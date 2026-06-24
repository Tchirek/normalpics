import type { Env, ImageRow } from '../types';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string | null;
}

export interface OnlineDevice {
  id: string;
  name: string | null;
  tunnelUrl: string;
  lastSeenAt: number;
}

export function normalizeDeviceId(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeDeviceName(value: string | undefined | null): string | null {
  const trimmed = value?.trim().slice(0, 80);
  return trimmed || null;
}

export async function ensureDeviceTables(env: Env): Promise<void> {
  void env;
}

export async function touchDevice(
  env: Env,
  identity: DeviceIdentity,
  tunnelUrl?: string | null
): Promise<void> {
  await ensureDeviceTables(env);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO devices (id, name, tunnel_url, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(excluded.name, devices.name),
       tunnel_url = COALESCE(excluded.tunnel_url, devices.tunnel_url),
       last_seen_at = excluded.last_seen_at`
  )
    .bind(identity.deviceId, identity.deviceName, tunnelUrl || null, now, now)
    .run();
}

export async function setDeviceTunnelUrl(env: Env, identity: DeviceIdentity, tunnelUrl: string): Promise<void> {
  await touchDevice(env, identity, tunnelUrl);
}

export async function recordImageOnDevice(
  env: Env,
  imageId: string,
  identity: DeviceIdentity,
  sha256?: string | null
): Promise<void> {
  await ensureDeviceTables(env);
  await touchDevice(env, identity);
  await env.DB.prepare(
    `INSERT INTO image_devices (image_id, device_id, sha256, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(image_id, device_id) DO UPDATE SET
       sha256 = COALESCE(excluded.sha256, image_devices.sha256),
       synced_at = excluded.synced_at`
  )
    .bind(imageId, identity.deviceId, sha256 || null, Date.now())
    .run();
}

export async function deleteImageDeviceRows(env: Env, imageId: string): Promise<void> {
  await ensureDeviceTables(env);
  await env.DB.prepare('DELETE FROM image_devices WHERE image_id = ?').bind(imageId).run();
}

export async function missingImagesForDevice(env: Env, deviceId: string, limit = 500): Promise<ImageRow[]> {
  await ensureDeviceTables(env);
  const result = await env.DB.prepare(
    `SELECT i.*
     FROM images i
     WHERE i.sync_status != 'uploading'
       AND (i.r2_key_orig IS NOT NULL OR i.r2_key_web IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM image_devices d
         WHERE d.image_id = i.id AND d.device_id = ?
       )
     ORDER BY i.uploaded_at ASC
     LIMIT ?`
  )
    .bind(deviceId, limit)
    .all<ImageRow>();
  return result.results || [];
}

export async function onlineDevicesForImage(env: Env, imageId: string, limit = 5): Promise<OnlineDevice[]> {
  await ensureDeviceTables(env);
  const cutoff = Date.now() - 90_000;
  const result = await env.DB.prepare(
    `SELECT d.id,
            d.name,
            d.tunnel_url AS tunnelUrl,
            d.last_seen_at AS lastSeenAt
     FROM devices d
     INNER JOIN image_devices imgd ON imgd.device_id = d.id
     WHERE imgd.image_id = ?
       AND d.tunnel_url IS NOT NULL
       AND d.last_seen_at > ?
     ORDER BY imgd.synced_at DESC, d.last_seen_at DESC
     LIMIT ?`
  )
    .bind(imageId, cutoff, limit)
    .all<OnlineDevice>();
  return (result.results || []).filter((device) => Boolean(device.tunnelUrl));
}
