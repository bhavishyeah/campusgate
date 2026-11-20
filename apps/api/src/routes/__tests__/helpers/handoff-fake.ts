/**
 * In-memory stand-in for the Prisma clients used by the admissions handoff:
 * a tenant client (rows of other institutions are invisible, like RLS) and an
 * owner client (sees everything). `withTenant` snapshots every table and restores
 * it when the callback throws, so rollback behaviour is observable.
 */
type Row = Record<string, any>;

export class UniqueError extends Error {
  code = "P2002";
  meta: { target: string[] };
  constructor(target: string[]) {
    super("Unique constraint failed");
    this.meta = { target };
  }
}

const TABLES = [
  "application",
  "enrollment",
  "admissionOffer",
  "admissionCampaign",
  "academicSession",
  "user",
  "institutionMembership",
  "role",
  "membershipRole",
  "program",
  "department",
  "studentProfile",
  "studentProfileHistory",
  "institution",
] as const;
type TableName = (typeof TABLES)[number];

const UNIQUES: Partial<Record<TableName, string[][]>> = {
  studentProfile: [["enrollmentNo"], ["userId"]],
  enrollment: [["institutionId", "applicationId"]],
  membershipRole: [["membershipId", "roleId"]],
  institutionMembership: [["userId", "institutionId"]],
};

export class HandoffDb {
  t: Record<string, Row[]> = {};
  seq = 0;
  rawCalls: unknown[][] = [];
  /** When set, the next create on this table throws a unique violation (race simulation). */
  failNextCreate: { table: TableName; target: string[] } | null = null;

  constructor() {
    this.reset();
  }

  reset() {
    this.t = {};
    for (const n of TABLES) this.t[n] = [];
    this.rawCalls = [];
    this.failNextCreate = null;
    this.t.role.push({ id: "role-student", key: "STUDENT", institutionId: null });
    this.t.role.push({ id: "role-applicant", key: "APPLICANT", institutionId: null });
    this.t.institution.push({ id: "inst-A", name: "Demo College", status: "ACTIVE" });
    this.t.institution.push({ id: "inst-B", name: "Other College", status: "ACTIVE" });
  }

  add(table: TableName, row: Row): Row {
    const r = { id: `${table}-${++this.seq}`, ...row };
    this.t[table].push(r);
    return r;
  }

  /** A realistic ACCEPTED application with offer, campaign, session, program, applicant and APPLICANT membership. */
  seedAccepted(inst = "inst-A", over: { passwordHash?: string | null; email?: string; programCode?: string; sessionStart?: Date | null; userRole?: string } = {}) {
    const n = ++this.seq;
    const dept = this.add("department", { institutionId: inst, name: "Computer Science" });
    const program = this.add("program", { institutionId: inst, departmentId: dept.id, name: "BCA", code: over.programCode ?? "BCA" });
    const session =
      over.sessionStart === null
        ? null
        : this.add("academicSession", { institutionId: inst, name: "2024-25", startDate: over.sessionStart ?? new Date("2024-07-01T00:00:00Z") });
    const campaign = this.add("admissionCampaign", { institutionId: inst, intakeSessionId: session?.id ?? null });
    const user = this.add("user", {
      institutionId: inst,
      email: over.email ?? `applicant${n}@demo.edu`,
      passwordHash: over.passwordHash === undefined ? "hash" : over.passwordHash,
      role: over.userRole ?? "STUDENT",
      accountStatus: "ACTIVE",
    });
    const membership = this.add("institutionMembership", {
      userId: user.id,
      institutionId: inst,
      membershipStatus: "ACTIVE",
      permissionsVersion: 0,
    });
    this.add("membershipRole", { membershipId: membership.id, roleId: "role-applicant", institutionId: inst });
    const application = this.add("application", {
      institutionId: inst,
      campaignId: campaign.id,
      applicantUserId: user.id,
      status: "ACCEPTED",
      formData: { name: "Asha Rao" },
      programId: program.id,
    });
    const offer = this.add("admissionOffer", {
      institutionId: inst,
      applicationId: application.id,
      status: "ACCEPTED",
      offeredProgramId: program.id,
    });
    return { dept, program, session, campaign, user, membership, application, offer };
  }

  private matchValue(actual: any, cond: any): boolean {
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("startsWith" in cond) return typeof actual === "string" && actual.startsWith(cond.startsWith);
      if ("in" in cond) return cond.in.includes(actual);
      if ("not" in cond) return actual !== cond.not;
      return false;
    }
    if (cond === null) return actual === null || actual === undefined;
    return actual === cond;
  }

  private match(table: TableName, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === "userId_institutionId") return row.userId === v.userId && row.institutionId === v.institutionId;
      if (k === "membershipId_roleId") return row.membershipId === v.membershipId && row.roleId === v.roleId;
      if (table === "membershipRole" && k === "membership") {
        const mem = this.t.institutionMembership.find((m) => m.id === row.membershipId);
        return !!mem && this.match("institutionMembership", mem, v);
      }
      if (table === "membershipRole" && k === "role") {
        const role = this.t.role.find((r) => r.id === row.roleId);
        return !!role && this.match("role", role, v);
      }
      return this.matchValue(row[k], v);
    });
  }

  private attach(table: TableName, row: Row): Row {
    const out = { ...row };
    if (table === "studentProfile") out.user = this.t.user.find((u) => u.id === row.userId) ?? null;
    if (table === "enrollment") out.studentProfile = this.t.studentProfile.find((p) => p.id === row.studentProfileId) ?? null;
    return out;
  }

  private model(table: TableName, scope?: string) {
    const visible = () => this.t[table].filter((r) => !scope || r.institutionId == null || r.institutionId === scope);
    const find = async (args: Row) => {
      const r = visible().find((x) => this.match(table, x, args.where));
      return r ? this.attach(table, r) : null;
    };
    return {
      findFirst: find,
      findUnique: find,
      findMany: async (args: Row = {}) => visible().filter((x) => this.match(table, x, args.where)).map((r) => this.attach(table, r)),
      count: async (args: Row = {}) => visible().filter((x) => this.match(table, x, args.where)).length,
      create: async (args: Row) => {
        if (this.failNextCreate?.table === table) {
          const target = this.failNextCreate.target;
          this.failNextCreate = null;
          throw new UniqueError(target);
        }
        for (const cols of UNIQUES[table] ?? []) {
          if (this.t[table].some((r) => cols.every((c) => r[c] === args.data[c]))) throw new UniqueError(cols);
        }
        return this.add(table, args.data);
      },
      update: async (args: Row) => {
        const r = this.t[table].find((x) => this.match(table, x, args.where));
        if (!r) throw new Error("record not found");
        for (const [k, v] of Object.entries(args.data as Row)) {
          if (v && typeof v === "object" && "increment" in v) r[k] = (r[k] ?? 0) + v.increment;
          else r[k] = v;
        }
        return r;
      },
    };
  }

  client(scope?: string): any {
    const c: Row = {};
    for (const n of TABLES) c[n] = this.model(n, scope);
    c.$executeRaw = async (...a: unknown[]) => {
      this.rawCalls.push(a);
      return 1;
    };
    return c;
  }

  /** withTenant stand-in: rolls every table back when the callback throws. */
  withTenant = async (institutionId: string, fn: (tx: any) => Promise<any>) => {
    const snapshot = structuredClone(this.t);
    try {
      return await fn(this.client(institutionId));
    } catch (err) {
      this.t = snapshot;
      throw err;
    }
  };

  owner = this.client();
}
