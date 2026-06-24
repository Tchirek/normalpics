import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import {
  claimBlurImages,
  claimMetadataImages,
  confirmBlurImage,
  confirmImage,
  getImage,
  pendingImagesForDevice,
  shouldRepairDescription,
  syncableImages
} from '../lib/db';
import {
  normalizeDeviceId,
  normalizeDeviceName,
  setDeviceTunnelUrl,
  touchDevice,
  type DeviceIdentity
} from '../lib/devices';
import { requireDaemon } from '../lib/jwt';
import { generatePresignedGet } from '../lib/r2';
import { getRuntimeState, putRuntimeState } from '../lib/runtime';
import { normalizeTrustedTunnelOrigin } from '../lib/tunnel-url';
import { booleanField, nullableNumberField, numberField, optionalStringField, readJsonRecord, stringArrayField, stringField } from '../lib/validation';

const sync = new Hono<{ Bindings: Env; Variables: Variables }>();

function deviceFromHeaders(c: { req: { header: (name: string) => string | undefined } }): DeviceIdentity | Response {
  const deviceId = normalizeDeviceId(c.req.header('X-Device-Id'));
  if (!deviceId) {
    return Response.json({ error: 'device_id_required' }, { status: 400 });
  }

  return {
    deviceId,
    deviceName: normalizeDeviceName(c.req.header('X-Device-Name'))
  };
}

function downloadKey(row: { r2_key_orig: string | null; r2_key_web: string | null; r2_key_thumb: string | null }): string | null {
  return row.r2_key_orig || row.r2_key_web || row.r2_key_thumb;
}

sync.get('/stream', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;
  await touchDevice(c.env, device);

  const encoder = new TextEncoder();
  let lastSeen = '';
  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        closed = true;
        if (pingTimer) clearInterval(pingTimer);
        if (pollTimer) clearInterval(pollTimer);
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };

      send(': connected\n\n');

      pingTimer = setInterval(() => {
        send(': ping\n\n');
      }, 30_000);

      pollTimer = setInterval(() => {
        (async () => {
          const state = await getRuntimeState(c.env, 'sync:latest').catch(() => null);
          const latest = state?.value || await c.env.KV.get('sync:latest').catch(() => null);
          if (!latest || latest === lastSeen) return;
          lastSeen = latest;

          const payload = JSON.parse(latest) as { imageId?: string; ts?: number };
          if (payload.imageId) {
            const row = await getImage(c.env, payload.imageId);
            send(
              `data: ${JSON.stringify({
                imageId: payload.imageId,
                id: payload.imageId,
                r2KeyOrig: row ? downloadKey(row) : null,
                filename: row?.filename || null,
                uploadedAt: row?.uploaded_at || null,
                uploadedDay: row?.uploaded_day || null,
                uploadedDaySeq: row?.uploaded_day_seq || null,
                ts: payload.ts || Date.now()
              })}\n\n`
            );
          }
        })().catch((err) => {
          send(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
        });
      }, 2_000);

      c.req.raw.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (pollTimer) clearInterval(pollTimer);
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
});

sync.post('/heartbeat', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;

  const body = await readJsonRecord(c.req).catch(() => ({} as Record<string, unknown>));
  const identity = {
    ...device,
    deviceName: normalizeDeviceName(stringField(body, 'deviceName', device.deviceName || ''))
  };
  await touchDevice(c.env, identity);

  const now = String(Date.now());
  await putRuntimeState(c.env, 'pc:heartbeat', now);
  await c.env.KV.put('pc:heartbeat', now, { expirationTtl: 120 }).catch((err) => {
    console.warn('[sync] KV heartbeat skipped:', err);
  });
  return c.json({ ok: true });
});

sync.post('/tunnel-url', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;

  const body = await readJsonRecord(c.req).catch(() => ({} as Record<string, unknown>));
  const tunnelUrl = stringField(body, 'url').trim();
  if (!tunnelUrl) return c.json({ error: 'url_required' }, 400);

  const tunnelOrigin = normalizeTrustedTunnelOrigin(c.env, tunnelUrl);
  if (!tunnelOrigin) return c.json({ error: 'untrusted_tunnel_url' }, 400);

  const identity = {
    ...device,
    deviceName: normalizeDeviceName(stringField(body, 'deviceName', device.deviceName || ''))
  };
  await setDeviceTunnelUrl(c.env, identity, tunnelOrigin);

  await putRuntimeState(c.env, 'pc:tunnel_url', tunnelOrigin);
  await c.env.KV.put('pc:tunnel_url', tunnelOrigin, { expirationTtl: 7 * 24 * 60 * 60 }).catch((err) => {
    console.warn('[sync] KV tunnel URL skipped:', err);
  });
  return c.json({ ok: true });
});

sync.get('/pending', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;
  await touchDevice(c.env, device);

  const items = await pendingImagesForDevice(c.env, device.deviceId);
  return c.json({
    items: items.map((item) => ({
      id: item.id,
      imageId: item.id,
      filename: item.filename,
      uploadedAt: item.uploaded_at,
      uploadedDay: item.uploaded_day,
      uploadedDaySeq: item.uploaded_day_seq,
      r2KeyOrig: downloadKey(item)
    }))
  });
});

sync.get('/library', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;
  await touchDevice(c.env, device);

  const limit = Number(c.req.query('limit') || 200);
  const rawCursor = c.req.query('cursor');
  let cursor: { uploadedAt: number; id: string } | null = null;
  if (rawCursor) {
    try {
      const parsed = JSON.parse(atob(rawCursor)) as { uploadedAt?: number; id?: string };
      if (Number.isFinite(parsed.uploadedAt) && parsed.id) {
        cursor = { uploadedAt: Number(parsed.uploadedAt), id: String(parsed.id) };
      }
    } catch {
      cursor = null;
    }
  }

  const items = await syncableImages(c.env, limit, cursor);
  const last = items[items.length - 1];
  return c.json({
    items: items.map((item) => ({
      id: item.id,
      imageId: item.id,
      filename: item.filename,
      uploadedAt: item.uploaded_at,
      uploadedDay: item.uploaded_day,
      uploadedDaySeq: item.uploaded_day_seq,
      r2KeyOrig: downloadKey(item)
    })),
    nextCursor: last && items.length >= Math.max(1, Math.min(500, limit || 200))
      ? btoa(JSON.stringify({ uploadedAt: last.uploaded_at, id: last.id }))
      : null
  });
});

sync.post('/metadata/claim', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;

  const body = await readJsonRecord(c.req).catch(() => ({} as Record<string, unknown>));
  const identity = {
    ...device,
    deviceName: normalizeDeviceName(stringField(body, 'deviceName', device.deviceName || ''))
  };
  await touchDevice(c.env, identity);

  const items = await claimMetadataImages(
    c.env,
    identity,
    numberField(body, 'limit') ?? 12,
    Boolean(booleanField(body, 'repairTruncated'))
  );
  return c.json({
    items: items.map((item) => ({
      id: item.id,
      imageId: item.id,
      filename: item.filename,
      uploadedAt: item.uploaded_at,
      uploadedDay: item.uploaded_day,
      uploadedDaySeq: item.uploaded_day_seq,
      r2KeyOrig: downloadKey(item),
      hasDescription: Boolean(item.description?.trim()),
      needsDescriptionRepair: shouldRepairDescription(item.description),
      hasTags: Boolean(item.tags?.trim())
    }))
  });
});

sync.post('/blur/claim', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;

  const body = await readJsonRecord(c.req).catch(() => ({} as Record<string, unknown>));
  const identity = {
    ...device,
    deviceName: normalizeDeviceName(stringField(body, 'deviceName', device.deviceName || ''))
  };
  await touchDevice(c.env, identity);

  const items = await claimBlurImages(c.env, identity, numberField(body, 'limit') ?? 4);
  return c.json({
    items: items.map((item) => ({
      id: item.id,
      imageId: item.id,
      filename: item.filename,
      uploadedAt: item.uploaded_at,
      uploadedDay: item.uploaded_day,
      uploadedDaySeq: item.uploaded_day_seq,
      r2KeyOrig: downloadKey(item)
    }))
  });
});

sync.post('/blur/confirm', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;

  const body = await readJsonRecord(c.req).catch(() => ({} as Record<string, unknown>));
  const imageId = stringField(body, 'imageId').trim();
  if (!imageId) return c.json({ error: 'image_id_required' }, 400);

  const updated = await confirmBlurImage(
    c.env,
    device,
    imageId,
    nullableNumberField(body, 'width') ?? null,
    nullableNumberField(body, 'height') ?? null,
    optionalStringField(body, 'blurDataUrl') ?? null
  );
  if (!updated) return c.json({ error: 'invalid_or_unclaimed' }, 409);
  return c.json({ ok: true });
});

sync.get('/download/:id', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;
  await touchDevice(c.env, device);

  const row = await getImage(c.env, c.req.param('id'));
  const key = row ? downloadKey(row) : null;
  if (!key) return c.json({ error: 'not_found' }, 404);
  const url = await generatePresignedGet(c.env, key, 3600);
  return c.redirect(url, 302);
});

sync.post('/confirm', async (c) => {
  const denied = await requireDaemon(c);
  if (denied) return denied;
  const device = deviceFromHeaders(c);
  if (device instanceof Response) return device;

  const body = await readJsonRecord(c.req).catch(() => ({} as Record<string, unknown>));
  const imageId = stringField(body, 'imageId').trim();
  if (!imageId) return c.json({ error: 'image_id_required' }, 400);

  const tags = Array.isArray(body.tags) ? stringArrayField(body, 'tags', 24) : null;
  const updated = await confirmImage(c.env, {
    imageId,
    device,
    sha256: optionalStringField(body, 'sha256') ?? null,
    width: nullableNumberField(body, 'width') ?? null,
    height: nullableNumberField(body, 'height') ?? null,
    sizeBytes: nullableNumberField(body, 'sizeBytes') ?? null,
    description: optionalStringField(body, 'description')?.trim() || null,
    tags,
    llmModel: optionalStringField(body, 'llmModel') ?? null,
    replaceMetadata: Boolean(booleanField(body, 'replaceMetadata')),
    r2KeyWeb: optionalStringField(body, 'r2KeyWeb') ?? null,
    r2KeyThumb: optionalStringField(body, 'r2KeyThumb') ?? null,
    blurDataUrl: optionalStringField(body, 'blurDataUrl') ?? null
  });

  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export default sync;
