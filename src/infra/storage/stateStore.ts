import fs from 'node:fs/promises';
import path from 'node:path';
import { AppState } from '../../types.js';
import { createDefaultState } from './defaultState.js';

export class StateStore {
  private state: AppState = createDefaultState();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly stateFilePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      this.state = JSON.parse(raw) as AppState;
    } catch {
      this.state = createDefaultState();
      await this.persist();
    }
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  async transaction<T>(work: (state: AppState) => Promise<T> | T): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => {};

    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const result = await work(this.state);
      await this.persist();
      return result;
    } finally {
      release();
    }
  }

  async flush(): Promise<void> {
    await this.lock;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
  }
}
