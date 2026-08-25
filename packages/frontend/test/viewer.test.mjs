import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.setCalls = [];
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.setCalls.push([key, String(value)]);
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test('anonymous viewer and commented-image state are session scoped', async () => {
  const local = new MemoryStorage({
    ph_viewer_id: 'legacy-viewer-123456',
    ph_commented_image_ids: '["legacy-image"]',
  });
  const session = new MemoryStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;

  const first = await import('../src/viewer.ts?session-scope=first');
  assert.equal(first.peekSessionViewerId(), '');
  assert.equal(local.getItem('ph_viewer_id'), null);
  assert.equal(local.getItem('ph_commented_image_ids'), null);
  assert.equal(session.getItem('ph_viewer_id'), null);

  const viewerId = first.requireSessionViewerId();
  assert.match(viewerId, /^[A-Za-z0-9_-]{16,80}$/);
  assert.equal(session.getItem('ph_viewer_id'), viewerId);
  first.markLocalCommentedImage('image-123456');
  assert.equal(first.hasLocalCommentedImage('image-123456'), true);
  assert.deepEqual(local.setCalls, []);

  const reloaded = await import('../src/viewer.ts?session-scope=reloaded');
  assert.equal(reloaded.peekSessionViewerId(), viewerId);
  assert.equal(reloaded.hasLocalCommentedImage('image-123456'), true);

  const nextSession = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = nextSession;
  const reopened = await import('../src/viewer.ts?session-scope=reopened');
  assert.equal(reopened.peekSessionViewerId(), '');
  const nextViewerId = reopened.requireSessionViewerId();
  assert.match(nextViewerId, /^[A-Za-z0-9_-]{16,80}$/);
  assert.notEqual(nextViewerId, viewerId);
  assert.equal(nextSession.getItem('ph_viewer_id'), nextViewerId);
});
