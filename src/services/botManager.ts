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

// Default bot ID for the original single-bot setup.
export const DEFAULT_BOT_ID = 'default';

// ─── Service ─────────────────────────────────────────────────────────────────

export class BotManager {
  private bots: Map<string, BotConfig> = new Map();
  private services: Map<string, SnipeService> = new Map();
  private bridges: Map<string, SnipeLearningBridge> = new Map();
  private readonly configPath: string;

  constructor(
    private readonly appConfig: AppConfig,
    private readonly stateStore: StateStore,
    private readonly learningService: AgentLearningService,
  ) {
    this.configPath = path.resolve(appConfig.paths.dataDir, 'bots.json');
  }

  /**
   * Initialize: load bot configs from disk, start all enabled bots.
   * If no bots.json exists, create a default bot from env vars.
   */
  async init(): Promise<void> {
    await this.loadConfigs();

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

    // Start all enabled bots.
    for (const bot of this.bots.values()) {
      if (bot.enabled) {
        await this.startBot(bot);
      }
    }
  }

  // ─── Public: Bot CRUD ──────────────────────────────────────────────────

  /** Create a new bot. Throws if ID already exists. */
  async createBot(config: Omit<BotConfig, 'createdAt'>): Promise<BotConfig> {
    if (this.bots.has(config.id)) {
      throw new Error(`Bot '${config.id}' already exists.`);
    }
    if (!config.privateKeyB58) {
      throw new Error('privateKeyB58 is required.');
    }
    if (!config.name || config.name.trim().length < 1) {
      throw new Error('Bot name is required.');
    }

    const bot: BotConfig = {
      ...config,
      name: config.name.trim(),
      createdAt: new Date().toISOString(),
    };
    this.bots.set(bot.id, bot);
    await this.saveConfigs();

    if (bot.enabled) {
      await this.startBot(bot);
    }

    return bot;
  }

  /** Update a bot's config. Restarts the bot if wallet key changed. */
  async updateBot(id: string, updates: Partial<Omit<BotConfig, 'id' | 'createdAt'>>): Promise<BotConfig> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot '${id}' not found.`);

    const walletChanged = updates.privateKeyB58 && updates.privateKeyB58 !== bot.privateKeyB58;
    Object.assign(bot, updates);
    await this.saveConfigs();

    // Restart if wallet changed or bot was toggled.
    if (walletChanged || updates.enabled !== undefined) {
      await this.stopBot(id);
      if (bot.enabled) {
        await this.startBot(bot);
      }
    }

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

    await service.init();
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
}
