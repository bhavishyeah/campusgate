# Implementation Plan: Outside-Time Allowance & Reliability Score

## Overview

This plan implements the AllowanceEngine and ReliabilityEngine subsystems for CAMPUSGATE. The approach is bottom-up: data models first, then core computation services, then API endpoints, then frontend integration. Both engines derive metrics from existing GateEvent records with no mutable counters. TypeScript with Fastify (API) and Next.js (frontend) following existing project conventions.

## Tasks

- [x] 1. Database schema and data model setup
  - [x] 1.1 Add new Prisma enums and models for AllowancePolicy, EmergencyOverride, and ReliabilityScoreSnapshot
    - Add `PolicyPeriod` enum (DAILY, WEEKLY, MONTHLY, SEMESTER)
    - Add `EnforcementMode` enum (BLOCK_NEW_REQUESTS, WARN_ONLY)
    - Add `SeverityLevel` enum (MINOR, MODERATE, SIGNIFICANT, SEVERE)
    - Add `AllowancePolicy` model with all fields from design (allowanceAmount, policyPeriod, gracePeriod, enforcement, minimumSampleSize, severity thresholds)
    - Add `EmergencyOverride` model with gatePassId, overriddenById, justification
    - Add `ReliabilityScoreSnapshot` model with studentId, score, movementNumber, computedAt
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.2, 5.3, 13.1, 14.1_

  - [x] 1.2 Modify existing models to add new relations
    - Add `emergencyOverride` optional relation and `allowanceWarning` field to `GatePass`
    - Add `allowancePolicy` optional relation to `Institution`
    - Add `emergencyOverrides` relation to `User` model
    - Add `reliabilitySnapshots` relation to `StudentProfile`
    - Add `EMERGENCY_OVERRIDE` and `ALLOWANCE_POLICY_UPDATED` to `AuditAction` enum
    - _Requirements: 5.3, 5.4, 7.1, 13.1_

  - [x] 1.3 Generate and apply Prisma migration
    - Run `prisma migrate dev` to create migration file for the new schema changes
    - Verify migration applies cleanly against development database
    - _Requirements: 3.5_

- [x] 2. Implement AllowanceEngine core service
  - [x] 2.1 Create AllowanceEngine service with period boundary computation and duration calculation
    - Create `apps/api/src/services/allowance-engine.ts`
    - Implement `computeActualDuration(passId)` — derives duration from EXIT/RETURN GateEvent timestamps
    - Implement `getPeriodBounds(periodType, referenceDate)` — computes start/end dates for DAILY, WEEKLY, MONTHLY, SEMESTER
    - Implement `getOrCreatePolicy(institutionId)` — returns existing policy or creates default (1440 min, weekly, 10 min grace, warn_only)
    - _Requirements: 1.1, 1.2, 1.3, 2.4, 3.5_

  - [x] 2.2 Write property tests for duration computation (Property 1)
    - **Property 1: Duration computation correctness**
    - For any EXIT/RETURN timestamp pair where RETURN > EXIT, verify `floor((returnTimestamp - exitTimestamp) / 60000)`
    - **Validates: Requirements 1.1**

  - [x] 2.3 Write property tests for period boundary computation (Property 8)
    - **Property 8: Period boundary date computation**
    - For any valid date and period type, verify start <= referenceDate <= end and period length matches type
    - **Validates: Requirements 6.4**

  - [x] 2.4 Implement remaining allowance computation and enforcement decision
    - Implement `getRemainingAllowance(studentId, institutionId)` — sums completed movement durations in current period, includes in-progress elapsed time for OUTSIDE status
    - Implement `getEnforcementDecision(studentId, institutionId)` — returns allow/block/warn based on remaining allowance and enforcement mode
    - Handle edge cases: missing GateEvent pairs excluded with warning log, empty period returns full allowance
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3_

  - [x] 2.5 Write property tests for remaining allowance formula (Properties 2, 3, 4)
    - **Property 2: Remaining allowance formula** — verify `max(0, AllowanceAmount - sum(durations))`
    - **Property 3: In-progress elapsed time inclusion** — verify currently-outside elapsed added to consumed
    - **Property 4: Period boundary filtering** — verify only movements with RETURN in period boundaries counted
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

  - [x] 2.6 Write property tests for enforcement decision (Property 6)
    - **Property 6: Enforcement decision determinism**
    - For any remaining value and enforcement mode, verify correct action returned
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [x] 2.7 Write property tests for policy configuration validation (Property 5)
    - **Property 5: Policy configuration validation**
    - Verify bounds: AllowanceAmount [60, 10080], GracePeriod [0, 60], MinimumSampleSize [3, 20], justification length >= 10
    - **Validates: Requirements 3.1, 3.3, 5.2, 14.1**

- [x] 3. Implement ReliabilityEngine core service
  - [x] 3.1 Create ReliabilityEngine service with severity classification and rate computation
    - Create `apps/api/src/services/reliability-engine.ts`
    - Implement `classifySeverity(overdueMinutes, thresholds)` — returns MINOR/MODERATE/SIGNIFICANT/SEVERE based on configured thresholds
    - Implement `computeTimelyReturnRate(movements, gracePeriod, thresholds)` — applies severity-weighted deductions
    - Implement `computeCompletionRate(passes)` — COMPLETED / total terminal passes
    - Implement `computeComplianceRate(movements)` — compliant / total movements
    - _Requirements: 8.3, 8.4, 8.5, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 3.2 Write property tests for severity classification (Property 9)
    - **Property 9: Severity classification completeness**
    - For any positive overdue value and valid thresholds, verify exactly one classification returned
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [x] 3.3 Write property tests for rate computations (Properties 12, 13, 14)
    - **Property 12: Timely return rate with severity deductions** — verify formula correctness
    - **Property 13: Completion rate computation** — verify COMPLETED/terminal ratio
    - **Property 14: Authorization compliance rate computation** — verify compliant/total ratio
    - **Validates: Requirements 8.3, 8.4, 8.5, 10.5**

  - [x] 3.4 Implement overall score computation with exclusion filtering and snapshot recording
    - Implement `computeScore(studentId, institutionId)` — weighted formula (60% timely + 20% completion + 20% compliance) scaled to 0.0–5.0
    - Implement `filterMovementsForScoring()` — excludes non-terminal, emergency overrides, system failures
    - Implement `recordSnapshot(studentId, score, movementNumber)` — persists score after each completed movement
    - Implement `getScoreTrend(studentId, limit)` — returns last 30 snapshots with improvement indicator
    - _Requirements: 8.1, 8.2, 11.1, 11.2, 11.3, 11.4, 13.1, 13.2, 13.3_

  - [x] 3.5 Write property tests for score bounds and weighted formula (Properties 10, 11)
    - **Property 10: Score bounded invariant** — for any valid component rates, overall in [0.0, 5.0] with 1dp
    - **Property 11: Weighted score formula** — verify `round((0.6*TR + 0.2*CR + 0.2*ACR) * 5.0, 1)`
    - **Validates: Requirements 8.1, 8.2**

  - [x] 3.6 Write property tests for exclusion rules and improvement indicator (Properties 15, 16)
    - **Property 15: Score exclusion rules** — verify emergency overrides, non-terminal, system failures excluded
    - **Property 16: Score improvement indicator** — verify threshold of 0.5 increase over 10 movements
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 13.3**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement API endpoints for allowance
  - [x] 5.1 Create student allowance endpoint and integrate enforcement into gate pass request
    - Add `GET /api/student/allowance` route — returns AllowanceSummary for current period
    - Modify existing `POST /api/student/gate-pass` route — call `getEnforcementDecision` before creating pass; block or attach warning based on result
    - Add `allowanceWarning` field to pass creation when enforcement is "warn_only" and allowance exhausted
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 6.1, 6.2, 6.3, 6.4_

  - [x] 5.2 Create HOD allowance and emergency override endpoints
    - Add `GET /api/hod/requests/:passId/allowance` — returns requesting student's allowance summary
    - Add `POST /api/hod/emergency-override` — validates justification (>= 10 chars), creates EmergencyOverride record, creates audit log entry
    - Modify `GET /api/hod/requests/:passId` — include student allowance info in response
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.1, 7.2, 7.3_

  - [x] 5.3 Create admin allowance policy endpoints
    - Add `GET /api/admin/allowance-policy` — returns current policy or default values
    - Add `PUT /api/admin/allowance-policy` — validates and updates policy config with bounds checking (allowanceAmount [60,10080], gracePeriod [0,60], minimumSampleSize [3,20])
    - Add `POST /api/admin/emergency-override` — admin-level override with same validation as HOD
    - Create audit log entry for policy updates
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.1, 14.1, 14.2, 14.3_

- [x] 6. Implement API endpoints for reliability score
  - [x] 6.1 Create student reliability endpoint
    - Add `GET /api/student/reliability` — returns ReliabilityScore with trend data
    - Return `hasSufficientData: false` with message when below Minimum_Sample_Size
    - Include last 30 snapshots for trend display and improvement indicator
    - _Requirements: 8.1, 9.1, 9.2, 9.3, 13.1, 13.2, 13.3_

  - [x] 6.2 Create HOD reliability endpoint and block guard access
    - Add `GET /api/hod/requests/:passId/reliability` — returns student's reliability score for approval context
    - Ensure no reliability endpoint exists for GUARD role routes
    - Modify `GET /api/hod/requests/:passId` — include reliability score in response when sufficient data exists
    - _Requirements: 9.4, 9.5, 12.1, 12.2, 12.3_

  - [x] 6.3 Integrate reliability snapshot trigger on pass completion
    - Modify guard's mark-return flow — when pass status transitions to COMPLETED, call `ReliabilityEngine.computeScore()` and `recordSnapshot()`
    - Ensure snapshot is only created for passes not excluded by filtering rules
    - _Requirements: 13.1, 11.1, 11.2, 11.3, 11.4_

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement frontend - Student Dashboard
  - [x] 8.1 Create student allowance display component
    - Add allowance summary section to student dashboard page (`apps/web/src/app/student/page.tsx`)
    - Display remaining allowance in hours and minutes
    - Display consumed allowance in hours and minutes
    - Display Policy_Period type with start/end dates
    - Show visual warning indicator when remaining < 20% of total
    - Show real-time elapsed timer when student is currently outside
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 8.2 Create student reliability score display component
    - Add reliability score section to student profile page (`apps/web/src/app/student/profile/page.tsx`)
    - Display overall score (0.0–5.0) when sufficient data exists
    - Display three component scores individually (timely return, completion, compliance)
    - Display "insufficient data" message when below Minimum_Sample_Size
    - Display trend chart for last 30 movements with improvement indicator
    - _Requirements: 9.1, 9.2, 9.3, 13.2, 13.3_

- [x] 9. Implement frontend - HOD Panel
  - [x] 9.1 Add allowance and reliability info to HOD request review panel
    - Modify HOD pending request view (`apps/web/src/app/hod/page.tsx`)
    - Display student's remaining allowance alongside request details
    - Show prominent exhaustion warning when allowance is zero/negative
    - Display allowance warning message if attached to the pass
    - Display student's reliability score (when sufficient data exists)
    - Present reliability score as advisory information (not blocking)
    - _Requirements: 7.1, 7.2, 7.3, 9.5, 12.3_

  - [x] 9.2 Implement emergency override UI for HOD
    - Add emergency override action button visible when student's allowance is exhausted and enforcement is "block_new_requests"
    - Create override modal/form requiring justification text (min 10 characters)
    - Call `POST /api/hod/emergency-override` on submission
    - Show success confirmation with audit trail reference
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 10. Implement frontend - Admin Panel
  - [x] 10.1 Create admin allowance policy configuration page
    - Add policy configuration section to admin page (`apps/web/src/app/admin/page.tsx`)
    - Form fields: Allowance Amount (60–10080 min), Policy Period (dropdown), Grace Period (0–60 min), Enforcement Mode (dropdown)
    - Form fields: Minimum Sample Size (3–20), Severity thresholds (minor max, moderate max, significant max)
    - Input validation matching backend bounds
    - Call `PUT /api/admin/allowance-policy` on save
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 14.1, 14.2, 14.3_

- [x] 11. Integration wiring and validation
  - [x] 11.1 Add Zod validation schemas for all new API inputs
    - Create validation schemas for policy config update (bounds checking)
    - Create validation schema for emergency override (justification min length)
    - Apply schemas to all new API routes using existing validation patterns
    - _Requirements: 3.1, 3.3, 5.2, 14.1_

  - [x] 11.2 Write property tests for duration formatting (Property 7)
    - **Property 7: Duration formatting**
    - For any non-negative integer minutes, verify hours = `floor(min/60)` and minutes = `min % 60`
    - **Validates: Requirements 6.1, 6.2**

  - [x] 11.3 Write integration tests for allowance lifecycle
    - Test full gate pass lifecycle with allowance tracking (request → approve → exit → return → verify consumed)
    - Test emergency override flow (exhausted → override → pass created → audit logged)
    - Test policy period reset behavior
    - _Requirements: 2.1, 2.4, 4.1, 5.1, 5.3_

  - [x] 11.4 Write integration tests for reliability scoring
    - Test reliability snapshot creation on pass completion
    - Test score exclusion for emergency override passes
    - Test guard role cannot access reliability endpoints
    - Test insufficient data scenario
    - _Requirements: 9.4, 11.2, 13.1_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–16)
- Unit tests validate specific examples and edge cases
- All durations are derived from GateEvent timestamps — no mutable duration counters
- The ReliabilityEngine score is purely informational and never blocks workflow actions (Req 12)
- fast-check library should be installed as a dev dependency for property-based testing

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1", "3.1"] },
    { "id": 4, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3", "3.4"] },
    { "id": 5, "tasks": ["2.5", "2.6", "2.7", "3.5", "3.6"] },
    { "id": 6, "tasks": ["5.1", "5.2", "5.3", "6.1", "6.2", "6.3"] },
    { "id": 7, "tasks": ["8.1", "8.2", "9.1", "9.2", "10.1", "11.1"] },
    { "id": 8, "tasks": ["11.2", "11.3", "11.4"] }
  ]
}
```
