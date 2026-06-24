import type { Env } from '../types';

const TRUSTED_DYNAMIC_SUFFIXES = [
  '.trycloudflare.com',
  '.ngrok-free.app',
  '.ngrok.io',
  '.loca.lt'
];

function splitOrigins(value?: string | null): string[] {
  return (value || '')
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function originOf(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function configuredTunnelOrigins(env: Env): Set<string> {
  const origins = new Set<string>();
  for (const value of [env.TUNNEL_URL, ...splitOrigins(env.DAEMON_TUNNEL_ORIGINS)]) {
    const origin = originOf(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost'
    || host === '::1'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
  ) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return (
      a === 0
      || a === 10
      || a === 127
      || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168
      || a === 100 && b >= 64 && b <= 127
      || a === 198 && (b === 18 || b === 19)
    );
  }

  if (!host.includes(':')) return false;
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
}

function isTrustedDynamicTunnel(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TRUSTED_DYNAMIC_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export function normalizeTrustedTunnelOrigin(env: Env, value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443') return null;
  if (isPrivateOrLocalHostname(parsed.hostname)) return null;

  const origin = parsed.origin;
  if (configuredTunnelOrigins(env).has(origin)) return origin;
  if (isTrustedDynamicTunnel(parsed.hostname)) return origin;
  return null;
}
