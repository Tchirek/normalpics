import { apiRequest, assetUrl } from './api';
import { getDeleteToken, isDeleteAuthenticated, promptPin } from './auth';
import { iconButton } from './icons';
import type { ImageItem } from './types';

type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}) => Promise<FileSystemDirectoryHandle>;

export function initSelection(
  getItems: () => ImageItem[],
  getTotal: () => number,
  getSearch: () => string,
  openLightbox: (id: string, origin?: HTMLElement | null) => void,
  removeImages: (imageIds: string[]) => void
): void {
  const gallery = document.getElementById('gallery')!;
  const toolbar = document.getElementById('toolbar-actions') || document.getElementById('toolbar')!;
  const selectionBar = document.getElementById('selection-bar')!;
  const selectionDock = document.createElement('div');
  selectionDock.id = 'selection-dock';
  selectionBar.before(selectionDock);
  selectionDock.appendChild(selectionBar);
  const selected = new Set<string>();
  let selectMode = false;
  let longPressTimer = 0;
  let longPressed = false;
  let touchToggleHandledAt = 0;
  let touchSelectCandidate: { id: string; startX: number; startY: number; check: boolean } | null = null;
  let directTouchCandidate: { id: string; touchId: number; startX: number; startY: number; check: boolean } | null = null;
  let selectionBlockTimer = 0;
  let selectionInteractionBlockedUntil = 0;
  let printLayoutResetTimer = 0;
  let printVisible = false;
  let printInFlight = false;
  let downloading = false;
  let allServerSelected = false;
  let allowEmptySelection = false;
  let beforeAllSelection: Set<string> | null = null;
  let allSelectionSearch = '';
  let allSelectionTotal = 0;

  const selectAllButton = iconButton('check-check', 'Select images', 'select-all-btn');
  toolbar.appendChild(selectAllButton);
  const printSlot = document.createElement('div');
  printSlot.className = 'selection-print-slot is-collapsed';
  const printButton = iconButton('printer', 'Print at 609', 'selection-print-btn');
  printButton.disabled = true;
  printButton.setAttribute('aria-hidden', 'true');
  printSlot.appendChild(printButton);
  selectionDock.prepend(printSlot);
  const count = document.createElement('button');
  count.type = 'button';
  count.className = 'selection-count';
  count.setAttribute('aria-label', 'Select all images');
  count.innerHTML = '<span class="selection-count-current">0</span><span class="selection-count-total">0</span>';
  const downloadButton = iconButton('download', 'Download', 'selection-action-btn');
  const deleteButton = iconButton('trash', 'Delete', 'selection-action-btn');
  const cancelButton = iconButton('x', 'Cancel', 'selection-action-btn');
  selectionBar.replaceChildren(count, downloadButton, deleteButton, cancelButton);

  const printPicker = document.createElement('div');
  printPicker.id = 'print-picker';
  printPicker.setAttribute('aria-hidden', 'true');
  printPicker.innerHTML = `
    <section class="print-picker-panel" role="dialog" aria-modal="true" aria-label="选择打印点">
      <button type="button" class="print-location" data-print-location="zhu1">
        <img src="/avatars/zhu1-609.png" alt="" loading="lazy" decoding="async">
        <span>
          <strong>Room 101</strong>
          <small>F6</small>
        </span>
      </button>
      <button type="button" class="print-location" data-print-location="zhu2">
        <img src="/avatars/zhu2-519.png" alt="" loading="lazy" decoding="async">
        <span>
          <strong>Room 102</strong>
          <small>F5</small>
        </span>
      </button>
      <p class="print-picker-note" aria-live="polite"></p>
    </section>
  `;
  document.body.appendChild(printPicker);
  const printPanel = printPicker.querySelector<HTMLElement>('.print-picker-panel')!;
  const printNote = printPicker.querySelector<HTMLElement>('.print-picker-note')!;
  const printLocations = Array.from(printPicker.querySelectorAll<HTMLButtonElement>('.print-location'));

  function consumeOverlayEvent(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
  }

  ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'click', 'touchstart', 'touchend', 'touchcancel'].forEach((type) => {
    selectionDock.addEventListener(type, consumeOverlayEvent, { passive: false });
  });

  function selectableIds(): string[] {
    return getItems()
      .filter((item) => item.syncStatus === 'synced' || item.syncStatus === 'pending')
      .map((item) => item.id);
  }

  function visibleTotal(): number {
    return Math.max(getTotal(), selectableIds().length, selected.size);
  }

  function selectedCount(): number {
    return allServerSelected ? Math.max(allSelectionTotal, visibleTotal()) : selected.size;
  }

  function syncAllLoadedSelection(): void {
    if (!allServerSelected) return;
    if (getSearch() !== allSelectionSearch) {
      clearSelection();
      return;
    }
    for (const id of selectableIds()) selected.add(id);
    allSelectionTotal = Math.max(allSelectionTotal, visibleTotal());
  }

  function enterSelectMode(options: { allowEmpty?: boolean } = {}): void {
    if (!selectMode) allowEmptySelection = Boolean(options.allowEmpty);
    else if (options.allowEmpty) allowEmptySelection = true;
    selectMode = true;
    document.body.classList.add('select-mode');
  }

  function exitSelectMode(): void {
    selectMode = false;
    allServerSelected = false;
    allowEmptySelection = false;
    beforeAllSelection = null;
    allSelectionSearch = '';
    allSelectionTotal = 0;
    document.body.classList.remove('select-mode');
  }

  function applyClasses(): void {
    syncAllLoadedSelection();
    gallery.querySelectorAll<HTMLElement>('.photo-item').forEach((item) => {
      item.classList.toggle('selected', Boolean(item.dataset.id && selected.has(item.dataset.id)));
    });
  }

  function triggerDownload(url: string, filename?: string): void {
    const anchor = document.createElement('a');
    anchor.href = url;
    if (filename) anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function bindButtonAction(button: HTMLButtonElement, action: () => void): void {
    let activePointerId: number | null = null;
    let activeTouchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let pointerActivatedAt = 0;

    function clearPress(): void {
      activePointerId = null;
      activeTouchId = null;
      button.classList.remove('is-pressing');
    }

    function activate(): boolean {
      if (button.disabled) return false;
      pointerActivatedAt = Date.now();
      action();
      return true;
    }

    function finishPress(clientX: number, clientY: number, threshold: number): void {
      const moved = Math.hypot(clientX - startX, clientY - startY);
      clearPress();
      if (moved > threshold) return;
      activate();
    }

    button.addEventListener('pointerdown', (event) => {
      if (button.disabled) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      activePointerId = event.pointerId;
      activeTouchId = null;
      startX = event.clientX;
      startY = event.clientY;
      button.classList.add('is-pressing');
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Some browsers release capture around transformed fixed elements.
      }
    });

    button.addEventListener('pointerup', (event) => {
      if (activePointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        button.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released by the browser.
      }
      finishPress(event.clientX, event.clientY, 18);
    });

    window.addEventListener('pointerup', (event) => {
      if (activePointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        button.releasePointerCapture(event.pointerId);
      } catch {
        // The capture may already be gone.
      }
      finishPress(event.clientX, event.clientY, 18);
    }, { capture: true });

    button.addEventListener('pointercancel', () => {
      clearPress();
    });

    button.addEventListener('touchstart', (event) => {
      if (button.disabled || activePointerId !== null) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      event.stopPropagation();
      activeTouchId = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      button.classList.add('is-pressing');
    }, { passive: false });

    button.addEventListener('touchend', (event) => {
      if (activePointerId !== null || activeTouchId === null) return;
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === activeTouchId);
      if (!touch) return;
      event.preventDefault();
      event.stopPropagation();
      finishPress(touch.clientX, touch.clientY, 22);
    }, { passive: false });

    window.addEventListener('touchend', (event) => {
      if (activeTouchId === null) return;
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === activeTouchId);
      if (!touch) return;
      event.preventDefault();
      event.stopPropagation();
      finishPress(touch.clientX, touch.clientY, 22);
    }, { capture: true, passive: false });

    button.addEventListener('touchcancel', () => {
      clearPress();
    });

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (Date.now() - pointerActivatedAt < 450) {
        event.preventDefault();
        return;
      }
      if (button.disabled) {
        event.preventDefault();
        return;
      }
      action();
    });
  }

  function directDownloadUrl(id: string): string {
    return `/api/download/file/${encodeURIComponent(id)}?t=${Date.now()}`;
  }

  function originalFilename(response: Response, id: string): string {
    const disposition = response.headers.get('Content-Disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
    let filename = quoted || `NormalPics-${id}`;
    if (encoded) {
      try {
        filename = decodeURIComponent(encoded);
      } catch {
        filename = encoded;
      }
    }
    return filename.replace(/[\\/:*?"<>|]/g, '_').trim() || `NormalPics-${id}`;
  }

  async function saveOriginalsToDirectory(
    imageIds: string[],
    pickDirectory: DirectoryPicker
  ): Promise<void> {
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await pickDirectory({
        id: 'normalpics-multi-download',
        mode: 'readwrite',
        startIn: 'downloads'
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      throw error;
    }

    let nextIndex = 0;
    const failures: unknown[] = [];
    const saveNext = async (): Promise<void> => {
      while (nextIndex < imageIds.length) {
        const id = imageIds[nextIndex];
        nextIndex += 1;
        try {
          const response = await fetch(directDownloadUrl(id), { credentials: 'same-origin' });
          if (!response.ok || !response.body) throw new Error(`download_${response.status}`);
          const handle = await directory.getFileHandle(originalFilename(response, id), { create: true });
          const writable = await handle.createWritable();
          await response.body.pipeTo(writable);
        } catch (error) {
          failures.push(error);
        }
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(3, imageIds.length) },
      () => saveNext()
    ));
    if (failures.length > 0) throw new AggregateError(failures, 'Some original files could not be downloaded');
  }

  function isFullSelection(imageIds: string[]): boolean {
    if (allServerSelected) return true;
    const all = selectableIds();
    const total = visibleTotal();
    return total > 0 && imageIds.length === total && imageIds.length === all.length && all.every((id) => selected.has(id));
  }

  function selectedImage(): ImageItem | null {
    if (allServerSelected || selected.size !== 1) return null;
    const [id] = Array.from(selected);
    return getItems().find((item) => item.id === id) || null;
  }

  function isPrintable(item: ImageItem | null): item is ImageItem {
    return Boolean(item && (item.syncStatus === 'pending' || item.syncStatus === 'synced'));
  }

  function showPrintButton(): void {
    window.clearTimeout(printLayoutResetTimer);
    if (printVisible) return;
    printVisible = true;
    printButton.disabled = false;
    printButton.setAttribute('aria-hidden', 'false');
    printSlot.classList.remove('is-collapsed');
    printButton.classList.remove('is-hiding');
  }

  function hidePrintButton(options: { preserveLayout?: boolean } = {}): void {
    window.clearTimeout(printLayoutResetTimer);
    if (!printVisible && printSlot.classList.contains('is-collapsed')) return;
    printVisible = false;
    printButton.disabled = true;
    printButton.setAttribute('aria-hidden', 'true');
    printButton.classList.add('is-hiding');
    if (options.preserveLayout) {
      printLayoutResetTimer = window.setTimeout(() => {
        if (selected.size > 0 || printVisible) return;
        printSlot.classList.add('is-collapsed');
      }, 220);
      return;
    }
    printSlot.classList.add('is-collapsed');
  }

  function photoPrintUrl(handoffToken: string): string {
    const url = new URL('https://print.example.com/');
    url.searchParams.set('handoff', handoffToken);
    return url.toString();
  }

  function closePrintPicker(): void {
    printPicker.classList.remove('visible');
    printPicker.setAttribute('aria-hidden', 'true');
    printNote.textContent = '';
  }

  function openPrintPicker(): void {
    const item = selectedImage();
    if (!isPrintable(item)) return;
    printNote.textContent = '';
    printPicker.classList.add('visible');
    printPicker.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => printLocations[0]?.focus(), 40);
  }

  async function sendSelectedToPrint(location: string): Promise<void> {
    const item = selectedImage();
    if (!isPrintable(item) || printInFlight) {
      closePrintPicker();
      return;
    }
    if (location === 'zhu2') {
      printNote.textContent = 'Room 102暂不支持云打印';
      return;
    }
    printInFlight = true;
    printNote.textContent = '正在准备图片...';
    try {
      const sessionResponse = await apiRequest('/api/print/handoff', {
        method: 'POST',
        body: JSON.stringify({
          imageId: item.id
        })
      });
      if (!sessionResponse.ok) throw new Error(`handoff_${sessionResponse.status}`);
      const session = await sessionResponse.json() as {
        document_id: string;
        upload_url: string;
        upload_token: string;
        upload_headers: Record<string, string>;
        notify_url: string;
        handoff_token: string;
        source_url: string;
      };

      const imageResponse = await fetch(session.source_url, { cache: 'no-store' });
      if (!imageResponse.ok) throw new Error(`image_${imageResponse.status}`);
      const imageBlob = await imageResponse.blob();
      if (!imageBlob.type.startsWith('image/') || imageBlob.size <= 0) throw new Error('image_invalid');

      const uploadResponse = await fetch(session.upload_url, {
        method: 'PUT',
        headers: session.upload_headers,
        body: imageBlob
      });
      if (!uploadResponse.ok) throw new Error(`upload_${uploadResponse.status}`);

      const notifyResponse = await fetch(session.notify_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_id: session.document_id,
          document_token: session.upload_token
        })
      });
      if (!notifyResponse.ok) throw new Error(`notify_${notifyResponse.status}`);

      window.location.assign(photoPrintUrl(session.handoff_token));
    } catch (err) {
      console.warn('[print] failed:', err);
      printNote.textContent = '图片发送失败，请重试';
    } finally {
      printInFlight = false;
    }
  }

  printPicker.addEventListener('click', (event) => {
    if (event.target === printPicker) closePrintPicker();
  });
  printPanel.addEventListener('click', (event) => event.stopPropagation());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && printPicker.classList.contains('visible')) closePrintPicker();
  });
  for (const locationButton of printLocations) {
    bindButtonAction(locationButton, () => void sendSelectedToPrint(locationButton.dataset.printLocation || ''));
  }

  bindButtonAction(printButton, openPrintPicker);
  bindButtonAction(downloadButton, () => void downloadSelected());
  bindButtonAction(deleteButton, () => void deleteSelected());
  bindButtonAction(cancelButton, clearSelection);

  function downloadIndividually(imageIds: string[]): void | Promise<void> {
    if (imageIds.length === 1) {
      triggerDownload(directDownloadUrl(imageIds[0]));
      return;
    }

    const pickDirectory = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (pickDirectory) return saveOriginalsToDirectory(imageIds, pickDirectory.bind(window));

    // Fallback for browsers without the File System Access API.
    for (const id of imageIds) {
      triggerDownload(directDownloadUrl(id));
    }
  }

  function downloadZip(imageIds: string[], options: { all?: boolean } = {}): void {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = assetUrl('/api/download/zip');
    form.hidden = true;
    if (options.all) {
      const allInput = document.createElement('input');
      allInput.type = 'hidden';
      allInput.name = 'all';
      allInput.value = '1';
      const query = allSelectionSearch.trim();
      if (query) {
        const queryInput = document.createElement('input');
        queryInput.type = 'hidden';
        queryInput.name = 'q';
        queryInput.value = query;
        form.appendChild(queryInput);
      }
      form.appendChild(allInput);
    } else {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'imageIds';
      input.value = JSON.stringify(imageIds);
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    window.setTimeout(() => form.remove(), 1_000);
  }

  async function downloadSelected(): Promise<void> {
    const imageIds = Array.from(selected);
    if (selectedCount() === 0 || downloading) return;

    downloading = true;
    renderBar();
    try {
      if (allServerSelected) downloadZip([], { all: true });
      else if (isFullSelection(imageIds)) downloadZip(imageIds);
      else await downloadIndividually(imageIds);
    } catch (err) {
      console.warn('[download] failed:', err);
    } finally {
      downloading = false;
      renderBar();
    }
  }

  async function deleteSelected(): Promise<void> {
    const imageIds = Array.from(selected);
    if (imageIds.length === 0 || (allServerSelected && visibleTotal() > imageIds.length)) return;
    if (!isDeleteAuthenticated() && !(await promptPin('delete'))) return;
    if (!window.confirm(`\u5220\u9664\u9009\u4e2d\u7684 ${imageIds.length} \u5f20\u56fe\u7247\uff1f`)) return;

    const results = await Promise.allSettled(imageIds.map(async (id) => {
      const deleteToken = getDeleteToken();
      const response = await apiRequest(`/api/images/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: deleteToken ? { Authorization: `Bearer ${deleteToken}` } : undefined
      });
      if (response.ok || response.status === 404) {
        return id;
      }
      throw new Error(`delete_${response.status}`);
    }));
    const deleted = results
      .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
      .map((result) => result.value);
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) console.warn('[delete] failed:', failed);

    if (deleted.length === 0) return;
    for (const id of deleted) selected.delete(id);
    removeImages(deleted);
    renderBar();
  }

  function renderBar(): void {
    const countValue = selectedCount();
    if (selected.size === 0 && (!selectMode || !allowEmptySelection)) {
      closePrintPicker();
      hidePrintButton({ preserveLayout: true });
      selectionInteractionBlockedUntil = Date.now() + 450;
      window.clearTimeout(selectionBlockTimer);
      selectionDock.classList.add('is-blocking');
      selectionDock.classList.remove('visible');
      selectionBar.classList.remove('visible');
      selectionBlockTimer = window.setTimeout(() => {
        if (selected.size > 0) return;
        selectionDock.classList.remove('is-blocking');
      }, 460);
      exitSelectMode();
      applyClasses();
      return;
    }

    window.clearTimeout(selectionBlockTimer);
    selectionDock.classList.remove('is-blocking');
    enterSelectMode();
    count.querySelector<HTMLElement>('.selection-count-current')!.textContent = String(countValue);
    count.querySelector<HTMLElement>('.selection-count-total')!.textContent = String(visibleTotal());
    count.classList.toggle('is-all-selected', allServerSelected);
    count.disabled = visibleTotal() === 0;
    const printable = isPrintable(selectedImage());
    downloadButton.disabled = downloading || countValue === 0;
    deleteButton.disabled = selected.size === 0 || (allServerSelected && visibleTotal() > selected.size);
    if (printable) {
      showPrintButton();
    } else {
      closePrintPicker();
      hidePrintButton();
    }
    selectionDock.classList.add('visible');
    selectionBar.classList.add('visible');
    applyClasses();
  }

  function clearSelection(): void {
    selected.clear();
    allServerSelected = false;
    allowEmptySelection = false;
    beforeAllSelection = null;
    allSelectionSearch = '';
    allSelectionTotal = 0;
    selectMode = false;
    renderBar();
  }

  function toggle(id: string, force?: boolean): void {
    allServerSelected = false;
    beforeAllSelection = null;
    allSelectionSearch = '';
    allSelectionTotal = 0;
    if (force === true || (!selected.has(id) && force !== false)) selected.add(id);
    else selected.delete(id);
    renderBar();
  }

  function selectAllAvailable(): void {
    enterSelectMode();
    if (allServerSelected) {
      selected.clear();
      for (const id of beforeAllSelection || []) selected.add(id);
      allServerSelected = false;
      beforeAllSelection = null;
      allSelectionSearch = '';
      allSelectionTotal = 0;
      renderBar();
      return;
    }
    beforeAllSelection = new Set(selected);
    allSelectionSearch = getSearch();
    allSelectionTotal = visibleTotal();
    allServerSelected = true;
    for (const id of selectableIds()) selected.add(id);
    renderBar();
  }

  selectAllButton.addEventListener('click', () => {
    if (selectMode) {
      clearSelection();
      return;
    }
    enterSelectMode({ allowEmpty: true });
    renderBar();
  });
  selectAllButton.addEventListener('mousedown', (event) => event.preventDefault());
  bindButtonAction(count, selectAllAvailable);

  gallery.addEventListener('click', (event) => {
    if (Date.now() - touchToggleHandledAt < 450 || Date.now() < selectionInteractionBlockedUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('.photo-item');
    if (!item?.dataset.id || item.dataset.status === 'uploading' || item.dataset.status === 'failed') return;

    if (longPressed) {
      longPressed = false;
      event.preventDefault();
      return;
    }

    if (target.closest('.photo-check') || selectMode) {
      event.preventDefault();
      toggle(item.dataset.id);
      return;
    }

    openLightbox(item.dataset.id, item.querySelector<HTMLElement>('.photo-image') || item);
  });

  gallery.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const isCheck = Boolean(target.closest('.photo-check'));
    if (event.pointerType !== 'touch' && isCheck) {
      event.preventDefault();
    }
    if (event.pointerType !== 'touch') return;
    const item = target.closest<HTMLElement>('.photo-item');
    if (!item?.dataset.id || item.dataset.status === 'uploading' || item.dataset.status === 'failed') return;
    const itemId = item.dataset.id;
    touchSelectCandidate = {
      id: itemId,
      startX: event.clientX,
      startY: event.clientY,
      check: isCheck
    };
    window.clearTimeout(longPressTimer);
    if (isCheck) return;
    longPressTimer = window.setTimeout(() => {
      longPressed = true;
      touchSelectCandidate = null;
      enterSelectMode();
      toggle(itemId, true);
    }, 500);
  });
  gallery.addEventListener('mousedown', (event) => {
    if ((event.target as HTMLElement).closest('.photo-check')) event.preventDefault();
  });

  gallery.addEventListener('pointerup', (event) => {
    window.clearTimeout(longPressTimer);
    if (event.pointerType !== 'touch' || !touchSelectCandidate) return;
    const candidate = touchSelectCandidate;
    touchSelectCandidate = null;
    const moved = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
    if (longPressed || moved > 18) return;
    const shouldToggle = candidate.check || selectMode;
    if (!shouldToggle) return;
    if (Date.now() - touchToggleHandledAt < 80) return;
    event.preventDefault();
    event.stopPropagation();
    touchToggleHandledAt = Date.now();
    toggle(candidate.id);
  });

  gallery.addEventListener('pointermove', (event) => {
    window.clearTimeout(longPressTimer);
    if (event.pointerType !== 'touch' || !touchSelectCandidate) return;
    const moved = Math.hypot(event.clientX - touchSelectCandidate.startX, event.clientY - touchSelectCandidate.startY);
    if (moved > 12) touchSelectCandidate = null;
  });

  gallery.addEventListener('touchstart', (event) => {
    if (Date.now() - touchToggleHandledAt < 80) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('.photo-item');
    if (!item?.dataset.id || item.dataset.status === 'uploading' || item.dataset.status === 'failed') return;
    const isCheck = Boolean(target.closest('.photo-check'));
    directTouchCandidate = {
      id: item.dataset.id,
      touchId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      check: isCheck
    };
    if (isCheck) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { passive: false });

  gallery.addEventListener('touchend', (event) => {
    if (!directTouchCandidate || Date.now() - touchToggleHandledAt < 80) return;
    const candidate = directTouchCandidate;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === candidate.touchId);
    if (!touch) return;
    directTouchCandidate = null;
    const moved = Math.hypot(touch.clientX - candidate.startX, touch.clientY - candidate.startY);
    if (longPressed || moved > 18) return;
    const shouldToggle = candidate.check || selectMode;
    if (!shouldToggle) return;
    event.preventDefault();
    event.stopPropagation();
    touchToggleHandledAt = Date.now();
    toggle(candidate.id);
  }, { passive: false });

  gallery.addEventListener('touchcancel', () => {
    directTouchCandidate = null;
    touchSelectCandidate = null;
    window.clearTimeout(longPressTimer);
  });

  gallery.addEventListener('touchmove', (event) => {
    window.clearTimeout(longPressTimer);
    touchSelectCandidate = null;
    if (!directTouchCandidate) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === directTouchCandidate?.touchId);
    if (!touch) return;
    const moved = Math.hypot(touch.clientX - directTouchCandidate.startX, touch.clientY - directTouchCandidate.startY);
    if (moved > 12) directTouchCandidate = null;
  }, { passive: true });
  window.addEventListener('photohost:gallery-updated', applyClasses);
  window.addEventListener('photohost:gallery-updated', () => {
    if (selectMode) renderBar();
  });
}
