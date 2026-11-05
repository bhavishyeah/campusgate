# CampusGate — Platform / Super-Admin API Contract (frontend ground truth)

Scope: the FRONTEND UI of the PLATFORM / SUPER ADMIN surface. This file is the
authoritative map of every backend endpoint the super-admin UI consumes, the
security gates on each, the exact step-up/MFA contract, request/response shapes,
error codes, and audit side-effects. Derived by reading the live handlers — not
re-derived from spec.

Sources read (ground truth):
- `apps/api/src/routes/platform.ts` (full file — endpoint list below is COMPLETE)
- `apps/api/src/services/support-grant.ts` (support grant + break-glass + audit service)
- `apps/api/src/middleware/step-up.ts` (`requirePlatformMfa`, `requireStepUp`)
- `apps/api/src/middleware/auth.ts` (`authenticate`, `requireSuperAdmin`, SUPER_ADMIN branch)
- `apps/api/src/routes/mfa.ts` (MFA plugin at `/api/auth/mfa`)
- `apps/api/src/server.ts` (prefix registration)
- `packages/shared/src/permissions.ts` (ROLE_PERMISSIONS.SUPER_ADMIN, platform.* keys)
- `packages/db/src/seed.ts` + `packages/db/prisma/schema.prisma` (seed super-admin + mfaEnabled default)
- web side: `apps/web/src/stores/auth.ts`, `apps/web/src/lib/landing.ts`,
  `apps/web/src/features/exams/useStepUp.ts`, `apps/web/src/components/exams/StepUpDialog.tsx`,
  `apps/web/src/app/platform/{layout,page}.tsx`, `apps/web/src/components/MfaEnrollment.tsx`,
  `apps/web/src/features/__tests__/pageAccess.test.ts`, `apps/web/src/lib/__tests__/landing.test.ts`

Registration (server.ts):
```
await app.register(mfaRoutes,      { prefix: "/api/auth/mfa" });
await app.register(platformRoutes, { prefix: "/api/platform" });
```

---

## 1. Plugin-level gates (apply to EVERY /api/platform/* route)

`platformRoutes` registers TWO `preHandler` hooks, in this exact order:

1. `requireSuperAdmin()` → `requireRole("SUPER_ADMIN")` → calls `authenticate`,
   then 403 `{ error: "Forbidden: insufficient role" }` if `user.role !== "SUPER_ADMIN"`.
2. `requirePlatformMfa()` → reads `mfaEnabled` on `privilegedPrisma` for the
   authed user. If NOT enrolled → **403 `{ error: "MFA enrollment required" }`**
   on EVERY platform route. EXEMPT paths (startsWith match on the route url):
   `/api/auth/mfa/enroll/start`, `/api/auth/mfa/enroll/verify`, `/api/auth/mfa/verify`
   — but those live on the mfa plugin, so in practice EVERY `/api/platform/*`
   route is gated: a `platform.*` holder WITHOUT `mfaEnabled` is 403'd everywhere
   on this prefix. The only way to clear it is to enroll via the mfa plugin.

So the base precondition for any platform call is: authenticated + SUPER_ADMIN
role + `mfaEnabled === true`. Individual routes layer additional `requirePermission`
and/or `requireStepUp` on top (see per-route rows).

**IMPORTANT for the UI:** there is NO endpoint that returns the caller's own
`mfaEnabled` flag. The enrollment-required state is detected by catching the
**403 `{ error: "MFA enrollment required" }`** from any platform call (the
existing `/platform` page does exactly this and shows `<MfaEnrollment />`).

### authenticate → SUPER_ADMIN branch (client-side identity signal)
- A SUPER_ADMIN has **no membership** and **no tenant context** (`request.tenant`
  stays undefined; `app.current_institution_id` is never set for them).
- `request.auth.roles = ["SUPER_ADMIN"]`, `request.auth.permissions` = the
  resolved `ROLE_PERMISSIONS.SUPER_ADMIN` set (the 7 `platform.*` keys below).
- JWT carries both the legacy `role: "SUPER_ADMIN"` claim AND `roles`/`permissions`.
- Account must be `ACTIVE` and its institution (PLATFORM) `ACTIVE`, else 401/403.

---

## 2. Step-up (x-step-up) contract — read once, applies to all high-risk ops

Guard: `requireStepUp(actionClass)` in `step-up.ts`.
- **Header name: `x-step-up`** (lowercase). Value = the step-up JWT string.
- The token is minted by **POST `/api/auth/mfa/verify`** (see §4). The body
  `action` (default `"support_grant.create"`) becomes the token's bound action
  class. Token response: `{ stepUpToken, action, expiresIn: 300 }` (5 min TTL).
- Verification checks: signature + expiry (same @fastify/jwt signer), `userId ===
  request.auth.userId`, `stepUp === true`, and `action === actionClass`.
- Missing/empty header → **401 `{ error: "Step-up required" }`**.
- Invalid/expired/mismatched-action/wrong-user token → **401 `{ error: "Step-up required" }`**.
- The 401 body `{ error: "Step-up required" }` is distinct from a session-expiry
  401 `{ error: "Unauthorized" }`. The UI MUST treat `"Step-up required"` as
  "open the step-up dialog and retry with `x-step-up`", NOT as a logout. (The
  exams publish flow already models this: `StepUpRequiredError`.)

**Action strings currently wired on the platform surface:**

| Action class string      | Where it is required                         |
|--------------------------|----------------------------------------------|
| `support_grant.create`   | POST `/api/platform/support-grants` (the ONLY step-up-gated platform route) |

No other platform route requires step-up today. (`exams.results.publish` exists
on the exams surface but is out of this surface's scope.) The step-up guard is a
single documented attach-point; future high-risk platform ops would attach their
own action class here, but NONE beyond `support_grant.create` are wired now.

**Minting flow for the UI (reuse the exams pattern):**
`POST /api/auth/mfa/verify { code, action: "support_grant.create" }` → returns
`{ stepUpToken }`. Then call the gated route with header `x-step-up: <stepUpToken>`.
Use raw `fetch` (as exams `publishRequest` does) so the header is attached; the
shared `api.*` helper does not add `x-step-up`.
`/verify` 400s to handle in the dialog: `{ error: "Invalid code" }` and
`{ error: "MFA not enrolled" }`.

---

## 3. Platform endpoints (COMPLETE — every route in platform.ts)

All rows below carry the plugin gates from §1 (`requireSuperAdmin` + `requirePlatformMfa`).
"Extra preHandler" lists what is layered ON TOP.

### 3.1 GET `/api/platform/stats`
- Extra preHandler: none (base gates only).
- Step-up: no.
- Request: none.
- Response 200:
  ```json
  {
    "institutions": { "total": 0, "active": 0, "suspended": 0 },
    "users":        { "total": 0, "students": 0 },
    "movement":     { "totalPasses": 0, "currentlyOutside": 0 }
  }
  ```
- Data source: cross-tenant counts via `privilegedPrisma` (bypasses RLS).
- Audit side-effect: none.

### 3.2 GET `/api/platform/institutions`
- Extra preHandler: none.
- Step-up: no.
- Request: none.
- Response 200: array of Institution rows, `orderBy createdAt desc`, each with
  `_count: { users, departments, gates, exitReasons }`. Cross-tenant via
  `privilegedPrisma`.
- Audit side-effect: none.
- NOTE: there is NO `GET /institutions/:id` single-fetch. The UI selects from
  this list client-side (not a gap).

### 3.3 POST `/api/platform/institutions`  — create institution + bootstrap admin
- Extra preHandler: none. Step-up: **no**.
- Request body: `{ name: string, code: string, adminEmail: string, domain?: string }`
  (`name`, `code`, `adminEmail` required).
- Responses:
  - 400 `{ error: "name, code and adminEmail are required" }`
  - 409 `{ error: "Institution code already exists" }`
  - 409 `{ error: "Admin email already in use" }`
  - 201:
    ```json
    {
      "institution": { "...full Institution row..." },
      "admin": { "id": "...", "email": "...", "role": "ADMIN" },
      "tempPassword": "<base64url, 12 chars>"
    }
    ```
- **BOOTSTRAP-SECRET CONTRACT (critical for UI):** `tempPassword` is a random
  `randomBytes(9).toString("base64url")` generated server-side, bcrypt-hashed
  (cost 12) into the new admin's `passwordHash`, and returned **IN PLAINTEXT
  EXACTLY ONCE** in this 201 response. It is:
  - **Never re-fetchable** — no endpoint returns it again; only the hash is stored.
  - **Never logged** — do not console.log / toast-log / send to analytics.
  - **Show-once** — the UI MUST display it in a copy-to-clipboard panel with a
    clear "this is shown only once" warning and NOT persist it to any store,
    localStorage, or query cache. On dialog close it is gone.
- Audit side-effect: none recorded by this handler (institution + admin created
  inside one `$transaction`, no `recordAuditEvent` call).

### 3.4 PUT `/api/platform/institutions/:id/status`
- Extra preHandler: none. Step-up: **no**.
- Request body: `{ status: "ACTIVE" | "SUSPENDED" }`.
- Responses:
  - 400 `{ error: "status must be ACTIVE or SUSPENDED" }`
  - 404 `{ error: "Institution not found" }`
  - 200: the updated Institution row.
- Audit side-effect: none recorded by this handler.
- Effect downstream: a SUSPENDED institution causes `authenticate` to 403
  (`Institution is suspended`) all its tenant users — the super admin is
  unaffected (PLATFORM institution).

### 3.5 Support grants (break-glass) — all require `platform.support.grant`

`actorOf(request)` = `{ userId, roleKey: roles[0] ("SUPER_ADMIN"), requestRef: request.id }`.

#### POST `/api/platform/support-grants`  — create grant (STEP-UP GATED)
- Extra preHandler: `requirePermission("platform.support.grant")` **then**
  `requireStepUp("support_grant.create")`.
- **Step-up: YES. action string = `support_grant.create`, header = `x-step-up`.**
  Missing/invalid token → 401 `{ error: "Step-up required" }`.
- Request body (zod `createSupportGrantSchema`):
  ```json
  {
    "institutionId": "<target tenant id, required>",
    "purpose": "<1..500 chars, required>",
    "expiresAt": "<ISO date; must be in the FUTURE and <= now + 4h>",
    "scope": { "modules": ["..."], "resources": ["..."] }   // optional, each <=50 items
  }
  ```
  - `grantedToUserId` is ALWAYS the caller (`request.auth.userId`), never from body.
  - Max TTL = 4 hours (`MAX_TTL_MS`). `expiresAt <= now` or `> now+4h` → 400.
- Responses:
  - 400 `{ error: "Invalid body", details: <zod flatten> }`
  - 404 `{ error: "Institution not found" }` (target tenant missing)
  - 201: the created SupportGrant row (`status: "ACTIVE"`, `activatedAt` set).
- Audit side-effects (SUCCESS, on `recordAuditEvent`, institutionId = target):
  `platform.support_grant.created` AND `platform.support_grant.activated`
  (Phase 0 collapses REQUESTED→ACTIVE).

#### DELETE `/api/platform/support-grants/:id`  — revoke grant
- Extra preHandler: `requirePermission("platform.support.grant")`. Step-up: **no**
  (revoke is lower-risk than create).
- Request body (optional): `{ reason?: string }`.
- Responses: 404 `{ error: "Support grant not found" }`; 200 = updated grant
  (`status: "REVOKED"`, `revokedAt`, `revokedByUserId`, `revokedReason`).
- Audit side-effect: `platform.support_grant.revoked` SUCCESS.

#### GET `/api/platform/support-grants`  — list grants
- Extra preHandler: `requirePermission("platform.support.grant")`. Step-up: **no**.
- Query: `?institutionId=<id>&status=<SupportGrantStatus>` (both optional).
- Response 200: array of SupportGrant rows, `orderBy createdAt desc`.
- Side-effect: opportunistic lazy-expiry — any ACTIVE row past `expiresAt` is
  flipped to EXPIRED and emits ONE `platform.support_grant.expired` SUCCESS audit
  (idempotent across concurrent loaders). The returned row reflects EXPIRED.

#### GET `/api/platform/support-grants/:id/tenant/overview`  — break-glass read
- Extra preHandler: `requirePermission("platform.support.grant")`. Step-up: **no**.
- Request: none (grant id in path).
- **Break-glass reason/consent semantics:** the "reason/consent" is carried by the
  GRANT itself, created earlier via POST /support-grants with its `purpose` (1..500
  chars, the human reason) and a bounded `expiresAt` (<=4h). This read endpoint
  does NOT take a fresh reason; it validates the EXISTING grant. Validation
  (`validateGrantForAccess`, all on privilegedPrisma, never trusts `status` alone):
  grant must exist, be ACTIVE (lazy-expired if past `expiresAt`), be bound to the
  CALLING operator (`grantedToUserId === caller`), and the target institution must
  be ACTIVE. The actual tenant read runs inside the READ-ONLY `withSupportGrant`
  (RLS-scoped) and returns the tenant's 50 most-recent `auditEvents` + 50 most-recent
  `passes`.
- Responses:
  - 403 `{ error: "Break-glass access denied" }` (notFound / notActive / expired / notOperator)
  - 403 `{ error: "Institution suspended" }`
  - 500 `{ error: "Audit write failed" }` (the mandatory SUCCESS audit write failed → access aborted, result discarded)
  - 200 `{ institutionId, auditEvents: [...], passes: [...] }`
- Audit side-effects: on EVERY denial, a DENIED `platform.support_grant.accessed`
  (with `metadata.reason`); on success, ONE SUCCESS `platform.support_grant.accessed`
  written AFTER the read returns (with `auditEventCount`/`passCount`). A failed
  SUCCESS-audit write aborts the whole access (→ 500).

#### GET `/api/platform/audit-events`  — platform audit explorer
- Extra preHandler: **`requirePermission("platform.security.respond")`** (NOTE:
  different key from the other support-grant routes). Step-up: **no**.
- Query: `?scope=platform|grant` (default `platform`), `?grantId=<id>` (required
  when `scope=grant`), `?limit=<1..100>` (default 50, clamped).
- Pagination/filter shape: limit-based, NO offset/cursor — it returns the newest
  `limit` rows (`orderBy timestamp desc`, `take` clamped to [1,100]). `scope=platform`
  returns rows with `institutionId = null` (platform-level events). `scope=grant`
  validates an ACTIVE grant (same `validateGrantForAccess` as break-glass) and
  returns rows for that grant's tenant only.
- Responses:
  - 400 `{ error: "scope must be platform or grant" }`
  - 400 `{ error: "grantId is required for scope=grant" }`
  - 403 `{ error: "Grant access denied" }` (grant validation failed for scope=grant)
  - 200 `{ events: [...] }`
- Audit side-effect: `scope=grant` goes through `validateGrantForAccess`, which
  writes a DENIED `platform.support_grant.accessed` on failure. `scope=platform`
  writes nothing.

### 3.6 Module entitlements — all require `platform.entitlements.manage`

#### POST `/api/platform/institutions/:id/modules`  — grant entitlement
- Extra preHandler: `requirePermission("platform.entitlements.manage")`. Step-up: **no**.
- Request body: `{ moduleKey: string }` (must be in `MODULE_KEY_SET`).
- Responses: 400 `{ error: "Unknown moduleKey" }`; 404 `{ error: "Institution not found" }`;
  200 `{ institutionId, moduleKey, state: "ENTITLED" }` (idempotent if already entitled).
- Audit side-effect: `platform.module.entitled` SUCCESS (institutionId = target tenant,
  `metadata.idempotentNoop` true when it was already entitled).

#### DELETE `/api/platform/institutions/:id/modules/:moduleKey`  — revoke entitlement
- Extra preHandler: `requirePermission("platform.entitlements.manage")`. Step-up: **no**.
- Responses:
  - 400 `{ error: "Unknown moduleKey" }`
  - 404 `{ error: "Module not entitled for this institution" }`
  - 409 `{ error: "Module has active or suspended dependents", moduleKey, blockingDependents: [...] }`
  - 200 `{ institutionId, moduleKey, state: "NOT_ENTITLED", warnings: { affectedDependents: [...] } }`
- Audit side-effect: `platform.module.revoked` SUCCESS (with `affectedDependents`).

#### GET `/api/platform/institutions/:id/modules`  — module matrix
- Extra preHandler: `requirePermission("platform.entitlements.manage")`. Step-up: **no**.
- Response 200: `{ institutionId, modules: [{ moduleKey, name, state, entitledAt,
  activatedAt, suspendedAt }] }` — iterates the STATIC `MODULES` catalogue so
  `NOT_ENTITLED` keys are always present (default state when no row).
- Audit side-effect: none (read).

---

## 4. MFA plugin (/api/auth/mfa) — enrollment + step-up minting

Registered with ONLY `authenticate` as preHandler (available to any authed user;
MANDATORY only for platform accounts via `requirePlatformMfa`). These are the
routes exempt from the platform MFA gate, so an un-enrolled super admin can reach
them.

### POST `/api/auth/mfa/enroll/start`
- Request: none. Response 200 `{ otpauthUri, qrCodeDataUrl }`. Stores a pending
  `mfaSecret` but does NOT flip `mfaEnabled`.
- 401 `{ error: "Unauthorized" }` if user vanished.

### POST `/api/auth/mfa/enroll/verify`
- Request `{ code: string }`. Verifies first TOTP code, flips `mfaEnabled = true`,
  sets `mfaEnrolledAt`, generates recovery codes.
- 400 `{ error: "Invalid code" }` / `{ error: "Enrollment not started" }`.
- 200 `{ enabled: true, recoveryCodes: [plaintext...] }` — recovery codes are
  returned **plaintext ONCE** (only hashes persisted). SHOW-ONCE, never re-fetchable.
- Audit: `platform.mfa.enrolled` SUCCESS (or DENIED on bad code).

### POST `/api/auth/mfa/verify`  — mint step-up token
- Request `{ code: string, action?: string }` (`action` default `"support_grant.create"`).
- Accepts a TOTP code OR a single-use recovery code (consumed on use).
- 400 `{ error: "Invalid code" }` / `{ error: "MFA not enrolled" }`.
- 200 `{ stepUpToken, action, expiresIn: 300 }` — the token to put in `x-step-up`.
- Audit: `platform.mfa.step_up` SUCCESS (or DENIED on bad code).

---

## 5. Error-code summary (what the UI must branch on)

| Status | Body error                        | Meaning / UI action |
|--------|-----------------------------------|---------------------|
| 401    | `Unauthorized`                    | No/invalid session → login |
| 401    | `Session revoked or expired`      | session gone → login |
| 403    | `Forbidden: insufficient role`    | not SUPER_ADMIN → not a platform user |
| 403    | `Institution is suspended`        | platform account's own institution suspended |
| **403**| **`MFA enrollment required`**     | **platform.* holder WITHOUT mfaEnabled → show MFA enrollment, do NOT logout** |
| **401**| **`Step-up required`**            | **high-risk op needs fresh step-up → open step-up dialog, retry with `x-step-up`, do NOT logout** |
| 400    | various (see per-route)           | validation |
| 404    | `Institution not found` / `Support grant not found` / `Module not entitled...` | |
| 409    | `Institution code already exists` / `Admin email already in use` / `Module has active or suspended dependents` | |
| 500    | `Audit write failed`              | break-glass access aborted |

---

## 6. Role-capability matrix (super-admin account only)

- Platform access is **one legacy role, `SUPER_ADMIN`** (User.role enum), which
  resolves to a FIXED set of 7 `platform.*` permission keys via
  `ROLE_PERMISSIONS.SUPER_ADMIN`. There is no per-admin sub-role differentiation
  today; a SUPER_ADMIN holds all 7:
  ```
  platform.institutions.manage
  platform.analytics.view
  platform.onboarding
  platform.entitlements.manage
  platform.subscriptions.manage
  platform.support.grant
  platform.security.respond
  ```
- Per-route permission requirements actually enforced on the platform surface:
  - `platform.support.grant`      → all `/support-grants*` routes
  - `platform.security.respond`   → `GET /audit-events`
  - `platform.entitlements.manage`→ all `/institutions/:id/modules*` routes
  - stats / institutions list / create / status → base gates only (no extra key;
    `platform.institutions.manage`/`platform.analytics.view` are held but NOT
    consumed as explicit route guards — the SUPER_ADMIN role gate covers them).
- **Client-side super-admin identity signal:** the authoritative check is the
  **role**. `useAuthStore` exposes `roles: string[]` (from the JWT) and
  `user.role` (legacy claim). The existing `/platform/layout.tsx` guards on
  `user.role !== "SUPER_ADMIN"`; `landing.ts` keys off `roles.includes("SUPER_ADMIN")`.
  So the client identifies a super admin by **`roles.includes("SUPER_ADMIN")`**
  (equivalently `user.role === "SUPER_ADMIN"`), NOT by a `platform.*` permission
  and NOT by a standalone flag.
- **Landing (load-bearing order):** `landingRoute()` check #1 is
  `if (roles.includes("SUPER_ADMIN")) return "/platform";` — it is FIRST, ahead of
  all legacy-role and permission-driven landings. Confirmed by `landing.test.ts`
  ("sends a SUPER_ADMIN to /platform"). Do not reorder.

---

## 7. Seed MFA state (REAL)

- Schema default: `User.mfaEnabled Boolean @default(false)`; `mfaSecret`,
  `mfaRecoveryCodes`, `mfaEnrolledAt` are all nullable/unset by default.
- `packages/db/src/seed.ts` creates `superadmin@campusgate.local` /
  `superadmin123` with `role: SUPER_ADMIN`, `accountStatus: ACTIVE`,
  `institutionId: PLATFORM` — and does **NOT set `mfaEnabled`**. So the seeded
  super admin has **`mfaEnabled = false`** (not enrolled), with no membership.
- **Consequence for the UI (first thing to verify):** on first login the seeded
  super admin will be **403 `MFA enrollment required`** on every `/api/platform/*`
  call. The platform UI MUST, before anything else, detect that 403 and route the
  operator through MFA enrollment (`POST /api/auth/mfa/enroll/start` →
  `/enroll/verify`) — the existing `/platform` page + `<MfaEnrollment />` already
  implement exactly this fallback. The enrollment flow is therefore the FIRST
  functional path the platform UI must get right.

---

## 8. Backend gaps found

Assessed every screen the super-admin UI needs against the endpoint list in §3:

- Institution list / create (with show-once bootstrap secret) / status toggle → covered.
- Per-institution module matrix + grant + revoke → covered (`/institutions/:id/modules`).
- Support grants list (filterable by institution/status) / create (step-up) /
  revoke / break-glass tenant overview → covered.
- Platform + per-grant audit explorer → covered (`/audit-events`).
- MFA enrollment + step-up token minting → covered (mfa plugin).
- Single-institution GET and single-grant GET are NOT exposed, but the list
  endpoints return full rows and the UI selects client-side — NOT a functional gap.

**Conclusion: NO backend gap.** The platform surface is fully served by existing
read/write endpoints, and every high-risk action the UI needs (`support_grant.create`)
has an obtainable step-up action string. No backend change was required, so none
was made (standing least-privilege rule: do not touch auth/MFA/step-up boundaries,
add permission keys, or migrate). No `feat(api)` commit in this step.

## 9. Test results

No backend code was changed in this setup step, so no new api tests were written
or run (the instruction to run `npm test -w @campusgate/api` and the
`superadmin-security` live suite is conditioned on a sanctioned backend fix; there
was none). Baseline api test count (768) is unchanged — this step added zero tests
and removed zero tests.
