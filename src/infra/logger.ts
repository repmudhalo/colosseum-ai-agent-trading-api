import fs from 'node:fs/promises';
import path from 'node:path';
import { isoNow } from '../utils/time.js';

type LogLevel = 'info' | 'warn' | 'error';

export class EventLogger {
  constructor(private readonly logFilePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
    try {
      await fs.access(this.logFilePath);
    } catch {
      await fs.writeFile(this.logFilePath, '');
    }
  }

  async log(level: LogLevel, event: string, data: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({
      ts: isoNow(),
      level,
      event,
      ...data,
    });

    await fs.appendFile(this.logFilePath, `${line}\n`);

    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
