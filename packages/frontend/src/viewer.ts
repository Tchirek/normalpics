const VIEWER_KEY = 'ph_viewer_id';
const COMMENTED_IMAGES_KEY = 'ph_commented_image_ids';

function fallbackId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getViewerId(): string {
  const existing = localStorage.getItem(VIEWER_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID ? crypto.randomUUID() : fallbackId();
  localStorage.setItem(VIEWER_KEY, next);
  return next;
}

function readCommentedImageIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMMENTED_IMAGES_KEY) || '[]');
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)));
    }
  } catch {
    // Corrupt local UI state should not break the gallery.
  }
  return new Set();
}

export function hasLocalCommentedImage(imageId: string): boolean {
  return readCommentedImageIds().has(imageId);
}

export function markLocalCommentedImage(imageId: string): void {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(imageId)) return;
  const ids = readCommentedImageIds();
  ids.add(imageId);
  localStorage.setItem(COMMENTED_IMAGES_KEY, JSON.stringify(Array.from(ids).slice(-500)));
}
