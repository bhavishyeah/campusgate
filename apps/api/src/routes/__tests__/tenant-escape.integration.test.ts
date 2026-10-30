/**
 * Cross-tenant escape suite (tenancy.md §7) — runs against the REAL Supabase
 * tables through the `campass_app` runtime connection, proving Row-Level Security
 * isolates tenants even when the application layer forgets to filter.
 *
 * Requires live Supabase + the campass_app credentials in apps/api/.env. This is
 * the real-DB suite; the other api integration suites mock @campusgate/db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appClient,
  adminClient,
  seedBothTenants,
  cleanup,
  countRemainingTestRows,
  disconnect,
  seeded,
  RLS_TABLES,
  EXPECTED_POLICIES,
  DEFAULT_POLICIES,
  PREFIX,
} from "./helpers/tenant-escape-setup.js";

// Imported dynamically in beforeAll so the setup module (which pins
// DATABASE_URL to campass_app) has executed before @campusgate/db is loaded.
type WithTenant = <T>(
  institutionId: string,
  fn: (tx: any) => Promise<T>,
) => Promise<T>;
let withTenant: WithTenant;

describe("Cross-tenant escape suite (real DB, RLS enforced)", () => {
  beforeAll(async () => {
    ({ withTenant } = (await import("@campusgate/db")) as unknown as {
      withTenant: WithTenant;
    });
    await seedBothTenants();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    const remaining = await countRemainingTestRows();
    expect(remaining).toBe(0);
    await disconnect();
  }, 120_000);

  it("1. read escape: tenant A cannot read tenant B's pass by id or via list", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.gatePass.findUnique({ where: { id: B.gatePassId } }),
    );
    expect(foreign).toBeNull();

    const own = await withTenant(A.institutionId, (tx) =>
      tx.gatePass.findMany({}),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.gatePassId);
    }
  }, 60_000);

  it("2. write escape: tenant A cannot create a pass referencing tenant B's student", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.gatePass.create({
          data: {
            passNumber: `${PREFIX}ILLEGAL_FOREIGN_PARENT`,
            institutionId: A.institutionId,
            studentId: B.studentProfileId, // B's student under A's tenant
            reasonId: A.reasonId,
            requestedExit: new Date(),
            expectedReturn: new Date(Date.now() + 3600_000),
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3. spoofed-tenant insert: tenant A cannot insert a row stamped institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.notification.create({
          data: {
            institutionId: B.institutionId, // spoof: claim to belong to B
            userId: B.userId,
            title: `${PREFIX}SPOOF`,
            body: "should be rejected by WITH CHECK",
            type: "TEST",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3b. membership_roles read escape: tenant A cannot see tenant B's membership-role", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Direct fetch of B's membership-role under A's tenant context => RLS hides it.
    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.membershipRole.findUnique({ where: { id: B.membershipRoleId } }),
    );
    expect(foreign).toBeNull();

    // Unscoped list under A still returns only A's rows, never B's.
    const own = await withTenant(A.institutionId, (tx) =>
      tx.membershipRole.findMany({}),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.membershipRoleId);
    }
  }, 60_000);

  it("3c. spoofed-tenant insert: tenant A cannot insert a membership-role stamped institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // A real template role id, resolved via the RLS-bypassing admin client, so
    // the roleId FK is valid and the rejection is proven to come from the tenant
    // WITH CHECK, not an incidental FK failure.
    const studentTemplateRole = await adminClient.role.findFirst({
      where: { key: "STUDENT", institutionId: null },
      select: { id: true },
    });
    expect(studentTemplateRole).toBeTruthy();

    // Claim B's institutionId (and B's membership) while in A's context =>
    // tenant_isolation_modify WITH CHECK rejects the write.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.membershipRole.create({
          data: {
            id: `${PREFIX}SPOOF_MRL`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            membershipId: B.membershipId,
            roleId: studentTemplateRole!.id,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3d. institution_modules read escape: tenant A cannot see tenant B's module row", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.institutionModule.findUnique({ where: { id: B.institutionModuleId } }),
    );
    expect(foreign).toBeNull();

    // Unscoped list under A still returns only A's rows, never B's.
    const own = await withTenant(A.institutionId, (tx) =>
      tx.institutionModule.findMany({}),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.institutionModuleId);
    }
  }, 60_000);

  it("3e. institution_modules spoofed-tenant insert: A cannot insert a row stamped institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.institutionModule.create({
          data: {
            id: `${PREFIX}SPOOF_IMOD`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            moduleKey: "student_management",
            state: "ENTITLED",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3f. institution_modules spoofed-tenant update: A cannot flip B's row to A", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Updating B's row under A's context: RLS makes B's row invisible to A, so
    // the update matches zero rows (count 0), never mutates B.
    const result = await withTenant(A.institutionId, (tx) =>
      tx.institutionModule.updateMany({
        where: { id: B.institutionModuleId },
        data: { state: "SUSPENDED" },
      }),
    );
    expect(result.count).toBe(0);

    // Confirm via admin that B's row is untouched.
    const bRow = await adminClient.institutionModule.findUnique({
      where: { id: B.institutionModuleId },
    });
    expect(bRow!.state).toBe("ACTIVE");
  }, 60_000);

  it("3g. institution_modules buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const rows = await withTenant(A.institutionId, (tx) =>
      tx.institutionModule.findMany({}),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.institutionId).toBe(A.institutionId);
    expect(rows.some((r: { id: string }) => r.id === B.institutionModuleId)).toBe(false);

    const aCount = await adminClient.institutionModule.count({
      where: { institutionId: A.institutionId },
    });
    expect(rows.length).toBe(aCount);
  }, 60_000);

  it("3h. institution_modules fail-closed: three GUC states all yield zero visible rows", async () => {
    const A = seeded.A!;

    // (i) no tenant context set (appClient outside withTenant) => GUC unset => NULL => no rows
    const unset = await appClient.institutionModule.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unset.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      return tx.institutionModule.findMany({ where: { institutionId: { startsWith: PREFIX } } });
    });
    expect(empty.length).toBe(0);

    // (iii) wrong-tenant GUC => A's context cannot see B's rows (covered by 3d/3g);
    //       prove the complementary direction: A's own row IS visible under A's GUC.
    const aVisible = await withTenant(A.institutionId, (tx) =>
      tx.institutionModule.findMany({}),
    );
    expect(aVisible.some((r: { id: string }) => r.id === A.institutionModuleId)).toBe(true);
  }, 60_000);

  // ─── FEAT-003 academics tables (design §10.1) ──────────────────────────────
  // academic_sessions / academic_terms / programs: cross-tenant read denied,
  // spoofed/cross-tenant write denied, buggy-query backstop, three-GUC-state
  // fail-closed. The append-only academic_calendar_day_revisions table is covered
  // separately (its self-contained test) + the UPDATE/DELETE assertions below.

  it("3i. academic_sessions read escape: tenant A cannot see tenant B's session", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.academicSession.findUnique({ where: { id: B.academicSessionId } }),
    );
    expect(foreign).toBeNull();

    const own = await withTenant(A.institutionId, (tx) => tx.academicSession.findMany({}));
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.academicSessionId);
    }
  }, 60_000);

  it("3j. academic_terms read escape: tenant A cannot see tenant B's term", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.academicTerm.findUnique({ where: { id: B.academicTermId } }),
    );
    expect(foreign).toBeNull();

    const own = await withTenant(A.institutionId, (tx) => tx.academicTerm.findMany({}));
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.academicTermId);
    }
  }, 60_000);

  it("3k. programs read escape: tenant A cannot see tenant B's program", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.program.findUnique({ where: { id: B.programId } }),
    );
    expect(foreign).toBeNull();

    const own = await withTenant(A.institutionId, (tx) => tx.program.findMany({}));
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.programId);
    }
  }, 60_000);

  it("3l. academic_sessions spoofed insert: A cannot stamp a session institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.academicSession.create({
          data: {
            id: `${PREFIX}SPOOF_SESS`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            name: `${PREFIX}SPOOF Session`,
            structureType: "SEMESTER",
            startDate: new Date("2026-07-01T00:00:00.000Z"),
            endDate: new Date("2027-06-30T00:00:00.000Z"),
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3m. academic_terms composite-FK: A cannot create a term referencing B's session", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, academicSessionId) makes it
    // physically impossible to reference B's session under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.academicTerm.create({
          data: {
            id: `${PREFIX}ILLEGAL_TERM`,
            institutionId: A.institutionId,
            academicSessionId: B.academicSessionId, // B's session under A's tenant
            name: `${PREFIX}Illegal Term`,
            ordinal: 9,
            startDate: new Date("2026-07-01T00:00:00.000Z"),
            endDate: new Date("2026-12-31T00:00:00.000Z"),
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3n. programs spoofed update: A cannot flip B's program to A's context", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const result = await withTenant(A.institutionId, (tx) =>
      tx.program.updateMany({
        where: { id: B.programId },
        data: { status: "INACTIVE" },
      }),
    );
    expect(result.count).toBe(0);

    const bRow = await adminClient.program.findUnique({ where: { id: B.programId } });
    expect(bRow!.status).toBe("ACTIVE");
  }, 60_000);

  it("3o. academics buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const sessions = await withTenant(A.institutionId, (tx) => tx.academicSession.findMany({}));
    for (const r of sessions) expect(r.institutionId).toBe(A.institutionId);
    expect(sessions.some((r: { id: string }) => r.id === B.academicSessionId)).toBe(false);

    const terms = await withTenant(A.institutionId, (tx) => tx.academicTerm.findMany({}));
    for (const r of terms) expect(r.institutionId).toBe(A.institutionId);
    expect(terms.some((r: { id: string }) => r.id === B.academicTermId)).toBe(false);

    const programs = await withTenant(A.institutionId, (tx) => tx.program.findMany({}));
    for (const r of programs) expect(r.institutionId).toBe(A.institutionId);
    expect(programs.some((r: { id: string }) => r.id === B.programId)).toBe(false);
  }, 60_000);

  it("3p. academics fail-closed: unset / empty-string GUC yield zero rows for every new table", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetSessions = await appClient.academicSession.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetSessions.length).toBe(0);
    const unsetTerms = await appClient.academicTerm.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetTerms.length).toBe(0);
    const unsetPrograms = await appClient.program.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetPrograms.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const s = await tx.academicSession.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const t = await tx.academicTerm.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const p = await tx.program.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return s.length + t.length + p.length;
    });
    expect(empty).toBe(0);

    // (iii) wrong-tenant direction already covered; prove A's own rows ARE visible under A.
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.academicSession.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.academicSessionId)).toBe(true);
  }, 60_000);

  // NOTE: the academic_calendar_day_revisions APPEND-ONLY assertion (campass_app
  // cannot UPDATE/DELETE a revision) is deliberately NOT in this shared escape
  // suite — seeding a revision here would leave an append-only row that RESTRICTs
  // the shared cleanup()'s institution delete (the exact reason design §10.1 keeps
  // revisions OUT of the escape seed, mirroring audit_events). That coverage lives
  // in the self-contained academics-behavioral suite ("§10.4 revision append-only
  // + fail-closed"), which manages the trigger within its own prefix/DDL scope.
  // The policy meta-test (case 6) still asserts the append-only policy pair + the
  // absence of a modify policy on this table.

  // ─── FEAT-003 SIS tables (design §9.3/§10.1) ───────────────────────────────
  // student_documents (standard pair): cross-tenant read denied, spoofed-tenant
  // write rejected, foreign-parent composite-FK violation, buggy-query backstop,
  // three-GUC-state fail-closed. student_profile_history (append-only) is covered
  // by its own self-contained case (3w) + the policy meta-test — it is NOT seeded
  // in the shared setup (the trigger blocks the shared teardown).

  it("3q. student_documents read escape: tenant A cannot see tenant B's document", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.studentDocument.findUnique({ where: { id: B.studentDocumentId } }),
    );
    expect(foreign).toBeNull();

    const own = await withTenant(A.institutionId, (tx) => tx.studentDocument.findMany({}));
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.studentDocumentId);
    }
  }, 60_000);

  it("3r. student_documents nested-include escape: B's docs never leak through A's studentProfile", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Reading the student profile WITH a documents include under A returns only
    // A's own doc, never B's (RLS applies to the nested relation read too).
    const profile = await withTenant(A.institutionId, (tx) =>
      tx.studentProfile.findFirst({
        where: { id: A.studentProfileId },
        include: { documents: true },
      }),
    );
    expect(profile).toBeTruthy();
    for (const doc of profile!.documents) {
      expect(doc.institutionId).toBe(A.institutionId);
      expect(doc.id).not.toBe(B.studentDocumentId);
    }
  }, 60_000);

  it("3s. student_documents spoofed-tenant insert: A cannot stamp a doc institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.studentDocument.create({
          data: {
            id: `${PREFIX}SPOOF_SDOC`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            studentProfileId: B.studentProfileId,
            kind: "OTHER",
            title: `${PREFIX}spoof`,
            storageKey: `${PREFIX}spoof_store`,
            uploadedByUserId: A.userId,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3t. student_documents foreign-parent: A cannot create a doc referencing B's studentProfile", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, studentProfileId) makes it
    // physically impossible to reference B's student under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.studentDocument.create({
          data: {
            id: `${PREFIX}FOREIGN_SDOC`,
            institutionId: A.institutionId,
            studentProfileId: B.studentProfileId, // B's student under A's tenant
            kind: "OTHER",
            title: `${PREFIX}foreign-parent`,
            storageKey: `${PREFIX}foreign_store`,
            uploadedByUserId: A.userId,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3u. student_documents buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const rows = await withTenant(A.institutionId, (tx) => tx.studentDocument.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.institutionId).toBe(A.institutionId);
    expect(rows.some((r: { id: string }) => r.id === B.studentDocumentId)).toBe(false);

    const aCount = await adminClient.studentDocument.count({
      where: { institutionId: A.institutionId },
    });
    expect(rows.length).toBe(aCount);
  }, 60_000);

  it("3v. student_profiles buggy-query backstop: generalized row unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The generalized student_profiles row (status + structured links) is still
    // RLS-isolated — an unfiltered read under A never leaks B's student.
    const rows = await withTenant(A.institutionId, (tx) => tx.studentProfile.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.institutionId).toBe(A.institutionId);
    expect(rows.some((r: { id: string }) => r.id === B.studentProfileId)).toBe(false);
  }, 60_000);

  it("3w. student_documents + generalized student_profiles fail-closed: unset / empty-string GUC yield zero rows", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetDocs = await appClient.studentDocument.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetDocs.length).toBe(0);
    const unsetProfiles = await appClient.studentProfile.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetProfiles.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const d = await tx.studentDocument.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const p = await tx.studentProfile.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return d.length + p.length;
    });
    expect(empty).toBe(0);

    // (iii) A's own rows ARE visible under A's GUC (the complementary direction).
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.studentDocument.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.studentDocumentId)).toBe(true);
  }, 60_000);

  it("3x. student_profile_history APPEND-ONLY (self-contained, one tenant): insert OK, UPDATE/DELETE denied", async () => {
    const A = seeded.A!;

    // Self-contained: insert a history row under A, assert campass_app can read
    // it, then assert UPDATE and DELETE are BOTH denied (REVOKE + trigger). The
    // row is left in place — the shared teardown deletes the parent studentProfile
    // via adminClient AFTER this, but the append-only trigger would block even
    // that, so we remove it here within THIS test's own trigger-disable scope
    // (mirrors the academics-behavioral suite's clearAcademics pattern).
    const histId = `${PREFIX}SPH_A`;
    await withTenant(A.institutionId, (tx) =>
      tx.studentProfileHistory.create({
        data: {
          id: histId,
          institutionId: A.institutionId,
          studentProfileId: A.studentProfileId,
          changeType: "UPDATED",
          actorUserId: A.userId,
        },
      }),
    );

    // Readable by campass_app under A's context.
    const readBack = await withTenant(A.institutionId, (tx) =>
      tx.studentProfileHistory.findUnique({ where: { id: histId } }),
    );
    expect(readBack).toBeTruthy();

    // UPDATE denied (REVOKE UPDATE + the BEFORE UPDATE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.studentProfileHistory.update({ where: { id: histId }, data: { reason: "mutate" } }),
      ),
    ).rejects.toBeTruthy();

    // DELETE denied (REVOKE DELETE + the BEFORE DELETE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.studentProfileHistory.delete({ where: { id: histId } }),
      ),
    ).rejects.toBeTruthy();

    // The row survived both attempts.
    const still = await adminClient.studentProfileHistory.findUnique({ where: { id: histId } });
    expect(still).toBeTruthy();

    // Clean up this suite-local history row within a scoped trigger-disable so
    // the shared teardown's studentProfile delete (RESTRICT parent) is not
    // blocked. This is the ONLY place the escape suite touches this table.
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "student_profile_history" DISABLE TRIGGER "student_profile_history_no_update_delete"`,
    );
    try {
      await adminClient.studentProfileHistory.deleteMany({
        where: { institutionId: { startsWith: PREFIX } },
      });
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "student_profile_history" ENABLE TRIGGER "student_profile_history_no_update_delete"`,
      );
    }
  }, 60_000);

  // ─── FEAT-004 Phase-3 classes tables (design §6) ───────────────────────────
  // courses / subjects / class_sections / class_enrollments / faculty_profiles /
  // faculty_assignments / timetables / scheduled_classes (the eight mutable
  // tables): cross-tenant read denied, spoofed/cross-tenant write denied,
  // foreign-parent composite-FK violation, buggy-query backstop, three-GUC-state
  // fail-closed. The append-only schedule_revisions table is covered by its own
  // self-contained case (3cc) + the policy meta-test — it is NOT seeded in the
  // shared setup (its trigger blocks the shared teardown).

  it("3y. classes read escape: tenant A cannot see tenant B's Phase-3 rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const course = await withTenant(A.institutionId, (tx) =>
      tx.course.findUnique({ where: { id: B.courseId } }),
    );
    expect(course).toBeNull();

    const subject = await withTenant(A.institutionId, (tx) =>
      tx.subject.findUnique({ where: { id: B.subjectId } }),
    );
    expect(subject).toBeNull();

    const section = await withTenant(A.institutionId, (tx) =>
      tx.classSection.findUnique({ where: { id: B.classSectionId } }),
    );
    expect(section).toBeNull();

    const enrollment = await withTenant(A.institutionId, (tx) =>
      tx.classEnrollment.findUnique({ where: { id: B.classEnrollmentId } }),
    );
    expect(enrollment).toBeNull();

    const faculty = await withTenant(A.institutionId, (tx) =>
      tx.facultyProfile.findUnique({ where: { id: B.facultyProfileId } }),
    );
    expect(faculty).toBeNull();

    const assignment = await withTenant(A.institutionId, (tx) =>
      tx.facultyAssignment.findUnique({ where: { id: B.facultyAssignmentId } }),
    );
    expect(assignment).toBeNull();

    const timetable = await withTenant(A.institutionId, (tx) =>
      tx.timetable.findUnique({ where: { id: B.timetableId } }),
    );
    expect(timetable).toBeNull();

    const scheduled = await withTenant(A.institutionId, (tx) =>
      tx.scheduledClass.findUnique({ where: { id: B.scheduledClassId } }),
    );
    expect(scheduled).toBeNull();

    // Unscoped lists under A still return only A's rows, never B's.
    const ownCourses = await withTenant(A.institutionId, (tx) => tx.course.findMany({}));
    expect(ownCourses.length).toBeGreaterThan(0);
    for (const row of ownCourses) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.courseId);
    }
  }, 60_000);

  it("3z. classes spoofed insert: A cannot stamp a course institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.course.create({
          data: {
            id: `${PREFIX}SPOOF_COURSE`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            programId: B.programId,
            name: `${PREFIX}SPOOF Course`,
            code: `${PREFIX}SPOOF_COURSE_CODE`,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3aa. classes foreign-parent: A cannot create a subject referencing B's course", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, courseId) makes it physically
    // impossible to reference B's course under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.subject.create({
          data: {
            id: `${PREFIX}FOREIGN_SUBJ`,
            institutionId: A.institutionId,
            courseId: B.courseId, // B's course under A's tenant
            name: `${PREFIX}foreign-parent subject`,
            code: `${PREFIX}FOREIGN_SUBJ_CODE`,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3bb. classes foreign-parent: A cannot enroll B's student into A's section", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // class_enrollments.(institutionId, studentId) composite FK forbids enrolling
    // another tenant's student — the single-identity guarantee (design §6.5).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.classEnrollment.create({
          data: {
            id: `${PREFIX}FOREIGN_ENROLL`,
            institutionId: A.institutionId,
            classSectionId: A.classSectionId,
            studentId: B.studentProfileId, // B's student under A's tenant
            status: "ENROLLED",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3cc. classes spoofed update: A cannot flip B's scheduled class to A's context", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Updating B's row under A's context: RLS makes B's row invisible to A, so
    // the update matches zero rows, never mutates B.
    const result = await withTenant(A.institutionId, (tx) =>
      tx.scheduledClass.updateMany({
        where: { id: B.scheduledClassId },
        data: { room: `${PREFIX}HIJACK` },
      }),
    );
    expect(result.count).toBe(0);

    const bRow = await adminClient.scheduledClass.findUnique({
      where: { id: B.scheduledClassId },
    });
    expect(bRow!.institutionId).toBe(B.institutionId);
    expect(bRow!.room).not.toBe(`${PREFIX}HIJACK`);
  }, 60_000);

  it("3dd. classes buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const subjects = await withTenant(A.institutionId, (tx) => tx.subject.findMany({}));
    for (const r of subjects) expect(r.institutionId).toBe(A.institutionId);
    expect(subjects.some((r: { id: string }) => r.id === B.subjectId)).toBe(false);

    const sections = await withTenant(A.institutionId, (tx) => tx.classSection.findMany({}));
    for (const r of sections) expect(r.institutionId).toBe(A.institutionId);
    expect(sections.some((r: { id: string }) => r.id === B.classSectionId)).toBe(false);

    const enrollments = await withTenant(A.institutionId, (tx) => tx.classEnrollment.findMany({}));
    for (const r of enrollments) expect(r.institutionId).toBe(A.institutionId);
    expect(enrollments.some((r: { id: string }) => r.id === B.classEnrollmentId)).toBe(false);

    const faculty = await withTenant(A.institutionId, (tx) => tx.facultyProfile.findMany({}));
    for (const r of faculty) expect(r.institutionId).toBe(A.institutionId);
    expect(faculty.some((r: { id: string }) => r.id === B.facultyProfileId)).toBe(false);

    const assignments = await withTenant(A.institutionId, (tx) => tx.facultyAssignment.findMany({}));
    for (const r of assignments) expect(r.institutionId).toBe(A.institutionId);
    expect(assignments.some((r: { id: string }) => r.id === B.facultyAssignmentId)).toBe(false);

    const timetables = await withTenant(A.institutionId, (tx) => tx.timetable.findMany({}));
    for (const r of timetables) expect(r.institutionId).toBe(A.institutionId);
    expect(timetables.some((r: { id: string }) => r.id === B.timetableId)).toBe(false);

    const scheduled = await withTenant(A.institutionId, (tx) => tx.scheduledClass.findMany({}));
    for (const r of scheduled) expect(r.institutionId).toBe(A.institutionId);
    expect(scheduled.some((r: { id: string }) => r.id === B.scheduledClassId)).toBe(false);

    const aCount = await adminClient.scheduledClass.count({
      where: { institutionId: A.institutionId },
    });
    expect(scheduled.length).toBe(aCount);
  }, 60_000);

  it("3ee. classes fail-closed: unset / empty-string GUC yield zero rows for every mutable table", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetCourses = await appClient.course.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetCourses.length).toBe(0);
    const unsetScheduled = await appClient.scheduledClass.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetScheduled.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows (all eight tables)
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const c = await tx.course.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const s = await tx.subject.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const sec = await tx.classSection.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const en = await tx.classEnrollment.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const f = await tx.facultyProfile.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const fa = await tx.facultyAssignment.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const tt = await tx.timetable.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const sc = await tx.scheduledClass.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return c.length + s.length + sec.length + en.length + f.length + fa.length + tt.length + sc.length;
    });
    expect(empty).toBe(0);

    // (iii) A's own rows ARE visible under A's GUC (the complementary direction).
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.scheduledClass.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.scheduledClassId)).toBe(true);
  }, 60_000);

  it("3ff. schedule_revisions APPEND-ONLY (self-contained, one tenant): insert OK, cross-tenant SELECT empty, UPDATE/DELETE denied", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Self-contained (mirrors the student_profile_history case 3x + the
    // audit_events precedent): INSERT one revision under A (a plain INSERT does
    // NOT trip the BEFORE UPDATE OR DELETE trigger, and satisfies the
    // schedule_revisions_tenant_insert policy), assert campass_app can read it
    // under A, assert B's context cannot see it (tenant isolation), then assert
    // UPDATE and DELETE are BOTH denied (REVOKE + trigger -> restrict_violation).
    // The row is removed here within THIS test's own trigger-disable scope so the
    // shared teardown is not blocked. This is the ONLY place the escape suite
    // touches schedule_revisions.
    const revId = `${PREFIX}SREV_A`;
    await withTenant(A.institutionId, (tx) =>
      tx.scheduleRevision.create({
        data: {
          id: revId,
          institutionId: A.institutionId,
          timetableId: A.timetableId,
          scheduledClassId: A.scheduledClassId,
          academicTermId: A.academicTermId,
          changeType: "TIMETABLE_PUBLISHED",
          newStatus: "PUBLISHED",
          actorUserId: A.userId,
        },
      }),
    );

    // Readable by campass_app under A's context.
    const readBack = await withTenant(A.institutionId, (tx) =>
      tx.scheduleRevision.findUnique({ where: { id: revId } }),
    );
    expect(readBack).toBeTruthy();

    // Cross-tenant SELECT from B's context returns empty (tenant isolation).
    const foreign = await withTenant(B.institutionId, (tx) =>
      tx.scheduleRevision.findUnique({ where: { id: revId } }),
    );
    expect(foreign).toBeNull();

    // UPDATE denied (REVOKE UPDATE + the BEFORE UPDATE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.scheduleRevision.update({ where: { id: revId }, data: { reason: "mutate" } }),
      ),
    ).rejects.toBeTruthy();

    // DELETE denied (REVOKE DELETE + the BEFORE DELETE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.scheduleRevision.delete({ where: { id: revId } }),
      ),
    ).rejects.toBeTruthy();

    // The row survived both attempts.
    const still = await adminClient.scheduleRevision.findUnique({ where: { id: revId } });
    expect(still).toBeTruthy();

    // Clean up this suite-local revision row within a scoped trigger-disable so
    // the shared teardown's timetable/scheduled_class deletes are not blocked by
    // a lingering append-only row.
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "schedule_revisions" DISABLE TRIGGER "schedule_revisions_no_update_delete"`,
    );
    try {
      await adminClient.scheduleRevision.deleteMany({
        where: { institutionId: { startsWith: PREFIX } },
      });
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "schedule_revisions" ENABLE TRIGGER "schedule_revisions_no_update_delete"`,
      );
    }
  }, 60_000);

  // ─── Phase-4 attendance tables (design §9/§10) ─────────────────────────────
  // attendance_sessions / attendance_records / attendance_corrections (the three
  // mutable tables): cross-tenant read denied, spoofed/cross-tenant write denied,
  // foreign-parent composite-FK violation (incl. the three-column term FK),
  // buggy-query backstop, three-GUC-state fail-closed. The append-only
  // attendance_record_history table is covered by its own self-contained case
  // (3kk) + the policy meta-test — it is NOT seeded in the shared setup (its
  // trigger blocks the shared teardown).

  it("3gg. attendance read escape: tenant A cannot see tenant B's Phase-4 rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const session = await withTenant(A.institutionId, (tx) =>
      tx.attendanceSession.findUnique({ where: { id: B.attendanceSessionId } }),
    );
    expect(session).toBeNull();

    const record = await withTenant(A.institutionId, (tx) =>
      tx.attendanceRecord.findUnique({ where: { id: B.attendanceRecordId } }),
    );
    expect(record).toBeNull();

    const correction = await withTenant(A.institutionId, (tx) =>
      tx.attendanceCorrection.findUnique({ where: { id: B.attendanceCorrectionId } }),
    );
    expect(correction).toBeNull();

    // Unscoped lists under A still return only A's rows, never B's.
    const ownSessions = await withTenant(A.institutionId, (tx) => tx.attendanceSession.findMany({}));
    expect(ownSessions.length).toBeGreaterThan(0);
    for (const row of ownSessions) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.attendanceSessionId);
    }
  }, 60_000);

  it("3hh. attendance spoofed insert: A cannot stamp a session institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.attendanceSession.create({
          data: {
            id: `${PREFIX}SPOOF_ASESSION`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            scheduledClassId: B.scheduledClassId,
            academicTermId: B.academicTermId,
            date: new Date("2026-11-09T00:00:00.000Z"),
            status: "OPEN",
            markedByFacultyId: B.facultyProfileId,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3ii. attendance foreign-parent: A cannot create a record referencing B's session", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, attendanceSessionId) makes it
    // physically impossible to reference B's session under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.attendanceRecord.create({
          data: {
            id: `${PREFIX}FOREIGN_AREC`,
            institutionId: A.institutionId,
            attendanceSessionId: B.attendanceSessionId, // B's session under A's tenant
            studentId: A.studentProfileId,
            status: "PRESENT",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3jj. attendance term-integrity: the three-column session->class->term FK rejects a tampered academicTermId", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The session->class link is a three-column FK
    // (institutionId, scheduledClassId, academicTermId) -> scheduled_classes.
    // A's scheduled class belongs to A's term; pairing it with B's term (even
    // within A's tenant) violates the FK, so a denormalized-term mismatch is
    // impossible by construction (design §3.2, MEDIUM-4).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.attendanceSession.create({
          data: {
            id: `${PREFIX}TAMPER_TERM`,
            institutionId: A.institutionId,
            scheduledClassId: A.scheduledClassId,
            academicTermId: B.academicTermId, // not A's scheduled class's term
            date: new Date("2026-11-16T00:00:00.000Z"),
            status: "OPEN",
            markedByFacultyId: A.facultyProfileId,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3jk. attendance buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const sessions = await withTenant(A.institutionId, (tx) => tx.attendanceSession.findMany({}));
    for (const r of sessions) expect(r.institutionId).toBe(A.institutionId);
    expect(sessions.some((r: { id: string }) => r.id === B.attendanceSessionId)).toBe(false);

    const records = await withTenant(A.institutionId, (tx) => tx.attendanceRecord.findMany({}));
    for (const r of records) expect(r.institutionId).toBe(A.institutionId);
    expect(records.some((r: { id: string }) => r.id === B.attendanceRecordId)).toBe(false);

    const corrections = await withTenant(A.institutionId, (tx) => tx.attendanceCorrection.findMany({}));
    for (const r of corrections) expect(r.institutionId).toBe(A.institutionId);
    expect(corrections.some((r: { id: string }) => r.id === B.attendanceCorrectionId)).toBe(false);

    const aCount = await adminClient.attendanceSession.count({
      where: { institutionId: A.institutionId },
    });
    expect(sessions.length).toBe(aCount);
  }, 60_000);

  it("3jl. attendance fail-closed: unset / empty-string GUC yield zero rows for every mutable table", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetSessions = await appClient.attendanceSession.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetSessions.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows (all three tables)
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const s = await tx.attendanceSession.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const r = await tx.attendanceRecord.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const c = await tx.attendanceCorrection.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return s.length + r.length + c.length;
    });
    expect(empty).toBe(0);

    // (iii) A's own rows ARE visible under A's GUC (the complementary direction).
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.attendanceSession.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.attendanceSessionId)).toBe(true);
  }, 60_000);

  it("3kk. attendance_record_history APPEND-ONLY (self-contained, one tenant): insert OK, cross-tenant SELECT empty, UPDATE/DELETE denied", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Self-contained (mirrors the schedule_revisions case 3ff + the audit_events
    // precedent): INSERT one history row under A (a plain INSERT does NOT trip the
    // BEFORE UPDATE OR DELETE trigger, and satisfies the
    // attendance_record_history_tenant_insert policy), assert campass_app can read
    // it under A, assert B's context cannot see it (tenant isolation), then assert
    // UPDATE and DELETE are BOTH denied (REVOKE + trigger -> restrict_violation).
    // The row is removed here within THIS test's own trigger-disable scope so the
    // shared teardown is not blocked. This is the ONLY place the escape suite
    // touches attendance_record_history.
    const histId = `${PREFIX}AHIST_A`;
    await withTenant(A.institutionId, (tx) =>
      tx.attendanceRecordHistory.create({
        data: {
          id: histId,
          institutionId: A.institutionId,
          attendanceRecordId: A.attendanceRecordId,
          changeType: "MARKED",
          previousStatus: null,
          newStatus: "PRESENT",
          actorUserId: A.facultyUserId,
        },
      }),
    );

    // Readable by campass_app under A's context.
    const readBack = await withTenant(A.institutionId, (tx) =>
      tx.attendanceRecordHistory.findUnique({ where: { id: histId } }),
    );
    expect(readBack).toBeTruthy();

    // Cross-tenant SELECT from B's context returns empty (tenant isolation).
    const foreign = await withTenant(B.institutionId, (tx) =>
      tx.attendanceRecordHistory.findUnique({ where: { id: histId } }),
    );
    expect(foreign).toBeNull();

    // UPDATE denied (REVOKE UPDATE + the BEFORE UPDATE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.attendanceRecordHistory.update({ where: { id: histId }, data: { reason: "mutate" } }),
      ),
    ).rejects.toBeTruthy();

    // DELETE denied (REVOKE DELETE + the BEFORE DELETE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.attendanceRecordHistory.delete({ where: { id: histId } }),
      ),
    ).rejects.toBeTruthy();

    // The row survived both attempts.
    const still = await adminClient.attendanceRecordHistory.findUnique({ where: { id: histId } });
    expect(still).toBeTruthy();

    // Clean up this suite-local history row within a scoped trigger-disable so the
    // shared teardown's attendance_records delete is not blocked by a lingering
    // append-only row.
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "attendance_record_history" DISABLE TRIGGER "attendance_record_history_no_update_delete"`,
    );
    try {
      await adminClient.attendanceRecordHistory.deleteMany({
        where: { institutionId: { startsWith: PREFIX } },
      });
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "attendance_record_history" ENABLE TRIGGER "attendance_record_history_no_update_delete"`,
      );
    }
  }, 60_000);

  // ─── Phase-5 library tables (design §3) ────────────────────────────────────
  // book_titles / book_copies / library_loans / book_reservations / library_fines
  // (the five mutable tables): cross-tenant read denied, spoofed/cross-tenant
  // write denied, foreign-parent composite-FK violation, buggy-query backstop,
  // three-GUC-state fail-closed, and a report-scope check (a cross-tenant sum
  // never leaks). No append-only library table exists this phase.

  it("3ll. library read escape: tenant A cannot see tenant B's library rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const title = await withTenant(A.institutionId, (tx) =>
      tx.bookTitle.findUnique({ where: { id: B.bookTitleId } }),
    );
    expect(title).toBeNull();

    const copy = await withTenant(A.institutionId, (tx) =>
      tx.bookCopy.findUnique({ where: { id: B.bookCopyId } }),
    );
    expect(copy).toBeNull();

    const loan = await withTenant(A.institutionId, (tx) =>
      tx.libraryLoan.findUnique({ where: { id: B.libraryLoanId } }),
    );
    expect(loan).toBeNull();

    const reservation = await withTenant(A.institutionId, (tx) =>
      tx.bookReservation.findUnique({ where: { id: B.bookReservationId } }),
    );
    expect(reservation).toBeNull();

    const fine = await withTenant(A.institutionId, (tx) =>
      tx.libraryFine.findUnique({ where: { id: B.libraryFineId } }),
    );
    expect(fine).toBeNull();

    // Unscoped lists under A still return only A's rows, never B's.
    const ownTitles = await withTenant(A.institutionId, (tx) => tx.bookTitle.findMany({}));
    expect(ownTitles.length).toBeGreaterThan(0);
    for (const row of ownTitles) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.bookTitleId);
    }
  }, 60_000);

  it("3mm. library spoofed insert: A cannot stamp a title institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.bookTitle.create({
          data: {
            id: `${PREFIX}SPOOF_BTITLE`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            title: `${PREFIX}SPOOF Title`,
            author: `${PREFIX}SPOOF Author`,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3nn. library foreign-parent: A cannot register a copy referencing B's title", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, bookTitleId) makes it
    // physically impossible to reference B's title under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.bookCopy.create({
          data: {
            id: `${PREFIX}FOREIGN_BCOPY`,
            institutionId: A.institutionId,
            bookTitleId: B.bookTitleId, // B's title under A's tenant
            accessionNumber: `${PREFIX}FOREIGN_ACC`,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3oo. library foreign-parent: A cannot create a loan referencing B's student", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // library_loans.(institutionId, studentId) composite FK forbids lending to
    // another tenant's student — the single-identity guarantee (design §3).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.libraryLoan.create({
          data: {
            id: `${PREFIX}FOREIGN_LLOAN`,
            institutionId: A.institutionId,
            bookCopyId: A.bookCopyReservedId,
            studentId: B.studentProfileId, // B's student under A's tenant
            issuedByUserId: A.userId,
            issueDate: new Date(),
            dueDate: new Date(Date.now() + 14 * 24 * 3600_000),
            status: "ACTIVE",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3pp. library spoofed update: A cannot flip B's fine to A's context", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Updating B's fine under A's context: RLS makes B's row invisible to A, so
    // the update matches zero rows, never mutates B.
    const result = await withTenant(A.institutionId, (tx) =>
      tx.libraryFine.updateMany({
        where: { id: B.libraryFineId },
        data: { status: "WAIVED" },
      }),
    );
    expect(result.count).toBe(0);

    const bRow = await adminClient.libraryFine.findUnique({ where: { id: B.libraryFineId } });
    expect(bRow!.status).toBe("PENDING");
  }, 60_000);

  it("3qq. library buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const copies = await withTenant(A.institutionId, (tx) => tx.bookCopy.findMany({}));
    for (const r of copies) expect(r.institutionId).toBe(A.institutionId);
    expect(copies.some((r: { id: string }) => r.id === B.bookCopyId)).toBe(false);

    const loans = await withTenant(A.institutionId, (tx) => tx.libraryLoan.findMany({}));
    for (const r of loans) expect(r.institutionId).toBe(A.institutionId);
    expect(loans.some((r: { id: string }) => r.id === B.libraryLoanId)).toBe(false);

    const reservations = await withTenant(A.institutionId, (tx) => tx.bookReservation.findMany({}));
    for (const r of reservations) expect(r.institutionId).toBe(A.institutionId);
    expect(reservations.some((r: { id: string }) => r.id === B.bookReservationId)).toBe(false);

    const fines = await withTenant(A.institutionId, (tx) => tx.libraryFine.findMany({}));
    for (const r of fines) expect(r.institutionId).toBe(A.institutionId);
    expect(fines.some((r: { id: string }) => r.id === B.libraryFineId)).toBe(false);

    const aCount = await adminClient.bookCopy.count({ where: { institutionId: A.institutionId } });
    expect(copies.length).toBe(aCount);
  }, 60_000);

  it("3rr. library report-scope: a PENDING-fine sum under A never includes B's fine", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The GET /reports/summary outstanding-fines aggregate runs inside withTenant;
    // prove the underlying RLS-scoped aggregate sums only A's PENDING fines, never
    // crossing into B's (both tenants seeded one PENDING fine of 5.00).
    const aSum = await withTenant(A.institutionId, (tx) =>
      tx.libraryFine.aggregate({ where: { status: "PENDING" }, _sum: { amount: true } }),
    );
    const total = aSum._sum.amount ? Number(aSum._sum.amount.toString()) : 0;
    expect(total).toBe(5); // exactly A's one fine, not 10 (A + B)

    // And A cannot see B's fine row directly.
    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.libraryFine.findUnique({ where: { id: B.libraryFineId } }),
    );
    expect(foreign).toBeNull();
  }, 60_000);

  it("3ss. library fail-closed: unset / empty-string GUC yield zero rows for every library table", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetTitles = await appClient.bookTitle.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetTitles.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows (all five tables)
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const t = await tx.bookTitle.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const c = await tx.bookCopy.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const l = await tx.libraryLoan.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const r = await tx.bookReservation.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const f = await tx.libraryFine.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return t.length + c.length + l.length + r.length + f.length;
    });
    expect(empty).toBe(0);

    // (iii) A's own rows ARE visible under A's GUC (the complementary direction).
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.bookTitle.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.bookTitleId)).toBe(true);
  }, 60_000);

  // ─── FEAT-004 Phase-6 admissions tables (design §5) ────────────────────────
  // admission_campaigns / admission_campaign_programs / applications /
  // application_documents / admission_offers / enrollments (the six mutable
  // tables): cross-tenant read denied, spoofed/cross-tenant write denied,
  // foreign-parent composite-FK violation, buggy-query backstop, three-GUC-state
  // fail-closed. The append-only application_reviews table is covered by its own
  // self-contained case (3zz) + the policy meta-test — it is NOT seeded in the
  // shared setup (its trigger blocks the shared teardown).

  it("3tt. admissions read escape: tenant A cannot see tenant B's Phase-6 rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const campaign = await withTenant(A.institutionId, (tx) =>
      tx.admissionCampaign.findUnique({ where: { id: B.admissionCampaignId } }),
    );
    expect(campaign).toBeNull();

    const join = await withTenant(A.institutionId, (tx) =>
      tx.admissionCampaignProgram.findUnique({ where: { id: B.admissionCampaignProgramId } }),
    );
    expect(join).toBeNull();

    const application = await withTenant(A.institutionId, (tx) =>
      tx.application.findUnique({ where: { id: B.applicationId } }),
    );
    expect(application).toBeNull();

    const doc = await withTenant(A.institutionId, (tx) =>
      tx.applicationDocument.findUnique({ where: { id: B.applicationDocumentId } }),
    );
    expect(doc).toBeNull();

    const offer = await withTenant(A.institutionId, (tx) =>
      tx.admissionOffer.findUnique({ where: { id: B.admissionOfferId } }),
    );
    expect(offer).toBeNull();

    const enrollment = await withTenant(A.institutionId, (tx) =>
      tx.enrollment.findUnique({ where: { id: B.enrollmentId } }),
    );
    expect(enrollment).toBeNull();

    // Unscoped lists under A still return only A's rows, never B's.
    const ownApplications = await withTenant(A.institutionId, (tx) => tx.application.findMany({}));
    expect(ownApplications.length).toBeGreaterThan(0);
    for (const row of ownApplications) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.applicationId);
    }
  }, 60_000);

  it("3uu. admissions spoofed insert: A cannot stamp a campaign institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.admissionCampaign.create({
          data: {
            id: `${PREFIX}SPOOF_CAMP`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            name: `${PREFIX}SPOOF Campaign`,
            status: "OPEN",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3vv. admissions foreign-parent: A cannot create an application referencing B's campaign", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, campaignId) makes it
    // physically impossible to reference B's campaign under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.application.create({
          data: {
            id: `${PREFIX}FOREIGN_APP`,
            institutionId: A.institutionId,
            campaignId: B.admissionCampaignId, // B's campaign under A's tenant
            applicantUserId: A.userId,
            programId: A.programId,
            status: "DRAFT",
            applicationNumber: `${PREFIX}FOREIGN_APPNO`,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3ww. admissions foreign-parent: A cannot enroll B's studentProfile under A's tenant", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // enrollments.(institutionId, studentProfileId) composite FK forbids linking
    // another tenant's student — the single-identity guarantee (design §4).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.enrollment.create({
          data: {
            id: `${PREFIX}FOREIGN_ENR`,
            institutionId: A.institutionId,
            applicationId: A.applicationId,
            studentProfileId: B.studentProfileId, // B's student under A's tenant
            academicSessionId: A.academicSessionId,
            enrolledByUserId: A.userId,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3xx. admissions spoofed update: A cannot flip B's offer to A's context", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Updating B's offer under A's context: RLS makes B's row invisible to A, so
    // the update matches zero rows, never mutates B.
    const result = await withTenant(A.institutionId, (tx) =>
      tx.admissionOffer.updateMany({
        where: { id: B.admissionOfferId },
        data: { status: "DECLINED" },
      }),
    );
    expect(result.count).toBe(0);

    const bRow = await adminClient.admissionOffer.findUnique({
      where: { id: B.admissionOfferId },
    });
    expect(bRow!.status).toBe("ISSUED");
  }, 60_000);

  it("3yy. admissions buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const campaigns = await withTenant(A.institutionId, (tx) => tx.admissionCampaign.findMany({}));
    for (const r of campaigns) expect(r.institutionId).toBe(A.institutionId);
    expect(campaigns.some((r: { id: string }) => r.id === B.admissionCampaignId)).toBe(false);

    const joins = await withTenant(A.institutionId, (tx) => tx.admissionCampaignProgram.findMany({}));
    for (const r of joins) expect(r.institutionId).toBe(A.institutionId);
    expect(joins.some((r: { id: string }) => r.id === B.admissionCampaignProgramId)).toBe(false);

    const applications = await withTenant(A.institutionId, (tx) => tx.application.findMany({}));
    for (const r of applications) expect(r.institutionId).toBe(A.institutionId);
    expect(applications.some((r: { id: string }) => r.id === B.applicationId)).toBe(false);

    const docs = await withTenant(A.institutionId, (tx) => tx.applicationDocument.findMany({}));
    for (const r of docs) expect(r.institutionId).toBe(A.institutionId);
    expect(docs.some((r: { id: string }) => r.id === B.applicationDocumentId)).toBe(false);

    const offers = await withTenant(A.institutionId, (tx) => tx.admissionOffer.findMany({}));
    for (const r of offers) expect(r.institutionId).toBe(A.institutionId);
    expect(offers.some((r: { id: string }) => r.id === B.admissionOfferId)).toBe(false);

    const enrollments = await withTenant(A.institutionId, (tx) => tx.enrollment.findMany({}));
    for (const r of enrollments) expect(r.institutionId).toBe(A.institutionId);
    expect(enrollments.some((r: { id: string }) => r.id === B.enrollmentId)).toBe(false);

    const aCount = await adminClient.application.count({
      where: { institutionId: A.institutionId },
    });
    expect(applications.length).toBe(aCount);
  }, 60_000);

  it("3zza. admissions fail-closed: unset / empty-string GUC yield zero rows for every mutable table", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetCampaigns = await appClient.admissionCampaign.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetCampaigns.length).toBe(0);
    const unsetApplications = await appClient.application.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetApplications.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows (all six tables)
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const c = await tx.admissionCampaign.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const j = await tx.admissionCampaignProgram.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const a = await tx.application.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const d = await tx.applicationDocument.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const o = await tx.admissionOffer.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const e = await tx.enrollment.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return c.length + j.length + a.length + d.length + o.length + e.length;
    });
    expect(empty).toBe(0);

    // (iii) A's own rows ARE visible under A's GUC (the complementary direction).
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.application.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.applicationId)).toBe(true);
  }, 60_000);

  it("3zz. application_reviews APPEND-ONLY (self-contained, one tenant): insert OK, cross-tenant SELECT empty, UPDATE/DELETE denied", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Self-contained (mirrors the schedule_revisions / attendance_record_history
    // cases + the audit_events precedent): INSERT one review under A against the
    // ALREADY-seeded application (a plain INSERT does NOT trip the BEFORE UPDATE
    // OR DELETE trigger, and satisfies the application_reviews_tenant_insert
    // policy), assert campass_app can read it under A, assert B's context cannot
    // see it (tenant isolation), then assert UPDATE and DELETE are BOTH denied
    // (REVOKE + trigger -> restrict_violation). The row is removed here within
    // THIS test's own trigger-disable scope so the shared teardown is not blocked.
    // This is the ONLY place the escape suite touches application_reviews.
    const reviewId = `${PREFIX}AREV_A`;
    await withTenant(A.institutionId, (tx) =>
      tx.applicationReview.create({
        data: {
          id: reviewId,
          institutionId: A.institutionId,
          applicationId: A.applicationId,
          reviewerUserId: A.userId,
          decision: "RECOMMEND_ELIGIBLE",
          notes: `${PREFIX}note`,
        },
      }),
    );

    // Readable by campass_app under A's context.
    const readBack = await withTenant(A.institutionId, (tx) =>
      tx.applicationReview.findUnique({ where: { id: reviewId } }),
    );
    expect(readBack).toBeTruthy();

    // Cross-tenant SELECT from B's context returns empty (tenant isolation).
    const foreign = await withTenant(B.institutionId, (tx) =>
      tx.applicationReview.findUnique({ where: { id: reviewId } }),
    );
    expect(foreign).toBeNull();

    // UPDATE denied (REVOKE UPDATE + the BEFORE UPDATE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.applicationReview.update({ where: { id: reviewId }, data: { notes: "mutate" } }),
      ),
    ).rejects.toBeTruthy();

    // DELETE denied (REVOKE DELETE + the BEFORE DELETE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.applicationReview.delete({ where: { id: reviewId } }),
      ),
    ).rejects.toBeTruthy();

    // The row survived both attempts.
    const still = await adminClient.applicationReview.findUnique({ where: { id: reviewId } });
    expect(still).toBeTruthy();

    // Clean up this suite-local review row within a scoped trigger-disable so the
    // shared teardown's applications delete is not blocked by a lingering
    // append-only row.
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "application_reviews" DISABLE TRIGGER "application_reviews_no_update_delete"`,
    );
    try {
      await adminClient.applicationReview.deleteMany({
        where: { institutionId: { startsWith: PREFIX } },
      });
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "application_reviews" ENABLE TRIGGER "application_reviews_no_update_delete"`,
      );
    }
  }, 60_000);

  // ─── FEAT-004 Phase-7 fees tables (design §D.2/§D.3/§D.4) ──────────────────
  // fee_structures / fee_components / student_charges / payment_transactions (the
  // four mutable/guarded tables): cross-tenant read denied, spoofed/cross-tenant
  // write denied, foreign-parent composite-FK violation, buggy-query backstop,
  // three-GUC-state fail-closed. The three fully append-only tables
  // (payment_allocations, receipts, processed_webhook_events) are covered by
  // their own self-contained cases (3fj) + the policy meta-test — they are NOT
  // seeded in the shared setup (their trigger blocks the shared teardown).

  it("3fa. fees read escape: tenant A cannot see tenant B's fee rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const structure = await withTenant(A.institutionId, (tx) =>
      tx.feeStructure.findUnique({ where: { id: B.feeStructureId } }),
    );
    expect(structure).toBeNull();

    const component = await withTenant(A.institutionId, (tx) =>
      tx.feeComponent.findUnique({ where: { id: B.feeComponentId } }),
    );
    expect(component).toBeNull();

    const charge = await withTenant(A.institutionId, (tx) =>
      tx.studentCharge.findUnique({ where: { id: B.studentChargeId } }),
    );
    expect(charge).toBeNull();

    const txn = await withTenant(A.institutionId, (tx) =>
      tx.paymentTransaction.findUnique({ where: { id: B.paymentTransactionId } }),
    );
    expect(txn).toBeNull();

    // Unscoped lists under A still return only A's rows, never B's.
    const ownStructures = await withTenant(A.institutionId, (tx) => tx.feeStructure.findMany({}));
    expect(ownStructures.length).toBeGreaterThan(0);
    for (const row of ownStructures) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.feeStructureId);
    }
  }, 60_000);

  it("3fb. fees spoofed insert: A cannot stamp a fee structure institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.feeStructure.create({
          data: {
            id: `${PREFIX}SPOOF_FEESTRUCT`,
            institutionId: B.institutionId, // spoof: claim to belong to B
            name: `${PREFIX}SPOOF Structure`,
            status: "ACTIVE",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3fc. fees foreign-parent: A cannot create a component referencing B's structure", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // The composite same-tenant FK (institutionId, feeStructureId) makes it
    // physically impossible to reference B's structure under A's tenant.
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.feeComponent.create({
          data: {
            id: `${PREFIX}FOREIGN_FEECOMP`,
            institutionId: A.institutionId,
            feeStructureId: B.feeStructureId, // B's structure under A's tenant
            category: "LAB",
            amountPaise: 100000n,
            currency: "INR",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3fd. fees foreign-parent: A cannot post a charge referencing B's student", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // student_charges.(institutionId, studentId) composite FK forbids charging
    // another tenant's student — the single-identity guarantee (design §D.2).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.studentCharge.create({
          data: {
            id: `${PREFIX}FOREIGN_CHARGE`,
            institutionId: A.institutionId,
            studentId: B.studentProfileId, // B's student under A's tenant
            category: "TUITION",
            amountPaise: 100000n,
            currency: "INR",
            description: `${PREFIX}foreign-parent charge`,
            status: "PENDING",
            postedByUserId: A.userId,
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3fe. fees spoofed update: A cannot flip B's fee structure to A's context", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Updating B's structure under A's context: RLS makes B's row invisible to A,
    // so the update matches zero rows, never mutates B.
    const result = await withTenant(A.institutionId, (tx) =>
      tx.feeStructure.updateMany({
        where: { id: B.feeStructureId },
        data: { status: "ARCHIVED" },
      }),
    );
    expect(result.count).toBe(0);

    const bRow = await adminClient.feeStructure.findUnique({ where: { id: B.feeStructureId } });
    expect(bRow!.status).toBe("ACTIVE");
  }, 60_000);

  it("3ff2. fees buggy-query backstop: unfiltered findMany under A returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const components = await withTenant(A.institutionId, (tx) => tx.feeComponent.findMany({}));
    for (const r of components) expect(r.institutionId).toBe(A.institutionId);
    expect(components.some((r: { id: string }) => r.id === B.feeComponentId)).toBe(false);

    const charges = await withTenant(A.institutionId, (tx) => tx.studentCharge.findMany({}));
    for (const r of charges) expect(r.institutionId).toBe(A.institutionId);
    expect(charges.some((r: { id: string }) => r.id === B.studentChargeId)).toBe(false);

    const txns = await withTenant(A.institutionId, (tx) => tx.paymentTransaction.findMany({}));
    for (const r of txns) expect(r.institutionId).toBe(A.institutionId);
    expect(txns.some((r: { id: string }) => r.id === B.paymentTransactionId)).toBe(false);

    const aCount = await adminClient.studentCharge.count({
      where: { institutionId: A.institutionId },
    });
    expect(charges.length).toBe(aCount);
  }, 60_000);

  it("3fg. fees fail-closed: unset / empty-string GUC yield zero rows for every mutable table", async () => {
    // (i) no tenant context set => GUC unset => NULL => no rows
    const unsetStructures = await appClient.feeStructure.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetStructures.length).toBe(0);
    const unsetTxns = await appClient.paymentTransaction.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(unsetTxns.length).toBe(0);

    // (ii) empty-string GUC => nullif(...,'') => NULL => no rows (all four tables)
    const empty = await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const s = await tx.feeStructure.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const c = await tx.feeComponent.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const ch = await tx.studentCharge.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      const t = await tx.paymentTransaction.findMany({ where: { institutionId: { startsWith: PREFIX } } });
      return s.length + c.length + ch.length + t.length;
    });
    expect(empty).toBe(0);

    // (iii) A's own rows ARE visible under A's GUC (the complementary direction).
    const A = seeded.A!;
    const aVisible = await withTenant(A.institutionId, (tx) => tx.feeStructure.findMany({}));
    expect(aVisible.some((r: { id: string }) => r.id === A.feeStructureId)).toBe(true);
  }, 60_000);

  it("3fj. fees append-only tables (self-contained, one tenant): insert OK via webhook path cols, cross-tenant SELECT empty, UPDATE/DELETE denied", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // Self-contained (mirrors the application_reviews / schedule_revisions cases +
    // the audit_events precedent): INSERT one row into EACH of the three fully
    // append-only fees tables under A (a plain INSERT does NOT trip the BEFORE
    // UPDATE OR DELETE trigger, and satisfies the <table>_tenant_insert policy),
    // assert campass_app can read each under A, assert B's context cannot see them
    // (tenant isolation), then assert UPDATE and DELETE are BOTH denied (REVOKE +
    // trigger -> restrict_violation). The rows are removed here within THIS test's
    // own trigger-disable scope so the shared teardown is not blocked. This is the
    // ONLY place the escape suite touches these three tables.
    const allocId = `${PREFIX}ALLOC_A`;
    const receiptId = `${PREFIX}RECEIPT_A`;
    const eventId = `${PREFIX}PWE_A`;

    // payment_allocations references the seeded payment_transactions + student_charge.
    await withTenant(A.institutionId, (tx) =>
      tx.paymentAllocation.create({
        data: {
          id: allocId,
          institutionId: A.institutionId,
          paymentTransactionId: A.paymentTransactionId,
          studentChargeId: A.studentChargeId,
          amountPaise: 100000n,
          currency: "INR",
        },
      }),
    );
    // receipts references the seeded payment_transactions.
    await withTenant(A.institutionId, (tx) =>
      tx.receipt.create({
        data: {
          id: receiptId,
          institutionId: A.institutionId,
          paymentTransactionId: A.paymentTransactionId,
          receiptNumber: `${PREFIX}RCPT_A`,
          sequence: 1,
          amountPaise: 100000n,
          currency: "INR",
        },
      }),
    );
    // processed_webhook_events (the idempotency ledger). razorpayEventId has a
    // GLOBAL unique, so use the PREFIX-scoped id to avoid collisions.
    await withTenant(A.institutionId, (tx) =>
      tx.processedWebhookEvent.create({
        data: {
          id: eventId,
          institutionId: A.institutionId,
          razorpayEventId: `${PREFIX}evt_A`,
          eventType: "payment.captured",
          paymentTransactionId: A.paymentTransactionId,
        },
      }),
    );

    // Readable by campass_app under A's context.
    expect(
      await withTenant(A.institutionId, (tx) =>
        tx.paymentAllocation.findUnique({ where: { id: allocId } }),
      ),
    ).toBeTruthy();
    expect(
      await withTenant(A.institutionId, (tx) => tx.receipt.findUnique({ where: { id: receiptId } })),
    ).toBeTruthy();
    expect(
      await withTenant(A.institutionId, (tx) =>
        tx.processedWebhookEvent.findUnique({ where: { id: eventId } }),
      ),
    ).toBeTruthy();

    // Cross-tenant SELECT from B's context returns empty (tenant isolation).
    expect(
      await withTenant(B.institutionId, (tx) =>
        tx.paymentAllocation.findUnique({ where: { id: allocId } }),
      ),
    ).toBeNull();
    expect(
      await withTenant(B.institutionId, (tx) => tx.receipt.findUnique({ where: { id: receiptId } })),
    ).toBeNull();
    expect(
      await withTenant(B.institutionId, (tx) =>
        tx.processedWebhookEvent.findUnique({ where: { id: eventId } }),
      ),
    ).toBeNull();

    // UPDATE + DELETE denied on all three (REVOKE + the BEFORE UPDATE OR DELETE trigger).
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.paymentAllocation.update({ where: { id: allocId }, data: { amountPaise: 1n } }),
      ),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.paymentAllocation.delete({ where: { id: allocId } }),
      ),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.receipt.update({ where: { id: receiptId }, data: { amountPaise: 1n } }),
      ),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(A.institutionId, (tx) => tx.receipt.delete({ where: { id: receiptId } })),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.processedWebhookEvent.update({ where: { id: eventId }, data: { eventType: "x" } }),
      ),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.processedWebhookEvent.delete({ where: { id: eventId } }),
      ),
    ).rejects.toBeTruthy();

    // The rows survived every attempt.
    expect(await adminClient.paymentAllocation.findUnique({ where: { id: allocId } })).toBeTruthy();
    expect(await adminClient.receipt.findUnique({ where: { id: receiptId } })).toBeTruthy();
    expect(
      await adminClient.processedWebhookEvent.findUnique({ where: { id: eventId } }),
    ).toBeTruthy();

    // Clean up these suite-local rows within a scoped trigger-disable so the
    // shared teardown's payment_transactions/student_charges deletes are not
    // blocked by a lingering append-only child row.
    for (const table of [
      "payment_allocations",
      "receipts",
      "processed_webhook_events",
    ] as const) {
      const trigger = `${table}_no_update_delete`;
      await adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
    try {
      await adminClient.paymentAllocation.deleteMany({ where: { institutionId: { startsWith: PREFIX } } });
      await adminClient.receipt.deleteMany({ where: { institutionId: { startsWith: PREFIX } } });
      await adminClient.processedWebhookEvent.deleteMany({ where: { institutionId: { startsWith: PREFIX } } });
    } finally {
      for (const table of [
        "payment_allocations",
        "receipts",
        "processed_webhook_events",
      ] as const) {
        const trigger = `${table}_no_update_delete`;
        await adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      }
    }
  }, 60_000);

  it("4. HEADLINE: a deliberately buggy query that forgets the tenant filter still returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // No where clause at all — the app "forgot" to scope. RLS is the backstop.
    const rows = await withTenant(A.institutionId, (tx) =>
      tx.gatePass.findMany({}),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.institutionId).toBe(A.institutionId);
    }
    // None of B's rows leaked.
    expect(rows.some((r: { id: string }) => r.id === B.gatePassId)).toBe(false);

    // And it matches exactly A's seeded count (verified independently via admin).
    const aCount = await adminClient.gatePass.count({
      where: { institutionId: A.institutionId },
    });
    expect(rows.length).toBe(aCount);
  }, 60_000);

  it("5. fail-closed: a query with no tenant context set returns zero rows", async () => {
    // appClient outside withTenant => app.current_institution_id unset => NULL => no rows.
    const rows = await appClient.gatePass.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(rows.length).toBe(0);
  }, 60_000);

  it("6. meta: every tenant-owned table has RLS enabled + forced and both policies", async () => {
    const rls = await adminClient.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      RLS_TABLES as unknown as string[],
    );

    const byName = new Map(rls.map((r) => [r.relname, r]));
    for (const table of RLS_TABLES) {
      const row = byName.get(table);
      expect(row, `table ${table} missing from pg_class`).toBeTruthy();
      expect(row!.relrowsecurity, `RLS not ENABLED on ${table}`).toBe(true);
      expect(row!.relforcerowsecurity, `RLS not FORCED on ${table}`).toBe(true);
    }

    const policies = await adminClient.$queryRawUnsafe<
      { tablename: string; policyname: string }[]
    >(
      `SELECT tablename, policyname
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      RLS_TABLES as unknown as string[],
    );

    // Per-table expected-policy map (design §9.3): the two FEAT-003 tables carry
    // their own load-bearing policies, everything else the standard pair. No
    // inert *_platform_all policy is asserted (none is created).
    for (const table of RLS_TABLES) {
      const names = policies.filter((p) => p.tablename === table).map((p) => p.policyname);
      const expected = EXPECTED_POLICIES[table] ?? DEFAULT_POLICIES;
      for (const policy of expected) {
        expect(names, `${table} missing ${policy}`).toContain(policy);
      }
    }

    // Append-only tables must NOT carry a FOR-ALL modify policy (design §4.3):
    // their immutability is the INSERT-only policy + REVOKE + trigger. Assert the
    // revision table (and the audit_events precedent) have no tenant_isolation_modify.
    // FEAT-003: student_profile_history joins the append-only set (no modify
    // policy); student_documents is the standard pair (asserted via the
    // EXPECTED_POLICIES/DEFAULT_POLICIES loop above, so it IS expected to carry
    // tenant_isolation_modify).
    for (const table of [
      "academic_calendar_day_revisions",
      "audit_events",
      "student_profile_history",
      // FEAT-004: schedule_revisions joins the append-only set (design §6.9) —
      // INSERT-only policy + REVOKE + trigger, NO modify policy.
      "schedule_revisions",
      // Phase-4: attendance_record_history joins the append-only set (design §10).
      "attendance_record_history",
      // FEAT-004: application_reviews joins the append-only set (design §5) —
      // INSERT-only policy + REVOKE + trigger, NO modify policy.
      "application_reviews",
      // FEAT-004 Phase-7 fees: the three fully INSERT-only tables join the
      // append-only set (design §D.3) — INSERT-only policy + REVOKE + trigger, NO
      // modify policy. The four mutable/guarded fees tables (fee_structures,
      // fee_components, student_charges, payment_transactions) are NOT here — they
      // carry the standard modify pair (the column-guard triggers enforce
      // immutability at the row level, not via RLS), asserted by the
      // EXPECTED_POLICIES/DEFAULT_POLICIES loop above.
      "payment_allocations",
      "receipts",
      "processed_webhook_events",
    ]) {
      const names = policies.filter((p) => p.tablename === table).map((p) => p.policyname);
      expect(names, `${table} must NOT have a modify policy`).not.toContain(
        "tenant_isolation_modify",
      );
    }

    // And student_documents MUST carry the standard modify policy (it is a
    // normal mutable tenant-owned table, not append-only).
    const docPolicies = policies
      .filter((p) => p.tablename === "student_documents")
      .map((p) => p.policyname);
    expect(docPolicies, "student_documents must have the standard modify policy").toContain(
      "tenant_isolation_modify",
    );
  }, 60_000);
});
