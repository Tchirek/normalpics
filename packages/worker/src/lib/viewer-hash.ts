const encoder = new TextEncoder();

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function commentProfileHash(secret: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `comment-profile:${viewerId}`);
}

export function imageLikeViewerKey(secret: string, imageId: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `image-like:${imageId}:${viewerId}`);
}

export function commentLikeViewerKey(secret: string, commentId: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `comment-like:${commentId}:${viewerId}`);
}

export function nicknameCooldownKey(secret: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `comment-nickname-cooldown:${viewerId}`);
}

export function rateLimitKey(secret: string, scope: string, value: string): Promise<string> {
  return hmacHex(secret, `rate:${scope}:${value}`);
}
