# Money-OUT + corrections half of the fees ledger (concessions, refunds, adjustments, reports)

Slice 7.1 adds the money-OUT and corrections half of the Phase-7 fees ledger on top of the frozen slice-1 capture spine (`ac9440f`). It lands six new tenant tables, five enums, a single-source-of-truth ledger module, concession/refund/adjustment services, the refund extension of the Razorpay gateway, refund handling in the public webhook, and read-only JSON + Excel reports — all in one commit (`a0aea05`). The unifying invariant holds throughout: a charge's effective state is recomputed from five append-only ledger streams (allocations − concessions − adjustment credits + adjustment debits + refund reversals, clamped `[0, amount]`) by exactly one function that both the read and write paths call; no captured fact is ever mutated. The commit records the fast suite at 454 passed, `fees-behavioral` 22 passed in isolation, `tenant-escape` 75 passed in isolation, `prisma migrate status` up to date (14 migrations), and clean `tsc` builds.

Watch for: nothing blocking. Two non-blocking notes — the HIGH-3 concurrency acceptance criterion is proven by a *sequential* two-partial test (409 on the second) rather than a truly concurrent one (**confirmed**, the advisory-lock code and net-refundable math are present and correct, so the invariant Σrefunds ≤ capture is still proven); and the collection-report `netPaise` is computed with a no-op ternary `(net > 0n ? net : net)` that is harmless but reads as a leftover (**confirmed**, net can legitimately be negative and the value is correct either way).

**Verdict**: APPROVED

## High-level view

The ledger is genuinely one source of truth. `ledger.ts` holds pure-BigInt `computeChargeOutstanding` / `computeChargeStatus` / `planRefundReversal`; `ledger-query.ts` loads the five streams one way; and the concession, adjustment, refund, capture, and report paths all route status/outstanding through those functions. `confirmation.ts` was switched from the slice-1 `planAllocation.nextStatus` to `computeChargeStatus` with a fallback, so a capture landing on a charge that already carries a concession credit computes correctly — behaviour-preserving when no credits exist.

The refund money model matches the design's delicate §E.4 shape. Requests take a per-transaction advisory lock, recompute net-refundable (`captured − Σ refunds IN (REQUESTED,PROCESSED)`) under the lock, reject over-large amounts with a 409 and a DENIED audit before any gateway call, mint a server-side `idempotencyKey`, insert a REQUESTED row, then call Razorpay outside the tx and persist/settle in a fresh tx. Reversing credits are written only at PROCESSED, never at REQUESTED, so a FAILED refund simply drops out of the reservation set and needs no undo. `settleRefund` is the shared idempotent routine for both the synchronous success path and the webhook, no-opping if already PROCESSED.

The webhook extension resolves refund events by `payment_id` (HIGH-1 — refund events carry no `order_id`), keeps the `eventId` idempotency guard family-agnostic and in place, and correlates the local refund by `razorpayRefundId` then by `receipt = idempotencyKey` (HIGH-2), stamping the refund id on a receipt-matched row. An unmatched `refund.processed` throws so Razorpay redelivers (retryable 500); a duplicate `x-razorpay-event-id` is a 200 no-op.

The security posture is intact. Refund and adjust routes are gated by both the permission (`fees.refund` / `fees.adjust`) and `requireStepUp(...)` reused unchanged from `middleware/step-up.ts` — no new MFA mechanism, and the un-enrolled-approver path surfaces as the MEDIUM-4 401 via the existing `/mfa/verify` 400. The single BigInt→Number coercion lives only at the Razorpay SDK boundary (guarded identically in `createOrder` and `refundPayment`); every JSON boundary serializes money as strings and Excel uses integer-paise numeric cells plus a formatted ₹ string column.

The migration mirrors slice 1 section-for-section (a–j), is strictly additive, and the §E.1 relaxation is a body-only `CREATE OR REPLACE` of `student_charges_guard` that keeps every snapshot-immutability check and the DELETE raise byte-identical while replacing only the forward-only status clause. The catalogue, tenant-escape suite, and live-suite list are all consistent with the new keys and tables.

<details>
<summary>Issues (2)</summary>

1. **HIGH-3 concurrency proven sequentially** — the two-partial over-capture test runs sequentially (second request 409) rather than truly concurrently; the advisory lock and net-refundable math are correct, so the invariant holds, but a concurrent test would exercise the lock contention path directly. Non-blocking.
2. **No-op ternary in collection net** — `netPaise: (net > 0n ? net : net).toString()` in `buildCollectionReport` is a harmless leftover; both branches return the same value. Leave as-is or simplify to `net.toString()`. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Ledger as the single source of truth

`ledger.ts` computes outstanding as `clamp(amount − allocations − concessionCredits − adjustmentCredits + adjustmentDebits + refundReversals, 0, amount)` and projects status purely from outstanding (`=amount → PENDING`, `0<out<amount → PARTIALLY_PAID`, `0 → PAID`), reusing the slice-1 `nextChargeStatus` for the PAID/PARTIALLY_PAID mapping and adding the PENDING branch. `ledger-query.ts` is the one place the five streams are read, splitting adjustments into CREDIT/DEBIT by `direction`. Every consumer — `postConcession`, `postAdjustment`, `settleRefund`, `confirmCapture`, `loadLedger`, and both report builders — routes through these, so there is no divergent math. The concession and adjustment services cap credits against live outstanding (409 if exceeded) and DEBIT corrections against snapshot headroom, which a row-level CHECK cannot see, so the cap correctly lives in the service.

### Refund request ordering and reservation

`POST /payments/:id/refunds` implements §E.4 exactly: lock → validate CAPTURED (409 + DENIED audit otherwise) → validate a captured `razorpayPaymentId` exists → `computeNetRefundable` under the lock → 409 + DENIED audit if `amount > net` → mint `idempotencyKey` → insert REQUESTED → audit `fees.refund.requested` → commit. Only then does it call `gateway.refundPayment` outside the tx with `receipt: idempotencyKey`. On SDK throw it flips the row to FAILED and audits `fees.refund.failed`, returning 502; on success it persists `razorpayRefundId` and, if Razorpay returned `processed`, drives `settleRefund` synchronously. A `pending` result correctly leaves the row REQUESTED for the webhook to finalize. Because reversals are written only at PROCESSED, a FAILED refund releases its reservation by dropping out of the `IN (REQUESTED,PROCESSED)` set with nothing to undo — consistent with AC-8.

The HIGH-3 acceptance criterion is exercised by a sequential test: two ₹30,000 partials against a ₹50,000 capture, the second rejected 409 once the first's REQUESTED row is visible. The advisory lock (`pg_advisory_xact_lock(hashtextextended('fees_refund:'||txnId, 0))`) and the under-lock recompute are present and correct, so the Σrefunds ≤ capture invariant is proven; the test simply doesn't drive true lock contention. This is a test-fidelity note, not a correctness gap.

### Webhook refund attribution and correlation

The webhook branches the unresolvable-attribution guard by event family: refund events require `payment_id` (200 ignored if absent), capture events keep the `order_id` guard. The `!eventId` idempotency guard stays family-agnostic and in its slice-1 position, so a redelivered refund webhook with a missing header can't bypass the duplicate check or NULL-insert the `razorpayEventId`. Tenant resolution for refunds is a filterless owner-role `findFirst` by `razorpayPaymentId` — the same accepted house pattern the capture path uses for `razorpayOrderId` (NEW-2), justified because the webhook has no tenant token and Razorpay ids are globally unique. Inside the resolved tenant tx, after the processed-event insert, `refund.processed` correlates (id → receipt, stamping the id on a receipt match) and either no-ops an already-PROCESSED refund or calls `settleRefund`; a no-match throws for a retryable 500. `refund.failed` flips REQUESTED→FAILED with no reversals; `refund.created` is an audited no-op reusing `fees.webhook.received`. The behavioral suite covers all of these including the HIGH-2 before-persist path and the duplicate-event no-second-reversal case.

### Migration: additive, section-mirrored, guard relaxation scoped

The migration follows slice-1's a–j layout: five enums; six tables (updatedAt only on `concession_definitions` and `refunds`); `(id, institutionId)` uniques plus the two global partials on refunds (`razorpayRefundId WHERE NOT NULL`, `idempotencyKey`); tenant-root and composite same-tenant FKs on all six; the full CHECK set (positive money, `currency='INR'`, non-empty name/reason, `percentBps 1..10000`, FIXED/PERCENT exclusivity, adjustment direction, `unreversiblePaise >= 0`); ENABLE+FORCE RLS with the nullif-guarded fail-closed pair on the two mutable/snapshot tables and the SELECT+`_tenant_insert` append-only pair on the four INSERT-only tables; four append-only triggers plus the `refunds_guard` column guard (freezes money/identity, NULL→value `razorpayRefundId` stamp once then frozen, forward-only REQUESTED→{PROCESSED,FAILED}, terminal frozen, DELETE raise); the guarded `campass_app` GRANT refresh (full DML on the two, SELECT+INSERT with REVOKE UPDATE/DELETE on the four, never BYPASSRLS); and the catalogue seed. The only `DROP` statements are `DROP POLICY IF EXISTS` inside the idempotent RLS re-create loop — no destructive DROP on any existing table, and none of the thirteen frozen dirs is touched.

The §E.1 relaxation is a body-only `CREATE OR REPLACE FUNCTION "student_charges_guard"()`: every immutable-snapshot-column check and the DELETE raise are byte-identical to slice 1, and only the forward-only status clause is replaced by a "status must be one of the three valid values" clause. The trigger binding is untouched. This is the minimal change that lets a refund move a charge PAID→PARTIALLY_PAID while keeping the real protections (money columns frozen, ledger rows append-only) intact. `payment_transactions_guard` is left unchanged, so captured money stays terminal-frozen.

### Catalogue, contracts, and tenant-escape coverage

`permissions.ts` adds the one new `fees.concession.manage` permission and binds `fees.concession.manage` / `fees.refund` / `fees.adjust` to both ACCOUNTANT and ADMIN; the migration's §j seeds a real parseable `INSERT INTO "permissions"` span (the one new key) plus the six role-permission pairs, and `catalogue-sync.test.ts` gets the exact `20261129000000_phase7_fees_slice2` string appended to `SEEDING_MIGRATION_DIRS` — so the set-equality test resolves. `audit-actions.ts` adds exactly the five new keys and reuses `fees.webhook.received` for `refund.created`. `validation.ts` adds the five enums and all schemas with every money field on `PaiseAmount` and the FIXED/PERCENT and DEBIT-only-for-CORRECTION refinements. The tenant-escape setup lists all six tables in `RLS_TABLES`, places the four INSERT-only tables in `EXPECTED_POLICIES` with their append-only pair, lets `concession_definitions`/`refunds` fall through to the default modify pair, seeds a `ConcessionDefinition` and a REQUESTED `Refund` per tenant, and adds the correct trigger-disable teardown order.

### Money typing on every boundary

The single BigInt→Number coercion is guarded identically in `createOrder` and `refundPayment` (reject `<= 0n` or `> MAX_SAFE_INTEGER`), and `refundPayment` falls back to the requested amount when the SDK omits `amount` (NIT-4). Every serializer (`serializeRefund`, `serializeAdjustment`, `serializeConcessionDefinition`, `loadLedger`, both report builders) emits money as strings. The two Excel exports use the verbatim `admin.ts` `writeBuffer()` + content-type + `Content-Disposition` + `Buffer.from(buffer)` pattern with integer-paise numeric cells and a formatted ₹ string column.

</details>

<details>
<summary>File map</summary>

- `packages/shared/src/permissions.ts` — +`fees.concession.manage`; bind concession.manage/refund/adjust to ACCOUNTANT+ADMIN.
- `packages/shared/src/audit-actions.ts` — +5 fees audit keys (concession.posted, refund.requested/processed/failed, adjustment.posted).
- `packages/shared/src/validation.ts` — +5 enums, concession/refund/adjustment/report schemas (money via PaiseAmount).
- `packages/db/prisma/schema.prisma` — +5 enums, +6 models, back-references; documents the partial-unique cosmetic diff.
- `packages/db/prisma/migrations/20261129000000_phase7_fees_slice2/migration.sql` — the additive a–j migration + §E.1 guard relaxation.
- `apps/api/src/services/fees/ledger.ts` — pure-BigInt single source of truth.
- `apps/api/src/services/fees/ledger-query.ts` — the one five-stream loader.
- `apps/api/src/services/fees/concessions.ts` / `adjustments.ts` / `refunds.ts` — the three posting services.
- `apps/api/src/services/fees/razorpay.ts` — gateway extended with `refundPayment` (not forked).
- `apps/api/src/services/fees/confirmation.ts` — post-capture status via the ledger.
- `apps/api/src/routes/fees.ts` — concession/adjustment/refund routes + four JSON reports + two Excel exports; `loadLedger` extended.
- `apps/api/src/routes/razorpay-webhook.ts` — refund.* branch (payment_id resolution, correlate, settle/fail/ack).
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — +new migration dir.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` — six new tables.
- `apps/api/src/routes/__tests__/fees-behavioral.integration.test.ts` — concession/refund/webhook/step-up/adjust/reports + MEDIUM-2.
- `apps/api/src/services/fees/__tests__/{ledger,razorpay.refund,concessions.service,adjustments.service,confirmation}.test.ts` + `fees-unit.test.ts` rename — fast suites.

Full diff: `git diff ac9440f`.

</details>
