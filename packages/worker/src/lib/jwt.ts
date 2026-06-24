import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const fullPayload = { ...payload, iat: now, exp: now + TTL_MS };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(fullPayload))}`;
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyJWT<T extends Record<string, unknown> = Record<string, unknown>>(
  token: string,
  secret: string
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    asArrayBuffer(base64UrlDecode(encodedSignature)),
    encoder.encode(signingInput)
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(decoder.decode(base64UrlDecode(encodedPayload))) as T & { exp?: number };
    if (!payload.exp || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function roleMiddleware(requiredRole: string): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const header = c.req.header('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return c.json({ error: 'unauthorized' }, 401);

    const payload = await verifyJWT<{ role?: string }>(match[1], c.env.JWT_SECRET);
    if (!payload || payload.role !== requiredRole) return c.json({ error: 'unauthorized' }, 401);

    c.set('userId', requiredRole === 'deleter' ? 'deleter' : 'uploader');
    c.set('authRole', requiredRole);
    return next();
  };
}

export const authMiddleware = roleMiddleware('uploader');
export const deleteAuthMiddleware = roleMiddleware('deleter');

export const anyAuthMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return c.json({ error: 'unauthorized' }, 401);

  const payload = await verifyJWT<{ role?: string }>(match[1], c.env.JWT_SECRET);
  if (!payload?.role || !['uploader', 'deleter'].includes(payload.role)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  c.set('userId', payload.role === 'deleter' ? 'deleter' : 'uploader');
  c.set('authRole', payload.role);
  return next();
};

async function constantTimeStringEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b))
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let i = 0; i < Math.max(leftBytes.length, rightBytes.length); i += 1) {
    diff |= (leftBytes[i] || 0) ^ (rightBytes[i] || 0);
  }
  return diff === 0;
}

export async function requireDaemon(c: Context<{ Bindings: Env; Variables: Variables }, string>): Promise<Response | null> {
  const provided = c.req.header('X-Daemon-Secret');
  if (!provided || !(await constantTimeStringEqual(provided, c.env.DAEMON_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}
