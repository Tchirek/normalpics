import type { BrowserWindow as BrowserWindowInstance, NativeImage, Tray as TrayInstance } from 'electron';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DEFAULT_GUI_CONFIG } from './defaults.js';
import { backfillMissingMetadata, testLlmConnection } from './metadata.js';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require('electron') as typeof import('electron');

interface GuiConfig {
  workerUrl: string;
  daemonSecret: string;
  deviceId: string;
  deviceName: string;
  deviceFingerprint: string;
  photoDir: string;
  thumbnailDir: string;
  localPort: number;
  tunnelEnabled: boolean;
  tunnelPublicUrl: string;
  tunnelToken: string;
  tunnelName: string;
  quickTunnel: boolean;
  tunnelLogLevel: string;
  r2Endpoint: string;
  r2BucketName: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmVisionCapable: boolean;
  llmMaxTokens: number;
  llmPrompt: string;
  llmTimeoutMs: number;
  syncConcurrency: number;
  processConcurrency: number;
  autoStart: boolean;
}

interface GuiState {
  config: GuiConfig;
  daemonRunning: boolean;
  startupEnabled: boolean;
  configPath: string;
  portableDir: string;
  logs: string[];
}

interface ManualSyncResult {
  ok: boolean;
  total: number;
  synced: number;
  failed: number;
}

function parseManualSyncResult(value: unknown): ManualSyncResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync_now_invalid_response');
  }
  const record = value as Record<string, unknown>;
  const total = Number(record.total);
  const synced = Number(record.synced);
  const failed = Number(record.failed);
  if (![total, synced, failed].every(Number.isFinite)) {
    throw new Error('sync_now_invalid_response');
  }
  return {
    ok: Boolean(record.ok),
    total,
    synced,
    failed
  };
}

const isDaemonChild = process.argv.includes('--daemon-child');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..');
const portableDir = app.isPackaged
  ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
  : packageDir;
const configPath = path.join(portableDir, 'photohost-daemon.config.json');
const bootLogPath = path.join(portableDir, 'normalpics-sync.log');
const logs: string[] = [];

let mainWindow: BrowserWindowInstance | null = null;
let tray: TrayInstance | null = null;
let daemonProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let config: GuiConfig;
let isQuitting = false;
let intentionalStop = false;

const APP_NAME = 'NormalPics Sync';
const ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAOWSURBVHhe7VshcOMwEAx8+CSTxAF5WFj48OHDmBUGBgZ2JiQssPBhwwIDCztBhYGFmaDCwof+vf/L11YvlmRLspzxzuxk2uiku5V0PstOr0OHDh2awHg8/qGSv7ouTCaTr0mSzEaj0RafRzAzILXbgfN+vz/krtoDchoBLxDAMwdUi+jrAK7AGx4iTvBsr+HobzUIV0Tf2yhXBRxbgO+S067JAq9JcB6+OSB5fYczpnvbNd/AO3YlPDD43Odyt+ADuxQGWHpfEPgvwZEmuQuyJWgQBP8iOBADXweDwTd21T145mMN/syjt5UQ4bK/xGeaLHbbDRA8FTbSYLHSXWKkOh0CxJDtbTnnEKqDlhI6ouutNEDUpEmrXTW2cOkXCP8fORR78E1NkPLWM285JDvA8EHpqK3ccUjm4NlvY+K7RLtVgOBXQietpXUugEHsFZ8t3zg0PaieFjpoPenWnUMsBxrPVeNaXO6zPE6bVGiXZpsTNwD2S/V7J1xziOVAwyfFsB4VASBBtknVdkEEeOUQy+H82v9JAOC0ydJCuyACZNqbJC59RePKlAQAikGGEUB7XuAlAeYF2O+zj7/22fJ/uzACaB/AUAPJsBYLAiyztBgptwsjAFh+iEoNFIP6zAvwd+9LwYYRAPltwaHKQCO3l0DiJwHwv3SDa8EZtBWCCbDiUGWg0Uw1qk1JAFDdCsWdovThiBDgnkOV4T0HFC5/+Vk/ZacAKwCccagyoNCNYFSPFwUAC1vhA74E0F4F6EhZMqzFMgHAwlZgeNwC+ifMaOT2HEAjQJIsc7XBP/gSgCaYw7wMCOD2VlgrgNIG8CSA2S0xBLiqw5AzEZfZoQga36rG10AIMOUQ9YBBU8/8vZDymvZOMA8YtOU5oCmfODQzeCmImmV5ASQBRm5PhhoiVvPBavmfAeOrSIZWyU8FjB+lTttCmn0OpRra/oRIW/ubAALcS53HTlq9HEJ9oDN611ccKEbC35dKie8SqDN0epAGi5BHL6/T8olx1G+LYJIoX1V7H8AE1DkGifKlCQp+OBz+ZFf9gVZChNuBVqa/mVdBBwsYkH7UIDkTlDQZXva8CeDAWnUoJBH81mm2rwI4QiVz0PsGmvUg+90GVHUFyA10TtHcbwRMABGmcHKHT5clNP3+aN74crcBF09TkG6orOoH2LyDVH3eUcLlLtsNunzSNuGtQr8CK/D8nfYZfocOHdyg1/sDJn/ZErhWkrgAAAAASUVORK5CYII=';

if (!isDaemonChild) {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('top.tchirek.normalpics.sync');
  bootLog('[gui] process start');
  process.on('uncaughtException', (err) => bootLog(`[uncaught] ${stackOf(err)}`));
  process.on('unhandledRejection', (err) => bootLog(`[unhandled] ${stackOf(err)}`));
}

if (isDaemonChild) {
  runDaemonChild().catch((err) => {
    console.error('[gui-child] failed:', err);
    process.exit(1);
  });
} else {
  const lock = app.requestSingleInstanceLock();
  if (!lock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    app.whenReady().then(startGui).catch((err) => {
      bootLog(`[gui] failed: ${stackOf(err)}`);
      console.error('[gui] failed:', err);
      app.quit();
    });
  }
}

async function runDaemonChild(): Promise<void> {
  const { startDaemonRuntime } = await import('../runtime.js');
  const runtime = await startDaemonRuntime();

  const shutdown = () => {
    runtime.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startGui(): Promise<void> {
  bootLog('[gui] ready');
  config = loadConfig();
  Menu.setApplicationMenu(null);
  applyStartup(config.autoStart);
  registerIpc();
  createWindow();
  createTray();
  startDaemon();
}

function createWindow(): void {
  bootLog('[gui] create window');
  mainWindow = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 680,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: '#f7f6f3',
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  void mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    void mainWindow?.webContents.executeJavaScript('Boolean(window.photohost)').then((ready) => {
      appendLog(`[gui] bridge ${ready ? 'ready' : 'missing'}`);
    }).catch((err) => appendLog(`[gui] bridge check failed ${stackOf(err)}`));
  });
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    appendLog(`[renderer] ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendLog(`[gui] renderer gone ${details.reason}`);
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  bootLog('[gui] create tray');
  tray = new Tray(appIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 NormalPics Sync', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: '重新连接', click: () => restartDaemon() },
    { label: '退出', click: () => quitApp() }
  ]));
}

function appIcon(): NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(ICON_PNG_BASE64, 'base64'));
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('directory:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择本地图片目录',
      defaultPath: config.photoDir,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('config:save', (_event, next: Partial<GuiConfig>) => {
    if (next.photoDir && !next.thumbnailDir) {
      next.thumbnailDir = path.join(next.photoDir, '.cache', 'thumbs');
    }
    config = normalizeConfig({ ...config, ...next });
    saveConfig(config);
    applyStartup(config.autoStart);
    restartDaemon();
    broadcastState();
    return getState();
  });
  ipcMain.handle('llm:test', async (_event, next: Partial<GuiConfig>) => {
    const testConfig = normalizeConfig({ ...config, ...next });
    return testLlmConnection(testConfig);
  });
  ipcMain.handle('metadata:backfill', async (_event, next: Partial<GuiConfig>) => {
    const runConfig = normalizeConfig({ ...config, ...next });
    const result = await backfillMissingMetadata(runConfig, 12);
    appendLog(`[metadata] claimed=${result.claimed} updated=${result.updated} skipped=${result.skipped} failed=${result.failed}`);
    return result;
  });
  ipcMain.handle('sync:missing', async () => {
    if (!daemonProcess) startDaemon();
    const result = await runManualSync();
    appendLog(`[sync] manual total=${result.total} synced=${result.synced} failed=${result.failed}`);
    return result;
  });
  ipcMain.handle('startup:set', (_event, enabled: boolean) => {
    config.autoStart = enabled;
    saveConfig(config);
    applyStartup(enabled);
    broadcastState();
    return getState();
  });
  ipcMain.handle('daemon:start', () => {
    startDaemon();
    return getState();
  });
  ipcMain.handle('daemon:stop', () => {
    stopDaemon();
    return getState();
  });
  ipcMain.handle('daemon:restart', () => {
    restartDaemon();
    return getState();
  });
  ipcMain.handle('open:external', (_event, url: string) => shell.openExternal(url));
  ipcMain.handle('open:path', (_event, targetPath: string) => shell.openPath(targetPath));
}

function startDaemon(): void {
  if (daemonProcess) return;
  intentionalStop = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const env = buildDaemonEnv(config);
  const args = app.isPackaged
    ? ['--daemon-child']
    : [path.join(packageDir, 'dist', 'gui', 'main.js'), '--daemon-child'];

  appendLog('[gui] starting daemon');
  bootLog('[gui] starting daemon');
  daemonProcess = spawn(process.execPath, args, {
    env,
    cwd: packageDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const runningProcess = daemonProcess;
  runningProcess.stdout.on('data', (chunk) => appendLog(chunk.toString()));
  runningProcess.stderr.on('data', (chunk) => appendLog(chunk.toString()));
  runningProcess.on('exit', (code, signal) => {
    appendLog(`[gui] daemon exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    daemonProcess = null;
    broadcastState();
    if (!isQuitting && !intentionalStop) {
      restartTimer = setTimeout(() => {
        appendLog('[gui] reconnecting daemon');
        startDaemon();
      }, 2500);
    }
  });
  broadcastState();
}

function stopDaemon(): void {
  intentionalStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!daemonProcess) return;
  appendLog('[gui] stopping daemon');
  daemonProcess.kill('SIGTERM');
  daemonProcess = null;
  broadcastState();
}

function restartDaemon(): void {
  stopDaemon();
  restartTimer = setTimeout(startDaemon, 800);
}

async function runManualSync(): Promise<ManualSyncResult> {
  const endpoint = `http://127.0.0.1:${config.localPort}/sync-now`;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 18; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      if (!response.ok) throw new Error(`sync_now_${response.status}`);
      return parseManualSyncResult(await response.json());
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function quitApp(): void {
  isQuitting = true;
  stopDaemon();
  app.quit();
}

function getState(): GuiState {
  return {
    config,
    daemonRunning: Boolean(daemonProcess),
    startupEnabled: app.getLoginItemSettings().openAtLogin,
    configPath,
    portableDir,
    logs
  };
}

function broadcastState(): void {
  mainWindow?.webContents.send('state:update', getState());
}

function appendLog(text: string): void {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) logs.push(line);
  while (logs.length > 500) logs.shift();
  bootLog(text);
  broadcastState();
}

function bootLog(text: string): void {
  try {
    mkdirSync(path.dirname(bootLogPath), { recursive: true });
    appendFileSync(bootLogPath, `${new Date().toISOString()} ${text.trim()}\n`, 'utf8');
  } catch {
    // Logging must never affect startup.
  }
}

function stackOf(err: unknown): string {
  return err instanceof Error ? err.stack || err.message : String(err);
}

function buildDaemonEnv(current: GuiConfig): NodeJS.ProcessEnv {
  const cloudflaredPath = bundledCloudflaredPath();
  const bundledTunnel = detectBundledTunnelCredentials();
  const quickTunnel = current.quickTunnel || (app.isPackaged && !current.tunnelToken && !bundledTunnel.credentialsFile);
  const useBundledCloudflared = Boolean(current.tunnelToken || quickTunnel || bundledTunnel.credentialsFile);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return {
    ...env,
    WORKER_URL: current.workerUrl,
    DAEMON_SECRET: current.daemonSecret,
    DEVICE_ID: current.deviceId,
    DEVICE_NAME: current.deviceName,
    PHOTO_DIR: current.photoDir,
    THUMBNAIL_DIR: current.thumbnailDir,
    LOCAL_SERVER_PORT: String(current.localPort),
    TUNNEL_ENABLED: String(current.tunnelEnabled),
    TUNNEL_PUBLIC_URL: quickTunnel ? '' : current.tunnelPublicUrl,
    CLOUDFLARED_RUNNER: useBundledCloudflared ? 'cloudflared' : 'wrangler',
    CLOUDFLARED_COMMAND: useBundledCloudflared && existsSync(cloudflaredPath) ? cloudflaredPath : 'npx',
    CLOUDFLARED_CREDENTIALS_FILE: bundledTunnel.credentialsFile,
    CLOUDFLARED_ORIGIN_CERT: bundledTunnel.originCert,
    CLOUDFLARED_TUNNEL_TOKEN: current.tunnelToken,
    CLOUDFLARED_TUNNEL_NAME: current.tunnelToken ? '' : current.tunnelName,
    CLOUDFLARED_QUICK_TUNNEL: String(quickTunnel),
    CLOUDFLARED_LOG_LEVEL: current.tunnelLogLevel,
    R2_ENDPOINT: current.r2Endpoint,
    R2_BUCKET_NAME: current.r2BucketName,
    R2_ACCESS_KEY_ID: current.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: current.r2SecretAccessKey,
    LLM_BASE_URL: current.llmBaseUrl,
    LLM_API_KEY: current.llmApiKey,
    LLM_MODEL: current.llmModel,
    LLM_VISION_CAPABLE: String(current.llmVisionCapable),
    LLM_MAX_TOKENS: String(current.llmMaxTokens),
    LLM_PROMPT: current.llmPrompt,
    LLM_TIMEOUT_MS: String(current.llmTimeoutMs),
    SYNC_CONCURRENCY: String(current.syncConcurrency),
    PROCESS_CONCURRENCY: String(current.processConcurrency)
  };
}

function bundledCloudflaredPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'cloudflared.exe')
    : path.join(packageDir, 'bin', 'cloudflared.exe');
}

function detectBundledTunnelCredentials(): { credentialsFile: string; originCert: string } {
  const credentialsCandidates = [
    path.join(portableDir, 'cloudflared', 'photohost.json'),
    path.join(portableDir, 'cloudflared', 'credentials.json'),
    path.join(packageDir, 'cloudflared', 'photohost.json'),
    path.join(packageDir, 'cloudflared', 'credentials.json')
  ];
  const certCandidates = [
    path.join(portableDir, 'cloudflared', 'cert.pem'),
    path.join(packageDir, 'cloudflared', 'cert.pem')
  ];

  return {
    credentialsFile: credentialsCandidates.find((file) => existsSync(file)) || '',
    originCert: certCandidates.find((file) => existsSync(file)) || ''
  };
}

function loadConfig(): GuiConfig {
  if (existsSync(configPath)) {
    try {
      const loaded = normalizeConfig(JSON.parse(readFileSync(configPath, 'utf8')) as Partial<GuiConfig>);
      saveConfig(loaded);
      return loaded;
    } catch (err) {
      bootLog(`[gui] config unreadable, rebuilding defaults: ${stackOf(err)}`);
    }
  }

  const seeded = normalizeConfig(seedFromEnv());
  saveConfig(seeded);
  return seeded;
}

function saveConfig(next: GuiConfig): void {
  mkdirSync(portableDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function seedFromEnv(): Partial<GuiConfig> {
  const envPath = path.join(packageDir, '.env');
  const env = !app.isPackaged && existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  const photoDir = env.PHOTO_DIR || defaultPhotoDir();

  return {
    workerUrl: normalizeWorkerUrl(env.WORKER_URL),
    daemonSecret: env.DAEMON_SECRET || DEFAULT_GUI_CONFIG.daemonSecret,
    deviceId: env.DEVICE_ID || createDeviceId(),
    deviceName: env.DEVICE_NAME || defaultDeviceName(),
    deviceFingerprint: currentDeviceFingerprint(),
    photoDir,
    thumbnailDir: env.THUMBNAIL_DIR || path.join(photoDir, '.cache', 'thumbs'),
    localPort: Number(env.LOCAL_SERVER_PORT || 18080),
    tunnelEnabled: env.TUNNEL_ENABLED ? env.TUNNEL_ENABLED !== 'false' : DEFAULT_GUI_CONFIG.tunnelEnabled,
    tunnelPublicUrl: env.TUNNEL_PUBLIC_URL || DEFAULT_GUI_CONFIG.tunnelPublicUrl,
    tunnelToken: env.CLOUDFLARED_TUNNEL_TOKEN || DEFAULT_GUI_CONFIG.tunnelToken,
    tunnelName: env.CLOUDFLARED_TUNNEL_NAME || DEFAULT_GUI_CONFIG.tunnelName,
    quickTunnel: env.CLOUDFLARED_QUICK_TUNNEL ? env.CLOUDFLARED_QUICK_TUNNEL === 'true' : DEFAULT_GUI_CONFIG.quickTunnel,
    tunnelLogLevel: env.CLOUDFLARED_LOG_LEVEL || DEFAULT_GUI_CONFIG.tunnelLogLevel,
    r2Endpoint: env.R2_ENDPOINT || DEFAULT_GUI_CONFIG.r2Endpoint,
    r2BucketName: env.R2_BUCKET_NAME || DEFAULT_GUI_CONFIG.r2BucketName,
    r2AccessKeyId: env.R2_ACCESS_KEY_ID || DEFAULT_GUI_CONFIG.r2AccessKeyId,
    r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY || DEFAULT_GUI_CONFIG.r2SecretAccessKey,
    llmBaseUrl: normalizeLlmBaseUrl(env.LLM_BASE_URL),
    llmApiKey: env.LLM_API_KEY || DEFAULT_GUI_CONFIG.llmApiKey,
    llmModel: normalizeLlmModel(env.LLM_MODEL),
    llmVisionCapable: env.LLM_VISION_CAPABLE ? env.LLM_VISION_CAPABLE === 'true' : DEFAULT_GUI_CONFIG.llmVisionCapable,
    llmMaxTokens: Number(env.LLM_MAX_TOKENS || DEFAULT_GUI_CONFIG.llmMaxTokens),
    llmPrompt: normalizeLlmPrompt(env.LLM_PROMPT),
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS || DEFAULT_GUI_CONFIG.llmTimeoutMs),
    syncConcurrency: Number(env.SYNC_CONCURRENCY || DEFAULT_GUI_CONFIG.syncConcurrency),
    processConcurrency: Number(env.PROCESS_CONCURRENCY || DEFAULT_GUI_CONFIG.processConcurrency),
    autoStart: true
  };
}

function normalizeConfig(input: Partial<GuiConfig>): GuiConfig {
  const photoDir = resolvePhotoDir(input.photoDir);
  const bundledTunnel = detectBundledTunnelCredentials();
  const hasFixedTunnel = Boolean(input.tunnelToken || bundledTunnel.credentialsFile);
  const quickTunnel = hasFixedTunnel ? (input.quickTunnel ?? DEFAULT_GUI_CONFIG.quickTunnel) : true;
  const deviceFingerprint = currentDeviceFingerprint();
  const copiedFromAnotherComputer = Boolean(input.deviceFingerprint && input.deviceFingerprint !== deviceFingerprint);
  const deviceId = copiedFromAnotherComputer ? createDeviceId() : normalizeDeviceId(input.deviceId) || createDeviceId();
  return {
    workerUrl: normalizeWorkerUrl(input.workerUrl),
    daemonSecret: input.daemonSecret || DEFAULT_GUI_CONFIG.daemonSecret,
    deviceId,
    deviceName: normalizeDeviceName(input.deviceName) || defaultDeviceName(),
    deviceFingerprint,
    photoDir,
    thumbnailDir: input.thumbnailDir || path.join(photoDir, '.cache', 'thumbs'),
    localPort: Number(input.localPort || 18080),
    tunnelEnabled: input.tunnelEnabled ?? DEFAULT_GUI_CONFIG.tunnelEnabled,
    tunnelPublicUrl: quickTunnel ? '' : input.tunnelPublicUrl || DEFAULT_GUI_CONFIG.tunnelPublicUrl,
    tunnelToken: input.tunnelToken || DEFAULT_GUI_CONFIG.tunnelToken,
    tunnelName: input.tunnelName || DEFAULT_GUI_CONFIG.tunnelName,
    quickTunnel,
    tunnelLogLevel: input.tunnelLogLevel || DEFAULT_GUI_CONFIG.tunnelLogLevel,
    r2Endpoint: input.r2Endpoint || DEFAULT_GUI_CONFIG.r2Endpoint,
    r2BucketName: input.r2BucketName || DEFAULT_GUI_CONFIG.r2BucketName,
    r2AccessKeyId: input.r2AccessKeyId || DEFAULT_GUI_CONFIG.r2AccessKeyId,
    r2SecretAccessKey: input.r2SecretAccessKey || DEFAULT_GUI_CONFIG.r2SecretAccessKey,
    llmBaseUrl: normalizeLlmBaseUrl(input.llmBaseUrl),
    llmApiKey: input.llmApiKey || DEFAULT_GUI_CONFIG.llmApiKey,
    llmModel: normalizeLlmModel(input.llmModel),
    llmVisionCapable: normalizeLlmVisionCapable(input),
    llmMaxTokens: Number(input.llmMaxTokens || DEFAULT_GUI_CONFIG.llmMaxTokens),
    llmPrompt: normalizeLlmPrompt(input.llmPrompt),
    llmTimeoutMs: Number(input.llmTimeoutMs || DEFAULT_GUI_CONFIG.llmTimeoutMs),
    syncConcurrency: Number(input.syncConcurrency || DEFAULT_GUI_CONFIG.syncConcurrency),
    processConcurrency: Number(input.processConcurrency || DEFAULT_GUI_CONFIG.processConcurrency),
    autoStart: input.autoStart !== false
  };
}

function defaultPhotoDir(): string {
  return path.join(app.getPath('pictures'), 'PhotoHost');
}

function normalizeLlmVisionCapable(input: Partial<GuiConfig>): boolean {
  const legacyPrompt = !input.llmPrompt || input.llmPrompt === 'Describe the photo briefly in natural Chinese.';
  if (input.llmVisionCapable === false && legacyPrompt) return DEFAULT_GUI_CONFIG.llmVisionCapable;
  return input.llmVisionCapable ?? DEFAULT_GUI_CONFIG.llmVisionCapable;
}

function normalizeWorkerUrl(value?: string): string {
  const trimmed = value?.trim().replace(/\/$/, '');
  if (!trimmed || /photohost-worker\.[^.]+\.workers\.dev$/i.test(trimmed)) {
    return DEFAULT_GUI_CONFIG.workerUrl;
  }
  return trimmed;
}

function normalizeLlmBaseUrl(value?: string): string {
  const trimmed = value?.trim().replace(/\/$/, '');
  if (!trimmed || /^http:\/\/localhost:11434\/v1$/i.test(trimmed)) {
    return DEFAULT_GUI_CONFIG.llmBaseUrl;
  }
  return trimmed;
}

function normalizeLlmModel(value?: string): string {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed === 'qwen2.5:9b' ||
    /^lmstudio-community\/Qwen3\.5-9B-GGUF-no-thinking$/i.test(trimmed)
  ) {
    return DEFAULT_GUI_CONFIG.llmModel;
  }
  return trimmed;
}

function normalizeLlmPrompt(value?: string): string {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed === 'Describe the photo briefly in natural Chinese.' ||
    /under 24 Chinese characters/i.test(trimmed) ||
    /不超过\s*24\s*个?中文?字/.test(trimmed)
  ) {
    return DEFAULT_GUI_CONFIG.llmPrompt;
  }
  return trimmed;
}

function createDeviceId(): string {
  return `dev_${randomUUID().replace(/-/g, '').slice(0, 28)}`;
}

function normalizeDeviceId(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : null;
}

function normalizeDeviceName(value?: string): string | null {
  const trimmed = value?.trim().replace(/\s+/g, ' ').slice(0, 80);
  return trimmed || null;
}

function defaultDeviceName(): string {
  return normalizeDeviceName(`${hostname() || process.env.COMPUTERNAME || 'PhotoHost'} Sync`) || 'PhotoHost Sync';
}

function currentDeviceFingerprint(): string {
  let user = '';
  try {
    user = userInfo().username || '';
  } catch {
    user = process.env.USERNAME || '';
  }

  const raw = [
    hostname(),
    process.env.COMPUTERNAME || '',
    process.env.USERDOMAIN || '',
    user
  ].join('|');

  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function resolvePhotoDir(candidate?: string): string {
  const fallback = defaultPhotoDir();
  const preferred = candidate || fallback;
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function applyStartup(enabled: boolean): void {
  if (!app.isPackaged) {
    appendLog(`[gui] startup ${enabled ? 'enabled' : 'disabled'} in config; packaged app will apply it`);
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  });
}
