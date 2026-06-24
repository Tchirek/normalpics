import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const heicConvert = require('heic-convert') as (options: {
  buffer: Buffer;
  format: 'JPEG';
  quality: number;
}) => Promise<ArrayBuffer | Buffer | Uint8Array>;

export function isHeicPath(filePath: string): boolean {
  return ['.heic', '.heif'].includes(path.extname(filePath).toLowerCase());
}

export function isBrowserFriendlyImage(filePath: string): boolean {
  return ['.webp', '.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(filePath).toLowerCase());
}

async function heicToJpegBuffer(filePath: string): Promise<Buffer> {
  const input = await readFile(filePath);
  const output = await heicConvert({
    buffer: input,
    format: 'JPEG',
    quality: 0.92
  });
  return output instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(output))
    : Buffer.from(output);
}

export async function sharpInputForImage(filePath: string): Promise<string | Buffer> {
  if (!isHeicPath(filePath)) return filePath;
  try {
    return await heicToJpegBuffer(filePath);
  } catch {
    return filePath;
  }
}

function orientedDimensions(metadata: sharp.Metadata): { width: number | null; height: number | null } {
  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return {
    width: (swapsAxes ? metadata.height : metadata.width) ?? null,
    height: (swapsAxes ? metadata.width : metadata.height) ?? null
  };
}

async function blurBuffer(pipeline: sharp.Sharp, maxEdge = 20, quality = 35): Promise<Buffer> {
  const output = await pipeline
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4, smartSubsample: true })
    .toBuffer();
  if (output.length <= 2 * 1024) return output;
  return pipeline
    .resize(14, 14, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 24, effort: 4, smartSubsample: true })
    .toBuffer();
}

function blurDataUrl(buffer: Buffer): string {
  if (buffer.length > 2 * 1024) throw new Error(`blur_placeholder_too_large_${buffer.length}`);
  return `data:image/webp;base64,${buffer.toString('base64')}`;
}

export async function generateBlurData(
  sourcePath: string
): Promise<{ width: number | null; height: number | null; blurDataUrl: string }> {
  const input = await sharpInputForImage(sourcePath);
  const metadata = await sharp(input, { failOn: 'none' }).metadata();
  const placeholder = await blurBuffer(sharp(input, { failOn: 'none' }).rotate());
  return {
    ...orientedDimensions(metadata),
    blurDataUrl: blurDataUrl(placeholder)
  };
}

export async function generateImageDerivatives(
  sourcePath: string,
  webPath: string,
  thumbPath: string
): Promise<{ width: number | null; height: number | null; blurDataUrl: string }> {
  const input = await sharpInputForImage(sourcePath);
  const metadata = await sharp(input, { failOn: 'none' }).metadata();
  const base = sharp(input, { failOn: 'none' }).rotate();
  const [, , placeholder] = await Promise.all([
    base.clone()
      .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, smartSubsample: true })
      .toFile(webPath),
    base.clone()
      .resize(960, 960, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86, smartSubsample: true })
      .toFile(thumbPath),
    blurBuffer(base.clone())
  ]);

  return {
    ...orientedDimensions(metadata),
    blurDataUrl: blurDataUrl(placeholder)
  };
}

export async function writeBrowserWebp(
  sourcePath: string,
  targetPath: string,
  maxEdge: number,
  quality: number
): Promise<{ width: number | null; height: number | null }> {
  const input = await sharpInputForImage(sourcePath);
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, smartSubsample: true })
    .toFile(targetPath);

  return {
    ...orientedDimensions(meta)
  };
}
