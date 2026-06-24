import type { Env } from '../types';

export interface RateLimitRule {
  identityHash: string;
  minIntervalMs: number;
  tenMinuteLimit: number;
  dayLimit: number;
  ttlMs?: number;
}

export function clientIp(headers: { header: (name: string) => string | undefined }): string {
  return headers.header('CF-Connecting-IP')?.trim() || 'unknown';
}

export async function consumeRateLimit(env: Env, rule: RateLimitRule): Promise<boolean> {
  const now = Date.now();
  const tenMinStart = Math.floor(now / 600_000) * 600_000;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const expiresAt = now + (rule.ttlMs ?? 2 * 86_400_000);

  await env.DB.prepare(
    `INSERT INTO comment_rate_limits (
      identity_hash, last_post_at, ten_min_started_at, ten_min_count, day_started_at, day_count, expires_at
    ) VALUES (?, 0, ?, 0, ?, 0, ?)
    ON CONFLICT(identity_hash) DO NOTHING`
  ).bind(rule.identityHash, tenMinStart, dayStart, expiresAt).run();

  const updated = await env.DB.prepare(
    `UPDATE comment_rate_limits
     SET last_post_at = ?,
         ten_min_started_at = ?,
         ten_min_count = CASE WHEN ten_min_started_at = ? THEN ten_min_count + 1 ELSE 1 END,
         day_started_at = ?,
         day_count = CASE WHEN day_started_at = ? THEN day_count + 1 ELSE 1 END,
         expires_at = ?
     WHERE identity_hash = ?
       AND last_post_at <= ?
       AND (ten_min_started_at != ? OR ten_min_count < ?)
       AND (day_started_at != ? OR day_count < ?)
     RETURNING identity_hash`
  )
    .bind(
      now,
      tenMinStart,
      tenMinStart,
      dayStart,
      dayStart,
      expiresAt,
      rule.identityHash,
      now - rule.minIntervalMs,
      tenMinStart,
      rule.tenMinuteLimit,
      dayStart,
      rule.dayLimit
    )
    .first<{ identity_hash: string }>();

  return Boolean(updated);
}

export async function cleanupExpiredRateLimits(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM comment_rate_limits WHERE expires_at <= ?')
    .bind(Date.now())
    .run()
    .catch(() => undefined);
}
