# Design Review — CAMPASS Phase 7 Fees SLICE 7.1 (backend)

Reviewed: `c:\campusgate\.agents\tasks\phase7-fees-slice71\design.md`
Mode: **Revision 2 re-review.** The design carries a "Review responses (revision 1)"
section and a "Review responses (revision 2)" section, naming prior findings
HIGH-1/2/3, MEDIUM-1..4, NIT-1..4, and NEW-1..3. Per the revision protocol I am
NOT fresh: I re-grounded every prior finding against the real source, marked each
Closed or Unchanged, then reviewed what changed for new defects.

This is money-critical code. Any HIGH or MEDIUM finding blocks (CHANGES_REQUESTED).

---

## Verification method

Every claim below was checked against the real monorepo files, not against the
design's prose. Files read:

- `apps/api/src/routes/razorpay-webhook.ts` (the live capture webhook handler)
- `apps/api/src/services/fees/confirmation.ts` (advisory-lock idiom, capture routine)
- `apps/api/src/services/fees/allocation.ts` (`nextChargeStatus`, `planAllocation`, `chargeOutstanding`)
- `apps/api/src/services/fees/razorpay.ts` (`RazorpaySdkLike`, `createOrder` BigInt guard)
- `apps/api/src/routes/fees.ts` (`actor()`, `money()`, `deny()`, `isDeny()`, `loadLedger`, `findStuck` usage, preHandler pattern)
- `apps/api/src/routes/mfa.ts` + `apps/api/src/middleware/step-up.ts` (MFA enrol/verify, `requireStepUp`)
- `apps/api/src/routes/admin.ts` (ExcelJS streamed-xlsx pattern)
- `packages/db/prisma/migrations/20261122000000_phase7_fees_slice1/migration.sql` (slice-1 guard bodies, RLS pairs, grants, catalogue §j seed shape)
- `packages/shared/src/permissions.ts` + `packages/shared/src/audit-actions.ts` (current catalogue state)
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` (the static parser mechanics)
- `apps/api/src/routes/__tests__/fees-behavioral.integration.test.ts` + `apps/api/src/services/fees/__tests__/fees-unit.test.ts` (the forward-only assertions)
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` (`RLS_TABLES`/`EXPECTED_POLICIES`/`DEFAULT_POLICIES`)
- `apps/api/vitest.live-db-suites.ts` (`LIVE_DB_SUITES`)
- `node_modules/razorpay/dist/types/payments.d.ts` + `refunds.d.ts` (SDK refund method + entity shape)

---

## Re-check of prior findings (revision protocol)

| ID | Prior issue | Status | Evidence |
|----|-------------|--------|----------|
| HIGH-1 | Refund webhook unreachable (`!razorpayOrderId` → 200 ignore) | **Closed** | `razorpay-webhook.ts` confirms the current handler early-returns `200 {status:"ignored", reason:"no order id"}` on `!razorpayOrderId`, then resolves tenant only by `razorpayOrderId`. A refund event has no `order_id`, so it would be ignored. §E.8's branch-by-`isRefundEvent` + `razorpayPaymentId` resolution via the real `payment_transactions_payment_id_unique ON (institutionId, razorpayPaymentId) WHERE razorpayPaymentId IS NOT NULL` index (verified in slice-1 migration) correctly fixes this. A live case (b) sends an order-id-less body to prove reachability. |
| HIGH-2 | Webhook↔request correlation / ordering | **Closed** | SDK `Refunds.RazorpayRefundCreateRequestBody.receipt?: string \| null` and `RazorpayRefund` echoing `receipt` both verified in `refunds.d.ts`. NOT-NULL global-unique `idempotencyKey` set at REQUESTED before the SDK call, correlation order `razorpayRefundId` → `idempotencyKey=receipt` → retryable 500, `(paymentTransactionId, amount)` fallback removed. `refunds_guard` NULL→value stamp mirrors the verified `payment_transactions_guard` razorpayPaymentId idiom. Consistent. |
| HIGH-3 | Reservation serialization for concurrent refunds | **Closed** | The slice-1 lock idiom `pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))` with key `fees_receipt:${institutionId}` is verified verbatim in `confirmation.ts`. The design's `fees_refund:<paymentTransactionId>` mirror, taken before net-refundable is computed/inserted inside the request tx, is a faithful application of the same pattern. Live case (b3) proves it. |
| MEDIUM-1 | AC-8 "reverse the reversing credit" contradiction | **Closed** | AC-8 and §E.4 now agree: FAILED writes no reversals, status unchanged, released by dropping out of the `IN (REQUESTED,PROCESSED)` set. Append-only triggers forbid mutating a reversal, and the model writes none until PROCESSED, so nothing to undo. Internally consistent. |
| MEDIUM-2 | Forward-only test breakage from the guard relaxation | **Closed** | Enumeration verified exact. (1) `fees-behavioral.integration.test.ts` ~line 735 asserts `studentCharge.update({status:"PENDING"}).rejects.toBeTruthy()` ("a PAID charge cannot move backwards to PENDING") — this WILL flip to failing under the relaxation and the design flags it to change, keeping the snapshot-immutability (`amountPaise`) and DELETE-denied assertions. (2) `fees-unit.test.ts` lines 314-338 `describe("charge-status transition logic (forward-only)")` tests a pure in-test mirror `isLegalChargeTransition` (no DB), so it does not break the build; design keeps it renamed/superseded. No third occurrence exists; the `nextChargeStatus` test (line 273) asserts the outstanding→status mapping, which is preserved. |
| MEDIUM-3 | Reversal vs post-capture credits (double-credit / lost cash) | **Closed** | §E.3/§E.4 clamp each per-charge reversal to `min(originalAllocationToCharge, currentOutstandingHeadroom)`, accumulate the shortfall into a new `Refund.unreversiblePaise` (CHECK ≥ 0, guard-frozen after PROCESSED), double-guarded by the final `[0, amount]` clamp of `computeChargeOutstanding`. A `ledger.test.ts` refund-after-concession case is specified. Sound. |
| MEDIUM-4 | MFA enrolment precondition for tenant staff | **Closed** | Verified in `mfa.ts`: `/verify` returns 400 `{error:"MFA not enrolled"}` when `!user.mfaEnabled`; `action` is read from the body and bound into the minted token; `/enroll/start` + `/enroll/verify` are open to any authenticated user. `step-up.ts`: `requireStepUp(actionClass)` verifies `action===actionClass` and 401s otherwise; mandatory MFA (`requirePlatformMfa`) is platform-only. Option (a) self-enrol resolution is accurate and feasible; the 403-then-401 ordering is correct for the real middleware. |
| NIT-1 | Redundant refund uniques | **Closed** | Single global partial unique on `razorpayRefundId` + global unique on `idempotencyKey`; the per-tenant composite is dropped. Mirrors the slice-1 `processed_webhook_events_razorpayEventId_key` global-unique precedent. |
| NIT-2 | Optional refund-webhook audit key | **Closed** | `fees.webhook.received` exists today in `audit-actions.ts` (verified); reusing it for `refund.created` with `eventType` in metadata is consistent with the slice-1 webhook audit style. |
| NIT-3 | Migration dir-name consistency | **Closed** | `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts` and `LIVE_DB_SUITES` in `vitest.live-db-suites.ts` both verified; the design's rule to use the exact string `20261129000000_phase7_fees_slice2` everywhere is correct, and no live-suite list change is needed (it extends existing suites). |
| NIT-4 | Razorpay SDK typing | **Closed** | `payments.refund(paymentId, params: RazorpayRefundPaymentLinkAccountCreateRequestBody \| Refunds.RazorpayRefundCreateRequestBody): Promise<Refunds.RazorpayRefund>` and `fetchRefund(paymentId, refundId)` both verified present in `payments.d.ts`. `RazorpayRefund.amount?: number` (optional, via `Omit<...,'speed'>`) and NO `[k]: unknown` index signature confirmed in `refunds.d.ts` — the design's undefined-amount fallback and dropped index member are correct. |
| NEW-1 | `eventId` guard placement for refund events | **Closed** | `razorpay-webhook.ts` confirms the `!eventId → 200 {ignored,"no event id"}` guard sits immediately after the `!razorpayOrderId` guard and before tenant resolution / the processed-event insert keyed on `razorpayEventId = eventId`. The design keeps it family-agnostic; the refund branch adds no new front-door idempotency primitive. Matches AC-7. |
| NEW-2 | Refund tenant resolution lacks `institutionId` filter | **Closed** | The slice-1 capture path already resolves the tenant with a filterless `paymentTransaction.findFirst({ where: { razorpayOrderId } })` on the owner-role lookup client (verified). The refund branch inherits the identical accepted rationale; documented as house style, not a defect. |
| NEW-3 | catalogue-sync permissions span must physically exist | **Closed** | `extractPermissionKeys` slices between the literal `INSERT INTO "permissions"` and the following `ON CONFLICT`; `extractRolePermissionPairs` slices between `INSERT INTO "role_permissions"` and `AS m(` (verified in `catalogue-sync.test.ts`). The design's concrete `INSERT INTO "permissions" (...) VALUES (...,'fees.concession.manage',...) ON CONFLICT ("key") DO NOTHING;` span and the `... AS m(role_key, perm_key) ...` role-pair block both parse. The alias column names after `AS m(` are outside the slice, so `role_key, perm_key` vs the slice-1 `"roleKey","permKey"` is immaterial to the parser. `fees.refund`/`fees.adjust` are currently unbound in `ROLE_PERMISSIONS` (verified) and bound to NO role in the slice-1 §j; adding the six pairs is correct and set-equality holds. |

All 14 prior findings are **Closed** against the real source. No prior finding is Unchanged.

---

## New findings (this revision)

No HIGH or MEDIUM defects were found in the revised design. The items below are
NITs (they do not block).

1. **NIT — webhook "unknown" vs "unknown order" reason string drift.** §E.8's
   edited snippet returns `return reply.status(200).send({ status: "ignored", reason: "unknown" });`
   for the no-row case, whereas the live handler
   (`razorpay-webhook.ts`) returns `reason: "unknown order"` for the capture path.
   This is cosmetic (the body shape `{status:"ignored"}` is what tests assert),
   but to keep the single handler internally consistent, keep the capture branch's
   existing `"unknown order"` string and use a distinct `"unknown payment"` for the
   refund branch rather than a bare `"unknown"`. Concrete fix: in the refund branch
   use `reason: "unknown payment"`; leave the capture branch's `"unknown order"`
   untouched.

2. **NIT — `confirmCapture` status-recompute change is under-scoped in the design.**
   §E.5 says `confirmCapture` is "updated to compute post-capture status via
   `computeChargeStatus`". The real `confirmCapture` (verified) currently sets each
   allocated charge's status from `planAllocation`'s `alloc.nextStatus`
   (`nextChargeStatus`, which only emits PAID/PARTIALLY_PAID). A concession credit
   that already zeroed a charge's outstanding is not an allocation target
   (`planAllocation` skips `outstanding <= 0`), so capture would not regress it.
   The design's "lands the correct status after capture" claim is therefore a
   defensive improvement, not a correctness fix — which is fine, but the design
   should state explicitly that the only behavioral change is that a charge whose
   outstanding is already reduced by a concession lands on PAID/PARTIALLY_PAID
   consistently via the shared `computeChargeStatus`, and that the existing
   allocation-driven path is otherwise byte-for-byte preserved (the fast
   `confirmation.test.ts` addition should assert the no-concession path is
   unchanged). Concrete fix: add one sentence to §E.5 pinning "no change to the
   allocation loop; only the status written for an allocated charge is sourced
   from `computeChargeStatus(ledgerInputs)` instead of `alloc.nextStatus`, and a
   regression test asserts identical output for the no-credit case."

3. **NIT — OQ-1 (refund webhook event names / payload path) remains unverifiable
   in-repo.** The design correctly flags that `refund.processed` / `refund.failed`
   / `refund.created` and `payload.refund.entity` come from Razorpay public docs,
   not the installed SDK (the SDK types confirm only the `payments.refund` *method*
   and the `RazorpayRefund` entity, not webhook envelopes). This is an accepted
   pre-go-live confirmation, not a design defect, because the design isolates the
   blast radius to the `eventType` switch and the entity path. Keep OQ-1 open and
   confirm against the live dashboard's webhook event list before enabling refund
   webhooks. No code change needed now.

---

## Verified Assumptions

- The live webhook handler early-returns `200 {status:"ignored", reason:"no order id"}` on `!razorpayOrderId` and resolves the tenant only by `razorpayOrderId` — so a refund event WOULD be dropped without §E.8's branch. (razorpay-webhook.ts)
- The `!eventId` guard immediately follows the `!razorpayOrderId` guard and precedes tenant resolution + the processed-event insert keyed on `razorpayEventId = eventId`. (razorpay-webhook.ts)
- The advisory-lock idiom is `pg_advisory_xact_lock(hashtextextended(<key>, 0))` with key `fees_receipt:${institutionId}`; the refund mirror `fees_refund:<paymentTransactionId>` is faithful. (confirmation.ts)
- `payment_transactions_payment_id_unique ON (institutionId, razorpayPaymentId) WHERE razorpayPaymentId IS NOT NULL` exists and is per-tenant (so cross-tenant uniqueness of a Razorpay payment id is effective-in-practice, matching the accepted capture-path rationale). (slice-1 migration.sql)
- Slice-1 `student_charges_guard` body matches the design's "UNCHANGED" snapshot-column list exactly and enforces the forward-only status clause the design relaxes; the `CREATE OR REPLACE FUNCTION` approach replaces only the body, leaving the trigger binding and the frozen file intact. (slice-1 migration.sql)
- `payment_transactions_guard` is not touched by the slice and stays terminal-frozen. (slice-1 migration.sql)
- The exact two forward-only test sites are as enumerated (one live-DB DB-level assertion that will flip; one pure in-test mirror that will not). (fees-behavioral / fees-unit)
- `nextChargeStatus` emits only PAID/PARTIALLY_PAID (no PENDING) — so `computeChargeStatus` legitimately needs the added PENDING branch. (allocation.ts)
- Razorpay SDK: `payments.refund(paymentId, params)` and `payments.fetchRefund(paymentId, refundId)` exist; `RazorpayRefundCreateRequestBody.receipt?: string|null`; `RazorpayRefund` echoes `receipt`, has `amount?: number` (optional), and has no `[k]: unknown` index member. (payments.d.ts, refunds.d.ts)
- `requireStepUp(actionClass)` 401s on missing/invalid `x-step-up`, verifies `action===actionClass`; `/api/auth/mfa/verify` 400s `{error:"MFA not enrolled"}` for un-enrolled users and mints an action-bound token from the body `action`; mandatory MFA is platform-only. (step-up.ts, mfa.ts)
- `recordAuditEvent` validates `action` against `AUDIT_ACTION_KEY_SET` from `@campusgate/shared` (no Prisma `AuditAction` enum), so new keys need no schema change. (audit.ts)
- `fees.webhook.received` already exists; the new keys `fees.concession.posted`, `fees.refund.requested/processed/failed`, `fees.adjustment.posted` do not yet exist. (audit-actions.ts)
- `fees.refund`/`fees.adjust` permission KEYS exist in `PERMISSION_KEYS` and in the slice-1 §j permissions span but are bound to NO role in `ROLE_PERMISSIONS` and no `role_permissions` pair — so adding the six ACCOUNTANT/ADMIN pairs is correct; `fees.concession.manage` exists nowhere yet. (permissions.ts, slice-1 migration.sql)
- `catalogue-sync.test.ts` slices permissions between `INSERT INTO "permissions"` and `ON CONFLICT`, and role-pairs between `INSERT INTO "role_permissions"` and `AS m(`; alias column names after `AS m(` are outside the slice. (catalogue-sync.test.ts)
- The ExcelJS streamed-xlsx pattern (`workbook.xlsx.writeBuffer()` → Content-Type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` + Content-Disposition attachment → `send(Buffer.from(buffer))`) is exactly the `admin.ts` precedent. (admin.ts)
- `fees.ts` exposes `actor()`, `money()`, `deny()`, `isDeny()`, `loadLedger`, and uses `findStuck` from reconciliation; the `preHandler: [requirePermission(...), requireModuleActive(gate)]` pattern is the house style refund/adjust routes extend. (fees.ts, reconciliation.ts)
- `RLS_TABLES`, `EXPECTED_POLICIES`, `DEFAULT_POLICIES`, `seedBothTenants` exist in the escape-suite helper, with the slice-1 fees tables already split into the append-only vs standard-pair sets the design mirrors. (tenant-escape-setup.ts)
- `LIVE_DB_SUITES` already contains `tenant-escape.integration.test.ts` and `fees-behavioral.integration.test.ts`. (vitest.live-db-suites.ts)

## Unverified / Wrong Assumptions

- **OQ-1 (unverifiable, flagged):** the Razorpay refund *webhook* event names and payload path (`refund.processed`/`refund.failed`/`refund.created`, `payload.refund.entity`) cannot be confirmed from the repo — only the SDK `payments.refund` method and `RazorpayRefund` entity are verifiable. The design correctly isolates this to the `eventType` switch and flags a pre-go-live dashboard confirmation. Carry open.
- No wrong assumptions were found. The design's NIT-4 self-claim ("verified the real `payments.d.ts` `refund` method") initially appeared suspect (a `grep` for `refund` in that file returned no matches), but a direct read of `payments.d.ts` confirms the `refund(paymentId, params): Promise<Refunds.RazorpayRefund>` method is present; the grep was a false negative on the large file. The claim stands.

---

## Verdict

HIGH findings: 0
MEDIUM findings: 0
NIT findings: 3

Mechanical verdict (HIGH + MEDIUM == 0): **APPROVED**.

All three prior review rounds' findings (HIGH-1/2/3, MEDIUM-1..4, NIT-1..4,
NEW-1..3) are re-grounded against the real source and Closed. The remaining items
are NITs and do not block implementation.
