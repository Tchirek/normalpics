import { Hono } from 'hono';
import type { Env, ImageRow, Variables } from '../types';
import { countImages, deleteImage, getImage, imageCommentInfo, imageLikeInfo, listImages, setImageLike, type ImageCommentInfo, type ImageLikeInfo } from '../lib/db';
import { deleteAuthMiddleware } from '../lib/jwt';
import { booleanField, readJsonRecord } from '../lib/validation';

const images = new Hono<{ Bindings: Env; Variables: Variables }>();

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 4);
    }
  } catch {
    // Older rows may contain plain text tags; split them loosely.
  }
  return value
    .split(/[\s,.;:，。；：、]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number | null {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}

function parseCursor(value: string | undefined): number | null | false {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : false;
}

function publicFilename(row: ImageRow): string {
  const day = row.uploaded_day || new Date(row.uploaded_at).toISOString().slice(0, 10);
  const seq = row.uploaded_day_seq ? `-${row.uploaded_day_seq}` : '';
  return `NormalPics-${day}${seq}.webp`;
}

function hasBrowserSafeOriginal(row: ImageRow): boolean {
  return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes((row.ext || '').toLowerCase());
}

function viewerId(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | null {
  const value = (c.req.header('X-Viewer-Id') || c.req.query('viewerId') || '').trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(value)) return null;
  return value;
}

function serializeImage(env: Env, row: ImageRow, like?: ImageLikeInfo, comment?: ImageCommentInfo) {
  const version = row.synced_at || row.uploaded_at;
  const tags = parseTags(row.tags);
  const format = (row.ext || 'image').toUpperCase();
  const displayReady = Boolean(row.r2_key_web || row.r2_key_thumb || (row.r2_key_orig && hasBrowserSafeOriginal(row)));
  return {
    id: row.id,
    filename: publicFilename(row),
    width: row.width,
    height: row.height,
    blurDataUrl: row.blur_data_url,
    thumbUrl: `/img/${row.id}?v=thumb&t=${version}`,
    webUrl: `/img/${row.id}?v=web&t=${version}`,
    description: row.description,
    tags,
    likeCount: like?.count || 0,
    likedByMe: Boolean(like?.likedByViewer),
    commentCount: comment?.count || 0,
    commentedByMe: Boolean(comment?.commentedByViewer),
    attribution: row.description ? env.LLM_ATTRIBUTION : undefined,
    uploadedAt: row.uploaded_at,
    uploadedDay: row.uploaded_day,
    uploadedDaySeq: row.uploaded_day_seq,
    metadata: {
      format,
      width: row.width,
      height: row.height,
      sizeBytes: row.size_bytes,
      uploadedAt: row.uploaded_at,
      uploadedDay: row.uploaded_day,
      uploadedDaySeq: row.uploaded_day_seq,
      displayReady
    },
    syncStatus: row.sync_status
  };
}

images.get('/', async (c) => {
  const limit = parsePositiveInt(c.req.query('limit'), 50, 100);
  const cursor = parseCursor(c.req.query('cursor'));
  if (limit === null || cursor === false) return c.json({ error: 'invalid_query' }, 400);

  const search = c.req.query('q')?.trim() || null;
  const rows = await listImages(c.env, limit, cursor, search);
  const imageIds = rows.map((row) => row.id);
  const viewer = viewerId(c);
  const [likes, comments, total] = await Promise.all([
    imageLikeInfo(c.env, imageIds, viewer),
    imageCommentInfo(c.env, imageIds, viewer),
    countImages(c.env, search)
  ]);
  const nextCursor = rows.length === limit ? rows[rows.length - 1]?.uploaded_at : null;

  return c.json({
    items: rows.map((row) => serializeImage(c.env, row, likes.get(row.id), comments.get(row.id))),
    nextCursor,
    total
  });
});

images.post('/:id/like', async (c) => {
  const id = c.req.param('id');
  const viewer = viewerId(c);
  if (!viewer) return c.json({ error: 'viewer_required' }, 400);

  const body = await readJsonRecord(c.req).catch(() => ({}));
  const current = await imageLikeInfo(c.env, [id], viewer);
  const liked = booleanField(body, 'liked');
  const nextLiked = typeof liked === 'boolean'
    ? liked
    : !current.get(id)?.likedByViewer;
  const next = await setImageLike(c.env, id, viewer, nextLiked);
  if (!next) return c.json({ error: 'not_found' }, 404);
  return c.json({ id, likeCount: next.count, likedByMe: next.likedByViewer });
});

images.get('/:id', async (c) => {
  const row = await getImage(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  const viewer = viewerId(c);
  const [likes, comments] = await Promise.all([
    imageLikeInfo(c.env, [row.id], viewer),
    imageCommentInfo(c.env, [row.id], viewer)
  ]);
  return c.json(serializeImage(c.env, row, likes.get(row.id), comments.get(row.id)));
});

images.delete('/:id', deleteAuthMiddleware, async (c) => {
  const deleted = await deleteImage(c.env, c.req.param('id'));
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, id: deleted.id });
});

export default images;
