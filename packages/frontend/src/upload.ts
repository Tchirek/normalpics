import { apiFetch } from './api';
import { isAuthenticated, promptPin } from './auth';
import { iconButton } from './icons';
import type { UploadPreview } from './types';

interface SignResponse {
  imageId: string;
  uploadUrl: string;
  r2Key: string;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'arw', 'cr2', 'nef', 'dng', 'tif', 'tiff']);

export function initUpload(prependPending: (imageId: string, filename?: string, preview?: UploadPreview | null) => void): void {
  const toolbar = document.getElementById('toolbar-actions') || document.getElementById('toolbar')!;
  const overlay = document.getElementById('upload-overlay')!;
  const progressBar = document.getElementById('progress-bar')!;
  const input = document.createElement('input');
  const toast = document.createElement('div');
  input.type = 'file';
  input.accept = 'image/*,.arw,.cr2,.nef,.dng,.heic,.heif';
  input.multiple = true;
  input.className = 'file-input-proxy';
  toast.className = 'upload-toast';
  document.body.appendChild(input);
  document.body.appendChild(toast);

  const uploadButton = iconButton('plus', 'Upload');
  toolbar.appendChild(uploadButton);

  const progress = new Map<string, { loaded: number; total: number }>();

  function imageFiles(files: FileList | File[]): File[] {
    return Array.from(files).filter((file) => {
      const ext = file.name.toLowerCase().split('.').pop() || '';
      return file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext);
    });
  }

  function updateProgress(): void {
    const values = Array.from(progress.values());
    if (values.length === 0) {
      progressBar.style.opacity = '0';
      progressBar.style.transform = 'scaleX(0)';
      return;
    }
    const total = values.reduce((sum, item) => sum + item.total, 0);
    const loaded = values.reduce((sum, item) => sum + item.loaded, 0);
    const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
    progressBar.style.opacity = '1';
    progressBar.style.transform = `scaleX(${ratio})`;
  }

  function finishProgress(): void {
    progressBar.style.transform = 'scaleX(1)';
    window.setTimeout(() => {
      progress.clear();
      updateProgress();
    }, 300);
  }

  let toastTimer = 0;
  function showToast(message: string): void {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('visible');
    }, 2200);
  }

  function putFile(url: string, file: File, key: string, contentType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', contentType);
      progress.set(key, { loaded: 0, total: file.size || 1 });
      updateProgress();
      xhr.upload.onprogress = (event) => {
        progress.set(key, {
          loaded: event.lengthComputable ? event.loaded : file.size,
          total: event.lengthComputable ? event.total : file.size || 1
        });
        updateProgress();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`upload_${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('upload_failed'));
      xhr.send(file);
    });
  }

  function decodedDataUrlBytes(dataUrl: string): number {
    const encoded = dataUrl.split(',', 2)[1] || '';
    return Math.floor((encoded.length * 3) / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  }

  async function extractUploadPreview(file: File): Promise<UploadPreview | null> {
    try {
      const bitmap = await createImageBitmap(file);
      const width = bitmap.width;
      const height = bitmap.height;
      if (!width || !height) {
        bitmap.close();
        return null;
      }

      const scale = Math.min(1, 20 / Math.max(width, height));
      const encode = (edgeScale: number, quality: number): string | null => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale * edgeScale));
        canvas.height = Math.max(1, Math.round(height * scale * edgeScale));
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', quality);
      };

      let blurDataUrl = encode(1, 0.35) || '';
      if (!blurDataUrl.startsWith('data:image/webp;base64,') || decodedDataUrlBytes(blurDataUrl) > 2 * 1024) {
        blurDataUrl = encode(0.7, 0.22) || '';
      }
      bitmap.close();
      if (!blurDataUrl.startsWith('data:image/webp;base64,') || decodedDataUrlBytes(blurDataUrl) > 2 * 1024) return null;
      return { width, height, blurDataUrl };
    } catch {
      return null;
    }
  }

  async function uploadViaSignedUrl(file: File, preview: UploadPreview | null): Promise<string> {
    const contentType = file.type || 'application/octet-stream';
    const signed = await apiFetch<SignResponse>('/api/upload/sign', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        contentType,
        width: preview?.width ?? null,
        height: preview?.height ?? null,
        blurDataUrl: preview?.blurDataUrl ?? null
      })
    });
    await putFile(signed.uploadUrl, file, signed.imageId, contentType);
    await apiFetch('/api/upload/notify', {
      method: 'POST',
      body: JSON.stringify({ imageId: signed.imageId })
    });
    return signed.imageId;
  }

  async function uploadOne(file: File): Promise<void> {
    const preview = await extractUploadPreview(file);
    const imageId = await uploadViaSignedUrl(file, preview);
    prependPending(imageId, file.name, preview);
  }

  async function uploadFiles(files: File[]): Promise<void> {
    const selected = imageFiles(files);
    if (selected.length === 0) return;
    if (!isAuthenticated() && !(await promptPin())) return;

    let cursor = 0;
    const workers = Array.from({ length: Math.min(2, selected.length) }, async () => {
      while (cursor < selected.length) {
        const file = selected[cursor];
        cursor += 1;
        await uploadOne(file).catch((err) => {
          console.warn('[upload] failed:', file.name, err);
          showToast('上传失败');
        });
      }
    });

    await Promise.all(workers);
    if (progress.size > 0) finishProgress();
  }

  uploadButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    void uploadFiles(Array.from(input.files || []));
    input.value = '';
  });

  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    overlay.classList.add('active');
  });

  window.addEventListener('dragleave', (event) => {
    if (event.target === document.body || event.clientX <= 0 || event.clientY <= 0) {
      overlay.classList.remove('active');
    }
  });

  window.addEventListener('drop', (event) => {
    event.preventDefault();
    overlay.classList.remove('active');
    if (event.dataTransfer?.files) void uploadFiles(Array.from(event.dataTransfer.files));
  });
}
