import { Hono, type Context } from 'hono';
import bcrypt from 'bcryptjs';
import type { Env, Variables } from '../types';
import { booleanField, readJsonRecord, stringField } from '../lib/validation';
import { cleanupExpiredRateLimits, clientIp, consumeRateLimit } from '../lib/rate-limit';
import { rateLimitKey } from '../lib/viewer-hash';
import { createSession, destroyAllSessions, destroySession, userAuthMiddleware } from '../lib/session';
import { codeHash, generateCode, sendVerificationCode } from '../lib/email';
import { buildAuthUrl, exchangeCode } from '../lib/oauth-google';
import {
  attachPasswordAndUsername,
  avatarPath,
  createUser,
  getAvatarKey,
  getOAuth,
  getUserByEmail,
  getUserById,
  getUserByIdentifier,
  getUserByUsername,
  isValidEmail,
  isValidPassword,
  isValidUsername,
  linkOAuth,
  normalizeBadge,
  normalizeEmail,
  publicUser,
  setAvatarKey,
  setBadge,
  setEmail,
  setPassword,
  type UserRow
} from '../lib/users';

const AVATAR_TYPES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true
};
const AVATAR_MAX_BYTES = 512 * 1024;

const account = new Hono<{ Bindings: Env; Variables: Variables }>();
const CODE_TTL_SEC = 600;
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

async function limit(c: Ctx, scope: string): Promise<boolean> {
  const ip = clientIp(c.req);
  const [ipKey, globalKey] = await Promise.all([
    rateLimitKey(c.env.JWT_SECRET, `${scope}-ip`, ip),
    rateLimitKey(c.env.JWT_SECRET, `${scope}-global`, 'global')
  ]);
  const ok =
    (await consumeRateLimit(c.env, { identityHash: ipKey, minIntervalMs: 500, tenMinuteLimit: 20, dayLimit: 120 })) &&
    (await consumeRateLimit(c.env, { identityHash: globalKey, minIntervalMs: 0, tenMinuteLimit: 600, dayLimit: 5000 }));
  await cleanupExpiredRateLimits(c.env);
  return ok;
}

function allowedCommentOrigin(env: Env, origin: string): boolean {
  return env.COMMENT_UI_ORIGINS.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean).includes(origin);
}

interface PendingCode {
  codeHash: string;
  attempts: number;
  createdAt: number;
  [key: string]: unknown;
}

type OAuthResult = { token?: string; user?: Awaited<ReturnType<typeof publicUser>>; error?: string };

async function loadPending(env: Env, key: string): Promise<PendingCode | null> {
  const raw = await env.KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingCode;
  } catch {
    return null;
  }
}

/** 'ok' | 'expired' | 'invalid' (attempts bumped) | 'locked'. */
async function checkCode(
  env: Env,
  key: string,
  scope: string,
  pending: PendingCode,
  code: string
): Promise<'ok' | 'expired' | 'invalid' | 'locked'> {
  if (pending.attempts >= 5) {
    await env.KV.delete(key).catch(() => undefined);
    return 'locked';
  }
  const remaining = CODE_TTL_SEC - Math.floor((Date.now() - pending.createdAt) / 1000);
  if (remaining <= 0) {
    await env.KV.delete(key).catch(() => undefined);
    return 'expired';
  }
  const hash = await codeHash(env, scope, code.trim());
  if (hash !== pending.codeHash) {
    await env.KV.put(key, JSON.stringify({ ...pending, attempts: pending.attempts + 1 }), {
      expirationTtl: remaining
    });
    return 'invalid';
  }
  return 'ok';
}

function mapConstraint(error: unknown): 'email_taken' | 'username_taken' | null {
  const message = String(error).toLowerCase();
  if (message.includes('users.email_lower')) return 'email_taken';
  if (message.includes('users.username_lower')) return 'username_taken';
  return null;
}

async function issue(c: Ctx, user: UserRow) {
  const token = await createSession(c.env, user.id);
  return c.json({ token, user: await publicUser(c.env, user) });
}

async function saveOAuthResult(env: Env, state: string, origin: string, result: OAuthResult): Promise<void> {
  await env.KV.put(`oauth:result:${state}`, JSON.stringify({ origin, ...result }), { expirationTtl: 120 });
}

// ---- Registration ----------------------------------------------------------

account.post('/register/start', async (c) => {
  if (!(await limit(c, 'reg'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const email = stringField(body, 'email').trim();
  const username = stringField(body, 'username').trim();
  const password = stringField(body, 'password');
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  if (!isValidUsername(username)) return c.json({ error: 'invalid_username' }, 400);
  if (!isValidPassword(password)) return c.json({ error: 'invalid_password' }, 400);

  const emailLower = normalizeEmail(email);
  const existingEmail = await getUserByEmail(c.env, emailLower);
  if (existingEmail?.password_hash) return c.json({ error: 'email_taken' }, 409);
  const existingUsername = await getUserByUsername(c.env, username.toLowerCase());
  if (existingUsername) return c.json({ error: 'username_taken' }, 409);

  const code = generateCode();
  const pending: PendingCode = {
    codeHash: await codeHash(c.env, `register:${emailLower}`, code),
    attempts: 0,
    createdAt: Date.now(),
    email,
    username,
    passwordHash: bcrypt.hashSync(password, 10)
  };
  await c.env.KV.put(`evc:register:${emailLower}`, JSON.stringify(pending), { expirationTtl: CODE_TTL_SEC });
  if (!(await sendVerificationCode(c.env, email, code, 'register'))) {
    return c.json({ error: 'email_send_failed' }, 502);
  }
  return c.json({ ok: true });
});

account.post('/register/verify', async (c) => {
  if (!(await limit(c, 'reg-verify'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const email = stringField(body, 'email').trim();
  const code = stringField(body, 'code').trim();
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) return c.json({ error: 'invalid_code' }, 400);

  const emailLower = normalizeEmail(email);
  const key = `evc:register:${emailLower}`;
  const pending = await loadPending(c.env, key);
  if (!pending) return c.json({ error: 'code_expired' }, 400);
  const result = await checkCode(c.env, key, `register:${emailLower}`, pending, code);
  if (result !== 'ok') return c.json({ error: result === 'invalid' ? 'invalid_code' : 'code_expired' }, 400);

  const passwordHash = String(pending.passwordHash || '');
  const username = String(pending.username || '') || null;
  try {
    const existing = await getUserByEmail(c.env, emailLower);
    let user: UserRow;
    if (existing) {
      if (existing.password_hash) {
        await c.env.KV.delete(key).catch(() => undefined);
        return c.json({ error: 'email_taken' }, 409);
      }
      await attachPasswordAndUsername(c.env, existing.id, passwordHash, username);
      user = (await getUserById(c.env, existing.id))!;
    } else {
      user = await createUser(c.env, {
        username,
        email: String(pending.email || email),
        emailVerified: true,
        passwordHash,
        badge: 'seal'
      });
    }
    await c.env.KV.delete(key).catch(() => undefined);
    return await issue(c, user);
  } catch (error) {
    const mapped = mapConstraint(error);
    if (mapped) return c.json({ error: mapped }, 409);
    throw error;
  }
});

// ---- Password login --------------------------------------------------------

account.post('/login', async (c) => {
  if (!(await limit(c, 'login'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const identifier = stringField(body, 'identifier').trim();
  const password = stringField(body, 'password');
  if (!identifier || !password) return c.json({ error: 'invalid_credentials' }, 401);

  const user = await getUserByIdentifier(c.env, identifier);
  if (!user?.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  return await issue(c, user);
});

// ---- Password reset --------------------------------------------------------

account.post('/reset/start', async (c) => {
  if (!(await limit(c, 'reset'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const email = stringField(body, 'email').trim();
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);

  const emailLower = normalizeEmail(email);
  const user = await getUserByEmail(c.env, emailLower);
  if (!user?.email_verified) return c.json({ ok: true });

  const code = generateCode();
  const pending: PendingCode = {
    codeHash: await codeHash(c.env, `reset:${emailLower}`, code),
    attempts: 0,
    createdAt: Date.now(),
    userId: user.id
  };
  await c.env.KV.put(`evc:reset:${emailLower}`, JSON.stringify(pending), { expirationTtl: CODE_TTL_SEC });
  if (!(await sendVerificationCode(c.env, email, code, 'reset'))) {
    return c.json({ error: 'email_send_failed' }, 502);
  }
  return c.json({ ok: true });
});

account.post('/reset/verify', async (c) => {
  if (!(await limit(c, 'reset-verify'))) return c.json({ error: 'rate_limited' }, 429);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const email = stringField(body, 'email').trim();
  const code = stringField(body, 'code').trim();
  const password = stringField(body, 'password');
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) return c.json({ error: 'invalid_code' }, 400);
  if (!isValidPassword(password)) return c.json({ error: 'invalid_password' }, 400);

  const emailLower = normalizeEmail(email);
  const key = `evc:reset:${emailLower}`;
  const pending = await loadPending(c.env, key);
  if (!pending) return c.json({ error: 'code_expired' }, 400);
  const result = await checkCode(c.env, key, `reset:${emailLower}`, pending, code);
  if (result !== 'ok') return c.json({ error: result === 'invalid' ? 'invalid_code' : 'code_expired' }, 400);

  const userId = String(pending.userId || '');
  const user = userId ? await getUserById(c.env, userId) : null;
  if (!user || user.email_lower !== emailLower) return c.json({ error: 'invalid_code' }, 400);

  await setPassword(c.env, user.id, bcrypt.hashSync(password, 10));
  await destroyAllSessions(c.env, user.id);
  await c.env.KV.delete(key).catch(() => undefined);
  return await issue(c, (await getUserById(c.env, user.id))!);
});

// ---- Google OAuth ----------------------------------------------------------

account.get('/google/start', async (c) => {
  if (!(await limit(c, 'google'))) return c.json({ error: 'rate_limited' }, 429);
  const origin = c.req.query('origin') || '';
  if (!allowedCommentOrigin(c.env, origin)) return c.json({ error: 'invalid_origin' }, 400);
  const requestedState = c.req.query('state') || '';
  const state = requestedState || crypto.randomUUID();
  if (!/^[\w-]{16,80}$/.test(state)) return c.json({ error: 'invalid_state' }, 400);
  await c.env.KV.put(`oauth:state:${state}`, JSON.stringify({ origin, createdAt: Date.now() }), {
    expirationTtl: CODE_TTL_SEC
  });
  const url = buildAuthUrl(c.env, state);
  if (c.req.query('mode') === 'json') return c.json({ url, state });
  return c.redirect(url);
});

account.get('/google/result', async (c) => {
  const state = c.req.query('state') || '';
  if (!state) return c.json({ error: 'invalid_state' }, 400);
  const raw = await c.env.KV.get(`oauth:result:${state}`);
  if (!raw) return c.json({ pending: true }, 202);
  const result = JSON.parse(raw) as OAuthResult & { origin?: string };
  const requestOrigin = c.req.header('Origin') || '';
  if (requestOrigin && result.origin && requestOrigin !== result.origin) {
    return c.json({ error: 'invalid_origin' }, 400);
  }
  await c.env.KV.delete(`oauth:result:${state}`).catch(() => undefined);
  return c.json(result);
});

function popupResult(origin: string, payload: Record<string, unknown>): Response {
  const data = JSON.stringify({ type: 'sodesu-auth', ...payload });
  const targetOrigin = JSON.stringify(origin);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#54514a;background:#f6f5f1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>登录完成，正在返回…</p>
<script>(function(){try{if(window.opener){window.opener.postMessage(${data}, ${targetOrigin});}}catch(e){}setTimeout(function(){window.close();},120);})();</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

account.get('/callback/google', async (c) => {
  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  const stateRaw = state ? await c.env.KV.get(`oauth:state:${state}`) : null;
  if (!stateRaw) return new Response('invalid_state', { status: 400 });
  await c.env.KV.delete(`oauth:state:${state}`).catch(() => undefined);
  let origin = '';
  try {
    origin = (JSON.parse(stateRaw) as { origin?: string }).origin || '';
  } catch {
    origin = '';
  }
  if (!allowedCommentOrigin(c.env, origin)) return new Response('invalid_origin', { status: 400 });
  if (!code) {
    await saveOAuthResult(c.env, state, origin, { error: 'oauth_failed' });
    return popupResult(origin, { error: 'oauth_failed' });
  }

  const profile = await exchangeCode(c.env, code);
  if (!profile) {
    await saveOAuthResult(c.env, state, origin, { error: 'oauth_failed' });
    return popupResult(origin, { error: 'oauth_failed' });
  }

  let user: UserRow | null = null;
  const existingLink = await getOAuth(c.env, 'google', profile.sub);
  if (existingLink) {
    user = await getUserById(c.env, existingLink.user_id);
  } else if (profile.emailVerified && profile.email) {
    const byEmail = await getUserByEmail(c.env, normalizeEmail(profile.email));
    if (byEmail && byEmail.email_verified) {
      await linkOAuth(c.env, 'google', profile.sub, byEmail.id, profile.email);
      user = byEmail;
    }
  }
  if (!user) {
    try {
      user = await createUser(c.env, {
        email: profile.email,
        emailVerified: Boolean(profile.emailVerified && profile.email),
        displayName: profile.name,
        badge: 'seal'
      });
      await linkOAuth(c.env, 'google', profile.sub, user.id, profile.email);
    } catch (error) {
      // Lost a race on email uniqueness — fall back to the now-existing account.
      if (mapConstraint(error) === 'email_taken' && profile.email) {
        const byEmail = await getUserByEmail(c.env, normalizeEmail(profile.email));
        if (byEmail) {
          await linkOAuth(c.env, 'google', profile.sub, byEmail.id, profile.email);
          user = byEmail;
        }
      }
      if (!user) {
        await saveOAuthResult(c.env, state, origin, { error: 'oauth_failed' });
        return popupResult(origin, { error: 'oauth_failed' });
      }
    }
  }
  if (!user) {
    await saveOAuthResult(c.env, state, origin, { error: 'oauth_failed' });
    return popupResult(origin, { error: 'oauth_failed' });
  }
  const token = await createSession(c.env, user.id);
  const result = { token, user: await publicUser(c.env, user) };
  await saveOAuthResult(c.env, state, origin, result);
  return popupResult(origin, result);
});

// ---- Session-scoped: profile, password, email, badge -----------------------

account.get('/me', userAuthMiddleware, async (c) => {
  return c.json({ user: await publicUser(c.env, c.get('account')!) });
});

account.post('/logout', userAuthMiddleware, async (c) => {
  const token = c.get('sessionToken')!;
  const body = await readJsonRecord(c.req).catch(() => ({}));
  await destroySession(c.env, token);
  if (booleanField(body, 'all') === true) await destroyAllSessions(c.env, c.get('account')!.id);
  return c.json({ ok: true });
});

account.post('/password', userAuthMiddleware, async (c) => {
  if (!(await limit(c, 'password'))) return c.json({ error: 'rate_limited' }, 429);
  const user = c.get('account')!;
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const currentPassword = stringField(body, 'currentPassword');
  const newPassword = stringField(body, 'newPassword');
  if (!isValidPassword(newPassword)) return c.json({ error: 'invalid_password' }, 400);
  if (user.password_hash) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return c.json({ error: 'invalid_credentials' }, 401);
    }
  }
  await setPassword(c.env, user.id, bcrypt.hashSync(newPassword, 10));
  await destroyAllSessions(c.env, user.id, c.get('sessionToken'));
  return c.json({ ok: true });
});

account.post('/email/start', userAuthMiddleware, async (c) => {
  if (!(await limit(c, 'email-change'))) return c.json({ error: 'rate_limited' }, 429);
  const user = c.get('account')!;
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const newEmail = stringField(body, 'newEmail').trim();
  if (!isValidEmail(newEmail)) return c.json({ error: 'invalid_email' }, 400);
  const emailLower = normalizeEmail(newEmail);
  if (emailLower === user.email_lower) return c.json({ error: 'same_email' }, 400);
  const other = await getUserByEmail(c.env, emailLower);
  if (other && other.id !== user.id && other.email_verified) return c.json({ error: 'email_taken' }, 409);

  const code = generateCode();
  const pending: PendingCode = {
    codeHash: await codeHash(c.env, `email:${user.id}`, code),
    attempts: 0,
    createdAt: Date.now(),
    email: newEmail
  };
  await c.env.KV.put(`evc:email:${user.id}`, JSON.stringify(pending), { expirationTtl: CODE_TTL_SEC });
  if (!(await sendVerificationCode(c.env, newEmail, code, 'email'))) {
    return c.json({ error: 'email_send_failed' }, 502);
  }
  return c.json({ ok: true });
});

account.post('/email/verify', userAuthMiddleware, async (c) => {
  if (!(await limit(c, 'email-verify'))) return c.json({ error: 'rate_limited' }, 429);
  const user = c.get('account')!;
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const code = stringField(body, 'code').trim();
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'invalid_code' }, 400);
  const key = `evc:email:${user.id}`;
  const pending = await loadPending(c.env, key);
  if (!pending) return c.json({ error: 'code_expired' }, 400);
  const result = await checkCode(c.env, key, `email:${user.id}`, pending, code);
  if (result !== 'ok') return c.json({ error: result === 'invalid' ? 'invalid_code' : 'code_expired' }, 400);

  const newEmail = String(pending.email || '');
  const emailLower = normalizeEmail(newEmail);
  const other = await getUserByEmail(c.env, emailLower);
  if (other && other.id !== user.id && other.email_verified) {
    await c.env.KV.delete(key).catch(() => undefined);
    return c.json({ error: 'email_taken' }, 409);
  }
  try {
    await setEmail(c.env, user.id, newEmail);
  } catch (error) {
    if (mapConstraint(error) === 'email_taken') return c.json({ error: 'email_taken' }, 409);
    throw error;
  }
  await c.env.KV.delete(key).catch(() => undefined);
  return c.json({ ok: true, user: await publicUser(c.env, (await getUserById(c.env, user.id))!) });
});

account.post('/badge', userAuthMiddleware, async (c) => {
  const user = c.get('account')!;
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const badge = normalizeBadge(stringField(body, 'badge'));
  if (!badge) return c.json({ error: 'invalid_badge' }, 400);
  await setBadge(c.env, user.id, badge);
  return c.json({ ok: true, badge });
});

// ---- Custom avatar (R2) -----------------------------------------------------

account.post('/avatar', userAuthMiddleware, async (c) => {
  if (!(await limit(c, 'avatar'))) return c.json({ error: 'rate_limited' }, 429);
  const user = c.get('account')!;
  const contentType = (c.req.header('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!AVATAR_TYPES[contentType]) return c.json({ error: 'invalid_image' }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > AVATAR_MAX_BYTES) return c.json({ error: 'image_too_large' }, 400);
  const key = `avatars/${user.id}`;
  await c.env.R2.put(key, body, { httpMetadata: { contentType } });
  const now = Date.now();
  await setAvatarKey(c.env, user.id, key);
  return c.json({ avatar: avatarPath({ id: user.id, avatar_key: key, updated_at: now }) });
});

account.delete('/avatar', userAuthMiddleware, async (c) => {
  const user = c.get('account')!;
  await c.env.R2.delete(`avatars/${user.id}`).catch(() => undefined);
  await setAvatarKey(c.env, user.id, null);
  return c.json({ ok: true });
});

account.get('/avatar/:userId', async (c) => {
  const userId = c.req.param('userId');
  const row = await getAvatarKey(c.env, userId);
  if (!row?.avatar_key) return c.json({ error: 'not_found' }, 404);
  const object = await c.env.R2.get(row.avatar_key);
  if (!object) return c.json({ error: 'not_found' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(object.body, { headers });
});

export default account;
