/**
 * Phase-3 classes ROUTE / permission / audit integration suite (FEAT-003),
 * mirroring academics-routes.integration.test.ts: @campusgate/db is MOCKED
 * (deterministic, no live pooler) so the test pins the ROUTE-LAYER contract —
 * permission gating per role, the 409 conflict envelope, the success-plus-
 * warnings envelope, the cross-tenant not-found shape, and the recordAuditEvent
 * call shape. The real-DB guarantees (RLS, append-only revisions, history
 * preservation, the single StudentProfile identity) are proven by the
 * classes-behavioral real-DB suite; this suite proves the WIRING.
 *
 * It proves:
 *   - an ADMIN with classes.* can create a course and audits classes.course.created;
 *   - an HOD (manage within scope) can create a course; FACULTY/STUDENT get 403
 *     on a mutate (they hold only classes.view_own);
 *   - the 409 { error, conflicts } envelope on a double-booked faculty slot;
 *   - the 200/201 success-plus-warnings envelope on an out-of-hours slot;
 *   - a cross-tenant read (tenant tx sees nothing) is 404.
 */
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    session: { findFirst: vi.fn(), update: vi.fn() },
    program: { findFirst: vi.fn() },
    academicTerm: { findFirst: vi.fn() },
    academicSession: { findFirst: vi.fn() },
    department: { findFirst: vi.fn() },
    studentProfile: { findFirst: vi.fn() },
    course: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    subject: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    classSection: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    classEnrollment: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    facultyProfile: { findFirst: vi.fn(), create: vi.fn() },
    facultyAssignment: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    timetable: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    scheduledClass: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    scheduleRevision: { create: vi.fn() },
    institutionConfig: { findUnique: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@campusgate/shared";
import { classesRoutes } from "../classes.js";

type MockFn = ReturnType<typeof vi.fn>;
const m = prisma as unknown as Record<string, Record<string, MockFn>>;

type RoleKey = "ADMIN" | "HOD" | "FACULTY" | "STUDENT";

function membershipFor(roleKey: RoleKey, departmentScope: string | null = null) {
  return {
    id: `mbr-${roleKey}`,
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    departmentScope,
    roles: [
      {
        role: {
          key: roleKey,
          permissions: (ROLE_PERMISSIONS[roleKey] ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "classes-route-test-secret" });
  await app.register(classesRoutes, { prefix: "/api/classes" });
  return app;
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function token(app: Awaited<ReturnType<typeof makeApp>>, userId: string, role: RoleKey) {
  // The legacy `role` claim is a UserRole enum value; FACULTY is not one, so a
  // faculty user carries GUARD (design A3). The permission decision uses the
  // membership roles, not this claim.
  const legacyRole = role === "FACULTY" ? "GUARD" : role;
  return app.jwt.sign({ userId, role: legacyRole, institutionId: "inst-A" });
}

const USERS: Record<string, RoleKey> = {
  "u-admin": "ADMIN",
  "u-hod": "HOD",
  "u-faculty": "FACULTY",
  "u-student": "STUDENT",
};

describe("Phase-3 classes routes (permission + conflict + audit wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const role = USERS[where.id];
      if (!role) return null;
      const legacyRole = role === "FACULTY" ? "GUARD" : role;
      return { id: where.id, role: legacyRole, institutionId: "inst-A", accountStatus: "ACTIVE", institution: { status: "ACTIVE" } };
    });
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.institutionConfig.findUnique.mockResolvedValue({ workingDaysOfWeek: [1, 2, 3, 4, 5, 6] });
    m.scheduleRevision.create.mockResolvedValue({ id: "rev-1" });
    m.auditEvent.create.mockResolvedValue({});
  });

  it("the 7 classes.* permissions are catalogued; FACULTY/STUDENT hold ONLY classes.view_own", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const k of [
      "classes.courses.manage",
      "classes.sections.manage",
      "classes.enroll",
      "classes.faculty.assign",
      "classes.timetable.manage",
      "classes.view",
      "classes.view_own",
    ]) {
      expect(keys.has(k), `missing permission ${k}`).toBe(true);
      expect(ROLE_PERMISSIONS.ADMIN).toContain(k);
    }
    // FACULTY holds ONLY classes.view_own among the classes.* permissions (the
    // Phase-4 attendance.* grants on FACULTY are out of this namespace's scope).
    expect(ROLE_PERMISSIONS.FACULTY.filter((k) => k.startsWith("classes."))).toEqual([
      "classes.view_own",
    ]);
    expect(ROLE_PERMISSIONS.STUDENT).toContain("classes.view_own");
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain("classes.view");
  });

  it("ADMIN creates a course and the handler audits classes.course.created in-tx", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.program.findFirst.mockResolvedValue({ id: "prog-1" });
    m.course.findFirst.mockResolvedValue(null); // no code dup
    m.course.create.mockResolvedValue({ id: "course-1", code: "BCA-S1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/courses",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { programId: "prog-1", name: "BCA Core", code: "BCA-S1" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "course-1" });
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "classes.course.created", result: "SUCCESS", resourceId: "course-1" }) }),
    );
    await app.close();
  });

  it("HOD (manage within scope) can create a course for an in-scope program", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("HOD", "dept-A"));
    m.program.findFirst.mockResolvedValue({ id: "prog-A" });
    m.course.findFirst.mockResolvedValue(null);
    m.course.create.mockResolvedValue({ id: "course-h", code: "H-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/courses",
      headers: authHeader(token(app, "u-hod", "HOD")),
      payload: { programId: "prog-A", name: "Dept Course", code: "H-1" },
    });

    expect(res.statusCode).toBe(201);
    // The program lookup carried the HOD scope relation-filter.
    expect(m.program.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ departmentId: "dept-A" }) }),
    );
    await app.close();
  });

  it("FACULTY (classes.view_own only) is 403 on a course-manage mutate", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("FACULTY"));

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/courses",
      headers: authHeader(token(app, "u-faculty", "FACULTY")),
      payload: { programId: "prog-1", name: "x", code: "x" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("STUDENT (classes.view_own only) is 403 on an enroll mutate", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("STUDENT"));

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/enroll",
      headers: authHeader(token(app, "u-student", "STUDENT")),
      payload: { classSectionId: "sec-1", studentId: "stu-1" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("adding a double-booked faculty slot returns 409 with { error, conflicts }", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.timetable.findFirst.mockResolvedValue({ id: "tt-1", status: "DRAFT", academicTermId: "term-1" });
    m.classSection.findFirst.mockResolvedValue({ id: "sec-1" });
    m.subject.findFirst.mockResolvedValue({ id: "subj-1" });
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    // An existing SCHEDULED slot: same faculty, same day, overlapping window.
    m.scheduledClass.findMany.mockResolvedValue([
      {
        id: "sc-existing",
        classSectionId: "sec-other",
        facultyId: "fac-1",
        room: "R-1",
        dayOfWeek: "MON",
        date: null,
        startTime: 540,
        endTime: 600,
        status: "SCHEDULED",
      },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/scheduled-classes",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: {
        timetableId: "tt-1",
        classSectionId: "sec-1",
        subjectId: "subj-1",
        facultyId: "fac-1",
        academicTermId: "term-1",
        room: "R-2",
        dayOfWeek: "MON",
        startTime: 570,
        endTime: 630,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("Timetable conflict");
    expect(body.conflicts.blocking.some((c: { type: string }) => c.type === "FACULTY_DOUBLE_BOOKED")).toBe(true);
    // The slot was NOT written.
    expect(m.scheduledClass.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("adding an out-of-hours slot succeeds 201 with a non-blocking warnings envelope", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.timetable.findFirst.mockResolvedValue({ id: "tt-1", status: "DRAFT", academicTermId: "term-1" });
    m.classSection.findFirst.mockResolvedValue({ id: "sec-1" });
    m.subject.findFirst.mockResolvedValue({ id: "subj-1" });
    m.facultyProfile.findFirst.mockResolvedValue({ id: "fac-1" });
    m.scheduledClass.findMany.mockResolvedValue([]); // no overlap
    // SUN (0) is NOT in workingDaysOfWeek [1..6] -> OUT_OF_HOURS warning.
    m.institutionConfig.findUnique.mockResolvedValue({ workingDaysOfWeek: [1, 2, 3, 4, 5, 6] });
    m.scheduledClass.create.mockResolvedValue({ id: "sc-new", classSectionId: "sec-1", subjectId: "subj-1", facultyId: "fac-1", room: null, startTime: 540, endTime: 600, status: "SCHEDULED" });

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/scheduled-classes",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: {
        timetableId: "tt-1",
        classSectionId: "sec-1",
        subjectId: "subj-1",
        facultyId: "fac-1",
        academicTermId: "term-1",
        dayOfWeek: "SUN",
        startTime: 540,
        endTime: 600,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.scheduledClass.id).toBe("sc-new");
    expect(body.warnings.some((c: { type: string }) => c.type === "OUT_OF_HOURS")).toBe(true);
    expect(m.scheduledClass.create).toHaveBeenCalled();
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "classes.scheduled_class.added" }) }),
    );
    await app.close();
  });

  it("cross-tenant read: a course invisible to the tenant tx (findFirst null) is 404", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.course.findFirst.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/classes/courses/foreign-course-id",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("enroll references the shared StudentProfile and audits classes.enrollment.enrolled", async () => {
    const app = await makeApp();
    m.institutionMembership.findUnique.mockImplementation(() => membershipFor("ADMIN"));
    m.classSection.findFirst.mockResolvedValue({ id: "sec-1", capacity: 60 });
    m.user.findFirst.mockResolvedValue(null);
    // The single student identity is resolved on studentProfile (the shared row).
    m.classEnrollment.findFirst.mockResolvedValue(null);
    m.classEnrollment.count.mockResolvedValue(0);
    m.classEnrollment.create.mockResolvedValue({ id: "enr-1" });
    // The single student identity is resolved on the shared studentProfile row.
    m.studentProfile.findFirst.mockResolvedValue({ id: "stu-1", status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/api/classes/enroll",
      headers: authHeader(token(app, "u-admin", "ADMIN")),
      payload: { classSectionId: "sec-1", studentId: "stu-1" },
    });

    expect(res.statusCode).toBe(201);
    expect(m.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "classes.enrollment.enrolled", resourceId: "enr-1" }) }),
    );
    await app.close();
  });
});
