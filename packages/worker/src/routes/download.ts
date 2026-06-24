import { Hono } from 'hono';
import type { Env, ImageRow, Variables } from '../types';
import { downloadableImages, getImage, imagesByIds } from '../lib/db';
import { cleanupExpiredRateLimits, clientIp, consumeRateLimit } from '../lib/rate-limit';
import { booleanField, isRecord, readJsonRecord, stringArrayField, stringField } from '../lib/validation';
import { rateLimitKey } from '../lib/viewer-hash';

const download = new Hono<{ Bindings: Env; Variables: Variables }>();

const ZIP_PREFETCH = 8;
const ZIP_LIMIT = 50;
const ZIP_ALL_LIMIT = 65_535;
const ZIP_MAX_TOTAL_BYTES = Math.floor(3.5 * 1024 * 1024 * 1024);
const encoder = new TextEncoder();

interface ZipEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

interface ZipItem {
  row: ImageRow;
  key: string;
  size: number;
}

function cleanFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function publicBaseName(row: ImageRow): string {
  const day = row.uploaded_day || new Date(row.uploaded_at).toISOString().slice(0, 10);
  const seq = row.uploaded_day_seq ? `-${row.uploaded_day_seq}` : '';
  return `NormalPics-${day}${seq}-${row.id}`;
}

function keyExt(key: string): string {
  const match = key.match(/\.([A-Za-z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : 'webp';
}

function originalDownloadKey(row: ImageRow): string | null {
  return row.r2_key_orig;
}

function downloadName(row: ImageRow, key: string): string {
  const safeBase = cleanFilename(publicBaseName(row)) || row.id;

  if (key === row.r2_key_orig) {
    return `${safeBase}.${row.ext || keyExt(key) || 'bin'}`;
  }

  return `${safeBase}.${keyExt(key)}`;
}

function uniqueZipName(filename: string, used: Map<string, number>): string {
  const seen = used.get(filename) || 0;
  used.set(filename, seen + 1);
  if (seen === 0) return filename;

  const dot = filename.lastIndexOf('.');
  const suffix = ` (${seen + 1})`;
  return dot > 0 ? `${filename.slice(0, dot)}${suffix}${filename.slice(dot)}` : `${filename}${suffix}`;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function contentTypeFor(key: string): string {
  const ext = keyExt(key);
  if (ext === 'webp') return 'image/webp';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  return 'application/octet-stream';
}

async function consumeZipRateLimits(env: Env, headers: { header: (name: string) => string | undefined }): Promise<boolean> {
  const ip = clientIp(headers);
  const [ipKey, globalKey] = await Promise.all([
    rateLimitKey(env.JWT_SECRET, 'download-zip-ip', ip),
    rateLimitKey(env.JWT_SECRET, 'download-zip-global', 'global')
  ]);
  const ok = await consumeRateLimit(env, {
    identityHash: ipKey,
    minIntervalMs: 1_000,
    tenMinuteLimit: 12,
    dayLimit: 80
  }) && await consumeRateLimit(env, {
    identityHash: globalKey,
    minIntervalMs: 0,
    tenMinuteLimit: 300,
    dayLimit: 2_000
  });
  await cleanupExpiredRateLimits(env);
  return ok;
}

async function resolveZipItems(env: Env, rows: ImageRow[]): Promise<{ items: ZipItem[]; totalSize: number }> {
  const items: ZipItem[] = [];
  let totalSize = 0;
  for (const row of rows) {
    const key = originalDownloadKey(row);
    if (!key) continue;
    const object = await env.R2.head(key);
    if (!object) continue;
    totalSize += object.size;
    if (totalSize > ZIP_MAX_TOTAL_BYTES) break;
    items.push({ row, key, size: object.size });
  }
  return { items, totalSize };
}

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

function crcUpdate(crc: number, chunk: Uint8Array): number {
  const lookup = table();
  let next = crc;
  for (let i = 0; i < chunk.length; i += 1) {
    next = lookup[(next ^ chunk[i]) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function bytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function localHeader(nameBytes: Uint8Array, time: number, date: number): Uint8Array {
  const out = bytes(30 + nameBytes.length);
  const view = new DataView(out.buffer);
  u32(view, 0, 0x04034b50);
  u16(view, 4, 20);
  u16(view, 6, 0x0808);
  u16(view, 8, 0);
  u16(view, 10, time);
  u16(view, 12, date);
  u16(view, 26, nameBytes.length);
  out.set(nameBytes, 30);
  return out;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const out = bytes(16);
  const view = new DataView(out.buffer);
  u32(view, 0, 0x08074b50);
  u32(view, 4, crc);
  u32(view, 8, size);
  u32(view, 12, size);
  return out;
}

function centralHeader(entry: ZipEntry): Uint8Array {
  const out = bytes(46 + entry.nameBytes.length);
  const view = new DataView(out.buffer);
  u32(view, 0, 0x02014b50);
  u16(view, 4, 20);
  u16(view, 6, 20);
  u16(view, 8, 0x0808);
  u16(view, 10, 0);
  u16(view, 12, entry.time);
  u16(view, 14, entry.date);
  u32(view, 16, entry.crc);
  u32(view, 20, entry.size);
  u32(view, 24, entry.size);
  u16(view, 28, entry.nameBytes.length);
  u32(view, 42, entry.offset);
  out.set(entry.nameBytes, 46);
  return out;
}

function endOfCentralDirectory(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const out = bytes(22);
  const view = new DataView(out.buffer);
  u32(view, 0, 0x06054b50);
  u16(view, 8, count);
  u16(view, 10, count);
  u32(view, 12, centralSize);
  u32(view, 16, centralOffset);
  return out;
}

download.get('/file/:id', async (c) => {
  const row = await getImage(c.env, c.req.param('id'));
  const key = row ? originalDownloadKey(row) : null;
  if (!row || !key) return c.json({ error: 'not_found' }, 404);

  const object = await c.env.R2.get(key);
  if (!object?.body) return c.json({ error: 'not_found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', headers.get('Content-Type') || contentTypeFor(key));
  headers.set('Content-Length', String(object.size));
  headers.set('Content-Disposition', contentDisposition(downloadName(row, key)));
  headers.set('Cache-Control', 'no-store');

  return new Response(object.body, { headers });
});

download.post('/zip', async (c) => {
  if (!(await consumeZipRateLimits(c.env, c.req))) return c.json({ error: 'rate_limited' }, 429);

  const contentType = c.req.header('Content-Type') || '';
  let requestedIds: string[] = [];
  let allRequested = false;
  let search: string | null = null;
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await c.req.formData().catch(() => null);
    allRequested = form?.get('all') === '1' || form?.get('all') === 'true';
    const rawSearch = form?.get('q');
    search = typeof rawSearch === 'string' ? rawSearch.trim() : null;
    const raw = form?.get('imageIds');
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        requestedIds = Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === 'string')
          : [];
      } catch {
        requestedIds = [];
      }
    }
  } else {
    const body = await readJsonRecord(c.req).catch(() => ({}));
    if (isRecord(body)) {
      allRequested = Boolean(booleanField(body, 'all'));
      search = stringField(body, 'q').trim() || null;
      requestedIds = stringArrayField(body, 'imageIds', ZIP_LIMIT);
    }
  }

  const rows = allRequested
    ? await downloadableImages(c.env, search, ZIP_ALL_LIMIT)
    : (await imagesByIds(
      c.env,
      Array.from(new Set(requestedIds.filter((id): id is string => typeof id === 'string'))).slice(0, ZIP_LIMIT)
    )).filter((row) => originalDownloadKey(row));

  if (rows.length === 0) return c.json({ error: 'not_available' }, 404);
  const { items, totalSize } = await resolveZipItems(c.env, rows);
  if (totalSize > ZIP_MAX_TOTAL_BYTES) return c.json({ error: 'zip_too_large' }, 413);
  if (items.length === 0) return c.json({ error: 'not_available' }, 404);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const entries: ZipEntry[] = [];
      const objectPromises = new Map<number, Promise<R2ObjectBody | null>>();
      const usedNames = new Map<string, number>();
      let offset = 0;
      let closed = false;

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        controller.enqueue(chunk);
        offset += chunk.byteLength;
      };

      const prefetch = (index: number) => {
        if (index >= items.length || objectPromises.has(index)) return;
        objectPromises.set(index, c.env.R2.get(items[index].key));
      };

      try {
        for (let i = 0; i < Math.min(ZIP_PREFETCH, items.length); i += 1) prefetch(i);

        for (let i = 0; i < items.length; i += 1) {
          prefetch(i + ZIP_PREFETCH);
          const { row, key } = items[i];
          const object = await objectPromises.get(i);
          objectPromises.delete(i);
          if (!object?.body) continue;

          const { time, date } = dosDateTime();
          const nameBytes = encoder.encode(uniqueZipName(downloadName(row, key), usedNames));
          const localOffset = offset;
          enqueue(localHeader(nameBytes, time, date));

          const reader = object.body.getReader();
          let crc = 0xffffffff;
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            crc = crcUpdate(crc, value);
            size += value.byteLength;
            enqueue(value);
          }

          const finalCrc = (crc ^ 0xffffffff) >>> 0;
          enqueue(dataDescriptor(finalCrc, size));
          entries.push({ nameBytes, crc: finalCrc, size, offset: localOffset, time, date });
        }

        const centralOffset = offset;
        for (const entry of entries) enqueue(centralHeader(entry));
        const centralSize = offset - centralOffset;
        enqueue(endOfCentralDirectory(entries.length, centralSize, centralOffset));
        closed = true;
        controller.close();
      } catch (err) {
        closed = true;
        controller.error(err);
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('photos.zip'),
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    }
  });
});

export default download;
