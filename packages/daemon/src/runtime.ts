import { mkdirSync } from 'node:fs';
import type http from 'node:http';
import { backfillBlurData, catchUp } from './sync.js';
import { startHeartbeat } from './heartbeat.js';
import { startSSEListener } from './sse.js';
import { startLocalServer } from './server.js';
import { startTunnel } from './tunnel.js';
import { CONFIG } from './config.js';

export interface DaemonRuntime {
  stop: () => Promise<void>;
}

export async function startDaemonRuntime(): Promise<DaemonRuntime> {
  mkdirSync(CONFIG.photoDir, { recursive: true });
  mkdirSync(CONFIG.thumbnailDir, { recursive: true });

  const server = startLocalServer();
  const stopTunnel = startTunnel();
  const stopHeartbeat = startHeartbeat();

  try {
    await catchUp();
  } catch (err) {
    console.warn('[startup] catch-up failed:', err);
  }

  void backfillBlurData().catch((err) => console.warn('[startup] blur backfill failed:', err));
  const blurTimer = setInterval(() => {
    void backfillBlurData().catch((err) => console.warn('[blur] scheduled backfill failed:', err));
  }, 15 * 60 * 1000);
  blurTimer.unref();

  const stopSSE = startSSEListener();

  return {
    async stop() {
      stopSSE();
      clearInterval(blurTimer);
      stopHeartbeat();
      stopTunnel();
      await closeServer(server);
    }
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 3_000).unref();
  });
}
