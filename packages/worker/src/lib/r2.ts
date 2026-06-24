import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

function r2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto'
  });
}

function objectUrl(env: Env, key: string): URL {
  const safeKey = key.split('/').map(encodeURIComponent).join('/');
  return new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${safeKey}`);
}

export async function generatePresignedPut(
  env: Env,
  key: string,
  contentType = 'application/octet-stream',
  expiresIn = 3600
): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(expiresIn));
  const signed = await r2Client(env).sign(
    new Request(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType }
    }),
    { aws: { signQuery: true, allHeaders: true } }
  );
  return signed.url;
}

export async function generatePresignedGet(env: Env, key: string, expiresIn = 3600): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(expiresIn));
  const signed = await r2Client(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true }
  });
  return signed.url;
}
