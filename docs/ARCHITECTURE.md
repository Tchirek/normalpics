# Architecture & operations

NormalPics is a private-first photo host built on Cloudflare (Pages, Workers, D1,
R2) with a local sync daemon that owns the heavy image processing.

## Tiers

```text
Browser  ->  Worker (D1 + R2 signing)  ->  R2 (originals)
                     |                         ^
                     v                         |
                    D1 (metadata)         local daemon  -> web / thumbnail / blur-up assets
```

| Package | Responsibility |
|---------|----------------|
| `packages/frontend` | Vite single-page gallery UI. |
| `packages/worker` | Cloudflare Worker API: D1 metadata, R2 signed URLs, accounts/OAuth, comment-UI origins. |
| `packages/daemon` | Local sync service + Electron GUI: pulls originals from R2, writes local copies, generates web/thumbnail/blur-up assets, confirms sync state. |

## Upload & serving flow

1. The browser requests a signed upload URL from the Worker and uploads the
   original straight to R2.
2. The Worker records image metadata in D1.
3. The local daemon pulls new originals from R2, writes local copies, and
   generates the web/thumbnail/blur-up derivatives.
4. When the daemon is offline, the site still serves the R2 fallback assets.

## Configuration & secrets

Secrets are never stored in the repo. The Worker reads them from `.dev.vars`
locally (see [../packages/worker/.dev.vars.example](../packages/worker/.dev.vars.example))
and from `wrangler secret put` in production. Non-secret bindings and routes live
in `packages/worker/wrangler.toml`; the example domains there (`pics.example.com`,
`api.pics.example.com`) are placeholders.

Key secrets: `DAEMON_SECRET`, `JWT_SECRET`, `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, and the PIN hashes guarding destructive
actions.

## Deployment

- **Worker:** `npm run build:worker` then `wrangler deploy` from `packages/worker`.
- **Frontend:** `npm run build:frontend` then deploy `packages/frontend/dist` to
  Pages.
- **Daemon:** packaged from `packages/daemon` on the machine that holds the local
  asset mirror.

Secrets stay in `.dev.vars` (local) and `wrangler secret put` (production); never
commit a real `.dev.vars` or `.env`.
