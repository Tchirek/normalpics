import { createWriteStream, existsSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { imageDataUrlForLlm, createLlmTestJpeg } from '../llm-image.js';
import { requestVisionMetadataCompletion } from '../llm-request.js';
import { findRememberedLocalFile } from '../local-index.js';
import { parseMetadata, type ImageMetadata } from '../metadata-format.js';

export interface MetadataGuiConfig {
  workerUrl: string;
  daemonSecret: string;
  deviceId: string;
  deviceName: string;
  photoDir: string;
  thumbnailDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmVisionCapable: boolean;
  llmMaxTokens: number;
  llmPrompt: string;
  llmTimeoutMs: number;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
  sample?: ImageMetadata;
}

export interface MetadataBackfillResult {
  claimed: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface MetadataClaimItem {
  id: string;
  imageId?: string;
  filename?: string | null;
  hasDescription?: boolean;
  needsDescriptionRepair?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMetadataClaimItems(value: unknown): MetadataClaimItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items
    .filter((item): item is Record<string, unknown> => {
      if (!isRecord(item)) return false;
      const id = item.id ?? item.imageId;
      return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
    })
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : String(item.imageId),
      imageId: typeof item.imageId === 'string' ? item.imageId : undefined,
      filename: typeof item.filename === 'string' ? item.filename : null,
      hasDescription: typeof item.hasDescription === 'boolean' ? item.hasDescription : undefined,
      needsDescriptionRepair: typeof item.needsDescriptionRepair === 'boolean'
        ? item.needsDescriptionRepair
        : undefined
    }));
}

function daemonHeaders(config: MetadataGuiConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Daemon-Secret': config.daemonSecret,
    'X-Device-Id': config.deviceId,
    'X-Device-Name': config.deviceName
  };
}

function extFor(contentType: string | null, filename?: string | null): string {
  const normalized = (contentType || '').toLowerCase();
  if (normalized.includes('image/webp')) return '.webp';
  if (normalized.includes('image/png')) return '.png';
  if (normalized.includes('image/jpeg') || normalized.includes('image/jpg')) return '.jpg';
  const ext = path.extname(filename || '').toLowerCase();
  return ext || '.webp';
}

async function requestMetadata(config: MetadataGuiConfig, imagePath: string): Promise<ImageMetadata | null> {
  if (!config.llmVisionCapable) return null;
  const imageDataUrl = await imageDataUrlForLlm(imagePath);
  if (!imageDataUrl) return null;

  const response = await requestVisionMetadataCompletion({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey || 'ollama',
    model: config.llmModel,
    maxTokens: config.llmMaxTokens,
    prompt: config.llmPrompt,
    imageDataUrl,
    timeoutMs: config.llmTimeoutMs
  });

  const content = response.choices?.[0]?.message?.content?.trim();
  return content ? parseMetadata(content) : null;
}

export async function testLlmConnection(config: MetadataGuiConfig): Promise<LlmTestResult> {
  if (!config.llmVisionCapable) {
    return { ok: false, message: '视觉标注未开启' };
  }

  const testPath = path.join(config.thumbnailDir, `llm-test-${Date.now()}.jpg`);
  try {
    await mkdir(config.thumbnailDir, { recursive: true });
    await createLlmTestJpeg(testPath);
    const sample = await requestMetadata(config, testPath);
    if (!sample) return { ok: false, message: '模型未返回可解析结果' };
    return { ok: true, message: 'LLM 可用', sample };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      if (existsSync(testPath)) unlinkSync(testPath);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function claimMetadataItems(config: MetadataGuiConfig, limit: number): Promise<MetadataClaimItem[]> {
  const response = await fetch(`${config.workerUrl}/api/sync/metadata/claim`, {
    method: 'POST',
    headers: daemonHeaders(config),
    body: JSON.stringify({ limit, deviceName: config.deviceName, repairTruncated: true })
  });
  if (!response.ok) throw new Error(`metadata_claim_${response.status}`);
  return parseMetadataClaimItems(await response.json());
}

function cachedSourcePath(config: MetadataGuiConfig, item: MetadataClaimItem): string | null {
  const id = item.id || item.imageId;
  if (!id) return null;
  const candidates = [
    path.join(config.thumbnailDir, `${id}_web.webp`),
    path.join(config.thumbnailDir, `${id}_web.jpg`),
    path.join(config.thumbnailDir, `${id}_web.jpeg`),
    path.join(config.thumbnailDir, `${id}_web.png`),
    path.join(config.thumbnailDir, `${id}_metadata_source.webp`),
    path.join(config.thumbnailDir, `${id}_metadata_source.jpg`),
    path.join(config.thumbnailDir, `${id}_metadata_source.png`),
    findRememberedLocalFile(config.photoDir, id)
  ].filter((file): file is string => Boolean(file));
  return candidates.find((file) => existsSync(file)) || null;
}

async function downloadSource(config: MetadataGuiConfig, item: MetadataClaimItem): Promise<string> {
  const id = item.id || item.imageId;
  if (!id) throw new Error('missing_image_id');
  await mkdir(config.thumbnailDir, { recursive: true });

  const response = await fetch(`${config.workerUrl}/api/sync/download/${encodeURIComponent(id)}`, {
    headers: daemonHeaders(config),
    redirect: 'follow'
  });
  if (!response.ok || !response.body) throw new Error(`metadata_download_${response.status}`);

  const target = path.join(config.thumbnailDir, `${id}_metadata_source${extFor(response.headers.get('Content-Type'), item.filename)}`);
  const writer = createWriteStream(target);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!writer.write(value)) await once(writer, 'drain');
    }
  } finally {
    writer.end();
  }

  await once(writer, 'finish');
  return target;
}

async function sourcePathFor(config: MetadataGuiConfig, item: MetadataClaimItem): Promise<string> {
  return cachedSourcePath(config, item) || downloadSource(config, item);
}

async function confirmMetadata(config: MetadataGuiConfig, imageId: string, metadata: ImageMetadata): Promise<void> {
  const response = await fetch(`${config.workerUrl}/api/sync/confirm`, {
    method: 'POST',
    headers: daemonHeaders(config),
    body: JSON.stringify({
      imageId,
      description: metadata.description,
      tags: metadata.tags,
      llmModel: config.llmModel,
      replaceMetadata: true
    })
  });
  if (!response.ok) throw new Error(`metadata_confirm_${response.status}`);
}

export async function backfillMissingMetadata(
  config: MetadataGuiConfig,
  limit = 12
): Promise<MetadataBackfillResult> {
  const items = await claimMetadataItems(config, limit);
  const result: MetadataBackfillResult = {
    claimed: items.length,
    updated: 0,
    skipped: 0,
    failed: 0
  };

  for (const item of items) {
    const id = item.id || item.imageId;
    if (!id) {
      result.skipped += 1;
      continue;
    }

    try {
      const imagePath = await sourcePathFor(config, item);
      const metadata = await requestMetadata(config, imagePath);
      if (!metadata || (!metadata.description && metadata.tags.length === 0)) {
        result.skipped += 1;
        continue;
      }
      await confirmMetadata(config, id, metadata);
      result.updated += 1;
    } catch (err) {
      console.warn('[metadata] backfill failed:', id, err);
      result.failed += 1;
    }
  }

  return result;
}
