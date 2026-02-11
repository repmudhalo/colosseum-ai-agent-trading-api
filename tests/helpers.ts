import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, config as baseConfig } from '../src/config.js';

export async function createTempDir(prefix = 'colosseum-tests-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function buildTestConfig(tmpDir: string): AppConfig {
  return {
    ...baseConfig,
    paths: {
      ...baseConfig.paths,
      dataDir: tmpDir,
      stateFile: path.join(tmpDir, 'state.json'),
      logFile: path.join(tmpDir, 'events.ndjson'),
    },
    worker: {
      ...baseConfig.worker,
      intervalMs: 60_000,
      maxBatchSize: 20,
    },
    payments: {
      ...baseConfig.payments,
      x402Enabled: false,
    },
  };
}
