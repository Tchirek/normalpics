import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const siteUrl = process.env.NORMALPICS_SITE_URL || "https://pics.example.com";
const edgePath = process.env.EDGE_PATH
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "normalpics-ui-test-"));
const port = await availablePort();
const edge = spawn(edgePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--window-size=1440,1000",
  siteUrl,
], {
  stdio: "ignore",
});

try {
  const target = await waitForTarget(port);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const requests = new Map();
  const respondedRequests = new Set();
  const networkLog = [];
  const consoleLog = [];
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    requests.set(requestId, { method: request.method, url: request.url });
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (isRelevantUrl(response.url)) {
      respondedRequests.add(requestId);
      networkLog.push({
        event: "response",
        method: requests.get(requestId)?.method,
        status: response.status,
        url: safeUrl(response.url),
      });
    }
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText, corsErrorStatus }) => {
    if (respondedRequests.has(requestId)) return;
    const request = requests.get(requestId);
    if (request && isRelevantUrl(request.url)) {
      networkLog.push({
        event: "failed",
        method: request.method,
        error: errorText,
        cors_error: corsErrorStatus,
        url: safeUrl(request.url),
      });
    }
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type !== "warning" && type !== "error") return;
    consoleLog.push({
      type,
      text: args.map((arg) => arg.value || arg.description || "").join(" "),
    });
  });
  await waitFor(cdp, `document.querySelectorAll(".photo-item .photo-check").length >= 2`);

  const blurUp = await evaluate(cdp, `(async () => {
    const cards = Array.from(document.querySelectorAll(".photo-item")).slice(0, 8);
    const first = cards[0];
    const image = first.querySelector(".photo-image");
    const before = first.getBoundingClientRect();
    if (image?.decode) await image.decode().catch(() => undefined);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = first.getBoundingClientRect();
    const likeBadge = document.querySelector(".photo-like-count");
    const commentBadge = document.querySelector(".photo-comment-count");
    const brand = document.querySelector(".brand");
    const badgeStyle = (badge) => {
      if (!badge) return null;
      const rect = badge.getBoundingClientRect();
      const style = getComputedStyle(badge);
      return {
        width: rect.width,
        height: rect.height,
        padding: style.padding,
        border_radius: style.borderRadius,
        background: style.backgroundColor,
        font_size: style.fontSize,
        gap: style.gap,
      };
    };
    return {
      card_count: cards.length,
      all_have_ratio: cards.every((card) => Boolean(card.style.aspectRatio)),
      all_have_inline_placeholder: cards.every((card) => card.querySelector(".photo-placeholder")?.getAttribute("src")?.startsWith("data:image/webp;base64,")),
      all_real_images_loaded: cards.every((card) => card.querySelector(".photo-image")?.classList.contains("is-loaded")),
      rect_delta: {
        width: Math.abs(before.width - after.width),
        height: Math.abs(before.height - after.height),
        top: Math.abs(before.top - after.top),
      },
      like_badge: badgeStyle(likeBadge),
      comment_badge: badgeStyle(commentBadge),
      brand: {
        font_family: getComputedStyle(brand).fontFamily,
        normal_color: getComputedStyle(brand.querySelector(".brand-normal")).color,
        pics_color: getComputedStyle(brand.querySelector(".brand-pics")).color,
      },
    };
  })()`);

  const commentPreloaded = await evaluate(cdp, `(() => {
    document.querySelector(".photo-item").click();
    const frame = document.querySelector(".lightbox-comments iframe");
    const button = document.querySelector(".lightbox-comment");
    const info = document.querySelector(".lightbox-info");
    const tag = document.querySelector(".lightbox-tags span");
    const anchor = !info.hidden ? info : tag;
    const rect = button.getBoundingClientRect();
    const anchorRect = anchor?.getBoundingClientRect();
    return {
      visible: document.querySelector("#lightbox").classList.contains("visible"),
      iframe_has_src: frame.hasAttribute("src"),
      iframe_sandbox: frame.getAttribute("sandbox"),
      fullscreen_placeholder_count: document.querySelectorAll(".lightbox-slide .lightbox-placeholder").length,
      button_width: rect.width,
      button_height: rect.height,
      button_border: getComputedStyle(button).borderStyle,
      anchor_available: Boolean(anchor),
      anchor_height: anchorRect?.height ?? null,
      anchor_top_delta: anchorRect ? Math.abs(rect.top - anchorRect.top) : null,
      anchor_bottom_delta: anchorRect ? Math.abs(rect.bottom - anchorRect.bottom) : null,
    };
  })()`);
  await waitFor(cdp, `document.querySelector(".lightbox-slide-current img")?.naturalWidth > 0`);
  const desktopNavBefore = await evaluate(cdp, `(() => {
    const current = document.querySelector(".lightbox-slide-current img");
    const next = document.querySelector(".lightbox-next");
    const previous = document.querySelector(".lightbox-prev");
    const close = document.querySelector(".lightbox-close");
    const inspect = (button) => {
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const hitButton = hit?.closest?.("button");
      return {
        x,
        y,
        hit_class: hitButton?.className || "",
        hit_tag: hit?.tagName || "",
        pointer_events: getComputedStyle(button).pointerEvents,
        z_index: getComputedStyle(button).zIndex,
      };
    };
    return {
      image_id: current.dataset.imageId,
      next: inspect(next),
      previous: inspect(previous),
      close: inspect(close),
    };
  })()`);
  await clickPoint(cdp, desktopNavBefore.next.x, desktopNavBefore.next.y);
  await waitFor(cdp, `document.querySelector(".lightbox-slide-current img")?.dataset.imageId !== ${JSON.stringify(desktopNavBefore.image_id)}`);
  const desktopNavAfterNext = await evaluate(cdp, `document.querySelector(".lightbox-slide-current img")?.dataset.imageId`);
  await clickPoint(cdp, desktopNavBefore.previous.x, desktopNavBefore.previous.y);
  await waitFor(cdp, `document.querySelector(".lightbox-slide-current img")?.dataset.imageId === ${JSON.stringify(desktopNavBefore.image_id)}`);
  const desktopNavigation = {
    before: desktopNavBefore,
    after_next: desktopNavAfterNext,
    returned_id: await evaluate(cdp, `document.querySelector(".lightbox-slide-current img")?.dataset.imageId`),
  };
  const commentImmediateOpen = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    const panel = document.querySelector(".lightbox-comments");
    const button = document.querySelector(".lightbox-comment");
    const started = performance.now();
    button.click();
    return {
      elapsed_ms: performance.now() - started,
      panel_open: root.classList.contains("comments-open"),
      aria_hidden: panel.getAttribute("aria-hidden"),
      button_pressed: button.getAttribute("aria-pressed"),
    };
  })()`);
  try {
    await waitFor(cdp, `document.querySelector(".lightbox-comments iframe")?.dataset.ready === "true"`);
  } catch (error) {
    const commentFailure = await evaluate(cdp, `(() => {
      const frame = document.querySelector(".lightbox-comments iframe");
      return {
        frame_src: frame?.src,
        frame_ready: frame?.dataset.ready,
        comments_open: document.querySelector("#lightbox")?.classList.contains("comments-open"),
      };
    })()`);
    throw new Error(`comment iframe did not become ready: ${JSON.stringify({
      state: commentFailure,
      network_log: networkLog,
      console_log: consoleLog,
    })}`, { cause: error });
  }
  await waitFor(cdp, `Boolean(document.querySelector(".lightbox-comments iframe")?.dataset.contextReady)`);
  const commentOpen = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    const frame = document.querySelector(".lightbox-comments iframe");
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://evil.example",
      source: frame.contentWindow,
      data: { type: "comment-ui:close" },
    }));
    return {
      panel_open: root.classList.contains("comments-open"),
      iframe_origin: new URL(frame.src).origin,
      iframe_ready: frame.dataset.ready,
      context_ready: frame.dataset.contextReady,
    };
  })()`);
  const desktopCommentClose = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    const button = document.querySelector(".lightbox-comment");
    const image = document.querySelector(".lightbox-slide-current img");
    const buttonStyle = getComputedStyle(button);
    image.click();
    return {
      lightbox_visible: root.classList.contains("visible"),
      comments_open: root.classList.contains("comments-open"),
      button_opacity_while_open: Number(buttonStyle.opacity),
      button_pointer_events_while_open: buttonStyle.pointerEvents,
    };
  })()`);
  await evaluate(cdp, `document.querySelector(".lightbox-comment").click()`);
  const desktopCommentViewing = await evaluate(cdp, `(async () => {
    const root = document.querySelector("#lightbox");
    const image = document.querySelector(".lightbox-slide-current img");
    const button = document.querySelector(".lightbox-comment");
    const beforeId = image.dataset.imageId;
    document.querySelector(".lightbox-next").click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    const rect = image.getBoundingClientRect();
    return {
      comments_open: root.classList.contains("comments-open"),
      image_unchanged: beforeId === image.dataset.imageId,
      image_center: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      },
      button_opacity: Number(getComputedStyle(button).opacity),
      button_pointer_events: getComputedStyle(button).pointerEvents,
    };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: desktopCommentViewing.image_center.x,
    y: desktopCommentViewing.image_center.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: desktopCommentViewing.image_center.x,
    y: desktopCommentViewing.image_center.y,
    deltaX: 0,
    deltaY: -100,
  });
  await sleep(80);
  Object.assign(desktopCommentViewing, await evaluate(cdp, `(() => ({
    comments_open_after_zoom: document.querySelector("#lightbox").classList.contains("comments-open"),
    zoom_active: document.querySelector("#lightbox").classList.contains("zoom-active"),
    image_transform_before_pan: getComputedStyle(document.querySelector(".lightbox-slide-current img")).transform,
    button_opacity_after_zoom: Number(getComputedStyle(document.querySelector(".lightbox-comment")).opacity),
    button_pointer_events_after_zoom: getComputedStyle(document.querySelector(".lightbox-comment")).pointerEvents,
  }))()`));
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: desktopCommentViewing.image_center.x,
    y: desktopCommentViewing.image_center.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: desktopCommentViewing.image_center.x + 52,
    y: desktopCommentViewing.image_center.y + 34,
    button: "left",
    buttons: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: desktopCommentViewing.image_center.x + 52,
    y: desktopCommentViewing.image_center.y + 34,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(80);
  Object.assign(desktopCommentViewing, await evaluate(cdp, `(() => ({
    comments_open_after_pan: document.querySelector("#lightbox").classList.contains("comments-open"),
    image_transform_after_pan: getComputedStyle(document.querySelector(".lightbox-slide-current img")).transform,
  }))()`));
  await sleep(340);
  const desktopZoomedImageClose = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    document.querySelector(".lightbox-slide-current img").click();
    return {
      lightbox_visible: root.classList.contains("visible"),
      comments_open: root.classList.contains("comments-open"),
    };
  })()`);
  for (let index = 0; index < 12; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: desktopCommentViewing.image_center.x,
      y: desktopCommentViewing.image_center.y,
      deltaX: 0,
      deltaY: 100,
    });
  }
  await sleep(80);
  await evaluate(cdp, `document.querySelector(".lightbox-comment").click()`);
  const desktopCommentButtonClose = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    document.querySelector(".lightbox-comment").click();
    return {
      lightbox_visible: root.classList.contains("visible"),
      comments_open: root.classList.contains("comments-open"),
    };
  })()`);
  await evaluate(cdp, `document.querySelector(".lightbox-comment").click()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(320);
  const mobileComments = await evaluate(cdp, `(() => {
    const panel = document.querySelector(".lightbox-comments");
    const rect = panel.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      bottom_delta: Math.abs(window.innerHeight - rect.bottom),
      border_top_style: getComputedStyle(panel).borderTopStyle,
      border_top_left_radius: getComputedStyle(panel).borderTopLeftRadius,
      clip_path: getComputedStyle(panel).clipPath,
      overflow: getComputedStyle(panel).overflowX + "/" + getComputedStyle(panel).overflowY,
      box_shadow: getComputedStyle(panel).boxShadow,
      iframe_clip_path: getComputedStyle(panel.querySelector("iframe")).clipPath,
      iframe_border_top_left_radius: getComputedStyle(panel.querySelector("iframe")).borderTopLeftRadius,
      background_color: getComputedStyle(panel).backgroundColor,
    };
  })()`);
  await clickPoint(cdp, 195, 100);
  await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("comments-open")`);
  const mobileBackdropClose = await evaluate(cdp, `(() => ({
    lightbox_visible: document.querySelector("#lightbox").classList.contains("visible"),
    comments_open: document.querySelector("#lightbox").classList.contains("comments-open"),
  }))()`);
  await evaluate(cdp, `document.querySelector(".lightbox-comment").click()`);
  await waitFor(cdp, `document.querySelector("#lightbox").classList.contains("comments-open")`);
  await sleep(300);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 650 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 690 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 750 }],
  });
  await sleep(60);
  const mobilePullDragging = await evaluate(cdp, `(() => {
    const panel = document.querySelector(".lightbox-comments");
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      dragging: document.querySelector("#lightbox").classList.contains("comment-panel-dragging"),
      parent_has_pull_variable: getComputedStyle(document.querySelector("#lightbox")).getPropertyValue("--comment-panel-pull-y") !== "",
      panel_top: rect.top,
      border_top_style: style.borderTopStyle,
      border_top_left_radius: style.borderTopLeftRadius,
      clip_path: style.clipPath,
      overflow: style.overflowX + "/" + style.overflowY,
      box_shadow: style.boxShadow,
      background_color: style.backgroundColor,
      transform: style.transform,
    };
  })()`);
  if (process.env.NORMALPICS_DRAG_SCREENSHOT) {
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(process.env.NORMALPICS_DRAG_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 830 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const mobilePullCloseTrace = await evaluate(cdp, `(async () => {
    const root = document.querySelector("#lightbox");
    const panel = document.querySelector(".lightbox-comments");
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < 340) {
      const rect = panel.getBoundingClientRect();
      samples.push({
        t: Math.round(performance.now() - started),
        top: Number(rect.top.toFixed(3)),
        open: root.classList.contains("comments-open"),
        transform: getComputedStyle(panel).transform,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return {
      viewport_height: window.innerHeight,
      samples,
    };
  })()`);
  try {
    await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("comments-open")`);
  } catch (error) {
    const dragFailure = await evaluate(cdp, `(() => {
      const root = document.querySelector("#lightbox");
      const panel = document.querySelector(".lightbox-comments");
      return {
        comments_open: root.classList.contains("comments-open"),
        dragging: root.classList.contains("comment-panel-dragging"),
        panel_transform: getComputedStyle(panel).transform,
        inline_transform: panel.style.transform,
        inline_transition: panel.style.transition,
        animation_count: panel.getAnimations().length,
        panel_top: panel.getBoundingClientRect().top,
      };
    })()`);
    throw new Error(`mobile comment panel did not close after pull: ${JSON.stringify(dragFailure)}`, { cause: error });
  }
  const mobilePullClose = await evaluate(cdp, `(() => ({
    lightbox_visible: document.querySelector("#lightbox").classList.contains("visible"),
    comments_open: document.querySelector("#lightbox").classList.contains("comments-open"),
  }))()`);
  await evaluate(cdp, `document.querySelector(".lightbox-comment").click()`);
  await waitFor(cdp, `document.querySelector("#lightbox").classList.contains("comments-open")`);
  await sleep(300);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 650 }],
  });
  const slowPullSamples = [];
  for (let y = 660; y <= 730; y += 10) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 195, y }],
    });
    await sleep(50);
    slowPullSamples.push(await evaluate(cdp, `document.querySelector(".lightbox-comments").getBoundingClientRect().top`));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const mobileSlowPullReturnTrace = await evaluate(cdp, `(async () => {
    const panel = document.querySelector(".lightbox-comments");
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < 320) {
      const rect = panel.getBoundingClientRect();
      samples.push({
        t: Math.round(performance.now() - started),
        top: Number(rect.top.toFixed(3)),
        transform: getComputedStyle(panel).transform,
        animations: panel.getAnimations().length,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return samples;
  })()`);
  const mobileSlowPull = await evaluate(cdp, `(() => ({
    lightbox_visible: document.querySelector("#lightbox").classList.contains("visible"),
    comments_open: document.querySelector("#lightbox").classList.contains("comments-open"),
    settled_top: document.querySelector(".lightbox-comments").getBoundingClientRect().top,
    animation_count: document.querySelector(".lightbox-comments").getAnimations().length,
  }))()`);
  mobileSlowPull.samples = slowPullSamples;
  mobileSlowPull.return_trace = mobileSlowPullReturnTrace;
  await clickPoint(cdp, 195, 100);
  await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("comments-open")`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 195, y: 430 }],
    });
    await sleep(24);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 195, y: 405 }],
    });
    await sleep(24);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 195, y: 370 }],
    });
    await sleep(24);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(240);
  }
  const mobileVerticalReturn = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    const slide = document.querySelector(".lightbox-slide-current");
    const transform = getComputedStyle(slide).transform;
    return {
      lightbox_visible: root.classList.contains("visible"),
      transform,
      returning: slide.getAnimations().length,
    };
  })()`);
  await evaluate(cdp, `(() => {
    window.__normalPicsSwipeSamples = [];
    window.__normalPicsSwipeSrcMutations = 0;
    const root = document.querySelector("#lightbox");
    window.__normalPicsSwipeObserver = new MutationObserver((records) => {
      if (root.classList.contains("swiping")) {
        window.__normalPicsSwipeSrcMutations += records.filter((record) => record.attributeName === "src").length;
      }
    });
    window.__normalPicsSwipeObserver.observe(document.querySelector(".lightbox-track"), {
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    const started = performance.now();
    const sample = () => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const slide = Array.from(document.querySelectorAll(".lightbox-slide")).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.left <= cx && rect.right >= cx && rect.top <= cy && rect.bottom >= cy;
      });
      const img = slide?.querySelector("img") || null;
      window.__normalPicsSwipeSamples.push({
        t: Math.round(performance.now() - started),
        slide_class: slide?.className || "",
        image_id: img?.dataset.imageId || "",
        opacity: img ? Number(getComputedStyle(img).opacity) : 0,
        natural_width: img?.naturalWidth || 0,
        src_present: Boolean(img?.currentSrc || img?.src),
        src: img?.currentSrc || img?.src || "",
        swiping: document.querySelector("#lightbox").classList.contains("swiping"),
        switching: document.querySelector("#lightbox").classList.contains("switching"),
        transition_duration: img ? getComputedStyle(img).transitionDuration : "",
      });
      if (performance.now() - started < 1700) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 320, y: 430 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 230, y: 430 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 120, y: 430 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(480);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 70, y: 430 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 170, y: 430 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 300, y: 430 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(940);
  const mobileSwipeFlash = await evaluate(cdp, `(() => {
    const samples = window.__normalPicsSwipeSamples || [];
    delete window.__normalPicsSwipeSamples;
    const visible = samples.filter((sample) => sample.t >= 40 && sample.t <= 1500);
    const gaps = samples.slice(1).map((sample, index) => sample.t - samples[index].t).sort((a, b) => a - b);
    window.__normalPicsSwipeObserver?.disconnect();
    return {
      sample_count: samples.length,
      blank_samples: visible.filter((sample) => !sample.src_present || sample.natural_width <= 0 || sample.opacity < 0.98).length,
      min_opacity: visible.reduce((min, sample) => Math.min(min, sample.opacity), 1),
      missing_image_samples: visible.filter((sample) => !sample.src_present || sample.natural_width <= 0).length,
      source_changes_while_dragging: window.__normalPicsSwipeSrcMutations || 0,
      moving_transitions_disabled: samples.filter((sample) => sample.swiping || sample.switching)
        .every((sample) => sample.transition_duration.split(",").every((duration) => Number.parseFloat(duration) === 0)),
      max_frame_gap_ms: gaps.at(-1) || 0,
      p95_frame_gap_ms: gaps[Math.floor(gaps.length * 0.95)] || 0,
      first_samples: samples.slice(0, 6),
      last_samples: samples.slice(-6),
    };
  })()`);
  await evaluate(cdp, `(() => {
    delete window.__normalPicsSwipeObserver;
    delete window.__normalPicsSwipeSrcMutations;
  })()`);
  await sleep(220);
  const mobileAlignment = await evaluate(cdp, `(() => {
    const buttonRect = document.querySelector(".lightbox-comment").getBoundingClientRect();
    const info = document.querySelector(".lightbox-info");
    const tag = document.querySelector(".lightbox-tags span");
    const anchor = !info.hidden ? info : tag;
    const anchorRect = anchor?.getBoundingClientRect();
    const metaRect = document.querySelector(".lightbox-meta").getBoundingClientRect();
    return {
      available: Boolean(anchor),
      center_delta: anchorRect
        ? Math.abs((buttonRect.top + buttonRect.height / 2) - (anchorRect.top + anchorRect.height / 2))
        : null,
      controls_gap: metaRect.left - buttonRect.right,
    };
  })()`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(120);
  const infoMutual = await evaluate(cdp, `(async () => {
    const info = document.querySelector(".lightbox-info");
    if (info.hidden) return { available: false };
    info.click();
    await new Promise((resolve) => setTimeout(resolve, 220));
    const commentStyle = getComputedStyle(document.querySelector(".lightbox-comment"));
    const result = {
      available: true,
      info_visible: document.querySelector("#lightbox").classList.contains("lightbox-info-visible"),
      comment_opacity: Number(commentStyle.opacity),
      comment_pointer_events: commentStyle.pointerEvents,
    };
    info.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const buttonRect = document.querySelector(".lightbox-comment").getBoundingClientRect();
    const infoRect = info.getBoundingClientRect();
    result.returned_info_visible = document.querySelector("#lightbox").classList.contains("lightbox-info-visible");
    result.returned_comment_opacity = Number(getComputedStyle(document.querySelector(".lightbox-comment")).opacity);
    result.returned_center_delta = Math.abs(
      (buttonRect.top + buttonRect.height / 2) - (infoRect.top + infoRect.height / 2)
    );
    result.returned_geometry = {
      button_top: buttonRect.top,
      button_bottom: buttonRect.bottom,
      button_transform: getComputedStyle(document.querySelector(".lightbox-comment")).transform,
      info_top: infoRect.top,
      info_bottom: infoRect.bottom,
      tag_row_top: document.querySelector(".lightbox-tag-row").getBoundingClientRect().top,
      tag_row_bottom: document.querySelector(".lightbox-tag-row").getBoundingClientRect().bottom,
      comment_bottom_var: getComputedStyle(document.querySelector("#lightbox")).getPropertyValue("--lightbox-comment-bottom"),
    };
    return result;
  })()`);
  await evaluate(cdp, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("visible") && !document.querySelector("#gallery").classList.contains("lightbox-grid-locked")`);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const heroOrigin = await evaluate(cdp, `(() => {
    const image = document.querySelector(".photo-item .photo-image");
    const shell = image.closest(".photo-item");
    const placeholder = shell.querySelector(".photo-placeholder");
    const rect = image.getBoundingClientRect();
    const shellRadius = getComputedStyle(shell).borderRadius;
    image.click();
    const clone = document.querySelector(".lightbox-hero-image");
    const cloneRect = clone?.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      inline_visibility_after_open: image.style.visibility,
      computed_visibility_after_open: getComputedStyle(image).visibility,
      shell_inline_visibility_after_open: shell.style.visibility,
      shell_computed_visibility_after_open: getComputedStyle(shell).visibility,
      placeholder_visibility_after_open: placeholder ? getComputedStyle(placeholder).visibility : null,
      shell_radius: shellRadius,
      clone_initial_rect: cloneRect ? {
        left: cloneRect.left,
        top: cloneRect.top,
        width: cloneRect.width,
        height: cloneRect.height,
      } : null,
      clone_initial_transform: clone ? getComputedStyle(clone).transform : null,
      clone_initial_radius: clone ? getComputedStyle(clone).borderRadius : null,
    };
  })()`);
  await sleep(60);
  const heroEntry = await evaluate(cdp, `(() => {
    const root = document.querySelector("#lightbox");
    const clone = document.querySelector(".lightbox-hero-image");
    return {
      visible: root.classList.contains("visible"),
      opening: root.classList.contains("hero-opening"),
      clone_present: Boolean(clone),
      clone_transform: clone ? getComputedStyle(clone).transform : "none",
      clone_radius: clone ? getComputedStyle(clone).borderRadius : "",
      clone_alt: clone?.getAttribute("alt"),
      clone_title: clone?.getAttribute("title"),
      origin_visibility: getComputedStyle(document.querySelector(".photo-item .photo-image")).visibility,
      origin_shell_visibility: getComputedStyle(document.querySelector(".photo-item")).visibility,
      origin_placeholder_visibility: getComputedStyle(document.querySelector(".photo-item .photo-placeholder")).visibility,
      grid_locked: document.querySelector("#gallery").classList.contains("lightbox-grid-locked"),
      scrim_opacity: Number(getComputedStyle(document.querySelector(".lightbox-scrim")).opacity),
    };
  })()`);
  await sleep(430);
  const heroOpenStability = await evaluate(cdp, `(async () => {
    const samples = [];
    const sample = () => {
      const img = document.querySelector(".lightbox-slide-current img");
      const rect = img.getBoundingClientRect();
      const style = getComputedStyle(img);
      const expectedWidth = Number.parseFloat(img.style.width || style.width);
      const expectedHeight = Number.parseFloat(img.style.height || style.height);
      samples.push({
        t: Math.round(performance.now()),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        center_x: rect.left + rect.width / 2,
        center_y: rect.top + rect.height / 2,
        expected_width: expectedWidth,
        expected_height: expectedHeight,
        expected_left: (window.innerWidth - expectedWidth) / 2,
        expected_top: (window.innerHeight - expectedHeight) / 2,
        src: img.currentSrc || img.src || "",
        opacity: Number(style.opacity),
      });
    };
    sample();
    const started = performance.now();
    while (performance.now() - started < 620) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      sample();
    }
    const first = samples[0];
    const maxDelta = (field) => Math.max(...samples.map((sample) => Math.abs(sample[field] - first[field])));
    const maxExpectedDelta = Math.max(...samples.map((sample) => Math.abs(sample.left - sample.expected_left) + Math.abs(sample.top - sample.expected_top)));
    return {
      sample_count: samples.length,
      inline_width: Number.parseFloat(document.querySelector(".lightbox-slide-current img").style.width || "0"),
      inline_height: Number.parseFloat(document.querySelector(".lightbox-slide-current img").style.height || "0"),
      max_top_delta: maxDelta("top"),
      max_left_delta: maxDelta("left"),
      max_width_delta: maxDelta("width"),
      max_height_delta: maxDelta("height"),
      max_expected_position_delta: maxExpectedDelta,
      min_opacity: Math.min(...samples.map((sample) => sample.opacity)),
      distinct_sources: new Set(samples.map((sample) => sample.src)).size,
      first,
      last: samples.at(-1),
    };
  })()`);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 430 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 215, y: 500 }],
  });
  await sleep(40);
  const heroDrag = await evaluate(cdp, `(() => {
    const motion = document.querySelector(".lightbox-slide-current");
    const stageMotion = document.querySelector(".lightbox-stage-motion");
    const previous = document.querySelector(".lightbox-slide-prev");
    const next = document.querySelector(".lightbox-slide-next");
    const scrim = document.querySelector(".lightbox-scrim");
    const matrix = new DOMMatrixReadOnly(getComputedStyle(motion).transform);
    return {
      transform: getComputedStyle(motion).transform,
      stage_transform: getComputedStyle(stageMotion).transform,
      previous_transform: getComputedStyle(previous).transform,
      next_transform: getComputedStyle(next).transform,
      scale: matrix.a,
      translate_x: matrix.e,
      translate_y: matrix.f,
      scrim_opacity: Number(getComputedStyle(scrim).opacity),
    };
  })()`);
  await sleep(170);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 215, y: 501 }],
  });
  await sleep(20);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(260);
  const heroReturn = await evaluate(cdp, `(() => ({
    visible: document.querySelector("#lightbox").classList.contains("visible"),
    transform: getComputedStyle(document.querySelector(".lightbox-slide-current")).transform,
    scrim_opacity: Number(getComputedStyle(document.querySelector(".lightbox-scrim")).opacity),
    animation_count: document.querySelector(".lightbox-slide-current").getAnimations().length,
  }))()`);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 430 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 500 }],
  });
  await sleep(140);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 560 }],
  });
  await sleep(160);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(230);
  const heroNearThreshold = await evaluate(cdp, `(() => ({
    visible: document.querySelector("#lightbox").classList.contains("visible"),
    closing: document.querySelector("#lightbox").classList.contains("hero-closing"),
    transform: getComputedStyle(document.querySelector(".lightbox-slide-current")).transform,
    scrim_opacity: Number(getComputedStyle(document.querySelector(".lightbox-scrim")).opacity),
    animation_count: document.querySelector(".lightbox-slide-current").getAnimations().length,
  }))()`);
  await evaluate(cdp, `(() => {
    window.__heroExitTrace = [];
    window.__heroExitFrames = [];
    const root = document.querySelector("#lightbox");
    const scrim = document.querySelector(".lightbox-scrim");
    const started = performance.now();
    const record = (type, extra = {}) => window.__heroExitTrace.push({
      type,
      t: Math.round(performance.now() - started),
      root_classes: root.className,
      body_locked: document.body.classList.contains("lightbox-open"),
      grid_locked: document.querySelector("#gallery").classList.contains("lightbox-grid-locked"),
      ...extra,
    });
    window.__heroExitObserver = new MutationObserver(() => record("mutation"));
    window.__heroExitObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
    window.__heroExitClick = (event) => record("click", {
      client_x: event.clientX,
      client_y: event.clientY,
      target: event.target?.className || event.target?.id || event.target?.tagName,
      trusted: event.isTrusted,
    });
    document.addEventListener("click", window.__heroExitClick, true);
    const sampleFrame = () => {
      window.__heroExitFrames.push({
        t: Math.round(performance.now() - started),
        visible: root.classList.contains("visible"),
        closing: root.classList.contains("hero-closing"),
        root_opacity: Number(getComputedStyle(root).opacity),
        scrim_opacity: Number(getComputedStyle(scrim).opacity),
        clone_present: Boolean(document.querySelector(".lightbox-hero-image")),
        source_shell_visibility: getComputedStyle(document.querySelector(".photo-item")).visibility,
      });
      if (performance.now() - started < 720) requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
    record("start");
  })()`);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 430 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 520 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 650 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(50);
  const heroClose = await evaluate(cdp, `(() => ({
    closing: document.querySelector("#lightbox").classList.contains("hero-closing"),
    clone_present: Boolean(document.querySelector(".lightbox-hero-image")),
    clone_alt: document.querySelector(".lightbox-hero-image")?.getAttribute("alt"),
    clone_title: document.querySelector(".lightbox-hero-image")?.getAttribute("title"),
    clone_border_radius: getComputedStyle(document.querySelector(".lightbox-hero-image")).borderRadius,
    target_border_radius: getComputedStyle(document.querySelector(".photo-item")).borderRadius,
    slide_images_have_empty_alt: Array.from(document.querySelectorAll(".lightbox-slide img"))
      .every((image) => image.getAttribute("alt") === "" && image.getAttribute("title") === ""),
    scrim_opacity: Number(getComputedStyle(document.querySelector(".lightbox-scrim")).opacity),
    overlay_pointer_events: getComputedStyle(document.querySelector("#lightbox")).pointerEvents,
    overlay_touch_action: getComputedStyle(document.querySelector("#lightbox")).touchAction,
    stage_touch_action: getComputedStyle(document.querySelector(".lightbox-stage")).touchAction,
    body_locked: document.body.classList.contains("lightbox-open"),
    body_overflow: getComputedStyle(document.body).overflow,
    grid_locked: document.querySelector("#gallery").classList.contains("lightbox-grid-locked"),
    origin_visibility: getComputedStyle(document.querySelector(".photo-item .photo-image")).visibility,
    origin_shell_visibility: getComputedStyle(document.querySelector(".photo-item")).visibility,
    scroll_before: window.scrollY,
  }))()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 195,
    y: 430,
    deltaX: 0,
    deltaY: 180,
  });
  await sleep(80);
  heroClose.scroll_after = await evaluate(cdp, `window.scrollY`);
  try {
    await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("visible") && !document.querySelector("#gallery").classList.contains("lightbox-grid-locked")`);
  } catch (error) {
    const stuckExit = await evaluate(cdp, `(() => ({
      root_classes: document.querySelector("#lightbox").className,
      clone_present: Boolean(document.querySelector(".lightbox-hero-image")),
      clone_animations: Array.from(document.querySelector(".lightbox-hero-image")?.getAnimations() || []).map((animation) => ({
        play_state: animation.playState,
        current_time: animation.currentTime,
        playback_rate: animation.playbackRate,
      })),
      scrim_animations: Array.from(document.querySelector(".lightbox-scrim").getAnimations()).map((animation) => ({
        play_state: animation.playState,
        current_time: animation.currentTime,
        playback_rate: animation.playbackRate,
      })),
      body_locked: document.body.classList.contains("lightbox-open"),
      pointer_events: getComputedStyle(document.querySelector("#lightbox")).pointerEvents,
      trace: window.__heroExitTrace,
    }))()`);
    throw new Error(`hero exit did not settle: ${JSON.stringify(stuckExit)}`, { cause: error });
  }
  await sleep(80);
  const heroCleanup = await evaluate(cdp, `(() => {
    const frames = window.__heroExitFrames || [];
    return {
      clone_present: Boolean(document.querySelector(".lightbox-hero-image")),
      opening: document.querySelector("#lightbox").classList.contains("hero-opening"),
      closing: document.querySelector("#lightbox").classList.contains("hero-closing"),
      origin_visibility: getComputedStyle(document.querySelector(".photo-item .photo-image")).visibility,
      origin_inline_visibility: document.querySelector(".photo-item .photo-image").style.visibility,
      origin_shell_visibility: getComputedStyle(document.querySelector(".photo-item")).visibility,
      origin_shell_inline_visibility: document.querySelector(".photo-item").style.visibility,
      grid_locked: document.querySelector("#gallery").classList.contains("lightbox-grid-locked"),
      hidden_overlay_black_frames: frames.filter((frame) => !frame.visible && frame.root_opacity > 0.02 && frame.scrim_opacity > 0.8).length,
      handoff_frames: frames.filter((frame) => frame.visible && frame.clone_present && frame.source_shell_visibility === "visible" && frame.scrim_opacity < 0.05).length,
      exposed_source_without_clone_frames: frames.filter((frame) => frame.visible && !frame.clone_present && frame.source_shell_visibility === "visible").length,
      exit_frames: frames.slice(-8),
    };
  })()`);
  await evaluate(cdp, `(() => {
    window.__heroExitObserver?.disconnect();
    if (window.__heroExitClick) document.removeEventListener("click", window.__heroExitClick, true);
    delete window.__heroExitObserver;
    delete window.__heroExitClick;
    delete window.__heroExitTrace;
    delete window.__heroExitFrames;
  })()`);
  const heroCancelStart = await evaluate(cdp, `(() => {
    const image = document.querySelector(".photo-item .photo-image");
    image.click();
    return {
      origin_visibility: getComputedStyle(image).visibility,
      origin_shell_visibility: getComputedStyle(image.closest(".photo-item")).visibility,
    };
  })()`);
  await sleep(430);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 430 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 520 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: 650 }],
  });
  await sleep(24);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(35);
  const heroCancel = await evaluate(cdp, `(async () => {
    const clone = document.querySelector(".lightbox-hero-image");
    const animation = clone?.getAnimations()[0];
    animation?.cancel();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const image = document.querySelector(".photo-item .photo-image");
    const shell = image.closest(".photo-item");
    return {
      animation_was_present: Boolean(animation),
      origin_visibility_after_cancel: getComputedStyle(image).visibility,
      origin_inline_visibility_after_cancel: image.style.visibility,
      origin_shell_visibility_after_cancel: getComputedStyle(shell).visibility,
      origin_shell_inline_visibility_after_cancel: shell.style.visibility,
    };
  })()`);
  await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("visible") && !document.querySelector("#gallery").classList.contains("lightbox-grid-locked")`);
  await evaluate(cdp, `document.querySelector(".photo-item .photo-image").click()`);
  await waitFor(cdp, `document.querySelector("#lightbox").classList.contains("visible")`);
  await sleep(460);
  const mobilePinchRelease = await evaluate(cdp, `(async () => {
    const root = document.querySelector("#lightbox");
    const img = document.querySelector(".lightbox-slide-current img");
    const originalSetPointerCapture = root.setPointerCapture;
    const originalReleasePointerCapture = root.releasePointerCapture;
    root.setPointerCapture = () => {};
    root.releasePointerCapture = () => {};
    const dispatch = (type, id, x, y) => {
      root.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: "touch",
        isPrimary: id === 1,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      }));
    };
    const matrix = () => {
      const transform = getComputedStyle(img).transform;
      const parsed = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
      return {
        transform,
        scale: parsed.a,
        x: parsed.e,
        y: parsed.f,
      };
    };
    dispatch("pointerdown", 1, 170, 420);
    dispatch("pointerdown", 2, 220, 420);
    dispatch("pointermove", 1, 135, 420);
    dispatch("pointermove", 2, 255, 420);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before_release = matrix();
    dispatch("pointerup", 2, 255, 420);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const after_release = matrix();
    dispatch("pointermove", 1, 135, 420);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const after_stationary_move = matrix();
    dispatch("pointermove", 1, 139, 423);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const after_small_pan = matrix();
    dispatch("pointerup", 1, 139, 423);
    root.setPointerCapture = originalSetPointerCapture;
    root.releasePointerCapture = originalReleasePointerCapture;
    return {
      before_release,
      after_release,
      after_stationary_move,
      after_small_pan,
      zoom_active: root.classList.contains("zoom-active"),
    };
  })()`);
  await evaluate(cdp, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await waitFor(cdp, `!document.querySelector("#lightbox").classList.contains("visible") && !document.querySelector("#gallery").classList.contains("lightbox-grid-locked")`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  const firstStatus = await evaluate(cdp, `document.querySelector(".photo-item")?.dataset.status || null`);
  await evaluate(cdp, `document.querySelector(".photo-item .photo-check").click()`);
  await sleep(280);

  const single = await evaluate(cdp, `(() => {
    const slot = document.querySelector(".selection-print-slot");
    const button = document.querySelector(".selection-print-btn");
    const bar = document.querySelector("#selection-bar");
    const actions = Array.from(document.querySelectorAll("#selection-bar .selection-action-btn"));
    const slotRect = slot.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      count: document.querySelector(".selection-count")?.textContent,
      slot_collapsed: slot.classList.contains("is-collapsed"),
      button_disabled: button.disabled,
      button_aria_hidden: button.getAttribute("aria-hidden"),
      button_width: buttonRect.width,
      button_height: buttonRect.height,
      bar_height: barRect.height,
      top_delta: Math.abs(buttonRect.top - barRect.top),
      bottom_delta: Math.abs(buttonRect.bottom - barRect.bottom),
      gap_to_bar: barRect.left - buttonRect.right,
      border_radius: style.borderRadius,
      background: style.backgroundColor,
      transition_duration: style.transitionDuration,
      transition_timing: style.transitionTimingFunction,
      action_count: actions.length,
      action_titles: actions.map((action) => action.getAttribute("aria-label")),
      action_disabled: actions.map((action) => action.disabled),
    };
  })()`);

  await evaluate(cdp, `document.querySelector(".selection-print-btn").click()`);
  await sleep(80);
  const pickerVisible = await evaluate(
    cdp,
    `document.querySelector("#print-picker").classList.contains("visible")`,
  );
  await evaluate(cdp, `document.querySelector("#print-picker").click()`);
  const singleDownload = await evaluate(cdp, `(() => {
    const links = [];
    let pickerCalled = false;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const originalDirectoryPicker = window.showDirectoryPicker;
    HTMLAnchorElement.prototype.click = function () {
      links.push(this.href);
    };
    window.showDirectoryPicker = async () => {
      pickerCalled = true;
      throw new DOMException("cancelled", "AbortError");
    };
    document.querySelector('.selection-action-btn[aria-label="Download"]').click();
    HTMLAnchorElement.prototype.click = originalAnchorClick;
    window.showDirectoryPicker = originalDirectoryPicker;
    return { links, picker_called: pickerCalled };
  })()`);

  await evaluate(cdp, `document.querySelectorAll(".photo-item .photo-check")[1].click()`);
  await sleep(280);
  const multiple = await evaluate(cdp, `(() => {
    const slot = document.querySelector(".selection-print-slot");
    const button = document.querySelector(".selection-print-btn");
    return {
      count: document.querySelector(".selection-count")?.textContent,
      slot_collapsed: slot.classList.contains("is-collapsed"),
      button_disabled: button.disabled,
      button_aria_hidden: button.getAttribute("aria-hidden"),
      action_count: document.querySelectorAll("#selection-bar .selection-action-btn").length,
    };
  })()`);

  const animation = await evaluate(cdp, `(async () => {
    const checks = document.querySelectorAll(".photo-item .photo-check");
    const slot = document.querySelector(".selection-print-slot");
    const button = document.querySelector(".selection-print-btn");
    const samples = [];
    checks[1].click();
    const started = performance.now();
    while (performance.now() - started < 320) {
      samples.push({
        elapsed_ms: Math.round(performance.now() - started),
        width: Number(slot.getBoundingClientRect().width.toFixed(2)),
        opacity: Number(getComputedStyle(button).opacity),
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return samples;
  })()`);
  await evaluate(cdp, `(async () => {
    const checks = document.querySelectorAll(".photo-item .photo-check");
    checks[1].click();
    await new Promise((resolve) => setTimeout(resolve, 120));

    window.__normalPicsOriginalDirectoryPicker = window.showDirectoryPicker;
    window.showDirectoryPicker = undefined;
    window.__normalPicsDownloadLinks = [];
    window.__normalPicsOriginalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.__normalPicsDownloadLinks.push({
        href: this.href,
        download: this.download,
        clicked_at: performance.now(),
        user_activation: navigator.userActivation?.isActive ?? null,
      });
    };
  })()`);
  await clickElement(cdp, '.selection-action-btn[aria-label="Download"]');
  await sleep(120);
  const individualLinks = await evaluate(cdp, `(() => {
    HTMLAnchorElement.prototype.click = window.__normalPicsOriginalAnchorClick;
    const links = window.__normalPicsDownloadLinks;
    delete window.__normalPicsDownloadLinks;
    delete window.__normalPicsOriginalAnchorClick;
    window.showDirectoryPicker = window.__normalPicsOriginalDirectoryPicker;
    delete window.__normalPicsOriginalDirectoryPicker;
    return links;
  })()`);
  await evaluate(cdp, `(() => {
    window.__normalPicsOriginalDirectoryPicker = window.showDirectoryPicker;
    window.__normalPicsSavedFiles = [];
    window.__normalPicsPickerActivations = [];
    window.showDirectoryPicker = async () => {
      window.__normalPicsPickerActivations.push(navigator.userActivation?.isActive ?? null);
      return {
        getFileHandle: async (name) => ({
          createWritable: async () => {
            let bytes = 0;
            return new WritableStream({
              write(chunk) {
                bytes += chunk?.byteLength || chunk?.size || 0;
              },
              close() {
                window.__normalPicsSavedFiles.push({ name, bytes });
              },
            });
          },
        }),
      };
    };
  })()`);
  await clickElement(cdp, '.selection-action-btn[aria-label="Download"]');
  await waitFor(cdp, `window.__normalPicsSavedFiles?.length >= 2`, 100);
  const streamedIndividualDownloads = await evaluate(cdp, `(() => {
    const result = {
      files: window.__normalPicsSavedFiles,
      picker_activations: window.__normalPicsPickerActivations,
    };
    window.showDirectoryPicker = window.__normalPicsOriginalDirectoryPicker;
    delete window.__normalPicsOriginalDirectoryPicker;
    delete window.__normalPicsSavedFiles;
    delete window.__normalPicsPickerActivations;
    return result;
  })()`);
  const downloadModes = await evaluate(cdp, `(async () => {
    const download = document.querySelector('.selection-action-btn[aria-label="Download"]');
    document.querySelector(".select-all-btn").click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    let zip = null;
    const originalFormSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      zip = {
        method: this.method,
        action: this.action,
        image_ids: JSON.parse(this.querySelector('input[name="imageIds"]').value),
      };
    };
    download.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    HTMLFormElement.prototype.submit = originalFormSubmit;
    return {
      zip,
      full_selection_count: document.querySelectorAll(".photo-item.selected").length,
    };
  })()`);
  downloadModes.individual_links = individualLinks;
  downloadModes.streamed_individual_downloads = streamedIndividualDownloads;

  assert(firstStatus === "pending" || firstStatus === "synced", `unexpected first image status: ${firstStatus}`);
  assert(blurUp.card_count >= 2 && blurUp.all_have_ratio, "gallery cards did not have stable aspect ratios");
  assert(blurUp.all_have_inline_placeholder, "gallery placeholders were not inline WebP data URLs");
  assert(blurUp.rect_delta.width < 0.5 && blurUp.rect_delta.height < 0.5 && blurUp.rect_delta.top < 0.5, "blur-up caused a layout shift");
  assert(blurUp.brand.font_family.includes("Bungee"), `brand did not use Bungee: ${JSON.stringify(blurUp.brand)}`);
  assert(blurUp.brand.normal_color === "rgb(26, 26, 26)" && blurUp.brand.pics_color === "rgb(46, 100, 80)", `brand colors were incorrect: ${JSON.stringify(blurUp.brand)}`);
  assert(blurUp.like_badge && blurUp.comment_badge, "gallery did not render both engagement badge types");
  assert(
    Math.abs(blurUp.like_badge.width - blurUp.comment_badge.width) < 0.5
    && Math.abs(blurUp.like_badge.height - blurUp.comment_badge.height) < 0.5
    && blurUp.like_badge.padding === blurUp.comment_badge.padding
    && blurUp.like_badge.border_radius === blurUp.comment_badge.border_radius
    && blurUp.like_badge.background === blurUp.comment_badge.background
    && blurUp.like_badge.font_size === blurUp.comment_badge.font_size
    && blurUp.like_badge.gap === blurUp.comment_badge.gap,
    `comment count badge did not match the heart count badge: ${JSON.stringify({
      like: blurUp.like_badge,
      comment: blurUp.comment_badge,
    })}`
  );
  assert(commentPreloaded.visible && commentPreloaded.iframe_has_src, "comment iframe was not preloaded when fullscreen opened");
  assert(
    desktopNavigation.before.next.hit_class.includes("lightbox-next")
    && desktopNavigation.before.previous.hit_class.includes("lightbox-prev")
    && desktopNavigation.before.close.hit_class.includes("lightbox-close")
    && desktopNavigation.before.next.pointer_events !== "none"
    && desktopNavigation.after_next !== desktopNavigation.before.image_id
    && desktopNavigation.returned_id === desktopNavigation.before.image_id,
    `desktop lightbox navigation controls were covered or did not navigate: ${JSON.stringify(desktopNavigation)}`
  );
  assert(commentPreloaded.iframe_sandbox.includes("allow-popups") && commentPreloaded.iframe_sandbox.includes("allow-popups-to-escape-sandbox"), "comment iframe blocked the Sodesu source link");
  assert(commentPreloaded.fullscreen_placeholder_count === 0, "fullscreen still rendered a blur-up placeholder");
  assert(Math.abs(commentPreloaded.button_width - 28) < 0.5 && Math.abs(commentPreloaded.button_height - 28) < 0.5, "comment button did not match the 28px tag/info control size");
  assert(commentPreloaded.button_border === "none", "comment button unexpectedly had a border");
  assert(!commentPreloaded.anchor_available || (
    Math.abs(commentPreloaded.anchor_height - 28) < 0.5
    && commentPreloaded.anchor_top_delta < 0.5
    && commentPreloaded.anchor_bottom_delta < 0.5
  ), "comment button was not vertically aligned with tags/info");
  assert(commentImmediateOpen.panel_open && commentImmediateOpen.aria_hidden === "false" && commentImmediateOpen.button_pressed === "true", "comment panel did not open synchronously");
  assert(commentImmediateOpen.elapsed_ms < 20, "comment panel open state was delayed");
  assert(commentOpen.panel_open, "an untrusted postMessage closed the comment panel");
  assert(commentOpen.iframe_origin === "https://comments.pics.example.com", "comment iframe used the wrong origin");
  assert(commentOpen.iframe_ready === "true" && Boolean(commentOpen.context_ready), "comment iframe did not complete its API-backed context load");
  assert(desktopCommentClose.lightbox_visible && !desktopCommentClose.comments_open, "clicking the image with comments open exited fullscreen instead of closing comments");
  assert(desktopCommentClose.button_opacity_while_open === 1 && desktopCommentClose.button_pointer_events !== "none", "desktop comment button disappeared while comments were open");
  assert(desktopCommentViewing.comments_open && desktopCommentViewing.comments_open_after_zoom && desktopCommentViewing.image_unchanged, "comments-open viewing allowed the current image to change or closed comments during zoom");
  assert(desktopCommentViewing.zoom_active, `desktop image could not be zoomed while comments were open: ${JSON.stringify(desktopCommentViewing)}`);
  assert(desktopCommentViewing.button_opacity === 1 && desktopCommentViewing.button_pointer_events !== "none" && desktopCommentViewing.button_opacity_after_zoom === 1 && desktopCommentViewing.button_pointer_events_after_zoom !== "none", "desktop comment button disappeared after zooming with comments open");
  assert(desktopCommentViewing.comments_open_after_pan && desktopCommentViewing.image_transform_after_pan !== desktopCommentViewing.image_transform_before_pan, "desktop image could not be panned while comments were open");
  assert(desktopZoomedImageClose.lightbox_visible && !desktopZoomedImageClose.comments_open, "clicking a zoomed image did not close comments while preserving fullscreen");
  assert(desktopCommentButtonClose.lightbox_visible && !desktopCommentButtonClose.comments_open, "desktop comment button did not close comments while preserving fullscreen");
  assert(Math.abs(mobileComments.width - 390) < 0.5 && mobileComments.height <= 640.5 && mobileComments.bottom_delta < 0.5, "mobile comments did not use the expected bottom sheet");
  assert(
    mobileComments.left < 0.5
    && mobileComments.border_top_style === "none"
    && mobileComments.clip_path !== "none"
    && mobileComments.iframe_clip_path !== "none"
    && mobileComments.iframe_border_top_left_radius === "14px"
    && mobileComments.box_shadow !== "none",
    `mobile comments were not clipped as a rounded bottom panel: ${JSON.stringify(mobileComments)}`
  );
  assert(mobileBackdropClose.lightbox_visible && !mobileBackdropClose.comments_open, "tapping above the mobile comment panel exited fullscreen instead of closing comments");
  assert(
    mobilePullDragging.dragging
    && !mobilePullDragging.parent_has_pull_variable
    && mobilePullDragging.panel_top > mobileComments.top + 60
    && mobilePullDragging.border_top_style === "none"
    && mobilePullDragging.border_top_left_radius === "14px"
    && mobilePullDragging.clip_path !== "none"
    && mobilePullDragging.box_shadow !== "none"
    && mobilePullDragging.background_color !== "rgba(0, 0, 0, 0)"
    && mobilePullDragging.transform !== "none",
    `mobile comment shell did not move intact with the drag: ${JSON.stringify({ initial: mobileComments, dragging: mobilePullDragging })}`
  );
  assert(mobilePullClose.lightbox_visible && !mobilePullClose.comments_open, "pulling down the mobile comment panel exited fullscreen instead of closing comments");
  assert(
    mobilePullCloseTrace.samples.every((sample, index, samples) => index === 0 || sample.top >= samples[index - 1].top - 1)
    && mobilePullCloseTrace.samples.some((sample) => !sample.open)
    && mobilePullCloseTrace.samples.at(-1).top >= mobilePullCloseTrace.viewport_height - 1,
    `mobile comment panel jumped upward during close: ${JSON.stringify(mobilePullCloseTrace)}`
  );
  const slowReturnTops = mobileSlowPull.return_trace.map((sample) => sample.top);
  assert(
    mobileSlowPull.lightbox_visible
    && mobileSlowPull.comments_open
    && mobileSlowPull.animation_count === 0
    && Math.abs(mobileSlowPull.settled_top - mobileComments.top) < 0.5
    && slowPullSamples.every((value, index) => index === 0 || value >= slowPullSamples[index - 1] - 0.5)
    && slowPullSamples.at(-1) > mobileComments.top + 70,
    `slow mobile comment drag was not monotonic and responsive: ${JSON.stringify(mobileSlowPull)}`
  );
  assert(
    slowReturnTops.length > 6
    && Math.min(...slowReturnTops) >= mobileComments.top - 1
    && Math.abs(slowReturnTops.at(-1) - mobileComments.top) < 1,
    `mobile comment panel overshot above its resting position: ${JSON.stringify(mobileSlowPull.return_trace)}`
  );
  assert(mobileVerticalReturn.lightbox_visible && (mobileVerticalReturn.transform === "none" || mobileVerticalReturn.transform === "matrix(1, 0, 0, 1, 0, 0)") && mobileVerticalReturn.returning === 0, `mobile image did not reliably return after an upward swipe: ${JSON.stringify(mobileVerticalReturn)}`);
  assert(
    mobileSwipeFlash.sample_count > 20
    && mobileSwipeFlash.blank_samples === 0
    && mobileSwipeFlash.missing_image_samples === 0
    && mobileSwipeFlash.min_opacity >= 0.98
    && mobileSwipeFlash.source_changes_while_dragging === 0
    && mobileSwipeFlash.moving_transitions_disabled
    && mobileSwipeFlash.p95_frame_gap_ms < 45
    && mobileSwipeFlash.max_frame_gap_ms < 100,
    `mobile horizontal swipe was blank, unstable, or poorly paced: ${JSON.stringify(mobileSwipeFlash)}`
  );
  assert(!mobileAlignment.available || mobileAlignment.center_delta < 0.5, `mobile comment button was not aligned with tags/info: ${JSON.stringify(mobileAlignment)}`);
  assert(mobileAlignment.controls_gap >= 10, "mobile comment button overlapped the tags/info area");
  assert(!infoMutual.available || (infoMutual.info_visible && infoMutual.comment_opacity === 0 && infoMutual.comment_pointer_events === "none"), "info panel did not hide the comment button");
  assert(!infoMutual.available || (
    !infoMutual.returned_info_visible
    && infoMutual.returned_comment_opacity === 1
    && infoMutual.returned_center_delta < 0.5
  ), `comment button did not return to the tags/info alignment after closing info: ${JSON.stringify(infoMutual)}`);
  assert(
    heroOrigin.inline_visibility_after_open === ""
    && heroOrigin.computed_visibility_after_open === "hidden"
    && heroOrigin.shell_inline_visibility_after_open === "hidden"
    && heroOrigin.shell_computed_visibility_after_open === "hidden"
    && (heroOrigin.placeholder_visibility_after_open === null || heroOrigin.placeholder_visibility_after_open === "hidden")
    && heroOrigin.clone_initial_rect
    && Math.abs(heroOrigin.clone_initial_rect.left - heroOrigin.left) < 0.75
    && Math.abs(heroOrigin.clone_initial_rect.top - heroOrigin.top) < 0.75
    && Math.abs(heroOrigin.clone_initial_rect.width - heroOrigin.width) < 0.75
    && Math.abs(heroOrigin.clone_initial_rect.height - heroOrigin.height) < 0.75
    && (heroOrigin.clone_initial_transform === "none" || heroOrigin.clone_initial_transform === "matrix(1, 0, 0, 1, 0, 0)")
    && heroOrigin.clone_initial_radius === heroOrigin.shell_radius
    && heroEntry.origin_visibility === "hidden"
    && heroEntry.origin_shell_visibility === "hidden"
    && heroEntry.origin_placeholder_visibility === "hidden"
    && heroEntry.grid_locked,
    `mobile hero entry did not synchronously hide the complete source card: ${JSON.stringify({ heroOrigin, heroEntry })}`
  );
  assert(
    heroOpenStability.sample_count > 10
    && heroOpenStability.inline_width > 1
    && heroOpenStability.inline_height > 1
    && heroOpenStability.max_top_delta < 0.75
    && heroOpenStability.max_left_delta < 0.75
    && heroOpenStability.max_width_delta < 0.75
    && heroOpenStability.max_height_delta < 0.75
    && heroOpenStability.max_expected_position_delta < 1.25,
    `mobile hero image jumped after the opening animation or did not use a stable contain box: ${JSON.stringify(heroOpenStability)}`
  );
  assert(
    heroEntry.visible
    && heroEntry.opening
    && heroEntry.clone_present
    && heroEntry.clone_transform !== "none"
    && heroEntry.clone_alt === ""
    && heroEntry.clone_title === ""
    && Number.parseFloat(heroEntry.clone_radius) >= 0
    && heroEntry.scrim_opacity < 0.96,
    `mobile hero entry did not animate cleanly from the thumbnail: ${JSON.stringify({ heroOrigin, heroEntry })}`
  );
  assert(
    heroDrag.scale < 1
    && heroDrag.translate_y > 30
    && Math.abs(heroDrag.translate_x) > 5
    && heroDrag.scrim_opacity < 0.9
    && (heroDrag.stage_transform === "none" || heroDrag.stage_transform === "matrix(1, 0, 0, 1, 0, 0)")
    && (heroDrag.previous_transform === "none" || heroDrag.previous_transform === "matrix(1, 0, 0, 1, 0, 0)")
    && (heroDrag.next_transform === "none" || heroDrag.next_transform === "matrix(1, 0, 0, 1, 0, 0)"),
    `mobile hero drag moved more than the current slide: ${JSON.stringify(heroDrag)}`
  );
  assert(heroReturn.visible && (heroReturn.transform === "none" || heroReturn.transform === "matrix(1, 0, 0, 1, 0, 0)") && heroReturn.scrim_opacity >= 0.959 && heroReturn.animation_count === 0, `mobile hero drag did not spring back cleanly: ${JSON.stringify(heroReturn)}`);
  assert(
    heroNearThreshold.visible
    && !heroNearThreshold.closing
    && (heroNearThreshold.transform === "none" || heroNearThreshold.transform === "matrix(1, 0, 0, 1, 0, 0)")
    && heroNearThreshold.scrim_opacity >= 0.959
    && heroNearThreshold.animation_count === 0,
    `mobile hero exit threshold was still too easy to trigger: ${JSON.stringify(heroNearThreshold)}`
  );
  assert(
    heroClose.closing
    && heroClose.clone_present
    && heroClose.clone_alt === ""
    && heroClose.clone_title === ""
    && Number.parseFloat(heroClose.clone_border_radius) > 0
    && Number.parseFloat(heroClose.clone_border_radius) <= Number.parseFloat(heroClose.target_border_radius)
    && heroClose.slide_images_have_empty_alt
    && heroClose.scrim_opacity < 0.96,
    `mobile hero exit exposed text or skipped the dedicated composite layer: ${JSON.stringify(heroClose)}`
  );
  assert(
    heroClose.overlay_pointer_events !== "none"
    && heroClose.overlay_touch_action === "none"
    && heroClose.stage_touch_action === "none"
    && heroClose.body_locked
    && heroClose.body_overflow === "hidden"
    && heroClose.grid_locked
    && heroClose.origin_visibility === "hidden"
    && heroClose.scroll_after === heroClose.scroll_before,
    `mobile hero exit did not keep the page locked during the shrink-back animation: ${JSON.stringify(heroClose)}`
  );
  assert(
    !heroCleanup.clone_present
    && !heroCleanup.opening
    && !heroCleanup.closing
    && heroCleanup.origin_visibility === "visible"
    && heroCleanup.origin_inline_visibility === ""
    && heroCleanup.origin_shell_visibility === "visible"
    && heroCleanup.origin_shell_inline_visibility === ""
    && heroCleanup.hidden_overlay_black_frames === 0
    && heroCleanup.handoff_frames > 0
    && heroCleanup.exposed_source_without_clone_frames === 0
    && !heroCleanup.grid_locked,
    `mobile hero exit left stale state or exposed an opaque black teardown frame: ${JSON.stringify(heroCleanup)}`
  );
  assert(
    heroCancelStart.origin_visibility === "hidden"
    && heroCancelStart.origin_shell_visibility === "hidden"
    && heroCancel.animation_was_present
    && heroCancel.origin_visibility_after_cancel === "visible"
    && heroCancel.origin_inline_visibility_after_cancel === ""
    && heroCancel.origin_shell_visibility_after_cancel === "visible"
    && heroCancel.origin_shell_inline_visibility_after_cancel === "",
    `cancelling the hero exit did not restore the source thumbnail: ${JSON.stringify({ heroCancelStart, heroCancel })}`
  );
  const pinchReleaseShift = Math.hypot(
    mobilePinchRelease.after_release.x - mobilePinchRelease.before_release.x,
    mobilePinchRelease.after_release.y - mobilePinchRelease.before_release.y
  );
  const pinchStationaryShift = Math.hypot(
    mobilePinchRelease.after_stationary_move.x - mobilePinchRelease.after_release.x,
    mobilePinchRelease.after_stationary_move.y - mobilePinchRelease.after_release.y
  );
  const pinchSmallPanDistance = Math.hypot(
    mobilePinchRelease.after_small_pan.x - mobilePinchRelease.after_stationary_move.x,
    mobilePinchRelease.after_small_pan.y - mobilePinchRelease.after_stationary_move.y
  );
  assert(
    mobilePinchRelease.zoom_active
    && mobilePinchRelease.before_release.scale > 1.1
    && pinchReleaseShift < 0.75
    && pinchStationaryShift < 0.75
    && pinchSmallPanDistance > 1
    && pinchSmallPanDistance < 12,
    `mobile pinch release rebased into an unintended pan jump: ${JSON.stringify({
      ...mobilePinchRelease,
      pinchReleaseShift,
      pinchStationaryShift,
      pinchSmallPanDistance,
    })}`
  );
  assert(single.count === "1", "single selection count was not 1");
  assert(!single.slot_collapsed && !single.button_disabled && single.button_aria_hidden === "false", "print button was not visible for a single image");
  assert(Math.abs(single.button_width - single.button_height) < 0.5, "print button was not circular");
  assert(Math.abs(single.button_height - single.bar_height) < 0.5, "print button height did not match the selection pill");
  assert(single.top_delta < 0.5 && single.bottom_delta < 0.5, "print button was not vertically aligned");
  assert(single.gap_to_bar >= 7 && single.gap_to_bar <= 9, "print button gap did not match the design");
  assert(single.action_count === 3, "download, delete, or close action was missing");
  assert(single.action_disabled.every((disabled) => !disabled), "a selection action was unexpectedly disabled");
  assert(pickerVisible, "print location picker did not open");
  assert(singleDownload.links.length === 1 && !singleDownload.picker_called, "single-image download did not remain a direct download");
  assert(multiple.count === "2", "multiple selection count was not 2");
  assert(multiple.slot_collapsed && multiple.button_disabled && multiple.button_aria_hidden === "true", "print button did not hide for multiple images");
  assert(multiple.action_count === 3, "selection actions changed after multiple selection");
  assert(downloadModes.individual_links.length === 2, "non-full multiple selection did not trigger individual downloads");
  assert(downloadModes.individual_links.every((link) => link.href.includes("/api/download/file/") && link.download === ""), "individual downloads did not defer original filenames to the server");
  assert(downloadModes.individual_links.every((link) => link.user_activation !== false), "individual downloads escaped the originating user-activation window");
  assert(downloadModes.individual_links.at(-1).clicked_at - downloadModes.individual_links[0].clicked_at < 50, "individual downloads were not triggered synchronously");
  assert(downloadModes.streamed_individual_downloads.files.length === 2, "directory download did not save every selected original");
  assert(downloadModes.streamed_individual_downloads.files.every((file) => file.bytes > 0), "directory download wrote an empty original");
  assert(downloadModes.streamed_individual_downloads.picker_activations.every((active) => active !== false), "directory picker escaped the originating user-activation window");
  assert(downloadModes.zip?.method === "post" && downloadModes.zip.action.endsWith("/api/download/zip"), "full selection did not use the streaming ZIP endpoint");
  assert(downloadModes.zip.image_ids.length === downloadModes.full_selection_count, "streaming ZIP did not include the full selection");

  const widths = new Set(animation.map((sample) => sample.width));
  const opacities = new Set(animation.map((sample) => sample.opacity));
  assert(widths.size >= 3, "print button slot animation did not produce intermediate widths");
  assert(opacities.size >= 2, "print button animation did not produce intermediate opacity");

  await evaluate(cdp, `document.querySelector('.selection-action-btn[aria-label="Cancel"]').click()`);
  await sleep(500);
  const cancelAction = await evaluate(cdp, `(() => ({
    selected_count: document.querySelectorAll(".photo-item.selected").length,
    dock_visible: document.querySelector("#selection-dock").classList.contains("visible"),
  }))()`);
  assert(cancelAction.selected_count === 0 && !cancelAction.dock_visible, "close action did not clear the selection");

  await cdp.send("Page.navigate", { url: "https://print.example.com/" });
  await waitFor(cdp, `location.hostname === "print.example.com" && Boolean(document.querySelector("input"))`);
  const nameGate = await evaluate(cdp, `(() => ({
    stored_name: localStorage.getItem("609-reading-room:user-name"),
    input_present: Boolean(document.querySelector("input")),
    payment_button_present: Array.from(document.querySelectorAll("button"))
      .some((button) => button.className.includes("border-emerald-600")),
  }))()`);
  assert(nameGate.stored_name === null && nameGate.input_present, "609 did not require a name for a fresh browser");
  assert(!nameGate.payment_button_present, "609 exposed print options before the name step");

  await evaluate(cdp, `localStorage.setItem("609-reading-room:user-name", "Codex UI Test")`);
  await cdp.send("Page.navigate", { url: siteUrl });
  await waitFor(cdp, `document.querySelectorAll(".photo-item .photo-check").length >= 2`);
  await evaluate(cdp, `document.querySelector(".photo-item .photo-check").click()`);
  await sleep(280);
  await evaluate(cdp, `document.querySelector(".selection-print-btn").click()`);
  await waitFor(cdp, `document.querySelector("#print-picker").classList.contains("visible")`);
  await evaluate(cdp, `document.querySelector('.print-location[data-print-location="zhu1"]').click()`);
  try {
    await waitFor(cdp, `location.hostname === "print.example.com"`);
  } catch (error) {
    const failureState = await evaluate(cdp, `(() => ({
      hostname: location.hostname,
      note: document.querySelector(".print-picker-note")?.textContent,
    }))()`);
    throw new Error(`NormalPics click-through failed: ${JSON.stringify({
      failure_state: failureState,
      network_log: networkLog,
      console_log: consoleLog,
    })}`, { cause: error });
  }
  try {
    await waitFor(cdp, `Array.from(document.querySelectorAll("button"))
      .filter((button) => button.className.includes("rounded-[20px]")).length === 2`, 900);
  } catch (error) {
    const failureState = await evaluate(cdp, `(() => ({
      hostname: location.hostname,
      title: document.title,
      body_text: document.body.innerText.slice(0, 1_500),
      buttons: Array.from(document.querySelectorAll("button")).map((button) => ({
        text: button.textContent.trim(),
        class_name: button.className,
        disabled: button.disabled,
      })),
    }))()`);
    throw new Error(`609 print modes did not appear: ${JSON.stringify({
      failure_state: failureState,
      network_log: networkLog,
      console_log: consoleLog,
    })}`, { cause: error });
  }
  const printFlow = await evaluate(cdp, `(() => {
    const modes = Array.from(document.querySelectorAll("button"))
      .filter((button) => button.className.includes("rounded-[20px]"));
    return {
      mode_count: modes.length,
      active_mode_index: modes.findIndex((button) => button.className.includes("border-emerald-600")),
      active_mode_text: modes.find((button) => button.className.includes("border-emerald-600"))?.textContent,
      paid_print_button_present: Array.from(document.querySelectorAll("button"))
        .some((button) => button.className.includes("border-ink") && button.className.includes("bg-ink")),
    };
  })()`);
  assert(printFlow.mode_count === 2, "609 print mode controls did not appear after handoff");
  assert(printFlow.active_mode_index === 1, "NormalPics handoff did not default to the color mode");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: "https://comments.pics.example.com/" });
  await waitFor(cdp, `Boolean(document.querySelector("footer a"))`);
  const commentUiLoadingState = await evaluate(cdp, `(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://pics.example.com",
      source: window,
      data: {
        type: "normalpics:context",
        imageId: ${JSON.stringify(desktopNavBefore.image_id)},
        viewerId: "codex-comment-ui-loading-test",
      },
    }));
    return {
      skeleton_count: document.querySelectorAll(".skeleton-comment").length,
      empty_text: document.querySelector(".empty")?.textContent || "",
      comment_count: document.querySelectorAll(".comment:not(.skeleton-comment)").length,
    };
  })()`);
  await waitFor(cdp, `document.querySelectorAll(".skeleton-comment").length === 0`);
  const commentUi = await evaluate(cdp, `(() => {
    const footer = document.querySelector("footer");
    const link = footer.querySelector("a");
    const surface = document.querySelector(".editor-surface");
    const before = surface.getBoundingClientRect();
    document.querySelector(".preview-toggle").click();
    const after = surface.getBoundingClientRect();
    return {
      has_sort: Boolean(document.querySelector("select")),
      has_visible_admin: Array.from(document.querySelectorAll("button"))
        .some((button) => button.textContent.trim().includes("管理")),
      footer_text: footer.textContent.trim().replace(/\\s+/g, " "),
      link_text: link.textContent.trim(),
      link_href: link.href,
      link_target: link.target,
      link_decoration: getComputedStyle(link).textDecorationLine,
      skeleton_count_after_load: document.querySelectorAll(".skeleton-comment").length,
      empty_text_after_load: document.querySelector(".empty")?.textContent || "",
      comment_count_after_load: document.querySelectorAll(".comment:not(.skeleton-comment)").length,
      editor_surface_delta: {
        width: Math.abs(before.width - after.width),
        height: Math.abs(before.height - after.height),
      },
    };
  })()`);
  assert(!commentUi.has_sort, "comment UI still exposed a sorting control");
  assert(!commentUi.has_visible_admin, "comment UI still exposed a visible management control");
  assert(commentUi.footer_text === "Powered by Sodesu v0.5.2", "comment UI footer attribution was incorrect");
  assert(commentUi.link_text === "Sodesu" && commentUi.link_href === "https://github.com/Tchirek/comment-ui", "Sodesu footer link was incorrect");
  assert(commentUi.link_target === "_blank", "Sodesu footer link did not open a navigable target");
  assert(commentUi.link_decoration.includes("underline"), "Sodesu footer link was not underlined");
  assert(
    commentUiLoadingState.skeleton_count > 0
    && commentUiLoadingState.empty_text === ""
    && commentUiLoadingState.comment_count === 0,
    `comment UI showed an empty state before the first API result instead of a skeleton: ${JSON.stringify(commentUiLoadingState)}`
  );
  assert(commentUi.skeleton_count_after_load === 0, `comment UI left skeleton rows after loading: ${JSON.stringify(commentUi)}`);
  assert(
    commentUi.comment_count_after_load > 0 || commentUi.empty_text_after_load === "还没有评论",
    `comment UI neither showed loaded comments nor the confirmed empty state: ${JSON.stringify(commentUi)}`
  );
  assert(commentUi.editor_surface_delta.width < 0.5 && commentUi.editor_surface_delta.height < 0.5, "comment edit/preview switch changed the editor size");

  console.log(JSON.stringify({
    site_url: siteUrl,
    first_image_status: firstStatus,
    blur_up: blurUp,
    hero_viewer: {
      origin: heroOrigin,
      entry: heroEntry,
      open_stability: heroOpenStability,
      drag: heroDrag,
      returned: heroReturn,
      near_threshold: heroNearThreshold,
      close: heroClose,
      cleanup: heroCleanup,
      cancelled_exit: heroCancel,
      pinch_release: mobilePinchRelease,
    },
    comments: {
      desktop_navigation: desktopNavigation,
      preloaded: commentPreloaded,
      immediate_open: commentImmediateOpen,
      open: commentOpen,
      desktop_image_close: desktopCommentClose,
      desktop_viewing: desktopCommentViewing,
      desktop_zoomed_image_close: desktopZoomedImageClose,
      desktop_button_close: desktopCommentButtonClose,
      mobile: mobileComments,
      mobile_backdrop_close: mobileBackdropClose,
      mobile_pull_dragging: mobilePullDragging,
      mobile_pull_close_trace: mobilePullCloseTrace,
      mobile_pull_close: mobilePullClose,
      mobile_slow_pull: mobileSlowPull,
      mobile_vertical_return: mobileVerticalReturn,
      mobile_swipe_flash: mobileSwipeFlash,
      mobile_alignment: mobileAlignment,
      info_mutual: infoMutual,
    },
    single_selection: single,
    single_download: singleDownload,
    picker_visible: pickerVisible,
    multiple_selection: multiple,
    download_modes: downloadModes,
    animation: {
      sample_count: animation.length,
      distinct_widths: widths.size,
      distinct_opacities: opacities.size,
      first_samples: animation.slice(0, 5),
      last_sample: animation.at(-1),
    },
    cancel_action: cancelAction,
    name_gate: nameGate,
    print_click_through: printFlow,
    comment_ui: commentUi,
    comment_ui_loading_state: commentUiLoadingState,
    click_through_network: networkLog,
  }, null, 2));

  cdp.close();
} finally {
  edge.kill();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function clickElement(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`element not found: ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function clickPoint(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Edge may still be starting.
    }
    await sleep(100);
  }
  throw new Error("Edge DevTools target did not become available");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (!message.id) {
      for (const listener of listeners.get(message.method) || []) {
        listener(message.params || {});
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
    on(method, listener) {
      const methodListeners = listeners.get(method) || [];
      methodListeners.push(listener);
      listeners.set(method, methodListeners);
    },
  };
}

function isRelevantUrl(url) {
  return url.includes("/api/download/")
    || url.includes("/api/print/")
    || url.includes("/api/print-upload/")
    || url.includes("/api/photohost/")
    || url.includes("/api/comment")
    || url.includes("comments.pics.example.com")
    || url.includes("r2.cloudflarestorage.com");
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function waitFor(cdp, expression, maxAttempts = 300) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {
      // Navigation can briefly invalidate the current execution context.
    }
    await sleep(100);
  }
  throw new Error(`condition was not met: ${expression}`);
}
