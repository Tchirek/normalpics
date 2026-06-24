import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { getImage } from '../lib/db';
import { onlineDevicesForImage, type OnlineDevice } from '../lib/devices';
import { normalizeTrustedTunnelOrigin } from '../lib/tunnel-url';

const proxy = new Hono<{ Bindings: Env; Variables: Variables }>();

const CACHE_HEADER = 'public, max-age=86400, stale-while-revalidate=3600';
const BROWSER_SAFE_ORIG_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

function cleanEtag(value: string | null): string {
  return (value || '').replace(/^W\//i, '').replace(/^"|"$/g, '');
}

function extFromKey(key: string): string {
  const match = key.match(/\.([A-Za-z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : '';
}

function contentTypeForKey(key: string, fallback = 'image/webp'): string {
  if (key.startsWith('web/') || key.startsWith('thumb/')) return 'image/webp';
  const ext = extFromKey(key);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return fallback;
}

function isBrowserSafeOriginal(row: { ext?: string | null }): boolean {
  return BROWSER_SAFE_ORIG_EXTS.has((row.ext || '').toLowerCase());
}

async function fetchFromDevice(
  env: Env,
  device: OnlineDevice,
  id: string,
  version: string,
  ifNoneMatch?: string,
  fallbackEtag?: string | null
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const tunnelOrigin = normalizeTrustedTunnelOrigin(env, device.tunnelUrl);
    if (!tunnelOrigin) return null;
    const url = new URL(`/img/${id}`, tunnelOrigin);
    if (version) url.searchParams.set('v', version);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) return null;
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', CACHE_HEADER);
    if (!headers.has('etag') && fallbackEtag) headers.set('etag', fallbackEtag);
    if (ifNoneMatch && cleanEtag(ifNoneMatch) && cleanEtag(headers.get('etag')) === cleanEtag(ifNoneMatch)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromOnlineDevice(
  env: Env,
  id: string,
  version: string,
  ifNoneMatch?: string,
  fallbackEtag?: string | null
): Promise<Response | null> {
  const devices = await onlineDevicesForImage(env, id);
  for (const device of devices) {
    const response = await fetchFromDevice(env, device, id, version, ifNoneMatch, fallbackEtag);
    if (response) return response;
  }
  return null;
}

proxy.get('/:id', async (c) => {
  const id = c.req.param('id');
  const version = c.req.query('v') === 'thumb' ? 'thumb' : 'web';
  const row = await getImage(c.env, id);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const ifNoneMatch = c.req.header('If-None-Match');
  const orig = isBrowserSafeOriginal(row) ? row.r2_key_orig : null;
  const keys = version === 'thumb'
    ? [row.r2_key_thumb, row.r2_key_web, orig]
    : [row.r2_key_web, row.r2_key_thumb, orig];
  const candidates = Array.from(new Set(keys.filter((key): key is string => Boolean(key))));
  if (candidates.length === 0) {
    return c.json({ error: row.sync_status === 'pending' ? 'pending' : 'not_available' }, row.sync_status === 'pending' ? 202 : 404);
  }

  let r2Etag: string | null = null;
  let r2EtagKey = '';
  for (const key of candidates) {
    const head = await c.env.R2.head(key);
    if (!head) continue;
    r2Etag = head.httpEtag;
    r2EtagKey = key;
    break;
  }

  if (ifNoneMatch && cleanEtag(ifNoneMatch) && r2Etag && cleanEtag(r2Etag) === cleanEtag(ifNoneMatch)) {
    const headers = new Headers();
    headers.set('etag', r2Etag);
    headers.set('Cache-Control', CACHE_HEADER);
    headers.set('Content-Type', contentTypeForKey(r2EtagKey));
    return new Response(null, { status: 304, headers });
  }

  if (ifNoneMatch && cleanEtag(ifNoneMatch)) {
    for (const key of candidates) {
      if (key === r2EtagKey) continue;
      const head = await c.env.R2.head(key);
      if (head && cleanEtag(head.httpEtag) === cleanEtag(ifNoneMatch)) {
        const headers = new Headers();
        headers.set('etag', head.httpEtag);
        headers.set('Cache-Control', CACHE_HEADER);
        headers.set('Content-Type', contentTypeForKey(key));
        return new Response(null, { status: 304, headers });
      }
    }
  }

  const tunneled = await fetchFromOnlineDevice(c.env, id, version, ifNoneMatch, r2Etag);
  if (tunneled) return tunneled;

  let object: R2ObjectBody | null = null;
  let objectKey = '';
  for (const key of candidates) {
    object = await c.env.R2.get(key);
    if (object?.body) {
      objectKey = key;
      break;
    }
  }
  if (!object?.body) return c.json({ error: 'not_found' }, 404);

  if (ifNoneMatch && cleanEtag(ifNoneMatch) === cleanEtag(object.httpEtag)) {
    const headers = new Headers();
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', CACHE_HEADER);
    return new Response(null, { status: 304, headers });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', CACHE_HEADER);
  headers.set('Content-Type', contentTypeForKey(objectKey, headers.get('Content-Type') || 'image/webp'));

  return new Response(object.body, { headers });
});

export default proxy;
