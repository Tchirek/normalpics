# Contributing to NormalPics

Thanks for taking a look. Issues and pull requests are welcome.

## Layout

```text
packages/frontend  Vite single-page gallery UI
packages/worker    Cloudflare Worker API (D1, R2 signing, accounts)
packages/daemon    local sync service + Electron GUI
schema.sql         D1 schema
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Local checks

Run the same checks CI runs before opening a pull request:

```bash
npm ci
npm run build:worker      # tsc --noEmit on the Worker
npm run build:frontend    # vite build
```

## Conventions

- Never commit a real `.dev.vars` or `.env`; update the matching `*.example`
  file when you add a configuration key.
- Keep secrets out of `wrangler.toml` — use `wrangler secret put` / `.dev.vars`.
- Use placeholder domains (`pics.example.com`) in committed config.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
