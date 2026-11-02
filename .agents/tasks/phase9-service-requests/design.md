# CAMPASS Phase 9.6 — Service Requests Management (backend only)

Combined requirements + technical design. The SIXTH module of Phase 9
(Institutional operations). A GATED ("booster") module layered on the shared
foundation (User / Department / Institution), INDEPENDENT of Phase 9.1
(faculty_management), 9.2 (HR), 9.3 (hostel), 9.4 (transport), 9.5 (inventory) —
no coupling in either direction.

- Branch: `main` (NO worktree). HEAD `56e568f` on `origin/main`. No push, no deploy.
- New migration dir: `20270124000000_phase9_service_requests` (the 22nd; the next
  sensible timestamp after `20270117000000_phase9_inventory`). All 21 prior frozen
  dirs stay byte-identical.
- Module registry key AND permission/audit KEY prefix are both `service_requests`
  (the hostel/transport/inventory `registry-key == prefix` precedent).

---

## 1. Summary

Any authenticated institution member (student, faculty, staff) can raise a
service request against one of a tenant's **predefined request types**, fill the
type's **data-driven form** (field definitions → captured values), track it,
comment on it, cancel it while still OPEN, and submit one piece of feedback once
it is resolved. A **SERVICE_AGENT** (new additive template role) or ADMIN handles
every request in the tenant: configure request types + their form fields + SLA,
assign to an agent, drive the **fixed enumerated lifecycle**, run the approval
gate for types that require it, resolve, and read the staff reports (open/overdue
queue, by-type volume, SLA compliance, feedback summary) + an ExcelJS export.

The lifecycle is a **FIXED, enumerated state machine shared by ALL request
types**. This is explicitly **NOT a configurable/generic workflow engine**: there
are no user-defined states, no rules DSL, no per-type control flow. The ONLY
variability is in the DATA — the set of request types and each type's form field
definitions. Per-type metadata (category, default assignee role/department, SLA
target hours, `requiresApproval`) tunes routing/derivation inside the one fixed
control flow; it never alters the control flow.

SLA breach is a **DERIVED** fact (`now > dueAt AND status not terminal`), never a
stored drifting flag. `dueAt` is computed deterministically from the type's SLA
target hours. There are no cost/money fields anywhere in this module, so the
money-as-string discipline does not apply here.

No cross-module coupling: a service request never auto-creates a hostel /
transport / inventory / fees / exam record. A request "about" a hostel room is a
plain typed request with form fields; explicit integrations are deferred.

---

## 2. Functional Requirements

**Request types + forms (staff config, mutable-with-audit)**
- FR-1 A SERVICE_AGENT/ADMIN creates/updates a `ServiceRequestType` (name, unique
  `code` per institution, category, description, optional `defaultAssigneeRole`,
  optional `defaultAssigneeDepartmentId`, `slaTargetHours`, `requiresApproval`,
  `isActive`).
- FR-2 Each type owns an **ordered** set of `ServiceRequestFieldDefinition` rows
  (`fieldKey`, `label`, `dataType` ∈ {TEXT, NUMBER, DATE, SELECT}, `required`,
  `options` for SELECT, `sortOrder`). Field definitions are mutable-with-audit
  while the type has no requests yet; once requests exist the definition set is
  **frozen** (append-new-version is out of scope — see §Out of Scope) to keep
  captured values validatable against a stable schema.
- FR-3 `fieldKey` is unique per type; `options` is required and non-empty for
  SELECT and must be null/absent for non-SELECT.

**Raising + lifecycle**
- FR-4 Any authenticated member raises a `ServiceRequest` against an **active**
  type: `requestTypeId`, `title`, optional `description`, `priority` ∈ {LOW,
  NORMAL, HIGH, URGENT}, and `fieldValues` (a JSON object keyed by `fieldKey`).
- FR-5 Raising **validates** `fieldValues` against the type's field definitions:
  every `required` field present and non-empty; each value coerces to its
  `dataType`; SELECT values are members of `options`; no unknown keys. Failure →
  422 with per-field errors, nothing persisted.
- FR-6 A raised request starts in `OPEN`, `requesterUserId` = token user,
  `assigneeUserId` = null, and `dueAt` = `raisedAt + slaTargetHours` (computed at
  raise time; see FR-13). `dueAt` is **NOT NULL** — it is always computable at
  raise from the type's `slaTargetHours` (NOT NULL, CHECK ≥ 1), so there is never a
  null-`dueAt` request and the overdue predicate needs no null branch (NIT-2).
- FR-7 The request status follows the fixed enumerated lifecycle (§5), enforced by
  a DB column-guard trigger and an in-handler transition map. Terminal states are
  `RESOLVED`→`CLOSED`, `REJECTED`, `CANCELLED`.

**Assignment**
- FR-8 A SERVICE_AGENT/ADMIN assigns a request to an assignee User; `OPEN →
  ASSIGNED`. Reassignment is allowed while the request is non-terminal and not
  `PENDING_APPROVAL`/`CLOSED`. Every assignment is appended to the activity log.
- FR-9 Assignment keeps `dueAt` unless the type's SLA policy re-anchors it (§5,
  FR-13).

**Status / SLA**
- FR-10 A SERVICE_AGENT drives `ASSIGNED → IN_PROGRESS`, and (for a type with
  `requiresApproval`) `IN_PROGRESS → PENDING_APPROVAL`; otherwise `IN_PROGRESS →
  RESOLVED`.
- FR-11 SLA breach is DERIVED (`now > dueAt AND status ∉ {RESOLVED, CLOSED,
  REJECTED, CANCELLED}`). Never stored as a live flag. Because `dueAt` is NOT NULL
  (FR-6), the predicate has no `dueAt IS NULL` branch.
- FR-12 A staff SLA report lists overdue and at-risk (within a configurable
  look-ahead window) non-terminal requests.
- FR-13 `dueAt` is computed once at raise from `slaTargetHours`. It is NOT
  recomputed on later transitions (deterministic, auditable). (Decision rationale
  in §5.)

**Approvals**
- FR-14 For a type with `requiresApproval`, the lifecycle routes through
  `PENDING_APPROVAL`. Only an authorized approver (ADMIN, or SERVICE_AGENT holding
  the approval permission) may `APPROVE` (`PENDING_APPROVAL → RESOLVED`) or
  `REJECT` (`PENDING_APPROVAL → REJECTED`). The decision + actor are appended to
  the activity log.
- FR-15 The approval gate is **pre-resolution** (a distinct state immediately
  before RESOLVED), not a parallel/post gate. Requests for non-approval types skip
  it entirely (`IN_PROGRESS → RESOLVED`).

**Resolution + feedback**
- FR-16 A SERVICE_AGENT resolves (`→ RESOLVED`) with a `resolutionNote`;
  `resolvedAt` is set.
- FR-17 The requester may `CLOSE` their own RESOLVED request (`RESOLVED → CLOSED`,
  `closedAt` set). A SERVICE_AGENT/ADMIN may also close.
- FR-18 The requester may submit **feedback** (rating 1–5 + optional comment) only
  on their OWN request and only once it is `RESOLVED` or `CLOSED`. Feedback is
  **one-per-request** (unique). Feedback is append-only (immutable once given).

**Comments / activity (append-only)**
- FR-19 An append-only `ServiceRequestActivity` log per request records every
  `kind` ∈ {STATUS_CHANGE, COMMENT, ASSIGNMENT, APPROVAL} with `actorUserId`,
  optional `fromStatus`/`toStatus`, `body`, `createdAt`. Immutable (ledger).
- FR-20 The requester may post a COMMENT on their OWN request while non-terminal
  or RESOLVED (not after CLOSED). A SERVICE_AGENT/ADMIN may comment on any request.

**Self-service vs staff separation**
- FR-21 A requester lists/views only THEIR OWN requests (`requesterUserId ==
  token.userId`), their activity, and their feedback. They CANNOT see others'
  requests. Enforced at the service layer by a `requesterUserId` predicate on
  every self route.
- FR-22 A SERVICE_AGENT/ADMIN sees + handles ALL requests in the tenant.

**Reports (staff)**
- FR-23 JSON report endpoints: open/overdue queue, by-type volume, SLA compliance
  (% resolved within SLA), feedback summary (avg rating + count). Plus an ExcelJS
  (`.xlsx`) export of the request register (the `admin.ts` / inventory export
  pattern).

---

## 3. Non-Functional Requirements

- NFR-1 **Multi-tenancy A2**: every new table carries `institutionId` + composite
  same-tenant FKs (incl. `institutionId`); ENABLE + FORCE RLS with nullif-guarded
  fail-closed `USING`/`WITH CHECK` policies. `campass_app` stays NOSUPERUSER
  NOBYPASSRLS — never BYPASSRLS. Append-only tables get `SELECT, INSERT` only (no
  UPDATE/DELETE grant). Every tenant read/write goes through
  `withTenant(institutionId, tx => ...)`; `privilegedPrisma` only for
  cross-tenant/pre-token (none here).
- NFR-2 Lifecycle integrity is enforced in depth: a DB column-guard trigger
  (enumerated legal transitions + frozen identity cols + always-raise on DELETE +
  terminal states have no outgoing edge) backs the in-handler transition map.
  The activity log and feedback are append-only (unconditional-raise trigger on
  UPDATE/DELETE).
- NFR-3 Every mutation and every DENIED lifecycle/authorization decision writes a
  `service_requests.*` AuditEvent via `recordAuditEvent` in the SAME transaction;
  deny branches return the 4xx from a normally-returning `withTenant` callback so
  the audit commits.
- NFR-4 The tenant-escape integration suite is extended to cover EVERY new table.
- NFR-5 The catalogue-sync meta-test stays green: the new migration dir is added
  to `SEEDING_MIGRATION_DIRS`; permission keys + role-permission pairs are
  set-equal between the migration seed and `@campusgate/shared`.

---

## 4. Acceptance Criteria (numbered, testable)

1. `POST /api/service-requests/types` with `requirePermission("service_requests.types.manage")` + `requireModuleActive("service_requests")` creates a type; a duplicate `code` in the same tenant → 409.
2. Creating a type with SELECT field definitions missing/empty `options` → 422; a non-SELECT field with `options` → 422.
3. Field definitions become frozen (update rejected, 409) once the type has ≥1 request. Field definitions are create/update-only — there is no delete route (the inventory/transport config-sub-resource precedent: no module exposes a DELETE on config children), so there is nothing to reject on delete.
4. `POST /api/service-requests` by any authenticated member against an active type with valid `fieldValues` → 201, status `OPEN`, `dueAt = raisedAt + slaTargetHours`, an activity row `kind=STATUS_CHANGE (→OPEN)`.
5. Raising against an inactive type → 409; against a type in another tenant → 404 (RLS/composite-FK).
6. Raising with a missing required field / wrong-typed value / out-of-range SELECT / unknown key → 422, nothing persisted.
7. `POST /:id/assign` by a SERVICE_AGENT drives `OPEN → ASSIGNED`, sets `assigneeUserId`, appends `kind=ASSIGNMENT`. A requester calling it → 403.
8. The DB column-guard trigger rejects an illegal transition (e.g. `OPEN → RESOLVED`) even if the app layer is bypassed; the handler maps it to 409.
9. `PATCH /:id/status` `ASSIGNED → IN_PROGRESS` → 200; for a `requiresApproval` type, `IN_PROGRESS → PENDING_APPROVAL` → 200; for a non-approval type that path is illegal (409) and `IN_PROGRESS → RESOLVED` is legal.
10. `POST /:id/approve` by an approver on a `PENDING_APPROVAL` request → `RESOLVED` + `kind=APPROVAL`; `POST /:id/reject` → `REJECTED`. A non-approver → 403.
11. SLA breach is derived: a request with `dueAt` in the past and non-terminal status appears in `GET /reports/overdue`; once RESOLVED it drops out. No stored breach column exists.
12. `POST /:id/resolve` by a SERVICE_AGENT sets `resolvedAt` + `resolutionNote`, status `RESOLVED`.
13. `POST /me/requests/:id/close` (`request_own`) by the requester on their own RESOLVED request → `CLOSED`, `closedAt` set; on a non-RESOLVED own request → 409; on another user's request → 404 (owner-scoped). Staff close via `POST /:id/close` (`requests.handle`).
14. `POST /me/requests/:id/cancel` (`request_own`) by the requester on their own OPEN request → `CANCELLED`; on their own ASSIGNED/IN_PROGRESS request → 409; on another user's request → 404 (owner-scoped). Staff cancel via `POST /:id/cancel` (`requests.handle`) from OPEN/ASSIGNED/IN_PROGRESS.
15. `POST /me/requests/:id/feedback` (`request_own`) by the requester on their own RESOLVED/CLOSED request with rating 1–5 → 201; a second feedback → 409 (unique); on a non-terminal own request → 409; on another user's request → 404 (owner-scoped).
16. `POST /me/requests/:id/comments` (`request_own`) by the requester on their own (non-CLOSED) request appends `kind=COMMENT` → 201; on their own CLOSED request → 409; on someone else's request → 404 (owner-scoped). Staff comment on any request via `POST /:id/comments` (`requests.handle`).
17. `GET /me/requests` returns ONLY the caller's requests; a request owned by another user is never visible; the activity/feedback sub-reads are owner-scoped.
18. `GET /` (staff) with `service_requests.view` lists ALL tenant requests; a requester-only token → 403.
19. `UPDATE`/`DELETE` on `service_request_activities` and `service_request_feedback` is rejected by the append-only trigger (restrict_violation) even for the table owner; `campass_app` has no UPDATE/DELETE grant on them.
20. The tenant-escape suite proves `campass_app` under tenant A cannot read, forge-insert, or foreign-parent any tenant-B row for all new tables.
21. catalogue-sync: permission keys + `(roleKey, permKey)` pairs are set-equal between `20270124000000_phase9_service_requests` and `@campusgate/shared`; `SEEDING_MIGRATION_DIRS` includes the new dir.
22. `prisma migrate diff --from-schema-datasource` shows only the long-standing composite-vs-single-FK cosmetic diff (NO DROP); `prisma migrate deploy` + `prisma migrate status` report up to date; all 21 prior dirs are byte-unchanged.
23. Every mutation + every DENIED decision writes exactly one `service_requests.*` AuditEvent in the same transaction.
24. `GET /reports/export` streams a valid `.xlsx` of the request register (admin.ts export pattern) gated by `service_requests.view`.

---

## 5. The FIXED enumerated state machine (settled)

**Enum `ServiceRequestStatus`** (8 values):

```
OPEN, ASSIGNED, IN_PROGRESS, PENDING_APPROVAL, RESOLVED, CLOSED, REJECTED, CANCELLED
```

**Legal transitions** (plus the no-op self transition; DELETE always forbidden;
terminal states {CLOSED, REJECTED, CANCELLED} have no outgoing edge):

| From | To | Who | Handler (self surface / staff surface) |
|------|-----|-----|---------|
| OPEN | ASSIGNED | SERVICE_AGENT/ADMIN (`...assign.manage`) | `POST /:id/assign` |
| OPEN | CANCELLED | requester (own, OPEN-only) OR AGENT/ADMIN | requester: `POST /me/requests/:id/cancel` (`request_own`) · staff: `POST /:id/cancel` (`requests.handle`) |
| ASSIGNED | IN_PROGRESS | SERVICE_AGENT/ADMIN (`...handle`) | `PATCH /:id/status` |
| ASSIGNED | ASSIGNED (reassign) | SERVICE_AGENT/ADMIN (`...assign.manage`) | `POST /:id/assign` |
| ASSIGNED | CANCELLED | AGENT/ADMIN only | staff: `POST /:id/cancel` (`requests.handle`) |
| IN_PROGRESS | PENDING_APPROVAL | SERVICE_AGENT/ADMIN (`...handle`), **requiresApproval types only** | `PATCH /:id/status` |
| IN_PROGRESS | RESOLVED | SERVICE_AGENT/ADMIN (`...handle`), **non-approval types only** | `POST /:id/resolve` |
| IN_PROGRESS | CANCELLED | AGENT/ADMIN only | staff: `POST /:id/cancel` (`requests.handle`) |
| PENDING_APPROVAL | RESOLVED | approver (`...approve`) | `POST /:id/approve` |
| PENDING_APPROVAL | REJECTED | approver (`...approve`) | `POST /:id/reject` |
| RESOLVED | CLOSED | requester (own) OR AGENT/ADMIN | requester: `POST /me/requests/:id/close` (`request_own`) · staff: `POST /:id/close` (`requests.handle`) |

**Who-may-perform rationale.** The brief requires: "only the requester can CANCEL
their own open request; only an agent can ASSIGN/RESOLVE; feedback/rating only
after RESOLVED/CLOSED." Settled decisions:

- **CANCEL** — allowed from `OPEN` by the requester (self, via `POST
  /me/requests/:id/cancel` under `request_own`), and from
  `OPEN`/`ASSIGNED`/`IN_PROGRESS` by an AGENT/ADMIN (via `POST /:id/cancel` under
  `requests.handle` — a lifecycle action alongside resolve/close; an agent may
  abandon an in-flight request). The requester's self-cancel is restricted to OPEN
  so they can't yank a request an agent is actively working. This is a product
  decision made explicit; it satisfies "only the requester can cancel their own
  OPEN request" (the requester's cancel is OPEN-only) while still letting staff
  cancel later.
- **ASSIGN / IN_PROGRESS / RESOLVE** — SERVICE_AGENT/ADMIN only.
- **APPROVE / REJECT** — an approver only (ADMIN always; SERVICE_AGENT when it
  holds `service_requests.requests.approve`). Bound to both by default (§7).
- **CLOSE** — the requester closes their own RESOLVED request (the common case:
  "yes, this fixed my problem") via `POST /me/requests/:id/close` under
  `request_own`; staff may also close via `POST /:id/close` under `requests.handle`
  (auto-close is out of scope for this slice; see §Out of Scope — the
  requester-close path is the settled mechanism, matching the brief's "the
  requester can CLOSE").

**`dueAt` policy (settled).** `dueAt = raisedAt + type.slaTargetHours` computed
once at raise, stored, never recomputed on later transitions. Rationale: a
deterministic, raise-anchored due time is auditable and testable; re-anchoring on
assign would let a slow triage hide an SLA breach and would make the derived-breach
report non-deterministic. SLA breach stays fully DERIVED at read time.

**DB enforcement.** The `service_request_status_guard` column-guard trigger
(mirroring `inventory_assets_guard` / the transport maintenance guard) freezes the
identity columns (`institutionId`, `requestTypeId`, `requesterUserId`, `title`,
`priority`, `fieldValues`, `description`, `raisedAt`, `createdAt`), forbids DELETE
unconditionally, and rejects any status pair not in the enumerated legal set
(self-transition allowed as a no-op). The in-handler `STATUS_TRANSITIONS` map
mirrors the same edges (the inventory `MAINTENANCE_TRANSITIONS` precedent) so the
app returns a clean 409 and the DB is the backstop. The **only** mutable columns
are `status`, `assigneeUserId`, `dueAt`, `resolutionNote`, `resolvedAt`,
`closedAt`, `updatedAt`; every other column is frozen after raise.

Frozen-set rationale (review MEDIUM-1/MEDIUM-2): `raisedAt` is frozen because the
derived-SLA correctness depends on it being immutable (`dueAt = raisedAt +
slaTargetHours`; breach is `now > dueAt`). `description` is frozen because the
request's raise-time answers are immutable by design (Assumption 4 — corrections
flow through comments or a new request, not by editing the original request body);
no route writes `description` after raise. This frozen list is **identical** to the
§8.5 trigger spec.

---

## 6. Form-field-definition + value-validation + storage model (settled)

**Definitions.** `ServiceRequestFieldDefinition` rows belong to a
`ServiceRequestType` (composite same-tenant FK). Columns: `fieldKey`, `label`,
`dataType` (enum `ServiceRequestFieldType` = TEXT | NUMBER | DATE | SELECT),
`required` (bool), `options` (`String[]` — Postgres text array; null/empty for
non-SELECT, non-empty for SELECT, enforced by a CHECK), `sortOrder` (int).
`(serviceRequestTypeId, fieldKey)` unique per tenant.

**Value storage (settled).** The captured values live on the `ServiceRequest` row
in a single `fieldValues Json` column (Postgres `jsonb`), a flat object keyed by
`fieldKey`. Decision — two options were viable:
- (a) a child `service_request_field_values` table (one row per field), or
- (b) a single `jsonb` column on the request.

**Chosen: (b) `jsonb` on the request.** Rationale: the field schema is owned and
validated by the request's type at raise time (the definitions are the
authoritative schema), values are always read/written as a whole alongside the
request, there is no need to query/aggregate on an individual field value in this
slice, and a frozen-definitions rule (FR-2) keeps the stored blob validatable. A
child table would add a table, FKs, RLS, and append-only concerns for no query
benefit. `fieldValues` is a **frozen identity column** on the request (captured
once at raise; the column guard rejects later edits) — the request's answers are
immutable; corrections happen via comments or a new request.

**Validation (settled, at raise time, in-handler, before insert).** Load the
type's active field definitions; then for the submitted `fieldValues`:
- required present + non-empty (else 422 `{field: "required"}`);
- TEXT → string; NUMBER → finite number (coerced from numeric string); DATE →
  ISO-8601 date parse; SELECT → string ∈ `options` (else 422
  `{field: "invalid_option"}`);
- reject unknown keys not in the definition set (422 `{field: "unknown"}`).
Validation is a pure function (`validateFieldValues(defs, values)`) → unit
testable in isolation. The Zod body schema validates the envelope
(`title`/`priority`/`fieldValues` is an object); the per-field typing against the
dynamic definitions is the handler step.

---

## 7. RBAC — the additive SERVICE_AGENT role + the requester self-service split

**New additive template role `SERVICE_AGENT`** (institutionId NULL) — the
ACCOUNTANT / LIBRARIAN / WARDEN / HR_MANAGER / TRANSPORT_MANAGER /
INVENTORY_MANAGER precedent. It runs service requests end to end within a tenant
(configure types/fields/SLA, assign, handle, approve/reject, resolve, read +
export) WITHOUT inheriting institution-wide admin rights. We do NOT extend the
legacy role enum.

**Who raises vs who handles (settled, with rationale).** Raising/viewing-own is
bound to a dedicated self key `service_requests.request_own`. For THIS slice it is
seeded to exactly one role — **STUDENT** (see Assumption 1 for how additional
member roles are added later without a schema change). Rationale: the brief wants a
broad self-service surface ("any authenticated institution member"); STUDENT is the
institution's broad member role, so seeding `request_own` to STUDENT delivers the
self-service surface while keeping the seed set-equal with `ROLE_PERMISSIONS` (which
carries STUDENT only). Two approaches were viable:
- (a) bind `request_own` to a broad role set and gate the self routes on the
  permission (the exams `reeval.request_own` / fees `view_own` precedent), or
- (b) make self routes available to any authenticated member with no permission
  key, scoping purely by `requesterUserId == token.userId`.

**Chosen: (a).** A permission key keeps the self-service surface auditable and
consistent with every other module's `*.view_own`/`*.request_own` pattern, and the
catalogue-sync meta-test already asserts permission/role-pair set-equality. STUDENT
(and only STUDENT, this slice) carries `service_requests.request_own`; the
route additionally hard-scopes by `requesterUserId == token.userId`, so even a
staff user who happened to hold the self key only ever sees their own requests on
the self routes. Seed exactly one `request_own` pair
(`STUDENT :: service_requests.request_own`) — do NOT seed extra non-staff roles,
or catalogue-sync set-equality (which sees STUDENT only in `ROLE_PERMISSIONS`)
would fail. Handling keys are NEVER granted to STUDENT. SERVICE_AGENT/ADMIN
do NOT hold the self key (the established "ADMIN holds no module-gated self key"
precedent); an agent reads their own requests through the staff `view` surface
filtered by requester rather than through the `/me` self surface.

### 7.1 Permission catalogue (`service_requests.*`, 6 keys)

| key | description | grants to |
|-----|-------------|-----------|
| `service_requests.types.manage` | Create/update request types + field definitions + SLA config (staff) | ADMIN, SERVICE_AGENT |
| `service_requests.assign.manage` | Assign/reassign a request to an agent (staff) | ADMIN, SERVICE_AGENT |
| `service_requests.requests.handle` | Drive lifecycle (ASSIGNED→IN_PROGRESS→PENDING_APPROVAL/RESOLVED), resolve, comment, close-any (staff) | ADMIN, SERVICE_AGENT |
| `service_requests.requests.approve` | Approve/reject a PENDING_APPROVAL request (staff) | ADMIN, SERVICE_AGENT |
| `service_requests.view` | Staff read of all requests/types/activity/feedback + reports/export | ADMIN, SERVICE_AGENT |
| `service_requests.request_own` | Self-service: raise, list/view OWN, comment OWN, cancel OWN OPEN, submit feedback OWN | STUDENT |

`ROLE_PERMISSIONS` lockstep: ADMIN gets the 5 staff keys (NOT `request_own`);
SERVICE_AGENT gets the same 5 staff keys (NOT `request_own`); STUDENT gains
`request_own` (added to the existing STUDENT list). Separation of duties: STUDENT
never gets a staff key; no staff role gets the self key.

### 7.2 permission × route × role × audit matrix

| Method & path | permission | module gate | roles | audit key(s) |
|---|---|---|---|---|
| POST `/types` | `types.manage` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.type.created` |
| PATCH `/types/:id` | `types.manage` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.type.updated` |
| GET `/types` | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| POST `/types/:id/fields` | `types.manage` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.field.created` |
| PATCH `/types/:id/fields/:fid` | `types.manage` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.field.updated` (DENIED if frozen) |
| GET `/types/:id/fields` | `view` OR `request_own` (inline guard — see note) | ✓ | staff + requester (to render the form) | — (read) |
| POST `/` (raise) | `request_own` | ✓ | STUDENT | `service_requests.request.raised` |
| GET `/me/requests` | `request_own` | ✓ | self | — (read, owner-scoped) |
| GET `/me/requests/:id` | `request_own` | ✓ | self | — (read, owner-scoped) |
| POST `/me/requests/:id/comments` | `request_own` | ✓ | self (own, non-CLOSED) | `service_requests.comment.added` (DENIED if not own/CLOSED) |
| POST `/me/requests/:id/cancel` | `request_own` | ✓ | self (own, OPEN) | `service_requests.request.cancelled` (DENIED if not OPEN/own) |
| POST `/me/requests/:id/close` | `request_own` | ✓ | self (own, RESOLVED) | `service_requests.request.closed` (DENIED if not RESOLVED/own) |
| POST `/me/requests/:id/feedback` | `request_own` | ✓ | self (own, RESOLVED/CLOSED) | `service_requests.feedback.submitted` (DENIED if not terminal/own/dup) |
| GET `/` (staff list) | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| GET `/:id` (staff detail) | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| POST `/:id/assign` | `assign.manage` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.assigned` (DENIED on illegal transition) |
| PATCH `/:id/status` | `requests.handle` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.transitioned` (DENIED on illegal/approval-mismatch) |
| POST `/:id/resolve` | `requests.handle` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.resolved` |
| POST `/:id/approve` | `requests.approve` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.approved` (DENIED if not PENDING_APPROVAL) |
| POST `/:id/reject` | `requests.approve` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.rejected` |
| POST `/:id/close` (staff) | `requests.handle` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.closed` |
| POST `/:id/cancel` (staff) | `requests.handle` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.request.cancelled` (DENIED on illegal transition) |
| POST `/:id/comments` (staff) | `requests.handle` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.comment.added` |
| GET `/reports/overdue` | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| GET `/reports/volume` | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| GET `/reports/sla` | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| GET `/reports/feedback` | `view` | ✓ | ADMIN, SERVICE_AGENT | — (read) |
| GET `/reports/export` | `view` | ✓ | ADMIN, SERVICE_AGENT | `service_requests.register.exported` |

Every route carries `requireModuleActive("service_requests")` + its
`requirePermission(...)`, mirroring inventory/transport wiring via
`apps/api/src/services/authz-engine.ts`.

**Two-surface split (authoritative).** This matrix is the single source of truth
for routes and permissions. Requester self actions live under the **`/me/requests/...`
surface** gated by `request_own` and hard-scoped by `requesterUserId ==
token.userId`; staff actions live under the **bare `/:id/...` surface** gated by a
staff key (`view`/`assign.manage`/`requests.handle`/`requests.approve`). The two
surfaces never overlap: a requester holding only `request_own` can never reach a
bare `/:id/...` staff route (403 at `requirePermission`), and staff reach their own
requests through the staff `GET /` surface filtered by requester rather than through
`/me`. Cancel, close, comment, and feedback therefore each exist as a *pair* — a
self route under `/me/requests/:id/...` and (where the brief allows staff to act) a
staff route under `/:id/...` — rather than one shared ownership-branching route. The
§5 Handler column names both members of each pair.

**NIT-3 — `GET /types/:id/fields` dual gate.** `requirePermission(key)` in
`authz-engine.ts` takes exactly one key and 403s otherwise; there is no
`requireAnyPermission` primitive and no other route needs one. This single route
therefore uses a **custom inline guard** in its handler —
`if (!can(request.auth, "service_requests.view") && !can(request.auth,
"service_requests.request_own")) return reply.status(403)...` — using the exported
`can(auth, key)` helper, rather than a single-key `requirePermission` preHandler. It
still carries `requireModuleActive("service_requests")` as a preHandler. It is the
ONLY route in this module with a two-key gate; every other route uses the
single-key `requirePermission`. (NIT-5) Unlike the `/me/requests/...` self routes,
this read is **tenant-scoped by RLS only** — it carries **no `requesterUserId`
ownership predicate**, because it exposes a request *type*'s public field schema,
not any request. There is no owner to scope to; a coder must not try to owner-scope
it. A requester may read an active type's field definitions to render the raise
form, and RLS confines the read to the caller's tenant.

### 7.3 Audit keys (`service_requests.*`, added to `AUDIT_ACTIONS` in `@campusgate/shared/audit-actions.ts`)

`type.created`, `type.updated`, `field.created`, `field.updated`,
`request.raised`, `request.assigned`, `request.transitioned`, `request.resolved`,
`request.approved`, `request.rejected`, `request.closed`, `request.cancelled`,
`comment.added`, `feedback.submitted`, `register.exported` (15 keys). These are
string-literal catalogue entries validated by `recordAuditEvent` at runtime; they
do NOT require a Prisma `AuditAction` enum change (the inventory/transport
precedent — new audit keys have no migration mirror and no enum extension). DENIED
decisions reuse the corresponding mutation key with `result: "DENIED"`.

---

## 8. New tables (5) — each tenant-owned, composite FKs, RLS, grants

Enums (migration step a): `ServiceRequestFieldType` (TEXT, NUMBER, DATE, SELECT),
`ServiceRequestPriority` (LOW, NORMAL, HIGH, URGENT), `ServiceRequestStatus`
(OPEN, ASSIGNED, IN_PROGRESS, PENDING_APPROVAL, RESOLVED, CLOSED, REJECTED,
CANCELLED), `ServiceRequestActivityKind` (STATUS_CHANGE, COMMENT, ASSIGNMENT,
APPROVAL).

**Mutable / guarded (updatedAt NOT NULL):**

1. `service_request_types` — mutable-with-audit, NO trigger. Cols: id,
   institutionId, name, code, category, description?, defaultAssigneeRole?,
   defaultAssigneeDepartmentId?, slaTargetHours (int ≥ 1), requiresApproval
   (bool), isActive (bool, default true), createdByUserId, createdAt, updatedAt.
   Business unique `(institutionId, code)`.
2. `service_request_field_definitions` — mutable-with-audit, NO trigger (handler
   enforces the frozen-once-requests-exist rule; §9 edge cases). Cols: id,
   institutionId, serviceRequestTypeId, fieldKey, label, dataType, required,
   options (text[]), sortOrder, createdByUserId, createdAt, updatedAt. Unique
   `(institutionId, serviceRequestTypeId, fieldKey)`.
3. `service_requests` — enumerated-transition terminal-enforcing column guard
   (`service_request_status_guard`). Cols: id, institutionId, requestTypeId,
   requesterUserId, title, description? (**frozen at raise** — see §5/§8.5),
   priority, fieldValues (jsonb), status (default OPEN), assigneeUserId?, dueAt
   (**NOT NULL** — always computed at raise from `slaTargetHours`; see NIT-2
   resolution below), resolutionNote?, raisedAt, resolvedAt?, closedAt?, createdAt,
   updatedAt.

**Append-only (createdAt-only, NO updatedAt):**

4. `service_request_activities` — append-only ledger. Cols: id, institutionId,
   serviceRequestId, kind, actorUserId, fromStatus?, toStatus?, body?, createdAt.
5. `service_request_feedback` — append-only, one-per-request. Cols: id,
   institutionId, serviceRequestId, requesterUserId, rating (int 1–5), comment?,
   createdAt. Unique `(institutionId, serviceRequestId)`.

(Two parents — `service_request_types` + `service_request_field_definitions` —
plus one `service_requests` + two append-only ledgers
(`service_request_activities` + `service_request_feedback`) = the authoritative
**5 new tables**.)

### 8.1 Composite same-tenant FKs (all ON DELETE RESTRICT ON UPDATE CASCADE)

- `service_request_field_definitions (institutionId, serviceRequestTypeId) →
  service_request_types (institutionId, id)`.
- `service_requests (institutionId, requestTypeId) → service_request_types
  (institutionId, id)`.
- `service_requests (institutionId, requesterUserId) → users (institutionId, id)`.
- `service_requests (institutionId, assigneeUserId) → users (institutionId, id)`
  **MATCH SIMPLE** (nullable assignee is a no-op — the inventory custody-user
  precedent).
- `service_request_types (institutionId, defaultAssigneeDepartmentId) →
  departments (institutionId, id)` **MATCH SIMPLE** (nullable).
- `service_request_activities (institutionId, serviceRequestId) → service_requests
  (institutionId, id)`.
- `service_request_feedback (institutionId, serviceRequestId) → service_requests
  (institutionId, id)`; `service_request_feedback (institutionId,
  requesterUserId) → users (institutionId, id)`.
- Every table: tenant-root `institutionId → institutions(id)` RESTRICT.
- Actor/provenance ids (`createdByUserId`, `actorUserId`) are recorded ids with NO
  FK (the transport/hostel/inventory precedent). `requesterUserId` and
  `assigneeUserId` DO carry composite FKs (they are authoritative identity refs,
  mirroring how a requester/assignee is a User per the brief).

### 8.2 CHECKs

- `service_request_types`: name/code non-empty; `slaTargetHours >= 1`.
- `service_request_field_definitions`: fieldKey/label non-empty; `sortOrder >= 0`;
  `(dataType = 'SELECT' AND array_length(options,1) >= 1) OR (dataType <> 'SELECT'
  AND (options IS NULL OR array_length(options,1) IS NULL))`.
- `service_requests`: title non-empty.
- `service_request_feedback`: `rating BETWEEN 1 AND 5`.

### 8.3 Indexes

`(id, institutionId)` unique on all five (anchors composite FKs); `(institutionId)`
on all five; plus query indexes: `service_requests (institutionId, status)`,
`(institutionId, requesterUserId)`, `(institutionId, assigneeUserId)`,
`(institutionId, requestTypeId)`, `(institutionId, dueAt)` (overdue report);
`service_request_field_definitions (institutionId, serviceRequestTypeId)`;
`service_request_activities (institutionId, serviceRequestId)`;
`service_request_feedback` unique `(institutionId, serviceRequestId)`.

### 8.4 RLS + grants

- The three mutable/guarded tables: ENABLE + FORCE RLS; standard fail-closed pair
  `{tenant_isolation_select, tenant_isolation_modify}` with
  `nullif(current_setting('app.current_institution_id', true), '')`. Grant
  `SELECT, INSERT, UPDATE` to `campass_app`.
- The two append-only tables: ENABLE + FORCE RLS; append-only pair
  `{tenant_isolation_select, <table>_tenant_insert}` (NO modify policy). Grant
  `SELECT, INSERT` + explicit `REVOKE UPDATE, DELETE` from `campass_app` (the
  fees-slice2 / inventory ledger precedent).

### 8.5 Triggers

- `service_request_status_guard` (BEFORE UPDATE OR DELETE on `service_requests`):
  DELETE → raise; freeze `institutionId, requestTypeId, requesterUserId, title,
  priority, fieldValues, description, raisedAt, createdAt` via `IS DISTINCT FROM`
  (this list is byte-identical to the §5 "DB enforcement" frozen set); enforce the
  §5 enumerated transition set (+ self no-op). Terminal states {CLOSED, REJECTED,
  CANCELLED} appear only as targets, never as legal sources.
- `service_request_activities_append_only` + `service_request_feedback_append_only`
  (BEFORE UPDATE OR DELETE, unconditional raise `restrict_violation`) — the
  inventory ledger idiom.

---

## 9. Error handling + edge cases (concrete, per operation)

- **Raise against inactive/foreign/missing type** → in-handler lookup
  `findFirst({ id, institutionId, isActive: true })`; missing → 404; present but
  inactive → 409 + DENIED audit. Recoverable (caller fixes input).
- **Field validation failure** → 422 with `{ errors: { <fieldKey>: <reason> } }`,
  nothing persisted (validation runs before insert). Recoverable. Not audited as a
  mutation (no row). Logged only at the standard request log level.
- **Illegal status transition** → the in-handler `STATUS_TRANSITIONS` map returns
  409 + DENIED audit; if the app guard were bypassed, the DB column guard raises
  `restrict_violation`, caught via `isRestrictViolation(err)` → 409 (the inventory
  precedent). Fatal to the request, recoverable by the caller.
- **Approval-type mismatch** — `IN_PROGRESS → PENDING_APPROVAL` on a non-approval
  type, or `IN_PROGRESS → RESOLVED` attempted on a `requiresApproval` type via the
  wrong endpoint → 409 + DENIED audit (the handler checks
  `type.requiresApproval`).
- **Cancel by non-owner / not-OPEN** → owner predicate + status check; non-owner →
  404 (the request is invisible to them, RLS + requesterUserId scope); owner on
  non-OPEN → 409 + DENIED.
- **Feedback dup / wrong-state / non-owner** → unique `(institutionId,
  serviceRequestId)` backstops a concurrent double submit (P2002 → 409); state
  check (`RESOLVED`/`CLOSED`) → 409; non-owner → 404. The insert + audit are one
  tx.
- **Field-definition edit after requests exist** → handler counts
  `serviceRequest` rows for the type; if ≥1, reject the field create/update
  with 409 + DENIED audit (frozen-schema invariant, §6). (Field definitions are
  create/update-only — there is no delete operation or route; the §7.2 matrix
  exposes only `POST /types/:id/fields` and `PATCH /types/:id/fields/:fid`, and
  §7.3 has no `field.deleted` key.) Recoverable only by the type owner creating a
  new type.
- **Assign to a user in another tenant** → composite FK `(institutionId,
  assigneeUserId) → users` rejects (FK violation surfaced as 409/400); a prior
  in-handler lookup gives a clean 404 "assignee not found".
- **Concurrent transition race** → the DB column guard + `updatedAt` optimistic
  read make a double transition idempotent on the no-op self edge or rejected on
  an illegal one; no advisory lock needed (no capacity/counter here, unlike
  inventory stock).

**Invariant ownership.** Lifecycle legality: owned by the DB column guard
(authoritative) + mirrored in the handler (fast clean 409). Append-only
immutability of activity/feedback: owned by the DB trigger + the revoked grant.
Tenant isolation: owned by RLS + composite FKs. Field-schema freeze + value
validation: owned by the handler (the only layer that knows the dynamic
definitions) backed by the CHECK on option shape. One-per-request feedback: owned
by the unique index + the handler.

---

## 10. Validation inputs (per external input)

- `createTypeSchema`: name (1–200), code (1–64, `[A-Z0-9_]`), category (1–64),
  description? (≤2000), defaultAssigneeRole? (enum of known role keys or free
  string ≤64), defaultAssigneeDepartmentId? (cuid), slaTargetHours (int 1–8760),
  requiresApproval (bool), isActive? (bool).
- `createFieldSchema`: fieldKey (1–64, `[a-zA-Z0-9_]`), label (1–200), dataType
  (enum), required (bool), options? (string[], each 1–200, ≤50 entries),
  sortOrder (int ≥ 0). Refinement: SELECT ⇒ options non-empty; non-SELECT ⇒
  options absent.
- `raiseRequestSchema`: requestTypeId (cuid), title (1–200), description? (≤4000),
  priority (enum, default NORMAL), fieldValues (record of string→unknown; the
  dynamic per-field typing is the handler step §6).
- `assignSchema`: assigneeUserId (cuid).
- `statusPatchSchema`: toStatus (enum subset {IN_PROGRESS, PENDING_APPROVAL}).
- `resolveSchema`: resolutionNote (1–4000).
- `rejectSchema`: reason? (≤2000).
- `commentSchema`: body (1–4000).
- `feedbackSchema`: rating (int 1–5), comment? (≤2000).
- `listQuerySchema`: page (≥1), pageSize (1–100), status?, requestTypeId?,
  assigneeUserId?, overdue? (bool), atRiskHours? (int) for the SLA look-ahead.
All limits/types are enforced by Zod `safeParse` → 400 on envelope failure, 422 on
dynamic field-value failure.

---

## 11. Technology stack (locked once approved)

TypeScript on Node; Fastify routes (`apps/api/src/routes/service-requests.ts`,
registered at `/api/service-requests` in `server.ts`); Prisma Client via
`@campusgate/db` `withTenant`; PostgreSQL (shared Supabase) with hand-authored RLS
+ triggers; Zod validation via `@campusgate/shared` schemas; `exceljs` for the
`.xlsx` export (the admin.ts/inventory precedent); Vitest for unit + integration
tests. No new runtime dependency is introduced.

---

## 12. Files to create / modify

**Create**
- `packages/db/prisma/migrations/20270124000000_phase9_service_requests/migration.sql`
  (hand-authored, lettered a–j house style — see §13).
- `apps/api/src/routes/service-requests.ts` (route module, transport.ts/inventory.ts idioms).
- `apps/api/src/routes/__tests__/service-requests.*.test.ts` (behavioral + validation unit tests).

**Modify**
- `packages/db/prisma/schema.prisma` — add the 5 models + 4 enums + the
  `User`/`Department`/`Institution` back-relations (the inventory model-block
  precedent; raw SQL for RLS/FKs/CHECKs/triggers lives only in the migration).
- `packages/shared/src/modules.ts` — add `{ key: "service_requests", ... }` to
  `MODULES` and `service_requests: []` to `MODULE_DEPENDENCIES`
  (foundational-not-gated; rationale §14).
- `packages/shared/src/permissions.ts` — add the 6 `service_requests.*`
  `PERMISSIONS` entries; add `SERVICE_AGENT` to `ROLE_PERMISSIONS` (5 staff keys);
  add the 5 ADMIN staff keys; add `service_requests.request_own` to STUDENT.
- `packages/shared/src/audit-actions.ts` — add the 15 `service_requests.*`
  `AUDIT_ACTIONS` entries.
- `packages/shared/src/schemas` (or the existing shared schema barrel) — add the
  Zod schemas (§10), exported from `@campusgate/shared`.
- `apps/api/src/server.ts` — `import { serviceRequestsRoutes }` + `app.register(...,
  { prefix: "/api/service-requests" })`.
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — add
  `20270124000000_phase9_service_requests` to `SEEDING_MIGRATION_DIRS`.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` +
  `tenant-escape.integration.test.ts` — seed + assert escape for all 5 new tables
  (the 3 mutable in child-safe order type→field→request; the 2 append-only
  ledgers seeded via adminClient with the scoped trigger-disable teardown dance,
  the inventory ledger precedent).

---

## 13. Migration layout (frozen lettered a–j house style)

Dir `20270124000000_phase9_service_requests/migration.sql`, strictly additive,
mirroring `20270117000000_phase9_inventory`:

- **a.** `CREATE TYPE` the 4 enums.
- **b.** `CREATE TABLE` the 5 tables + PKs (3 mutable carry `updatedAt NOT NULL`;
  2 append-only are createdAt-only).
- **c.** `(id, institutionId)` uniques + `(institutionId)` + query indexes +
  business uniques (`types code`, `field (type,fieldKey)`, `feedback
  (serviceRequestId)`).
- **d.** tenant-root `institutionId → institutions(id)` RESTRICT on all 5.
- **e.** composite same-tenant FKs (§8.1); MATCH SIMPLE for nullable
  assignee/department.
- **f.** CHECKs (§8.2).
- **g.** ENABLE + FORCE RLS — standard pair on the 3 mutable; append-only pair on
  the 2 ledgers.
- **h.** triggers — the `service_request_status_guard` column guard + the two
  append-only functions/triggers (§8.5).
- **i.** guarded + idempotent `campass_app` GRANT refresh (`SELECT, INSERT,
  UPDATE` on the 3; `SELECT, INSERT` + `REVOKE UPDATE, DELETE` on the 2).
  NOSUPERUSER NOBYPASSRLS — never BYPASSRLS.
- **j.** catalogue seed: the `SERVICE_AGENT` role row (`institutionId = NULL`,
  BEFORE the permissions block), then the 6 `service_requests.*` permissions
  (`ON CONFLICT (key) DO NOTHING`), then the `role_permissions`
  `... FROM (VALUES ...) AS m(roleKey, permKey) JOIN roles r ON r.key =
  m.roleKey AND r.institutionId IS NULL JOIN permissions p ...` block (ADMIN ×5,
  SERVICE_AGENT ×5, STUDENT ×1 = 11 pairs).

**Workflow (shared Supabase):** NEVER `prisma migrate dev`. Hand-author the dir,
then `prisma migrate diff --from-schema-datasource` (only the long-standing
composite-vs-single-FK cosmetic diff expected — NO DROP), `prisma migrate deploy`,
`prisma migrate status` up to date. All 21 prior frozen dirs stay byte-untouched.

---

## 14. Module registry wiring + the no-generic-engine constraint

`MODULE_DEPENDENCIES.service_requests = []` — **foundational-not-gated**, the
established Phase-9 precedent (attendance/fees/admissions/faculty/hr/hostel/
transport/inventory). Only its own `InstitutionModule` row must be
ENTITLED→ACTIVE. Its real prerequisites (foundational User/Department data) have NO
ACTIVE `InstitutionModule` row, so a gated edge would PERMANENTLY block activation;
those prerequisites are validated at operation time via composite FKs + in-handler
lookups. Every operational route carries `requireModuleActive("service_requests")`
in addition to its permission (the inventory/transport wiring via
`authz-engine.ts` + the module engine).

**No generic engine (hard constraint).** The control flow is the single fixed §5
state machine compiled into the DB column guard + the in-handler transition map.
There is no table of user-defined states, no transition-rule table, no DSL. The
`requiresApproval` boolean only chooses whether the fixed `PENDING_APPROVAL` node
is traversed; it does not define new flow. All per-tenant variability is DATA:
`service_request_types` + `service_request_field_definitions`.

**No cross-module coupling (hard constraint).** This module imports no
hostel/transport/inventory/fees/exam model and writes none. A request referencing
another domain is a plain typed request with form fields. Deferred integrations are
out of scope.

---

## 15. Testability

- **Unit (no DB):** `validateFieldValues(defs, values)` (required/type/SELECT/
  unknown-key matrix); the `STATUS_TRANSITIONS` map legality; the derived-breach
  predicate; the Zod schemas (envelope accept/reject); `dueAt` computation.
- **Integration (live Supabase, campass_app):** full lifecycle happy paths +
  every DENIED branch (ACs §4); the DB column-guard rejection of an illegal
  transition and of DELETE; the append-only trigger rejection on activity/feedback
  UPDATE/DELETE; the one-per-request feedback unique; the frozen-field-definition
  rule; owner-scoping of the self routes.
- **Meta:** catalogue-sync set-equality; the tenant-escape suite for all 5 tables.
The design is testable because the lifecycle, validation, and breach logic are
pure functions over inputs, and the DB guards are independently assertable.

---

## 16. Out of Scope

- A configurable/generic workflow engine, user-defined states, or a rules DSL.
- Cross-module auto-creation or linking (hostel/transport/inventory/fees/exam).
- Auto-close of RESOLVED requests on a timer / scheduled job (the requester-close
  + staff-close paths are the settled mechanism this slice).
- Versioned/append-new form-field definitions after requests exist (definitions
  freeze instead).
- Notifications/email, SLA escalation automation, attachment uploads on requests,
  and any frontend.
- Money/cost fields (none exist in this module).

---

## Assumptions

1. "Any authenticated institution member" is operationalized as the broad
   self-service role STUDENT holding `service_requests.request_own` for this
   slice; additional member roles can be added to the seed later without schema
   change (set-equality test will track it).
2. SLA look-ahead ("at-risk") window default is a query param (`atRiskHours`,
   default 24) rather than stored config, to avoid a config table this slice.
3. `defaultAssigneeRole` is advisory metadata for routing hints; it does not
   auto-assign (assignment is an explicit agent action), avoiding a role→user
   resolution engine.
4. `fieldValues` is frozen at raise; corrections are made via comments or a new
   request — matching the brief's "captured form-field values ... validated at
   raise time." `description` is frozen for the same reason (review MEDIUM-2).

---

## Review responses (revision 1)

Reviewed doc: `.agents/tasks/phase9-service-requests/design.md`. Verdict was
CHANGES_REQUESTED (2 HIGH, 2 MEDIUM, 3 NIT). All seven findings are internal
contradictions within the design (the reviewer verified every surrounding
codebase fact as consistent); each is ADDRESSED below. The single external fact
re-checked during this revision — that `authz-engine.ts` exports `can(auth, key)`
and `requirePermission` takes exactly one key with no OR primitive — was confirmed
against the real file, which is what NIT-3's inline-guard fix relies on.

- **HIGH-1 (requester-close had no route/permission) — ADDRESSED.** Added
  `POST /me/requests/:id/close` under `request_own` (self, own, RESOLVED; audit
  `request.closed`, DENIED if not RESOLVED/own) to the §7.2 matrix, kept the staff
  `POST /:id/close` under `requests.handle`, and updated the §5 `RESOLVED → CLOSED`
  Handler column + AC-13 to name both routes. The requester-close path (AC-13) now
  resolves against a route a STUDENT can actually reach.
- **HIGH-2 (self vs staff route-path contradiction) — ADDRESSED.** §7.2 is now the
  explicit single source of truth, documented via a new "Two-surface split"
  paragraph: requester self actions live under `/me/requests/:id/...` (`request_own`,
  owner-scoped), staff actions under bare `/:id/...` (staff key). Rewrote the §5
  Handler column (cancel/close now name both the self and staff route of each pair)
  and AC-14/15/16 to the `/me/requests/:id/cancel|feedback|comments` self paths with
  owner-scoped 404 (not 403) for a foreign request, plus the staff
  `/:id/cancel|comments` counterparts.
- **MEDIUM-1 (raisedAt freeze disagreement) — ADDRESSED.** `raisedAt` is now frozen
  in BOTH §5 and §8.5; the two frozen-column lists are stated to be byte-identical:
  `institutionId, requestTypeId, requesterUserId, title, priority, fieldValues,
  description, raisedAt, createdAt`.
- **MEDIUM-2 (`description` unclassified) — ADDRESSED.** `description` is classified
  **frozen** (added to the identity set in §5 + §8.5 + flagged in the §8 table-3
  column), consistent with Assumption 4 (raise-time answers immutable; corrections
  via comments/new request). No route writes `description` after raise.
- **NIT-1 (staff-cancel permission undefined) — ADDRESSED.** Added the staff
  `POST /:id/cancel` row to §7.2 under `requests.handle` (a lifecycle action
  alongside resolve/close), audit key `service_requests.request.cancelled`; the §5
  staff-cancel edges now name it.
- **NIT-2 (`dueAt` nullable vs always-set) — ADDRESSED.** `dueAt` is now **NOT
  NULL** (always computable at raise from `slaTargetHours ≥ 1`); FR-6/FR-11 and the
  §8 table-3 column updated; the derived-breach predicate has no null branch.
- **NIT-3 (dual-permission gate mechanism) — ADDRESSED.** Added a note that
  `GET /types/:id/fields` uses a custom inline guard
  (`can(auth, "service_requests.view") || can(auth, "service_requests.request_own")`)
  via the exported `can` helper rather than the single-key `requirePermission`
  preHandler, and that it is the only two-key route in the module (no nonexistent
  `requireAnyPermission`).

No finding was backlogged or declined; all align with the original requirements
(the brief's "any member raises + tracks their own; only SERVICE_AGENT/ADMIN
handle/assign/resolve" self-vs-staff separation, and the derived-SLA + append-only
constraints).

## Review responses (revision 2)

Reviewed doc: `.agents/tasks/phase9-service-requests/design.md`. Verdict was
CHANGES_REQUESTED (1 MEDIUM, 2 NIT). All three findings are internal consistency
issues; each is ADDRESSED below. The one external fact re-checked this revision —
whether any existing Phase-9 module exposes a DELETE on a config sub-resource —
was confirmed against the real `apps/api/src/routes/inventory.ts` (grep for
DELETE/`.delete(`: no matches), which grounds the MEDIUM-3 "no delete" choice in
the established house pattern.

- **MEDIUM-3 (field DELETE referenced by AC-3/§9 but absent from the §7.2 matrix)
  — ADDRESSED via option (a), no delete.** Field definitions are create/update-only
  (the inventory/transport config-sub-resource precedent: no module exposes a
  DELETE on config children). AC-3 now reads "update rejected, 409" and explicitly
  states there is no delete route; §9's "Field-definition edit after requests
  exist" now says "field create/update" (dropped "delete") and notes the §7.2
  matrix exposes only `POST /types/:id/fields` + `PATCH /types/:id/fields/:fid`
  and that §7.3 has no `field.deleted` key. No route, permission, or audit key was
  added; the audit catalogue stays at 15 keys and the matrix is unchanged on this
  axis — so AC-3/§9 no longer assert an operation the matrix cannot serve.
- **NIT-4 ("(+ broad self)" phrasing conflicts with the STUDENT-only seed) —
  ADDRESSED.** Dropped "(+ broad self)" from the §7.2 `POST /` (raise) row (now
  "STUDENT"); the §7.1 grants cell was already "STUDENT". Rewrote the §7 "Who
  raises vs who handles" + "Chosen: (a)" prose to state STUDENT is the sole seeded
  binding this slice and to instruct seeding exactly one pair
  (`STUDENT :: service_requests.request_own`), with an explicit warning that extra
  non-staff pairs would break catalogue-sync set-equality; future expansion is
  deferred to Assumption 1.
- **NIT-5 (`GET /types/:id/fields` self access lacks a tenant-scoped-only note) —
  ADDRESSED.** Appended a clause to the NIT-3 note: this read is tenant-scoped by
  RLS only, carries no `requesterUserId` ownership predicate (it exposes a type's
  public field schema, not any request, so there is no owner to scope to), and a
  requester may read an active type's field definitions to render the raise form.

No finding was backlogged or declined; all three align with the original
requirements (fixed-lifecycle self-service module, catalogue-sync set-equality, and
the data-driven-forms-not-generic-engine constraint).
