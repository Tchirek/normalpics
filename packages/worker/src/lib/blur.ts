const BLUR_PREFIX = 'data:image/webp;base64,';
const MAX_BLUR_BYTES = 2 * 1024;
const MAX_DIMENSION = 100_000;

export function normalizeDimension(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_DIMENSION) return null;
  return number;
}

export function normalizeBlurDataUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(BLUR_PREFIX)) return null;
  if (value.length > 4_096) return null;

  const encoded = value.slice(BLUR_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;

  try {
    const decoded = atob(encoded);
    if (decoded.length < 12 || decoded.length > MAX_BLUR_BYTES) return null;
    if (decoded.slice(0, 4) !== 'RIFF' || decoded.slice(8, 12) !== 'WEBP') return null;
    return `${BLUR_PREFIX}${encoded}`;
  } catch {
    return null;
  }
}
