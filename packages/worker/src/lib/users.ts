import { nanoid } from 'nanoid';
import type { Env } from '../types';

export type BadgeKind = 'none' | 'cockade' | 'seal';
export const BADGE_KINDS: BadgeKind[] = ['none', 'cockade', 'seal'];

export interface UserRow {
  id: string;
  username: string | null;
  username_lower: string | null;
  email: string | null;
  email_lower: string | null;
  email_verified: number;
  password_hash: string | null;
  badge: string;
  display_name: string | null;
  avatar_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  badge: BadgeKind;
  displayName: string;
  hasPassword: boolean;
  googleLinked: boolean;
  avatar: string | null;
}

/** Relative avatar URL (the frontend prefixes its apiOrigin); null when no custom avatar. */
export function avatarPath(row: { id: string; avatar_key: string | null; updated_at: number }): string | null {
  return row.avatar_key ? `/api/auth/avatar/${row.id}?v=${row.updated_at}` : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim()) && value.trim().length <= 254;
}

export function isValidUsername(value: string): boolean {
  return USERNAME_RE.test(value.trim());
}

export function isValidPassword(value: string): boolean {
  return typeof value === 'string' && value.length >= 8 && value.length <= 200;
}

export function emailLocalPart(email: string): string {
  return email.split('@')[0] || 'User';
}

export function normalizeBadge(value: unknown): BadgeKind | null {
  return BADGE_KINDS.includes(value as BadgeKind) ? (value as BadgeKind) : null;
}

export function getUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export function getUserByEmail(env: Env, emailLower: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE email_lower = ?').bind(emailLower).first<UserRow>();
}

export function getUserByUsername(env: Env, usernameLower: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE username_lower = ?').bind(usernameLower).first<UserRow>();
}

export function getUserByIdentifier(env: Env, identifier: string): Promise<UserRow | null> {
  const value = identifier.trim();
  if (value.includes('@')) return getUserByEmail(env, normalizeEmail(value));
  return getUserByUsername(env, value.toLowerCase());
}

export async function isGoogleLinked(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM user_oauth WHERE user_id = ? AND provider = 'google' LIMIT 1"
  ).bind(userId).first<{ ok: number }>();
  return Boolean(row);
}

export interface CreateUserInput {
  username?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  passwordHash?: string | null;
  displayName?: string | null;
  badge?: BadgeKind;
}

export async function createUser(env: Env, input: CreateUserInput): Promise<UserRow> {
  const id = nanoid(16);
  const now = Date.now();
  const username = input.username?.trim() || null;
  const email = input.email?.trim() || null;
  const displayName =
    input.displayName?.trim() || username || (email ? emailLocalPart(email) : 'User');
  await env.DB.prepare(
    `INSERT INTO users (
       id, username, username_lower, email, email_lower, email_verified,
       password_hash, badge, display_name, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    username,
    username ? username.toLowerCase() : null,
    email,
    email ? normalizeEmail(email) : null,
    input.emailVerified ? 1 : 0,
    input.passwordHash ?? null,
    input.badge ?? 'seal',
    displayName,
    now,
    now
  ).run();
  const row = await getUserById(env, id);
  if (!row) throw new Error('user_create_failed');
  return row;
}

export function getOAuth(
  env: Env,
  provider: string,
  accountId: string
): Promise<{ user_id: string } | null> {
  return env.DB.prepare(
    'SELECT user_id FROM user_oauth WHERE provider = ? AND provider_account_id = ?'
  ).bind(provider, accountId).first<{ user_id: string }>();
}

export async function linkOAuth(
  env: Env,
  provider: string,
  accountId: string,
  userId: string,
  email: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_oauth (provider, provider_account_id, user_id, email, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_account_id) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`
  ).bind(provider, accountId, userId, email, Date.now()).run();
}

export async function setBadge(env: Env, userId: string, badge: BadgeKind): Promise<void> {
  await env.DB.prepare('UPDATE users SET badge = ?, updated_at = ? WHERE id = ?')
    .bind(badge, Date.now(), userId).run();
}

export async function setPassword(env: Env, userId: string, hash: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(hash, Date.now(), userId).run();
}

export async function attachPasswordAndUsername(
  env: Env,
  userId: string,
  hash: string,
  username: string | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
       SET password_hash = ?,
           username = COALESCE(username, ?),
           username_lower = COALESCE(username_lower, ?),
           updated_at = ?
     WHERE id = ?`
  ).bind(hash, username, username ? username.toLowerCase() : null, Date.now(), userId).run();
}

export async function setEmail(env: Env, userId: string, email: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET email = ?, email_lower = ?, email_verified = 1, updated_at = ? WHERE id = ?'
  ).bind(email.trim(), normalizeEmail(email), Date.now(), userId).run();
}

export function displayName(row: UserRow): string {
  return row.display_name || row.username || (row.email ? emailLocalPart(row.email) : 'User');
}

export async function publicUser(env: Env, row: UserRow): Promise<PublicUser> {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    emailVerified: Boolean(row.email_verified),
    badge: (normalizeBadge(row.badge) ?? 'none'),
    displayName: displayName(row),
    hasPassword: Boolean(row.password_hash),
    googleLinked: await isGoogleLinked(env, row.id),
    avatar: avatarPath(row)
  };
}

export async function setAvatarKey(env: Env, userId: string, key: string | null): Promise<void> {
  await env.DB.prepare('UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?')
    .bind(key, Date.now(), userId).run();
}

export function getAvatarKey(env: Env, userId: string): Promise<{ avatar_key: string | null } | null> {
  return env.DB.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(userId).first<{ avatar_key: string | null }>();
}
