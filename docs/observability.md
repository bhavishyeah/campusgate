# Observability: uptime and error tracking

## Health endpoints (API)

| URL | Touches DB | Use |
| --- | --- | --- |
| `GET /api/health` | no | Liveness. Railway healthcheck and `scripts/prod-smoke.mjs` step A. Unchanged. |
| `GET /api/health/ready` | yes (`SELECT 1`, 8 s timeout) | Readiness. Point uptime monitors here. |

`/api/health/ready` responses (no auth, read-only, never includes error text):

- `200 {"status":"ok","db":"up","timestamp":"..."}`
- `503 {"status":"error","db":"down","timestamp":"..."}` (query failed or took longer than 8 s; the real error is logged on the server as a warning)

Uptime monitor URL: `https://campusgate.up.railway.app/api/health/ready`, expect HTTP 200.

Quick check: `curl -i https://campusgate.up.railway.app/api/health/ready`, or run
`node scripts/prod-smoke.mjs` (step A2).

## Sentry error tracking (optional)

Sentry is off unless its DSN is set. With no DSN the SDK is not loaded at all (no network calls, no behavior change).

| App | Env var | Where to set it |
| --- | --- | --- |
| API (`apps/api`) | `SENTRY_DSN` | Railway > service > Variables |
| Web (`apps/web`) | `NEXT_PUBLIC_SENTRY_DSN` | Vercel > Project > Settings > Environment Variables (then redeploy: it is inlined at build time) |

The DSN is not a secret in the browser sense, but keep it out of git anyway. No `SENTRY_AUTH_TOKEN`, org or project is needed: source-map upload is not configured, so builds work without any Sentry env.

Settings: errors only (`tracesSampleRate: 0`), Session Replay off, automatic PII collection off (`dataCollection` with user info, cookies, headers, bodies and query params disabled; SDK v11 replaces `sendDefaultPii` with this). API `environment` comes from `NODE_ENV`, `release` from `RAILWAY_GIT_COMMIT_SHA`. The API reports only 5xx errors; 3xx/4xx (400/401/403/404/409/422/429) are skipped.

### What is scrubbed (`beforeSend` / `beforeBreadcrumb`)

- API (`apps/api/src/sentry-scrub.ts`): `authorization`, `cookie`, `x-step-up` headers; request bodies for `/api/auth/*`, `/api/platform/*` and `/ws`; any field named `password`, `passwordHash`, `token`, `stepUpToken`, `code`, `secret`, `razorpay_signature` at any depth; `token=` query params in URLs, messages and breadcrumbs (the WebSocket URL carries `?token=<JWT>`). The user is reduced to `{ id }` (the opaque userId).
- Web (`apps/web/src/lib/sentryScrub.ts`): the same headers and field names, all request bodies, `token=` query params, any JWT-shaped string, and anything mentioning the persisted auth store (`campusgate-auth` in localStorage). The user is reduced to `{ id }`.

### Verify after setting a DSN

There is no crash/test route. To send a one-off test event from your machine with the API's DSN:

```bash
cd apps/api
SENTRY_DSN="<your dsn>" node -e "import('@sentry/node').then(async S => { S.init({ dsn: process.env.SENTRY_DSN }); S.captureMessage('campusgate sentry test'); await S.flush(5000); })"
```

PowerShell: `$env:SENTRY_DSN="<your dsn>"; node -e "..."` with the same script. The message should appear in the Sentry project's Issues within a minute. For the web app, after redeploying with `NEXT_PUBLIC_SENTRY_DSN`, any unhandled error in the browser shows up the same way.
