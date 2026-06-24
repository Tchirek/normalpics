# NormalPics

NormalPics is a private photo-hosting system built around Cloudflare Pages, Workers, D1, R2, and a local sync daemon.

The browser uploads original images to R2 through signed URLs. The Worker records image metadata in D1, and the local daemon later pulls originals from R2, writes local copies, generates web/thumbnail/blur-up assets, and confirms sync state. When the daemon is offline, the site can still serve the R2 fallback assets.

## Project Layout

```text
packages/frontend  Vite single-page gallery UI
packages/worker    Cloudflare Worker API, D1 schema access, R2 signing
packages/daemon    Local sync service and Electron GUI
schema.sql         D1 schema
r2-cors.json       R2 CORS template
```

## Configuration

Secrets are intentionally not stored in this repository.

Use Cloudflare secrets for Worker credentials:

```text
PIN_HASH
DELETE_PIN_HASH
JWT_SECRET
DAEMON_SECRET
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
PRINT_609_HANDOFF_SECRET
```

For the daemon, copy `packages/daemon/.env.example` to `packages/daemon/.env` during local development, or provide the same values through the Electron GUI/local config file. Do not commit `.env`, generated daemon configs, Cloudflare tunnel credentials, logs, or packaged release output.

## Common Commands

```powershell
cd packages/frontend
npm run build

cd ../worker
npm run build
npm run deploy

cd ../daemon
npm run build
```

## Notes

- `wrangler.toml` files contain deployment bindings and public endpoint configuration, not secret values.
- Generated folders such as `dist/`, `.wrangler/`, `release/`, rollback snapshots, and `node_modules/` are ignored.
- The NormalPics-to-609 print handoff passes only short-lived tokens and upload session metadata. File bytes should go through signed upload/download paths, not through Cloudflare Tunnel.
