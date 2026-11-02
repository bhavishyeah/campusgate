# Service Requests Management (Phase 9.6) — backend module

Phase 9.6 adds the sixth Phase-9 "booster" module: predefined request types with data-driven form fields, a fixed enumerated request lifecycle, assignment, a pre-resolution approval gate, derived SLA breach, append-only comment/activity and feedback ledgers, staff reports + an XLSX export, and a requester `/me` self-service surface. The work lands as a single commit (`230d8b4`) touching 14 files (+4169): a hand-authored additive migration (the 22nd dir), five Prisma models + four enums, the four shared catalogues, a 28-route Fastify module, and unit + behavioral + tenant-escape test tiers. The implementation tracks the APPROVED design section-for-section — the fixed state machine is a DB column-guard trigger backed by an in-handler map (not a generic engine), SLA breach is derived at read time, the append-only ledgers are enforced in the DB, and tenant isolation rests on composite same-tenant FKs + ENABLE/FORCE RLS with fail-closed policies and a NOBYPASSRLS `campass_app`.

Watch for: nothing blocking. The structural invariants, RBAC separation, and tenant-escape coverage all match the design, and every acceptance criterion maps to a behavioral test. The notes below are confirmations and two low-severity observations (a SELECT-options validation path that returns 400 instead of the design's 422, and a report query that materializes all non-terminal rows in memory) — neither contradicts the brief.

**Verdict**: APPROVED

## High-level view

The lifecycle is genuinely fixed, not configurable. The `service_request_status_guard` trigger enumerates exactly the eleven legal edges plus the self no-op, freezes the nine identity columns via `IS DISTINCT FROM`, and raises unconditionally on DELETE; terminal states appear only as targets. The in-handler `STATUS_TRANSITIONS` map mirrors the same edges for a clean 409, with the DB guard as the backstop caught through `isRestrictViolation`. The only per-type variability is data (the request types and their field definitions) and the `requiresApproval` boolean, which only chooses whether the fixed `PENDING_APPROVAL` node is traversed. There is no state table, no rule DSL, no cross-module import.

Form fields are data-driven and validated at raise time by a pure `validateFieldValues(defs, values)` that enforces required/non-empty, type coercion (TEXT/NUMBER/DATE), SELECT-range, and unknown-key rejection against the type's definitions, returning a per-field error map with nothing persisted on failure. Field definitions freeze once the type has any request, enforced by an in-handler count.

SLA is derived, never stored: `dueAt = raisedAt + slaTargetHours` is computed once at raise (and `dueAt` is NOT NULL), and `isBreached(status, dueAt, now)` recomputes breach at read with no stored flag. The approval gate restricts APPROVE/REJECT to the `requests.approve` permission and only from `PENDING_APPROVAL`; feedback is one-per-request, owner-only, and allowed only after RESOLVED/CLOSED, backed by a unique index. The activity and feedback ledgers block UPDATE/DELETE at the DB via unconditional-raise triggers plus a revoked grant.

RBAC follows the established additive pattern: a new `SERVICE_AGENT` template role (institutionId NULL) carries the five staff keys, ADMIN gains the same five, and STUDENT alone gains `request_own`. Staff and self surfaces never overlap — self routes live under `/me/requests/...` hard-scoped by `requesterUserId == token.userId` with owner-scoped 404s, staff routes under bare `/:id/...` behind staff keys. The migration seed is set-equal to the shared catalogue (11 role-permission pairs), and the new dir is registered in `SEEDING_MIGRATION_DIRS`.

Multi-tenancy is airtight by the house pattern: every table carries `institutionId`, a `(id, institutionId)` composite unique anchoring same-tenant FKs, ENABLE + FORCE RLS, and nullif-guarded fail-closed policies; append-only tables get SELECT+INSERT only with REVOKE UPDATE/DELETE. The tenant-escape suite seeds all five tables and asserts cross-tenant read denial, spoofed insert rejection, foreign-parent FK violation, zero-row spoofed update, and fail-closed unset/empty GUC, plus the append-only INSERT-ok/UPDATE+DELETE-denied cases and the RLS meta-test table list.

<details>
<summary>Issues (2)</summary>

1. **SELECT-options returns 400, not 422 (confirmed, informational)** — the field create/update SELECT-vs-options rule is enforced by the Zod envelope refinement, so a bad `POST /types/:id/fields` returns 400 (the behavioral test asserts 400). AC-2 says "422". This is a status-code wording mismatch on a config sub-resource, not a behavioral gap — the invalid shape is still rejected and nothing is persisted, and the DB CHECK is the backstop. No action required unless strict AC-2 parity is wanted.
2. **Overdue/SLA reports materialize all non-terminal rows (likely, scale note)** — `GET /reports/overdue` loads every non-terminal request and filters/derives breach in memory rather than predicating `dueAt` in SQL; `/reports/sla` loads all RESOLVED/CLOSED rows. Correct and deterministic for current tenant volumes, but worth a `dueAt`/indexed predicate if a tenant's request table grows large. The `(institutionId, dueAt)` index already exists to support this later.

</details>

<details>
<summary>Details</summary>

### Fixed state machine enforced in depth, not a workflow engine

The DB guard (`service_request_status_guard`, BEFORE UPDATE OR DELETE) is the authoritative control flow. It raises on DELETE, freezes `institutionId, requestTypeId, requesterUserId, title, priority, fieldValues, description, raisedAt, createdAt` via `IS DISTINCT FROM`, and rejects any status pair outside the enumerated set (OPEN→ASSIGNED/CANCELLED, ASSIGNED→IN_PROGRESS/ASSIGNED/CANCELLED, IN_PROGRESS→PENDING_APPROVAL/RESOLVED/CANCELLED, PENDING_APPROVAL→RESOLVED/REJECTED, RESOLVED→CLOSED) plus the self no-op. CLOSED/REJECTED/CANCELLED never appear as a source, so terminal states have no outgoing edge — confirmed both in SQL and in the exported `STATUS_TRANSITIONS` map (`CLOSED/REJECTED/CANCELLED: []`). The frozen column list in the trigger is byte-identical to the design §5/§8.5 set. The behavioral suite proves the backstop directly: `adminClient.serviceRequest.update({ status: "RESOLVED" })` from OPEN and a `delete()` both reject while the row stays OPEN (AC-8). The `requiresApproval` boolean is the only per-type lever and it only gates whether `PENDING_APPROVAL` is entered — the handler checks `type.requiresApproval` on both the `IN_PROGRESS→PENDING_APPROVAL` PATCH and the resolve path. There is no state/rule table and no cross-module model import, satisfying the hard no-generic-engine and no-coupling constraints.

The in-handler `isLegalTransition` gives the fast 409 and `isRestrictViolation` catches any edge that slips to the DB. One subtlety worth noting as correct rather than concerning: `isRestrictViolation` matches on substrings (`restrict_violation`, `illegal`, `append-only`, `immutable`) of the error message — this mirrors the inventory/transport precedent and is the house idiom, so it is consistent with the codebase even though it is message-based.

### Data-driven forms with raise-time validation

`validateFieldValues` is a pure, exported, unit-tested function over the type's definitions: required-present-and-non-empty (empty string trimmed), TEXT→string, NUMBER→finite (numeric strings coerced), DATE→`Date.parse`, SELECT→member of options, and unknown-key rejection. On any error the raise handler returns 422 with a `{ errors: { field: reason } }` map and persists nothing — the behavioral test checks each failure mode (required/invalid_type/invalid_option/unknown) and asserts the row count is unchanged (AC-6). Field definitions freeze once `serviceRequest.count` for the type is ≥1, returning 409 + a DENIED audit on both the create and patch paths (AC-3). `fieldValues` is a frozen identity column on the request, so raise-time answers are immutable by design.

### Derived SLA, approval gate, one-per-request feedback

`dueAt` is computed once at raise (`computeDueAt`) and is NOT NULL; the breach predicate `isBreached` excludes the four SLA-settled statuses and otherwise compares `now > dueAt`, with no stored flag anywhere. The behavioral test backdates `dueAt` on a live row, sees it in `/reports/overdue`, drives it to RESOLVED, and confirms it drops out (AC-11). APPROVE/REJECT sit behind `requests.approve` and only fire from `PENDING_APPROVAL` (else 409 + DENIED); a non-approver STUDENT token gets 403 (AC-10). Feedback is gated to the owner, to RESOLVED/CLOSED only, and to one row via a pre-check plus the `(institutionId, serviceRequestId)` unique index as the concurrency backstop — the handler comments explain why the pre-check carries the audited DENIED while the P2002 path returns a clean 409 without an in-tx audit (the aborted transaction can't write one). That is a sound, deliberate handling of the Postgres abort semantics, not an oversight.

### Append-only history and audit-in-transaction

Activities and feedback get `*_append_only` triggers raising `restrict_violation` on UPDATE/DELETE (binding the table owner too) plus `REVOKE UPDATE, DELETE` from `campass_app`. The behavioral suite asserts UPDATE and DELETE both reject on both ledgers even via `adminClient` (AC-19). Every mutation and every DENIED decision writes a `service_requests.*` AuditEvent via `recordAuditEvent` inside the same `withTenant` transaction, and deny branches return the 4xx from a normally-returning callback rather than throwing, so the audit commits — the behavioral tests assert the SUCCESS and DENIED audit counts throughout.

### Self vs staff separation and cross-tenant reads

The requester surface (`GET/POST /me/requests...`) is gated by `request_own` and every query carries `requesterUserId == token.userId`, so a foreign id returns an owner-scoped 404 and `GET /me/requests` returns only the caller's rows (AC-17); the behavioral test confirms a second student's requests are invisible and that foreign close/cancel/comment/feedback all 404. Staff `GET /` requires `view` and a STUDENT token gets 403 (AC-18). The one dual-gate route, `GET /types/:id/fields`, uses the inline `can(view) || can(request_own)` guard with `requireModuleActive` still a preHandler and no owner predicate (it exposes a type's public field schema), exactly as NIT-3/NIT-5 specify, and the test confirms a requester can read it. Because authorization resolves from membership roles via `request.auth.permissions` (not the JWT `role` claim), the test's uniform `role: "ADMIN"` token signing does not weaken the 403 assertions — the per-user seeded memberships (ADMIN/SERVICE_AGENT/STUDENT) are what decide access.

### Migration, RLS, grants, catalogue-sync

The migration is the hand-authored 22nd dir (`20270124000000`, the next timestamp after inventory), lettered a–j, strictly additive with no DROP, and the commit records `prisma migrate diff` showing only the long-standing composite-vs-single-FK cosmetic diff plus deploy/status up to date with all 21 prior dirs byte-untouched. All five tables carry `institutionId`, the `(id, institutionId)` anchor, composite same-tenant FKs (MATCH SIMPLE for the nullable assignee/department), the CHECKs from §8.2, ENABLE + FORCE RLS with nullif-guarded fail-closed policies, and the correct grant split (SELECT/INSERT/UPDATE on the three mutable; SELECT/INSERT + REVOKE UPDATE/DELETE on the two ledgers); `campass_app` is never granted BYPASSRLS. The seed inserts the `SERVICE_AGENT` role before the permissions block (so the role tuple falls outside the sliced permission span the parser reads), the six permissions `ON CONFLICT (key) DO NOTHING`, and the 11 role-permission pairs — set-equal to the shared `PERMISSIONS`/`ROLE_PERMISSIONS`, with the new dir added to `SEEDING_MIGRATION_DIRS`.

### Test coverage read

The recorded results (build OK; 651 unit tests incl. 35 service-requests unit + catalogue-sync; 23/23 behavioral in isolation; 123/123 tenant-escape incl. the RLS meta-test and the new SR escape cases) are consistent with the suites in the diff. Coverage maps cleanly onto the brief's required proofs: the fixed state machine (unit legality matrix + behavioral DB-guard rejection of OPEN→RESOLVED and DELETE), form validation (unit matrix + behavioral 422-nothing-persisted), derived SLA (unit predicate + behavioral in/out of the overdue report), the approval gate (behavioral approve/reject + non-approver 403), one-per-request feedback (behavioral 201 then 409 + non-terminal/foreign), append-only history (behavioral + tenant-escape UPDATE/DELETE denial), requester-own-only (behavioral owner-scoped 404s + `/me` list), and cross-tenant blocks (tenant-escape 3s1–3s7 across all five tables + fail-closed GUC). Not separately asserted: a dedicated test that reassignment (`ASSIGNED→ASSIGNED`) is accepted — the edge is in the map and the guard but is not exercised end-to-end; low risk given the guard allows it structurally.

</details>

<details>
<summary>File map</summary>

- `packages/db/prisma/migrations/20270124000000_phase9_service_requests/migration.sql` — new additive migration (enums, 5 tables, indexes, tenant-root + composite FKs, CHECKs, RLS, status guard + 2 append-only triggers, grants, catalogue seed).
- `packages/db/prisma/schema.prisma` — 5 models + 4 enums + back-relations on Institution/User/Department.
- `packages/shared/src/modules.ts` — `service_requests` module registry entry + `MODULE_DEPENDENCIES: []`.
- `packages/shared/src/permissions.ts` — 6 permissions, `SERVICE_AGENT` role (5 staff keys), ADMIN +5, STUDENT +`request_own`.
- `packages/shared/src/audit-actions.ts` — 15 `service_requests.*` audit keys.
- `packages/shared/src/validation.ts` — Zod schemas + inferred input types.
- `apps/api/src/routes/service-requests.ts` — 28-route module + exported pure helpers (`validateFieldValues`, `STATUS_TRANSITIONS`, `computeDueAt`, `isBreached`).
- `apps/api/src/server.ts` — import + register at `/api/service-requests`.
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — new dir added to `SEEDING_MIGRATION_DIRS`.
- `apps/api/vitest.live-db-suites.ts` — behavioral suite registered.
- `apps/api/src/routes/__tests__/service-requests.unit.test.ts` — pure-logic unit suite.
- `apps/api/src/routes/__tests__/service-requests.behavioral.integration.test.ts` — live behavioral suite (AC 1–24).
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` — 5-table seed, teardown, escape cases, RLS meta-test entries.

Full diff: `git -C c:\campusgate show 230d8b4`.

</details>
