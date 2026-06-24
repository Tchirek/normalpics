import { CONFIG } from './config.js';
import { imageDataUrlForLlm } from './llm-image.js';
import { requestVisionMetadataCompletion } from './llm-request.js';
import { parseMetadata, type ImageMetadata } from './metadata-format.js';

export async function generateMetadata(imagePath: string): Promise<ImageMetadata | null> {
  try {
    if (!CONFIG.llm.visionCapable) return null;
    const imageDataUrl = await imageDataUrlForLlm(imagePath);
    if (!imageDataUrl) return null;

    const response = await requestVisionMetadataCompletion({
      baseUrl: CONFIG.llm.baseUrl,
      apiKey: CONFIG.llm.apiKey,
      model: CONFIG.llm.model,
      maxTokens: CONFIG.llm.maxTokens,
      prompt: CONFIG.llm.prompt,
      imageDataUrl,
      timeoutMs: CONFIG.llm.timeoutMs
    });

    const content = response.choices?.[0]?.message?.content?.trim();
    return content ? parseMetadata(content) : null;
  } catch (err) {
    console.warn('[LLM] metadata generation failed:', err);
    return null;
  }
}
