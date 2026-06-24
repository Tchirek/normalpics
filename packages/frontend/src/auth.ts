const TOKEN_KEY = 'ph_token';
const DELETE_TOKEN_KEY = 'ph_delete_token';
const API_BASE = (import.meta.env.VITE_WORKER_URL || '').replace(/\/$/, '');

let activePrompt: Promise<boolean> | null = null;

type PinPurpose = 'upload' | 'delete';

function decodePayload(token: string): { exp?: number } | null {
  try {
    const raw = token.split('.')[1];
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getDeleteToken(): string | null {
  return localStorage.getItem(DELETE_TOKEN_KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function saveDeleteToken(token: string): void {
  localStorage.setItem(DELETE_TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function tokenIsValid(token: string | null): boolean {
  if (!token) return false;
  const payload = decodePayload(token);
  if (!payload?.exp) return false;
  const expMs = payload.exp < 1_000_000_000_000 ? payload.exp * 1000 : payload.exp;
  return expMs > Date.now();
}

export function isAuthenticated(): boolean {
  return tokenIsValid(getToken());
}

export function isDeleteAuthenticated(): boolean {
  return tokenIsValid(getDeleteToken());
}

export async function promptPin(purpose: PinPurpose = 'upload'): Promise<boolean> {
  if (activePrompt) return activePrompt;

  const modal = document.getElementById('pin-modal');
  if (!modal) return false;

  activePrompt = new Promise<boolean>((resolve) => {
    modal.innerHTML = `
      <form class="pin-form">
        <input class="pin-input" type="password" inputmode="numeric" autocomplete="one-time-code" />
      </form>
    `;
    const form = modal.querySelector<HTMLFormElement>('.pin-form')!;
    const input = modal.querySelector<HTMLInputElement>('.pin-input')!;

    const finish = (ok: boolean) => {
      modal.classList.remove('visible');
      window.setTimeout(() => {
        modal.innerHTML = '';
        activePrompt = null;
      }, 220);
      resolve(ok);
    };

    const submit = async () => {
      const pin = input.value.trim();
      if (!pin) return;
      try {
        const response = await fetch(`${API_BASE}${purpose === 'delete' ? '/api/auth/delete' : '/api/auth'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        if (!response.ok) throw new Error('unauthorized');
        const body = await response.json() as { token: string };
        if (purpose === 'delete') saveDeleteToken(body.token);
        else saveToken(body.token);
        finish(true);
      } catch {
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        input.value = '';
        input.focus();
      }
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submit();
    });

    modal.classList.add('visible');
    window.setTimeout(() => input.focus(), 40);
  });

  return activePrompt;
}
