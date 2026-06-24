import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Env, Variables } from '../types';
import { authMiddleware } from '../lib/jwt';
import { discardUploadingImage, getImage, insertPendingImage, markImagePending } from '../lib/db';
import { generatePresignedPut } from '../lib/r2';
import { putRuntimeState } from '../lib/runtime';
import { numberField, optionalStringField, readJsonRecord, stringField } from '../lib/validation';

const upload = new Hono<{ Bindings: Env; Variables: Variables }>();

function extensionFromName(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || 'bin';
}

function safeFilename(value: string): string {
  return value
    .replace(/[\\/\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'photo';
}

async function appendQueue(env: Env, imageId: string): Promise<void> {
  const key = 'sync:queue';
  const event = JSON.stringify({ imageId, ts: Date.now() });

  await putRuntimeState(env, 'sync:latest', event).catch((err) => {
    console.warn('[upload] failed to write D1 sync event:', err);
  });

  try {
    const existing = await env.KV.get<string[]>(key, 'json').catch(() => null);
    const queue = Array.isArray(existing) ? existing : [];
    if (!queue.includes(imageId)) queue.push(imageId);
    await env.KV.put(key, JSON.stringify(queue.slice(-500)));
    await env.KV.put('sync:latest', event);
  } catch (err) {
    console.warn('[upload] KV sync event skipped:', err);
  }
}

upload.get('/sign', authMiddleware, async (c) => {
  const filename = c.req.query('filename')?.trim();
  const contentType = c.req.query('contentType')?.trim() || 'application/octet-stream';
  if (!filename) return c.json({ error: 'filename_required' }, 400);

  const imageId = nanoid(12);
  const r2KeyOrig = `orig/${imageId}`;
  const uploadUrl = await generatePresignedPut(c.env, r2KeyOrig, contentType, 3600);

  await insertPendingImage(c.env, {
    id: imageId,
    filename,
    ext: extensionFromName(filename),
    r2KeyOrig
  });

  return c.json({ imageId, uploadUrl, r2Key: r2KeyOrig });
});

upload.post('/sign', authMiddleware, async (c) => {
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const filename = stringField(body, 'filename').trim();
  const contentType = stringField(body, 'contentType', 'application/octet-stream').trim() || 'application/octet-stream';
  if (!filename) return c.json({ error: 'filename_required' }, 400);

  const imageId = nanoid(12);
  const r2KeyOrig = `orig/${imageId}`;
  const uploadUrl = await generatePresignedPut(c.env, r2KeyOrig, contentType, 3600);

  await insertPendingImage(c.env, {
    id: imageId,
    filename: safeFilename(filename),
    ext: extensionFromName(filename),
    r2KeyOrig,
    width: numberField(body, 'width') ?? null,
    height: numberField(body, 'height') ?? null,
    blurDataUrl: optionalStringField(body, 'blurDataUrl') ?? null
  });

  return c.json({ imageId, uploadUrl, r2Key: r2KeyOrig });
});

upload.post('/file', authMiddleware, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const value = form?.get('file');
  if (!value || typeof value === 'string') return c.json({ error: 'file_required' }, 400);

  const file = value as File;
  const filename = safeFilename(file.name || form?.get('filename')?.toString() || 'photo');
  const contentType = file.type || form?.get('contentType')?.toString() || 'application/octet-stream';
  const imageId = nanoid(12);
  const r2KeyOrig = `orig/${imageId}`;

  await insertPendingImage(c.env, {
    id: imageId,
    filename,
    ext: extensionFromName(filename),
    r2KeyOrig,
    width: Number(form?.get('width')) || null,
    height: Number(form?.get('height')) || null,
    blurDataUrl: form?.get('blurDataUrl')?.toString() || null
  });

  try {
    await c.env.R2.put(r2KeyOrig, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: { filename }
    });
    await markImagePending(c.env, imageId);
    await appendQueue(c.env, imageId);
    return c.json({ ok: true, imageId, r2Key: r2KeyOrig });
  } catch (err) {
    await Promise.allSettled([
      c.env.R2.delete(r2KeyOrig),
      discardUploadingImage(c.env, imageId)
    ]);
    console.error('[upload] proxied upload failed:', err);
    return c.json({ error: 'upload_failed' }, 502);
  }
});

upload.post('/notify', authMiddleware, async (c) => {
  const body = await readJsonRecord(c.req).catch(() => ({}));
  const imageId = stringField(body, 'imageId').trim();
  if (!imageId) return c.json({ error: 'image_id_required' }, 400);

  const image = await getImage(c.env, imageId);
  if (!image) return c.json({ error: 'not_found' }, 404);
  if (!image.r2_key_orig) return c.json({ error: 'not_available' }, 409);

  const object = await c.env.R2.head(image.r2_key_orig);
  if (!object) return c.json({ error: 'upload_not_found' }, 400);

  await markImagePending(c.env, imageId);
  await appendQueue(c.env, imageId);
  return c.json({ ok: true });
});

export default upload;
