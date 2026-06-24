import type { Env, ImageRow } from '../types';
import { deleteImageDeviceRows, missingImagesForDevice, recordImageOnDevice, type DeviceIdentity } from './devices';
import { normalizeBlurDataUrl, normalizeDimension } from './blur';
import { imageLikeViewerKey } from './viewer-hash';

export interface NewImageRecord {
  id: string;
  filename: string;
  ext: string;
  r2KeyOrig: string;
  width?: number | null;
  height?: number | null;
  blurDataUrl?: string | null;
}

export interface ConfirmImageInput {
  imageId: string;
  device?: DeviceIdentity | null;
  sha256?: string | null;
  llmModel?: string | null;
  replaceMetadata?: boolean;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  description?: string | null;
  tags?: string[] | null;
  r2KeyWeb?: string | null;
  r2KeyThumb?: string | null;
  blurDataUrl?: string | null;
}

function uploadDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function allocateUploadSequence(env: Env, day: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO upload_days (day, next_seq)
     VALUES (?, 2)
     ON CONFLICT(day) DO UPDATE SET next_seq = next_seq + 1
     RETURNING next_seq - 1 AS seq`
  )
    .bind(day)
    .first<{ seq: number }>();
  return row?.seq || 1;
}

function normalizeTags(tags?: string[] | null): string | null {
  if (!Array.isArray(tags)) return null;
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of tags) {
    const tag = String(raw)
      .trim()
      .replace(/^#+/, '')
      .replace(/[\s#,.;:\uFF0C\u3002\uFF1B\uFF1A\u3001]+/g, '')
      .slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(`#${tag}`);
    if (normalized.length >= 4) break;
  }

  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function searchTokens(search?: string | null): string[] {
  return (search || '')
    .toLowerCase()
    .replace(/#/g, ' ')
    .split(/[\s#,.;:\uFF0C\u3002\uFF1B\uFF1A\u3001]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function shouldRepairDescription(value?: string | null): boolean {
  const text = value?.trim();
  if (!text) return false;
  if (text.length < 10 || text.length > 200) return false;
  if (/[。！？.!?]$/.test(text)) return false;
  return /[，、：；,;:的了吗呢吧啊呀着过和与或到在从被把将]$/.test(text);
}

export async function insertPendingImage(env: Env, record: NewImageRecord): Promise<void> {
  const now = Date.now();
  const day = uploadDay(now);
  const seq = await allocateUploadSequence(env, day);
  await env.DB.prepare(
    `INSERT INTO images (
       id, filename, ext, r2_key_orig, width, height, blur_data_url,
       sync_status, uploaded_at, uploaded_day, uploaded_day_seq
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`
  )
    .bind(
      record.id,
      record.filename,
      record.ext,
      record.r2KeyOrig,
      normalizeDimension(record.width),
      normalizeDimension(record.height),
      normalizeBlurDataUrl(record.blurDataUrl),
      now,
      day,
      seq
    )
    .run();
}

export async function getImage(env: Env, imageId: string): Promise<ImageRow | null> {
  return env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(imageId).first<ImageRow>();
}

export async function imageCommentCounts(env: Env, imageIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(imageIds)).slice(0, 100);
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const result = await env.DB.prepare(
      `SELECT image_id, COUNT(*) AS count
       FROM image_comments
       WHERE status = 'visible' AND image_id IN (${placeholders})
       GROUP BY image_id`
    ).bind(...ids).all<{ image_id: string; count: number }>();
    for (const row of result.results || []) counts.set(row.image_id, Number(row.count || 0));
  } catch (error) {
    if (!String(error).toLowerCase().includes('no such table')) throw error;
  }
  return counts;
}

export interface ImageCommentInfo {
  count: number;
  commentedByViewer: boolean;
}

export async function imageCommentInfo(
  env: Env,
  imageIds: string[],
  viewerId?: string | null
): Promise<Map<string, ImageCommentInfo>> {
  const ids = Array.from(new Set(imageIds)).filter(Boolean).slice(0, 100);
  const counts = await imageCommentCounts(env, ids);
  const map = new Map(ids.map((id) => [
    id,
    { count: counts.get(id) || 0, commentedByViewer: false }
  ]));
  void env;
  void viewerId;
  return map;
}

export async function deleteImage(env: Env, imageId: string): Promise<ImageRow | null> {
  const current = await getImage(env, imageId);
  if (!current) return null;

  const keys = Array.from(new Set([
    current.r2_key_orig,
    current.r2_key_web,
    current.r2_key_thumb
  ].filter((key): key is string => Boolean(key))));

  await deleteImageDeviceRows(env, imageId);
  await env.DB.prepare('DELETE FROM image_likes WHERE image_id = ?').bind(imageId).run();
  await env.DB.prepare('DELETE FROM image_like_counts WHERE image_id = ?').bind(imageId).run().catch(() => undefined);
  await env.DB.prepare(
    'DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM image_comments WHERE image_id = ?)'
  ).bind(imageId).run().catch(() => undefined);
  await env.DB.prepare(
    'DELETE FROM comment_like_counts WHERE comment_id IN (SELECT id FROM image_comments WHERE image_id = ?)'
  ).bind(imageId).run().catch(() => undefined);
  await env.DB.prepare('DELETE FROM image_comments WHERE image_id = ?').bind(imageId).run().catch(() => undefined);
  await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(imageId).run();
  await Promise.allSettled(keys.map((key) => env.R2.delete(key)));
  return current;
}

export async function listImages(
  env: Env,
  limit: number,
  cursor?: number | null,
  search?: string | null
): Promise<ImageRow[]> {
  const tokens = searchTokens(search);
  const where = ["sync_status != 'uploading'"];
  const binds: Array<string | number> = [];

  if (cursor) {
    where.push('uploaded_at < ?');
    binds.push(cursor);
  }

  for (const token of tokens) {
    where.push(`(LOWER(COALESCE(description, "")) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(tags, "")) LIKE ? ESCAPE '\\')`);
    const like = `%${escapeLike(token)}%`;
    binds.push(like, like);
  }

  const result = await env.DB.prepare(
    `SELECT * FROM images WHERE ${where.join(' AND ')} ORDER BY uploaded_at DESC LIMIT ?`
  )
    .bind(...binds, limit)
    .all<ImageRow>();
  return result.results || [];
}

export async function countImages(env: Env, search?: string | null): Promise<number> {
  const tokens = searchTokens(search);
  const where = ["sync_status != 'uploading'"];
  const binds: string[] = [];

  for (const token of tokens) {
    where.push(`(LOWER(COALESCE(description, "")) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(tags, "")) LIKE ? ESCAPE '\\')`);
    const like = `%${escapeLike(token)}%`;
    binds.push(like, like);
  }

  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM images WHERE ${where.join(' AND ')}`)
    .bind(...binds)
    .first<{ total: number }>();
  return row?.total || 0;
}

export async function markImagePending(env: Env, imageId: string): Promise<void> {
  await env.DB.prepare("UPDATE images SET sync_status = 'pending' WHERE id = ?").bind(imageId).run();
}

export async function pendingImages(env: Env): Promise<ImageRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM images
     WHERE sync_status = 'pending' AND (r2_key_orig IS NOT NULL OR r2_key_web IS NOT NULL)
     ORDER BY uploaded_at ASC`
  ).all<ImageRow>();
  return result.results || [];
}

export async function pendingImagesForDevice(env: Env, deviceId: string): Promise<ImageRow[]> {
  return missingImagesForDevice(env, deviceId);
}

export async function syncableImages(
  env: Env,
  limit: number,
  cursor?: { uploadedAt: number; id: string } | null
): Promise<ImageRow[]> {
  const cappedLimit = Math.max(1, Math.min(500, limit || 200));
  const where = [
    "sync_status != 'uploading'",
    '(r2_key_orig IS NOT NULL OR r2_key_web IS NOT NULL OR r2_key_thumb IS NOT NULL)'
  ];
  const binds: Array<string | number> = [];

  if (cursor) {
    where.push('(uploaded_at > ? OR (uploaded_at = ? AND id > ?))');
    binds.push(cursor.uploadedAt, cursor.uploadedAt, cursor.id);
  }

  const result = await env.DB.prepare(
    `SELECT * FROM images
     WHERE ${where.join(' AND ')}
     ORDER BY uploaded_at ASC, id ASC
     LIMIT ?`
  )
    .bind(...binds, cappedLimit)
    .all<ImageRow>();

  return result.results || [];
}

export async function claimMetadataImages(
  env: Env,
  device: DeviceIdentity,
  limit: number,
  repairTruncated = false
): Promise<ImageRow[]> {
  const now = Date.now();
  const leaseCutoff = now - 10 * 60 * 1000;
  const cappedLimit = Math.max(1, Math.min(50, limit || 12));

  const result = await env.DB.prepare(
    `UPDATE images
     SET metadata_claim_device_id = ?,
         metadata_claimed_at = ?
     WHERE id IN (
       SELECT id
       FROM images
       WHERE sync_status != 'uploading'
         AND (r2_key_orig IS NOT NULL OR r2_key_web IS NOT NULL OR r2_key_thumb IS NOT NULL)
         AND (
           description IS NULL OR TRIM(description) = ''
           OR tags IS NULL OR TRIM(tags) = ''
           OR (
             ?
             AND description IS NOT NULL
             AND TRIM(description) != ''
             AND LENGTH(TRIM(description)) BETWEEN 18 AND 38
             AND SUBSTR(TRIM(description), -1) NOT IN ('\u3002', '.', '!', '\uFF01', '?', '\uFF1F')
           )
         )
         AND (
           metadata_claim_device_id IS NULL
           OR metadata_claimed_at IS NULL
           OR metadata_claimed_at < ?
           OR metadata_claim_device_id = ?
         )
       ORDER BY uploaded_at ASC, id ASC
       LIMIT ?
     )
     RETURNING *`
  )
    .bind(device.deviceId, now, repairTruncated ? 1 : 0, leaseCutoff, device.deviceId, cappedLimit)
    .all<ImageRow>();

  return result.results || [];
}

export async function claimBlurImages(
  env: Env,
  device: DeviceIdentity,
  limit: number
): Promise<ImageRow[]> {
  const now = Date.now();
  const leaseCutoff = now - 10 * 60 * 1000;
  const cappedLimit = Math.max(1, Math.min(20, limit || 4));

  const result = await env.DB.prepare(
    `UPDATE images
     SET blur_claim_device_id = ?,
         blur_claimed_at = ?
     WHERE id IN (
       SELECT id
       FROM images
       WHERE sync_status != 'uploading'
         AND (r2_key_orig IS NOT NULL OR r2_key_web IS NOT NULL OR r2_key_thumb IS NOT NULL)
         AND (blur_data_url IS NULL OR width IS NULL OR height IS NULL)
         AND (
           blur_claim_device_id IS NULL
           OR blur_claimed_at IS NULL
           OR blur_claimed_at < ?
           OR blur_claim_device_id = ?
         )
       ORDER BY uploaded_at ASC, id ASC
       LIMIT ?
     )
     RETURNING *`
  )
    .bind(device.deviceId, now, leaseCutoff, device.deviceId, cappedLimit)
    .all<ImageRow>();

  return result.results || [];
}

export async function confirmBlurImage(
  env: Env,
  device: DeviceIdentity,
  imageId: string,
  width: unknown,
  height: unknown,
  blurDataUrl: unknown
): Promise<ImageRow | null> {
  const normalizedWidth = normalizeDimension(width);
  const normalizedHeight = normalizeDimension(height);
  const normalizedBlur = normalizeBlurDataUrl(blurDataUrl);
  if (!normalizedWidth || !normalizedHeight || !normalizedBlur) return null;

  const result = await env.DB.prepare(
    `UPDATE images
     SET width = ?,
         height = ?,
         blur_data_url = ?,
         blur_claim_device_id = NULL,
         blur_claimed_at = NULL
     WHERE id = ? AND blur_claim_device_id = ?
     RETURNING *`
  )
    .bind(normalizedWidth, normalizedHeight, normalizedBlur, imageId, device.deviceId)
    .first<ImageRow>();
  return result || null;
}

export async function confirmImage(env: Env, input: ConfirmImageInput): Promise<ImageRow | null> {
  const current = await getImage(env, input.imageId);
  if (!current) return null;

  const tagsJson = normalizeTags(input.tags);
  const description = input.description?.trim().slice(0, 220) || null;
  const hasMetadata = Boolean(description || tagsJson);
  const ownsMetadataClaim = Boolean(input.device?.deviceId && current.metadata_claim_device_id === input.device.deviceId);
  const shouldReplaceDescription = Boolean(
    input.replaceMetadata &&
    ownsMetadataClaim &&
    description &&
    shouldRepairDescription(current.description)
  );
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE images
     SET sync_status = 'synced',
         synced_at = COALESCE(synced_at, ?),
         r2_key_web = COALESCE(?, r2_key_web),
         r2_key_thumb = COALESCE(?, r2_key_thumb),
         width = COALESCE(?, width),
         height = COALESCE(?, height),
         blur_data_url = COALESCE(?, blur_data_url),
         size_bytes = COALESCE(?, size_bytes),
         description = CASE
           WHEN ? THEN ?
           WHEN description IS NULL OR TRIM(description) = '' THEN COALESCE(?, description)
           ELSE description
         END,
         tags = CASE
           WHEN tags IS NULL OR TRIM(tags) = '' THEN COALESCE(?, tags)
           ELSE tags
         END,
         metadata_device_id = CASE
           WHEN ? AND (metadata_at IS NULL OR ?) THEN ?
           ELSE metadata_device_id
         END,
         metadata_model = CASE
           WHEN ? AND (metadata_at IS NULL OR ?) THEN ?
           ELSE metadata_model
         END,
         metadata_at = CASE
           WHEN ? AND (metadata_at IS NULL OR ?) THEN ?
           ELSE metadata_at
         END,
         metadata_claim_device_id = CASE
           WHEN ? AND metadata_claim_device_id = ? THEN NULL
           ELSE metadata_claim_device_id
         END,
         metadata_claimed_at = CASE
           WHEN ? AND metadata_claim_device_id = ? THEN NULL
           ELSE metadata_claimed_at
         END
     WHERE id = ?`
  )
    .bind(
      now,
      input.r2KeyWeb ?? null,
      input.r2KeyThumb ?? null,
      input.width ?? null,
      input.height ?? null,
      normalizeBlurDataUrl(input.blurDataUrl),
      input.sizeBytes ?? null,
      shouldReplaceDescription ? 1 : 0,
      description,
      description,
      tagsJson,
      hasMetadata ? 1 : 0,
      shouldReplaceDescription ? 1 : 0,
      input.device?.deviceId ?? null,
      hasMetadata ? 1 : 0,
      shouldReplaceDescription ? 1 : 0,
      input.llmModel ?? null,
      hasMetadata ? 1 : 0,
      shouldReplaceDescription ? 1 : 0,
      now,
      hasMetadata ? 1 : 0,
      input.device?.deviceId ?? null,
      hasMetadata ? 1 : 0,
      input.device?.deviceId ?? null,
      input.imageId
    )
    .run();

  if (input.device) {
    await recordImageOnDevice(env, input.imageId, input.device, input.sha256 ?? null);
  }

  return getImage(env, input.imageId);
}

export async function markImageFailed(env: Env, imageId: string): Promise<void> {
  await env.DB.prepare("UPDATE images SET sync_status = 'failed' WHERE id = ?").bind(imageId).run();
}

export async function discardUploadingImage(env: Env, imageId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM images WHERE id = ? AND sync_status = 'uploading'").bind(imageId).run();
}

export async function imagesByIds(env: Env, imageIds: string[]): Promise<ImageRow[]> {
  if (imageIds.length === 0) return [];
  const placeholders = imageIds.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT * FROM images WHERE id IN (${placeholders})`)
    .bind(...imageIds)
    .all<ImageRow>();
  const byId = new Map((result.results || []).map((row) => [row.id, row]));
  return imageIds.map((id) => byId.get(id)).filter((row): row is ImageRow => Boolean(row));
}

export async function downloadableImages(
  env: Env,
  search?: string | null,
  limit = 65_535
): Promise<ImageRow[]> {
  const tokens = searchTokens(search);
  const where = [
    "sync_status != 'uploading'",
    'r2_key_orig IS NOT NULL'
  ];
  const binds: Array<string | number> = [];

  for (const token of tokens) {
    where.push(`(LOWER(COALESCE(description, "")) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(tags, "")) LIKE ? ESCAPE '\\')`);
    const like = `%${escapeLike(token)}%`;
    binds.push(like, like);
  }

  const result = await env.DB.prepare(
    `SELECT * FROM images
     WHERE ${where.join(' AND ')}
     ORDER BY uploaded_at DESC
     LIMIT ?`
  )
    .bind(...binds, Math.max(1, Math.min(65_535, limit)))
    .all<ImageRow>();
  return result.results || [];
}

export interface ImageLikeInfo {
  count: number;
  likedByViewer: boolean;
}

export async function imageLikeInfo(
  env: Env,
  imageIds: string[],
  viewerId?: string | null
): Promise<Map<string, ImageLikeInfo>> {
  const ids = Array.from(new Set(imageIds)).filter(Boolean);
  const map = new Map(ids.map((id) => [id, { count: 0, likedByViewer: false }]));
  if (ids.length === 0) return map;

  const placeholders = ids.map(() => '?').join(',');
  const counts = await env.DB.prepare(
    `SELECT image_id, SUM(count) AS count
     FROM (
       SELECT image_id, COUNT(*) AS count
       FROM image_likes
       WHERE image_id IN (${placeholders})
       GROUP BY image_id
       UNION ALL
       SELECT image_id, count
       FROM image_like_counts
       WHERE image_id IN (${placeholders})
     )
     GROUP BY image_id`
  )
    .bind(...ids, ...ids)
    .all<{ image_id: string; count: number }>();

  for (const row of counts.results || []) {
    const current = map.get(row.image_id);
    if (current) current.count = row.count || 0;
  }

  if (viewerId) {
    const viewerKeys = await Promise.all(ids.map((id) => imageLikeViewerKey(env.JWT_SECRET, id, viewerId)));
    const liked = await env.DB.prepare(
      `SELECT image_id
       FROM image_likes
       WHERE image_id IN (${placeholders})
         AND viewer_key IN (${placeholders})`
    )
      .bind(...ids, ...viewerKeys)
      .all<{ image_id: string }>();

    for (const row of liked.results || []) {
      const current = map.get(row.image_id);
      if (current) current.likedByViewer = true;
    }
  }

  return map;
}

export async function setImageLike(
  env: Env,
  imageId: string,
  viewerId: string,
  liked: boolean
): Promise<ImageLikeInfo | null> {
  const image = await getImage(env, imageId);
  if (!image) return null;

  if (liked) {
    const viewerKey = await imageLikeViewerKey(env.JWT_SECRET, imageId, viewerId);
    await env.DB.prepare(
      `INSERT INTO image_likes (image_id, viewer_key, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(image_id, viewer_key) DO NOTHING`
    )
      .bind(imageId, viewerKey, Date.now())
      .run();
  } else {
    const viewerKey = await imageLikeViewerKey(env.JWT_SECRET, imageId, viewerId);
    await env.DB.prepare('DELETE FROM image_likes WHERE image_id = ? AND viewer_key = ?')
      .bind(imageId, viewerKey)
      .run();
  }

  const info = await imageLikeInfo(env, [imageId], viewerId);
  return info.get(imageId) || { count: 0, likedByViewer: false };
}
