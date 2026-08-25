import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Variables } from './types';
import auth from './routes/auth';
import account from './routes/account';
import upload from './routes/upload';
import images from './routes/images';
import sync from './routes/sync';
import proxy from './routes/proxy';
import download from './routes/download';
import print from './routes/print';
import comments from './routes/comments';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function allowedOrigins(env: Env): Set<string> {
  const values = [env.FRONTEND_ORIGIN, env.FRONTEND_ORIGINS || '']
    .flatMap((value) => value.split(/[,\s;]+/))
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(values);
}

function allowedMethods(path: string): string[] {
  if (path.startsWith('/img')) return ['GET', 'HEAD', 'OPTIONS'];
  if (path.startsWith('/api/auth')) return ['GET', 'POST', 'DELETE', 'OPTIONS'];
  if (path.startsWith('/api/upload')) return ['GET', 'POST', 'OPTIONS'];
  if (path.startsWith('/api/images')) return ['GET', 'DELETE', 'OPTIONS'];
  if (path.startsWith('/api/comment')) return ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
  if (path.startsWith('/api/sync')) return ['GET', 'POST', 'OPTIONS'];
  if (path.startsWith('/api/download')) return ['GET', 'POST', 'OPTIONS'];
  if (path.startsWith('/api/print')) return ['POST', 'OPTIONS'];
  return ['GET', 'OPTIONS'];
}

function allowedHeaders(path: string): string[] {
  if (path.startsWith('/img')) return [];
  if (path.startsWith('/api/sync')) return ['Content-Type', 'X-Daemon-Secret', 'X-Device-Id', 'X-Device-Name'];
  if (path.startsWith('/api/images')) return ['Content-Type', 'Authorization', 'X-Viewer-Id'];
  if (path.startsWith('/api/comment')) return ['Content-Type', 'Authorization', 'X-Viewer-Id'];
  return ['Content-Type', 'Authorization'];
}

function applySecurityHeaders(path: string, headers: Headers): void {
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (path.startsWith('/img') || path.startsWith('/api/auth/avatar/')) {
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.delete('Content-Security-Policy');
    return;
  }
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (!headers.get('Content-Type')?.includes('text/html')) {
    headers.delete('Content-Security-Policy');
  }
}

app.use('*', async (c, next) => {
  await next();
  const path = new URL(c.req.url).pathname;
  applySecurityHeaders(path, c.res.headers);
  if (c.req.method === 'OPTIONS' || c.res.headers.has('Access-Control-Allow-Methods')) {
    c.res.headers.set('Access-Control-Allow-Methods', allowedMethods(path).join(','));
    const headers = allowedHeaders(path);
    if (headers.length > 0) c.res.headers.set('Access-Control-Allow-Headers', headers.join(','));
    else c.res.headers.delete('Access-Control-Allow-Headers');
  }
});

app.use('*', async (c, next) => {
  const origins = allowedOrigins(c.env);
  const path = new URL(c.req.url).pathname;
  const middleware = cors({
    origin(origin) {
      if (!origin) return origin;
      if (origins.has(origin)) return origin;
      return '';
    },
    allowMethods: allowedMethods(path),
    allowHeaders: allowedHeaders(path),
    exposeHeaders: ['Content-Disposition'],
    maxAge: 86400
  });
  return middleware(c, next);
});

app.get('/health', (c) => c.json({ ok: true }));
app.route('/api/auth', auth);
app.route('/api/auth', account);
app.route('/api/upload', upload);
app.route('/api/images', images);
app.route('/api/sync', sync);
app.route('/api/download', download);
app.route('/api/print', print);
app.route('/api/comment', comments);
app.route('/img', proxy);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error(err);
  const response = c.json({ error: 'internal_error' }, 500);
  applySecurityHeaders(new URL(c.req.url).pathname, response.headers);
  return response;
});

export default app;
