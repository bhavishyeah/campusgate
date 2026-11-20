# Email and account setup/recovery

The API sends two kinds of email, both through Brevo's transactional REST API (`POST https://api.brevo.com/v3/smtp/email`, called with `fetch`, no SDK). Sending sits behind the `EmailSender` interface in `apps/api/src/services/email/`, so the provider can be swapped later.

## Environment variables (API only, Railway)

| Variable | Required | Default | What it does |
|----------|----------|---------|--------------|
| `BREVO_API_KEY` | for sending | unset | Brevo API key (Brevo > SMTP & API > API keys). |
| `EMAIL_FROM` | for sending | unset | Sender address. It must be verified in Brevo (Senders, domains & IPs > Senders). |
| `EMAIL_FROM_NAME` | no | `CampusGate` | Sender display name. |
| `FRONTEND_URL` | yes (already set for CORS) | | Links are built from its origin: `<origin>/reset-password#token=...` and `<origin>/activate#token=...`. Outside development/test, if it is unset the sender stays unconfigured. |
| `ALLOW_SELF_REGISTRATION` | no | enabled | `false`, `0` or `no` makes `POST /api/auth/register` return 403 and hides the form on `/register`. |
| `TRUST_PROXY_HOPS` | no | 1 (0 when `NODE_ENV` is `development` or `test`) | Proxies in front of the API. Used to read the real client IP for rate limits. |
| `EMAIL_DAILY_LIMIT` | no | 300 | Rolling 24 h ceiling for all mail sent by this API (Brevo free plan). |
| `EMAIL_RESET_HOURLY_LIMIT` | no | 40 | Platform-wide forgot-password sends per rolling hour. |
| `EMAIL_RESET_DAILY_LIMIT` | no | 100 | Platform-wide forgot-password sends per rolling 24 h. |
| `EMAIL_DEV_PRINT_LINKS` | no | unset | Development only: `true` lets the console sender print links. |

The web app needs no new variables.

Sender selection:

- `BREVO_API_KEY` and `EMAIL_FROM` both set: Brevo.
- Otherwise, `NODE_ENV=test` (or running under vitest): in-memory sender, prints nothing.
- Otherwise, `NODE_ENV=development` and `RAILWAY_ENVIRONMENT` unset: console sender. It logs recipient and subject; links are hidden unless `EMAIL_DEV_PRINT_LINKS=true`.
- Anything else, including `NODE_ENV` unset: unconfigured. Nothing is sent.

The API never throws at boot because of these variables.

### Behavior while Brevo is not configured (today's production)

- `POST /api/auth/forgot-password` returns the usual generic 200, sends nothing, and logs `warn` "email not configured, reset not sent".
- Admin invite endpoints return 503 `EMAIL_NOT_CONFIGURED`. A bulk `dryRun` still works and reports `emailConfigured: false`; the dialog disables sending.
- `POST /api/admin/users` keeps returning a `tempPassword` for every role, as before.
- Login, reset-password and activate work normally (there are just no new links to use).

### Railway checklist

1. Set `NODE_ENV=production` on the API service.
2. Set `BREVO_API_KEY`, `EMAIL_FROM` and optionally `EMAIL_FROM_NAME`. Check `FRONTEND_URL` is the Vercel origin.
3. Deploy. Railway runs `prisma migrate deploy`, which adds the `account_tokens` table (migration `20270207000000_account_tokens`, additive).
4. Check the proxy hop count: call `GET /api/auth/public-config` from your own network and compare the logged request IP to your public IP. If the log shows a private address (10.x, 100.64-127.x, 172.16-31.x, 192.168.x), raise `TRUST_PROXY_HOPS` by one. If it shows an address you can spoof by sending your own `X-Forwarded-For`, lower it. While the IP looks private, the API skips IP-keyed limits and logs "client IP looks like an internal proxy; check TRUST_PROXY_HOPS" once; per-email and per-user limits still apply.
5. In Brevo, turn off open and click tracking for transactional mail (account setting; the send API has no per-message switch). The templates contain no tracking pixel and no images.

## The emails

Both are short, plain English, with HTML and text versions, the institution name in the subject, an expiry line and "If you did not request this, you can ignore this email. Your password will not change."

| Email | Subject | Sent when | Link | Expires |
|-------|---------|-----------|------|---------|
| Password reset | Reset your CampusGate password - {Institution} | Someone uses Forgot password for an active account that has a password | `/reset-password#token=...` | 45 minutes |
| Account activation | Activate your CampusGate account - {Institution} | An admin sends or resends an invite, or Forgot password is used for an active account that has no password yet (imported or admin-created students, invited staff) | `/activate#token=...` | 72 hours |

Token rules: 32 random bytes, base64url, only the SHA-256 hash is stored. Each link works once, works only on its own page (a reset link fails on `/activate` and the reverse), and is cancelled when a newer link of the same kind is issued. A successful reset or activation signs the user out of every session and cancels their other links. The token travels in the URL fragment, so it never reaches a server log; the page removes it from the address bar after reading it. The three pages send `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and `X-Frame-Options: DENY`, and the service worker never caches them.

Who can use Forgot password: active accounts in active institutions. Students also need an active or newly enrolled (ENROLLED) student profile to activate (any active account may reset an existing password). Pending-approval accounts get nothing. The response is the same in every case.

### Enrolled email

Enrolling an applicant also sends one email (an activation link inside it for applicants with no password yet). See [dmissions-handoff.md](./admissions-handoff.md). It uses the same sender, the same daily budget for the activation variant, and a 20-invite reserve for the plain variant.

### Admin invites

- Users page: "Send invite" / "Resend invite" on active rows without a password, with a confirm dialog. Students go through `POST /api/account-invites/students/:userId` (permission `students.create`), staff through `POST /api/account-invites/users/:userId` (`admin.users.create`).
- "Invite not-activated students" on the Users page and on the import success panel opens the bulk dialog: a dry run shows how many students are waiting and how many can be sent now, then each click sends one batch of up to 100 and lists sent, failed and skipped per user. Repeat "Send next batch" on later days until everyone is invited.
- Staff created through `POST /api/admin/users` with Brevo configured get an invite and no temporary password. Students, and all roles while Brevo is unconfigured, still get a `tempPassword`.

## Limits

| Limit | Value | When exceeded |
|-------|-------|---------------|
| All mail from this API | 300 per rolling 24 h | Invites: 429 `EMAIL_DAILY_LIMIT`. Forgot: generic 200, nothing sent. |
| Invites (single and bulk) | 250 per rolling 24 h (50 kept for resets) | 429 `EMAIL_DAILY_LIMIT`, or the batch stops |
| Forgot-password sends, platform-wide | 40 per rolling hour, 100 per rolling 24 h | generic 200, nothing sent, `warn` |
| Bulk batch size | 100 recipients per request | 400 |
| Links per user per kind | 3 per hour | Forgot: silent. Invites: 429 `INVITE_THROTTLED`. Bulk: `SKIPPED_RECENTLY_INVITED` |
| Forgot per email | 3 per hour | generic 200, nothing sent |
| Forgot per IP | 60 per 15 min, 150 per 24 h | 429 with `Retry-After` |
| Reset and activate per IP | 600 per 15 min | 429 with `Retry-After` |
| Register per IP / per email | 30 per hour / 5 per hour | 429 with `Retry-After` |
| Single invite per admin | 30 per minute | 429 with `Retry-After` |
| Bulk send per admin | 6 per hour | 429 with `Retry-After` |

A failed send cancels its link, frees its budget slot and is not retried in bulk for 24 h (`SKIPPED_RECENT_FAILURE`). Brevo 402/429 responses are reported as `EMAIL_PROVIDER_LIMIT` and stop a bulk batch. The budget counts only mail sent by this API; anything else sent with the same Brevo key is invisible to it. In-memory limits (IP, email, admin) are per process and reset on restart; the budget and per-user limits are in the database.

## Platform accounts

`SUPER_ADMIN` users, and anyone holding a `platform.*` permission, cannot use Forgot password, reset or activation, and cannot be invited. Forgot password returns the usual generic 200 and sends nothing. Recover them as an operator, following `scripts/rotate-seed-passwords.mjs`.

## Self-registration

`/register` creates new `PENDING_APPROVAL` accounts only. It returns 409 "Email already registered" for any existing email (case-insensitive) and never sets a password on an existing account, so the old "activate by email plus enrollment number" path is gone. Logging in with the old default password (the enrollment number) is refused with a not-activated message; those students use Forgot password.

Remaining risk: someone can register a pending account with a real student's email or enrollment number before the student does. A pending account cannot log in or receive mail. Admins remove it with Reject on the Users page (`POST /api/admin/users/:id/reject`, permission `admin.users.approve`), which frees the email and enrollment number. `ALLOW_SELF_REGISTRATION=false` turns registration off entirely.

## Testing with a real Brevo key

Use your own inbox and the TEST database, never production data.

1. Create a free Brevo account, verify a sender address, and create an API key.
2. In a local shell for the API: set `BREVO_API_KEY`, `EMAIL_FROM`, `FRONTEND_URL=http://localhost:3000`, `NODE_ENV=development`, and the TEST project's database URLs (see `docs/test-database.md`). Start the API and the web app.
3. Forgot password: create or pick an active test user whose email is your inbox, open `/forgot-password`, submit. Check the mail arrives, the subject has the institution name, the link opens `/reset-password`, the token disappears from the address bar, and the new password works. Open the same link again: it must say the link is invalid.
4. Activation: create a student without a password (single create or import) with your inbox as the email. On Users, click Send invite, confirm, open the mail, set a password on `/activate`, log in.
5. Bulk: run "Invite not-activated students", check the dry-run numbers, send one batch, compare the sent count with the Brevo transactional log.
6. In Brevo's log, check that opens and clicks are not tracked and that the message has no rewritten links.
7. Look at the mail in Gmail and Outlook (spam folder too).

## Not verified

These could not be checked without a real Brevo key or the deployed environment:

- The Railway proxy hop count (`TRUST_PROXY_HOPS`, checklist step 4).
- Actual delivery to an inbox.
- Brevo account setup and sender verification.
- Brevo's real 402 and 429 response bodies (the code maps by status only).
- Whether open and click tracking is off for this account.
- Spam placement.
- Rendering in Gmail and Outlook.
- When Brevo's daily 300 window resets (the API uses a rolling 24 h count, which is the conservative choice).
- The service worker exclusion for the three token pages was checked in the generated `sw.js`, not in a browser on the deployed site.
