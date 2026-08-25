import { apiFetch, assetUrl } from './api';
import { iconButton } from './icons';
import { getDeleteToken, isDeleteAuthenticated, promptPin } from './auth';
import { hasLocalCommentedImage, markLocalCommentedImage, peekSessionViewerId, requireSessionViewerId } from './viewer';
import type { ImageItem } from './types';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.18;
const DETAILS_KEY = 'ph_lightbox_details_visible';
const MOBILE_QUERY = '(max-width: 700px), (pointer: coarse)';
const COMMENT_ORIGIN = (import.meta.env.VITE_COMMENT_ORIGIN || 'https://comments.pics.example.com').replace(/\/$/, '');
const SCRIM_OPACITY = 0.96;
const HERO_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const HERO_EXIT_DURATION = 360;

type LikeResponse = {
  id: string;
  likeCount: number;
  likedByMe: boolean;
};

type PointerRecord = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastT: number;
  velocityX: number;
  velocityY: number;
  pointerType: string;
};

type VerticalVisual = {
  x: number;
  y: number;
  scale: number;
  scrimOpacity: number;
};

export function initLightbox(getItems: () => ImageItem[]): { open: (id: string, origin?: HTMLElement | null) => void } {
  const root = document.getElementById('lightbox')!;
  const gallery = document.getElementById('gallery')!;
  let index = -1;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let trackX = 0;
  let activeMode: 'idle' | 'pan' | 'pinch' | 'swipe' | 'vertical' = 'idle';
  let swipeAxisLock: 'none' | 'horizontal' | 'vertical' = 'none';
  let dragOriginX = 0;
  let dragOriginY = 0;
  let pinchDistance = 0;
  let isSwitching = false;
  let switchTimer = 0;
  let switchDelta = 0;
  let switchSequence = 0;
  let slideRenderSequence = 0;
  let lastWheelMoveAt = 0;
  let wheelZoomGestureActive = false;
  let wheelZoomGestureTimer = 0;
  let suppressClickUntil = 0;
  let verticalDragX = 0;
  let verticalDragY = 0;
  let verticalDragScale = 1;
  let verticalAnimation: Animation | null = null;
  let scrimAnimation: Animation | null = null;
  let heroAnimationSequence = 0;
  let heroAnimating = false;
  let heroOriginId = '';
  let heroOriginElement: HTMLElement | null = null;
  let heroOriginRect: DOMRect | null = null;
  let heroClone: HTMLImageElement | null = null;
  let heroOpeningImageId = '';
  let heroFallbackImageId = '';
  const hiddenHeroSources = new Map<HTMLElement, string>();
  let exitClickGuard: ((event: MouseEvent) => void) | null = null;
  let exitClickGuardTimer = 0;
  let lastPointerEndX = 0;
  let lastPointerEndY = 0;
  let exifSheetVisible = false;
  let detailsVisible = localStorage.getItem(DETAILS_KEY) === '1';
  let lastImageTapAt = 0;
  let lastImageTapId = '';
  let likeBusy = false;
  let infoCloseTimer = 0;
  let slideUpgradeTimer = 0;
  const pointers = new Map<number, PointerRecord>();
  const deferredSlideUpgrades = new Map<HTMLImageElement, () => void>();

  const scrim = document.createElement('div');
  scrim.className = 'lightbox-scrim';
  const stage = document.createElement('div');
  stage.className = 'lightbox-stage';
  const stageMotion = document.createElement('div');
  stageMotion.className = 'lightbox-stage-motion';
  const track = document.createElement('div');
  track.className = 'lightbox-track';
  const slideImages = ['prev', 'current', 'next'].map((name) => {
    const slide = document.createElement('div');
    slide.className = `lightbox-slide lightbox-slide-${name}`;
    const img = document.createElement('img');
    img.className = 'lightbox-image';
    img.alt = '';
    img.title = '';
    img.draggable = false;
    img.decoding = 'async';
    slide.appendChild(img);
    track.appendChild(slide);
    return img;
  });
  stageMotion.appendChild(track);
  stage.appendChild(stageMotion);

  const meta = document.createElement('div');
  meta.className = 'lightbox-meta';
  const tagRow = document.createElement('div');
  tagRow.className = 'lightbox-tag-row';
  const tags = document.createElement('div');
  tags.className = 'lightbox-tags';
  const infoButton = iconButton('info', 'Info', 'lightbox-info');
  const description = document.createElement('div');
  description.className = 'lightbox-description';
  tagRow.append(tags, infoButton);
  meta.append(tagRow, description);

  const exifPanel = document.createElement('aside');
  exifPanel.className = 'lightbox-exif is-hidden';
  exifPanel.setAttribute('aria-hidden', 'true');
  const exifList = document.createElement('dl');
  exifPanel.appendChild(exifList);

  const closeButton = iconButton('x', 'Close', 'lightbox-close');
  const prevButton = iconButton('chevron-left', 'Previous', 'lightbox-prev');
  const nextButton = iconButton('chevron-right', 'Next', 'lightbox-next');
  const likeButton = iconButton('heart', 'Like', 'lightbox-like');
  const commentButton = iconButton('message', '评论', 'lightbox-comment');
  const likeCount = document.createElement('span');
  likeCount.className = 'lightbox-like-count';
  likeButton.appendChild(likeCount);
  const commentPanel = document.createElement('aside');
  commentPanel.className = 'lightbox-comments is-loading';
  commentPanel.setAttribute('aria-hidden', 'true');
  let commentsVisible = false;
  let commentsLoaded = false;
  let commentCloseTimer = 0;
  let commentContextRetryTimer = 0;
  let commentContextRetryCount = 0;
  let commentDragPort: MessagePort | null = null;
  let commentDragAnimation: Animation | null = null;
  let commentDragY = 0;
  let commentDragLimit = 0;
  let commentDragActive = false;
  let commentDragSequence = 0;
  const decodedLightboxSources = new Set<string>();
  const preloadingLightboxSources = new Map<string, Promise<void>>();
  const commentFrame = document.createElement('iframe');
  commentFrame.title = '评论';
  commentFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  commentFrame.addEventListener('load', () => {
    if (!commentsLoaded) return;
    commentFrame.dataset.ready = 'true';
    commentPanel.classList.remove('is-loading');
    connectCommentDragChannel();
    ensureCommentContext(true);
  });
  commentPanel.appendChild(commentFrame);
  root.append(scrim, stage, exifPanel, meta, likeButton, commentButton, commentPanel, closeButton, prevButton, nextButton);

  function currentImage(): HTMLImageElement {
    return slideImages[1];
  }

  function currentSlide(): HTMLElement {
    return currentImage().parentElement!;
  }

  function setSlideSlot(img: HTMLImageElement, slot: 'prev' | 'current' | 'next'): void {
    const slide = img.parentElement;
    if (!slide) return;
    slide.className = `lightbox-slide lightbox-slide-${slot}`;
  }

  function syncSlideDomOrder(): void {
    const slides = slideImages
      .map((image) => image.parentElement)
      .filter((slide): slide is HTMLElement => Boolean(slide));
    track.replaceChildren(...slides);
    setSlideSlot(slideImages[0], 'prev');
    setSlideSlot(slideImages[1], 'current');
    setSlideSlot(slideImages[2], 'next');
  }

  function rotateSlides(delta: number): void {
    const [prev, current, next] = slideImages;
    if (delta > 0) {
      slideImages[0] = current;
      slideImages[1] = next;
      slideImages[2] = prev;
    } else {
      slideImages[0] = next;
      slideImages[1] = prev;
      slideImages[2] = current;
    }
    syncSlideDomOrder();
  }

  function viewableItems(): ImageItem[] {
    return getItems().filter((item) => {
      if (item.metadata?.displayReady === false) return false;
      return item.syncStatus === 'synced' || item.syncStatus === 'pending';
    });
  }

  function currentItem(): ImageItem | null {
    return viewableItems()[index] || null;
  }

  function isVisible(): boolean {
    return root.classList.contains('visible');
  }

  function sendCommentContext(reset = false): void {
    const item = currentItem();
    if (!commentsLoaded || !item || !commentFrame.contentWindow) return;
    if (reset) delete commentFrame.dataset.contextReady;
    const viewerId = peekSessionViewerId();
    commentFrame.contentWindow.postMessage({
      type: 'normalpics:context',
      imageId: item.id,
      ...(viewerId ? { viewerId } : {})
    }, COMMENT_ORIGIN);
  }

  function clearCommentContextRetry(): void {
    window.clearTimeout(commentContextRetryTimer);
    commentContextRetryTimer = 0;
    commentContextRetryCount = 0;
  }

  function ensureCommentContext(reset = false): void {
    clearCommentContextRetry();
    if (reset) delete commentFrame.dataset.contextReady;
    const attempt = () => {
      const item = currentItem();
      if (!item || commentFrame.dataset.contextReady === item.id || commentContextRetryCount >= 8) {
        clearCommentContextRetry();
        return;
      }
      commentContextRetryCount += 1;
      sendCommentContext();
      commentContextRetryTimer = window.setTimeout(attempt, Math.min(2_000, 300 * commentContextRetryCount));
    };
    attempt();
  }

  function preloadComments(): void {
    if (commentsLoaded) return;
    commentsLoaded = true;
    commentFrame.src = `${COMMENT_ORIGIN}/`;
  }

  function connectCommentDragChannel(): void {
    if (!commentFrame.contentWindow) return;
    commentDragPort?.close();
    const channel = new MessageChannel();
    commentDragPort = channel.port1;
    commentDragPort.onmessage = (event) => handleCommentPull(event.data as CommentPullMessage);
    commentDragPort.start();
    commentFrame.contentWindow.postMessage(
      { type: 'normalpics:drag-channel' },
      COMMENT_ORIGIN,
      [channel.port2]
    );
  }

  type CommentPullMessage = {
    type?: string;
    phase?: string;
    deltaY?: number;
    velocityY?: number;
  };

  function cancelCommentDragAnimation(): void {
    if (!commentDragAnimation) return;
    commentDragAnimation.cancel();
    commentDragAnimation = null;
  }

  function clearCommentDragVisual(): void {
    commentDragSequence += 1;
    cancelCommentDragAnimation();
    commentDragActive = false;
    commentDragY = 0;
    commentDragLimit = 0;
    commentPanel.style.transition = '';
    commentPanel.style.transform = '';
    root.classList.remove('comment-panel-dragging');
  }

  function setCommentDragTransform(deltaY: number): void {
    commentDragY = Math.max(0, Math.min(commentDragLimit || window.innerHeight, deltaY));
    commentPanel.style.transform = `translate3d(0, ${commentDragY}px, 0)`;
  }

  function settleCommentDragAtRest(sequence: number): void {
    requestAnimationFrame(() => {
      if (commentDragSequence !== sequence || commentDragActive || !commentsVisible) return;
      commentDragY = 0;
      commentDragLimit = 0;
      commentPanel.style.transition = 'none';
      commentPanel.style.transform = '';
      requestAnimationFrame(() => {
        if (commentDragSequence !== sequence || commentDragActive || !commentsVisible) return;
        commentPanel.style.transition = '';
      });
    });
  }

  function finishCommentDragClose(sequence: number): void {
    if (commentDragSequence !== sequence) return;

    commentsVisible = false;
    root.classList.remove('comments-open', 'comment-panel-dragging');
    commentButton.setAttribute('aria-pressed', 'false');
    commentPanel.setAttribute('aria-hidden', 'true');
    clearCommentContextRetry();
    window.clearTimeout(commentCloseTimer);
    commentCloseTimer = window.setTimeout(() => {
      commentCloseTimer = 0;
      if (!commentsVisible) syncPanelLayout();
    }, 200);

    window.setTimeout(() => {
      if (commentDragSequence !== sequence || commentsVisible) return;
      commentPanel.style.transition = 'none';
      commentPanel.style.transform = '';
      commentDragY = 0;
      commentDragLimit = 0;
      requestAnimationFrame(() => {
        if (commentDragSequence !== sequence || commentsVisible) return;
        commentPanel.style.transition = '';
      });
    }, 220);
  }

  function animateCommentDrag(toY: number, duration: number, onFinish?: (sequence: number) => void): void {
    cancelCommentDragAnimation();
    const sequence = ++commentDragSequence;
    const fromY = commentDragY;
    if (Math.abs(fromY - toY) < 0.1) {
      commentDragY = toY;
      commentPanel.style.transform = `translate3d(0, ${toY}px, 0)`;
      onFinish?.(sequence);
      return;
    }

    const animation = commentPanel.animate([
      { transform: `translate3d(0, ${fromY}px, 0)` },
      { transform: `translate3d(0, ${toY}px, 0)` }
    ], {
      duration,
      easing: 'cubic-bezier(.22, 1, .36, 1)',
      fill: 'forwards'
    });
    commentDragAnimation = animation;
    void animation.finished.then(() => {
      if (commentDragAnimation !== animation || commentDragSequence !== sequence) return;
      commentDragAnimation = null;
      commentDragY = toY;
      commentPanel.style.transform = `translate3d(0, ${toY}px, 0)`;
      animation.cancel();
      onFinish?.(sequence);
    }).catch(() => {
      // A new drag can intentionally interrupt the settle animation.
    });
  }

  function handleCommentPull(pull: CommentPullMessage): void {
    if (!commentsVisible || !isMobileViewport()) return;
    const deltaY = Number.isFinite(pull.deltaY) ? Math.max(0, Number(pull.deltaY)) : 0;
    const velocityY = Number.isFinite(pull.velocityY) ? Number(pull.velocityY) : 0;
    if (pull.phase === 'start') {
      commentDragSequence += 1;
      cancelCommentDragAnimation();
      commentDragActive = true;
      commentDragLimit = commentPanel.offsetHeight + 24;
      commentPanel.style.transition = 'none';
      root.classList.add('comment-panel-dragging');
      return;
    }
    if (pull.phase === 'move') {
      if (!commentDragActive) return;
      setCommentDragTransform(deltaY);
      return;
    }
    if (pull.phase !== 'end' && pull.phase !== 'cancel') return;

    commentDragActive = false;
    root.classList.remove('comment-panel-dragging');
    if (pull.phase === 'end' && (deltaY > Math.min(120, window.innerHeight * 0.18) || velocityY > 0.5)) {
      setCommentDragTransform(deltaY);
      animateCommentDrag(commentDragLimit, 180, finishCommentDragClose);
      return;
    }
    setCommentDragTransform(deltaY);
    animateCommentDrag(0, 190, settleCommentDragAtRest);
  }

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => preloadComments(), { timeout: 1_800 });
  } else {
    window.setTimeout(() => preloadComments(), 900);
  }

  function setCommentsVisible(visible: boolean): void {
    window.clearTimeout(commentCloseTimer);
    commentCloseTimer = 0;
    clearCommentDragVisual();
    commentsVisible = visible;
    if (visible) {
      if (isSwitching) interruptSwitching();
      resetTrack(false);
      detailsVisible = false;
      exifSheetVisible = false;
      root.classList.remove('mobile-exif-open');
      const item = currentItem();
      if (item) renderMeta(item);
      preloadComments();
      ensureCommentContext(true);
      commentFrame.contentWindow?.postMessage({ type: 'normalpics:panel-reset' }, COMMENT_ORIGIN);
    }
    root.classList.toggle('comments-open', visible);
    commentButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
    commentPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible) {
      clearCommentContextRetry();
      commentCloseTimer = window.setTimeout(() => {
        commentCloseTimer = 0;
        if (!commentsVisible) syncPanelLayout();
      }, 200);
    }
  }

  function mediaUrl(path: string, item: ImageItem): string {
    const url = new URL(assetUrl(path), window.location.href);
    url.searchParams.set('phv', `${item.uploadedAt}-${item.width || 0}-${item.height || 0}`);
    return url.toString();
  }

  function preloadLightboxImage(item: ImageItem | null, priority: 'high' | 'low' | 'auto' = 'auto'): Promise<void> {
    if (!item) return Promise.resolve();
    const src = mediaUrl(item.webUrl, item);
    if (decodedLightboxSources.has(src)) return Promise.resolve();
    const existing = preloadingLightboxSources.get(src);
    if (existing) return existing;

    let settled = false;
    const image = new Image();
    image.decoding = 'async';
    image.fetchPriority = priority;
    const promise = new Promise<void>((resolve) => {
      const finish = (decoded: boolean) => {
        if (settled) return;
        settled = true;
        if (decoded) decodedLightboxSources.add(src);
        preloadingLightboxSources.delete(src);
        resolve();
      };
      const decode = () => {
        if (image.naturalWidth <= 0) {
          finish(false);
          return;
        }
        if (typeof image.decode === 'function') void image.decode().then(() => finish(true), () => finish(true));
        else finish(true);
      };
      image.onload = decode;
      image.onerror = () => finish(false);
      image.src = src;
      if (image.complete) decode();
    });
    preloadingLightboxSources.set(src, promise);
    return promise;
  }

  function waitForLightboxImage(item: ImageItem | null, timeoutMs: number): Promise<void> {
    const preload = preloadLightboxImage(item);
    if (timeoutMs <= 0) return preload;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      window.setTimeout(finish, timeoutMs);
      void preload.then(finish, finish);
    });
  }

  function waitFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
      const step = () => {
        count -= 1;
        if (count <= 0) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function isLightboxImageDecoded(item: ImageItem | null): boolean {
    if (!item) return false;
    const webSource = mediaUrl(item.webUrl, item);
    if (decodedLightboxSources.has(webSource)) return true;
    const img = currentImage();
    const currentSource = img.currentSrc || img.src;
    return img.dataset.imageId === item.id
      && currentSource === webSource
      && img.complete
      && img.naturalWidth > 0
      && img.style.opacity !== '0';
  }

  function isUsableRect(rect: DOMRect | null): rect is DOMRect {
    return Boolean(rect && rect.width > 1 && rect.height > 1 && Number.isFinite(rect.left) && Number.isFinite(rect.top));
  }

  function lightboxViewportRect(): DOMRect {
    const rect = root.getBoundingClientRect();
    return new DOMRect(
      Number.isFinite(rect.left) ? rect.left : 0,
      Number.isFinite(rect.top) ? rect.top : 0,
      Math.max(1, rect.width || window.innerWidth),
      Math.max(1, rect.height || window.innerHeight)
    );
  }

  function imageIntrinsicSize(item: ImageItem): { width: number; height: number } {
    const width = item.width || item.metadata?.width || 0;
    const height = item.height || item.metadata?.height || 0;
    if (width > 0 && height > 0) return { width, height };

    const sourceRatio = heroOriginRect && heroOriginRect.height > 0
      ? heroOriginRect.width / heroOriginRect.height
      : 1;
    return { width: Math.max(sourceRatio, 0.01), height: 1 };
  }

  function fittedImageSize(item: ImageItem): { width: number; height: number } {
    const intrinsic = imageIntrinsicSize(item);
    const viewport = lightboxViewportRect();
    const fit = Math.min(viewport.width / intrinsic.width, viewport.height / intrinsic.height);
    return {
      width: Math.max(1, intrinsic.width * fit),
      height: Math.max(1, intrinsic.height * fit)
    };
  }

  function fittedImageRect(item: ImageItem): DOMRect {
    const viewport = lightboxViewportRect();
    const { width: fittedWidth, height: fittedHeight } = fittedImageSize(item);
    return new DOMRect(
      viewport.left + (viewport.width - fittedWidth) / 2,
      viewport.top + (viewport.height - fittedHeight) / 2,
      fittedWidth,
      fittedHeight
    );
  }

  function applyLightboxImageLayout(img: HTMLImageElement, item: ImageItem | null): void {
    if (!item) {
      img.style.removeProperty('width');
      img.style.removeProperty('height');
      return;
    }
    const { width, height } = fittedImageSize(item);
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
  }

  function transformRectToRect(base: DOMRect, destination: DOMRect): string {
    const baseCenterX = base.left + base.width / 2;
    const baseCenterY = base.top + base.height / 2;
    const destinationCenterX = destination.left + destination.width / 2;
    const destinationCenterY = destination.top + destination.height / 2;
    return `translate3d(${destinationCenterX - baseCenterX}px, ${destinationCenterY - baseCenterY}px, 0) scale(${destination.width / base.width}, ${destination.height / base.height})`;
  }

  function parsePixelRadius(value: string): number {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    return match ? Math.max(0, Number(match[0])) : 0;
  }

  function heroSourceShell(element: HTMLElement | null): HTMLElement | null {
    return element?.closest<HTMLElement>('.photo-item') || element;
  }

  function hideHeroSource(element: HTMLElement | null): void {
    const shell = heroSourceShell(element);
    if (!shell || hiddenHeroSources.has(shell)) return;
    hiddenHeroSources.set(shell, shell.style.visibility);
    shell.style.visibility = 'hidden';
  }

  function restoreHeroSources(): void {
    for (const [element, visibility] of hiddenHeroSources) {
      element.style.visibility = visibility;
    }
    hiddenHeroSources.clear();
  }

  function setGalleryLocked(locked: boolean): void {
    gallery.classList.toggle('lightbox-grid-locked', locked);
  }

  function clearExitClickGuard(): void {
    if (exitClickGuard) document.removeEventListener('click', exitClickGuard, true);
    exitClickGuard = null;
    window.clearTimeout(exitClickGuardTimer);
    exitClickGuardTimer = 0;
  }

  function armExitClickGuard(): void {
    clearExitClickGuard();
    const originX = lastPointerEndX;
    const originY = lastPointerEndY;
    exitClickGuard = (event) => {
      if (Math.hypot(event.clientX - originX, event.clientY - originY) > 56) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearExitClickGuard();
    };
    document.addEventListener('click', exitClickGuard, true);
    exitClickGuardTimer = window.setTimeout(clearExitClickGuard, 900);
  }

  function lockExitInteraction(): void {
    armExitClickGuard();
    root.classList.remove('gesture-active', 'dragging', 'pinching', 'swiping', 'vertical-dragging');
    activeMode = 'idle';
    swipeAxisLock = 'none';
    pointers.clear();
  }

  function removeHeroClone(): void {
    if (!heroClone) return;
    for (const animation of heroClone.getAnimations()) animation.cancel();
    heroClone.remove();
    heroClone = null;
  }

  function promoteHeroCloneToCurrentImage(item: ImageItem | null): void {
    if (!heroClone) return;
    const img = currentImage();
    if (item && img.dataset.imageId !== item.id) return;
    const src = heroClone.currentSrc || heroClone.src;
    if (src && (img.style.opacity === '0' || !img.currentSrc)) {
      img.src = src;
      img.style.opacity = '1';
    }
    img.style.visibility = '';
  }

  function settleHeroCloneForInteraction(): void {
    if (!heroClone || root.classList.contains('hero-closing')) return;
    promoteHeroCloneToCurrentImage(currentItem());
    setScrimOpacity(SCRIM_OPACITY);
    stageMotion.style.visibility = '';
    removeHeroClone();
    root.classList.remove('hero-animating', 'hero-opening', 'hero-layer-only');
    heroAnimating = false;
  }

  function heroBorderRadius(element: HTMLElement | null): string {
    const shell = heroSourceShell(element);
    return shell ? getComputedStyle(shell).borderRadius || '0px' : '0px';
  }

  function createHeroClone(source: HTMLImageElement, rect: DOMRect, borderRadius = '0px'): HTMLImageElement | null {
    const src = source.currentSrc || source.src || source.dataset.src || '';
    if (!src || !isUsableRect(rect)) return null;
    removeHeroClone();
    const clone = document.createElement('img');
    clone.className = 'lightbox-hero-image';
    clone.alt = '';
    clone.title = '';
    clone.draggable = false;
    clone.decoding = 'async';
    clone.src = src;
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.borderRadius = borderRadius;
    root.appendChild(clone);
    heroClone = clone;
    return clone;
  }

  function heroDestination(item: ImageItem): { element: HTMLElement | null; rect: DOMRect } | null {
    let element: HTMLElement | null = null;
    if (heroOriginId === item.id && heroOriginElement?.isConnected) {
      element = heroOriginElement;
    } else {
      element = document.querySelector<HTMLElement>(
        `.photo-item[data-id="${CSS.escape(item.id)}"] .photo-image`
      );
    }
    const shell = heroSourceShell(element);
    const liveRect = shell?.getBoundingClientRect() || element?.getBoundingClientRect() || null;
    if (isUsableRect(liveRect)) return { element: shell || element, rect: liveRect };
    if (heroOriginId === item.id && isUsableRect(heroOriginRect)) {
      return { element: heroOriginElement, rect: heroOriginRect };
    }
    return null;
  }

  async function animateHeroOpen(item: ImageItem, origin: HTMLImageElement, originRect: DOMRect): Promise<void> {
    const sequence = ++heroAnimationSequence;
    heroAnimating = true;
    root.classList.add('hero-animating', 'hero-opening', 'hero-layer-only');
    setScrimOpacity(0);
    const sourceRadius = heroBorderRadius(origin);
    syncSlideImageLayouts();
    const clone = createHeroClone(origin, originRect, sourceRadius);
    if (!clone || !isUsableRect(originRect)) {
      root.classList.remove('hero-animating', 'hero-opening', 'hero-layer-only');
      heroAnimating = false;
      if (heroOpeningImageId === item.id) heroOpeningImageId = '';
      setScrimOpacity(SCRIM_OPACITY);
      return;
    }

    hideHeroSource(origin);
    stageMotion.style.visibility = 'hidden';
    await waitFrames(3);
    if (sequence !== heroAnimationSequence || !isVisible() || currentItem()?.id !== item.id) return;
    syncSlideImageLayouts();
    const renderedTargetRect = currentImage().getBoundingClientRect();
    const targetRect = isUsableRect(renderedTargetRect) ? renderedTargetRect : fittedImageRect(item);
    if (!isUsableRect(targetRect)) {
      stageMotion.style.visibility = '';
      removeHeroClone();
      root.classList.remove('hero-animating', 'hero-opening', 'hero-layer-only');
      heroAnimating = false;
      if (heroOpeningImageId === item.id) heroOpeningImageId = '';
      setScrimOpacity(SCRIM_OPACITY);
      return;
    }
    const targetTransform = transformRectToRect(originRect, targetRect);
    clone.style.transform = 'translate3d(0, 0, 0) scale(1, 1)';
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (sequence !== heroAnimationSequence || !isVisible()) return;

    const imageAnimation = clone.animate([
      { transform: 'translate3d(0, 0, 0) scale(1, 1)', borderRadius: sourceRadius },
      { transform: targetTransform, borderRadius: '0px' }
    ], {
      duration: 350,
      easing: HERO_EASING,
      fill: 'forwards'
    });
    const backdropAnimation = scrim.animate([
      { opacity: 0 },
      { opacity: SCRIM_OPACITY }
    ], {
      duration: 350,
      easing: HERO_EASING,
      fill: 'forwards'
    });

    await Promise.allSettled([imageAnimation.finished, backdropAnimation.finished]);
    if (sequence !== heroAnimationSequence || !isVisible()) return;
    setScrimOpacity(SCRIM_OPACITY);
    syncSlideImageLayouts();
    promoteHeroCloneToCurrentImage(item);
    stageMotion.style.visibility = '';
    root.classList.remove('hero-layer-only');
    await waitFrames(2);
    if (sequence !== heroAnimationSequence || !isVisible() || currentItem()?.id !== item.id) return;
    removeHeroClone();
    if (imageAnimation.playState !== 'idle') imageAnimation.cancel();
    if (backdropAnimation.playState !== 'idle') backdropAnimation.cancel();

    if (sequence !== heroAnimationSequence || !isVisible() || currentItem()?.id !== item.id) return;
    syncSlideImageLayouts();
    root.classList.remove('hero-animating', 'hero-opening');
    heroAnimating = false;
    if (heroOpeningImageId === item.id) heroOpeningImageId = '';
    heroFallbackImageId = item.id;
    void preloadLightboxImage(item, 'high').then(() => {
      if (sequence !== heroAnimationSequence || currentItem()?.id !== item.id || !isVisible()) return;
      heroFallbackImageId = '';
      applyOrDeferSlideUpgrade(currentImage(), () => {
        if (sequence === heroAnimationSequence && currentItem()?.id === item.id && isVisible()) {
          setImage(currentImage(), item, 'high', 'web');
        }
      });
    });
  }

  function distance(a: PointerRecord, b: PointerRecord): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midpoint(a: PointerRecord, b: PointerRecord): { x: number; y: number } {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function moved(pointer: PointerRecord): number {
    return Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY);
  }

  function viewportWidth(): number {
    const rect = root.getBoundingClientRect();
    return Math.max(rect.width || window.innerWidth, 320);
  }

  function isMobileViewport(): boolean {
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  function setTrackTransform(x: number, animated = false): void {
    trackX = x;
    const transition = animated ? 'transform 260ms cubic-bezier(.22, 1, .36, 1)' : 'none';
    if (track.style.transition !== transition) track.style.transition = transition;
    track.style.transform = `translate3d(${-viewportWidth() + x}px, 0, 0)`;
  }

  function resetTrack(animated = true): void {
    setTrackTransform(0, animated);
  }

  function dampedDistance(value: number, limit: number, resistance: number): number {
    const distance = Math.abs(value);
    const direction = Math.sign(value) || 1;
    return direction * limit * (1 - Math.exp((-distance * resistance) / limit));
  }

  function dampenVerticalDrag(deltaY: number): number {
    if (deltaY < 0 && !detailsVisible) return dampedDistance(deltaY, 44, 0.34);
    if (deltaY < 0 && !exifSheetVisible) return dampedDistance(deltaY, 142, 0.82);
    if (deltaY > 0 && exifSheetVisible) return dampedDistance(deltaY, 112, 0.78);
    if (deltaY > 0) return dampedDistance(deltaY, window.innerHeight * 0.42, 0.9);
    return Math.max(-150, deltaY);
  }

  function applyVerticalGesture(deltaX: number, deltaY: number): void {
    cancelVerticalAnimation();
    const y = dampenVerticalDrag(deltaY);
    if (y > 0 && !exifSheetVisible) {
      const x = clamp(deltaX, -window.innerWidth * 0.34, window.innerWidth * 0.34);
      const nextScale = Math.max(0.82, 1 - Math.abs(y) / 1000);
      const nextScrim = SCRIM_OPACITY * clamp(1 - Math.abs(y) / 300, 0, 1);
      setVerticalTransform(y, x, nextScale, nextScrim);
      return;
    }
    setVerticalTransform(y);
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function verticalTransform(visual: Pick<VerticalVisual, 'x' | 'y' | 'scale'>): string {
    return `translate3d(${visual.x}px, ${visual.y}px, 0) scale(${visual.scale})`;
  }

  function setScrimOpacity(opacity: number): void {
    scrim.style.opacity = String(clamp(opacity, 0, SCRIM_OPACITY));
  }

  function setVerticalVisual(visual: VerticalVisual): void {
    verticalDragX = visual.x;
    verticalDragY = visual.y;
    verticalDragScale = visual.scale;
    currentSlide().style.transform = verticalTransform(visual);
    setScrimOpacity(visual.scrimOpacity);
  }

  function setVerticalTransform(y: number, x = 0, nextScale = 1, scrimOpacity = SCRIM_OPACITY): void {
    setVerticalVisual({ x, y, scale: nextScale, scrimOpacity });
  }

  function cancelVerticalAnimation(): void {
    if (verticalAnimation) {
      verticalAnimation.cancel();
      verticalAnimation = null;
    }
    if (scrimAnimation) {
      scrimAnimation.cancel();
      scrimAnimation = null;
    }
  }

  function springProgress(timeSeconds: number): number {
    const stiffness = 300;
    const damping = 30;
    const omega0 = Math.sqrt(stiffness);
    const zeta = damping / (2 * omega0);
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega0 * timeSeconds);
    const displacement = envelope * (
      Math.cos(omegaD * timeSeconds)
      + ((zeta * omega0) / omegaD) * Math.sin(omegaD * timeSeconds)
    );
    return 1 - displacement;
  }

  function animateVerticalTransform(toY: number, duration: number, onFinish?: () => void): void {
    cancelVerticalAnimation();
    const from: VerticalVisual = {
      x: verticalDragX,
      y: verticalDragY,
      scale: verticalDragScale,
      scrimOpacity: Number.parseFloat(scrim.style.opacity || String(SCRIM_OPACITY))
    };
    const to: VerticalVisual = { x: 0, y: toY, scale: 1, scrimOpacity: SCRIM_OPACITY };
    if (
      Math.abs(from.x) < 0.1
      && Math.abs(from.y - to.y) < 0.1
      && Math.abs(from.scale - 1) < 0.001
      && Math.abs(from.scrimOpacity - SCRIM_OPACITY) < 0.001
    ) {
      setVerticalVisual(to);
      if (toY === 0) currentSlide().style.transform = '';
      onFinish?.();
      return;
    }

    const sampleCount = 18;
    const stageFrames: Keyframe[] = [];
    const scrimFrames: Keyframe[] = [];
    for (let sample = 0; sample <= sampleCount; sample += 1) {
      const offset = sample / sampleCount;
      const progress = sample === sampleCount ? 1 : springProgress(0.42 * offset);
      const visual: VerticalVisual = {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        scale: from.scale + (to.scale - from.scale) * progress,
        scrimOpacity: from.scrimOpacity + (to.scrimOpacity - from.scrimOpacity) * progress
      };
      stageFrames.push({ offset, transform: verticalTransform(visual) });
      scrimFrames.push({ offset, opacity: visual.scrimOpacity });
    }

    const slide = currentSlide();
    const animation = slide.animate(stageFrames, {
      duration,
      easing: 'linear',
      fill: 'forwards'
    });
    const backdropAnimation = scrim.animate(scrimFrames, {
      duration,
      easing: 'linear',
      fill: 'forwards'
    });
    verticalAnimation = animation;
    scrimAnimation = backdropAnimation;
    void animation.finished.then(() => {
      if (verticalAnimation !== animation) return;
      verticalAnimation = null;
      scrimAnimation = null;
      setVerticalVisual(to);
      if (toY === 0) slide.style.transform = '';
      animation.cancel();
      backdropAnimation.cancel();
      onFinish?.();
    }).catch(() => {
      // Cancellation is expected when a new gesture interrupts the return animation.
    });
  }

  function resetVerticalTransform(animated = true): void {
    if (animated) {
      animateVerticalTransform(0, 160);
      return;
    }
    clearVerticalTransform();
  }

  function clearVerticalTransform(): void {
    cancelVerticalAnimation();
    verticalDragX = 0;
    verticalDragY = 0;
    verticalDragScale = 1;
    stageMotion.style.transition = '';
    stageMotion.style.transform = '';
    for (const image of slideImages) {
      const slide = image.parentElement;
      if (!slide) continue;
      slide.style.transition = '';
      slide.style.transform = '';
    }
    setScrimOpacity(SCRIM_OPACITY);
  }

  function syncPanelLayout(): void {
    requestAnimationFrame(() => {
      const metaHeight = meta.hidden ? 0 : Math.ceil(meta.getBoundingClientRect().height);
      root.style.setProperty('--lightbox-meta-h', `${metaHeight}px`);

      if (!isMobileViewport() || !exifSheetVisible || exifPanel.classList.contains('is-hidden')) {
        root.style.removeProperty('--mobile-exif-shift');
        return;
      }

      const exifHeight = Math.ceil(exifPanel.getBoundingClientRect().height);
      root.style.setProperty('--mobile-exif-shift', `${exifHeight + 14}px`);
    });
  }

  function clearWheelZoomGesture(): void {
    if (wheelZoomGestureTimer) window.clearTimeout(wheelZoomGestureTimer);
    wheelZoomGestureTimer = 0;
    wheelZoomGestureActive = false;
  }

  function markWheelZoomGesture(): void {
    wheelZoomGestureActive = true;
    if (wheelZoomGestureTimer) window.clearTimeout(wheelZoomGestureTimer);
    wheelZoomGestureTimer = window.setTimeout(() => {
      wheelZoomGestureActive = false;
      wheelZoomGestureTimer = 0;
    }, 460);
  }

  function syncMobileExifShift(): void {
    if (!isMobileViewport() || !exifSheetVisible || exifPanel.classList.contains('is-hidden')) {
      root.style.removeProperty('--mobile-exif-shift');
      return;
    }
    syncPanelLayout();
  }

  function clearSwitchTimer(): void {
    switchSequence += 1;
    if (switchTimer) {
      window.clearTimeout(switchTimer);
      switchTimer = 0;
    }
    root.classList.remove('switching');
  }

  function applyZoom(): void {
    const img = currentImage();
    img.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})`;
    img.classList.toggle('zoomed', scale > 1.01);
    root.classList.toggle('zoom-active', scale > 1.01);
  }

  function resetZoom(): void {
    scale = MIN_SCALE;
    offsetX = 0;
    offsetY = 0;
    activeMode = 'idle';
    swipeAxisLock = 'none';
    root.classList.remove('dragging', 'pinching', 'swiping', 'vertical-dragging');
    root.classList.remove('zoom-active');
    for (const img of slideImages) {
      img.style.transform = 'translate3d(0,0,0) scale(1)';
      img.classList.remove('zoomed');
    }
  }

  function setScaleAt(clientX: number, clientY: number, nextScale: number): void {
    nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    if (Math.abs(nextScale - scale) < 0.01) return;

    if (nextScale <= MIN_SCALE + 0.01) {
      scale = MIN_SCALE;
      offsetX = 0;
      offsetY = 0;
      applyZoom();
      return;
    }

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const imageX = (clientX - centerX - offsetX) / scale;
    const imageY = (clientY - centerY - offsetY) / scale;
    offsetX = clientX - centerX - imageX * nextScale;
    offsetY = clientY - centerY - imageY * nextScale;
    scale = nextScale;
    applyZoom();
  }

  function zoomAt(clientX: number, clientY: number, factor: number): void {
    setScaleAt(clientX, clientY, scale * factor);
  }

  function rebasePointerForPan(pointer: PointerRecord): void {
    const now = performance.now();
    pointer.startX = pointer.x;
    pointer.startY = pointer.y;
    pointer.lastX = pointer.x;
    pointer.lastY = pointer.y;
    pointer.lastT = now;
    pointer.velocityX = 0;
    pointer.velocityY = 0;
    dragOriginX = offsetX;
    dragOriginY = offsetY;
  }

  function isPointerOverCurrentImage(clientX: number, clientY: number): boolean {
    const rect = currentImage().getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function formatBytes(value?: number | null): string | null {
    if (!value || value < 1) return null;
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
  }

  function formatDate(value?: number | null): string | null {
    if (!value) return null;
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  }

  function appendExif(label: string, value?: string | number | null): void {
    if (value === null || value === undefined || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    exifList.append(dt, dd);
  }

  function shouldShowExifPanel(): boolean {
    if (!detailsVisible) return false;
    return !isMobileViewport() || exifSheetVisible;
  }

  function renderExif(item: ImageItem): void {
    exifList.replaceChildren();
    const meta = item.metadata || {};
    const exif = meta.exif || {};
    const width = meta.width ?? item.width;
    const height = meta.height ?? item.height;
    appendExif('\u683c\u5f0f', meta.format);
    appendExif('\u5c3a\u5bf8', width && height ? `${width} x ${height}` : null);
    appendExif('\u5149\u5708', exif.aperture);
    appendExif('\u5feb\u95e8\u901f\u5ea6', exif.shutterSpeed);
    appendExif('\u611f\u5149\u5ea6', exif.iso);
    appendExif('\u5b9e\u9645\u7126\u8ddd', exif.focalLength);
    appendExif('\u6d4b\u5149\u6a21\u5f0f', exif.meteringMode);
    appendExif('\u77e9\u9635\u6d4b\u5149', exif.matrixMetering);
    appendExif('\u70b9\u6d4b\u5149', exif.spotMetering);
    appendExif('\u66dd\u5149\u8865\u507f\uff08EV\uff09', exif.exposureCompensation);
    appendExif('\u95ea\u5149\u706f\u72b6\u6001', exif.flash);
    appendExif('\u5927\u5c0f', formatBytes(meta.sizeBytes));
    appendExif('\u4e0a\u4f20', formatDate(meta.uploadedAt ?? item.uploadedAt));
    appendExif('\u5e8f\u53f7', meta.uploadedDay && meta.uploadedDaySeq ? `${meta.uploadedDay}-${meta.uploadedDaySeq}` : null);
    const showExif = shouldShowExifPanel() && exifList.childElementCount > 0;
    exifPanel.classList.toggle('is-hidden', !showExif);
    exifPanel.setAttribute('aria-hidden', showExif ? 'false' : 'true');
    syncPanelLayout();
  }

  function renderMeta(item: ImageItem): void {
    tags.replaceChildren(...(item.tags || []).map((tag) => {
      const pill = document.createElement('span');
      pill.textContent = tag;
      return pill;
    }));

    description.replaceChildren();
    if (detailsVisible && item.description) {
      const text = document.createElement('div');
      text.className = 'caption-text';
      text.textContent = item.description;
      description.appendChild(text);
      if (item.attribution) {
        const attr = document.createElement('div');
        attr.className = 'caption-attr';
        attr.textContent = item.attribution;
        description.appendChild(attr);
      }
    }

    renderExif(item);
    const descriptionWasVisible = description.classList.contains('visible');
    description.classList.toggle('visible', detailsVisible && Boolean(item.description));
    if (detailsVisible) {
      window.clearTimeout(infoCloseTimer);
      infoCloseTimer = 0;
      root.classList.add('lightbox-info-visible');
    } else if (descriptionWasVisible || infoCloseTimer) {
      root.classList.add('lightbox-info-visible');
      if (!infoCloseTimer) {
        infoCloseTimer = window.setTimeout(() => {
          infoCloseTimer = 0;
          if (detailsVisible) return;
          root.classList.remove('lightbox-info-visible');
          syncPanelLayout();
        }, 220);
      }
    } else {
      root.classList.remove('lightbox-info-visible');
    }
    infoButton.hidden = !item.description && exifList.childElementCount === 0;
    meta.hidden = tags.childElementCount === 0 && !item.description && exifList.childElementCount === 0;
    syncPanelLayout();
  }

  function renderLike(item: ImageItem): void {
    const count = Math.max(0, item.likeCount || 0);
    likeButton.classList.toggle('liked', Boolean(item.likedByMe));
    likeButton.classList.toggle('busy', likeBusy);
    likeButton.setAttribute('aria-pressed', item.likedByMe ? 'true' : 'false');
    likeCount.textContent = count > 0 ? (count > 999 ? '1K+' : String(count)) : '';
    likeCount.hidden = count === 0;
  }

  function emitLikeUpdated(item: ImageItem): void {
    window.dispatchEvent(new CustomEvent('photohost:like-updated', {
      detail: {
        id: item.id,
        likeCount: Math.max(0, item.likeCount || 0),
        likedByMe: Boolean(item.likedByMe)
      }
    }));
  }

  async function toggleLike(): Promise<void> {
    const item = currentItem();
    if (!item || likeBusy) return;

    const viewerId = requireSessionViewerId();
    likeBusy = true;
    const previousLiked = item.likedByMe;
    const previousCount = item.likeCount || 0;
    item.likedByMe = !previousLiked;
    item.likeCount = Math.max(0, previousCount + (item.likedByMe ? 1 : -1));
    renderLike(item);
    sendCommentContext();
    emitLikeUpdated(item);

    try {
      const result = await apiFetch<LikeResponse>(`/api/images/${encodeURIComponent(item.id)}/like`, {
        method: 'POST',
        headers: { 'X-Viewer-Id': viewerId },
        body: JSON.stringify({ liked: item.likedByMe })
      });
      item.likedByMe = result.likedByMe;
      item.likeCount = result.likeCount;
      emitLikeUpdated(item);
      likeButton.classList.toggle('pulse', result.likedByMe);
      window.setTimeout(() => likeButton.classList.remove('pulse'), 260);
    } catch (err) {
      item.likedByMe = previousLiked;
      item.likeCount = previousCount;
      emitLikeUpdated(item);
      console.warn('[like] failed:', err);
    } finally {
      likeBusy = false;
      renderLike(item);
    }
  }

  function setImage(
    img: HTMLImageElement,
    item: ImageItem | null,
    priority: 'high' | 'low' | 'auto' = 'auto',
    variant: 'thumb' | 'web' = 'web'
  ): void {
    if (!item) {
      img.removeAttribute('src');
      img.removeAttribute('data-image-id');
      img.alt = '';
      img.title = '';
      img.style.opacity = '0';
      applyLightboxImageLayout(img, null);
      return;
    }
    applyLightboxImageLayout(img, item);
    const src = mediaUrl(variant === 'thumb' ? item.thumbUrl : item.webUrl, item);
    const changed = img.dataset.imageId !== item.id || img.src !== src;
    img.fetchPriority = priority;
    img.dataset.imageId = item.id;
    img.alt = '';
    img.title = '';
    img.onload = () => {
      const reveal = () => {
        if (img.dataset.imageId === item.id) {
          decodedLightboxSources.add(src);
          img.style.opacity = '1';
        }
      };
      if (typeof img.decode === 'function') void img.decode().then(reveal, reveal);
      else reveal();
    };
    img.onerror = () => {
      if (img.dataset.imageId !== item.id) return;
      const retry = new URL(src);
      retry.searchParams.set('retry', String(Date.now()));
      window.setTimeout(() => {
        if (img.dataset.imageId === item.id) img.src = retry.toString();
      }, 450);
    };
    if (changed) {
      if (!decodedLightboxSources.has(src)) img.style.opacity = '0';
      img.src = src;
      if (decodedLightboxSources.has(src) || (img.complete && img.naturalWidth > 0)) {
        decodedLightboxSources.add(src);
        img.style.opacity = '1';
      }
    } else if (img.complete && img.naturalWidth > 0) {
      decodedLightboxSources.add(src);
      img.style.opacity = '1';
    }
  }

  function slideMotionActive(): boolean {
    return activeMode === 'swipe' || isSwitching;
  }

  function applyOrDeferSlideUpgrade(img: HTMLImageElement, update: () => void): void {
    if (slideMotionActive()) {
      deferredSlideUpgrades.set(img, update);
      return;
    }
    update();
  }

  function flushDeferredSlideUpgrades(): void {
    window.clearTimeout(slideUpgradeTimer);
    slideUpgradeTimer = 0;
    if (slideMotionActive() || deferredSlideUpgrades.size === 0) return;
    const updates = [...deferredSlideUpgrades.values()];
    deferredSlideUpgrades.clear();
    for (const update of updates) update();
  }

  function scheduleDeferredSlideUpgrades(delay = 0): void {
    window.clearTimeout(slideUpgradeTimer);
    slideUpgradeTimer = window.setTimeout(flushDeferredSlideUpgrades, delay);
  }

  function renderSlides(options: { preserveCurrent?: boolean } = {}): void {
    const list = viewableItems();
    if (index >= list.length) index = list.length - 1;
    const item = list[index];
    if (!item || list.length === 0) return;

    const sequence = ++slideRenderSequence;
    const prev = list.length > 1 ? list[(index - 1 + list.length) % list.length] : null;
    const next = list.length > 1 ? list[(index + 1) % list.length] : null;
    const currentWebSource = mediaUrl(item.webUrl, item);
    const currentVariant = heroOpeningImageId === item.id
      ? 'thumb'
      : (slideMotionActive() || !decodedLightboxSources.has(currentWebSource) ? 'thumb' : 'web');
    if (options.preserveCurrent) {
      const current = slideImages[1];
      applyLightboxImageLayout(current, item);
      current.fetchPriority = 'high';
      current.dataset.imageId = item.id;
      current.alt = '';
      current.title = '';
      current.style.opacity = '1';
    } else {
      setImage(slideImages[1], item, 'high', currentVariant);
    }
    setImage(slideImages[0], prev, 'low', 'thumb');
    setImage(slideImages[2], next, 'low', 'thumb');
    void preloadLightboxImage(item, 'high').then(() => {
      if (sequence !== slideRenderSequence || currentItem()?.id !== item.id || !isVisible()) return;
      if (heroFallbackImageId === item.id) return;
      applyOrDeferSlideUpgrade(slideImages[1], () => {
        if (sequence === slideRenderSequence && currentItem()?.id === item.id && isVisible()) {
          setImage(slideImages[1], item, 'high', 'web');
        }
      });
      void preloadLightboxImage(prev, 'low').then(() => {
        applyOrDeferSlideUpgrade(slideImages[0], () => {
          if (sequence === slideRenderSequence && currentItem()?.id === item.id && isVisible()) {
            setImage(slideImages[0], prev, 'low', 'web');
          }
        });
      });
      void preloadLightboxImage(next, 'low').then(() => {
        applyOrDeferSlideUpgrade(slideImages[2], () => {
          if (sequence === slideRenderSequence && currentItem()?.id === item.id && isVisible()) {
            setImage(slideImages[2], next, 'low', 'web');
          }
        });
      });
    });
    renderMeta(item);
    renderLike(item);
  }

  function syncSlideImageLayouts(): void {
    const list = viewableItems();
    if (index < 0 || index >= list.length) return;
    const item = list[index];
    const prev = list.length > 1 ? list[(index - 1 + list.length) % list.length] : null;
    const next = list.length > 1 ? list[(index + 1) % list.length] : null;
    applyLightboxImageLayout(slideImages[1], item);
    applyLightboxImageLayout(slideImages[0], prev);
    applyLightboxImageLayout(slideImages[2], next);
  }

  function render(): void {
    resetZoom();
    renderSlides();
    resetTrack(false);
  }

  function open(id: string, origin?: HTMLElement | null): void {
    clearExitClickGuard();
    heroAnimationSequence += 1;
    heroAnimating = false;
    removeHeroClone();
    restoreHeroSources();
    root.style.removeProperty('opacity');
    root.classList.remove('hero-animating', 'hero-opening', 'hero-closing', 'hero-layer-only', 'hero-pass-through', 'gesture-active');
    stageMotion.style.visibility = '';
    currentImage().style.visibility = '';
    const originImage = origin instanceof HTMLImageElement
      ? origin
      : origin?.querySelector<HTMLImageElement>('.photo-image') || null;
    const originShell = heroSourceShell(originImage);
    const originRect = originShell?.getBoundingClientRect() || originImage?.getBoundingClientRect() || null;
    const shouldAnimateHero = isMobileViewport() && Boolean(originImage) && isUsableRect(originRect);
    const list = viewableItems();
    index = list.findIndex((item) => item.id === id);
    if (index === -1) {
      restoreHeroSources();
      return;
    }
    heroOriginId = id;
    heroOriginElement = originImage;
    heroOriginRect = isUsableRect(originRect) ? originRect : null;
    heroOpeningImageId = shouldAnimateHero ? id : '';
    heroFallbackImageId = '';
    exifSheetVisible = false;
    lastImageTapAt = 0;
    lastImageTapId = '';
    document.body.classList.add('lightbox-open');
    setGalleryLocked(true);
    render();
    root.classList.add('visible');
    if (shouldAnimateHero && originImage && isUsableRect(originRect)) {
      void animateHeroOpen(list[index], originImage, originRect);
    } else {
      setScrimOpacity(SCRIM_OPACITY);
    }
    preloadComments();
    ensureCommentContext(true);
  }

  function close(): void {
    const heroExit = root.classList.contains('hero-closing');
    if (heroExit) {
      setScrimOpacity(0);
      root.style.opacity = '0';
      root.classList.remove('visible');
    }
    heroAnimationSequence += 1;
    heroAnimating = false;
    removeHeroClone();
    restoreHeroSources();
    if (!heroExit) root.classList.remove('visible');
    document.body.classList.remove('lightbox-open');
    setGalleryLocked(false);
    setCommentsVisible(false);
    window.clearTimeout(infoCloseTimer);
    infoCloseTimer = 0;
    root.classList.remove('lightbox-info-visible');
    for (const img of slideImages) {
      img.removeAttribute('src');
      img.removeAttribute('data-image-id');
      img.style.opacity = '0';
    }
    pointers.clear();
    clearSwitchTimer();
    window.clearTimeout(slideUpgradeTimer);
    slideUpgradeTimer = 0;
    deferredSlideUpgrades.clear();
    slideRenderSequence += 1;
    clearWheelZoomGesture();
    isSwitching = false;
    switchDelta = 0;
    exifSheetVisible = false;
    lastImageTapAt = 0;
    lastImageTapId = '';
    root.classList.remove('mobile-exif-open', 'vertical-dragging');
    root.style.removeProperty('--lightbox-meta-h');
    stageMotion.style.visibility = '';
    currentImage().style.visibility = '';
    resetZoom();
    resetVerticalTransform(false);
    resetTrack(false);
    root.classList.remove('hero-animating', 'hero-opening', 'hero-closing', 'hero-layer-only', 'hero-pass-through', 'gesture-active');
    heroOriginId = '';
    heroOriginElement = null;
    heroOriginRect = null;
    heroOpeningImageId = '';
    heroFallbackImageId = '';
    index = -1;
    if (heroExit) {
      requestAnimationFrame(() => {
        if (!isVisible()) root.style.removeProperty('opacity');
      });
    }
  }

  function commitMove(delta: number, preserveCurrent = false): void {
    const list = viewableItems();
    if (index === -1 || list.length === 0) return;
    index = (index + delta + list.length) % list.length;
    heroFallbackImageId = '';
    if (isMobileViewport()) exifSheetVisible = false;
    if (!preserveCurrent) {
      render();
      preloadComments();
      ensureCommentContext(true);
      return;
    }
    resetZoom();
    renderSlides({ preserveCurrent: true });
    resetTrack(false);
    preloadComments();
    ensureCommentContext(true);
  }

  function finishMove(delta: number): void {
    clearSwitchTimer();
    isSwitching = true;
    root.classList.add('switching');
    switchDelta = delta;
    const sequence = ++switchSequence;
    const list = viewableItems();
    const targetItem = index !== -1 && list.length > 0
      ? list[(index + delta + list.length) % list.length]
      : null;
    const target = delta > 0 ? -viewportWidth() : viewportWidth();
    void preloadLightboxImage(targetItem, 'high');
    setTrackTransform(target, true);
    switchTimer = window.setTimeout(() => {
      switchTimer = 0;
      if (switchSequence !== sequence || !isSwitching) return;
      switchDelta = 0;
      rotateSlides(delta);
      commitMove(delta, true);
      isSwitching = false;
      root.classList.remove('switching');
      track.style.transition = '';
      scheduleDeferredSlideUpgrades();
    }, 270);
  }

  function interruptSwitching(): void {
    if (!isSwitching || !switchDelta) return;
    const delta = switchDelta;
    clearSwitchTimer();
    switchDelta = 0;
    isSwitching = false;
    root.classList.remove('switching');
    track.style.transition = 'none';
    commitMove(delta);
  }

  function move(delta: number): void {
    if (commentsVisible) return;
    if (isSwitching) interruptSwitching();
    if (viewableItems().length < 2) return;
    resetZoom();
    resetTrack(false);
    requestAnimationFrame(() => finishMove(delta));
  }

  function animateStageMotionFrom(beforeRect: DOMRect | null): void {
    if (!beforeRect) return;

    const afterRect = stageMotion.getBoundingClientRect();
    const dy = beforeRect.top - afterRect.top;
    if (Math.abs(dy) < 0.5) {
      clearVerticalTransform();
      return;
    }

    cancelVerticalAnimation();
    setVerticalTransform(dy);
    animateVerticalTransform(0, 250);
  }

  function prepareStageForPanelTransition(): DOMRect {
    const beforeRect = stageMotion.getBoundingClientRect();
    clearVerticalTransform();
    return beforeRect;
  }

  function openMobileExifSheet(animated = true): boolean {
    if (!isMobileViewport() || !detailsVisible) return false;
    const beforeRect = animated ? prepareStageForPanelTransition() : null;
    exifSheetVisible = true;
    root.classList.add('mobile-exif-open');
    const item = viewableItems()[index];
    if (item) renderMeta(item);
    animateStageMotionFrom(beforeRect);
    return true;
  }

  function closeMobileExifSheet(animated = true): boolean {
    if (!exifSheetVisible) return false;
    const beforeRect = animated ? prepareStageForPanelTransition() : null;
    exifSheetVisible = false;
    root.classList.remove('mobile-exif-open');
    root.style.removeProperty('--mobile-exif-shift');
    const item = currentItem();
    if (item) renderMeta(item);
    animateStageMotionFrom(beforeRect);
    return true;
  }

  function finalizeHeroExit(
    sequence: number,
    imageAnimation: Animation,
    backdropAnimation: Animation
  ): void {
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      const shouldClose = sequence === heroAnimationSequence && isVisible();
      try {
        imageAnimation.commitStyles();
      } catch {
        // Some browsers throw if the animation is already idle.
      }
      try {
        backdropAnimation.commitStyles();
      } catch {
        // The inline scrim/root state above is the visual source of truth.
      }
      setScrimOpacity(0);
      restoreHeroSources();
      if (!shouldClose) {
        root.classList.remove('hero-layer-only');
        stageMotion.style.visibility = '';
        if (backdropAnimation.playState !== 'idle') backdropAnimation.cancel();
        if (imageAnimation.playState !== 'idle') imageAnimation.cancel();
        return;
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (sequence !== heroAnimationSequence || !isVisible()) return;
          root.style.opacity = '0';
          root.classList.remove('visible');
          if (backdropAnimation.playState !== 'idle') backdropAnimation.cancel();
          if (imageAnimation.playState !== 'idle') imageAnimation.cancel();
          close();
        });
      });
    };
    imageAnimation.onfinish = finalize;
    imageAnimation.oncancel = finalize;
  }

  function closeWithoutHero(): void {
    const sequence = ++heroAnimationSequence;
    heroAnimating = true;
    root.classList.add('hero-animating', 'hero-closing');
    lockExitInteraction();

    const slide = currentSlide();
    const from = verticalTransform({ x: verticalDragX, y: verticalDragY, scale: verticalDragScale });
    const to = verticalTransform({
      x: verticalDragX,
      y: Math.max(verticalDragY, window.innerHeight * 0.42),
      scale: Math.max(0.78, verticalDragScale * 0.9)
    });
    const currentScrim = Number.parseFloat(scrim.style.opacity || String(SCRIM_OPACITY));
    const imageAnimation = slide.animate([
      { transform: from, opacity: 1 },
      { transform: to, opacity: 0 }
    ], {
      duration: 260,
      easing: HERO_EASING,
      fill: 'forwards'
    });
    const backdropAnimation = scrim.animate([
      { opacity: currentScrim },
      { opacity: 0 }
    ], {
      duration: 260,
      easing: HERO_EASING,
      fill: 'forwards'
    });
    finalizeHeroExit(sequence, imageAnimation, backdropAnimation);
  }

  function closeFromVerticalGesture(): void {
    if (heroAnimating) return;
    const item = currentItem();
    const source = currentImage();
    const sourceRect = source.getBoundingClientRect();
    if (!item || !isUsableRect(sourceRect)) {
      closeWithoutHero();
      return;
    }

    const ratio = sourceRect.width / sourceRect.height;
    const target = heroDestination(item);
    const destination = target?.rect || new DOMRect(
        window.innerWidth * 0.46,
        window.innerHeight + 12,
        window.innerWidth * 0.08,
        (window.innerWidth * 0.08) / ratio
      );
    const targetRadius = target?.element ? heroBorderRadius(target.element) : '0px';
    const clone = createHeroClone(source, sourceRect, '0px');
    if (!clone) {
      closeWithoutHero();
      return;
    }
    hideHeroSource(target?.element || null);

    const sequence = ++heroAnimationSequence;
    heroAnimating = true;
    root.classList.add('hero-animating', 'hero-closing', 'hero-layer-only');
    stageMotion.style.visibility = 'hidden';
    lockExitInteraction();
    const currentScrim = Number.parseFloat(scrim.style.opacity || String(SCRIM_OPACITY));
    const targetTransform = transformRectToRect(sourceRect, destination);
    const imageAnimation = clone.animate([
      { transform: 'translate3d(0, 0, 0) scale(1, 1)', opacity: 1, borderRadius: '0px' },
      { transform: targetTransform, opacity: 1, borderRadius: targetRadius }
    ], {
      duration: HERO_EXIT_DURATION,
      easing: HERO_EASING,
      fill: 'forwards'
    });
    const backdropAnimation = scrim.animate([
      { opacity: currentScrim },
      { opacity: 0 }
    ], {
      duration: HERO_EXIT_DURATION,
      easing: HERO_EASING,
      fill: 'forwards'
    });
    finalizeHeroExit(sequence, imageAnimation, backdropAnimation);
  }

  function finishVerticalGesture(pointer?: PointerRecord): void {
    const travel = verticalDragY;
    const velocity = pointer?.velocityY || 0;
    activeMode = 'idle';
    swipeAxisLock = 'none';
    root.classList.remove('vertical-dragging');

    if (exifSheetVisible && (travel > 44 || velocity > 0.35)) {
      closeMobileExifSheet(true);
      return;
    }

    const exitDistance = Math.min(208, Math.max(156, window.innerHeight * 0.22));
    if (travel > exitDistance || (travel > exitDistance * 0.68 && velocity > 0.95)) {
      closeFromVerticalGesture();
      return;
    }

    if (detailsVisible && (travel < -72 || velocity < -0.45) && openMobileExifSheet(true)) {
      return;
    }

    resetVerticalTransform(true);
  }

  function endPointer(pointerId: number): void {
    const current = pointers.get(pointerId);
    if (current && moved(current) > 6) suppressClickUntil = Date.now() + 320;
    if (current) {
      lastPointerEndX = current.x;
      lastPointerEndY = current.y;
    }
    pointers.delete(pointerId);
    if (pointers.size === 0) {
      root.classList.remove('gesture-active');
      swipeAxisLock = 'none';
    }

    if (activeMode === 'vertical') {
      finishVerticalGesture(current);
      return;
    }

    if (activeMode === 'swipe') {
      const travel = trackX;
      const velocity = current?.velocityX || 0;
      const threshold = Math.min(130, window.innerWidth * 0.2);
      activeMode = 'idle';
      swipeAxisLock = 'none';
      root.classList.remove('swiping');

      if (viewableItems().length < 2) {
        resetTrack(true);
        scheduleDeferredSlideUpgrades(280);
        return;
      }

      if (Math.abs(travel) > threshold || Math.abs(velocity) > 0.55) {
        finishMove(travel < 0 || velocity < -0.55 ? 1 : -1);
      } else {
        resetTrack(true);
        scheduleDeferredSlideUpgrades(280);
      }
      return;
    }

    if (activeMode === 'pan' && pointers.size === 0) {
      activeMode = 'idle';
      swipeAxisLock = 'none';
      root.classList.remove('dragging');
    }

    if (activeMode === 'pinch' && pointers.size < 2) {
      root.classList.remove('pinching');
      pinchDistance = 0;
      if (scale <= 1.01) {
        resetZoom();
        return;
      }

      const remaining = [...pointers.values()][0];
      if (remaining) {
        rebasePointerForPan(remaining);
        activeMode = 'pan';
        root.classList.add('dragging');
      } else {
        activeMode = 'idle';
        swipeAxisLock = 'none';
        root.classList.remove('dragging');
      }
    }
  }

  infoButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const item = viewableItems()[index];
    if (!item) return;
    if (commentsVisible) setCommentsVisible(false);
    detailsVisible = !detailsVisible;
    if (!detailsVisible || isMobileViewport()) exifSheetVisible = false;
    root.classList.toggle('mobile-exif-open', exifSheetVisible);
    localStorage.setItem(DETAILS_KEY, detailsVisible ? '1' : '0');
    renderMeta(item);
  });

  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });
  prevButton.addEventListener('click', (event) => {
    event.stopPropagation();
    move(-1);
  });
  nextButton.addEventListener('click', (event) => {
    event.stopPropagation();
    move(1);
  });
  likeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggleLike();
  });
  commentButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setCommentsVisible(!commentsVisible);
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== COMMENT_ORIGIN || event.source !== commentFrame.contentWindow) return;
    const message = event.data as { type?: string };
    if (message.type === 'comment-ui:ready') {
      commentFrame.dataset.ready = 'true';
      commentPanel.classList.remove('is-loading');
      connectCommentDragChannel();
      ensureCommentContext(true);
      return;
    }
    if (message.type === 'comment-ui:loaded') {
      const current = currentItem();
      const loaded = message as { type: string; imageId?: string; commentCount?: number; commentedByMe?: boolean };
      if (current && loaded.imageId === current.id) {
        commentFrame.dataset.contextReady = current.id;
        clearCommentContextRetry();
        if (loaded.commentedByMe) markLocalCommentedImage(current.id);
        current.commentedByMe = Boolean(current.commentedByMe || loaded.commentedByMe || hasLocalCommentedImage(current.id));
        if (typeof loaded.commentCount === 'number') {
          current.commentCount = Math.max(0, loaded.commentCount);
          window.dispatchEvent(new CustomEvent('photohost:comment-count-updated', {
            detail: { id: current.id, commentCount: current.commentCount, commentedByMe: current.commentedByMe }
          }));
        }
      }
      return;
    }
    if (message.type === 'comment-ui:close') {
      setCommentsVisible(false);
      return;
    }
    if (message.type === 'comment-ui:pull') {
      handleCommentPull(message as CommentPullMessage);
      return;
    }
    if (message.type === 'comment-ui:request-admin') {
      void (async () => {
        if (!isDeleteAuthenticated() && !(await promptPin('delete'))) return;
        const token = getDeleteToken();
        if (!token || !commentFrame.contentWindow) return;
        commentFrame.contentWindow.postMessage({ type: 'normalpics:admin-token', token }, COMMENT_ORIGIN);
      })();
    }
  });

  root.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target === root) {
      if (commentsVisible) setCommentsVisible(false);
      else if (!isMobileViewport()) close();
    }
  });

  stage.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) return;
    if (commentsVisible) {
      setCommentsVisible(false);
      return;
    }
    if (scale > 1.01) return;
    if (event.target instanceof HTMLImageElement) {
      if (closeMobileExifSheet()) return;
      const item = currentItem();
      if (!item) return;
      const now = Date.now();
      if (lastImageTapId === item.id && now - lastImageTapAt < 320) {
        lastImageTapAt = 0;
        lastImageTapId = '';
        void toggleLike();
        return;
      }
      lastImageTapAt = now;
      lastImageTapId = item.id;
      return;
    }
    if (!isMobileViewport()) close();
  });

  root.addEventListener('wheel', (event) => {
    if (!isVisible()) return;
    event.preventDefault();

    if (scale > 1.01 || isPointerOverCurrentImage(event.clientX, event.clientY)) {
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      markWheelZoomGesture();
      return;
    }

    if (wheelZoomGestureActive) {
      markWheelZoomGesture();
      return;
    }

    if (commentsVisible) return;
    if (isMobileViewport() || viewableItems().length < 2) return;
    const now = Date.now();
    if (now - lastWheelMoveAt < 340 || isSwitching) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(delta) < 8) return;
    lastWheelMoveAt = now;
    move(delta > 0 ? 1 : -1);
  }, { passive: false });

  root.addEventListener('pointerdown', (event) => {
    if (!isVisible() || event.button !== 0) return;
    settleHeroCloneForInteraction();
    if (heroAnimating) return;
    if ((event.target as HTMLElement).closest('button, .lightbox-meta, .lightbox-exif, .lightbox-comments')) return;
    if (commentsVisible && isMobileViewport()) return;
    event.stopPropagation();
    root.classList.add('gesture-active');
    if (isSwitching) interruptSwitching();

    const now = performance.now();
    const record: PointerRecord = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: now,
      velocityX: 0,
      velocityY: 0,
      pointerType: event.pointerType
    };
    pointers.set(event.pointerId, record);
    root.setPointerCapture(event.pointerId);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = distance(a, b);
      activeMode = 'pinch';
      root.classList.add('pinching');
      root.classList.remove('dragging', 'swiping');
      clearVerticalTransform();
      resetTrack(true);
      return;
    }

    if (scale > 1.01) {
      activeMode = 'pan';
      dragOriginX = offsetX;
      dragOriginY = offsetY;
      root.classList.add('dragging');
    } else if (isMobileViewport()) {
      activeMode = 'swipe';
      swipeAxisLock = 'none';
      root.classList.add('swiping');
      setTrackTransform(0, false);
    }
  });

  root.addEventListener('pointermove', (event) => {
    const current = pointers.get(event.pointerId);
    if (!current || !isVisible()) return;
    event.stopPropagation();

    const now = performance.now();
    const dt = Math.max(8, now - current.lastT);
    current.velocityX = (event.clientX - current.lastX) / dt;
    current.velocityY = (event.clientY - current.lastY) / dt;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
    current.lastT = now;
    current.x = event.clientX;
    current.y = event.clientY;
    if (moved(current) > 6) suppressClickUntil = Date.now() + 320;

    if (activeMode === 'pinch' && pointers.size >= 2) {
      event.preventDefault();
      const [a, b] = [...pointers.values()];
      const nextDistance = distance(a, b);
      if (pinchDistance > 0) {
        const center = midpoint(a, b);
        setScaleAt(center.x, center.y, scale * (nextDistance / pinchDistance));
      }
      pinchDistance = nextDistance;
      return;
    }

    if (activeMode === 'pan') {
      event.preventDefault();
      const primary = [...pointers.values()][0];
      offsetX = dragOriginX + primary.x - primary.startX;
      offsetY = dragOriginY + primary.y - primary.startY;
      applyZoom();
      return;
    }

    if (activeMode === 'vertical') {
      event.preventDefault();
      const deltaX = current.x - current.startX;
      const deltaY = current.y - current.startY;
      applyVerticalGesture(deltaX, deltaY);
      return;
    }

    if (activeMode === 'swipe' && scale <= 1.01) {
      const deltaX = current.x - current.startX;
      const deltaY = current.y - current.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (swipeAxisLock === 'none' && absX > 14 && absX > absY * 1.05) {
        swipeAxisLock = 'horizontal';
      }
      if (
        swipeAxisLock !== 'horizontal'
        && isMobileViewport()
        && absY > 14
        && absY > absX * 1.12
      ) {
        swipeAxisLock = 'vertical';
        activeMode = 'vertical';
        root.classList.remove('swiping');
        root.classList.add('vertical-dragging');
        resetTrack(false);
        event.preventDefault();
        applyVerticalGesture(deltaX, deltaY);
        return;
      }
      if (swipeAxisLock !== 'horizontal' && absY > absX * 1.15) return;
      event.preventDefault();
      const limit = viewportWidth() * 0.96;
      const clamped = Math.max(-limit, Math.min(limit, deltaX));
      setTrackTransform(clamped, false);
    }
  }, { passive: false });

  root.addEventListener('pointerup', (event) => {
    event.stopPropagation();
    try {
      root.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    endPointer(event.pointerId);
  });

  root.addEventListener('pointercancel', (event) => {
    event.stopPropagation();
    resetTrack(true);
    resetVerticalTransform(true);
    pointers.delete(event.pointerId);
    if (pointers.size === 0) root.classList.remove('gesture-active');
    activeMode = 'idle';
    swipeAxisLock = 'none';
    root.classList.remove('dragging', 'pinching', 'swiping', 'vertical-dragging');
    scheduleDeferredSlideUpgrades(280);
  });

  for (const image of slideImages) {
    image.addEventListener('dblclick', (event) => {
      if (!isVisible()) return;
      event.preventDefault();
      event.stopPropagation();
    });
  }

  window.addEventListener('resize', () => {
    if (!isVisible()) return;
    syncSlideImageLayouts();
    resetTrack(false);
    const item = currentItem();
    if (item) renderMeta(item);
    if (!isMobileViewport()) {
      exifSheetVisible = false;
      root.classList.remove('mobile-exif-open');
      root.style.removeProperty('--mobile-exif-shift');
      clearVerticalTransform();
      if (item) renderMeta(item);
    }
    syncPanelLayout();
  });

  window.addEventListener('keydown', (event) => {
    if (!isVisible()) return;
    if (event.key === 'Escape' && commentsVisible) {
      setCommentsVisible(false);
      return;
    }
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
  });

  return { open };
}
