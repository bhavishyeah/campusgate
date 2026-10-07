# Guard Panel & Scan Pass Investigation — Findings Report

## Summary (answer first)

The guard panel and scan-pass code paths are **architecturally complete and correct end-to-end**. There is no single broken API call, wrong URL, or missing import that breaks scanning in isolation. The "not working" symptom is almost certainly caused by **unmet operational prerequisites that the UI handles silently**, plus a handful of robustness gaps that make failures invisible to the guard.

The dominant root cause: **the SCAN PASS button is hard-disabled unless the guard has an `ACTIVE` shift**, and when the shift-loading call fails (no guard profile, no shift, network/auth error) the page silently swallows the error and shows only "No active or upcoming shifts. Contact admin to schedule your shift." with no diagnostic. A guard with no admin-assigned shift, or whose `GuardProfile` was never created, sees a permanently disabled scanner and assumes the panel is broken.

Secondary gaps: a latent config trap (`NEXT_PUBLIC_WS_URL` is defined but ignored), no real-time student notification on exit/return (missing feature vs. HOD approve flow), and a `Html5Qrcode` double-init risk under React Strict Mode.

---

## How the system works end-to-end (verified by reading code)

### 1. Guard panel — what it renders and its main actions

File: `apps/web/src/app/guard/page.tsx` (the scan page) + `apps/web/src/app/guard/layout.tsx` (chrome) + `apps/web/src/app/guard/activity/page.tsx` (activity tab).

- `layout.tsx` guards the route: redirects to `/login` if no token or `user.role !== "GUARD"`, then calls `connectSocket()` (`apps/web/src/lib/socket.ts`) for live notifications. Top bar has Scan / Activity nav, a `NotificationBell`, and logout.
- `page.tsx` renders, top to bottom:
  1. An active emergency alert banner (from `/api/guard/emergency/active`).
  2. A shift panel (`shiftPanel()`): "Shift Active" with an **End Shift** button, OR "Upcoming Shift" with a **Start Shift** button, OR "No active or upcoming shifts."
  3. A `#qr-reader` div + a **SCAN PASS** button (disabled unless `shiftInfo?.activeShift` is truthy) and a **Cancel Scan** button while scanning.
  4. A **Manual Lookup** input + search button (also disabled unless `shiftInfo?.activeShift`).
  5. A result card showing VALID/INVALID, student details, reason, pass #, and a context-dependent **MARK EXIT** or **MARK RETURN** button based on `result.action`.

### 2. Scan pass end-to-end (frontend → API → database)

- **QR generation**: HOD approves a pending pass in `apps/api/src/routes/hod.ts:234` — `const qrToken = nanoid(32)` + `qrExpiresAt = now + 480min` (8h, from `QR_TOKEN_VALIDITY_MINUTES` in `packages/shared/src/constants.ts:19`). Pass transitions `PENDING → APPROVED`, and student is notified via `notifyUser` (`hod.ts:262`).
- **Student display**: `apps/web/src/app/student/pass/page.tsx` fetches `/api/student/active-pass` (`apps/api/src/routes/student.ts:210`, returns the full pass incl. `qrToken` for statuses `APPROVED|ACTIVE|OUTSIDE`) and renders a QR image from `data.qrToken` via the `qrcode` lib.
- **Guard scan**: `page.tsx:startScanner()` instantiates `new Html5Qrcode("qr-reader")`, starts the back camera (`facingMode: "environment"`), and on decode calls `verifyToken(decodedText)`.
- **Verify**: `verifyToken` → `api.post("/api/guard/verify", { qrToken })`. Backend `apps/api/src/routes/guard.ts` `/verify` looks up the pass by `qrToken` scoped to the guard's `institutionId`, runs a validation chain (not found / REVOKED / EXPIRED / COMPLETED / CANCELLED / REJECTED / PENDING), computes `isOverdue`, and returns `{ valid, status, action, message, pass }`. `action` is `MARK_EXIT` for `APPROVED|ACTIVE`, `MARK_RETURN` for `OUTSIDE`, else `NONE`.
- **Mark exit/return**: `handleMarkExit`/`handleMarkReturn` POST `/api/guard/mark-exit` or `/mark-return` with `{ passId, gateId }`. Backend verifies the guard's `GuardGateAssignment` for `gateId`, verifies an active shift exists at that gate, then in a transaction transitions the pass (`APPROVED|ACTIVE → OUTSIDE` for exit, clearing `qrExpiresAt`; `OUTSIDE → COMPLETED` for return, computing `overdueMinutes`) and creates a `GateEvent`. On return it fire-and-forgets a `ReliabilityEngine` snapshot (`guard.ts:486-521`).
- **Auth**: All `/api/guard/*` routes use `app.addHook("preHandler", requireTenantRole("GUARD"))` (`guard.ts:15`). `requireTenantRole` (`apps/api/src/middleware/auth.ts:60`) runs `authenticate` (JWT verify + DB user/institution status check), rejects `SUPER_ADMIN`, and enforces role `GUARD`.

### 3. WebSocket

- `apps/api/src/routes/ws.ts` registers `/ws/connect` (prefix `/ws` in `server.ts:38`). Auth via `?token=` query param; verified with `app.jwt.verify`; stores `wsConnections.set(userId, socket)`. Ping/pong keepalive.
- `apps/web/src/lib/socket.ts` builds the WS URL as `NEXT_PUBLIC_API_URL.replace("http","ws")` + `/ws/connect?token=...`, with 30s ping and 5s reconnect. `onMessage(type, handler)` dispatches by `message.type`.
- `connectSocket()` is called from `guard/layout.tsx:32`. The guard scan page itself does **not** subscribe to any WS messages; only `NotificationBell` does (`notification` type).

---

## What is broken or missing

### Issue 1 — PRIMARY: Scan button is disabled without an active shift, and the reason is invisible

- **Where**: `apps/web/src/app/guard/page.tsx:346` — `disabled={!shiftInfo?.activeShift}`; manual lookup button at `:372` — `disabled={loading || !shiftInfo?.activeShift}`.
- **Effect**: Scanning (and manual lookup) can only be used after the guard has started an `ACTIVE` shift. That requires: (a) admin created the `GUARD` user with a `GuardProfile` + `GuardGateAssignment` (`apps/api/src/routes/admin.ts:570-577`), (b) admin created a `SCHEDULED` `GuardShift` for that guard+gate (`admin.ts:1169-1212`), (c) the guard clicked **Start Shift** within the −30min…scheduledEnd window (`guard.ts:138-142`).
- **Why it looks "broken":** `loadShift` (`page.tsx:83-105`) calls `/api/guard/shift/current`. If the guard has no `GuardProfile`, the API returns 404 (`guard.ts:54-56`); if no shift is scheduled, `activeShift` and `nextShift` are both null. In **both** cases the catch block (`page.tsx:101-103`) does `catch { setShiftInfo(null); }` — it sets no `error` state. The user sees the neutral "No active or upcoming shifts. Contact admin to schedule your shift." message even when the real cause is a missing profile or a 401/500. There is no way for the guard to tell "I have no shift" from "the API is failing."
- **Impact**: This is the most likely explanation for "the scan pass is not working" — the button never enables.

### Issue 2 — Silent failure: no user-facing error when shift/emergency loading fails

- **Where**: `apps/web/src/app/guard/page.tsx:101-103` (`catch { setShiftInfo(null); }`) and the `Promise.all` at `:86-89`.
- **Effect**: Any failure in `/api/guard/shift/current` or `/api/guard/emergency/active` is swallowed. If the JWT is expired the `api` client auto-logs-out (`apps/web/src/lib/api.ts:37-39`) and the layout redirects to `/login` — but a 403 (e.g., role mismatch), 404 (no profile), or network error just leaves the panel in a "no shift" state with no message. Diagnosis is impossible from the UI.
- **Recommendation**: surface the caught error in the `error` state (or a dedicated `shiftError`) and distinguish "no shift scheduled" from "could not load shift."

### Issue 3 — `gateId` can be empty, dead-ending mark-exit/mark-return

- **Where**: `apps/web/src/app/guard/page.tsx:92-98` (gateId resolution) and `:207-211`, `:229-233` (mark-exit/return guards).
- **Effect**: `gateId` is set from `activeShift.gateId`, with a fallback to `/api/auth/me` → `profile.assignedGates[0].gate.id`. If the shift endpoint failed (Issue 1/2) the fallback runs; if the guard has no `assignedGates`, `gateId` stays `""`. The mark handlers then short-circuit with "No gate available. Contact admin." — handled, but a dead-end for the user with no recovery path in the UI.
- **Note**: The backend `mark-exit`/`mark-return` also independently verify the guard is assigned to the gate and that an active shift exists for that gate (`guard.ts:335-340`, `:434-439`), so even a stale `gateId` would be rejected with a clear 403 — but the frontend guards already prevent the call.

### Issue 4 — Latent config trap: `NEXT_PUBLIC_WS_URL` is defined but ignored

- **Where**: `apps/web/.env.local` defines `NEXT_PUBLIC_WS_URL=ws://localhost:4000`; `apps/web/.env.example` documents it. But `apps/web/src/lib/socket.ts:3` reads only `NEXT_PUBLIC_API_URL` and derives the WS URL via `WS_URL.replace("http","ws")` (`:24`). `NEXT_PUBLIC_WS_URL` is never referenced anywhere in `apps/web/src` (grep confirmed).
- **Effect**: For the default single-port setup this is harmless — the replace correctly yields `ws://...` from `http://...` and `wss://...` from `https://...` (verified). But if an operator sets `NEXT_PUBLIC_WS_URL` to point WebSocket at a different host/port (a common production pattern), it is silently ignored and the app connects to the HTTP host's WS path instead. This is a latent misconfig trap, not the current "not working" cause.

### Issue 5 — Missing feature: no student notification on exit/return

- **Where**: `apps/api/src/routes/guard.ts` — `mark-exit` (`:325-405`) and `mark-return` (`:412-540`) create `AuditLog` and `GateEvent` but never call `notifyUser`. Contrast `apps/api/src/routes/hod.ts:262-263` and `:322-323`, which notify the student on approve/reject.
- **Effect**: A student whose pass is scanned at the gate gets no live push; they only learn of the exit/return by refreshing their history. Not a bug per se, but an inconsistency vs. the HOD flow and likely a user expectation gap. (`notifyUser` and `wsConnections` are wired and working; this is just an omission in the guard handlers.)

### Issue 6 — Robustness: `Html5Qrcode` double-init risk under React Strict Mode

- **Where**: `apps/web/next.config.ts:11` (`reactStrictMode: true`); `apps/web/src/app/guard/page.tsx:139-160` (`startScanner`).
- **Effect**: `startScanner` unconditionally creates `new Html5Qrcode("qr-reader")` and calls `.start()` without checking `scannerRef.current`. `startScanner` is user-click-triggered (not an effect), so Strict Mode's double effect invoke does not directly hit it — but a double-click during slow camera init, or a re-enter after a failed stop, would attempt to bind a second scanner to the same DOM id and throw. The `catch` masks this as "Camera access denied or not available." Low likelihood of being the reported issue, but a real fragility.

### Issue 7 — Noted (not a bug): QR expiry is enforced only at scan time

- **Where**: `apps/api/src/routes/guard.ts:229` — `if (pass.status !== "OUTSIDE" && (pass.status === "EXPIRED" || (pass.qrExpiresAt && new Date() > pass.qrExpiresAt)))`.
- **Effect**: An `APPROVED` pass whose 8h `qrExpiresAt` has passed is correctly rejected as "expired" at scan time. There is no background job in the repo that proactively transitions `APPROVED → EXPIRED` (no cron/queue found). This is acceptable — expiry is enforced lazily — but it means the student's pass card will still show "AUTHORIZED FOR EXIT" visually until a scan rejects it. Not a guard-panel defect.

---

## Files and lines that need to change to fix the issues

Priority-ordered, with the concrete edit for each:

### Fix A (addresses Issue 1 + 2 — the actual "not working") — Surface shift-load errors and explain the disabled state
- **File**: `apps/web/src/app/guard/page.tsx`
  - `:101-103` — replace the bare `catch { setShiftInfo(null); }` with a block that captures the error (e.g., `setError("Could not load your shift. ...")` or a dedicated `shiftError` state) so the guard sees why scanning is unavailable.
  - `:344-352` (SCAN PASS button) and `:372` (manual lookup button) — add a visible helper text under the buttons when `!shiftInfo?.activeShift && !shiftLoading` explaining "Scanning is disabled until you start your shift" (and, if `shiftInfo === null` due to error, "Could not load shift info — check your connection or contact admin"). Currently the disabled button gives no hint.
  - `:318-322` (the "No active or upcoming shifts" fallback) — branch on whether `shiftInfo` is `null` (load failed) vs. a real empty object (no shifts) so the message is accurate.

### Fix B (addresses Issue 1 root cause) — Ensure guards have a profile + shift
- This is operational, not code: an admin must create the `GUARD` user with gate assignments (`apps/api/src/routes/admin.ts:570-577`) and schedule a `GuardShift` (`admin.ts:1169-1212`). No code change required unless you want to auto-create a default shift — not recommended. Fix A makes this discoverable instead of silent.

### Fix C (addresses Issue 3) — Gate-id fallback messaging
- **File**: `apps/web/src/app/guard/page.tsx:92-98` — when neither `activeShift.gateId` nor `assignedGates[0]` yields a gate, set an explicit `error` ("No gate assigned to your account. Contact admin.") rather than leaving `gateId=""` to be caught later by the mark handlers. Low priority since the mark handlers already message this.

### Fix D (addresses Issue 4) — Honor `NEXT_PUBLIC_WS_URL`
- **File**: `apps/web/src/lib/socket.ts:3` — change to `const WS_URL = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";` and keep the `replace("http","ws")` only as a fallback when the env is the HTTP URL. Alternatively, prefer `NEXT_PUBLIC_WS_URL` directly when set and skip the replace. This is a latent trap, not the current failure, but a cheap and safe fix.

### Fix E (addresses Issue 5) — Notify the student on exit/return
- **File**: `apps/api/src/routes/guard.ts` — in `mark-exit` (after the audit log at `:391-403`) and `mark-return` (after the audit log at `:494-510`), call `notifyUser(pass.student.userId, { title, body, type, data })` mirroring `hod.ts:262`. Requires including the student relation in the pass lookup inside the transaction (or a follow-up fetch). Follow the exact pattern in `hod.ts`.

### Fix F (addresses Issue 6) — Guard against double scanner init
- **File**: `apps/web/src/app/guard/page.tsx:139-160` — at the top of `startScanner`, if `scannerRef.current`, `await scannerRef.current.stop().catch(() => {})` and clear it before creating a new `Html5Qrcode`. Also disable the SCAN PASS button while `scanning` is true (it is hidden then, but a rapid re-click during teardown is still possible).

No code changes are recommended for Issue 7 (lazy expiry enforcement is fine).

---

## Verification notes

- I did **not** run the build, tests, or any server (read-only investigation as instructed). The `apps/api` test command is `vitest run` (`apps/api/package.json`); the web lint is `tsc --noEmit -p tsconfig.lint.json` (`apps/web/package.json`). None of the existing test files under `apps/api/src/routes/__tests__/` cover the guard routes directly (they cover admin/analytics/emergency/gate-health/revocation/tenant-boundary), so any fix to `guard.ts` should add guard-route tests.
- Route registration verified: `guardRoutes` is registered at prefix `/api/guard` in `apps/api/src/server.ts:31`; `wsRoutes` at `/ws` (`:38`); `authRoutes` at `/api/auth` (`:28`). Frontend calls match these prefixes (`/api/guard/shift/current`, `/api/guard/verify`, `/api/guard/mark-exit`, `/api/guard/mark-return`, `/api/guard/lookup`, `/api/guard/activity`, `/api/guard/emergency/active`, `/api/auth/me`, `/ws/connect`).
- `html5-qrcode` is a declared dependency (`apps/web/package.json`) and present in `node_modules`.
- Env: `apps/web/.env.local` sets `NEXT_PUBLIC_API_URL=http://localhost:4000` and `NEXT_PUBLIC_WS_URL=ws://localhost:4000`; `apps/api/.env` sets `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `FRONTEND_URL`, `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` (values redacted). The API client and socket both default to `http://localhost:4000` when env is missing.
- `PassStatus` enum (`packages/db/prisma/schema.prisma:27-37`) includes `ACTIVE`, so the verify action logic for `APPROVED|ACTIVE → MARK_EXIT` is valid.
- The repo is clean (`git status --short` empty) — no in-flight changes to reconcile.

## Conclusion

The guard panel and scan pass are wired correctly; the failure is operational (no active shift → disabled scanner) made invisible by silent error handling. Fix A (surface shift-load errors + explain the disabled scan button) is the single highest-value change and most likely resolves the user's "not working" report by making the root cause visible. Fix B is the operational counterpart (assign the guard a profile + shift). Fixes D–F are hardening and parity improvements, not blockers.
