export interface VisionMetadataCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface VisionMetadataCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  prompt: string;
  imageDataUrl: string;
  timeoutMs: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function completionEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/$/, '');
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /model reloaded|timeout|fetch failed|econnreset|socket|502|503|504/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCompletion(value: unknown): VisionMetadataCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices)) return {};
  return {
    choices: value.choices.map((choice) => {
      if (!isRecord(choice) || !isRecord(choice.message)) return {};
      const content = choice.message.content;
      return {
        message: {
          content: typeof content === 'string' || content === null ? content : null
        }
      };
    })
  };
}

async function completionOnce(
  options: VisionMetadataCompletionOptions
): Promise<VisionMetadataCompletion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  const apiKey = options.apiKey.trim();
  if (apiKey && apiKey.toLowerCase() !== 'none') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(completionEndpoint(options.baseUrl), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: options.imageDataUrl }
            },
            { type: 'text', text: options.prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    return normalizeCompletion(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('LLM timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestVisionMetadataCompletion(
  options: VisionMetadataCompletionOptions
): Promise<VisionMetadataCompletion> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await completionOnce(options);
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !isRetryableLlmError(error)) break;
      await wait(1500);
    }
  }

  throw lastError;
}
