import { apiFetch, assetUrl } from './api';
import { icon } from './icons';
import type { ImageItem, ImageListResponse, UploadPreview } from './types';
import { hasLocalCommentedImage, markLocalCommentedImage, peekSessionViewerId } from './viewer';

export interface GalleryController {
  loadInitial: () => Promise<void>;
  setSearch: (query: string) => void;
  prependPending: (imageId: string, filename?: string, preview?: UploadPreview | null) => void;
  removeItems: (imageIds: string[]) => void;
  getItems: () => ImageItem[];
  getTotal: () => number;
  getSearch: () => string;
  isComplete: () => boolean;
}

const PAGE_SIZE = 50;
const FAST_REFRESH_DELAYS = [900, 1400, 2200, 3500, 5500, 8000, 10_000];
const BROWSER_SAFE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

export async function fetchImagePage(params: URLSearchParams): Promise<ImageListResponse> {
  const viewerId = peekSessionViewerId();
  return apiFetch<ImageListResponse>(`/api/images?${params.toString()}`, viewerId ? {
    headers: { 'X-Viewer-Id': viewerId }
  } : {});
}

export function initGallery(): GalleryController {
  const gallery = document.getElementById('gallery')!;
  const masonry = document.createElement('div');
  const pageSentinel = document.createElement('div');
  let items: ImageItem[] = [];
  let cursor: number | null = null;
  let loading = false;
  let done = false;
  let searchQuery = '';
  let totalCount = 0;
  let reloadQueued = false;
  let columnCount = 0;
  let columns: HTMLElement[] = [];
  let columnHeights: number[] = [];
  let resizeTimer = 0;
  const pendingTimers = new Map<string, number>();
  const checkContrastCache = new Map<string, Promise<boolean>>();

  masonry.className = 'gallery-masonry';
  pageSentinel.className = 'gallery-sentinel';
  pageSentinel.setAttribute('aria-hidden', 'true');
  gallery.append(masonry, pageSentinel);

  const lazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      const src = img.dataset.src;
      const srcset = img.dataset.srcset;
      if (srcset) {
        img.srcset = srcset;
        img.removeAttribute('data-srcset');
      }
      if (src) {
        img.src = src;
        img.removeAttribute('data-src');
      }
      lazyObserver.unobserve(img);
    }
  }, { rootMargin: '600px 0px' });

  function revealImage(img: HTMLImageElement): void {
    const reveal = () => {
      if (!img.isConnected) return;
      img.classList.add('is-loaded');
    };
    if (typeof img.decode === 'function') {
      void img.decode().then(reveal, reveal);
    } else {
      reveal();
    }
  }

  const pageObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadPage();
  }, { rootMargin: '900px 0px' });

  function emitUpdated(): void {
    window.dispatchEvent(new CustomEvent('photohost:gallery-updated'));
  }

  function clearPendingTimer(id: string): void {
    const timer = pendingTimers.get(id);
    if (timer) window.clearTimeout(timer);
    pendingTimers.delete(id);
  }

  function mediaUrl(path: string, item: ImageItem, nonce = ''): string {
    const url = new URL(assetUrl(path), window.location.href);
    const key = `${item.uploadedAt}-${item.width || 0}-${item.height || 0}${nonce ? `-${nonce}` : ''}`;
    url.searchParams.set('phv', key);
    return url.toString();
  }

  function canRenderItem(item: ImageItem): boolean {
    return Boolean(item.width && item.height && item.metadata?.displayReady !== false);
  }

  function desiredColumnCount(): number {
    const width = Math.max(1, gallery.clientWidth);
    const mobile = window.matchMedia('(max-width: 600px)').matches;
    const maxColumns = mobile ? 2 : 4;
    const minColumnWidth = mobile ? 160 : 200;
    return Math.max(1, Math.min(maxColumns, Math.floor(width / minColumnWidth) || 1));
  }

  function createColumns(count: number): void {
    masonry.replaceChildren();
    columns = [];
    columnHeights = [];
    columnCount = count;
    for (let index = 0; index < count; index += 1) {
      const column = document.createElement('div');
      column.className = 'gallery-column';
      column.dataset.column = String(index);
      columns.push(column);
      columnHeights.push(0);
      masonry.appendChild(column);
    }
  }

  function estimateItemHeight(item: ImageItem): number {
    if (!item.width || !item.height || columns.length === 0) return 0;
    const columnWidth = columns[0].clientWidth || ((gallery.clientWidth - (columnCount - 1) * 3) / Math.max(1, columnCount));
    const gap = Number.parseFloat(getComputedStyle(gallery).getPropertyValue('--gap')) || 0;
    return (columnWidth * item.height) / item.width + gap;
  }

  function shortestColumnIndex(): number {
    let shortest = 0;
    for (let index = 1; index < columnHeights.length; index += 1) {
      if (columnHeights[index] < columnHeights[shortest]) shortest = index;
    }
    return shortest;
  }

  function syncColumnHeights(): void {
    columnHeights = columns.map((column) => column.scrollHeight);
  }

  function ensureLayout(): void {
    const count = desiredColumnCount();
    if (columns.length > 0 && count === columnCount) return;
    createColumns(count);
    for (const item of items) {
      if (canRenderItem(item)) appendRenderedItem(item);
    }
    syncColumnHeights();
  }

  function resetLayout(): void {
    lazyObserver.disconnect();
    pageObserver.disconnect();
    gallery.querySelector('.empty-state')?.remove();
    createColumns(desiredColumnCount());
    observeLast();
  }

  function appendRenderedItem(item: ImageItem): HTMLElement | null {
    if (!canRenderItem(item)) return null;
    if (columns.length === 0) ensureLayout();
    const article = renderItem(item);
    const columnIndex = shortestColumnIndex();
    columns[columnIndex]?.appendChild(article);
    columnHeights[columnIndex] += estimateItemHeight(item);
    return article;
  }

  function renderItem(item: ImageItem): HTMLElement {
    item.commentedByMe = item.commentedByMe || hasLocalCommentedImage(item.id);
    const article = document.createElement('article');
    article.className = `photo-item ${item.syncStatus === 'pending' ? 'pending' : ''}`;
    article.dataset.id = item.id;
    article.dataset.status = item.syncStatus;

    if (item.width && item.height) {
      article.style.aspectRatio = `${item.width} / ${item.height}`;
    }

    const check = document.createElement('div');
    check.className = 'photo-check';
    check.innerHTML = icon('check', 14);
    article.appendChild(check);
    scheduleCheckContrast(article, item);

    const displayReady = item.metadata?.displayReady !== false;
    if ((item.syncStatus === 'pending' || item.syncStatus === 'synced') && displayReady) {
      if (item.blurDataUrl) {
        const placeholder = document.createElement('img');
        placeholder.className = 'photo-placeholder';
        placeholder.alt = '';
        placeholder.src = item.blurDataUrl;
        placeholder.setAttribute('aria-hidden', 'true');
        article.appendChild(placeholder);
      }

      const img = document.createElement('img');
      img.className = 'photo-image';
      img.alt = item.filename;
      img.decoding = 'async';
      img.loading = 'lazy';
      const thumbUrl = mediaUrl(item.thumbUrl, item);
      const webUrl = mediaUrl(item.webUrl, item);
      img.dataset.src = thumbUrl;
      img.dataset.srcset = `${thumbUrl} 480w, ${webUrl} 2048w`;
      img.sizes = '(max-width: 600px) 50vw, (max-width: 1200px) 33vw, 25vw';
      let retryCount = 0;
      img.addEventListener('load', () => revealImage(img));
      img.addEventListener('error', () => {
        if (retryCount >= 3) return;
        retryCount += 1;
        window.setTimeout(() => {
          const nonce = `${retryCount}-${Date.now()}`;
          const retryThumb = mediaUrl(item.thumbUrl, item, nonce);
          const retryWeb = mediaUrl(item.webUrl, item, nonce);
          img.srcset = `${retryThumb} 480w, ${retryWeb} 2048w`;
          img.src = retryThumb;
        }, retryCount * 900);
      });
      article.appendChild(img);
      lazyObserver.observe(img);
    }

    renderEngagementBadges(article, item);

    return article;
  }

  function decodeImage(src: string): Promise<HTMLImageElement> {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    if (typeof img.decode === 'function') {
      return img.decode().then(() => img);
    }
    return new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image_decode_failed'));
    });
  }

  async function lightnessFromBlurRegion(dataUrl: string, box: { x: number; y: number; width: number; height: number }): Promise<boolean> {
    const cacheKey = `${dataUrl}|${box.x.toFixed(3)},${box.y.toFixed(3)},${box.width.toFixed(3)},${box.height.toFixed(3)}`;
    let promise = checkContrastCache.get(cacheKey);
    if (!promise) {
      promise = (async () => {
        const img = await decodeImage(dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx || canvas.width <= 0 || canvas.height <= 0) return false;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const x = Math.max(0, Math.floor(box.x * canvas.width));
        const y = Math.max(0, Math.floor(box.y * canvas.height));
        const width = Math.max(1, Math.min(canvas.width - x, Math.ceil(box.width * canvas.width)));
        const height = Math.max(1, Math.min(canvas.height - y, Math.ceil(box.height * canvas.height)));
        const pixels = ctx.getImageData(x, y, width, height).data;
        let luminance = 0;
        let samples = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3] / 255;
          const red = pixels[index] * alpha + 255 * (1 - alpha);
          const green = pixels[index + 1] * alpha + 255 * (1 - alpha);
          const blue = pixels[index + 2] * alpha + 255 * (1 - alpha);
          luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          samples += 1;
        }
        return samples > 0 && luminance / samples >= 214;
      })();
      checkContrastCache.set(cacheKey, promise);
      if (checkContrastCache.size > 500) checkContrastCache.delete(checkContrastCache.keys().next().value as string);
    }
    return promise;
  }

  function scheduleCheckContrast(article: HTMLElement, item: ImageItem): void {
    if (!item.blurDataUrl) return;
    window.requestAnimationFrame(() => {
      const check = article.querySelector<HTMLElement>('.photo-check');
      if (!article.isConnected || !check) return;
      const articleRect = article.getBoundingClientRect();
      const checkRect = check.getBoundingClientRect();
      if (articleRect.width <= 0 || articleRect.height <= 0 || checkRect.width <= 0 || checkRect.height <= 0) return;
      const padding = Math.max(checkRect.width, checkRect.height) * 0.3;
      const left = Math.max(articleRect.left, checkRect.left - padding);
      const top = Math.max(articleRect.top, checkRect.top - padding);
      const right = Math.min(articleRect.right, checkRect.right + padding);
      const bottom = Math.min(articleRect.bottom, checkRect.bottom + padding);
      const box = {
        x: (left - articleRect.left) / articleRect.width,
        y: (top - articleRect.top) / articleRect.height,
        width: (right - left) / articleRect.width,
        height: (bottom - top) / articleRect.height
      };
      void lightnessFromBlurRegion(item.blurDataUrl, box).then((isLight) => {
        if (article.isConnected) article.classList.toggle('photo-check-on-light', isLight);
      }).catch(() => undefined);
    });
  }

  function formatCompactCount(count: number): string {
    if (count > 999) return '1K+';
    return String(count);
  }

  function renderEngagementBadges(article: HTMLElement, item: ImageItem): void {
    const likeCount = Math.max(0, item.likeCount || 0);
    const commentCount = Math.max(0, item.commentCount || 0);
    let badges = article.querySelector<HTMLElement>('.photo-engagement-counts');
    if (likeCount <= 0 && commentCount <= 0) {
      badges?.remove();
      return;
    }
    if (!badges) {
      badges = document.createElement('div');
      badges.className = 'photo-engagement-counts';
      article.appendChild(badges);
    }
    badges.replaceChildren();
    if (likeCount > 0) {
      badges.appendChild(renderCountBadge('like', likeCount, item.likedByMe));
    }
    if (commentCount > 0) {
      badges.appendChild(renderCountBadge('comment', commentCount, item.commentedByMe));
    }
  }

  function renderCountBadge(kind: 'like' | 'comment', count: number, active: boolean): HTMLElement {
    const badge = document.createElement('div');
    badge.className = [
      'photo-count-badge',
      kind === 'like' ? 'photo-like-count' : 'photo-comment-count',
      active ? 'is-viewer-active' : ''
    ].filter(Boolean).join(' ');
    badge.dataset.kind = kind;
    badge.dataset.viewerActive = active ? 'true' : 'false';
    badge.innerHTML = `${icon(kind === 'like' ? 'heart' : 'message', 12)}<span>${formatCompactCount(count)}</span>`;
    return badge;
  }

  function syncLikeBadge(id: string, count: number): void {
    const item = items.find((candidate) => candidate.id === id);
    if (item) item.likeCount = Math.max(0, count);

    const article = gallery.querySelector<HTMLElement>(`.photo-item[data-id="${CSS.escape(id)}"]`);
    if (article && item) renderEngagementBadges(article, item);
  }

  function syncCommentBadge(id: string, count: number, commentedByMe?: boolean): void {
    const item = items.find((candidate) => candidate.id === id);
    if (item) {
      item.commentCount = Math.max(0, count);
      if (commentedByMe) markLocalCommentedImage(id);
      item.commentedByMe = Boolean(commentedByMe || item.commentedByMe || hasLocalCommentedImage(id));
    }
    const article = gallery.querySelector<HTMLElement>(`.photo-item[data-id="${CSS.escape(id)}"]`);
    if (article && item) renderEngagementBadges(article, item);
  }

  function observeLast(): void {
    pageObserver.disconnect();
    if (!done) pageObserver.observe(pageSentinel);
  }

  function appendItems(next: ImageItem[]): void {
    ensureLayout();
    for (const item of next) {
      appendRenderedItem(item);
    }
    for (const item of next) {
      if (item.syncStatus === 'pending') schedulePendingRefresh(item.id);
    }
    syncColumnHeights();
    observeLast();
    emitUpdated();
  }

  function renderEmpty(): void {
    if (items.length > 0 || loading) return;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    gallery.appendChild(empty);
  }

  async function loadPage(initial = false): Promise<void> {
    if (loading) {
      if (initial) reloadQueued = true;
      return;
    }
    if (!initial && done) return;
    loading = true;
    const requestSearch = searchQuery;
    if (initial) {
      for (const timer of pendingTimers.values()) window.clearTimeout(timer);
      pendingTimers.clear();
      items = [];
      totalCount = 0;
      cursor = null;
      done = false;
      resetLayout();
    }

    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) params.set('cursor', String(cursor));
    if (requestSearch) params.set('q', requestSearch);

    try {
      const response = await fetchImagePage(params);
      if (requestSearch !== searchQuery) return;
      const known = new Set(items.map((item) => item.id));
      const fresh = response.items
        .filter((item) => !known.has(item.id))
        .map((item) => ({
          ...item,
          commentedByMe: Boolean(item.commentedByMe || hasLocalCommentedImage(item.id))
        }));
      items.push(...fresh);
      totalCount = Math.max(0, response.total);
      cursor = response.nextCursor;
      done = !response.nextCursor || fresh.length === 0;
      appendItems(fresh);
      renderEmpty();
    } finally {
      loading = false;
      if (reloadQueued) {
        reloadQueued = false;
        void loadPage(true);
      }
    }
  }

  async function refreshImage(id: string): Promise<boolean> {
    const current = items.findIndex((item) => item.id === id);
    if (current === -1) return true;
    const viewerId = peekSessionViewerId();
    const next = await apiFetch<ImageItem>(`/api/images/${id}`, viewerId ? {
      headers: { 'X-Viewer-Id': viewerId }
    } : {}).catch(() => null);
    if (!next || next.syncStatus === 'pending') return false;

    next.commentedByMe = Boolean(next.commentedByMe || hasLocalCommentedImage(next.id));
    items[current] = next;
    clearPendingTimer(id);
    const existing = gallery.querySelector<HTMLElement>(`.photo-item[data-id="${CSS.escape(id)}"]`);
    if (existing) {
      const replacement = renderItem(next);
      existing.replaceWith(replacement);
    } else if (canRenderItem(next)) {
      appendRenderedItem(next);
    }
    syncColumnHeights();
    observeLast();
    emitUpdated();
    return true;
  }

  function schedulePendingRefresh(id: string, attempt = 0): void {
    if (pendingTimers.has(id)) return;
    const delay = FAST_REFRESH_DELAYS[Math.min(attempt, FAST_REFRESH_DELAYS.length - 1)];
    const timer = window.setTimeout(() => {
      pendingTimers.delete(id);
      void refreshImage(id).then((ready) => {
        const item = items.find((candidate) => candidate.id === id);
        if (!ready && item?.syncStatus === 'pending') schedulePendingRefresh(id, attempt + 1);
      });
    }, delay);
    pendingTimers.set(id, timer);
  }

  window.setInterval(() => {
    const pending = items.filter((item) => item.syncStatus === 'pending').map((item) => item.id);
    for (const id of pending) schedulePendingRefresh(id);
  }, 10_000);

  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (desiredColumnCount() === columnCount) return;
      ensureLayout();
      observeLast();
      emitUpdated();
    }, 120);
  }, { passive: true });

  window.addEventListener('photohost:like-updated', (event) => {
    const detail = (event as CustomEvent<{ id?: string; likeCount?: number }>).detail;
    if (!detail?.id || typeof detail.likeCount !== 'number') return;
    syncLikeBadge(detail.id, detail.likeCount);
  });
  window.addEventListener('photohost:comment-count-updated', (event) => {
    const detail = (event as CustomEvent<{ id?: string; commentCount?: number; commentedByMe?: boolean }>).detail;
    if (!detail?.id || typeof detail.commentCount !== 'number') return;
    syncCommentBadge(detail.id, detail.commentCount, detail.commentedByMe);
  });

  return {
    loadInitial: () => loadPage(true),
    setSearch(query) {
      const next = query.trim();
      if (next === searchQuery) return;
      searchQuery = next;
      void loadPage(true);
    },
    prependPending(imageId, filename = imageId, preview = null) {
      if (items.some((item) => item.id === imageId)) return;
      const ext = filename.toLowerCase().split('.').pop() || '';
      const pending: ImageItem = {
        id: imageId,
        filename,
        width: preview?.width ?? null,
        height: preview?.height ?? null,
        blurDataUrl: preview?.blurDataUrl ?? null,
        thumbUrl: `/img/${imageId}?v=thumb`,
        webUrl: `/img/${imageId}`,
        description: null,
        tags: [],
        likeCount: 0,
        likedByMe: false,
        commentCount: 0,
        commentedByMe: false,
        uploadedAt: Date.now(),
        uploadedDay: null,
        uploadedDaySeq: null,
        metadata: {
          uploadedAt: Date.now(),
          displayReady: !ext || BROWSER_SAFE_EXTS.has(ext)
        },
        syncStatus: 'pending'
      };
      items.unshift(pending);
      totalCount += 1;
      const empty = gallery.querySelector('.empty-state');
      if (empty) empty.remove();
      if (canRenderItem(pending)) {
        ensureLayout();
        const firstColumn = columns[0];
        if (firstColumn) {
          firstColumn.prepend(renderItem(pending));
          syncColumnHeights();
        }
      }
      schedulePendingRefresh(imageId);
      observeLast();
      emitUpdated();
    },
    removeItems(imageIds) {
      const ids = new Set(imageIds);
      if (ids.size === 0) return;
      items = items.filter((item) => {
        if (!ids.has(item.id)) return true;
        clearPendingTimer(item.id);
        gallery.querySelector<HTMLElement>(`.photo-item[data-id="${CSS.escape(item.id)}"]`)?.remove();
        return false;
      });
      totalCount = Math.max(0, totalCount - ids.size);
      observeLast();
      renderEmpty();
      emitUpdated();
    },
    getItems: () => [...items],
    getTotal: () => totalCount,
    getSearch: () => searchQuery,
    isComplete: () => done && !loading && items.length > 0
  };
}
