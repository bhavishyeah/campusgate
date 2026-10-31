# CAMPASS Phase 8 — EXAMINATIONS Slice 8.1 — Baseline

## Workspace / Branch

- **Workspace:** `c:\campusgate` (working directly on `main`, NO worktree — every prior phase was built this way; step agents' cwd is the workspace root).
- **Branch:** `main`
- **HEAD:** `e113810e5feaff11ff2c8336049b2d6f018a636a`
- **Matches brief's expected HEAD (`e113810`, origin/main, Phase 7 fees complete):** ✅ YES — short SHA `e113810` matches.

## Frozen migration dirs

Location: `c:\campusgate\packages\db\prisma\migrations`

**Count: 14 directories** (all present and untouched). Plus `migration_lock.toml` (file, not a dir).

1. `20260824143031_add_allowance_and_reliability_models`
2. `20261018100917_init`
3. `20261018110658_tenancy_isolation_rls`
4. `20261018171747_identity_rbac_b2`
5. `20261019053533_superadmin_security`
6. `20261019093119_module_system`
7. `20261027111710_phase1_academics`
8. `20261027161616_phase2_sis`
9. `20261028000000_phase3_classes`
10. `20261101000000_phase4_attendance`
11. `20261108000000_phase5_library`
12. `20261115000000_phase6_admissions`
13. `20261122000000_phase7_fees_slice1`
14. `20261129000000_phase7_fees_slice2`  ← **newest reference dir to mirror**

## Constraints for Phase 8 migration work

- The **newest reference dir to mirror** is `20261129000000_phase7_fees_slice2`.
- The long-standing **composite-vs-single-FK cosmetic diff is expected** — it is not an error and must not be "fixed".
- There must be **NO DROP on existing tables**.
- The **14 frozen migration dirs must stay untouched** (no edits, renames, or deletions).

## Notes

- No code changes were made in this step.
- No push or deploy performed.
