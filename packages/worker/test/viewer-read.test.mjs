import assert from 'node:assert/strict';
import test from 'node:test';

const image = {
  id: 'image-123456',
  filename: 'source.jpg',
  ext: 'jpg',
  mime_type: 'image/jpeg',
  width: 100,
  height: 80,
  size_bytes: 1234,
  blur_data_url: null,
  r2_key_orig: 'orig/image-123456.jpg',
  r2_key_web: 'web/image-123456.webp',
  r2_key_thumb: 'thumb/image-123456.webp',
  description: null,
  tags: '[]',
  uploaded_at: 1_700_000_000_000,
  uploaded_day: '2023-11-14',
  uploaded_day_seq: 1,
  synced_at: 1_700_000_000_100,
  sync_status: 'synced',
};

class Statement {
  constructor(sql) {
    this.sql = sql;
  }

  bind() {
    return this;
  }

  async all() {
    if (/SELECT \* FROM images WHERE/.test(this.sql)) return { results: [image] };
    return { results: [] };
  }

  async first() {
    if (/SELECT \* FROM images WHERE id = \?/.test(this.sql)) return image;
    if (/SELECT COUNT\(\*\) AS total FROM images/.test(this.sql)) return { total: 1 };
    return null;
  }
}

const env = {
  DB: { prepare: (sql) => new Statement(sql) },
  JWT_SECRET: 'test-secret',
  FRONTEND_ORIGIN: 'https://pics.example.test',
  FRONTEND_ORIGINS: '',
  LLM_ATTRIBUTION: '',
};

test('image and comment reads work without a viewer header', async () => {
  const { default: images } = await import('../src/routes/images.ts');
  const { default: comments } = await import('../src/routes/comments.ts');

  const listResponse = await images.request('https://worker.example.test/?limit=1', {}, env);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].likedByMe, false);
  assert.equal(list.items[0].commentedByMe, false);

  const detailResponse = await images.request('https://worker.example.test/image-123456', {}, env);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.likedByMe, false);
  assert.equal(detail.commentedByMe, false);

  const commentsResponse = await comments.request(
    'https://worker.example.test/?imageId=image-123456',
    {},
    env,
  );
  assert.equal(commentsResponse.status, 200);
  assert.deepEqual(await commentsResponse.json(), { items: [], data: [], commentedByMe: false });

  assert.equal((await images.request(
    'https://worker.example.test/image-123456/like',
    { method: 'POST', body: JSON.stringify({ liked: true }) },
    env,
  )).status, 400);
  assert.equal((await comments.request(
    'https://worker.example.test/comment-123456',
    { method: 'PUT', body: JSON.stringify({ liked: true }) },
    env,
  )).status, 400);
});
