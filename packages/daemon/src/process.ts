import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CONFIG } from './config.js';
import { generateImageDerivatives, isBrowserFriendlyImage } from './image-convert.js';

export interface ProcessResult {
  width: number | null;
  height: number | null;
  sizeBytes: number;
  r2KeyWeb: string | null;
  r2KeyThumb: string | null;
  descriptionSourcePath: string | null;
  blurDataUrl: string | null;
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: CONFIG.r2.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: CONFIG.r2.accessKeyId,
    secretAccessKey: CONFIG.r2.secretAccessKey
  }
});

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

async function uploadFile(filePath: string, key: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: CONFIG.r2.bucketName,
    Key: key,
    Body: createReadStream(filePath),
    ContentType: mimeFor(filePath),
    CacheControl: 'public, max-age=31536000, immutable'
  }));
}

export async function processImage(srcPath: string, imageId: string): Promise<ProcessResult> {
  await mkdir(CONFIG.thumbnailDir, { recursive: true });
  const fileStat = await stat(srcPath);

  try {
    const thumbPath = path.join(CONFIG.thumbnailDir, `${imageId}_thumb.webp`);
    const webPath = path.join(CONFIG.thumbnailDir, `${imageId}_web.webp`);
    const r2KeyThumb = `thumb/${imageId}.webp`;
    const r2KeyWeb = `web/${imageId}.webp`;

    const meta = await generateImageDerivatives(srcPath, webPath, thumbPath);

    await Promise.all([
      uploadFile(thumbPath, r2KeyThumb),
      uploadFile(webPath, r2KeyWeb)
    ]);

    return {
      width: meta.width,
      height: meta.height,
      sizeBytes: fileStat.size,
      r2KeyWeb,
      r2KeyThumb,
      descriptionSourcePath: webPath,
      blurDataUrl: meta.blurDataUrl
    };
  } catch (err) {
    console.warn('[process] derivative generation failed, archiving original as web fallback:', err);
    const ext = path.extname(srcPath).toLowerCase() || '.bin';
    if (!isBrowserFriendlyImage(srcPath)) {
      return {
        width: null,
        height: null,
        sizeBytes: fileStat.size,
        r2KeyWeb: null,
        r2KeyThumb: null,
        descriptionSourcePath: null,
        blurDataUrl: null
      };
    }

    const fallbackPath = path.join(CONFIG.thumbnailDir, `${imageId}_web${ext}`);
    const r2KeyWeb = `web/${imageId}${ext}`;
    await copyFile(srcPath, fallbackPath);
    await uploadFile(fallbackPath, r2KeyWeb);

    return {
      width: null,
      height: null,
      sizeBytes: fileStat.size,
      r2KeyWeb,
      r2KeyThumb: null,
      descriptionSourcePath: null,
      blurDataUrl: null
    };
  }
}
