import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { CONFIG } from './config.js';

let lastPublishedUrl = '';

function buildCommand(): { command: string; args: string[] } | null {
  if (!CONFIG.tunnel.enabled) return null;

  const localUrl = `http://127.0.0.1:${CONFIG.localPort}`;
  if (CONFIG.tunnel.runner === 'cloudflared') {
    const baseArgs: string[] = [];
    if (CONFIG.tunnel.originCert) {
      baseArgs.push('--origincert', CONFIG.tunnel.originCert);
    }
    if (CONFIG.tunnel.credentialsFile && existsSync(CONFIG.tunnel.credentialsFile)) {
      return {
        command: CONFIG.tunnel.command,
        args: [
          ...baseArgs,
          'tunnel',
          '--credentials-file',
          CONFIG.tunnel.credentialsFile,
          'run',
          CONFIG.tunnel.name || 'photohost',
          '--loglevel',
          CONFIG.tunnel.logLevel
        ]
      };
    }

    if (CONFIG.tunnel.token) {
      return {
        command: CONFIG.tunnel.command,
        args: [...baseArgs, 'tunnel', 'run', '--token', CONFIG.tunnel.token, '--loglevel', CONFIG.tunnel.logLevel]
      };
    }

    if (CONFIG.tunnel.quickTunnel) {
      return {
        command: CONFIG.tunnel.command,
        args: [...baseArgs, 'tunnel', '--url', localUrl, '--loglevel', CONFIG.tunnel.logLevel]
      };
    }
  }

  if (CONFIG.tunnel.token) {
    return {
      command: CONFIG.tunnel.command,
      args: ['wrangler', 'tunnel', 'run', '--token', CONFIG.tunnel.token, '--log-level', CONFIG.tunnel.logLevel]
    };
  }

  if (CONFIG.tunnel.name) {
    return {
      command: CONFIG.tunnel.command,
      args: ['wrangler', 'tunnel', 'run', CONFIG.tunnel.name, '--log-level', CONFIG.tunnel.logLevel]
    };
  }

  if (CONFIG.tunnel.quickTunnel) {
    return {
      command: CONFIG.tunnel.command,
      args: ['wrangler', 'tunnel', 'quick-start', localUrl, '--log-level', CONFIG.tunnel.logLevel]
    };
  }

  return null;
}

export function startTunnel(): () => void {
  const command = buildCommand();
  if (!command) {
    console.warn('[tunnel] disabled or not configured');
    return () => undefined;
  }

  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let stopped = false;
  let restartTimer: NodeJS.Timeout | null = null;

  const handleOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(`[tunnel] ${text}`);
    publishQuickTunnelUrl(text).catch((err) => console.warn('[tunnel] failed to publish URL:', err));
  };

  const spawnTunnel = () => {
    if (stopped || child) return;
    console.log(`[tunnel] starting ${command.command} ${command.args.join(' ')}`);
    child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && !/\.exe$/i.test(command.command),
      env: process.env
    });

    const runningChild = child;
    runningChild.stdout.on('data', handleOutput);
    runningChild.stderr.on('data', handleOutput);
    runningChild.on('exit', (code, signal) => {
      console.warn(`[tunnel] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      child = null;
      if (!stopped) restartTimer = setTimeout(spawnTunnel, 2500);
    });
  };

  spawnTunnel();

  if (CONFIG.tunnel.publicUrl) {
    publishTunnelUrl(CONFIG.tunnel.publicUrl).catch((err) => console.warn('[tunnel] failed to publish public URL:', err));
  }

  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (!child) return;
    child.kill('SIGTERM');
    child = null;
  };
}

async function publishQuickTunnelUrl(text: string): Promise<void> {
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (!match) return;
  await publishTunnelUrl(match[0]);
}

async function publishTunnelUrl(url: string): Promise<void> {
  if (url === lastPublishedUrl) return;

  lastPublishedUrl = url;
  const response = await fetch(`${CONFIG.workerUrl}/api/sync/tunnel-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Secret': CONFIG.daemonSecret,
      'X-Device-Id': CONFIG.deviceId
    },
    body: JSON.stringify({ url, deviceName: CONFIG.deviceName })
  });

  if (!response.ok) throw new Error(`publish_tunnel_url_${response.status}`);
  console.log(`[tunnel] published ${url}`);
}
