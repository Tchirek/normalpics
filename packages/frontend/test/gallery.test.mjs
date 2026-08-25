import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test('search reads preserve the current session liked state', async () => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
  const { requireSessionViewerId } = await import('../src/viewer.ts?gallery-search');
  const viewerId = requireSessionViewerId();
  let request;
  globalThis.fetch = async (input, init = {}) => {
    request = { input, init };
    return Response.json({
      items: [{ id: 'image-123456', likedByMe: true }],
      nextCursor: null,
      total: 1,
    });
  };

  const { fetchImagePage } = await import('../src/gallery.ts?gallery-search');
  const result = await fetchImagePage(new URLSearchParams({ q: 'liked image' }));
  const headers = new Headers(request.init.headers);

  assert.match(String(request.input), /\/api\/images\?q=liked\+image$/);
  assert.equal(headers.get('X-Viewer-Id'), viewerId);
  assert.equal(result.items[0].likedByMe, true);
});
