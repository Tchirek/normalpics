import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type LocalIndex = Record<string, string>;

function indexPath(photoDir: string): string {
  return path.join(photoDir, '.cache', 'local-index.json');
}

function readIndex(photoDir: string): LocalIndex {
  const file = indexPath(photoDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as LocalIndex : {};
  } catch {
    return {};
  }
}

export function findRememberedLocalFile(photoDir: string, imageId: string): string | null {
  const filePath = readIndex(photoDir)[imageId];
  return filePath && existsSync(filePath) ? filePath : null;
}

export async function rememberLocalFile(photoDir: string, imageId: string, filePath: string): Promise<void> {
  const file = indexPath(photoDir);
  const next = readIndex(photoDir);
  next[imageId] = filePath;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
