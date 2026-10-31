# CAMPASS Phase 7 — Fees & Payments, SLICE 7.1 (backend only)

Requirements + technical design. Money-critical. Design-first, grounded in the
real slice-1 files (read, not assumed). Slice 1 is frozen and live-verified
(HEAD `ac9440f` on `origin/main`); this slice is strictly ADDITIVE and never
touches a frozen migration, policy, grant, or captured row.

Section map mirrors the slice-1 design vocabulary (§D.*) so reviewers can
cross-reference. New-in-7.1 sections use §E.*.

---

## 1. Summary

Slice 1 shipped the core fees ledger + Razorpay capture spine: immutable
`student_charges` (snapshot), append-only `payment_allocations`/`receipts`/
`processed_webhook_events`, the column-guarded `payment_transactions`, the
single idempotent `confirmCapture` routine, oldest-due-first `planAllocation`,
and read-computed outstanding/status. Slice 7.1 adds the money-OUT and
corrections half of the ledger plus reporting, WITHOUT ever mutating a captured
fact:

1. **Scholarships / concessions** — a concession definition + a CREDIT ledger
   entry that reduces outstanding via credit allocations against charges.
   Staff-posted (`fees.concession.manage`), approver audited.
2. **Refunds** — partial or full, modeled as an append-only `Refund` record +
   reversing credit, integrated with the Razorpay refund API, idempotent by
   construction, webhook-reconciled (`refund.processed`/`refund.failed`).
   `fees.refund` permission + MFA step-up.
3. **Adjustments** — waivers / write-offs / corrections as append-only adjusting
   ledger entries with reason + approver. `fees.adjust` permission + MFA step-up.
4. **Financial reports** — read-only JSON (`fees.view`) for collection summary,
   outstanding/aging, reconciliation status, per-program / per-session rollups,
   plus `.xlsx` export mirroring the existing `admin.ts` ExcelJS pattern.

The unifying invariant: **a charge's effective state is recomputed from the
ledger** (charges + payment allocations + concession credits + refund reversals
+ adjustments), never destructively edited. All money is integer paise (BigInt
in-process, decimal STRING on every JSON boundary); the only BigInt→Number
coercion stays at the Razorpay SDK boundary.

### Locked technology stack (frozen once this design is approved)

- **Runtime/API:** TypeScript, Fastify, Node `node:crypto` for all HMAC.
- **DB:** PostgreSQL (shared Supabase), Prisma Client via `withTenant` /
  `privilegedPrisma`; hand-authored raw-SQL migration (RLS, triggers, grants).
- **Payments:** `razorpay` SDK (pinned, already in deps) for order + refund +
  reconciliation reads; HMAC verify via `node:crypto`, never the SDK validator.
- **MFA step-up:** existing `requireStepUp(actionClass)` middleware +
  `POST /api/auth/mfa/verify` (mints an action-bound step-up JWT). No new
  mechanism. **Enrolment precondition (MEDIUM-4):** `/api/auth/mfa/verify` returns
  400 `{error:"MFA not enrolled"}` unless `user.mfaEnabled`, and mandatory MFA is
  enforced ONLY for `platform.*` accounts (`requirePlatformMfa`), never for
  tenant ACCOUNTANT/ADMIN. Chosen resolution (option a): a refund/adjust approver
  must SELF-ENROL once via the existing `/api/auth/mfa/enroll/start` +
  `/enroll/verify` (already available to any authenticated user) before they can
  mint a `fees.refund`/`fees.adjust` step-up token. We do NOT add a new
  mandatory-MFA gate for tenant staff in this slice (that is a broader auth-policy
  change beyond a money slice; option b is noted as a future option). The
  un-enrolled-approver error path is defined in §E.10 and tested in §E.13.
- **Excel:** `exceljs` (already a dep; used in `apps/api/src/routes/admin.ts`).
- **Validation:** `zod` schemas in `@campusgate/shared`; `PaiseAmount` for every
  money input.
- **Catalogue:** `packages/shared` permissions / role-permissions / audit-action
  lists are the single source of truth, asserted by `catalogue-sync`.

---

## 2. Functional Requirements

**Concessions**
- FR-C1 Staff with `fees.concession.manage` can create a **concession
  definition**: name, type (`FIXED` paise amount or `PERCENT` basis points),
  scope (`PER_STUDENT` or `PER_STRUCTURE`), optional program/session link,
  optional note.
- FR-C2 Staff can **post** a concession to a student against one or more of that
  student's charges, producing CREDIT ledger entries. A posted concession is an
  append-only fact; its credits reduce the charges' outstanding.
- FR-C3 A percentage concession resolves to an integer-paise amount at post time
  against the targeted charge(s) (snapshot); the resolved amount is stored, not
  recomputed later.
- FR-C4 A concession credit against a charge can never exceed that charge's
  current outstanding (no negative outstanding, no refundable "overpay via
  concession").
- FR-C5 Posting a concession recomputes each affected charge's effective status
  from the ledger and audits `fees.concession.posted` under the approver.

**Refunds**
- FR-R1 Staff with `fees.refund` **and** a valid MFA step-up token
  (`x-step-up`, action class `fees.refund`) can issue a refund against a CAPTURED
  `payment_transactions` row.
- FR-R2 Refund amount must be `> 0` and `<= net-refundable` for that transaction
  = `captured_allocated_or_credited_to_refund_base − already-refunded`. Full
  refund is the max case. (Exact base defined in §E.4.)
- FR-R3 A refund is an append-only `Refund` record + a reversing credit that the
  ledger honors; the original capture/receipt/allocations are NEVER mutated.
- FR-R4 The Razorpay refund API is called with the captured `razorpayPaymentId`
  and a server-minted `idempotencyKey` passed as the Razorpay `receipt`; the
  returned Razorpay refund id is stored and is globally unique. Both the
  `razorpayRefundId` and the `idempotencyKey` are global idempotency keys (the
  latter is set at request time so the webhook can correlate even if it arrives
  before the SDK result is persisted).
- FR-R5 Razorpay refund webhooks (`refund.processed`, `refund.failed`,
  `refund.created`) are handled in the PUBLIC webhook with the same
  signature-gated, owner-role-resolve, idempotent-by-construction path as
  capture; they advance the local refund status, never create a second reversal.
- FR-R6 Issuing/finalizing a refund recomputes affected charge statuses: a PAID
  charge whose backing payment is (partially) refunded moves back to
  PARTIALLY_PAID or PENDING per the net.
- FR-R7 Every refund transition audits (`fees.refund.requested`,
  `fees.refund.processed`, `fees.refund.failed`) under the approver (request
  routes) or the resolved payer (webhook), mirroring slice-1 actor resolution.

**Adjustments**
- FR-A1 Staff with `fees.adjust` **and** a valid MFA step-up token (action class
  `fees.adjust`) can post an adjustment against a student's charge(s): type
  `WAIVER`, `WRITE_OFF`, or `CORRECTION`, a positive paise amount, a required
  reason, and the approver.
- FR-A2 An adjustment is an append-only ledger entry (credit); it never mutates
  the original charge amount or any captured row.
- FR-A3 A `CORRECTION` may be a DEBIT (increase outstanding) or CREDIT (decrease)
  — see §E.3 sign rule; `WAIVER`/`WRITE_OFF` are always credits bounded by the
  charge's outstanding.
- FR-A4 Posting an adjustment recomputes affected charge statuses and audits
  `fees.adjustment.posted` under the approver.

**Reports**
- FR-F1 `fees.view` holders can read a **collection summary** (captured totals,
  refunded totals, net, over a date range, grouped by day/program/session).
- FR-F2 `fees.view` holders can read an **outstanding/aging** report (per
  student and rolled up, bucketed by overdue age).
- FR-F3 `fees.view` holders can read a **reconciliation status** report (stuck
  transaction counts by age — reuses `findStuck`).
- FR-F4 `fees.view` holders can read **per-program / per-academic-session
  rollups** of billed / collected / concession / refund / outstanding.
- FR-F5 Collection and outstanding reports are downloadable as streamed `.xlsx`.
- FR-F6 All money in every report is a decimal STRING of paise (JSON) or a
  correctly-typed numeric cell carrying integer paise (Excel), never a float.

**Cross-cutting (inherited, non-negotiable)**
- FR-X1 Every new table carries `institutionId`, composite same-tenant FKs,
  `(id, institutionId)` unique, ENABLE+FORCE RLS with nullif-guarded fail-closed
  USING + WITH CHECK, and a `campass_app` grant (never BYPASSRLS).
- FR-X2 Every mutation audits a `fees.*` key in the same `withTenant` tx; deny
  branches record a DENIED audit then RETURN a 4xx (never throw).
- FR-X3 Ledger entries (credits, refunds, adjustments) are append-only
  (INSERT-only RLS + REVOKE UPDATE/DELETE + a raise-on-UPDATE/DELETE trigger).

## Non-Functional Requirements

- NFR-1 Money correctness: integer paise end-to-end; the single guarded
  BigInt→Number coercion lives only at the Razorpay SDK boundary.
- NFR-2 Tenant isolation provable by the extended tenant-escape suite for every
  new table (read / foreign-parent / spoof / buggy-query / fail-closed +
  append-only coverage).
- NFR-3 Idempotency: refund webhooks and refund creation are idempotent by DB
  construction (unique Razorpay refund id + processed-webhook-event global
  unique) AND a terminal-state no-op check.
- NFR-4 Migration workflow safety: hand-author → `prisma migrate diff` sanity →
  `prisma migrate deploy` → `prisma migrate status` clean. Never
  `prisma migrate dev`. No DROP on existing tables; frozen dirs untouched.
- NFR-5 Each new live-DB suite passes in ISOLATION (Supabase free-tier pooler
  flakes on combined runs — acceptance bar is isolated green).

## Acceptance Criteria (testable, numbered)

1. `prisma migrate deploy` applies the new dir cleanly on a DB already at slice
   1; `prisma migrate status` reports up to date; no frozen dir changed; the
   only diff from `migrate diff` is the known composite-vs-single-FK cosmetic
   diff — zero DROP on an existing table.
2. `catalogue-sync` is green with `fees.concession.manage` added (bound to
   ACCOUNTANT + ADMIN) and `fees.refund` / `fees.adjust` now bound (ACCOUNTANT +
   ADMIN); the new migration dir is in `SEEDING_MIGRATION_DIRS` and its seeded
   permission keys + role-permission pairs set-equal the shared catalogue.
3. All new audit-action keys exist in `@campusgate/shared` `AUDIT_ACTIONS`;
   `recordAuditEvent` accepts them; `npm test -w @campusgate/api` is fully green.
4. A concession credit reduces the targeted charge's outstanding by exactly the
   resolved paise and moves its status per the ledger; a credit exceeding
   outstanding is rejected (409); the original charge row is byte-for-byte
   unchanged (column-guard proves it).
5. A partial refund on a CAPTURED transaction creates a `Refund` (status
   `REQUESTED`→`PROCESSED`) + a reversing credit; the capture, its receipt, and
   its allocations are unchanged; the affected charge moves PAID→PARTIALLY_PAID;
   `net-refundable` decreases by the refunded amount.
6. A refund exceeding `net-refundable` is rejected (409) before any Razorpay
   call; TWO concurrent partial refunds that individually fit but together exceed
   the capture cannot both succeed — the `fees_refund:<txnId>` advisory lock
   serializes them and the second is 409 (HIGH-3); a refund without a valid
   `x-step-up` token for action `fees.refund` is 401 (including an un-enrolled
   approver, MEDIUM-4); without `fees.refund` permission is 403.
7. A `refund.processed` webhook correlates the local refund by `razorpayRefundId`
   then by `receipt=idempotencyKey` (HIGH-2) — resolving the tenant by
   `payment_id` even though the event carries no `order_id` (HIGH-1) — and flips
   it to PROCESSED exactly once; a webhook that arrives before the request route
   persisted `razorpayRefundId` still settles via the `idempotencyKey`; a webhook
   with no local match returns a retryable 500; a duplicate `x-razorpay-event-id`
   is a 200 `{status:"duplicate"}` no-op; the reversing credit is not
   double-inserted.
8. A `refund.failed` webhook flips the refund to FAILED; because the chosen §E.4
   model writes NO `RefundReversal` rows until PROCESSED, there is nothing to
   undo — no reversal is written, the affected charge's status is UNCHANGED, and
   `net-refundable` increases by the released amount (the FAILED row drops out of
   the `IN (REQUESTED,PROCESSED)` reservation set). (Consistent with §E.4; this
   AC must NOT be read as "reverse a reversing credit".)
9. A `WAIVER` adjustment with a reason reduces outstanding and recomputes status;
   missing reason is 400; missing/invalid step-up for `fees.adjust` is 401;
   missing `fees.adjust` permission is 403.
10. The collection-summary, outstanding/aging, reconciliation, and rollup JSON
    endpoints return `fees.view`-gated data with all money as STRING; a non-view
    role is 403.
11. `GET .../reports/collection/export.xlsx` and `.../reports/outstanding/export.xlsx`
    stream a valid workbook with the correct content-type + `Content-Disposition`.
12. The tenant-escape suite covers every new table (concession defs, concession
    credits, refunds, adjustments) with read/spoof/foreign-parent/buggy-query/
    fail-closed, and append-only UPDATE/DELETE denial for the INSERT-only ones;
    it passes in isolation.
13. `fees-behavioral.integration.test.ts` (extended) proves end-to-end:
    concession→status, refund→status + Razorpay refund stub + webhook idempotency,
    adjustment→status, all in isolation.

## Out of Scope (slice 7.1)

- Any frontend / checkout UI.
- Payment-gateway providers other than Razorpay.
- Multi-currency (locked to INR).
- Refund-to-source-vs-wallet routing, instant-refund speed selection beyond
  passing `speed: "normal"`.
- Receipt PDF generation; credit notes as formatted documents (reports are JSON
  + Excel only).
- Automatic/scheduled report emailing.
- Editing or deleting a concession/refund/adjustment after posting (reverse by a
  new opposing entry if a future slice needs it).

---

## 3. Design overview (§D.0)

The slice-1 ledger has exactly one money-IN primitive: a `payment_allocation`
(positive paise) consuming a charge's outstanding. Slice 7.1 generalizes the
ledger to a single additive truth where outstanding is computed from **four**
credit/debit streams against a charge:

```
charge.outstanding =
    charge.amountPaise
  − Σ payment_allocations.amountPaise            (slice 1, money in)
  − Σ concession_credits.amountPaise             (7.1, scholarship)
  − Σ adjustments(credit).amountPaise            (7.1, waiver/write-off/correction−)
  + Σ adjustments(debit).amountPaise             (7.1, correction+)
  + Σ refund_reversals.amountPaise               (7.1, money out → restores outstanding)
    , floored at 0, capped at amountPaise
```

This is implemented as ONE function (`computeChargeLedger`, §E.5) that both the
read path (ledger / reports) and the write path (status recompute after any
posting) call — no divergent math. The slice-1 `chargeOutstanding` /
`computeOutstanding` / `planAllocation` / `nextChargeStatus` helpers stay and
are composed into it (not forked). The new reversing/credit rows are modeled so
they key on `studentChargeId`, letting the existing per-charge aggregation
absorb them with a `signedAmount` convention.

Two new `StudentChargeStatus` enum values are added ADDITIVELY so the ledger can
express corrections without breaking slice-1's forward-only trigger: we do NOT
need them for concessions/refunds (those recompute into the existing
PENDING/PARTIALLY_PAID/PAID) — but we DO need to relax the `student_charges`
column-guard's forward-only status rule, because a refund legitimately moves a
charge PAID→PARTIALLY_PAID (backward). See §E.1 for the chosen, carefully-scoped
trigger change. This is the single most delicate change in the slice and is
called out explicitly.

---

## §E.1 — Schema changes (additive) and the slice-1 trigger relaxation

### New enums (migration section a)

```sql
CREATE TYPE "ConcessionType"   AS ENUM ('FIXED', 'PERCENT');
CREATE TYPE "ConcessionScope"  AS ENUM ('PER_STUDENT', 'PER_STRUCTURE');
CREATE TYPE "RefundStatus"     AS ENUM ('REQUESTED', 'PROCESSED', 'FAILED');
CREATE TYPE "AdjustmentType"   AS ENUM ('WAIVER', 'WRITE_OFF', 'CORRECTION');
CREATE TYPE "LedgerEntryKind"  AS ENUM ('CONCESSION', 'ADJUSTMENT', 'REFUND_REVERSAL');
```

No change to `StudentChargeStatus`. Decision: refunds move a charge **backward**
along the EXISTING three states; we do not introduce `REFUNDED`/`WAIVED` as
statuses, because status is a derived projection of outstanding (0 = PAID, 0 <
out < amount = PARTIALLY_PAID, out = amount = PENDING). Adding REFUNDED/WAIVED
would create two sources of truth (status vs ledger). Instead the ledger carries
the *reason*; status stays the pure outstanding projection. This keeps one
source of truth (the brief's explicit requirement) and is why §E.1's trigger
change is the minimal necessary edit.

### New models (Prisma `schema.prisma`, mapped to snake_case tables)

**`ConcessionDefinition` → `concession_definitions`** (mutable; standard RLS
pair; column-guard NOT needed — definitions can be edited before posting, like
`fee_structures`).

| column | type | notes |
|---|---|---|
| id | String @id cuid | |
| institutionId | String | tenant root |
| name | String | CHECK char_length ≥ 1 |
| type | ConcessionType | |
| amountPaise | BigInt? | required when type=FIXED; CHECK (type='FIXED') = (amountPaise IS NOT NULL AND amountPaise > 0) |
| percentBps | Int? | basis points; required when type=PERCENT; CHECK 1..10000 |
| scope | ConcessionScope | |
| programId | String? | composite FK (institutionId, programId) → programs |
| academicSessionId | String? | composite FK → academic_sessions |
| note | String? | |
| status | FeeStructureStatus | reuse DRAFT/ACTIVE/ARCHIVED (no new enum) |
| createdAt/updatedAt | | updatedAt present (mutable) |

Indexes: `@@unique([id, institutionId])`, `@@unique([institutionId, name])`,
`@@index([institutionId])`.

**`StudentConcession` → `student_concessions`** (INSERT-only append-only ledger
header; posted fact). One per posting action; it owns one or more
`concession_credits`.

| column | type | notes |
|---|---|---|
| id | String @id cuid | |
| institutionId | String | |
| concessionDefinitionId | String | composite FK → concession_definitions |
| studentId | String | composite FK → student_profiles (NOT a User id) |
| totalPaise | BigInt | Σ of its credits; CHECK > 0 |
| approvedByUserId | String | recorded actor id (no FK, slice-1 precedent) |
| note | String? | |
| postedAt/createdAt | | NO updatedAt (append-only) |

**`ConcessionCredit` → `concession_credits`** (INSERT-only; the per-charge credit
line the ledger consumes).

| column | type | notes |
|---|---|---|
| id | String @id cuid | |
| institutionId | String | |
| studentConcessionId | String | composite FK → student_concessions |
| studentChargeId | String | composite FK → student_charges |
| amountPaise | BigInt | CHECK > 0 |
| currency | String default 'INR' | CHECK = 'INR' |
| createdAt | | NO updatedAt |

**`Refund` → `refunds`** (snapshot/fact with a column-guard, exactly like
`payment_transactions`: the money/identity columns freeze, status is
forward-only, DELETE always raises).

| column | type | notes |
|---|---|---|
| id | String @id cuid | |
| institutionId | String | |
| paymentTransactionId | String | composite FK → payment_transactions |
| studentId | String | composite FK → student_profiles |
| amountPaise | BigInt | CHECK > 0 |
| currency | String default 'INR' | CHECK = 'INR' |
| status | RefundStatus default 'REQUESTED' | forward-only REQUESTED→PROCESSED/FAILED |
| reason | String | CHECK char_length ≥ 1 |
| razorpayRefundId | String? | set once; GLOBAL unique WHERE NOT NULL (hard idempotency key) |
| idempotencyKey | String | server-minted at request time; GLOBAL unique; passed to Razorpay as `receipt`; the webhook-vs-request correlation key (HIGH-2) |
| approvedByUserId | String | recorded actor id |
| requestedAt | DateTime default now | |
| settledAt | DateTime? | set when PROCESSED/FAILED |
| unreversiblePaise | BigInt default 0 | MEDIUM-3: refunded paise that could not be restored to a charge (concession-zeroed); set once at settle; CHECK ≥ 0. Frozen by the guard after PROCESSED. |
| createdAt/updatedAt | | updatedAt present (status moves) |

Uniques (NIT-1 — the global `razorpayRefundId` unique already implies tenant
uniqueness, so NO partial `(institutionId, razorpayRefundId)` composite is
declared; both would be redundant):
- `@@unique([id, institutionId])` (composite-FK target).
- GLOBAL `@@unique([razorpayRefundId])` — the hard idempotency key for a settled
  Razorpay refund, mirroring `processed_webhook_events.razorpayEventId`. Because
  Prisma cannot express a partial unique over a nullable column cleanly, this is
  authored in raw SQL as `CREATE UNIQUE INDEX refunds_razorpay_refund_id_unique
  ON refunds(razorpayRefundId) WHERE razorpayRefundId IS NOT NULL` (a global
  partial unique; NULLs — the REQUESTED-but-not-yet-settled rows — are exempt).
- GLOBAL `@@unique([idempotencyKey])` — the request-time correlation key
  (HIGH-2). `idempotencyKey` is NOT NULL and set in the SAME tx that inserts the
  REQUESTED row, BEFORE any Razorpay call, so the webhook always has a stable key
  to correlate on even if it arrives before `razorpayRefundId` is persisted.
- Indexes: `(institutionId)`, `(institutionId, paymentTransactionId)`,
  `(institutionId, status)`.

**`RefundReversal` → `refund_reversals`** (INSERT-only; the per-charge reversing
credit the ledger consumes to restore outstanding when a refund settles).

| column | type | notes |
|---|---|---|
| id | String @id cuid | |
| institutionId | String | |
| refundId | String | composite FK → refunds |
| studentChargeId | String | composite FK → student_charges |
| amountPaise | BigInt | CHECK > 0 (positive; it ADDS back to outstanding) |
| currency | String default 'INR' | CHECK = 'INR' |
| createdAt | | NO updatedAt |

**`Adjustment` → `adjustments`** (INSERT-only append-only ledger entry).

| column | type | notes |
|---|---|---|
| id | String @id cuid | |
| institutionId | String | |
| studentId | String | composite FK → student_profiles |
| studentChargeId | String | composite FK → student_charges |
| type | AdjustmentType | |
| direction | String | 'CREDIT' or 'DEBIT'; CHECK IN ('CREDIT','DEBIT'); WAIVER/WRITE_OFF forced CREDIT by app + CHECK (type='CORRECTION' OR direction='CREDIT') |
| amountPaise | BigInt | CHECK > 0 (magnitude; sign carried by direction) |
| currency | String default 'INR' | CHECK = 'INR' |
| reason | String | CHECK char_length ≥ 1 |
| approvedByUserId | String | recorded actor id |
| postedAt/createdAt | | NO updatedAt |

All six new tables: `institutionId → institutions(id) RESTRICT`, composite
same-tenant FKs carrying `institutionId`, `(id, institutionId)` unique,
`(institutionId)` index, ENABLE+FORCE RLS.

### The slice-1 `student_charges_guard` trigger relaxation (§E.1 — critical)

Slice 1's `student_charges_guard` enforces **forward-only** status:
`PENDING→{PARTIALLY_PAID,PAID}`, `PARTIALLY_PAID→PAID`, or no-op. A refund
legitimately needs `PAID→PARTIALLY_PAID` or `PAID→PENDING`, and an adjustment
reversal (future) similarly. We must relax this WITHOUT weakening the immutable
snapshot-column freeze.

Decision — **replace the forward-only clause with a ledger-consistency clause**,
keeping every immutable-column check byte-identical. The new guard still raises
on DELETE and on any snapshot-column change; it simply ALLOWS any status among
the three valid values (the application is the authority that always writes the
recomputed status, and the status is a pure projection of append-only ledger
rows that are themselves immutable). Rationale: the forward-only rule was a
slice-1 safety net when only money-IN existed; in 7.1 backward moves are
correct, and the real protection (money columns can't change, ledger rows can't
be mutated/deleted) is unchanged. We considered keeping forward-only and adding
REFUNDED/WAIVED terminal states, but that duplicates the source of truth (status
vs outstanding) and still can't express "PAID→PARTIALLY_PAID after partial
refund". We considered a separate `student_charges_status` side table, but that
splits the charge's identity. The relaxation is the smallest correct change.

This edit is made in the NEW migration via
`CREATE OR REPLACE FUNCTION "student_charges_guard"()` (same name — Postgres
replaces the body; the trigger binding is untouched). The frozen slice-1
migration file is NOT edited. The new body (verbatim target):

```sql
CREATE OR REPLACE FUNCTION "student_charges_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student_charges is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable snapshot columns: posted facts never change (UNCHANGED from slice 1)
  IF NEW."amountPaise"     IS DISTINCT FROM OLD."amountPaise"
  OR NEW."currency"        IS DISTINCT FROM OLD."currency"
  OR NEW."category"        IS DISTINCT FROM OLD."category"
  OR NEW."dueDate"         IS DISTINCT FROM OLD."dueDate"
  OR NEW."description"     IS DISTINCT FROM OLD."description"
  OR NEW."studentId"       IS DISTINCT FROM OLD."studentId"
  OR NEW."institutionId"   IS DISTINCT FROM OLD."institutionId"
  OR NEW."feeStructureId"  IS DISTINCT FROM OLD."feeStructureId"
  OR NEW."feeComponentId"  IS DISTINCT FROM OLD."feeComponentId"
  OR NEW."postedAt"        IS DISTINCT FROM OLD."postedAt"
  OR NEW."postedByUserId"  IS DISTINCT FROM OLD."postedByUserId"
  THEN
    RAISE EXCEPTION 'immutable student_charges snapshot column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- 7.1: status is a pure projection of the append-only ledger; any of the three
  -- valid states is reachable (money-out moves it backward). The forward-only
  -- clause from slice 1 is intentionally removed; snapshot immutability (above)
  -- and ledger-row immutability (append-only triggers) are the real guards.
  IF NEW."status" NOT IN ('PENDING','PARTIALLY_PAID','PAID') THEN
    RAISE EXCEPTION 'invalid student_charges status %', NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
```

`payment_transactions_guard` is UNCHANGED (captured money stays terminal-frozen;
refunds live in their own table, never by mutating the capture).

**Existing tests that assert the OLD forward-only rule (MEDIUM-2 — enumerated,
not assumed).** I grepped the suites. Exactly TWO places encode the slice-1
forward-only charge-status behavior, and both must change in lockstep with this
relaxation:

1. `apps/api/src/routes/__tests__/fees-behavioral.integration.test.ts` (live-DB)
   — the column-guard block asserts a DB-level rejection:
   ```ts
   // Column guard: a PAID charge cannot move backwards to PENDING.
   await expect(
     adminClient.studentCharge.update({ where: { id: chargeId }, data: { status: "PENDING" } }),
   ).rejects.toBeTruthy();
   ```
   This WILL flip from pass to fail once the guard allows backward moves. It MUST
   be updated: replace this single assertion with proof that (a) the IMMUTABLE
   snapshot columns still reject mutation (keep the `amountPaise`-change and
   DELETE assertions unchanged — those are the real guard and stay), and (b) a
   bare status move among the three valid states is now ALLOWED only when the app
   writes it (the test may assert a direct `status:'PENDING'` write now SUCCEEDS,
   documenting the intended 7.1 rule). The surrounding snapshot-immutability and
   DELETE-denied assertions are untouched.

2. `apps/api/src/services/fees/__tests__/fees-unit.test.ts` (fast) — the
   `describe("charge-status transition logic (forward-only)")` block exercises a
   PURE in-test mirror `isLegalChargeTransition` (it does NOT hit the DB). Since
   it tests a local helper, it does not break the build, but leaving it asserts a
   rule the DB no longer enforces. Decision: rename the block to
   `"charge-status transition logic (slice-1 historical / superseded by 7.1
   ledger projection)"` and keep it as a documented record of the slice-1 rule,
   OR delete it. Chosen: KEEP, renamed, with a comment pointing at §E.1 — the
   mirror still documents why slice-1 chose forward-only and why 7.1 supersedes
   it. No other test in the repo asserts the forward-only charge transition
   (grep: only these two + the capture-side `payment_transactions` reverse-move
   assertion, which is UNCHANGED because `payment_transactions_guard` is not
   relaxed).

---

## §E.2 — New migration directory + lettered a–j SQL plan

**Dir name:** `packages/db/prisma/migrations/20261129000000_phase7_fees_slice2/`
(next sensible timestamp after `20261122000000`; `_slice2` chosen over `_slice71`
for consistency with the existing `_slice1` suffix). **NIT-3 — name-consistency
lock:** the IDENTICAL string `20261129000000_phase7_fees_slice2` MUST appear in
every place that references the dir — `SEEDING_MIGRATION_DIRS` in
`catalogue-sync.test.ts`, any module-system test that enumerates fees migration
dirs, and (if a new standalone live suite is ever added) `LIVE_DB_SUITES`. Do NOT
"correct" it to `_slice71` in one place and `_slice2` in another; the task is
called "SLICE 7.1" but the on-disk dir name is deliberately `_slice2` and that
exact string is authoritative everywhere. Single `migration.sql`, hand-authored,
mirroring the slice-1 a–j structure:

- **a. Enums** — the five `CREATE TYPE` above.
- **b. Tables + PKs** — the six new tables. `concession_definitions` and
  `refunds` carry `updatedAt NOT NULL`; the four INSERT-only tables
  (`student_concessions`, `concession_credits`, `refund_reversals`,
  `adjustments`) have NO `updatedAt`. Money BIGINT; `currency` text default 'INR'.
  `refunds` additionally carries `idempotencyKey TEXT NOT NULL` (HIGH-2,
  request-time correlation key) and `unreversiblePaise BIGINT NOT NULL DEFAULT 0`
  (MEDIUM-3).
- **c. Indexes** — `(id, institutionId)` uniques; `concession_definitions`
  `(institutionId, name)` unique; **(NIT-1) the refund idempotency uniques are
  BOTH global partials, no `(institutionId, …)` composite:**
  `refunds_razorpay_refund_id_unique ON refunds(razorpayRefundId) WHERE razorpayRefundId IS NOT NULL`
  (settled-refund idempotency) and
  `refunds_idempotency_key_key ON refunds(idempotencyKey)` (request-time
  correlation key, NOT NULL so a plain unique index);
  `(institutionId)` + query indexes `(institutionId, studentChargeId)`,
  `(institutionId, paymentTransactionId)`, `(institutionId, status)` as applicable.
- **d. Tenant-root FKs** — `institutionId → institutions(id) ON DELETE RESTRICT
  ON UPDATE CASCADE` on all six.
- **e. Composite same-tenant FKs** (each carries `institutionId`):
  `concession_definitions`→programs/academic_sessions (nullable);
  `student_concessions`→concession_definitions + student_profiles;
  `concession_credits`→student_concessions + student_charges;
  `refunds`→payment_transactions + student_profiles;
  `refund_reversals`→refunds + student_charges;
  `adjustments`→student_profiles + student_charges.
  (`approvedByUserId` is a recorded actor id, no FK — slice-1 precedent.)
- **f. CHECKs** — `amountPaise > 0` / `currency = 'INR'` everywhere money/currency
  appears; `char_length(name/reason) ≥ 1`; `percentBps BETWEEN 1 AND 10000`;
  the FIXED/PERCENT exclusivity CHECK; the adjustment direction CHECK;
  `refunds.unreversiblePaise >= 0` (MEDIUM-3).
- **g. RLS** — ENABLE+FORCE on all six. `concession_definitions` and `refunds`
  get the standard `{tenant_isolation_select, tenant_isolation_modify}` pair (the
  `refunds` column-guard enforces immutability at row level, so it still carries
  a modify policy — same rationale as `payment_transactions`). The four
  INSERT-only tables get the append-only pair
  `{tenant_isolation_select, <table>_tenant_insert}` with NO modify policy. All
  `nullif(current_setting('app.current_institution_id', true), '')` fail-closed.
- **h. Triggers** —
  - `<table>_append_only()` unconditional-raise + `BEFORE UPDATE OR DELETE` on
    the four INSERT-only tables (verbatim shape from slice-1 `receipts`).
  - `refunds_guard()` column-guard + `BEFORE UPDATE OR DELETE` on `refunds`
    (freezes `amountPaise`, `currency`, `paymentTransactionId`, `studentId`,
    `institutionId`, `reason`, `idempotencyKey`; once `razorpayRefundId` is set it
    can't change — but a NULL→value transition IS allowed, since both the request
    route and the webhook may be the one to first stamp it (HIGH-2) — use the
    slice-1 `payment_transactions_guard` razorpayPaymentId idiom:
    `OLD.razorpayRefundId IS NOT NULL AND NEW.razorpayRefundId IS DISTINCT FROM OLD.razorpayRefundId` raises;
    `unreversiblePaise` is writable only on the REQUESTED→PROCESSED move then
    frozen; forward-only `REQUESTED→{PROCESSED,FAILED}`, terminal frozen; raise on
    DELETE — copied from `payment_transactions_guard` shape).
  - `CREATE OR REPLACE FUNCTION "student_charges_guard"()` with the §E.1 relaxed
    body (replaces the function body only; the slice-1 trigger binding stays).
- **i. `campass_app` GRANT refresh** (guarded `IF EXISTS pg_roles`): full DML on
  `concession_definitions` + `refunds`; `SELECT, INSERT` + `REVOKE UPDATE, DELETE`
  on `student_concessions`, `concession_credits`, `refund_reversals`,
  `adjustments`. Never BYPASSRLS.
- **j. Catalogue seed** — INSERT `fees.concession.manage` permission; bind
  `fees.concession.manage`, `fees.refund`, `fees.adjust` to ACCOUNTANT and ADMIN
  via the same `role_permissions` SELECT-join + `ON CONFLICT DO NOTHING` block
  shape the slice-1 §j used (so `catalogue-sync` parses it). `fees.refund` /
  `fees.adjust` permission rows already exist (slice-1 forward-declared) — do NOT
  re-INSERT; only add their `role_permissions` pairs.

  **NEW-3 — the `INSERT INTO "permissions"` span must physically exist in this
  migration (not just the role-pair block).** `catalogue-sync.test.ts`
  `extractPermissionKeys` slices each seeding migration between the literal
  `INSERT INTO "permissions"` and the following `ON CONFLICT`, reads the 2nd
  quoted literal of every `(...)` VALUES tuple, and set-equals the UNION across
  all `SEEDING_MIGRATION_DIRS` against `PERMISSION_KEYS`. Because slice-2 adds
  exactly ONE new permission, this migration MUST contain a real, parseable
  permissions span that contributes that one key, e.g.:

  ```sql
  INSERT INTO "permissions" ("id", "key", "module", "description")
  VALUES ('perm_fees_concession_manage', 'fees.concession.manage', 'fees',
          'Create concession definitions + post concessions/scholarships')
  ON CONFLICT ("key") DO NOTHING;
  ```

  If `fees.concession.manage` is added to `permissions.ts` `PERMISSION_KEYS` but
  this `INSERT INTO "permissions"` span is omitted (or vice-versa), the
  set-equality test FAILS. Conversely the `fees.refund` / `fees.adjust`
  permission ROWS are NOT re-inserted here (they were seeded in slice-1 §j and
  already appear in some seeding migration's `permissions` span — re-inserting is
  unnecessary and the `extractPermissionKeys` union is a SET, so a second
  contribution is harmless but omitted for cleanliness); only their
  `role_permissions` pairs are added. The `role_permissions` block is authored in
  the exact `INSERT INTO "role_permissions" (...) SELECT ... FROM (VALUES
  ('ACCOUNTANT','fees.concession.manage'), ('ADMIN','fees.concession.manage'),
  ('ACCOUNTANT','fees.refund'), ('ADMIN','fees.refund'),
  ('ACCOUNTANT','fees.adjust'), ('ADMIN','fees.adjust')) AS m(role_key, perm_key)
  ... ON CONFLICT DO NOTHING;` shape that `extractRolePermissionPairs` (slice
  between `INSERT INTO "role_permissions"` and `AS m(`) parses, so these six
  pairs join the `ROLE_PERMISSIONS` union.

**Workflow (NFR-4):** author the dir → `prisma migrate diff
--from-schema-datasource` for sanity (expect only the known composite-vs-single-FK
cosmetic diff, no DROP) → `prisma migrate deploy` → `prisma migrate status` clean.
Never `prisma migrate dev`. Frozen dirs untouched.

---

## §E.3 — Sign / bound rules (invariant ownership)

- **Concession credit:** always positive, reduces outstanding. Bound: the sum of
  concession credits + existing allocations + other credits against a charge may
  not exceed `charge.amountPaise` (no negative outstanding). Enforcement layer:
  **service** (`postConcession`) computes the per-charge cap from
  `computeChargeLedger`; the DB CHECK only guarantees `> 0`. The service owns the
  cap because it needs the current ledger aggregate, which a row-level CHECK
  can't see.
- **Adjustment:** `WAIVER`/`WRITE_OFF` = CREDIT bounded by outstanding (service).
  `CORRECTION` CREDIT bounded by outstanding; `CORRECTION` DEBIT bounded so that
  `outstanding + debit ≤ charge.amountPaise` is NOT required (a correction may
  legitimately raise the owed amount above the original snapshot? **No** — the
  charge amount is the snapshot ceiling; a DEBIT correction is capped so
  outstanding never exceeds `amountPaise`). Enforcement: **service**. See Open
  Question OQ-2 on whether DEBIT corrections above the snapshot are ever needed.
- **Refund reversal (MEDIUM-3):** positive, ADDS back to outstanding. Each
  per-charge reversal is bounded by
  `min(originalAllocationToCharge, currentOutstandingHeadroom)` where
  `currentOutstandingHeadroom = charge.amountPaise − computeChargeOutstanding(charge)`
  (the room still available to restore AFTER any concession/adjustment credit
  that landed on the same charge between capture and refund). Any paise the
  refund could not restore because the charge was concurrently
  concession-/waiver-zeroed is NOT silently dropped: the leftover is accumulated
  into `Refund.unreversiblePaise` (a new column, see below) for audit, so cash-out
  always reconciles against ledger-restored even when they legitimately differ.
  Enforcement: **service** (`settleRefund`), derived from the transaction's
  `payment_allocations` AND the live per-charge ledger via `computeChargeLedger`.
- **Refund amount vs net-refundable:** see §E.4. Enforcement: **service** under a
  per-transaction advisory lock (HIGH-3), before any Razorpay call.

---

## §E.4 — Refund money model (the delicate one)

**Base definition (FR-R2).** For a CAPTURED `payment_transactions` row T:
`net-refundable(T) = T.amountPaise − Σ refunds(T where status IN (REQUESTED,PROCESSED)).amountPaise`.
A REQUESTED refund reserves against the base (so two concurrent partial refunds
can't exceed the capture); a FAILED refund releases it (it drops out of the
`IN (REQUESTED,PROCESSED)` set, so the released amount re-enters net-refundable
automatically — no row is mutated to "unreserve"). This is the full captured
amount, not the allocated amount, because slice-1 issues the receipt for the full
capture and overpayment may sit unallocated — a refund can return the unallocated
remainder too.

**Concurrency / reservation serialization (HIGH-3 — the fix).** `net-refundable`
is a BigInt aggregate no row-level CHECK can see, so two concurrent REQUESTED
refunds could each read the same base and each pass while summing above the
capture. The `razorpayRefundId`/`idempotencyKey` uniques do NOT prevent this
(they only stop double-*settling the same* refund, not two distinct over-large
REQUESTED rows). Fix: the refund-request tx takes a **per-transaction advisory
lock** BEFORE it computes `net-refundable` and inserts the REQUESTED row,
mirroring the slice-1 receipt-sequence lock verbatim
(`confirmation.ts` uses `pg_advisory_xact_lock(hashtextextended('fees_receipt:'||institutionId, 0))`):

```sql
SELECT pg_advisory_xact_lock(hashtextextended('fees_refund:' || $paymentTransactionId, 0));
```

Held for the duration of the request tx, it serializes the read-modify-write so
the second concurrent request blocks until the first's REQUESTED row is visible,
then recomputes a correct (smaller) net-refundable and rejects if it now exceeds.
The lock key is scoped to the transaction id (not the institution) so refunds on
different payments never contend.

**Webhook-vs-request correlation (HIGH-2 — the fix).** The webhook can arrive
BEFORE the request route persists `razorpayRefundId` (it is only known after the
SDK call returns). So `razorpayRefundId` cannot be the sole correlation key, and
a `(paymentTransactionId, amount)` fallback is unsafe — two partial refunds of
equal amount against the same transaction are indistinguishable. Fix: a
server-minted `idempotencyKey` (cuid) is written on the `Refund` row in the SAME
tx that inserts REQUESTED, BEFORE any Razorpay call, and passed to Razorpay as the
refund `receipt` field (the SDK's `RazorpayRefundCreateRequestBody.receipt?:
string|null` is verified present, and the refund webhook entity echoes `receipt`
because `RazorpayRefund extends RazorpayRefundBaseRequestBody`). Correlation order
in the webhook (§E.8):
  1. `refunds WHERE razorpayRefundId = refundEntity.id` (exact, once persisted);
  2. else `refunds WHERE idempotencyKey = refundEntity.receipt` (always available —
     set at request time) → persist `razorpayRefundId = refundEntity.id` on that
     row in the same tx (first-wins; the global `razorpayRefundId` unique makes a
     concurrent double-link impossible);
  3. else (neither matches — e.g. a refund created out-of-band in the Razorpay
     dashboard with no local row) → return a **retryable 500** so Razorpay
     redelivers (bounded retries), giving the request route time to persist; a
     terminal "no local refund after retries" is logged for manual
     reconciliation, never an ambiguous amount-match. The non-unique
     `(paymentTransactionId, amount)` fallback is **removed entirely**.

**Credit lifecycle (AC-8 decision — see MEDIUM-1).** Chosen model: the
`RefundReversal` rows (which restore charge outstanding) are inserted **only when
the refund reaches PROCESSED**, NOT at REQUESTED. Rationale: outstanding should
reflect actually-returned money. At REQUESTED we create the `Refund` row
(reserving net-refundable via the advisory lock) but DO NOT restore outstanding.
On `refund.processed` we insert the reversals and recompute status
(PAID→PARTIALLY_PAID). On `refund.failed` we flip the `Refund` to FAILED and
insert NO reversals — because none were ever written there is nothing to undo, the
charge status is unchanged, and the released amount re-enters net-refundable by
dropping out of the `IN (REQUESTED,PROCESSED)` set. This is why AC-8 is worded as
"flips to FAILED, writes no reversals, status unchanged" — it must NOT say
"reverses the reversing credit", since the append-only triggers forbid
mutating/deleting any reversal row and none exist to reverse.

**Reversal distribution (MEDIUM-3).** When a refund processes, `planRefundReversal`
(§E.5, symmetric to `planAllocation`) distributes its `amountPaise` across the
charges the ORIGINAL transaction's `payment_allocations` touched,
newest-allocation-first. Each per-charge reversal is clamped to
`min(originalAllocationToThatCharge, currentOutstandingHeadroom)` where headroom =
`charge.amountPaise − computeChargeOutstanding(chargeLedgerNow)` — so a charge that
was concession-/waiver-zeroed between capture and refund restores only the room
that actually exists (never pushing outstanding above the snapshot). Any refunded
paise that could not be restored (because a later credit consumed the headroom, or
it was unallocated overpayment that never reduced a charge) is summed into
`Refund.unreversiblePaise` for audit — cash-out is thereby always reconciled
against ledger-restored even when they legitimately diverge. The `+Σ
refund_reversals` term in the §3 charge-projection formula is therefore
double-guarded (per-charge clamp here AND the final `[0, amountPaise]` clamp),
guaranteeing no double-credit. A `ledger.test.ts` case covers
refund-after-concession on the same charge (§E.13).

**Razorpay call ordering (request route, §E.6).**
1. In a `withTenant` tx: take the `fees_refund:<paymentTransactionId>` advisory
   lock (HIGH-3); validate CAPTURED + step-up + permission; recompute
   `net-refundable` under the lock and reject (409) if exceeded; mint
   `idempotencyKey` (cuid); INSERT `Refund` status REQUESTED carrying
   `idempotencyKey` (HIGH-2); audit `fees.refund.requested`; COMMIT (lock
   releases on commit).
2. OUTSIDE the tx: call `gateway.refundPayment(razorpayPaymentId, amountPaise,
   { speed:'normal', receipt: idempotencyKey, notes })`.
3. On SDK success: in a new `withTenant` tx, persist `razorpayRefundId` on the
   Refund row (the global unique makes this idempotent against a webhook that
   already linked it) and — if Razorpay returned `status:'processed'`
   synchronously — drive the shared `settleRefund` routine (insert reversals,
   set `unreversiblePaise`, recompute status, audit `fees.refund.processed`). If
   Razorpay returned `status:'pending'`, leave at REQUESTED and let the webhook
   finalize. On SDK failure: flip to FAILED (released from net-refundable by the
   status set), audit `fees.refund.failed`, return 502.

This mirrors slice-1's "create order outside tenant tx; persist inside" shape and
the capture idempotency discipline.

---

## §E.5 — Ledger single source of truth (service extension)

New file `apps/api/src/services/fees/ledger.ts` (co-located with `allocation.ts`,
pure BigInt, no I/O). It composes the slice-1 helpers:

```ts
export interface LedgerInputs {
  charge: { amountPaise: bigint };
  allocations: { amountPaise: bigint }[];        // slice-1 payment_allocations
  concessionCredits: { amountPaise: bigint }[];  // 7.1
  adjustmentCredits: { amountPaise: bigint }[];  // 7.1 CREDIT
  adjustmentDebits: { amountPaise: bigint }[];   // 7.1 DEBIT
  refundReversals: { amountPaise: bigint }[];    // 7.1 (restore)
}
// outstanding = clamp(amount − allocs − concessions − adjCredits + adjDebits + reversals, 0, amount)
export function computeChargeOutstanding(i: LedgerInputs): bigint;
export function computeChargeStatus(i: LedgerInputs): StudentChargeStatusValue; // reuses nextChargeStatus + a PENDING case
export function planRefundReversal(
  refundAmount: bigint,
  allocationsNewestFirst: { studentChargeId: string; amountPaise: bigint }[],
): { reversals: { studentChargeId: string; amountPaise: bigint }[]; remainder: bigint };
```

`allocation.ts` `chargeOutstanding`/`computeOutstanding`/`nextChargeStatus`/
`planAllocation` are REUSED, not duplicated: `computeChargeOutstanding` calls the
same clamp logic; `computeChargeStatus` adds a PENDING branch (outstanding ==
amount) alongside the existing PAID/PARTIALLY_PAID mapping. `confirmation.ts`'s
`confirmCapture` is updated to compute post-capture status via
`computeChargeStatus` (so a charge that already had a concession credit lands on
the correct status after capture) — a minimal, behavior-preserving change (with a
fast unit test proving a concession+capture combination). The read path in
`fees.ts` `loadLedger` is extended to subtract concession credits + adjustments +
add refund reversals, surfacing new per-charge fields
(`concessionPaise`, `adjustmentPaise`, `refundedPaise`) all as STRING.

New service files:
- `apps/api/src/services/fees/concessions.ts` — `resolveConcessionAmount(def, charge)`
  (FIXED or percentBps → paise, integer floor), `postConcession(tx, …)` (caps per
  charge via ledger, inserts header + credits, recomputes statuses, audits).
- `apps/api/src/services/fees/refunds.ts` —
  `acquireRefundLock(tx, paymentTransactionId)` (runs the
  `pg_advisory_xact_lock(hashtextextended('fees_refund:'||paymentTransactionId, 0))`,
  HIGH-3); `computeNetRefundable(tx, txnId)` (must be called only while the lock
  is held); `correlateRefund(tx, { razorpayRefundId, receipt })` (HIGH-2 order:
  by `razorpayRefundId` then by `idempotencyKey = receipt`, stamping
  `razorpayRefundId` on a receipt-matched row); `settleRefund(tx, …)` (the shared
  idempotent processed-refund routine used by BOTH the sync success path and the
  webhook, symmetric to `confirmCapture`: runs `planRefundReversal` with the live
  per-charge headroom, inserts reversals, computes and stamps `unreversiblePaise`,
  flips Refund→PROCESSED, recomputes charge statuses, audits). `settleRefund`
  no-ops if the Refund is already PROCESSED.
- `apps/api/src/services/fees/razorpay.ts` — EXTENDED (not forked), see §E.7.
- `apps/api/src/services/fees/adjustments.ts` — `postAdjustment(tx, …)`.

---

## §E.6 — New routes

All under the existing `feesRoutes` plugin (`/api/fees`, gated module), reusing
its `authenticate` top hook, `actor()`, `money()`, `deny()`/`isDeny()`,
`withTenant` + same-tx audit, and STRING money serialization. Refund/adjust add
`requireStepUp(...)` AFTER `requirePermission(...)` (the platform.ts precedent).

Step-up action classes (bound into the minted token via
`POST /api/auth/mfa/verify { action }`): `"fees.refund"` and `"fees.adjust"`.
**Enrolment precondition (MEDIUM-4):** the approver must have `mfaEnabled` (one-
time self-enrol via `/api/auth/mfa/enroll/*`) before `/verify` will mint the
token; an un-enrolled approver who hits a refund/adjust route gets the §E.10
response. `requireStepUp(...)` runs AFTER `requirePermission(...)` (the SupportGrant
precedent), so order is: permission 403 → step-up 401 (the step-up guard cannot
tell "no token yet" from "un-enrolled"; both surface as the same 401, and the
operator's remedy is to enrol then re-verify). No API returns the raw
`mfaEnabled` flag, so the client discovers the precondition via the enrol flow.

**Concessions**
- `POST /concession-definitions` — `requirePermission("fees.concession.manage")`
  + `requireModuleActive("fees")`. Body `createConcessionDefinitionSchema`. 201.
- `PATCH /concession-definitions/:id` — same perm. Body
  `patchConcessionDefinitionSchema`.
- `GET /concession-definitions` / `GET /concession-definitions/:id` —
  `requirePermission("fees.view")`.
- `POST /students/:studentId/concessions` —
  `requirePermission("fees.concession.manage")`. Body `postConcessionSchema`
  (`concessionDefinitionId`, `allocations: [{ chargeId, amountPaise? }]` — when
  PERCENT/FIXED-from-def, amount resolved server-side; explicit amount only for
  manual split). Audits `fees.concession.posted`. 201.

**Refunds**
- `POST /payments/:paymentTransactionId/refunds` —
  `requirePermission("fees.refund")` THEN `requireStepUp("fees.refund")` +
  `requireModuleActive("fees")`. Body `createRefundSchema` (`amountPaise`
  PaiseAmount, `reason` non-empty). Executes §E.4 ordering: inside the first
  `withTenant` tx it takes the `fees_refund:<paymentTransactionId>` advisory lock
  (HIGH-3), recomputes net-refundable under the lock, mints a server-side
  `idempotencyKey` (HIGH-2), inserts the REQUESTED Refund, audits, commits; then
  calls the gateway outside the tx with `receipt: idempotencyKey`; then persists
  `razorpayRefundId` (and settles synchronously if Razorpay returned
  `processed`). `idempotencyKey` is server-minted, never from the request body.
  Returns the Refund (status, amount STRING, `razorpayRefundId` if already
  linked). The webhook may finalize a `pending` refund later.
- `GET /refunds` / `GET /payments/:id/refunds` — `requirePermission("fees.view")`.

**Adjustments**
- `POST /students/:studentId/adjustments` — `requirePermission("fees.adjust")`
  THEN `requireStepUp("fees.adjust")` + `requireModuleActive("fees")`. Body
  `createAdjustmentSchema` (`chargeId`, `type`, `direction?` (default CREDIT;
  only CORRECTION may be DEBIT), `amountPaise` PaiseAmount, `reason` non-empty).
  Audits `fees.adjustment.posted`. 201.
- `GET /adjustments` — `requirePermission("fees.view")`.

**Reports** (`requirePermission("fees.view")`)
- `GET /reports/collection?from&to&groupBy=day|program|session` — captured,
  refunded, net, counts. Money STRING.
- `GET /reports/outstanding?asOf&bucketing` — per-student + rollup, aging buckets
  (0–30 / 31–60 / 61–90 / 90+ by `dueDate`).
- `GET /reports/reconciliation?thresholdMinutes` — reuses `findStuck` counts.
- `GET /reports/rollups?dimension=program|session` — billed/collected/concession/
  refund/outstanding per dimension.
- `GET /reports/collection/export.xlsx` and `GET /reports/outstanding/export.xlsx`
  — ExcelJS, `workbook.xlsx.writeBuffer()` → `reply.header("Content-Type",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  .header("Content-Disposition", 'attachment; filename="..."').send(Buffer.from(buffer))`
  (verbatim `admin.ts` pattern). Money cells carry integer paise as a number cell
  with a note that the unit is paise; a human "₹" column is formatted STRING.
  Decision: integer-paise numeric cells (not rupee floats) keep Excel exact.

All report reads run in a single `withTenant` tx; no mutation, no audit.

---

## §E.7 — RazorpayGateway refund extension (extend, do not fork)

Add to `RazorpaySdkLike` (NIT-4 — the stub signature is pinned to be assignable
FROM the real `node_modules/razorpay/dist/types/payments.d.ts` method, verified:
`refund(paymentId: string, params: RazorpayRefundPaymentLinkAccountCreateRequestBody
| Refunds.RazorpayRefundCreateRequestBody): Promise<Refunds.RazorpayRefund>`):

```ts
// Request body — a structural subset of Refunds.RazorpayRefundCreateRequestBody
// (all fields optional there; receipt is `string | null`).
interface RazorpayRefundParams {
  amount?: number;                        // smallest unit (paise); optional in SDK
  speed?: "normal" | "optimum";
  notes?: Record<string, string | number>;
  receipt?: string | null;                // we send idempotencyKey here (HIGH-2)
}
// Response — the fields we consume off Refunds.RazorpayRefund. NOTE (NIT-4):
// the real RazorpayRefund has NO `[k]: unknown` index signature and its `amount`
// is `number | undefined`, so the mapping code MUST handle an undefined amount
// (fall back to the amount we requested). No `[k]: unknown` is declared here.
interface RazorpayRefundResult {
  id: string;
  payment_id: string;
  amount?: number;                        // optional — handle undefined
  status: "pending" | "processed" | "failed";
  receipt?: string | null;
}
payments: {
  refund(paymentId: string, params: RazorpayRefundParams): Promise<RazorpayRefundResult>;
  fetchRefund?(paymentId: string, refundId: string): Promise<RazorpayRefundResult>;
};
```

New method `RazorpayGateway.refundPayment(paymentId, amountPaise: bigint, opts)`:
guards the SINGLE BigInt→Number coercion exactly like `createOrder`
(`amountPaise <= 0n || > MAX_SAFE_INTEGER` → throw), then calls
`this.sdk.payments.refund(paymentId, { amount: Number(amountPaise), speed:
"normal", receipt: opts.receipt, notes: opts.notes })`. It maps the result,
treating a missing `result.amount` as the requested `Number(amountPaise)`
(NIT-4). The real SDK instance in the constructor already exposes `.payments`;
the fast suites inject a stub `payments.refund`. `verifyWebhookSignature` is
reused unchanged for refund webhooks (same HMAC over raw body). No existing
method changes.

---

## §E.8 — Refund webhook handling (public webhook extension)

Extend `razorpay-webhook.ts` additively. Razorpay refund events: `refund.created`,
`refund.processed`, `refund.failed`, payload at `evt.payload.refund.entity`
carrying `id`, `payment_id`, `amount` (optional per SDK, NIT-4), `status`, and
`receipt` (which echoes the `idempotencyKey` we sent). Event names/path are
unverifiable in-repo (OQ-1) — flagged.

**HIGH-1 — the exact field-extraction + tenant-resolution edit (not a prose
summary).** The CURRENT handler (verified) computes
`razorpayOrderId = paymentEntity?.order_id ?? orderEntity?.id`, then does
`if (!razorpayOrderId) return 200 {status:"ignored"}` and resolves the tenant
ONLY via `paymentTransaction.findFirst({ where: { razorpayOrderId } })`. A refund
event has NO `order_id` at `payload.refund.entity`, so it would be 200-ignored
before any refund code runs. The edit, inserted at step (b)/(c) of the existing
handler:

```ts
const eventType: string = evt?.event ?? "";
const isRefundEvent = eventType.startsWith("refund.");

const paymentEntity = evt?.payload?.payment?.entity;
const orderEntity   = evt?.payload?.order?.entity;
const refundEntity  = evt?.payload?.refund?.entity;        // refund.* events

const razorpayOrderId: string | undefined =
  paymentEntity?.order_id ?? orderEntity?.id;              // capture path (unchanged)
const razorpayPaymentId: string | undefined =
  refundEntity?.payment_id ?? paymentEntity?.id ?? undefined; // refund tenant key

// Unresolvable-attribution guard now BRANCHES by event family:
if (isRefundEvent) {
  if (!razorpayPaymentId) {
    request.log.warn({ eventType }, "razorpay webhook: refund event without payment_id");
    return reply.status(200).send({ status: "ignored", reason: "no payment id" });
  }
} else if (!razorpayOrderId) {
  return reply.status(200).send({ status: "ignored", reason: "no order id" });
}

// (b') UNCHANGED from slice 1 — the existing `!eventId` guard runs for BOTH
//      event families, immediately AFTER the branched attribution guard above
//      (same position it occupies today, right after the `!razorpayOrderId`
//      check at razorpay-webhook.ts lines 116-120). `eventId`
//      (`x-razorpay-event-id`) is the SOLE global idempotency key for the whole
//      webhook (processed_webhook_events_razorpayEventId_key / the NOT-NULL
//      `razorpayEventId` column). No event id ⇒ the processed-event row cannot
//      be keyed ⇒ we cannot de-dupe a redelivery ⇒ ignore. This guard is NOT
//      relaxed, skipped, or re-ordered for refund events; dropping it for the
//      refund branch would let a redelivered refund webhook with a missing
//      header bypass the duplicate check (a money-OUT idempotency hazard), and
//      passing `undefined` into the NOT-NULL `razorpayEventId` insert would
//      throw. It fires for capture AND refund events identically:
if (!eventId) {
  return reply.status(200).send({ status: "ignored", reason: "no event id" });
}

// Tenant resolution:
//  - capture events: by razorpayOrderId (unchanged).
//  - refund events: by razorpayPaymentId via the slice-1 partial unique
//    payment_transactions_payment_id_unique ON (institutionId, razorpayPaymentId)
//    WHERE razorpayPaymentId IS NOT NULL — a single-row owner-role lookup.
const txRow = isRefundEvent
  ? await lookupClient.paymentTransaction.findFirst({
      where: { razorpayPaymentId },
      select: { id: true, institutionId: true, status: true },
    })
  : await lookupClient.paymentTransaction.findFirst({
      where: { razorpayOrderId },
      select: { id: true, institutionId: true, status: true },
    });
if (!txRow) return reply.status(200).send({ status: "ignored", reason: "unknown" });
```

**NEW-2 — refund tenant resolution has no `institutionId` filter BY DESIGN (not
an oversight).** The refund-branch `findFirst({ where: { razorpayPaymentId } })`
on the owner-role (BYPASSRLS) lookup client carries no `institutionId` filter,
and the only index on that column is the slice-1 PER-TENANT partial unique
`payment_transactions_payment_id_unique ON (institutionId, razorpayPaymentId)
WHERE razorpayPaymentId IS NOT NULL` — so cross-tenant uniqueness of a
`razorpayPaymentId` is effective-in-practice (Razorpay payment ids are globally
unique) rather than DB-enforced. This is the IDENTICAL accepted pattern the
slice-1 capture path already uses to resolve the tenant by `razorpayOrderId`
(also only `(institutionId, razorpayOrderId)` unique, also resolved by a filterless
`findFirst` on the owner-role client): the webhook has no tenant token yet, so it
MUST resolve the tenant from the globally-unique Razorpay id before entering
`withTenant`. Refund resolution deliberately inherits that rationale; the missing
`institutionId` filter is consistent house style, not a defect.

The fail-closed role probe (`assertLookupRoleBypassesRls`), payer-actor
resolution, module-inactive 200 no-op, and the `processed_webhook_events`
event-id idempotency insert are ALL reused UNCHANGED (the global `razorpayEventId`
unique already de-dupes across capture AND refund events).

**NEW-1 — the `eventId` (`x-razorpay-event-id`) idempotency guard is unchanged
and family-agnostic (explicit).** The refund branch introduces NO new idempotency
primitive at the webhook front door: the existing `!eventId` guard (shown above
as step (b'), unchanged from `razorpay-webhook.ts` lines 116-120) runs for refund
events exactly as for capture events, immediately after the branched attribution
guard and BEFORE tenant resolution and the processed-event insert. The
processed-event insert for a refund event writes the SAME `razorpayEventId = eventId`
column (and the SAME `paymentTransactionId = txRow.id`) that the capture path
writes — there is no separate refund idempotency column at this layer. Therefore
a redelivered refund webhook carrying a duplicate `x-razorpay-event-id` hits the
`processed_webhook_events_razorpayEventId_key` 23505 and is a `{status:"duplicate"}`
200 no-op — the per-event `settleRefund`/`refund.failed` body never runs twice,
so the reversing credit is never double-inserted. This is precisely what AC-7
asserts, and the handler spec here matches it. (The Refund's own
`razorpayRefundId`/`idempotencyKey` global uniques are a SECOND, deeper
idempotency layer for the request-vs-webhook race, not a replacement for this
front-door `eventId` de-dupe.)

**Per-event handling inside the resolved `withTenant` tx** (after the
processed-event insert, which still returns `{status:"duplicate"}` on a 23505 of
`razorpayEventId`):

- `refund.processed` → correlate the local `Refund` by the HIGH-2 order:
  (1) `WHERE razorpayRefundId = refundEntity.id`; else
  (2) `WHERE idempotencyKey = refundEntity.receipt` and, if found, set
      `razorpayRefundId = refundEntity.id` on it in this tx; else
  (3) throw → the tx rolls back → **retryable 500** (Razorpay redelivers; the
      request route will have persisted by then). NO `(paymentTransactionId,
      amount)` fallback.
  If the located Refund is already PROCESSED → no-op (idempotent). Otherwise drive
  the shared `settleRefund` (insert reversals via `planRefundReversal`, set
  `unreversiblePaise`, flip Refund→PROCESSED, recompute affected charge statuses,
  audit `fees.refund.processed` under the resolved payer).
- `refund.failed` → correlate the same way; flip Refund→FAILED (released from
  net-refundable by the status set); insert NO reversals; charge status unchanged;
  audit `fees.refund.failed`.
- `refund.created` → audited `fees.webhook.received` no-op (REQUESTED already
  local; metadata carries `eventType`). NIT-2 decision: REUSE `fees.webhook.received`
  — no dedicated `fees.webhook.refund_received` key is added.
- Module-inactive / unknown / duplicate branches reuse the existing
  payer-actor-resolution + privileged-audit fallback verbatim.

Idempotency: by DB construction (processed-event global unique + the Refund's
forward-only `refunds_guard` terminal freeze + the once-only reversal insert
guarded by "already PROCESSED → no-op" + the global `razorpayRefundId`/`idempotencyKey`
uniques), exactly as capture.

---

## §E.9 — Shared contracts (packages/shared)

**`validation.ts`** — new zod schemas, every money field via `PaiseAmount`:
`createConcessionDefinitionSchema` (name, type enum, `amountPaise` PaiseAmount
optional, `percentBps` int 1..10000 optional, scope enum, program/session
optional, with a `.refine` enforcing FIXED⇔amount / PERCENT⇔percentBps),
`patchConcessionDefinitionSchema`, `postConcessionSchema`, `createRefundSchema`
(`amountPaise` PaiseAmount, `reason` 1..500), `createAdjustmentSchema` (`chargeId`,
`type` enum, `direction` enum optional, `amountPaise` PaiseAmount, `reason`), and
the report query schemas (date range, `groupBy`/`dimension`/`bucketing` enums,
coerced + bounded). New enums: `concessionTypeEnum`, `concessionScopeEnum`,
`refundStatusEnum`, `adjustmentTypeEnum`, `adjustmentDirectionEnum` mirroring the
pg enums; exported inferred types.

**`permissions.ts`** — add ONE permission:
`{ key: "fees.concession.manage", module: "fees", description: "Create concession definitions + post concessions/scholarships" }`.
`ROLE_PERMISSIONS`: append `fees.concession.manage`, `fees.refund`, `fees.adjust`
to `ACCOUNTANT` and to `ADMIN`. (`fees.refund`/`fees.adjust` permission keys
already exist; they just gain role bindings.)

**`audit-actions.ts`** — add exactly these fees keys:
`fees.concession.posted`, `fees.refund.requested`, `fees.refund.processed`,
`fees.refund.failed`, `fees.adjustment.posted`. **NIT-2 decision:** NO
`fees.webhook.refund_received` key is added — `refund.created` (and any
refund-webhook acknowledgement) REUSES the existing `fees.webhook.received`, whose
metadata already carries `eventType` to distinguish capture vs refund
acknowledgements. (Audit keys live only in the shared list; `recordAuditEvent`
validates against `AUDIT_ACTION_KEY_SET` — no Prisma `AuditAction` enum change
needed, matching the slice-1 fees precedent.)

---

## §E.10 — Error handling (concrete, per failing operation)

- **Concession post, credit > outstanding** → recoverable; DENIED audit
  `fees.concession.posted`; RETURN 409 `{error:"credit exceeds outstanding"}`;
  logged at info via the deny path.
- **Concession def FIXED without amount / PERCENT without bps** → zod 400 (schema
  `.refine`), no DB touch.
- **Refund, transaction not CAPTURED** → 409 `{error:"transaction not captured"}`;
  DENIED audit `fees.refund.requested`.
- **Refund amount > net-refundable** → 409 before any Razorpay call; DENIED audit.
- **Refund, missing/invalid step-up token** → 401 `{error:"Step-up required"}`
  from `requireStepUp` (no handler entry, no audit — mirrors platform.ts).
- **Refund/adjust by an un-enrolled approver (MEDIUM-4)** → the approver cannot
  obtain a step-up token: their call to `POST /api/auth/mfa/verify { action }`
  returns 400 `{error:"MFA not enrolled"}` (verified in `routes/mfa.ts`), so they
  never present a valid `x-step-up` and `requireStepUp` returns the same 401
  `{error:"Step-up required"}` at the refund/adjust route. Recovery: enrol once
  via `/api/auth/mfa/enroll/start` then `/enroll/verify`, then re-verify for the
  action. This is recoverable, not a server error; no fees audit is written (the
  route handler never runs). Covered by a §E.13 case.
- **Refund, missing `fees.refund` permission** → 403 from `requirePermission`.
- **Razorpay refund SDK throws / non-2xx** → recoverable; flip Refund→FAILED in a
  new tx (release reservation), audit `fees.refund.failed`, RETURN 502
  `{error:"refund gateway unavailable"}`; `request.log.error`. The REQUESTED
  Refund row is left FAILED (append-only history), never deleted.
- **Refund webhook, bad/absent HMAC** → 401, structured log, nothing written
  (verbatim slice-1 capture path; no DB audit actor exists).
- **Refund webhook, unknown payment_id / module inactive / duplicate event** →
  200 no-op (+ privileged audit or structured log fallback), exactly as capture.
- **Refund webhook, settleRefund mid-tx failure** → tx rolls back, 500 → Razorpay
  retries (idempotent).
- **Adjustment, missing reason** → zod 400. **direction=DEBIT with
  type≠CORRECTION** → 400 (schema `.refine`) AND the DB CHECK as backstop.
- **Adjustment credit > outstanding** → 409 DENIED audit `fees.adjustment.posted`.
- **Report export, zero rows** → 200 with an empty sheet (header row only), not an
  error.
- **Append-only / column-guard violation** (any attempt to mutate a ledger row) →
  Prisma throws `restrict_violation`; surfaces as 500 if it ever reaches a
  handler (it must not — the service never UPDATEs these rows); covered by the
  escape-suite append-only assertions.

## §E.11 — External-input validation rules

| input | required | type | limits | on failure |
|---|---|---|---|---|
| concession `name` | yes | string | 1..200 | 400 |
| concession `type` | yes | enum | FIXED/PERCENT | 400 |
| concession `amountPaise` | iff FIXED | PaiseAmount string | >0, ≤ MAX_SAFE_INTEGER | 400 |
| concession `percentBps` | iff PERCENT | int | 1..10000 | 400 |
| concession `scope` | yes | enum | PER_STUDENT/PER_STRUCTURE | 400 |
| post concession `allocations[].chargeId` | yes | string | 1..N owned charges | 409 if not owned |
| refund `amountPaise` | yes | PaiseAmount string | >0, ≤ net-refundable | 400 / 409 |
| refund `reason` | yes | string | 1..500 | 400 |
| `x-step-up` (refund/adjust) | yes | JWT header | action-bound, ≤5m | 401 |
| adjustment `type` | yes | enum | WAIVER/WRITE_OFF/CORRECTION | 400 |
| adjustment `direction` | no (dflt CREDIT) | enum | DEBIT only if CORRECTION | 400 |
| adjustment `amountPaise` | yes | PaiseAmount | >0, ≤ cap (service) | 400 / 409 |
| report `from`/`to`/`asOf` | no | ISO datetime | bounded range | 400 |
| report `groupBy`/`dimension` | no | enum | fixed set | 400 |

`institutionId` and the acting user come ONLY from the verified token, never
from input (slice-1 invariant). `studentId` path params are re-validated as
tenant-owned inside the tx.

## §E.12 — Invariant ownership

| invariant | owning layer | why |
|---|---|---|
| tenant isolation on every new table | DB (RLS USING/WITH CHECK) + composite FKs | defense-in-depth, provable by escape suite |
| ledger rows never mutated/deleted | DB (append-only + column-guard triggers + REVOKE) | binds even the table owner |
| money columns frozen on refunds/charges | DB (`refunds_guard`, `student_charges_guard`) | row-level, not grant-level |
| outstanding ≥ 0 and ≤ amount | service (`computeChargeOutstanding` clamp) + per-post caps | needs the live ledger aggregate a CHECK can't see |
| net-refundable not exceeded (incl. concurrent) | service, serialized by a per-transaction `pg_advisory_xact_lock(hashtextextended('fees_refund:'\|\|paymentTransactionId, 0))` held across the request tx (HIGH-3, mirrors slice-1 receipt-sequence lock); global `razorpayRefundId`/`idempotencyKey` uniques backstop double-SETTLE only | reservation is a BigInt aggregate no CHECK can see; the advisory lock serializes the read-modify-write so concurrent REQUESTED rows cannot both pass |
| webhook↔request refund correlation | service + DB (`idempotencyKey` set at request time, global unique; webhook correlates on `razorpayRefundId` then `receipt=idempotencyKey`; else retryable 500) | HIGH-2: the `(paymentTransactionId, amount)` fallback was non-unique and is removed |
| step-up for refund/adjust | API middleware (`requireStepUp`) | mirrors platform break-glass |
| money as STRING on JSON | API serializers (`money()`) | slice-1 boundary rule |
| idempotent webhook settle | DB (global event unique + forward-only refund status) + "already PROCESSED" no-op | by construction |

---

## §E.13 — Test plan

**Fast / mocked (`npm test -w @campusgate/api`, must stay fully green):**
- `ledger.test.ts` — `computeChargeOutstanding` across all five streams
  (alloc/concession/adj-credit/adj-debit/reversal), clamp at 0 and at amount;
  `computeChargeStatus` PENDING/PARTIALLY_PAID/PAID boundaries;
  `planRefundReversal` distribution + remainder; **refund-after-concession on the
  same charge (MEDIUM-3)** — a charge concession-zeroed between capture and refund
  restores only `currentOutstandingHeadroom`, with the shortfall surfaced as
  `unreversiblePaise` (assert the exact split); property-style BigInt edge cases
  (amount = 1 paise, amount = MAX_SAFE_INTEGER).
- **MEDIUM-2 test update (fast):** rename the `fees-unit.test.ts`
  `charge-status transition logic (forward-only)` block to the slice-1-historical
  wording (it tests a pure in-test mirror; no DB). No assertion is deleted; it is
  re-documented as superseded.
- `razorpay.refund.test.ts` — `refundPayment` guards the BigInt→Number coercion
  (reject >MAX_SAFE_INTEGER, ≤0); calls the injected `payments.refund` stub with
  the right args (incl. `receipt: idempotencyKey`); maps the result; **a stub
  result with `amount: undefined` falls back to the requested amount (NIT-4)**;
  webhook signature verify reused.
- `concessions.service.test.ts` / `adjustments.service.test.ts` — amount
  resolution (FIXED, PERCENT floor), per-charge cap enforcement (mocked tx).
- `validation.test.ts` additions — the new schemas accept STRING paise, reject
  JSON-number money, enforce FIXED/PERCENT and DEBIT/CORRECTION refinements.
- `catalogue-sync.test.ts` — green with the new dir in `SEEDING_MIGRATION_DIRS`
  and the new permission/role bindings (set-equality).
- `module-system` expectations updated if they enumerate the fees migration dir.
- A `confirmation.test.ts` addition proving capture-after-concession lands the
  correct status via `computeChargeStatus`.

**Live-DB (`npm run test:integration`, each passes in ISOLATION — NFR-5):**
- `tenant-escape.integration.test.ts` EXTENDED: add the six new tables to
  `RLS_TABLES`; add the four INSERT-only ones to `EXPECTED_POLICIES` (append-only
  pair); `concession_definitions` + `refunds` fall through to `DEFAULT_POLICIES`.
  Add read-escape / spoof-insert / foreign-parent-composite-FK / buggy-query /
  three-GUC fail-closed cases for `concession_definitions`, `student_concessions`,
  `concession_credits`, `refunds`, `refund_reversals`, `adjustments`. Seed a
  `ConcessionDefinition` + a `Refund` (status REQUESTED, a unique `idempotencyKey`
  per tenant, `razorpayRefundId` NULL — HIGH-2 column) in `seedBothTenants`; the
  four
  INSERT-only tables are DELIBERATELY NOT seeded in the shared setup (their
  triggers block the shared teardown) and get self-contained append-only cases
  (insert → UPDATE denied → DELETE denied) with the scoped trigger-disable
  teardown dance (the `payment_transactions`/`student_charges` precedent). Teardown
  order: refund_reversals → refunds (guard-disable) → concession_credits →
  student_concessions → concession_definitions → adjustments, before the slice-1
  fees teardown.
- The escape suite's policy meta-test (`EXPECTED_POLICIES`/`DEFAULT_POLICIES`)
  asserts the correct pair per new table and the absence of a modify policy on the
  four append-only tables.
- `fees-behavioral.integration.test.ts` EXTENDED (already in `LIVE_DB_SUITES`):
  (a) post a concession → charge outstanding drops → status recomputed; original
  charge row unchanged. (b) partial refund via injected Razorpay stub → Refund
  REQUESTED (carrying `idempotencyKey`) → simulate a **real refund webhook body**
  with payload at `payload.refund.entity` (`payment_id`, `id`, `receipt`,
  `status:'processed'`) and NO `order_id` → proves the **HIGH-1** payment-id
  tenant resolution reaches the refund branch (a pre-fix handler would 200-ignore
  it); reversals inserted, PAID→PARTIALLY_PAID, net-refundable drops; duplicate
  webhook `x-razorpay-event-id` → no second reversal. (b2) **HIGH-2 ordering:**
  deliver the `refund.processed` webhook BEFORE the request route persists
  `razorpayRefundId` (local row has only `idempotencyKey`) → the webhook correlates
  by `receipt=idempotencyKey`, links `razorpayRefundId`, and settles exactly once;
  a variant with neither key matching returns a retryable 500 and settles on the
  retry. (b3) **HIGH-3 concurrency:** two concurrent partial-refund requests whose
  amounts individually fit but together exceed the capture → the advisory lock
  serializes them; the second is rejected 409, and `Σ refunds ≤ capture` holds.
  (c) `refund.failed` → FAILED, NO reversal, charge status UNCHANGED,
  net-refundable restored (MEDIUM-1 wording). (d) adjustment WAIVER → outstanding
  drops, status recomputed. (e) step-up + permission enforcement on the refund and
  adjust routes (401 without `x-step-up`, 403 without permission, 200/201 with a
  minted action-bound step-up token). (f) **MEDIUM-4:** an ACCOUNTANT who has NOT
  enrolled MFA gets 400 `{error:"MFA not enrolled"}` from `/mfa/verify` and
  consequently 401 at the refund route; after `/enroll/start`+`/enroll/verify`
  the same approver completes the refund.
- **MEDIUM-2 test update (live-DB):** in the same suite's column-guard block,
  change the single "PAID→PENDING rejected" assertion to the new rule (a bare
  status move among the three valid states is allowed); KEEP the snapshot-column
  immutability and DELETE-denied assertions unchanged. Enumerated in §E.1.
- Refund/adjust permission + step-up enforcement may also be covered by a fast
  route test using a built Fastify app with a mocked `@campusgate/db` and a real
  `app.jwt` signer (mirrors the mfa.test.ts signer seam) so the 401/403 matrix is
  in the fast suite too.

`LIVE_DB_SUITES` already lists `fees-behavioral` and `tenant-escape`; no list
change needed unless a NEW standalone live suite is added (none planned — refund
behavior extends the existing fees-behavioral suite).

---

## Open Questions

- **OQ-1 (refund webhook contract):** verified the SDK refund *method* shape
  (`payments.refund(paymentId, {amount, speed, notes})` → `{id, payment_id,
  amount, status:'pending'|'processed'|'failed'}`) from the installed
  `razorpay` types. The exact *webhook* event names (`refund.created`/
  `refund.processed`/`refund.failed`) and payload path (`payload.refund.entity`)
  are from Razorpay's public docs, not verifiable against the repo. If the live
  account emits different event names, the webhook's `eventType` switch is the
  only change needed — flagged so the implementer confirms against the Razorpay
  dashboard's webhook event list before go-live.
- **OQ-2 (DEBIT corrections above snapshot):** the design caps a CORRECTION DEBIT
  so outstanding never exceeds the original `charge.amountPaise`. If the product
  needs corrections that raise the owed amount ABOVE the original charge (e.g. a
  late-fee surcharge), that is better modeled as a NEW charge, not an adjustment —
  confirm no requirement to exceed the snapshot ceiling via adjustment.
- **OQ-3 (concession on an already-PAID charge):** if a scholarship is granted
  AFTER full payment, the charge has zero outstanding, so a concession credit is
  rejected by the cap (§E.3). Such a case is really a REFUND of the overpaid
  amount, not a concession. Confirm the product treats post-payment scholarships
  as refunds (the design assumes concessions apply only to outstanding).
- **OQ-4 (report date semantics):** collection summary groups by `capturedAt`;
  outstanding aging buckets by `dueDate`. Confirm these are the intended report
  time axes (vs `postedAt` / `issuedAt`).

---

## Review responses (revision 1 — resolving `design-review.json`, verdict CHANGES_REQUESTED)

Every finding below was re-grounded against the real source before responding
(the webhook handler, `mfa.ts`, `step-up.ts`, the slice-1 migration guard, the
slice-1 `confirmation.ts` advisory-lock line, `allocation.ts`, the installed
Razorpay SDK `payments.d.ts`/`refunds.d.ts`, and a grep of the test suites).

- **HIGH-1 (refund webhook unreachable) — ADDRESSED.** §E.8 now specifies the
  EXACT edit: extract `refundEntity = evt.payload.refund.entity`, derive
  `razorpayPaymentId = refundEntity?.payment_id ?? paymentEntity?.id`, BRANCH the
  unresolvable guard by `isRefundEvent` (refund events require `payment_id`, not
  `order_id`), and resolve the tenant for refund events via
  `paymentTransaction.findFirst({ where: { razorpayPaymentId } })` using the
  verified slice-1 partial unique `payment_transactions_payment_id_unique ON
  (institutionId, razorpayPaymentId) WHERE razorpayPaymentId IS NOT NULL`. The
  capture `order_id` path is unchanged. Verified against the real
  `razorpay-webhook.ts` (which indeed early-returns on `!razorpayOrderId`) and the
  real migration index. A live-DB case (b) sends a real order-id-less refund body
  to prove reachability.
- **HIGH-2 (correlation / ordering) — ADDRESSED.** Added a NOT-NULL, globally
  unique `idempotencyKey` set in the SAME tx as the REQUESTED insert, BEFORE the
  SDK call, and passed to Razorpay as `receipt` (verified `receipt?: string|null`
  on `RazorpayRefundCreateRequestBody`, and `RazorpayRefund` echoes it). §E.4/§E.8
  pin the correlation order: `razorpayRefundId` → `idempotencyKey=receipt`
  (stamping `razorpayRefundId`) → retryable 500. The non-unique
  `(paymentTransactionId, amount)` fallback is REMOVED. `refunds_guard` allows the
  NULL→value `razorpayRefundId` stamp (slice-1 `razorpayPaymentId` idiom) so
  either the request route or the webhook can be the one to link it, idempotently.
- **HIGH-3 (reservation serialization) — ADDRESSED.** §E.4/§E.6/§E.12 require the
  request tx to take `pg_advisory_xact_lock(hashtextextended('fees_refund:'||paymentTransactionId, 0))`
  BEFORE computing net-refundable and inserting REQUESTED — mirroring the verified
  slice-1 `confirmation.ts` receipt-sequence lock verbatim. A live-DB concurrency
  case (b3) proves two racing partial refunds cannot over-refund.
- **MEDIUM-1 (AC-8 contradiction) — ADDRESSED.** AC-8 rewritten to match §E.4:
  FAILED writes no reversals, leaves charge status unchanged, and releases the
  amount back into net-refundable by dropping out of the `IN (REQUESTED,PROCESSED)`
  set. No "reverse a reversing credit".
- **MEDIUM-2 (forward-only test breakage) — ADDRESSED.** Grepped the suites and
  ENUMERATED exactly the two places that encode forward-only: the DB-level
  assertion in `fees-behavioral.integration.test.ts` (PAID→PENDING rejected —
  MUST change; snapshot-immutability + DELETE-denied assertions kept) and the pure
  in-test mirror in `fees-unit.test.ts` (renamed to "slice-1 historical /
  superseded"). §E.1 and §E.13 list both; no other test asserts it.
- **MEDIUM-3 (reversal vs post-capture credits) — ADDRESSED.** §E.3/§E.4 state the
  invariant: each per-charge reversal is clamped to
  `min(originalAllocationToCharge, currentOutstandingHeadroom)`, and any
  unrestorable remainder is recorded on `Refund.unreversiblePaise` (new column,
  CHECK ≥ 0, guard-frozen after PROCESSED). A `ledger.test.ts` refund-after-
  concession case is added.
- **MEDIUM-4 (MFA enrolment precondition) — ADDRESSED.** Verified `/mfa/verify`
  hard-fails 400 for un-enrolled users and that mandatory MFA is platform-only.
  Chose option (a): refund/adjust approvers self-enrol once via the existing
  `/api/auth/mfa/enroll/*`; documented in the locked stack, §E.6, the §E.10 error
  path (un-enrolled → 400 at /verify → 401 at the route), and a §E.13 live case.
  Option (b) (mandatory-MFA gate for fees staff) is noted as a future auth-policy
  change, out of scope for this money slice.
- **NIT-1 (redundant uniques) — ADDRESSED.** Dropped the partial
  `(institutionId, razorpayRefundId)` composite; kept only the GLOBAL partial
  unique on `razorpayRefundId` (plus the new global unique on `idempotencyKey`).
  §E.1/§E.2.c updated.
- **NIT-2 (optional audit key) — ADDRESSED (decision).** No
  `fees.webhook.refund_received` key; `refund.created` reuses the existing
  `fees.webhook.received` (metadata carries `eventType`). §E.8/§E.9 updated.
- **NIT-3 (dir name) — ADDRESSED (confirmed).** The exact string
  `20261129000000_phase7_fees_slice2` is authoritative in `SEEDING_MIGRATION_DIRS`
  and everywhere else; §E.2 flags it must not be partially "corrected" to
  `_slice71`.
- **NIT-4 (SDK typing) — ADDRESSED.** §E.7 pins the stub to be assignable from the
  verified real `refund(paymentId, params): Promise<Refunds.RazorpayRefund>`
  signature, drops the `[k]: unknown` index member (the real type has none), and
  the mapping code falls back to the requested amount when the response `amount`
  is undefined. A fast test covers the undefined-amount case.

### Review responses (revision 2 — resolving the second `design-review.json`, verdict CHANGES_REQUESTED)

Re-grounded against the real `razorpay-webhook.ts` (confirmed the handler order:
HMAC → extract `razorpayOrderId` → `if (!razorpayOrderId) return 200 "no order
id"` → `if (!eventId) return 200 "no event id"` → resolve tenant → processed-event
insert keyed on `razorpayEventId = eventId`, with the `!eventId` guard at lines
116-120) and against `catalogue-sync.test.ts` parser mechanics.

- **NEW-1 (webhook `eventId` guard placement for refund events) — ADDRESSED.**
  §E.8's snippet now shows the existing `!eventId → 200 {ignored,"no event id"}`
  guard as step (b'), UNCHANGED from slice 1, placed immediately after the
  branched attribution guard and before tenant resolution, firing for BOTH event
  families. A new paragraph states explicitly that the refund branch introduces
  no new front-door idempotency primitive: the processed-event insert for a
  refund event writes the SAME `razorpayEventId = eventId` column, so a duplicate
  `x-razorpay-event-id` is a `{status:"duplicate"}` 200 no-op (reversing credit
  never double-inserted), matching AC-7; the Refund's `razorpayRefundId` /
  `idempotencyKey` uniques are a second, deeper layer for the request-vs-webhook
  race, not a replacement for this `eventId` de-dupe.
- **NEW-2 (refund tenant resolution lacks `institutionId` filter) — ADDRESSED
  (documentation).** Added a paragraph to §E.8 noting the filterless
  `findFirst({ where: { razorpayPaymentId } })` on the owner-role client inherits
  the accepted slice-1 capture-path rationale (`razorpayOrderId` is resolved the
  same filterless way; Razorpay ids are globally unique in practice; the webhook
  has no tenant token before resolving), so the absent `institutionId` filter is
  consistent house style, not an oversight.
- **NEW-3 (catalogue-sync permissions span must physically exist) — ADDRESSED
  (confirmation).** §E.2.j now shows the concrete `INSERT INTO "permissions"
  (...) VALUES (...,'fees.concession.manage','fees',...) ON CONFLICT ("key") DO
  NOTHING;` span that `extractPermissionKeys` slices, states that omitting it
  (while adding the key to `permissions.ts`, or vice-versa) fails the set-equality
  test, confirms `fees.refund` / `fees.adjust` permission ROWS are NOT re-inserted
  (only their six `role_permissions` pairs added), and gives the exact
  `role_permissions` `SELECT ... FROM (VALUES ...) AS m(role_key, perm_key)` shape
  the `extractRolePermissionPairs` parser requires.

OPEN QUESTIONS carried forward: OQ-1 (the Razorpay refund *webhook* event
names/payload path are unverifiable in-repo) remains flagged — the implementer
confirms against the live dashboard before go-live; the webhook's `eventType`
switch is the only change if names differ. OQ-2/OQ-3/OQ-4 are unchanged product
confirmations.
