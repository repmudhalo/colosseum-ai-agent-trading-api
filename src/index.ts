import { buildApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const { app, worker, autonomousService, stateStore, logger } = await buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    await logger.log('info', 'shutdown.start', { signal });
    await autonomousService.stop();
    await worker.stop();
    await app.close();
    await stateStore.flush();
    await logger.log('info', 'shutdown.complete', { signal });
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({ port: config.app.port, host: '0.0.0.0' });
  worker.start();
  await autonomousService.start();

  await logger.log('info', 'server.started', {
    port: config.app.port,
    env: config.app.env,
    defaultMode: config.trading.defaultMode,
    liveEnabled: config.trading.liveEnabled,
    autonomousEnabled: config.autonomous.enabled,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
