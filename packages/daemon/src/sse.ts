import { CONFIG } from './config.js';
import { catchUp } from './sync.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(ms * factor);
}

async function connectOnce(stopSignal: AbortSignal, onSyncEvent: () => void): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  stopSignal.addEventListener('abort', stop, { once: true });

  let lastSeen = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastSeen > 45_000) controller.abort();
  }, 5_000);

  try {
    const response = await fetch(`${CONFIG.workerUrl}/api/sync/stream`, {
      headers: {
        'X-Daemon-Secret': CONFIG.daemonSecret,
        'X-Device-Id': CONFIG.deviceId,
        Accept: 'text/event-stream'
      },
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error(`sse_${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];

    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      lastSeen = Date.now();
      buffer += decoder.decode(value, { stream: true });

      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
        buffer = buffer.slice(lineEnd + 1);

        if (line.startsWith(':')) {
          lastSeen = Date.now();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line === '') {
          if (dataLines.length > 0) {
            JSON.parse(dataLines.join('\n'));
            onSyncEvent();
            dataLines = [];
          }
        }

        lineEnd = buffer.indexOf('\n');
      }
    }
  } finally {
    clearInterval(watchdog);
    stopSignal.removeEventListener('abort', stop);
  }
}

export function startSSEListener(): () => void {
  const controller = new AbortController();
  let delay = 1_000;
  let catchUpRunning = false;
  let catchUpAgain = false;

  const scheduleCatchUp = () => {
    catchUpAgain = true;
    if (catchUpRunning) return;

    catchUpRunning = true;
    void (async () => {
      while (catchUpAgain && !controller.signal.aborted) {
        catchUpAgain = false;
        await catchUp().catch((err) => console.warn('[sse] catch-up failed:', err));
      }
      catchUpRunning = false;
    })();
  };

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        await connectOnce(controller.signal, scheduleCatchUp);
        delay = 1_000;
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[sse] disconnected:', err);
      }
      if (!controller.signal.aborted) {
        await sleep(jitter(delay));
        delay = Math.min(delay * 2, 32_000);
      }
    }
  };

  void run();
  return () => controller.abort();
}
