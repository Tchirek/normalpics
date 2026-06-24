# Security policy

## Reporting a vulnerability

Please report security issues privately via a
[GitHub security advisory](https://github.com/Tchirek/normalpics/security/advisories/new)
rather than a public issue.

## Handling of secrets

- Real secrets never belong in the repository. The Worker reads them from
  `.dev.vars` locally and from `wrangler secret put` in production.
- `packages/worker/.dev.vars.example` documents every secret with placeholder
  values only.

## Trust boundaries

- The browser uploads originals directly to R2 via short-lived signed URLs; the
  Worker only signs URLs and records metadata in D1.
- The local sync daemon authenticates to the Worker with `DAEMON_SECRET`.
- Destructive actions are gated by hashed PINs, never raw PINs in the repo.
