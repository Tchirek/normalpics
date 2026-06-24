import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import dotenv from 'dotenv';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(packageDir, '.env') });

const DEFAULT_LLM_PROMPT = 'You are labeling a private photography gallery. Return compact JSON only, with this exact shape: {"description":"...","tags":["#..."]}. Use Simplified Chinese. The description must be one complete, natural sentence, specific to the image, preferably 30 to 70 Chinese characters. Do not cut the sentence off mid-thought. Create 1 to 4 elegant, specific tags; each tag must start with #, contain no spaces, and be useful for search. No markdown, no extra text.';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

export const CONFIG = {
  workerUrl: required('WORKER_URL').replace(/\/$/, ''),
  daemonSecret: required('DAEMON_SECRET'),
  deviceId: process.env.DEVICE_ID || `legacy-${hostname().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'device'}`,
  deviceName: process.env.DEVICE_NAME || hostname() || 'PhotoHost Device',
  photoDir: required('PHOTO_DIR'),
  thumbnailDir: required('THUMBNAIL_DIR'),
  localPort: intEnv('LOCAL_SERVER_PORT', 18080),

  r2: {
    endpoint: required('R2_ENDPOINT').replace(/\/$/, ''),
    bucketName: required('R2_BUCKET_NAME'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY')
  },

  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
    apiKey: process.env.LLM_API_KEY || 'ollama',
    model: process.env.LLM_MODEL || 'qwen2.5:7b',
    visionCapable: process.env.LLM_VISION_CAPABLE !== 'false',
    maxTokens: intEnv('LLM_MAX_TOKENS', 180),
    prompt: process.env.LLM_PROMPT || DEFAULT_LLM_PROMPT,
    timeoutMs: intEnv('LLM_TIMEOUT_MS', 30_000)
  },

  sync: {
    concurrency: intEnv('SYNC_CONCURRENCY', 4),
    processConcurrency: intEnv('PROCESS_CONCURRENCY', 2)
  },

  tunnel: {
    enabled: process.env.TUNNEL_ENABLED !== 'false',
    runner: process.env.CLOUDFLARED_RUNNER || 'wrangler',
    command: process.env.CLOUDFLARED_COMMAND || 'npx',
    credentialsFile: process.env.CLOUDFLARED_CREDENTIALS_FILE || '',
    originCert: process.env.CLOUDFLARED_ORIGIN_CERT || '',
    token: process.env.CLOUDFLARED_TUNNEL_TOKEN || '',
    name: process.env.CLOUDFLARED_TUNNEL_NAME || '',
    publicUrl: (process.env.TUNNEL_PUBLIC_URL || '').replace(/\/$/, ''),
    logLevel: process.env.CLOUDFLARED_LOG_LEVEL || 'info',
    quickTunnel: process.env.CLOUDFLARED_QUICK_TUNNEL === 'true'
  }
};
