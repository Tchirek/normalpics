import { Hono, type Context } from 'hono';
import bcrypt from 'bcryptjs';
import type { Env, Variables } from '../types';
import { signJWT } from '../lib/jwt';
import { cleanupExpiredRateLimits, clientIp, consumeRateLimit } from '../lib/rate-limit';
import { readJsonRecord, stringField } from '../lib/validation';
import { rateLimitKey } from '../lib/viewer-hash';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

function readPin(body: Record<string, unknown>): string {
  return stringField(body, 'pin').trim();
}

function comparePin(pin: string, hash?: string): boolean {
  if (!pin) return false;
  if (hash) return bcrypt.compareSync(pin, hash);
  return false;
}

async function consumeAuthRateLimits(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  scope: 'auth' | 'delete-auth'
): Promise<boolean> {
  const ip = clientIp(c.req);
  const [ipKey, globalKey] = await Promise.all([
    rateLimitKey(c.env.JWT_SECRET, `${scope}-ip`, ip),
    rateLimitKey(c.env.JWT_SECRET, `${scope}-global`, 'global')
  ]);
  const ok = await consumeRateLimit(c.env, {
    identityHash: ipKey,
    minIntervalMs: 250,
    tenMinuteLimit: 20,
    dayLimit: 120
  }) && await consumeRateLimit(c.env, {
    identityHash: globalKey,
    minIntervalMs: 0,
    tenMinuteLimit: 600,
    dayLimit: 3_000
  });
  await cleanupExpiredRateLimits(c.env);
  return ok;
}

auth.post('/', async (c) => {
  if (!(await consumeAuthRateLimits(c, 'auth'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const ok = comparePin(readPin(body), c.env.PIN_HASH);

  if (!ok) return c.json({ error: 'unauthorized' }, 401);

  const token = await signJWT({ role: 'uploader' }, c.env.JWT_SECRET);
  return c.json({ token });
});

auth.post('/delete', async (c) => {
  if (!(await consumeAuthRateLimits(c, 'delete-auth'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const ok = comparePin(readPin(body), c.env.DELETE_PIN_HASH);

  if (!ok) return c.json({ error: 'unauthorized' }, 401);

  const token = await signJWT({ role: 'deleter' }, c.env.JWT_SECRET);
  return c.json({ token });
});

export default auth;
