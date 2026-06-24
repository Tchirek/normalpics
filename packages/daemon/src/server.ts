import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { CONFIG } from './config.js';
import { isBrowserFriendlyImage, writeBrowserWebp } from './image-convert.js';
import { findRememberedLocalFile } from './local-index.js';
import { syncMissingLocalLibrary } from './sync.js';

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBrowserDerivative(id: string, sourcePath: string): Promise<string | null> {
  if (isBrowserFriendlyImage(sourcePath)) return sourcePath;
  const target = path.join(CONFIG.thumbnailDir, `${id}_web.webp`);
  if (await fileExists(target)) return target;

  try {
    await mkdir(CONFIG.thumbnailDir, { recursive: true });
    await writeBrowserWebp(sourcePath, target, 2560, 90);
    return target;
  } catch (err) {
    console.warn('[server] browser derivative failed:', sourcePath, err);
    return null;
  }
}

async function findFile(id: string, version: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) return null;

  if (version === 'thumb') {
    const thumb = path.join(CONFIG.thumbnailDir, `${id}_thumb.webp`);
    if (await fileExists(thumb)) return thumb;
  }

  const candidates = [
    `${id}_web.webp`,
    `${id}_web.jpg`,
    `${id}_web.jpeg`,
    `${id}_web.png`
  ].map((name) => path.join(CONFIG.thumbnailDir, name));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  const derivativeSources = [
    `${id}_web.heic`,
    `${id}_web.heif`,
    `${id}_web.tif`,
    `${id}_web.tiff`,
    `${id}_web.bin`
  ].map((name) => path.join(CONFIG.thumbnailDir, name));

  for (const candidate of derivativeSources) {
    if (!(await fileExists(candidate))) continue;
    const derivative = await ensureBrowserDerivative(id, candidate);
    if (derivative) return derivative;
  }

  const remembered = findRememberedLocalFile(CONFIG.photoDir, id);
  if (remembered) return ensureBrowserDerivative(id, remembered);

  const original = (await readdir(CONFIG.photoDir, { withFileTypes: true }).catch(() => []))
    .find((entry) => entry.isFile() && entry.name.startsWith(`${id}_`));
  return original ? ensureBrowserDerivative(id, path.join(CONFIG.photoDir, original.name)) : null;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header?.startsWith('bytes=')) return null;
  const [rawStart, rawEnd] = header.slice(6).split('-');
  const start = rawStart ? Number(rawStart) : 0;
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) return null;
  return { start, end };
}

async function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  const range = parseRange(req.headers.range, fileStat.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? fileStat.size - 1;
  const status = range ? 206 : 200;

  res.writeHead(status, {
    'Content-Type': mimeFor(filePath),
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fileStat.size}` } : {})
  });

  const stream = createReadStream(filePath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

export function startLocalServer(): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      console.warn('[server] request failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  server.listen(CONFIG.localPort, () => {
    console.log(`[server] listening on http://127.0.0.1:${CONFIG.localPort}`);
  });

  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/sync-now' && req.method === 'POST') {
      const result = await syncMissingLocalLibrary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    const match = url.pathname.match(/^\/img\/([^/]+)$/);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const version = url.searchParams.get('v') === 'thumb' ? 'thumb' : 'web';
    const filePath = await findFile(decodeURIComponent(match[1]), version);
    if (!filePath) {
      res.writeHead(404);
      res.end();
      return;
    }

    await serveFile(req, res, filePath);
}
