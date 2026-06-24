import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';
import { getUserById, type UserRow } from './users';

const SESSION_TTL_SEC = 90 * 24 * 60 * 60;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** A bearer token shaped `userId:random` (zero dots) — distinguishable from the admin JWT (two dots). */
export function looksLikeSessionToken(token: string): boolean {
  return token.split('.').length !== 3 && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(token);
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = `${userId}:${randomToken()}`;
  await env.KV.put(`sess:${token}`, JSON.stringify({ userId, createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SEC
  });
  return token;
}

export async function readSession(env: Env, token: string): Promise<{ userId: string } | null> {
  if (!looksLikeSessionToken(token)) return null;
  const raw = await env.KV.get(`sess:${token}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { userId?: string };
    return parsed.userId ? { userId: parsed.userId } : null;
  } catch {
    return null;
  }
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.KV.delete(`sess:${token}`).catch(() => undefined);
}

export async function destroyAllSessions(env: Env, userId: string, exceptToken?: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: `sess:${userId}:`, cursor });
    await Promise.all(
      page.keys
        .filter((key) => key.name !== `sess:${exceptToken}`)
        .map((key) => env.KV.delete(key.name).catch(() => undefined))
    );
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function bearer(c: Context<{ Bindings: Env; Variables: Variables }>): string | null {
  const match = (c.req.header('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Resolve the signed-in user from a session bearer token, ignoring admin JWTs. */
export async function optionalUser(
  c: Context<{ Bindings: Env; Variables: Variables }>
): Promise<{ user: UserRow; token: string } | null> {
  const token = bearer(c);
  if (!token || !looksLikeSessionToken(token)) return null;
  const session = await readSession(c.env, token);
  if (!session) return null;
  const user = await getUserById(c.env, session.userId);
  return user ? { user, token } : null;
}

export const userAuthMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const resolved = await optionalUser(c);
  if (!resolved) return c.json({ error: 'unauthorized' }, 401);
  c.set('account', resolved.user);
  c.set('sessionToken', resolved.token);
  return next();
};
