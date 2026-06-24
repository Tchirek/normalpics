export interface ImageMetadata {
  description: string | null;
  tags: string[];
}

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value
    .trim()
    .replace(/^#+/, '')
    .replace(/[\s#,.;:\uFF0C\u3002\uFF1B\uFF1A\u3001]+/g, '')
    .slice(0, 24);
  return body ? `#${body}` : null;
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^\u8fd9(\u5f20|\u5e45)?(\u7167\u7247|\u56fe\u7247|\u56fe\u50cf|\u753b\u9762|\u63d2\u753b)(\u4e3b\u8981)?(\u63cf\u7ed8\u4e86|\u5c55\u793a\u4e86|\u5448\u73b0\u4e86|\u6355\u6349\u4e86|\u8bb0\u5f55\u4e86|\u662f|\u4e3a)?\s*/, '')
    .replace(/[\u3002.!\uFF01\uFF1F?]+$/g, '');
  return compact.slice(0, 140) || null;
}

export function parseMetadata(content: string): ImageMetadata {
  const raw = stripJsonFence(content);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as { description?: unknown; tags?: unknown };
    const description = normalizeDescription(record.description);
    const seen = new Set<string>();
    const tags = Array.isArray(record.tags)
      ? record.tags
        .map(normalizeTag)
        .filter((tag): tag is string => Boolean(tag))
        .filter((tag) => {
          if (seen.has(tag)) return false;
          seen.add(tag);
          return true;
        })
        .slice(0, 4)
      : [];
    return { description, tags };
  }

  return {
    description: normalizeDescription(raw),
    tags: []
  };
}
