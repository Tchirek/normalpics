import { Hono } from 'hono';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { nanoid } from 'nanoid';
import type { Env, Variables } from '../types';
import { verifyJWT } from '../lib/jwt';
import { commentLikeViewerKey, nicknameCooldownKey, rateLimitKey } from '../lib/viewer-hash';
import { booleanField, readJsonRecord, stringField } from '../lib/validation';
import { optionalUser } from '../lib/session';
import { displayName, normalizeBadge } from '../lib/users';

const comments = new Hono<{ Bindings: Env; Variables: Variables }>();
const NICKNAME_CHANGE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const ANONYMOUS_NICKNAME = 'Anonymous';

interface CommentRow {
  id: string;
  image_id: string;
  root_id: string;
  parent_id: string | null;
  nickname: string;
  markdown: string;
  rendered_html: string;
  status: string;
  user_id: string | null;
  edit_count?: number;
  created_at: number;
  updated_at: number;
  like_count?: number;
  liked_by_viewer?: number;
  author_badge?: string | null;
  author_display?: string | null;
  author_avatar_key?: string | null;
  author_updated_at?: number | null;
}

function viewerId(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const value = (c.req.header('X-Viewer-Id') || '').trim();
  return /^[A-Za-z0-9_-]{16,80}$/.test(value) ? value : null;
}

function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') return ANONYMOUS_NICKNAME;
  const nickname = value.replace(/\s+/g, ' ').trim();
  if (!nickname) return ANONYMOUS_NICKNAME;
  return nickname.length <= 32 ? nickname : null;
}

function normalizeMarkdown(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const markdown = value.replace(/\r\n?/g, '\n').trim();
  return markdown.length >= 1 && markdown.length <= 2_000 ? markdown : null;
}

async function checkNickname(
  env: Env,
  cooldownKey: string,
  nickname: string
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const now = Date.now();
  const current = await env.DB.prepare(
    'SELECT nickname, nickname_changed_at FROM comment_nickname_cooldowns WHERE identity_hash = ? AND expires_at > ?'
  ).bind(cooldownKey, now).first<{ nickname: string; nickname_changed_at: number | null }>();
  if (
    !current
    || current.nickname === nickname
    || current.nickname_changed_at === null
    || current.nickname_changed_at <= now - NICKNAME_CHANGE_COOLDOWN_MS
  ) {
    return { ok: true };
  }

  const changedAt = Number(current.nickname_changed_at);
  return {
    ok: false,
    retryAfterMs: Math.max(1_000, changedAt + NICKNAME_CHANGE_COOLDOWN_MS - now)
  };
}

async function persistNickname(env: Env, viewerHash: string, nickname: string): Promise<boolean> {
  const now = Date.now();
  const expiresAt = now + NICKNAME_CHANGE_COOLDOWN_MS;
  await env.DB.prepare(
    `INSERT INTO comment_nickname_cooldowns (identity_hash, nickname, nickname_changed_at, expires_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(identity_hash) DO NOTHING`
  ).bind(viewerHash, nickname, expiresAt).run();
  await env.DB.prepare(
    `UPDATE comment_nickname_cooldowns
     SET nickname = ?, nickname_changed_at = ?, expires_at = ?
     WHERE identity_hash = ?
       AND nickname != ?
       AND (nickname_changed_at IS NULL OR nickname_changed_at <= ?)`
  ).bind(nickname, now, expiresAt, viewerHash, nickname, now - NICKNAME_CHANGE_COOLDOWN_MS).run();
  const current = await env.DB.prepare(
    'SELECT nickname FROM comment_nickname_cooldowns WHERE identity_hash = ?'
  ).bind(viewerHash).first<{ nickname: string }>();
  return current?.nickname === nickname;
}

function renderMarkdown(markdown: string): string | null {
  const html = micromark(markdown, {
    allowDangerousHtml: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()]
  });
  const images = [...html.matchAll(/<img\s+[^>]*src="([^"]*)"[^>]*>/gi)];
  if (images.some((match) => !match[1].startsWith('https://'))) return null;
  return html.replace(/<img\s+/gi, '<img loading="lazy" referrerpolicy="no-referrer" ');
}

async function consumeRateLimit(
  env: Env,
  rule: { identityHash: string; minIntervalMs: number; tenMinuteLimit: number; dayLimit: number }
): Promise<boolean> {
  const now = Date.now();
  const tenMinStart = Math.floor(now / 600_000) * 600_000;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const expiresAt = now + 2 * 86_400_000;
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

async function consumeCommentRateLimits(env: Env, viewer: string, ip: string): Promise<boolean> {
  const keys = await Promise.all([
    rateLimitKey(env.JWT_SECRET, 'comment-device', viewer),
    rateLimitKey(env.JWT_SECRET, 'comment-ip', ip || 'unknown'),
    rateLimitKey(env.JWT_SECRET, 'comment-global', 'global')
  ]);
  const rules = [
    { identityHash: keys[0], minIntervalMs: 5_000, tenMinuteLimit: 10, dayLimit: 50 },
    { identityHash: keys[1], minIntervalMs: 0, tenMinuteLimit: 80, dayLimit: 400 },
    { identityHash: keys[2], minIntervalMs: 0, tenMinuteLimit: 500, dayLimit: 5_000 }
  ];
  for (const rule of rules) {
    if (!(await consumeRateLimit(env, rule))) return false;
  }
  await env.DB.prepare('DELETE FROM comment_rate_limits WHERE expires_at <= ?').bind(Date.now()).run().catch(() => undefined);
  return true;
}

function serialize(row: CommentRow, sessionUserId?: string | null) {
  const verified = Boolean(row.user_id);
  return {
    id: row.id,
    imageId: row.image_id,
    rootId: row.root_id,
    parentId: row.parent_id,
    nickname: verified && row.author_display ? row.author_display : row.nickname,
    content: row.markdown,
    html: row.rendered_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    likeCount: Number(row.like_count || 0),
    likedByMe: Boolean(row.liked_by_viewer),
    verified,
    authorBadge: verified ? (normalizeBadge(row.author_badge) ?? null) : null,
    authorAvatar:
      verified && row.user_id && row.author_avatar_key
        ? `/api/auth/avatar/${row.user_id}?v=${row.author_updated_at || 0}`
        : null,
    ownedByMe: Boolean(row.user_id && sessionUserId && row.user_id === sessionUserId),
    editable: Boolean(row.user_id && sessionUserId && row.user_id === sessionUserId && Number(row.edit_count || 0) < 1)
  };
}

comments.get('/', async (c) => {
  const imageId = c.req.query('imageId')?.trim();
  if (!imageId) return c.json({ error: 'image_id_required' }, 400);
  const viewer = viewerId(c);
  const session = await optionalUser(c);
  const sessionUserId = session?.user.id ?? null;
  const result = await c.env.DB.prepare(
    `SELECT c.*,
       u.badge AS author_badge,
       u.display_name AS author_display,
       u.avatar_key AS author_avatar_key,
       u.updated_at AS author_updated_at,
       COALESCE((SELECT count FROM comment_like_counts lc WHERE lc.comment_id = c.id), 0)
       + (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS like_count,
       0 AS liked_by_viewer
     FROM image_comments c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.image_id = ? AND c.status = 'visible'
     ORDER BY
       CASE WHEN like_count > 0 THEN 0 ELSE 1 END ASC,
       like_count DESC,
       created_at DESC
     LIMIT 500`
  ).bind(imageId).all<CommentRow>();
  const rows = result.results || [];
  if (viewer && rows.length > 0) {
    const ids = rows.map((row) => row.id);
    const keys = await Promise.all(ids.map((id) => commentLikeViewerKey(c.env.JWT_SECRET, id, viewer)));
    const placeholders = ids.map(() => '?').join(',');
    const liked = await c.env.DB.prepare(
      `SELECT comment_id
       FROM comment_likes
       WHERE comment_id IN (${placeholders})
         AND viewer_key IN (${placeholders})`
    ).bind(...ids, ...keys).all<{ comment_id: string }>();
    const likedIds = new Set((liked.results || []).map((row) => row.comment_id));
    for (const row of rows) row.liked_by_viewer = likedIds.has(row.id) ? 1 : 0;
  }
  const items = rows.map((row) => serialize(row, sessionUserId));
  const commentedByMe = false;
  return c.json({ items, data: items, commentedByMe });
});

comments.post('/', async (c) => {
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const imageId = stringField(body, 'imageId').trim();
  const markdown = normalizeMarkdown(stringField(body, 'content'));
  if (!imageId || !markdown) return c.json({ error: 'invalid_comment' }, 400);

  const session = await optionalUser(c);
  let nickname: string;
  if (session) {
    nickname = displayName(session.user);
  } else {
    const candidate = normalizeNickname(stringField(body, 'nickname'));
    if (!candidate) return c.json({ error: 'invalid_comment' }, 400);
    nickname = candidate;
  }

  const rendered = renderMarkdown(markdown);
  if (!rendered) return c.json({ error: 'unsafe_image_url' }, 400);
  const image = await c.env.DB.prepare("SELECT id FROM images WHERE id = ? AND sync_status != 'uploading'")
    .bind(imageId)
    .first<{ id: string }>();
  if (!image) return c.json({ error: 'image_not_found' }, 404);

  const id = nanoid(14);
  let parentId: string | null = null;
  let rootId = id;
  const requestedParentId = stringField(body, 'parentId').trim();
  if (requestedParentId) {
    const parent = await c.env.DB.prepare(
      "SELECT id, root_id FROM image_comments WHERE id = ? AND image_id = ? AND status = 'visible'"
    ).bind(requestedParentId, imageId).first<{ id: string; root_id: string }>();
    if (!parent) return c.json({ error: 'invalid_parent' }, 400);
    parentId = parent.id;
    rootId = parent.root_id;
  }

  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const userId = session ? session.user.id : null;
  if (session) {
    if (!(await consumeCommentRateLimits(c.env, `u:${session.user.id}`, ip))) {
      return c.json({ error: 'rate_limited' }, 429);
    }
  } else {
    const viewer = viewerId(c);
    if (!viewer) return c.json({ error: 'viewer_required' }, 400);
    const cooldownKey = await nicknameCooldownKey(c.env.JWT_SECRET, viewer);
    if (nickname !== ANONYMOUS_NICKNAME) {
      const nicknameResult = await checkNickname(c.env, cooldownKey, nickname);
      if (!nicknameResult.ok) {
        return c.json({ error: 'nickname_change_cooldown', retryAfterMs: nicknameResult.retryAfterMs }, 429);
      }
    }
    if (!(await consumeCommentRateLimits(c.env, viewer, ip))) return c.json({ error: 'rate_limited' }, 429);
    if (nickname !== ANONYMOUS_NICKNAME && !(await persistNickname(c.env, cooldownKey, nickname))) {
      return c.json({ error: 'nickname_change_cooldown', retryAfterMs: NICKNAME_CHANGE_COOLDOWN_MS }, 429);
    }
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO image_comments (
      id, image_id, root_id, parent_id, nickname, markdown, rendered_html, status, user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?, ?)`
  ).bind(id, imageId, rootId, parentId, nickname, markdown, rendered, userId, now, now).run();
  const row = await c.env.DB.prepare(
    `SELECT c.*, u.badge AS author_badge, u.display_name AS author_display,
       u.avatar_key AS author_avatar_key, u.updated_at AS author_updated_at
     FROM image_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`
  ).bind(id).first<CommentRow>();
  return c.json(serialize(row!, userId), 201);
});

comments.put('/:id/content', async (c) => {
  const session = await optionalUser(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const markdown = normalizeMarkdown(stringField(body, 'content'));
  if (!markdown) return c.json({ error: 'invalid_comment' }, 400);
  const rendered = renderMarkdown(markdown);
  if (!rendered) return c.json({ error: 'unsafe_image_url' }, 400);

  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    "SELECT user_id, edit_count FROM image_comments WHERE id = ? AND status = 'visible'"
  ).bind(id).first<{ user_id: string | null; edit_count: number }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.user_id !== session.user.id) return c.json({ error: 'forbidden' }, 403);
  if (Number(row.edit_count || 0) >= 1) return c.json({ error: 'edit_limit' }, 409);

  await c.env.DB.prepare(
    "UPDATE image_comments SET markdown = ?, rendered_html = ?, edit_count = edit_count + 1, updated_at = ? WHERE id = ?"
  ).bind(markdown, rendered, Date.now(), id).run();
  const updated = await c.env.DB.prepare(
    `SELECT c.*, u.badge AS author_badge, u.display_name AS author_display,
       u.avatar_key AS author_avatar_key, u.updated_at AS author_updated_at
     FROM image_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`
  ).bind(id).first<CommentRow>();
  return c.json(serialize(updated!, session.user.id));
});

comments.put('/:id', async (c) => {
  const viewer = viewerId(c);
  if (!viewer) return c.json({ error: 'viewer_required' }, 400);
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const liked = booleanField(body, 'liked');
  if (typeof liked !== 'boolean') return c.json({ error: 'liked_required' }, 400);
  const id = c.req.param('id');
  const comment = await c.env.DB.prepare("SELECT id FROM image_comments WHERE id = ? AND status = 'visible'")
    .bind(id)
    .first<{ id: string }>();
  if (!comment) return c.json({ error: 'not_found' }, 404);

  const viewerKey = await commentLikeViewerKey(c.env.JWT_SECRET, id, viewer);
  if (liked) {
    await c.env.DB.prepare(
      `INSERT INTO comment_likes (comment_id, viewer_key, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(comment_id, viewer_key) DO NOTHING`
    ).bind(id, viewerKey, Date.now()).run();
  } else {
    await c.env.DB.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND viewer_key = ?')
      .bind(id, viewerKey)
      .run();
  }
  const count = await c.env.DB.prepare(
    `SELECT COALESCE((SELECT count FROM comment_like_counts WHERE comment_id = ?), 0)
      + (SELECT COUNT(*) FROM comment_likes WHERE comment_id = ?) AS count`
  )
    .bind(id, id)
    .first<{ count: number }>();
  return c.json({ id, likedByMe: liked, likeCount: Number(count?.count || 0) });
});

comments.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT id, root_id, parent_id, user_id FROM image_comments WHERE id = ?')
    .bind(id)
    .first<{ id: string; root_id: string; parent_id: string | null; user_id: string | null }>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const session = await optionalUser(c);
  const isOwner = Boolean(session && row.user_id && row.user_id === session.user.id);
  let isAdmin = false;
  if (!isOwner) {
    const match = (c.req.header('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (match) {
      const payload = await verifyJWT<{ role?: string }>(match[1], c.env.JWT_SECRET);
      isAdmin = payload?.role === 'deleter';
    }
  }
  if (!isOwner && !isAdmin) return c.json({ error: 'unauthorized' }, 401);

  if (row.parent_id === null) {
    await c.env.DB.prepare(
      'DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM image_comments WHERE root_id = ?)'
    ).bind(row.root_id).run();
    await c.env.DB.prepare(
      'DELETE FROM comment_like_counts WHERE comment_id IN (SELECT id FROM image_comments WHERE root_id = ?)'
    ).bind(row.root_id).run().catch(() => undefined);
    await c.env.DB.prepare('DELETE FROM image_comments WHERE root_id = ?').bind(row.root_id).run();
  } else {
    await c.env.DB.prepare('DELETE FROM comment_likes WHERE comment_id = ?').bind(id).run();
    await c.env.DB.prepare('DELETE FROM comment_like_counts WHERE comment_id = ?').bind(id).run().catch(() => undefined);
    await c.env.DB.prepare('DELETE FROM image_comments WHERE id = ?').bind(id).run();
  }
  return c.json({ ok: true, id });
});

export default comments;
