import { startDaemonRuntime } from './runtime.js';

const runtime = await startDaemonRuntime();

function shutdown(signal: string): void {
  console.log(`[shutdown] ${signal}`);
  runtime.stop().finally(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
