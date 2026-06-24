interface GuiConfig {
  photoDir: string;
  autoStart: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmVisionCapable: boolean;
  llmMaxTokens: number;
  llmPrompt: string;
  llmTimeoutMs: number;
}

interface GuiState {
  config: GuiConfig;
  daemonRunning: boolean;
  startupEnabled: boolean;
  logs: string[];
}

interface LlmTestResult {
  ok: boolean;
  message: string;
  sample?: { description: string | null; tags: string[] };
}

interface MetadataBackfillResult {
  claimed: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface ManualSyncResult {
  ok: boolean;
  total: number;
  synced: number;
  failed: number;
}

declare global {
  interface Window {
    photohost: {
      getState: () => Promise<GuiState>;
      chooseDirectory: () => Promise<string | null>;
      saveConfig: (config: Partial<GuiConfig>) => Promise<GuiState>;
      testLlm: (config: Partial<GuiConfig>) => Promise<LlmTestResult>;
      backfillMetadata: (config: Partial<GuiConfig>) => Promise<MetadataBackfillResult>;
      syncMissing: () => Promise<ManualSyncResult>;
      setAutoStart: (enabled: boolean) => Promise<GuiState>;
      restartDaemon: () => Promise<GuiState>;
      openExternal: (url: string) => Promise<void>;
      openPath: (path: string) => Promise<void>;
      onState: (callback: (state: GuiState) => void) => () => void;
    };
  }
}

let state: GuiState | null = null;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function hasLog(pattern: RegExp): boolean {
  return Boolean(state?.logs.some((line) => pattern.test(line)));
}

function statusCopy(): { dot: string; text: string; summary: string } {
  if (!state?.daemonRunning) {
    return {
      dot: 'off',
      text: '未连接',
      summary: '同步服务未运行。点击重新连接即可恢复。'
    };
  }

  if (hasLog(/\[tunnel\] published/i)) {
    return {
      dot: 'on',
      text: '已就绪',
      summary: '本地同步已启动，图库会自动读取这台电脑上的图片。'
    };
  }

  if (hasLog(/\[heartbeat\] failed|\[tunnel\] exited|failed/i)) {
    return {
      dot: 'wait',
      text: '正在重连',
      summary: '同步服务已启动，正在重新建立网络连接。通常会自动恢复。'
    };
  }

  return {
    dot: 'wait',
    text: '正在连接',
    summary: '同步服务已启动，正在连接云端。'
  };
}

function setValue(id: string, value: string | number): void {
  el<HTMLInputElement | HTMLTextAreaElement>(id).value = String(value);
}

function renderLlmSettings(): void {
  if (!state) return;
  setValue('llmBaseUrl', state.config.llmBaseUrl);
  setValue('llmApiKey', state.config.llmApiKey);
  setValue('llmModel', state.config.llmModel);
  setValue('llmMaxTokens', state.config.llmMaxTokens);
  setValue('llmTimeoutMs', state.config.llmTimeoutMs);
  setValue('llmPrompt', state.config.llmPrompt);
  el<HTMLInputElement>('llmVisionCapable').checked = state.config.llmVisionCapable;
}

function render(next: GuiState): void {
  state = next;
  const copy = statusCopy();
  el('statusDot').className = `dot ${copy.dot}`;
  el('statusText').textContent = copy.text;
  el('summary').textContent = copy.summary;
  el('photoDirText').textContent = state.config.photoDir;
  el('startupState').textContent = state.startupEnabled ? '已开启' : '未开启';
  el<HTMLInputElement>('autoStart').checked = state.config.autoStart;
  renderLlmSettings();
}

async function refresh(): Promise<void> {
  render(await window.photohost.getState());
}

function readLlmConfig(): Partial<GuiConfig> {
  return {
    llmVisionCapable: el<HTMLInputElement>('llmVisionCapable').checked,
    llmBaseUrl: el<HTMLInputElement>('llmBaseUrl').value.trim(),
    llmApiKey: el<HTMLInputElement>('llmApiKey').value.trim() || 'ollama',
    llmModel: el<HTMLInputElement>('llmModel').value.trim(),
    llmMaxTokens: Number(el<HTMLInputElement>('llmMaxTokens').value || 180),
    llmTimeoutMs: Number(el<HTMLInputElement>('llmTimeoutMs').value || 30000),
    llmPrompt: el<HTMLTextAreaElement>('llmPrompt').value.trim()
  };
}

function setInlineStatus(text: string, tone: 'idle' | 'ok' | 'bad' = 'idle'): void {
  const status = el('llmStatus');
  status.textContent = text;
  status.className = `inline-status ${tone}`;
}

function bind(): void {
  el('choosePhotoDir').addEventListener('click', async () => {
    const selected = await window.photohost.chooseDirectory();
    if (!selected) return;
    render(await window.photohost.saveConfig({ photoDir: selected }));
  });

  el('restart').addEventListener('click', async () => {
    el('statusText').textContent = '正在重连';
    render(await window.photohost.restartDaemon());
  });

  el('autoStart').addEventListener('change', async () => {
    render(await window.photohost.setAutoStart(el<HTMLInputElement>('autoStart').checked));
  });

  el('openPhotos').addEventListener('click', () => {
    if (state) void window.photohost.openPath(state.config.photoDir);
  });

  el('openWeb').addEventListener('click', () => {
    void window.photohost.openExternal('https://pics.example.com');
  });

  el('syncMissing').addEventListener('click', async () => {
    el<HTMLButtonElement>('syncMissing').disabled = true;
    setInlineStatus('正在同步缺失图片...');
    try {
      const result = await window.photohost.syncMissing();
      const text = result.total === 0
        ? '本地图库已完整'
        : `发现 ${result.total}，已同步 ${result.synced}，失败 ${result.failed}`;
      setInlineStatus(text, result.failed > 0 ? 'bad' : 'ok');
    } catch (err) {
      setInlineStatus(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      el<HTMLButtonElement>('syncMissing').disabled = false;
      void refresh();
    }
  });

  el('saveAdvanced').addEventListener('click', async () => {
    render(await window.photohost.saveConfig(readLlmConfig()));
    setInlineStatus('已保存', 'ok');
  });

  el('testLlm').addEventListener('click', async () => {
    setInlineStatus('测试中...');
    const result = await window.photohost.testLlm(readLlmConfig());
    const sample = result.sample?.tags?.length ? ` ${result.sample.tags.join(' ')}` : '';
    setInlineStatus(result.ok ? `${result.message}${sample}` : result.message, result.ok ? 'ok' : 'bad');
  });

  el('backfillMetadata').addEventListener('click', async () => {
    setInlineStatus('检查中...');
    const result = await window.photohost.backfillMetadata(readLlmConfig());
    const text = `领取 ${result.claimed}，写入 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`;
    setInlineStatus(text, result.failed > 0 ? 'bad' : 'ok');
  });

  window.photohost.onState(render);
}

bind();
void refresh();

export {};
