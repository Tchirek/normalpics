export interface Env {
  R2: R2Bucket;
  DB: D1Database;
  KV: KVNamespace;
  TUNNEL_URL: string;
  JWT_SECRET: string;
  PIN_HASH: string;
  DELETE_PIN_HASH: string;
  DAEMON_SECRET: string;
  DAEMON_TUNNEL_ORIGINS?: string;
  LLM_ATTRIBUTION: string;
  FRONTEND_ORIGIN: string;
  FRONTEND_ORIGINS?: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  PRINT_609_BASE_URL: string;
  PRINT_609_HANDOFF_SECRET: string;
  // Comment-UI accounts (Google OAuth + Resend email)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_REDIRECT_URI: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  COMMENT_UI_ORIGINS: string;
}

export interface Variables {
  userId: string;
  authRole?: string;
  account?: import('./lib/users').UserRow;
  sessionToken?: string;
}

export interface ImageRow {
  id: string;
  filename: string;
  ext: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  r2_key_orig: string | null;
  r2_key_web: string | null;
  r2_key_thumb: string | null;
  sync_status: 'uploading' | 'pending' | 'synced' | 'failed';
  description: string | null;
  tags: string | null;
  metadata_device_id: string | null;
  metadata_model: string | null;
  metadata_at: number | null;
  metadata_claim_device_id: string | null;
  metadata_claimed_at: number | null;
  blur_data_url: string | null;
  blur_claim_device_id: string | null;
  blur_claimed_at: number | null;
  exif_aperture: string | null;
  exif_shutter_speed: string | null;
  exif_iso: number | null;
  exif_focal_length: string | null;
  exif_metering_mode: string | null;
  exif_matrix_metering: string | null;
  exif_spot_metering: string | null;
  exif_exposure_compensation: string | null;
  exif_flash: string | null;
  uploaded_at: number;
  uploaded_day: string | null;
  uploaded_day_seq: number | null;
  synced_at: number | null;
}

export interface DeviceRow {
  id: string;
  name: string | null;
  tunnel_url: string | null;
  last_seen_at: number;
  created_at: number;
}
