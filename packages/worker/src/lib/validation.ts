export class JsonValidationError extends Error {
  constructor(message = 'invalid_json') {
    super(message);
  }
}

export interface JsonReader {
  json(): Promise<unknown>;
}

export async function readJsonRecord(request: JsonReader): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new JsonValidationError();
  }
  if (!isRecord(value)) throw new JsonValidationError('invalid_json_body');
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

export function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function nullableNumberField(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringArrayField(body: Record<string, unknown>, key: string, limit: number): string[] {
  const value = body[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}
