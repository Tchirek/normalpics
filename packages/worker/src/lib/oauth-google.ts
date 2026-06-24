import type { Env } from '../types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export function buildAuthUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online'
  });
  return `${AUTH_URL}?${params.toString()}`;
}

function decodeJwtPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Exchange an authorization code for the user's Google profile (via the id_token). */
export async function exchangeCode(env: Env, code: string): Promise<GoogleProfile | null> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: env.OAUTH_REDIRECT_URI
    }).toString()
  });
  if (!response.ok) {
    console.error('google_token_failed', response.status, await response.text().catch(() => ''));
    return null;
  }
  const data = (await response.json().catch(() => null)) as { id_token?: string } | null;
  if (!data?.id_token) return null;
  const payload = decodeJwtPayload(data.id_token);
  const sub = typeof payload?.sub === 'string' ? payload.sub : null;
  if (!sub) return null;
  const email = typeof payload?.email === 'string' ? payload.email : null;
  const emailVerified = payload?.email_verified === true || payload?.email_verified === 'true';
  const name = typeof payload?.name === 'string' ? payload.name : null;
  return { sub, email, emailVerified, name };
}
