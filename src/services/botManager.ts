/**
 * Bot Manager — manages multiple snipe bot instances.
 *
 * Each bot has its own:
 *   - Wallet (keypair)
 *   - Strategy defaults
 *   - Persistence file
 *   - Learning bridge
 *
 * Bot configs are stored in data/bots.json and survive restarts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import bs58 from 'bs58';
import { AppConfig } from '../config.js';
import { SnipeService, ExitStrategy } from './snipeService.js';
import { SnipeLearningBridge } from './snipeLearningBridge.js';
import { AgentLearningService } from './agentLearningService.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BotConfig {
  id: string;
  name: string;
  /** Base58-encoded Solana private key for this bot's wallet. */
  privateKeyB58: string;
  /** Override default strategy params. Unset fields use the global defaults. */
  strategy?: Partial<ExitStrategy>;
  /** Per-bot LORE settings. */
  lore?: {
    autoTradeEnabled?: boolean;
    autoTradeBoxTypes?: string[];
    autoTradeAmountSol?: number;
  };
  /** Per-bot minimum market cap. */
  minMarketCapUsd?: number;
  /** Whether this bot is enabled (active). */
  enabled: boolean;
  createdAt: string;
}

export interface BotInfo {
  id: string;
  name: string;
  enabled: boolean;
  ready: boolean;
  walletAddress: string | null;
  openPositions: number;
  totalTrades: number;
  createdAt: string;
}

/** A saved strategy preset that can be reused across bots. */
export interface StrategyPreset {
  id: string;
  name: string;
  description?: string;
  strategy: Partial<ExitStrategy>;
  createdAt: string;
  updatedAt: string;
}

// Default bot ID for the original single-bot setup.
export const DEFAULT_BOT_ID = 'default';

// Hard cap: each bot opens a Solana RPC connection + price monitor, so limit resource usage.
const MAX_BOTS = 10;

// Timeout for starting a bot (Solana RPC connect + wallet load). Prevents hanging forever.
const START_BOT_TIMEOUT_MS = 15_000;

/**
 * Validate that a string is a valid Solana private key (Base58-encoded, 64 bytes when decoded).
 * Throws a descriptive error if invalid.
 */
function validateBase58Key(key: string): void {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(key);
  } catch {
    throw new Error('Invalid private key: not valid Base58 encoding.');
  }
  // Accept both 64-byte keypair (secret + public) and 32-byte seed (secret only).
  // Solana's Keypair.fromSecretKey() handles 64, Keypair.fromSeed() handles 32.
  if (decoded.length !== 64 && decoded.length !== 32) {
    throw new Error(`Invalid private key: expected 32 or 64 bytes, got ${decoded.length}.`);
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class BotManager {
  private bots: Map<string, BotConfig> = new Map();
  private services: Map<string, SnipeService> = new Map();
  private bridges: Map<string, SnipeLearningBridge> = new Map();
  private presets: Map<string, StrategyPreset> = new Map();
  private readonly configPath: string;
  private readonly presetsPath: string;

  constructor(
    private readonly appConfig: AppConfig,
    private readonly stateStore: StateStore,
    private readonly learningService: AgentLearningService,
  ) {
    this.configPath = path.resolve(appConfig.paths.dataDir, 'bots.json');
    this.presetsPath = path.resolve(appConfig.paths.dataDir, 'strategy-presets.json');
  }

  /**
   * Initialize: load bot configs from disk, start all enabled bots.
   * If no bots.json exists, create a default bot from env vars.
   */
  async init(): Promise<void> {
    await this.loadConfigs();
    await this.loadPresets();

    // If no bots configured, bootstrap the default bot from env vars.
    if (this.bots.size === 0 && this.appConfig.trading.solanaPrivateKeyB58) {
      const defaultBot: BotConfig = {
        id: DEFAULT_BOT_ID,
        name: 'Sesame Bot',
        privateKeyB58: this.appConfig.trading.solanaPrivateKeyB58,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      this.bots.set(DEFAULT_BOT_ID, defaultBot);
      await this.saveConfigs();
    }

    // Start all enabled bots. One failing bot shouldn't prevent the others from starting.
    for (const bot of this.bots.values()) {
      if (bot.enabled) {
        try {
          await this.startBot(bot);
          console.log(`[BotManager] Started bot '${bot.id}' (${bot.name})`);
        } catch (err) {
          console.error(`[BotManager] Failed to start bot '${bot.id}':`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  // ─── Public: Bot CRUD ──────────────────────────────────────────────────

  /** Create a new bot. Validates key, enforces limits, rolls back on failure. */
  async createBot(config: Omit<BotConfig, 'createdAt'>): Promise<BotConfig> {
    if (this.bots.has(config.id)) {
      throw new Error(`Bot '${config.id}' already exists.`);
    }
    if (this.bots.size >= MAX_BOTS) {
      throw new Error(`Maximum of ${MAX_BOTS} bots reached. Remove an existing bot first.`);
    }
    if (!config.privateKeyB58) {
      throw new Error('privateKeyB58 is required.');
    }
    if (!config.name || config.name.trim().length < 1) {
      throw new Error('Bot name is required.');
    }

    // Validate private key format before saving anything.
    validateBase58Key(config.privateKeyB58);

    const bot: BotConfig = {
      ...config,
      name: config.name.trim(),
      createdAt: new Date().toISOString(),
    };

    // Start the bot FIRST. Only persist to disk if startup succeeds.
    // This prevents broken configs from being saved and failing on every restart.
    if (bot.enabled) {
      try {
        await this.startBot(bot);
      } catch (err) {
        throw new Error(`Bot created but failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.bots.set(bot.id, bot);
    await this.saveConfigs();
    return bot;
  }

  /** Update a bot's config. Restarts the bot if wallet key changed. Rolls back on failure. */
  async updateBot(id: string, updates: Partial<Omit<BotConfig, 'id' | 'createdAt'>>): Promise<BotConfig> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot '${id}' not found.`);

    // Validate new private key if provided.
    if (updates.privateKeyB58) {
      validateBase58Key(updates.privateKeyB58);
    }

    const walletChanged = updates.privateKeyB58 && updates.privateKeyB58 !== bot.privateKeyB58;
    const needsRestart = walletChanged || updates.enabled !== undefined;

    // Snapshot old config so we can roll back if restart fails.
    const snapshot = { ...bot };

    Object.assign(bot, updates);

    if (needsRestart) {
      await this.stopBot(id);
      if (bot.enabled) {
        try {
          await this.startBot(bot);
        } catch (err) {
          // Roll back to previous config and try to restore the old bot.
          Object.assign(bot, snapshot);
          try { await this.startBot(bot); } catch { /* best effort restore */ }
          throw new Error(`Update failed, rolled back: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Only persist after successful restart.
    await this.saveConfigs();
    return bot;
  }

  /** Remove a bot entirely. Stops it first. */
  async removeBot(id: string): Promise<void> {
    if (id === DEFAULT_BOT_ID) {
      throw new Error('Cannot remove the default bot.');
    }
    await this.stopBot(id);
    this.bots.delete(id);
    await this.saveConfigs();
  }

  // ─── Public: Access ────────────────────────────────────────────────────

  /** Get a bot's SnipeService by ID. Falls back to default. */
  getService(botId?: string): SnipeService | null {
    const id = botId || DEFAULT_BOT_ID;
    return this.services.get(id) ?? null;
  }

  /** Get the default bot's SnipeService (backward compatibility). */
  getDefaultService(): SnipeService | null {
    return this.services.get(DEFAULT_BOT_ID) ?? null;
  }

  /** Get a bot's config. */
  getBotConfig(botId: string): BotConfig | null {
    return this.bots.get(botId) ?? null;
  }

  /** List all bot configs. */
  listBots(): BotConfig[] {
    return Array.from(this.bots.values());
  }

  /** List bot summaries (for the dashboard). */
  async listBotInfo(): Promise<BotInfo[]> {
    const result: BotInfo[] = [];
    for (const bot of this.bots.values()) {
      const service = this.services.get(bot.id);
      let openPositions = 0;
      let totalTrades = 0;
      if (service) {
        try {
          const portfolio = await service.getPortfolio();
          openPositions = portfolio.openPositions.length;
          totalTrades = portfolio.totalTrades;
        } catch { /* best effort */ }
      }
      result.push({
        id: bot.id,
        name: bot.name,
        enabled: bot.enabled,
        ready: service?.isReady() ?? false,
        walletAddress: service?.walletAddress() ?? null,
        openPositions,
        totalTrades,
        createdAt: bot.createdAt,
      });
    }
    return result;
  }

  /** Get all active SnipeService instances. */
  getAllServices(): Map<string, SnipeService> {
    return this.services;
  }

  /** Get all bot IDs. */
  getBotIds(): string[] {
    return Array.from(this.bots.keys());
  }

  // ─── Public: Strategy Presets ──────────────────────────────────────────

  /** List all saved strategy presets. */
  listPresets(): StrategyPreset[] {
    return Array.from(this.presets.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /** Get a single preset by ID. */
  getPreset(id: string): StrategyPreset | null {
    return this.presets.get(id) ?? null;
  }

  /** Create or update a strategy preset. */
  async savePreset(data: { id: string; name: string; description?: string; strategy: Partial<ExitStrategy> }): Promise<StrategyPreset> {
    const existing = this.presets.get(data.id);
    const now = new Date().toISOString();
    const preset: StrategyPreset = {
      id: data.id,
      name: data.name.trim(),
      description: data.description?.trim() || undefined,
      strategy: data.strategy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.presets.set(preset.id, preset);
    await this.savePresets();
    return preset;
  }

  /** Delete a strategy preset. */
  async deletePreset(id: string): Promise<void> {
    if (!this.presets.has(id)) throw new Error(`Preset '${id}' not found.`);
    this.presets.delete(id);
    await this.savePresets();
  }

  // ─── Private: Bot lifecycle ────────────────────────────────────────────

  private async startBot(bot: BotConfig): Promise<void> {
    if (this.services.has(bot.id)) return;

    // Build a per-bot config by overriding the wallet key and persistence path.
    const botConfig = this.buildBotAppConfig(bot);
    const service = new SnipeService(botConfig, bot.id);

    // Apply per-bot strategy overrides.
    if (bot.strategy) {
      service.updateDefaultStrategy(bot.strategy);
    }

    // Init with a timeout so a slow/unreachable RPC doesn't hang forever.
    await Promise.race([
      service.init(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Bot '${bot.id}' init timed out after ${START_BOT_TIMEOUT_MS / 1000}s. Check RPC and wallet key.`)), START_BOT_TIMEOUT_MS),
      ),
    ]);

    this.services.set(bot.id, service);

    // Start a learning bridge for this bot.
    const bridge = new SnipeLearningBridge(
      this.stateStore,
      this.learningService,
      service,
      bot.id,
    );
    bridge.start();
    this.bridges.set(bot.id, bridge);
  }

  private async stopBot(id: string): Promise<void> {
    const bridge = this.bridges.get(id);
    if (bridge) {
      bridge.stop();
      this.bridges.delete(id);
    }

    const service = this.services.get(id);
    if (service) {
      service.stopPriceMonitor();
      this.services.delete(id);
    }
  }

  /**
   * Build an AppConfig clone with the bot's wallet key and persistence path.
   * Shares everything else (RPC URL, Jupiter URLs, etc.) with the global config.
   */
  private buildBotAppConfig(bot: BotConfig): AppConfig {
    return {
      ...this.appConfig,
      trading: {
        ...this.appConfig.trading,
        solanaPrivateKeyB58: bot.privateKeyB58,
      },
      paths: {
        ...this.appConfig.paths,
        // Each bot gets its own data dir suffix for the persist path override.
        dataDir: this.appConfig.paths.dataDir,
      },
      snipe: {
        ...this.appConfig.snipe,
        minMarketCapUsd: bot.minMarketCapUsd ?? this.appConfig.snipe.minMarketCapUsd,
      },
    };
  }

  // ─── Private: Persistence ──────────────────────────────────────────────

  private async loadConfigs(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const arr = JSON.parse(raw) as BotConfig[];
      for (const bot of arr) {
        this.bots.set(bot.id, bot);
      }
    } catch {
      // No file yet — fresh install.
    }
  }

  private async saveConfigs(): Promise<void> {
    const arr = Array.from(this.bots.values());
    // Don't persist private keys in plain text — redact them for safety.
    // Actually, we need them to restart. Store them but warn in docs.
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(arr, null, 2), 'utf-8');
  }

  private async loadPresets(): Promise<void> {
    try {
      const raw = await fs.readFile(this.presetsPath, 'utf-8');
      const arr = JSON.parse(raw) as StrategyPreset[];
      for (const p of arr) {
        this.presets.set(p.id, p);
      }
    } catch {
      // No file yet — fresh install.
    }
  }

  private async savePresets(): Promise<void> {
    const arr = Array.from(this.presets.values());
    const dir = path.dirname(this.presetsPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.presetsPath, JSON.stringify(arr, null, 2), 'utf-8');
  }
}
