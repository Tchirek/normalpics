import type { Env } from '../types';

async function ensureRuntimeTable(env: Env): Promise<void> {
  void env;
}

export async function putRuntimeState(env: Env, key: string, value: string): Promise<void> {
  await ensureRuntimeTable(env);
  await env.DB.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}

export async function getRuntimeState(env: Env, key: string): Promise<{ value: string; updatedAt: number } | null> {
  await ensureRuntimeTable(env);
  const row = await env.DB.prepare(
    'SELECT value, updated_at AS updatedAt FROM runtime_state WHERE key = ?'
  ).bind(key).first<{ value: string; updatedAt: number }>();
  return row || null;
}
