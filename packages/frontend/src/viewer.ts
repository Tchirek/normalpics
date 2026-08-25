const VIEWER_KEY = 'ph_viewer_id';
const COMMENTED_IMAGES_KEY = 'ph_commented_image_ids';
const VIEWER_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

let memoryViewerId = '';
let memoryCommentedImageIds = new Set<string>();

function clearLegacyIdentityStorage(): void {
  try {
    localStorage.removeItem(VIEWER_KEY);
    localStorage.removeItem(COMMENTED_IMAGES_KEY);
  } catch {
    // Storage may be unavailable; session memory still works.
  }
}

function fallbackId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function peekSessionViewerId(): string {
  clearLegacyIdentityStorage();
  try {
    const existing = sessionStorage.getItem(VIEWER_KEY) || '';
    if (VIEWER_ID_PATTERN.test(existing)) {
      memoryViewerId = existing;
      return existing;
    }
    if (existing) sessionStorage.removeItem(VIEWER_KEY);
  } catch {
    // Fall back to memory for this page session.
  }
  return VIEWER_ID_PATTERN.test(memoryViewerId) ? memoryViewerId : '';
}

export function requireSessionViewerId(): string {
  const existing = peekSessionViewerId();
  if (existing) return existing;
  const next = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : fallbackId();
  memoryViewerId = next;
  try {
    sessionStorage.setItem(VIEWER_KEY, next);
  } catch {
    // Memory keeps the identity for the current page when storage is blocked.
  }
  return next;
}

function readCommentedImageIds(): Set<string> {
  clearLegacyIdentityStorage();
  try {
    const parsed = JSON.parse(sessionStorage.getItem(COMMENTED_IMAGES_KEY) || '[]');
    if (Array.isArray(parsed)) {
      memoryCommentedImageIds = new Set(parsed.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)));
    }
  } catch {
    // Corrupt or blocked session state should not break the gallery.
  }
  return new Set(memoryCommentedImageIds);
}

export function hasLocalCommentedImage(imageId: string): boolean {
  return readCommentedImageIds().has(imageId);
}

export function markLocalCommentedImage(imageId: string): void {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(imageId)) return;
  const ids = readCommentedImageIds();
  ids.add(imageId);
  memoryCommentedImageIds = new Set(Array.from(ids).slice(-500));
  try {
    sessionStorage.setItem(COMMENTED_IMAGES_KEY, JSON.stringify(Array.from(memoryCommentedImageIds)));
  } catch {
    // Memory keeps the hint for the current page when storage is blocked.
  }
}
