import { EventLogger } from '../infra/logger.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';
import { ExecutionService } from './executionService.js';

export class ExecutionWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight = false;

  constructor(
    private readonly store: StateStore,
    private readonly executionService: ExecutionService,
    private readonly logger: EventLogger,
    private readonly intervalMs: number,
    private readonly batchSize: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    while (this.inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;

    try {
      const pending = Object.values(this.store.snapshot().tradeIntents)
        .filter((intent) => intent.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, this.batchSize);

      for (const intent of pending) {
        await this.executionService.processIntent(intent.id);
      }

      await this.store.transaction((state) => {
        state.metrics.workerLoops += 1;
        state.metrics.lastWorkerRunAt = isoNow();
        return undefined;
      });
    } catch (error) {
      await this.logger.log('error', 'worker.loop.error', {
        error: String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }
}
