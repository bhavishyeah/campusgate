# CAMPASS Super Admin & Platform Security (C)

> Owning doc for decision **D4 (Super Admin = zero standing access + audited break-glass
> + MFA)**. Builds on the identity model in [`identity-rbac.md`](./identity-rbac.md) and
> the isolation model in [`tenancy.md`](./tenancy.md).

---

## 1. Principle

Platform power is **not** a license to silently read every student's personal data. The
Super Admin operates the platform; it does **not** have standing (always-on) access to
any institution's operational records. When support genuinely requires tenant data
access, it happens through a **time-limited, purpose-bound, tenant-visible, revocable,
fully audited** break-glass grant — and nothing broader.

This closes the most common ERP trust failure: an all-powerful platform account that can
read anyone's data invisibly.

---

## 2. Platform vs. tenant permission split

Super Admin capability is decomposed into **separate** permissions. Holding one does not
imply the others.

| Capability | What it allows | Grants tenant data access? |
|---|---|---|
| `platform.institutions.manage` | Create / activate / suspend / archive institutions | No |
| `platform.onboarding` | Invite initial Institution Admin, bootstrap setup | No |
| `platform.entitlements.manage` | Grant/revoke module entitlements | No |
| `platform.subscriptions.manage` | Plans, billing status | No |
| `platform.analytics.view` | Platform-wide **aggregate** metrics only (counts, health) | No (aggregates, never row-level PII) |
| `platform.support.grant` | Initiate a break-glass `SupportGrant` into one tenant | Only via an audited grant (§4) |
| `platform.security.respond` | Security incident response actions | Scoped + audited |

**Default standing access of a Super Admin = platform operations only.** No tenant
operational rows. The existing code already blocks the platform role from tenant
endpoints (`requireTenantRole` rejects `SUPER_ADMIN`); this doc formalizes and extends
that into the permission model of [`identity-rbac.md`](./identity-rbac.md).

> Platform analytics must be built on **aggregates/de-identified** data. A platform
> metric endpoint must not become a backdoor to row-level tenant PII.

---

## 3. Super Admin under RLS

From [`tenancy.md`](./tenancy.md): the application database role used by Prisma is a
non-superuser, non-`BYPASSRLS` role. The Super Admin therefore does **not** get a
blanket RLS bypass. Two access paths exist:

- **Platform tables** (`Institution`, entitlements, subscriptions, `SupportGrant`) —
  not tenant-owned; Super Admin accesses them through platform endpoints.
- **Tenant data** — only by setting `app.current_institution_id` to **one** institution
  under an active `SupportGrant` (§4). Same RLS mechanism as a normal tenant request,
  scoped to a single institution, and every access is attributed to the grant.

There is intentionally **no** code path where the Super Admin reads across all tenants'
operational rows at once.

---

## 4. Break-glass: the `SupportGrant` model

### 4.1 Concept

A `SupportGrant` is an explicit, auditable authorization for a specific platform
operator to access **one** institution's data for a **stated purpose** for a **limited
time**. The institution can see it and revoke it.

### 4.2 Shape (schema lands in [`database.md`](./database.md))

```text
SupportGrant
 ├── id
 ├── institutionId        -> the ONE tenant this grants access to
 ├── grantedToUserId      -> the platform operator (Super Admin / support user)
 ├── purpose              -> required free-text reason (why access is needed)
 ├── scope                -> optional: limit to certain modules/resources
 ├── status               (REQUESTED | ACTIVE | EXPIRED | REVOKED)
 ├── requestedAt, activatedAt
 ├── expiresAt            -> hard time limit (e.g. minutes–hours)
 ├── revokedAt, revokedByUserId, revokedReason
 └── createdAt
```

### 4.3 Properties (all required)

- **Purpose-bound** — a non-empty `purpose` is mandatory to create the grant.
- **Time-limited** — `expiresAt` is enforced; after it, access stops automatically.
- **Single-tenant** — one `institutionId` per grant; never "all tenants."
- **Tenant-visible** — the institution's admins can see active and historical grants
  affecting them (surfaced in their Audit Explorer).
- **Revocable** — the institution admin (and the platform) can revoke immediately.
- **Audited** — creation, activation, every data access under it, expiry, and revocation
  all write audit events referencing the grant ID.

### 4.4 Access flow

```text
Super Admin needs tenant data
        |
Creates SupportGrant(institutionId, purpose, expiresAt)   [requires platform.support.grant + MFA]
        |
Grant ACTIVE (visible to the institution; audit event written)
        |
Requests run with app.current_institution_id = that institution   [RLS scopes to one tenant]
        |            every access -> audit event referencing grantId
        |
expiresAt reached OR revoked  ->  access ends; audit event written
```

### 4.5 Emergency access

If a scenario needs access faster than a normal grant flow, it uses a **separate,
even-more-tightly-controlled** emergency path (stricter MFA/approval, shorter TTL, louder
alerting to the institution). It is still single-tenant, time-limited, and audited — it
is never an unlogged master key. Exact emergency policy is defined when the support
operation is built.

---

## 5. MFA and step-up authentication

### 5.1 MFA policy

- **Required** for all platform accounts (anyone holding a `platform.*` permission).
- **Available** (optionally required by institution policy) for Institution Admins and
  other privileged tenant roles.
- `User` carries `mfaEnabled` / `mfaSecret?` (and recovery/backup-code storage); the
  exact TOTP/WebAuthn mechanism is chosen at implementation. The model leaves room; the
  policy is: platform = mandatory.

### 5.2 High-risk step-up

Certain actions require **re-authentication / a fresh MFA assertion** at the moment of
the action, regardless of an otherwise-valid session:

- Creating or activating a `SupportGrant`.
- Changing permissions / roles.
- Revoking a pass; approving financial refunds/adjustments; publishing exam results;
  suspending an institution; bulk destructive operations.

Step-up pairs with the "re-check permission at point of action" rule in
[`identity-rbac.md`](./identity-rbac.md) §5.3 — for the riskiest actions we trust neither
the token alone nor the UI.

> **Do not** rely on browser fingerprinting as a primary authentication mechanism. It is
> at most a signal for new-device detection, never a gate.

---

## 6. AuditLog v2

Today's `AuditLog` has a gatepass-specific action enum and no `institutionId`. The ERP
needs a **generic, tenant-scoped** audit record every module can write to.

### 6.1 Target shape

```text
AuditEvent
 ├── id
 ├── institutionId?      -> tenant scope (null only for pure platform actions)
 ├── actorUserId         -> who acted
 ├── actorMembershipId?  -> which membership/role context (null for platform actors)
 ├── actorRoleKey        -> role at time of action (snapshot)
 ├── action              -> STRING, "<module>.<action>" (NOT a fixed enum)
 ├── resourceType        -> e.g. "GatePass", "FeePayment", "Student"
 ├── resourceId
 ├── result              (SUCCESS | DENIED | ERROR)
 ├── supportGrantId?     -> set when the action happened under a break-glass grant
 ├── requestRef?         -> correlation/request id
 ├── metadata            -> JSON, minimal; NO indiscriminate PII copying
 └── timestamp           -> server-controlled
```

### 6.2 Why a string `action`, not an enum

A fixed enum (as today) forces a schema/enum migration every time any module adds an
auditable action. A validated string keyed `<module>.<action>` lets every future module
record audit events without touching the core enum — critical for a platform with many
modules. Validation/allow-list lives in the shared catalogue alongside permissions.

### 6.3 Protections

- Append-only in practice: no ordinary update/delete path; corrections are new events.
- Tenant-scoped under RLS (it carries `institutionId`), so an institution admin's Audit
  Explorer sees only their events; the platform sees platform events and, for a tenant,
  only what a grant authorizes.
- `supportGrantId` makes every break-glass access traceable to its grant.
- Metadata is minimal — never dump full records or secrets into logs.

### 6.4 Audit Explorer scopes

- **Institution Admin:** searches their institution's events by date / actor / action /
  resource / result / module — **including** any `SupportGrant` accesses into their
  tenant (transparency).
- **Super Admin:** searches **platform** events; tenant events only within an authorizing
  grant's scope.

---

## 7. Session & device security (carried forward)

The existing mechanisms are kept and extended; they already match best practice.

Kept as-is:

- JWT with a per-session `jti`; sessions table enables individual revocation.
- Login records device/browser/OS/IP; `SecurityEvent` logs login success/failure,
  logout, revocation, etc.
- Suspended-institution check on every authenticated request.
- "Logout all other sessions" / revoke a specific session.

Extended for the ERP:

- `SecurityEvent.institutionId` becomes reliably populated (tenant-scoped security
  timeline).
- New-device login notification (`NEW_DEVICE_LOGIN` already in the enum) wired to the
  notification engine.
- Failed-login throttling / account lockout policy made explicit.
- Session revocation triggered by sensitive permission changes (ties to
  [`identity-rbac.md`](./identity-rbac.md) §5.3).

---

## 8. Checklist (platform & sensitive-action security)

- [ ] Super Admin has **no** standing tenant-data access (platform permissions only).
- [ ] Prisma connects as a non-superuser, non-`BYPASSRLS` role (see `tenancy.md`).
- [ ] Platform analytics expose aggregates/de-identified data only.
- [ ] `SupportGrant` is single-tenant, purpose-bound, time-limited, tenant-visible,
      revocable, and audited.
- [ ] MFA mandatory for platform accounts; step-up required for high-risk actions.
- [ ] AuditLog v2 is generic (string action), tenant-scoped, append-only, references
      `supportGrantId` for break-glass access.
- [ ] High-risk actions re-check permission at the point of action, not just via the
      token.
- [ ] No feature relies on browser fingerprinting as primary auth.

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-18 | Initial Super Admin/security doc: platform-vs-tenant permission split, zero standing access under RLS, `SupportGrant` break-glass model, MFA + step-up policy, AuditLog v2 schema and rationale, session/device carry-over, checklist. |
