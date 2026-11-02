# Design Review — CAMPASS Phase 9.6 Service Requests Management (backend only)

Reviewed document: `.agents/tasks/phase9-service-requests/design.md`
Review type: **revision 2** (two prior reviews named in the design's "Review
responses" sections). Per the revision protocol I first re-checked every prior
finding against the current design, marking each Closed or Unchanged, then
reviewed what changed and the design as a whole against the real monorepo at
`c:\campusgate` on branch `main`.

Verdict is mechanical: HIGH + MEDIUM count. This review finds **0 HIGH, 0 MEDIUM,
2 NIT** → **APPROVED**.

---

## Part A — Re-check of prior findings

The design documents seven revision-1 findings (2 HIGH, 2 MEDIUM, 3 NIT) and three
revision-2 findings (1 MEDIUM, 2 NIT). Each is re-checked against the current text.

- **HIGH-1 (requester-close had no route/permission) — CLOSED.** §7.2 now carries
  `POST /me/requests/:id/close` under `request_own`; §5's `RESOLVED → CLOSED` row
  names both the self and staff routes; AC-13 names both. The requester-close path
  resolves against a route STUDENT can reach. Internally consistent.
- **HIGH-2 (self vs staff route-path contradiction) — CLOSED.** §7.2 is declared
  the single source of truth; the "Two-surface split" paragraph defines
  `/me/requests/:id/...` (self, `request_own`, owner-scoped, 404 on foreign) vs
  bare `/:id/...` (staff key). §5 Handler column and AC-14/15/16 agree with it.
  No residual contradiction found.
- **MEDIUM-1 (raisedAt freeze disagreement) — CLOSED.** `raisedAt` is frozen in
  BOTH §5 "DB enforcement" and §8.5, and the two frozen-column lists are stated —
  and are in fact — byte-identical: `institutionId, requestTypeId,
  requesterUserId, title, priority, fieldValues, description, raisedAt,
  createdAt`.
- **MEDIUM-2 (`description` unclassified) — CLOSED.** `description` is classified
  frozen in §5, §8.5, and flagged in the §8 table-3 column, consistent with
  Assumption 4. No post-raise route writes it.
- **NIT-1 (staff-cancel permission undefined) — CLOSED.** §7.2 has the staff
  `POST /:id/cancel` row under `requests.handle`; §5 staff-cancel edges name it.
- **NIT-2 (`dueAt` nullable vs always-set) — CLOSED.** `dueAt` is NOT NULL in FR-6,
  FR-11, and the §8 table-3 column; the derived-breach predicate has no null
  branch and `slaTargetHours` carries CHECK ≥ 1 (§8.2), so it is always
  computable.
- **NIT-3 (dual-permission gate mechanism) — CLOSED.** The `GET /types/:id/fields`
  inline-guard note is present and rests on a verified fact: `authz-engine.ts`
  exports `can(auth, key)` and `requirePermission` takes exactly one key with no
  OR primitive (verified below). The note is accurate.
- **MEDIUM-3 (field DELETE referenced but absent from matrix) — CLOSED.** Resolved
  via "no delete": AC-3 and §9 now say create/update only, and the §7.2 matrix /
  §7.3 audit list expose no delete route or `field.deleted` key. Verified against
  `apps/api/src/routes/inventory.ts` (no `.delete(` verb) — the house pattern
  genuinely has no DELETE on config sub-resources, so the choice is grounded.
- **NIT-4 ("(+ broad self)" phrasing) — CLOSED.** §7.2 `POST /` (raise) row reads
  "STUDENT"; §7 prose states STUDENT is the sole seeded `request_own` binding and
  warns that extra pairs would break catalogue-sync set-equality.
- **NIT-5 (`GET /types/:id/fields` tenant-scoped-only note) — CLOSED.** The NIT-3
  note states this read is RLS-tenant-scoped only, carries no `requesterUserId`
  predicate, and exposes a type's public field schema (no owner to scope to).

All ten prior findings are genuinely Closed in the current text; none regressed.

---

## Part B — Findings on the current design

### NIT-1. `defaultAssigneeRole` validation and the new SERVICE_AGENT role value are under-specified
**Where:** FR-1, §8 table-1, §10 `createTypeSchema`.
**Problem:** `defaultAssigneeRole` is `enum of known role keys or free string ≤64`
(§10) and stored as a column with no FK (it is advisory per Assumption 3). The
design never settles whether `SERVICE_AGENT` (the new template role) is an
accepted value, nor whether an unknown/garbage role string is rejected or stored
verbatim. "enum of known role keys **or** free string" is exactly the kind of
"use X or Y" ambiguity that leaves two valid implementations (strict allow-list
vs free text). Since it is advisory metadata that never drives behaviour
(Assumption 3), this does not block, but the coder needs one rule.
**Concrete fix:** Pick one and state it in §10. Recommended: accept a free string
≤64 constrained by a regex (`[A-Z0-9_]{1,64}`) with NO cross-table validation
(matches the "advisory, no FK" decision and avoids a role-resolution dependency);
or, if an allow-list is wanted, validate against `Object.keys(ROLE_PERMISSIONS)`
plus `SERVICE_AGENT`. Add a one-line note that `SERVICE_AGENT` is a legal value
either way.

### NIT-2. `statusPatchSchema` toStatus enum vs the `IN_PROGRESS → RESOLVED` resolve path is slightly ambiguous at the envelope layer
**Where:** §10 `statusPatchSchema` (`toStatus ∈ {IN_PROGRESS, PENDING_APPROVAL}`),
§5 table, FR-10, AC-9.
**Problem:** AC-9 says "for a non-approval type `IN_PROGRESS → RESOLVED` is legal"
but RESOLVED is reached via `POST /:id/resolve` (FR-16), not `PATCH /:id/status`
(whose Zod enum excludes RESOLVED). This is internally resolvable — `PATCH
/:id/status` only drives `ASSIGNED→IN_PROGRESS` and `IN_PROGRESS→PENDING_APPROVAL`,
and resolve/approve/reject/cancel/close are dedicated endpoints — but AC-9's
phrasing ("that path is illegal (409) and `IN_PROGRESS → RESOLVED` is legal")
reads as if both are reachable through the same endpoint, when RESOLVED is only
reachable through `resolve`. A coder could mis-read AC-9 as requiring RESOLVED in
the `statusPatchSchema` enum.
**Concrete fix:** In AC-9 clarify: "for a non-approval type, `PATCH /:id/status`
`IN_PROGRESS → PENDING_APPROVAL` → 409 (approval-mismatch); `IN_PROGRESS →
RESOLVED` is performed via `POST /:id/resolve`, not `PATCH /:id/status`." Keep
`statusPatchSchema.toStatus` as `{IN_PROGRESS, PENDING_APPROVAL}` only.

---

## Verified Assumptions (checked against real source)

1. **Module registry `registry-key == prefix` precedent.** `packages/shared/src/modules.ts`
   — `hostel`, `transport`, `inventory` all use one key as both registry key and
   permission prefix, and all have `MODULE_DEPENDENCIES[...] = []`
   (foundational-not-gated). The design's `service_requests` key + `[]` deps
   (§12/§14) match exactly.
2. **catalogue-sync mechanism.** `apps/api/src/services/__tests__/catalogue-sync.test.ts`
   — `SEEDING_MIGRATION_DIRS` currently lists 18 dirs; the test extracts permission
   keys from `INSERT INTO "permissions" ... ON CONFLICT` and `(roleKey, permKey)`
   pairs from `INSERT INTO "role_permissions" ... AS m(` and asserts set-equality
   with `PERMISSION_KEYS` + `ROLE_PERMISSIONS`. The design's §13.j seed shape
   (`FROM (VALUES ...) AS m("roleKey","permKey")`) and the NFR-5 / AC-21 set-equal
   claim are exactly what the test enforces.
3. **Role/permission seed house style.** `20270117000000_phase9_inventory/migration.sql`
   §j — role row inserted BEFORE the permissions block (`INSERT INTO "roles"
   (...,"institutionId") VALUES (..., NULL) ON CONFLICT DO NOTHING`), then
   permissions `ON CONFLICT ("key") DO NOTHING`, then the role_permissions
   `VALUES ... AS m("roleKey","permKey")` join. The design's §13.j matches
   byte-for-byte in structure.
4. **`ROLE_PERMISSIONS` lockstep is achievable.** `packages/shared/src/permissions.ts`
   — ADMIN already carries the hostel/transport/inventory staff keys; STUDENT
   carries the self keys (`*.view_own` / `exams.reeval.request_own`). Adding 6
   `service_requests.*` permissions, a `SERVICE_AGENT` role with 5 staff keys, 5
   ADMIN staff keys, and `service_requests.request_own` to STUDENT is consistent
   with the existing additive pattern (ACCOUNTANT/WARDEN/HR_MANAGER/
   TRANSPORT_MANAGER/INVENTORY_MANAGER are all additive template roles). The
   design seeding exactly one `STUDENT :: request_own` pair keeps set-equality
   (NIT-4 fix) — correct, because the test compares ALL pairs.
5. **`authz-engine.ts` primitives.** Verified `requirePermission(key)` takes
   exactly ONE `PermissionKey` and 403s; `can(auth, key)` is exported and pure;
   `requireModuleActive(moduleKey)` exists and fails closed. There is NO
   `requireAnyPermission`. This grounds the NIT-3 inline-guard design for the one
   dual-key route (`GET /types/:id/fields`).
6. **No DELETE on config sub-resources.** `apps/api/src/routes/inventory.ts` — the
   route verbs are POST/PATCH/GET only; no `.delete(`. Grounds MEDIUM-3's
   "create/update only, no delete route" resolution.
7. **Audit catalogue is string-literal, no enum/migration.** `packages/shared/src/audit-actions.ts`
   + `apps/api/src/services/audit.ts` — `recordAuditEvent(input, tx)` validates
   `input.action` against `AUDIT_ACTION_KEY_SET` and accepts
   `result ∈ {SUCCESS, DENIED, ERROR}`. The design's §7.3 "15 string keys, no enum
   change, DENIED reuses the mutation key" is exactly how the writer behaves.
8. **DENIED-in-same-tx via normally-returning `withTenant`.** `apps/api/src/routes/admissions.ts`
   — deny branches call `recordAuditEvent(..., { result: "DENIED" }, tx)` then
   RETURN the 4xx from the callback (not throw), so the audit commits. NFR-3 / AC-23
   match this precedent.
9. **`fieldValues Json` storage is idiomatic.** `schema.prisma` — `Json` columns
   are used throughout (`Institution.settings`, `Application.formData Json
   @default("{}")`, etc.). The §6 choice of a single `jsonb` column is consistent.
10. **Schema model-block idiom.** `schema.prisma` `InventoryAsset` — `@@unique([id,
    institutionId])` anchors composite FKs, `@@index([institutionId])`, Prisma
    single-column relations with composite FKs/CHECKs/triggers living only in raw
    SQL migration, recorded actor ids with NO FK, authoritative identity refs
    (custody user/department) with composite FKs MATCH SIMPLE for nullable. The
    design's §8/§8.1 plan (recorded `createdByUserId`/`actorUserId` with no FK;
    composite FKs for requester/assignee; MATCH SIMPLE for nullable
    assignee/department) matches precisely.
11. **tenant-escape suite pattern.** `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`
    — every prior phase seeds its mutable tables in child-safe order via
    `adminClient` and handles append-only / column-guard tables with a scoped
    trigger-disable teardown dance (the inventory block seeds all nine with exactly
    this dance). The design's §12 plan to extend this for the 5 new tables (3
    mutable child-safe; 2 append-only ledgers via adminClient + trigger-disable)
    matches the established precedent, satisfying NFR-4 / AC-20.
12. **`exceljs` already present.** `apps/api/package.json` declares `exceljs
    ^4.4.0`. §11's "no new runtime dependency" + §23/AC-24 `.xlsx` export are
    feasible.
13. **Migration timestamp is free.** No migration dir with a `2027…` timestamp
    other than the 21 known frozen dirs exists; `20270124000000` is strictly after
    `20270117000000_phase9_inventory` and unused. The "22nd dir / SIXTH Phase-9
    module" framing is correct (9.1–9.6).
14. **No pre-existing `service_requests` / `SERVICE_AGENT` / `ServiceRequest`
    collision.** A repo-wide search returns matches only inside the design document
    itself — no schema model, permission key, role, or migration already claims
    these names, so the additive plan will not clash.

## Unverified / Wrong Assumptions

None. Every external claim the design depends on was checked against the real
source files listed above and found accurate. No claim was taken on the
document's word alone; no claim was found wrong.

---

## Verdict

0 HIGH + 0 MEDIUM → **APPROVED**. The two NIT items are polish for the
implementer (one validation rule for `defaultAssigneeRole`, one AC-9 wording
clarification) and do not block implementation. The fixed enumerated state
machine, the data-driven form model, the derived SLA, the approval gate, the
one-per-request owner-only feedback, the append-only logs, the additive
SERVICE_AGENT role + requester-self key separation, the RBAC×route×role×audit
matrix, the RLS/composite-FK/grants model, the module-registry wiring, the
additive migration layout, the catalogue-sync + tenant-escape coverage, and the
no-generic-engine / no-cross-module-coupling constraints are all concretely
settled and grounded in the real codebase.
