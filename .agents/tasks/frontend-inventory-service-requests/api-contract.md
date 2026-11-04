# API contract: Inventory + Service Requests UI (ground truth)

Source read: `apps/api/src/routes/inventory.ts`, `service-requests.ts`,
`packages/shared/src/{permissions,validation,modules}.ts`,
`apps/api/src/services/audit-actions.ts`, `packages/db/prisma/schema.prisma`
(inventory_* / service_request* models), `packages/db/src/seed.ts`, and the live
suites `inventory.behavioral.integration.test.ts` /
`service-requests.behavioral.integration.test.ts`. Backend fixes **G-INV1** and
**G-SR1** below were added in this step (one `feat(api)` commit, no migrations,
no new permission keys).

## Prefixes and gating
- Inventory: `/api/inventory`, module key `inventory`. Service Requests:
  `/api/service-requests`, module key `service_requests`. Both are
  "foundational-not-gated" (no dependency edges in `modules.ts`) but each needs
  its own `InstitutionModule` row in state `ACTIVE`.
- Every route: `authenticate` (top-level preHandler) + `requirePermission(key)` +
  `requireModuleActive(module)`. Inactive/absent module = **403** (same probe
  pattern as hostel/transport — `useModuleActive` keys on this).
  - **Exception (service_requests):** `GET /types/:id/fields` uses an inline dual
    gate `service_requests.view` OR `service_requests.request_own` (so a requester
    can render the raise form). 401 if unauthenticated, 403 if holding neither key.
- Errors: `{ error: string | zodFlatten }`. `400` zod (`error.flatten()`), `403`
  permission/module, `404` not found (also a foreign-tenant id, invisible via RLS),
  `409` conflict / illegal-transition / deny, `422` field-value validation (raise)
  and field-def SELECT-shape (service_requests). Deny branches write a DENIED
  AuditEvent in the same tx, then return the 4xx.
- `institutionId` ALWAYS comes from the verified token; ids in body/params are
  tenant-filtered inside `withTenant(institutionId, tx => ...)`. Never send
  `institutionId` / `requesterUserId` / `custodyUserId==self` from the client.
- Pagination (list endpoints that take it): `page>=1` default 1, `pageSize` 1..100
  default 20.

## Money
- **Inventory uses integer MINOR UNITS (paise) stored as `Int`, crossing JSON as a
  decimal-digit STRING** (money-as-string). Applies to `acquisitionCost` (asset),
  `cost` (maintenance), `proceeds` (disposal). Requests send `/^\d+$/` (>= 0);
  responses serialize back to a digit string or `null`. `currency` is an optional
  3-letter uppercase ISO-4217-shaped code (`/^[A-Z]{3}$/`). Use BigInt/paise
  helpers, never floats. **Unlike transport, there is no `number`-typed quirk —
  all three inventory money fields are serialized to string consistently.**
- **Service Requests has NO money fields.**

## Permission keys
Inventory (`permissions.ts`): `inventory.categories.manage`,
`inventory.assets.manage`, `inventory.stock.manage`,
`inventory.maintenance.manage`, `inventory.disposals.manage`,
`inventory.audits.manage`, `inventory.view` (staff read), `inventory.view_own`
(custodian self — **binds to INVENTORY_MANAGER only**, a deliberate deviation:
inventory has no non-staff self role).

Service Requests: `service_requests.types.manage`,
`service_requests.assign.manage`, `service_requests.requests.handle`,
`service_requests.requests.approve`, `service_requests.view` (staff read),
`service_requests.request_own` (requester self).

## Roles (ROLE_PERMISSIONS)
- **ADMIN:** all 6 inventory manage keys + `inventory.view` (NOT `inventory.view_own`);
  all 5 service_requests staff keys (types/assign/handle/approve/view, NOT `request_own`).
- **INVENTORY_MANAGER** (template role, inventory-scoped only): all 6 manage keys +
  `inventory.view` + `inventory.view_own` + `documents.download`. NO `admin.users.view`,
  NO `students.view`, NO `admin.departments.manage`, nothing service_requests.
- **SERVICE_AGENT** (template role, service-requests-scoped only): types.manage,
  assign.manage, requests.handle, requests.approve, view + `documents.download`.
  NO `request_own`, NO `admin.users.view`, NO `students.view`, nothing inventory.
- **STUDENT:** `service_requests.request_own` only (self). NO inventory key ever.
- HOD, FACULTY, ACCOUNTANT, LIBRARIAN, WARDEN, TRANSPORT_MANAGER, etc.: none of
  these keys.
- **Seeds (`packages/db/src/seed.ts`):** the seed does **NOT** create an
  INVENTORY_MANAGER or SERVICE_AGENT user and does **NOT** activate the
  `inventory` / `service_requests` InstitutionModule rows (it upserts only
  campus_movement, attendance, library, admissions, fees). `admin@demo.edu/admin123`
  holds every inventory + service_requests *staff* key; `bhavishya@demo.edu/student123`
  holds `service_requests.request_own`. Both see **403** until the modules are
  activated. See Known Limitations.

---

# INVENTORY endpoints (`/api/inventory`)

Enums (`validation.ts`): assetKind `FIXED_ASSET|CONSUMABLE`; assetStatus
`IN_STORE|ASSIGNED|IN_MAINTENANCE|RETIRED|DISPOSED`; maintenanceStatus
`OPEN|IN_PROGRESS|RESOLVED|CANCELLED`; stockMovementKind `RECEIPT|ISSUE|ADJUSTMENT`;
disposalMethod enum (`inventoryDisposalMethodEnum` — includes SCRAPPED/SOLD/...);
terminalStatus `RETIRED|DISPOSED`; maintenanceTransitionTarget `IN_PROGRESS|RESOLVED|CANCELLED`.

### Asset lifecycle (status machine, DB-guard enforced)
- Create: `ASSIGNED` if a custodian (user or dept) is supplied at create, else `IN_STORE`.
- Lateral: `IN_STORE <-> ASSIGNED` (via custody transfer). `*->IN_MAINTENANCE` on
  opening maintenance; `IN_MAINTENANCE -> priorAssetStatus` on close.
- Terminal: `RETIRED` / `DISPOSED` — no outgoing edge (any further
  transfer/maintenance/dispose/patch → `409 asset is terminal`).

### Categories
- `POST /categories` (`categories.manage`) `{name 1..128, code 1..64, kind,
  depreciationMethod?, usefulLifeMonths?}` → 201 category. 409 `category code already exists`.
- `PATCH /categories/:id` (`categories.manage`) strict partial of the same →
  category. 404 `category not found`; 409 dup code.
- `GET /categories?page&pageSize&kind` (`inventory.view`) → `{ categories, total,
  page, pageSize }` ordered by code. **(UI resolves categoryId→name from this list.)**

### Assets
- `POST /assets` (`assets.manage`) `{assetTag 1..128, name 1..256, categoryId,
  acquisitionDate?, acquisitionCost? (digit string), currency?, location?,
  custodyUserId?, custodyDepartmentId?}` → 201 asset (money as string). 404
  `category not found`; 409 `asset tag already exists`. Identity cols
  (assetTag/categoryId/acquisition*/currency) are **frozen by the DB guard after create**.
- `PATCH /assets/:id` (`assets.manage`) strict `{name?, location? (nullable)}` only
  (identity + status + custody are NOT editable here). 404 `asset not found`;
  409 `asset is terminal` | `immutable asset column changed`.
- `GET /assets?page&pageSize&status&categoryId` (`inventory.view`) → `{ assets,
  total, page, pageSize }` ordered by assetTag. Rows carry raw `categoryId`,
  `custodyUserId`, `custodyDepartmentId` (join client-side via `/categories` +
  `/users/lookup`).
- `GET /assets/:id` (`inventory.view`) → asset (money as string). 404.
- `POST /assets/:id/transfer` (`assets.manage`) `{toUserId?, toDepartmentId?
  (>=1 required), reason?, transferredAt?}` → **201** asset (now ASSIGNED) + a
  custody-ledger row. 404 `asset not found`; 409 `asset is terminal`.
- `POST /assets/:id/maintenance` (`maintenance.manage`) `{issue 1..512,
  assigneeUserId?, cost? (digit string)}` → 201 OPEN request; asset → IN_MAINTENANCE.
  404 `asset not found`; 409 `asset not available for maintenance` (asset not
  IN_STORE/ASSIGNED) | `maintenance already open for asset`.
- `POST /assets/:id/dispose` (`disposals.manage`) `{terminalStatus, method,
  proceeds?, currency?, reason?, disposedAt?}` → 201 disposal (proceeds as string);
  asset → terminal. 404; 409 `asset is terminal` | `asset already disposed`.

### Maintenance
- `PATCH /maintenance/:id` (`maintenance.manage`) `{toStatus
  IN_PROGRESS|RESOLVED|CANCELLED, cost?, resolutionNote?}`. Legal:
  `OPEN->IN_PROGRESS|CANCELLED`, `IN_PROGRESS->RESOLVED|CANCELLED`;
  RESOLVED/CANCELLED terminal. On close: asset restored to priorAssetStatus
  (or maintenance-only flip if asset was disposed mid-maintenance). 404
  `maintenance request not found`; 409 `illegal status transition`. Response money
  as string.
- `GET /maintenance?page&pageSize&status&assetId` (`inventory.view`) → `{ requests,
  total, page, pageSize }` newest first.

### Consumable stock (CONSUMABLE assets get a 1:1 stock item at create; on-hand starts 0)
- `POST /stock/:assetId/movements` (`stock.manage`) `{kind, quantity (signed,
  non-zero int; RECEIPT>0, ISSUE<0, ADJUSTMENT!=0), reason?}` →
  `201 { movement, onHandQuantity }`. Advisory-locked per stock item. 404
  `stock item not found` (asset has no stock item / not consumable); 409
  `insufficient stock` (would drive on-hand < 0). `balanceAfter` is the
  post-movement on-hand snapshot.
- `GET /stock?page&pageSize` (`inventory.view`) → `{ stockItems, total, page, pageSize }`.
- `GET /stock/:assetId` (`inventory.view`) → `{ stockItem, movements }` (last 100,
  newest first). 404 `stock item not found`.

### Stock-take audits
- `POST /audits` (`audits.manage`) `{name 1..128}` → 201 OPEN session.
- `POST /audits/:id/lines` (`audits.manage`) `{EXACTLY ONE of assetId|stockItemId,
  expectedQuantity?, foundQuantity?, note?}` → 201 line (append-only; discrepancy
  = found-expected when both present). 404 `audit session not found`; 409
  `audit session not open`.
- `PATCH /audits/:id` (`audits.manage`, no body) → session CLOSED. 404; 409
  `audit session not open`.

### Reports (all `inventory.view`)
- `GET /reports/register` → `{ register: [asset...] }` (money as string).
- `GET /reports/custody` → `{ custody: [asset with a custodian...] }`.
- `GET /reports/low-stock` → `{ lowStock: [stockItem where onHand <= reorderLevel] }`.
- `GET /reports/disposals` → `{ disposals: [...] }` (proceeds as string).
- `GET /reports/register.xlsx` → XLSX blob (audited). Fetch with the auth header,
  not a plain `<a href>`. Columns are RAW ids (Asset/Category/Custody ids).

### Self-service
- `GET /me/assets` (`inventory.view_own`, **INVENTORY_MANAGER only**) → `{ assets }`
  self-scoped by `custodyUserId == token.userId`. 200 + list (possibly empty),
  never 404, no audit.

### G-INV1 (NEW — backend fix this step)
- `GET /users/lookup?q=&limit=` (`inventory.assets.manage`) q 2..100 chars (400
  otherwise), limit 1..25 default 10; matches tenant users by email OR faculty
  name (case-insensitive contains), **excludes student-profile users**, ordered by
  email. → `{ users: [{ id, email, name|null }] }`. This is the custodian/assignee
  picker for the asset-create + custody-transfer forms. Rationale: INVENTORY_MANAGER
  holds no `admin.users.view`/`students.view`, so there was previously no
  least-privilege way to resolve a user id. Mirrors the hostel G-HOS6 precedent.

---

# SERVICE REQUESTS endpoints (`/api/service-requests`)

Enums: fieldType `TEXT|NUMBER|DATE|SELECT`; priority `LOW|NORMAL|HIGH|URGENT`;
status `OPEN|ASSIGNED|IN_PROGRESS|PENDING_APPROVAL|RESOLVED|CLOSED|REJECTED|CANCELLED`.

### Lifecycle (FIXED enumerated machine, DB-guard enforced; `STATUS_TRANSITIONS` in route)
```
OPEN            -> ASSIGNED | CANCELLED
ASSIGNED        -> IN_PROGRESS | ASSIGNED(reassign) | CANCELLED
IN_PROGRESS     -> PENDING_APPROVAL | RESOLVED | CANCELLED
PENDING_APPROVAL-> RESOLVED | REJECTED
RESOLVED        -> CLOSED
CLOSED | REJECTED | CANCELLED = terminal (no outgoing edge)
```
- `PENDING_APPROVAL` is reachable ONLY for `requiresApproval` types (a non-approval
  type → 409 `this request type does not require approval`).
- `RESOLVED` for a non-approval type is reached via `POST /:id/resolve`
  (IN_PROGRESS->RESOLVED); for an approval type via `POST /:id/approve`
  (PENDING_APPROVAL->RESOLVED). `PATCH /:id/status` only targets `IN_PROGRESS` /
  `PENDING_APPROVAL`.
- **SLA:** `dueAt = raisedAt + slaTargetHours` (computed at raise, NOT NULL).
  `isOverdue = now > dueAt AND status not in {RESOLVED,CLOSED,REJECTED,CANCELLED}`
  — returned as a derived `isOverdue` flag on request rows/detail.
- **Field-def freeze:** once a type has >= 1 request, its field definitions are
  frozen (POST/PATCH field → 409 `field definitions are frozen once the type has requests`).

### Request types + field defs (staff config)
- `POST /types` (`types.manage`) `{name 1..200, code [A-Z0-9_] 1..64, category 1..64,
  description?, defaultAssigneeRole? ([A-Z0-9_]), defaultAssigneeDepartmentId?,
  slaTargetHours 1..8760, requiresApproval?, isActive?}` → 201 type. 409 dup code.
- `PATCH /types/:id` (`types.manage`) strict partial → type. 404 `request type not found`.
- `GET /types` (`service_requests.view`) → `[type...]` (array; ordered category,name).
- `POST /types/:id/fields` (`types.manage`) `{fieldKey [a-zA-Z0-9_] 1..64, label
  1..200, dataType, required?, options? (SELECT => non-empty, non-SELECT => omit),
  sortOrder?}` → 201 field. 404; 409 frozen | `field key already exists for this type`.
- `PATCH /types/:id/fields/:fid` (`types.manage`) strict partial → field. 404; 409
  frozen | dup key; **422** SELECT-shape violation.
- `GET /types/:id/fields` (**dual gate** `view` OR `request_own`) → `[fieldDef...]`
  ordered by sortOrder. This is how the requester renders the data-driven raise form.

### Self-service (requester, `request_own`, hard-scoped by `requesterUserId==token.userId`)
- `POST /` (`request_own`) `{requestTypeId, title 1..200, description?, priority
  (default NORMAL), fieldValues {}}` → 201 request (status OPEN) + a STATUS_CHANGE
  activity. 404 `request type not found`; 409 `request type is inactive`; **422
  { errors: {fieldKey: "required"|"invalid_type"|"invalid_option"|"unknown"} }**
  from the dynamic field-value validator.
- `GET /me/requests?page&pageSize&status&requestTypeId` (`request_own`) →
  `{ page, pageSize, total, data: [request & {isOverdue}] }` own only, newest first.
- `GET /me/requests/:id` (`request_own`) → request & `{ isOverdue, activities[],
  feedback|null }`. Foreign id → owner-scoped **404**.
- `POST /me/requests/:id/comments` (`request_own`) `{body 1..4000}` → 201 activity.
  404 (foreign/owner-scoped); 409 `cannot comment on a closed request`.
- `POST /me/requests/:id/cancel` (`request_own`, no body) → CANCELLED. **OPEN only**;
  else 409 `cannot cancel from <status>`. 404 foreign.
- `POST /me/requests/:id/close` (`request_own`, no body) → CLOSED. **RESOLVED only**;
  else 409. 404 foreign.
- `POST /me/requests/:id/feedback` (`request_own`) `{rating 1..5, comment?}` → 201
  feedback. Only on RESOLVED/CLOSED (else 409 `feedback is only allowed...`); one
  per request (second → 409 `feedback already submitted...`). 404 foreign.

### Staff triage / handling
- `GET /?page&pageSize&status&requestTypeId&assigneeUserId&overdue` (`view`) →
  `{ page, pageSize, total, data: [request & {isOverdue}] }` all tenant requests,
  newest first. `overdue=true` filters to breached rows.
- `GET /:id` (`view`) → request & `{ isOverdue, activities[], feedback|null }`. 404.
- `POST /:id/assign` (`assign.manage`) `{assigneeUserId}` → `{status:"ASSIGNED"}` +
  ASSIGNMENT activity. 404 `request not found` | `assignee not found` (404 deny);
  409 illegal transition (only OPEN->ASSIGNED / ASSIGNED->ASSIGNED reassign).
- `PATCH /:id/status` (`requests.handle`) `{toStatus IN_PROGRESS|PENDING_APPROVAL}`
  → `{status}`. 404; 409 illegal transition | approval-type mismatch.
- `POST /:id/resolve` (`requests.handle`) `{resolutionNote 1..4000}` →
  `{status:"RESOLVED"}`. Only IN_PROGRESS + non-approval type; else 409.
- `POST /:id/approve` (`requests.approve`, no body) → `{status:"RESOLVED"}`. Only
  from PENDING_APPROVAL; else 409 `cannot approve from <status>`.
- `POST /:id/reject` (`requests.approve`) `{reason?}` → `{status:"REJECTED"}`. Only
  from PENDING_APPROVAL; else 409.
- `POST /:id/close` (`requests.handle`, no body) → `{status:"CLOSED"}`. Only from
  RESOLVED; else 409.
- `POST /:id/cancel` (`requests.handle`, no body) → `{status:"CANCELLED"}`. From
  OPEN/ASSIGNED/IN_PROGRESS; else 409.
- `POST /:id/comments` (`requests.handle`) `{body 1..4000}` → 201 activity. 404.

### Reports (all `service_requests.view`)
- `GET /reports/overdue?atRiskHours` (default 24) → `{ atRiskHours, overdue[], atRisk[] }`.
- `GET /reports/volume` → `{ data: [{ requestTypeId, count }] }`.
- `GET /reports/sla` → `{ totalResolved, withinSla, compliancePct|null }`.
- `GET /reports/feedback` → `{ count, averageRating|null }`.
- `GET /reports/export` → XLSX blob (audited). Fetch with the auth header. Columns
  are RAW ids.

### G-SR1 (NEW — backend fix this step)
- `GET /users/lookup?q=&limit=` (`service_requests.assign.manage`) same contract/shape
  as G-INV1 → `{ users: [{ id, email, name|null }] }`. Agent picker for the
  assign/reassign form. Rationale: SERVICE_AGENT holds no `admin.users.view`/
  `students.view`, so there was no least-privilege way to resolve an agent id.
  Mirrors the hostel G-HOS6 / inventory G-INV1 precedent.

---

# ROLE-CAPABILITY MATRIX (each screen × the role that owns it; write key + every read/lookup key it needs)

| Screen (module) | Role | Write key(s) | Read / lookup key(s) needed | All held? |
|---|---|---|---|---|
| Inventory: Categories admin | INVENTORY_MANAGER / ADMIN | `inventory.categories.manage` | `inventory.view` (list) | ✅ both roles |
| Inventory: Asset registry (create/edit/list/detail) | INVENTORY_MANAGER / ADMIN | `inventory.assets.manage` | `inventory.view`, `inventory.categories` list via `inventory.view`, **`/users/lookup` via `inventory.assets.manage` (G-INV1)** | ✅ both roles |
| Inventory: Custody transfer | INVENTORY_MANAGER / ADMIN | `inventory.assets.manage` | `inventory.view`, **`/users/lookup` (G-INV1, `assets.manage`)**, departments via public `/auth/departments` | ✅ both roles |
| Inventory: Consumable stock (movements) | INVENTORY_MANAGER / ADMIN | `inventory.stock.manage` | `inventory.view` | ✅ |
| Inventory: Maintenance queue | INVENTORY_MANAGER / ADMIN | `inventory.maintenance.manage` | `inventory.view` | ✅ |
| Inventory: Disposal | INVENTORY_MANAGER / ADMIN | `inventory.disposals.manage` | `inventory.view` | ✅ |
| Inventory: Stock-take audits | INVENTORY_MANAGER / ADMIN | `inventory.audits.manage` | `inventory.view` | ✅ |
| Inventory: Reports + XLSX | INVENTORY_MANAGER / ADMIN | — | `inventory.view` | ✅ |
| Inventory: My assets (custodian self) | INVENTORY_MANAGER | — | `inventory.view_own` | ✅ (ADMIN excluded by design) |
| SvcReq: Type/field config | SERVICE_AGENT / ADMIN | `service_requests.types.manage` | `service_requests.view`, `/types/:id/fields` (view) | ✅ both roles |
| SvcReq: Triage queue (list/detail) | SERVICE_AGENT / ADMIN | — | `service_requests.view` | ✅ |
| SvcReq: Assign / reassign | SERVICE_AGENT / ADMIN | `service_requests.assign.manage` | `service_requests.view`, **`/users/lookup` (G-SR1, `assign.manage`)** | ✅ both roles |
| SvcReq: Handle (status/resolve/close/cancel/comment) | SERVICE_AGENT / ADMIN | `service_requests.requests.handle` | `service_requests.view` | ✅ |
| SvcReq: Approve / reject | SERVICE_AGENT / ADMIN | `service_requests.requests.approve` | `service_requests.view` | ✅ |
| SvcReq: Reports + XLSX | SERVICE_AGENT / ADMIN | — | `service_requests.view` | ✅ |
| SvcReq: Raise a request (self-service) | STUDENT (any `request_own` holder) | `service_requests.request_own` | `/types` — **see Known Limitation SR-1**, `/types/:id/fields` (dual gate, held) | ⚠ types list gap |
| SvcReq: Track my requests / comment / cancel / close / feedback | STUDENT | `service_requests.request_own` | `/me/requests*` (all `request_own`) | ✅ |

Legend: ✅ = the owning role holds the write key AND every read/lookup key the
screen needs. Lookups use the module's own manage key (G-INV1/G-SR1), never a
broadened unrelated role.

---

# BACKEND GAPS — found and FIXED this step

**G-INV1 — custodian/assignee picker.** The asset-create and custody-transfer
forms need to resolve a user id, but INVENTORY_MANAGER holds no
`admin.users.view` / `students.view` (strict least privilege). Added
`GET /api/inventory/users/lookup` gated by the existing `inventory.assets.manage`
key (the very key that sets custody). Returns non-student tenant users only.
No new permission key, no migration. Mirrors hostel G-HOS6.

**G-SR1 — agent picker.** The assign/reassign form needs to resolve an agent id,
but SERVICE_AGENT holds no `admin.users.view` / `students.view`. Added
`GET /api/service-requests/users/lookup` gated by the existing
`service_requests.assign.manage` key. Returns non-student tenant users only.
No new permission key, no migration. Mirrors G-INV1.

Both lookups: tenant-scoped via `withTenant`, validated with new zod schemas
(`inventoryUserLookupQuerySchema`, `serviceRequestUserLookupQuerySchema`, q 2..100,
limit 1..25 default 10), add fast-fail 400 on short q, and never broaden any
unrelated role.

**NOT changed (deliberately):** inventory/service_requests list + report reads
continue to return RAW foreign ids (categoryId, custodyUserId, assigneeUserId,
requesterUserId, requestTypeId). The UI resolves names client-side via the list
endpoints (`/categories`, `/types`) and the new `/users/lookup` pickers — the exact
hostel/transport precedent. Enriching every read was rejected as scope creep that
would also break the existing behavioral-suite shape assertions.

---

# Known Limitations

- **SR-1 (types list for requesters).** `GET /types` (the full type catalogue) is
  gated by `service_requests.view`, which a STUDENT requester does NOT hold. A
  requester CAN read a single type's fields via the dual-gated `GET /types/:id/fields`
  but has **no endpoint that lists the active request types to choose from**. The
  raise flow therefore needs a type id supplied some other way (e.g. a landing page
  per type, or a linked "raise X" entry). This was NOT fixed here because the only
  least-privilege fix is a NEW requester-facing types-list endpoint/behaviour that
  changes what a requester sees — a **product decision** (which types to surface,
  only `isActive`, categorised, etc.), out of scope for a mechanical gap-fix. The
  frontend step should flag it to the user or pick a convention and confirm. No
  permission key supports it today without broadening `request_own`.
- **Seed gaps.** The seed creates no INVENTORY_MANAGER or SERVICE_AGENT user and
  does not activate the `inventory` / `service_requests` InstitutionModule rows, so
  on the demo tenant only `admin@demo.edu` has the staff keys and even that returns
  403 until the modules are activated (`bhavishya@demo.edu` likewise for the
  self surface). Activating the modules + (optionally) seeding the two manager
  users is a prerequisite for the UI to function on the demo data. Left to the
  deployment/seed owner (no migration added here).
- **Departments picker is cross-tenant.** The only department list reachable by a
  manager/agent is the public `GET /auth/departments`, which returns departments
  across all ACTIVE institutions. It is adequate for a dept-id picker (used by the
  existing registration form) but is not tenant-scoped; a dedicated tenant-scoped
  dept lookup was not added (no inventory/service_requests dept-write key exists and
  custody-by-department is optional).

---

# TEST RESULTS

- **Fast suite** `npm test -w @campusgate/api`: **762 passed, 1 failed** — the single
  failure is `src/services/__tests__/reliability-engine.property.test.ts` (a
  fast-check property test unrelated to inventory/service_requests). It **passes
  deterministically when run in isolation** (`20 passed`), confirming it is a
  seed-dependent flake in the property generator, not a regression from this step.
  My additions are in the live behavioral suites (below), not the fast suite, so
  the fast count is unchanged from the 763 baseline.
- **Build / typecheck:** `npm run build -w @campusgate/shared` and
  `npm run build -w @campusgate/api` both pass (tsc clean) — the new routes,
  schemas, and tests compile.
- **Live suites — WRITTEN, NOT RUN.** `inventory.behavioral` could not complete:
  the shared Supabase free-tier session pooler returned
  `FATAL: (EMAXCONNSESSION) max clients reached in session mode (pool_size: 15)`
  at the seed/teardown step (all 17 tests SKIPPED, zero logic executed). Retried
  once after a ~70s wait per the runbook; still pool-exhausted (the deployed
  container competes for the same 15-slot pool, matching the EMAXCONNSESSION lines
  in the deploy logs). `service-requests.behavioral` was therefore not attempted
  (never two vitest processes at once + the same pool is saturated). The new
  tenant-isolation + role-denial cases (`Inventory G-INV1 /users/lookup` ×3,
  `G-SR1 /users/lookup` ×2) are committed and ready to run once the pool frees up.
