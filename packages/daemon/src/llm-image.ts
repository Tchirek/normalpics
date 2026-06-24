import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX_LLM_JPEG_BYTES = 160 * 1024 * 1024;
const MAX_LLM_EDGE = 1280;

export async function imageDataUrlForLlm(imagePath: string): Promise<string | null> {
  try {
    const metadata = await sharp(imagePath, {
      failOn: 'none',
      limitInputPixels: 512 * 512 * 1024
    }).metadata();

    const estimatedPixels = (metadata.width || 0) * (metadata.height || 0);
    if (estimatedPixels > 512 * 512 * 1024) return null;

    const jpeg = await sharp(imagePath, {
      failOn: 'none',
      limitInputPixels: 512 * 512 * 1024
    })
      .rotate()
      .resize(MAX_LLM_EDGE, MAX_LLM_EDGE, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality: 86,
        mozjpeg: true
      })
      .toBuffer();

    if (jpeg.length > MAX_LLM_JPEG_BYTES) return null;
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function createLlmTestJpeg(targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  const testScene = Buffer.from(`
    <svg width="640" height="420" viewBox="0 0 640 420" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="420" fill="#dfeaf2"/>
      <rect y="260" width="640" height="160" fill="#d8d0bf"/>
      <circle cx="510" cy="90" r="42" fill="#f3c96b"/>
      <path d="M0 265 L160 120 L330 265 Z" fill="#7d8b83"/>
      <path d="M210 265 L390 105 L640 265 Z" fill="#596d76"/>
      <path d="M0 315 C130 280 225 350 355 315 C460 285 540 305 640 292 L640 420 L0 420 Z" fill="#a0a88f"/>
      <rect x="82" y="238" width="70" height="58" rx="4" fill="#8f5f4a"/>
      <path d="M72 242 L117 205 L162 242 Z" fill="#63463e"/>
      <path d="M430 316 C470 270 535 268 572 318" fill="none" stroke="#3d4948" stroke-width="8" stroke-linecap="round"/>
    </svg>
  `);

  await sharp(testScene)
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(targetPath);
}
