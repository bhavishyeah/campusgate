# Phase 2 (SIS) — Design Review

Reviewer: design-review subagent (fresh read, no authoring context).
Artifact: `c:\campusgate\.agents\tasks\phase2-sis\design.md`.
Method: every load-bearing claim re-verified against the live repo at `c:\campusgate`
(schema, FROZEN migrations, shared catalogues, route handlers, test helpers, docs).
No builds or test suites were run (design review only).

## Verdict

**APPROVED.** Zero HIGH and zero MEDIUM findings. The design stands on its own: its
invariants are enforced by construction (DB-level), its assumptions about the live code
and docs were checked and hold, and its scope matches the roadmap. The findings below are
all NIT — specification polish the implementer should fold in, none of which block.

The verdict is mechanical: HIGH + MEDIUM = 0 ⇒ APPROVED.

---

## Findings

1. **NIT — `students.ts` route registration + prefix not spelled out.**
   §5.1 says the new route file `students.ts` (exported `studentAdminRoutes`) is
   "registered under a `/students` prefix in the API's route registration", but it never
   states the concrete `apps/api/src/server.ts` edit nor that the prefix must follow the
   established `/api/<name>` convention (verified: every route in `server.ts` is
   `app.register(x, { prefix: "/api/..." })`). 
   Concrete fix: state explicitly in §5.1/§10 — "add
   `await app.register(studentAdminRoutes, { prefix: \"/api/students\" });` to
   `apps/api/src/server.ts` alongside the existing registrations." Confirm there is no
   path collision with the self-service additions, which live on `student.ts`
   (prefix `/api/student`), so the admin routes at `/api/students/*` and self-service at
   `/api/student/me/*` do not overlap.

2. **NIT — self-service `/me/services` resolution mechanism is named only by analogy.**
   §8 says `/me/services` reads the institution's `institutionModule` rows "via the same
   mechanism `requireModuleActive` uses" and returns modules whose `state = ACTIVE`.
   `requireModuleActive` exists (`apps/api/src/services/authz-engine.js`, imported by
   `student.ts`), so the referent is real, but the design does not name the exact
   read (e.g. a `tx.institutionModule.findMany({ where: { institutionId, state: "ACTIVE" } })`
   inside `withTenant`) or how module keys map to self-service entry points.
   Concrete fix: specify the query and the module-key → entry-point map shape (even if the
   map is a small literal in `students.ts`/`student.ts`), so the implementer has no
   interpretation to make. The `ACTIVE`-only filter and the SUSPENDED/ENTITLED/NOT_ENTITLED
   exclusion are already unambiguous.

3. **NIT — live importer's audit key changes from `admin.students.imported` to
   `students.student.imported`.**
   §7.3/§7.4 keep the legacy `admin.students.imported` catalogue entry but have the
   folded-in importer write the NEW `students.student.imported` key "going forward". This
   is a behavioral change to a live route's audit output (verified: `admin.ts`
   `/students/bulk-import` currently writes `admin.students.imported` via
   `recordAuditEvent`). It is defensible and explicitly mirrors the Phase-1
   `admin.academic_calendar.updated` stance, but a consumer that greps audit history by the
   old key will see the stream switch.
   Concrete fix: either (a) keep writing `admin.students.imported` and drop the new
   `students.student.imported` key (one fewer catalogue entry), or (b) keep the change but
   add a one-line note in §7.4 that any audit dashboard/filter keyed on the old import key
   must union both. Pick one and state it; the current text leaves both keys "valid" without
   saying which the live route emits after the fold-in beyond "going forward".

4. **NIT — `migrate dev --create-only` risk is characterized more strongly than
   `database.md` supports.**
   §10.2 avoids `migrate dev --create-only` because it "may trip the pre-existing superadmin
   checksum mismatch into a reset prompt against the shared DB". Verified against
   `database.md`: the doc records the `20261019053533_superadmin_security` checksum mismatch
   as harmless and `migrate deploy`-tolerated, and in fact lists `migrate dev --create-only`
   as the standard going-forward generation step. The design's chosen path (hand-author the
   SQL + confirm with read-only `migrate diff` + apply with `migrate deploy`) is correct and
   fully compatible with `database.md` — hand-authoring is required anyway for the
   RLS/trigger/grant/seed SQL the diff cannot model — so the plan is sound; only the
   rationale slightly overstates the `--create-only` hazard.
   Concrete fix: reword §10.2 to "`--create-only` is unnecessary here because the migration
   is hand-authored for the RLS/trigger/grant/seed SQL regardless; we confirm the modelled
   DDL with read-only `migrate diff` and apply with `migrate deploy`", dropping the
   speculative reset-prompt claim.

---

## Verified Assumptions

Each was checked against the actual repo file named.

- **Live `StudentProfile` shape** (`packages/db/prisma/schema.prisma`): `enrollmentNo`
  `@unique`, `userId @unique`, `@@unique([id, institutionId])`, `@@index([institutionId])`,
  `program String`, `semester Int`, `dob String?`, `rollNumber String?`, `section String?`,
  `phone/address String?`, `departmentId` with a `Department` relation, `gatePasses` +
  `reliabilitySnapshots` back-relations. §3.1 is accurate; the additive columns in §3.3 do
  not collide with any existing field, and naming the new relation `structuredProgram`
  (scalar `programId`) is necessary because the scalar `program` field already exists.

- **Parent tables carry `@@unique([id, institutionId])`** for the new composite FKs:
  `Program`, `AcademicSession`, `AcademicTerm` all have it (schema + FROZEN
  `phase1_academics` migration create the `*_id_institutionId_key` indexes). `AcademicTerm`
  has `ordinal Int` (§5.3 "term's ordinal" is valid). §3.5 composite same-tenant FKs are
  constructible with no change to any FROZEN object.

- **GatePass / reliability FKs reference only untouched columns.**
  `gate_passes_student_same_tenant_fkey` and
  `reliability_score_snapshots_student_same_tenant_fkey` reference
  `student_profiles(id, institutionId)` (verified pattern in `tenancy.md` §4 +
  `schema.prisma`). Phase 2 adds only columns/indexes/FKs and never alters `id` or
  `institutionId`, so §9's non-breaking argument holds.

- **Append-only machinery exists verbatim in the FROZEN `phase1_academics` migration.**
  `academic_calendar_day_revisions` uses the SELECT + `*_tenant_insert` (NO modify/FOR ALL)
  RLS pair, a `*_append_only()` function raising `restrict_violation`, a
  `BEFORE UPDATE OR DELETE` trigger binding every role, and `GRANT SELECT, INSERT` +
  `REVOKE UPDATE, DELETE` from `campass_app`. §4.2 / §10 mirror this faithfully for
  `student_profile_history`. The composite-FK-to-parent detail (§4.1: history keeps an
  `ON DELETE RESTRICT` composite FK because students are never deleted, unlike the
  calendar-revision table which omitted its FK) is a correct and justified divergence.

- **`catalogue-sync.test.ts` parser markers** (verified): permissions block sliced between
  `INSERT INTO "permissions"` and `ON CONFLICT`, key = 2nd single-quoted literal per row;
  role_permissions block sliced between `INSERT INTO "role_permissions"` and `AS m(`, pairs
  matched as `('ROLE','key')` after stripping `--` comments; `SEEDING_MIGRATION_DIRS`
  currently lists the four seeding migrations. §7.5's required edits (seed the new
  permissions + pairs with the exact markers; add the `phase2_sis` dir to
  `SEEDING_MIGRATION_DIRS`) are the correct and complete set of changes to keep the test
  green, and set-equality against `PERMISSION_KEYS` + `ROLE_PERMISSIONS` is what the test
  asserts.

- **`tenant-escape-setup.ts` structure** (verified): `RLS_TABLES` (array, `student_profiles`
  already present), `EXPECTED_POLICIES` (override map; absent tables fall through to
  `DEFAULT_POLICIES = {tenant_isolation_select, tenant_isolation_modify}`), `DEFAULT_POLICIES`,
  `SeededTenant` interface, `seedTenant`, `cleanup`, `countRemainingTestRows`. §11.1 names
  the exact edits correctly — including the important subtlety that `student_documents` must
  be added to `RLS_TABLES` but NOT to `EXPECTED_POLICIES` (so it is asserted against the
  default pair), while `student_profile_history` must be registered in `EXPECTED_POLICIES`
  as the append-only pair and must NOT be seeded/cleaned (the trigger blocks even the
  admin client, exactly the `academic_calendar_day_revisions` precedent the helper already
  follows).

- **Audit-action enforcement** (verified): `recordAuditEvent` (`apps/api/src/services/audit.ts`)
  throws on any `action` not in `AUDIT_ACTION_KEY_SET`; `AuditActionKey` is a literal union
  over `AUDIT_ACTIONS`, so an unlisted key also fails `tsc`; the `audit-actions.test.ts`
  meta-test asserts `KEY_RE = /^[a-z_]+(\.[a-z_]+)+$/`. The eight proposed
  `students.student.*` keys are 3-segment and MATCH that regex (the `(\.[a-z_]+)+` group
  allows one-or-more dotted segments), and there is no pg enum / seeded row / migration
  mirror for audit keys — so adding them to the `AUDIT_ACTIONS` array is the single required
  change. §7.4 is accurate on all counts.

- **Permission catalogue shape** (verified `packages/shared/src/permissions.ts`):
  `PERMISSIONS` entries are `{ key, module, description }`; `PERMISSION_KEYS` and
  `ROLE_PERMISSIONS` (STUDENT/GUARD/HOD/ADMIN/SUPER_ADMIN) are the single source of truth;
  `admin.students.export` already exists and is ADMIN-bound. §5.1/§7.4's decision to keep
  export on `admin.students.export` (six new `students.*` keys + `students.view_own`, no
  `students.export`) is internally consistent and avoids churning a live key.

- **Live routes** (verified): `/register` (`auth.ts`) rejects a mismatched `enrollmentNo` on
  an existing imported user (409), and rejects a new registration whose `enrollmentNo`
  already exists via `studentProfile.findUnique({ where: { enrollmentNo } })`; bulk-import
  (`admin.ts`, `admin.students.import`) runs inside one `withTenant`, parses each row with
  `bulkImportStudentSchema`, resolves the department by `courseCode`, skips on existing
  email, wraps each create in `try/catch`, and writes one `admin.students.imported` audit
  event; export (`admin.ts`, `admin.students.export`) reads `program`/`semester` and
  department fields. §7.2 / §7.3 / §5.1 accurately describe these, and the re-import rule
  (resolve by `enrollmentNo` first → update-or-skip, with the `enrollmentNo UNIQUE` index as
  the final backstop) is a correct, non-duplicating fold-in.

- **`getStudentInTenant`** (verified `apps/api/src/services/authz.ts`): resolves by
  `{ userId, user: { institutionId } }`, i.e. keyed on the authenticated `userId`, never on
  a request-supplied student id. §8's ownership guarantee ("reads only the row owned by the
  authenticated userId; never accepts a student id from the request") is accurate, and
  combined with `withTenant` RLS gives the two-layer scope the design claims.

- **FROZEN migration set** (verified `ls` of `packages/db/prisma/migrations`): exactly the
  seven dirs §10 lists (`20260824143031_add_allowance_and_reliability_models`,
  `20261018100917_init`, `20261018110658_tenancy_isolation_rls`,
  `20261018171747_identity_rbac_b2`, `20261019053533_superadmin_security`,
  `20261019093119_module_system`, `20261027111710_phase1_academics`). §0's "six Phase-0 +
  the phase1" = 7 total is consistent with §10's "seven FROZEN"; no contradiction.

- **Checksum-drift note** (verified `docs/database.md`): the
  `20261019053533_superadmin_security` recorded checksum does not match the committed file
  bytes; recorded as harmless, `migrate status` clean, `migrate deploy` tolerant; if it ever
  blocks `migrate dev`, use `prisma migrate resolve`, never a manual overwrite or reset. The
  earlier B-1 "mismatch" was a CRLF false alarm. §10.2 matches the doc (see NIT 4 for the one
  slightly-overstated line).

- **Architecture / roadmap grounding** (verified `docs/architecture.md`, `docs/roadmap.md`):
  §2 Layer B lists `Student` among shared identity entities modules reference by ID; §5 is
  the entitlement/activation model for Layer-C operational modules; roadmap Phase 2 scope
  lists generalize-StudentProfile, statuses (the exact seven the design's enum uses),
  the operations set (incl. "bulk import — fold into the new model", "export (authorized)"),
  "emergency contact (only if collected)", "documents (reference)", "profile history", and
  the four named tests (no-duplicate-on-re-import, permitted-field enforcement, self-service
  shows only active-module services, cross-tenant escape extended). Decisions A (foundational,
  not gated — §1), the emergency-contact omission (§2), and the self-service scope (§8) are
  all faithful to these sources.

## Unverified / Wrong Assumptions

No wrong assumptions were found. The design's §14 "assumptions verified this pass" list was
independently re-checked and matches the repo.

Items that remain genuinely unverifiable in a static design review (not defects — called out
for transparency):

- **Runtime DB behavior** (the live `_prisma_migrations` ledger's current checksum state, the
  free-tier pause status, and that `migrate deploy` applies cleanly against the live Supabase
  instance today) cannot be confirmed without executing against the database, which this
  review deliberately does not do. The design relies on `database.md`'s recorded state, which
  is the correct source to trust here.
- **Prisma's generated single-column FK constraint names** (`student_profiles_programId_fkey`
  etc. that §3.5 DROPs before adding the composite FKs) follow Prisma 6's default naming; this
  is the same pattern the FROZEN `phase1_academics` migration used successfully
  (`programs_departmentId_fkey` → composite), so it is sound, but the exact names only
  materialize when the implementer runs `prisma generate` + inspects the diff (§10.2 step 3),
  which is the right place to confirm them.
