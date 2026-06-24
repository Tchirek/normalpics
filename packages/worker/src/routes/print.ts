import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { getImage } from '../lib/db';
import { cleanupExpiredRateLimits, clientIp, consumeRateLimit } from '../lib/rate-limit';
import { generatePresignedGet } from '../lib/r2';
import { isRecord, readJsonRecord, stringField } from '../lib/validation';
import { rateLimitKey } from '../lib/viewer-hash';

const print = new Hono<{ Bindings: Env; Variables: Variables }>();

function viewerId(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const value = (c.req.header('X-Viewer-Id') || '').trim();
  return /^[A-Za-z0-9_-]{16,80}$/.test(value) ? value : null;
}

async function consumeHandoffRateLimits(env: Env, headers: { header: (name: string) => string | undefined }): Promise<boolean> {
  const ip = clientIp(headers);
  const viewer = viewerId({ req: headers }) || 'anonymous';
  const [viewerKey, ipKey, globalKey] = await Promise.all([
    rateLimitKey(env.JWT_SECRET, 'print-handoff-viewer', viewer),
    rateLimitKey(env.JWT_SECRET, 'print-handoff-ip', ip),
    rateLimitKey(env.JWT_SECRET, 'print-handoff-global', 'global')
  ]);
  const ok = await consumeRateLimit(env, {
    identityHash: viewerKey,
    minIntervalMs: 1_500,
    tenMinuteLimit: 12,
    dayLimit: 80
  }) && await consumeRateLimit(env, {
    identityHash: ipKey,
    minIntervalMs: 0,
    tenMinuteLimit: 40,
    dayLimit: 200
  }) && await consumeRateLimit(env, {
    identityHash: globalKey,
    minIntervalMs: 0,
    tenMinuteLimit: 300,
    dayLimit: 2_000
  });
  await cleanupExpiredRateLimits(env);
  return ok;
}

print.post('/handoff', async (c) => {
  if (!(await consumeHandoffRateLimits(c.env, c.req))) return c.json({ error: 'rate_limited' }, 429);

  const body = await readJsonRecord(c.req).catch(() => ({}));
  const imageId = stringField(body, 'imageId').trim();
  if (!imageId) return c.json({ error: 'image_id_required' }, 400);

  const image = await getImage(c.env, imageId);
  if (!image || !['pending', 'synced'].includes(image.sync_status)) {
    return c.json({ error: 'image_not_ready' }, 409);
  }
  const key = image.r2_key_web || image.r2_key_orig;
  if (!key) return c.json({ error: 'image_not_available' }, 404);

  const object = await c.env.R2.head(key);
  if (!object || object.size <= 0) return c.json({ error: 'image_not_available' }, 404);

  const contentType = normalizeImageContentType(
    contentTypeForKey(key, object.httpMetadata?.contentType || '', image.ext)
  );
  if (!contentType) return c.json({ error: 'image_type_not_supported' }, 415);
  const baseUrl = c.env.PRINT_609_BASE_URL?.trim().replace(/\/$/, '');
  if (!baseUrl || !c.env.PRINT_609_HANDOFF_SECRET) {
    return c.json({ error: 'print_handoff_not_configured' }, 503);
  }

  const response = await fetch(`${baseUrl}/api/photohost/handoff`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.PRINT_609_HANDOFF_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      file_name: imagePrintFilename(image.filename, contentType),
      mime_type: contentType,
      size_bytes: object.size
    })
  });
  const rawPayload: unknown = await response.json().catch(() => ({ error: `print_handoff_${response.status}` }));
  const payload = isRecord(rawPayload) ? rawPayload : { error: `print_handoff_${response.status}` };
  if (!response.ok) return c.json(payload, response.status as 400);
  return c.json({
    ...payload,
    source_url: await generatePresignedGet(c.env, key, 10 * 60)
  });
});

function normalizeImageContentType(value: string): string | null {
  const normalized = value.trim().toLowerCase().split(';')[0];
  return ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif'].includes(normalized)
    ? normalized
    : null;
}

function imagePrintFilename(filename: string, contentType: string): string {
  const clean = filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim();
  const stem = clean.replace(/\.[^.]+$/, '') || 'NormalPics';
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length);
  return `${stem}.${extension}`;
}

function contentTypeForKey(key: string, fallback: string, sourceExtension: string): string {
  if (key.startsWith('web/') || key.startsWith('thumb/')) return 'image/webp';
  const extension = key.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || sourceExtension.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'bmp') return 'image/bmp';
  return fallback;
}

export default print;
