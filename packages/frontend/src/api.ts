import { getToken } from './auth';

export const API_BASE = (import.meta.env.VITE_WORKER_URL || '').replace(/\/$/, '');

export function assetUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(assetUrl(path), {
    ...init,
    headers
  });
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiRequest(path, init);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json() as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
