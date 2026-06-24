import { CONFIG } from './config.js';

async function postHeartbeat(): Promise<void> {
  const response = await fetch(`${CONFIG.workerUrl}/api/sync/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Secret': CONFIG.daemonSecret,
      'X-Device-Id': CONFIG.deviceId
    },
    body: JSON.stringify({ deviceName: CONFIG.deviceName })
  });
  if (!response.ok) throw new Error(`heartbeat_${response.status}`);
}

export function startHeartbeat(): () => void {
  const tick = () => {
    postHeartbeat().catch((err) => console.warn('[heartbeat] failed:', err));
  };

  tick();
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
}
