import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import pLimit from 'p-limit';
import { CONFIG } from './config.js';
import { generateMetadata } from './llm.js';
import { findRememberedLocalFile, rememberLocalFile } from './local-index.js';
import { processImage } from './process.js';
import { generateBlurData } from './image-convert.js';

export interface PendingItem {
  id: string;
  imageId?: string;
  r2KeyOrig?: string | null;
  filename?: string | null;
  uploadedAt?: number | null;
  uploadedDay?: string | null;
  uploadedDaySeq?: number | null;
}

export interface SyncRunResult {
  total: number;
  synced: number;
  failed: number;
}

const active = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

function daemonHeaders(): Record<string, string> {
  return {
    'X-Daemon-Secret': CONFIG.daemonSecret,
    'X-Device-Id': CONFIG.deviceId
  };
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'photo';
}

function uploadDayFor(item: PendingItem): string {
  if (item.uploadedDay && /^\d{4}-\d{2}-\d{2}$/.test(item.uploadedDay)) return item.uploadedDay;
  const timestamp = Number(item.uploadedAt || Date.now());
  return new Date(timestamp).toISOString().slice(0, 10);
}

function uploadSequenceFor(item: PendingItem): number {
  const seq = Number(item.uploadedDaySeq);
  return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1;
}

async function targetPathFor(item: PendingItem, id: string): Promise<string> {
  const dayDir = path.join(CONFIG.photoDir, uploadDayFor(item));
  await mkdir(dayDir, { recursive: true });

  const safe = sanitizeFilename(item.filename || `${id}.bin`);
  const ext = path.extname(safe) || '.bin';
  const base = path.basename(safe, ext) || 'photo';
  const seq = uploadSequenceFor(item);
  const preferred = path.join(dayDir, `${base}-${seq}${ext}`);
  if (!(await fileExists(preferred))) return preferred;

  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
  const byId = path.join(dayDir, `${base}-${seq}-${safeId}${ext}`);
  if (!(await fileExists(byId))) return byId;

  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = path.join(dayDir, `${base}-${seq}-${safeId}-${attempt}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }

  return path.join(dayDir, `${base}-${seq}-${safeId}-${Date.now().toString(36)}${ext}`);
}

async function writeResponseAndHash(response: Response, filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  if (!response.body) throw new Error('empty_download_body');
  const hash = createHash('sha256');
  const writer = createWriteStream(filePath);
  const reader = response.body.getReader();
  let sizeBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      sizeBytes += value.byteLength;
      hash.update(value);
      if (!writer.write(value)) await once(writer, 'drain');
    }
  } finally {
    writer.end();
  }

  await once(writer, 'finish');
  return { sha256: hash.digest('hex'), sizeBytes };
}

export async function downloadAndProcess(item: PendingItem): Promise<boolean> {
  const id = item.id || item.imageId;
  if (!id || active.has(id)) return false;
  active.add(id);
  let partialPath: string | null = null;

  try {
    await mkdir(CONFIG.photoDir, { recursive: true });
    const targetPath = await targetPathFor(item, id);
    partialPath = `${targetPath}.part`;

    const download = await fetch(`${CONFIG.workerUrl}/api/sync/download/${encodeURIComponent(id)}`, {
      headers: daemonHeaders(),
      redirect: 'follow'
    });
    if (!download.ok) throw new Error(`download_${download.status}`);

    const { sha256, sizeBytes } = await writeResponseAndHash(download, partialPath);
    await rename(partialPath, targetPath);
    await rememberLocalFile(CONFIG.photoDir, id, targetPath);
    const processed = await processImage(targetPath, id);
    const metadata = await generateMetadata(processed.descriptionSourcePath || targetPath);

    const confirm = await fetch(`${CONFIG.workerUrl}/api/sync/confirm`, {
      method: 'POST',
      headers: {
        ...daemonHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        imageId: id,
        sha256,
        width: processed.width,
        height: processed.height,
        sizeBytes: processed.sizeBytes || sizeBytes,
        description: metadata?.description || null,
        tags: metadata?.tags || [],
        llmModel: metadata ? CONFIG.llm.model : null,
        r2KeyWeb: processed.r2KeyWeb,
        r2KeyThumb: processed.r2KeyThumb,
        blurDataUrl: processed.blurDataUrl
      })
    });

    if (!confirm.ok) throw new Error(`confirm_${confirm.status}`);
    console.log(`[sync] synced ${id} -> ${targetPath}`);
    return true;
  } catch (err) {
    console.warn(`[sync] failed ${id}:`, err);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    return false;
  } finally {
    active.delete(id);
  }
}

function parsePendingItems(body: unknown, context: string): PendingItem[] {
  if (!isRecord(body)) throw new Error(`${context}_invalid_json`);
  const rawItems = body.items;
  if (rawItems === undefined) return [];
  if (!Array.isArray(rawItems)) throw new Error(`${context}_invalid_items`);

  return rawItems.filter((item): item is PendingItem => {
    if (!isRecord(item)) return false;
    const id = item.id ?? item.imageId;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
  }).map((item) => ({
    id: typeof item.id === 'string' ? item.id : String(item.imageId),
    imageId: typeof item.imageId === 'string' ? item.imageId : undefined,
    r2KeyOrig: typeof item.r2KeyOrig === 'string' ? item.r2KeyOrig : null,
    filename: typeof item.filename === 'string' ? item.filename : null,
    uploadedAt: typeof item.uploadedAt === 'number' ? item.uploadedAt : null,
    uploadedDay: typeof item.uploadedDay === 'string' ? item.uploadedDay : null,
    uploadedDaySeq: typeof item.uploadedDaySeq === 'number' ? item.uploadedDaySeq : null
  }));
}

async function readPendingItems(response: Response, context: string): Promise<PendingItem[]> {
  return parsePendingItems(await response.json(), context);
}

async function backfillBlurItem(item: PendingItem): Promise<boolean> {
  const id = item.id || item.imageId;
  if (!id) return false;

  let sourcePath = findRememberedLocalFile(CONFIG.photoDir, id);
  let temporaryPath: string | null = null;
  try {
    if (!sourcePath) {
      await mkdir(CONFIG.thumbnailDir, { recursive: true });
      temporaryPath = path.join(CONFIG.thumbnailDir, `.blur-${id}.part`);
      const download = await fetch(`${CONFIG.workerUrl}/api/sync/download/${encodeURIComponent(id)}`, {
        headers: daemonHeaders(),
        redirect: 'follow'
      });
      if (!download.ok) throw new Error(`blur_download_${download.status}`);
      await writeResponseAndHash(download, temporaryPath);
      sourcePath = temporaryPath;
    }

    const blur = await generateBlurData(sourcePath);
    if (!blur.width || !blur.height) throw new Error('blur_dimensions_missing');
    const confirm = await fetch(`${CONFIG.workerUrl}/api/sync/blur/confirm`, {
      method: 'POST',
      headers: {
        ...daemonHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        imageId: id,
        width: blur.width,
        height: blur.height,
        blurDataUrl: blur.blurDataUrl
      })
    });
    if (!confirm.ok) throw new Error(`blur_confirm_${confirm.status}`);
    console.log(`[blur] backfilled ${id}`);
    return true;
  } catch (err) {
    console.warn(`[blur] failed ${id}:`, err);
    return false;
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function backfillBlurData(): Promise<SyncRunResult> {
  let total = 0;
  let synced = 0;
  let failed = 0;

  for (let batch = 0; batch < 100; batch += 1) {
    const response = await fetch(`${CONFIG.workerUrl}/api/sync/blur/claim`, {
      method: 'POST',
      headers: {
        ...daemonHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ limit: 8, deviceName: CONFIG.deviceName })
    });
    if (!response.ok) throw new Error(`blur_claim_${response.status}`);
    const items = await readPendingItems(response, 'blur_claim');
    if (items.length === 0) break;

    const limit = pLimit(Math.max(1, Math.min(2, CONFIG.sync.processConcurrency)));
    const results = await Promise.all(items.map((item) => limit(() => backfillBlurItem(item))));
    total += items.length;
    synced += results.filter(Boolean).length;
    failed += results.filter((result) => !result).length;
    if (results.every((result) => !result)) break;
  }

  return { total, synced, failed };
}

export async function catchUp(): Promise<SyncRunResult> {
  const response = await fetch(`${CONFIG.workerUrl}/api/sync/pending`, {
    headers: daemonHeaders()
  });
  if (!response.ok) throw new Error(`pending_${response.status}`);
  const items = await readPendingItems(response, 'pending');
  const limit = pLimit(CONFIG.sync.concurrency);
  const results = await Promise.all(items.map((item) => limit(() => downloadAndProcess(item))));
  const synced = results.filter(Boolean).length;
  return {
    total: items.length,
    synced,
    failed: items.length - synced
  };
}

async function fetchLibraryPage(cursor?: string | null): Promise<{ items: PendingItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: '250' });
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`${CONFIG.workerUrl}/api/sync/library?${params.toString()}`, {
    headers: daemonHeaders()
  });
  if (!response.ok) throw new Error(`library_${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('library_invalid_json');
  const items = parsePendingItems({ items: body.items }, 'library');
  const rawCursor = body.nextCursor;
  return {
    items,
    nextCursor: typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null
  };
}

export async function syncMissingLocalLibrary(): Promise<SyncRunResult> {
  const missing: PendingItem[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchLibraryPage(cursor);
    for (const item of page.items) {
      const id = item.id || item.imageId;
      if (!id) continue;
      if (!findRememberedLocalFile(CONFIG.photoDir, id)) missing.push(item);
    }
    cursor = page.nextCursor;
  } while (cursor);

  const limit = pLimit(CONFIG.sync.concurrency);
  const results = await Promise.all(missing.map((item) => limit(() => downloadAndProcess(item))));
  const synced = results.filter(Boolean).length;
  return {
    total: missing.length,
    synced,
    failed: missing.length - synced
  };
}
