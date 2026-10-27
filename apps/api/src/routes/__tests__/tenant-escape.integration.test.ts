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
