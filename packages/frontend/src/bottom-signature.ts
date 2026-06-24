interface BottomSignatureOptions {
  isComplete: () => boolean;
}

const MAX_PULL = 92;
const WHEEL_EXTRA_PULL = 36;
const WHEEL_IDLE_DELAY = 120;
const WHEEL_DWELL_DELAY = 535;
const WHEEL_RESPONSE = 18;
const RELEASE_RESPONSE = 14;
const SETTLE_EPSILON = 0.08;

export function initBottomSignature(options: BottomSignatureOptions): void {
  const signature = document.createElement('div');
  signature.className = 'bottom-signature';
  signature.textContent = 'Tchirek';
  signature.setAttribute('aria-hidden', 'true');
  document.body.appendChild(signature);

  let rawPull = 0;
  let targetPull = 0;
  let renderedPull = 0;
  let pullVelocity = 0;
  let frame = 0;
  let lastFrameAt = 0;
  let wheelIdleTimer = 0;
  let wheelDwellTimer = 0;
  let touchId: number | null = null;
  let lastTouchY = 0;
  let touchActive = false;

  function canPull(): boolean {
    if (!options.isComplete()) return false;
    if (document.body.classList.contains('lightbox-open')) return false;
    const doc = document.documentElement;
    const scrollTop = window.scrollY || doc.scrollTop || 0;
    const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
    return scrollTop >= maxScroll - 2;
  }

  function dampen(value: number, extra = false): number {
    const base = MAX_PULL * (1 - Math.exp(-Math.max(0, value) / 118));
    if (!extra || base < MAX_PULL - 0.5) return base;
    const overPull = Math.max(0, value - 260);
    return MAX_PULL + WHEEL_EXTRA_PULL * (1 - Math.exp(-overPull / 860));
  }

  function applyPull(value: number): void {
    const opacity = Math.min(1, value / 54);
    const scale = 0.94 + Math.min(0.06, value / 1500);
    signature.style.opacity = opacity.toFixed(3);
    signature.style.transform = `translate3d(-50%, ${(110 - value).toFixed(3)}%, 0) scale(${scale.toFixed(3)})`;
  }

  function renderTowardTarget(): void {
    const now = performance.now();
    const dt = Math.min(0.04, Math.max(0.001, (now - lastFrameAt) / 1000 || 0.016));
    lastFrameAt = now;
    const target = dampen(targetPull, true);
    const distance = target - renderedPull;
    const response = targetPull > 0 ? WHEEL_RESPONSE : RELEASE_RESPONSE;
    pullVelocity = distance * response;
    renderedPull += pullVelocity * dt;
    if (Math.abs(target - renderedPull) < SETTLE_EPSILON && Math.abs(pullVelocity) < 0.12) {
      renderedPull = target;
      pullVelocity = 0;
    }
    applyPull(renderedPull);
    if (Math.abs(target - renderedPull) >= SETTLE_EPSILON || Math.abs(pullVelocity) >= 0.12) {
      frame = window.requestAnimationFrame(renderTowardTarget);
      return;
    }
    frame = 0;
  }

  function scheduleRender(smooth = false): void {
    if (smooth) {
      if (!frame) {
        lastFrameAt = performance.now();
        frame = window.requestAnimationFrame(renderTowardTarget);
      }
      return;
    }
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    pullVelocity = 0;
    renderedPull = dampen(targetPull);
    applyPull(renderedPull);
  }

  function pullBy(delta: number, smooth = false): void {
    rawPull = Math.min(520, Math.max(0, rawPull + delta));
    targetPull = rawPull;
    signature.classList.add('is-pulling');
    scheduleRender(smooth);
  }

  function dwellBeforeWheelRelease(): void {
    if (rawPull <= 0) return;
    window.clearTimeout(wheelDwellTimer);
    wheelDwellTimer = window.setTimeout(release, WHEEL_DWELL_DELAY);
  }

  function release(): void {
    window.clearTimeout(wheelIdleTimer);
    window.clearTimeout(wheelDwellTimer);
    if (rawPull <= 0 && !signature.classList.contains('is-pulling')) return;
    rawPull = 0;
    targetPull = 0;
    signature.classList.remove('is-pulling');
    scheduleRender();
  }

  window.addEventListener('wheel', (event) => {
    if (event.deltaY <= 0 || !canPull()) {
      if (rawPull > 0 && event.deltaY < 0) release();
      return;
    }
    event.preventDefault();
    window.clearTimeout(wheelDwellTimer);
    pullBy(event.deltaY * 0.42, true);
    window.clearTimeout(wheelIdleTimer);
    wheelIdleTimer = window.setTimeout(dwellBeforeWheelRelease, WHEEL_IDLE_DELAY);
  }, { passive: false });

  window.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchId = touch.identifier;
    lastTouchY = touch.clientY;
    touchActive = false;
  }, { passive: true });

  window.addEventListener('touchmove', (event) => {
    if (touchId === null) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === touchId);
    if (!touch) return;
    const delta = lastTouchY - touch.clientY;
    lastTouchY = touch.clientY;
    if (delta <= 0) {
      if (rawPull > 0) pullBy(delta * 0.8);
      return;
    }
    if (!touchActive && !canPull()) return;
    event.preventDefault();
    touchActive = true;
    pullBy(delta * 0.92);
  }, { passive: false });

  function endTouch(): void {
    touchId = null;
    touchActive = false;
    release();
  }

  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });

  window.addEventListener('scroll', () => {
    if (!canPull()) release();
  }, { passive: true });
}
