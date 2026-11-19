/**
 * Minimal stateful in-memory stand-in for the owner Prisma client, covering only
 * the calls made by account-tokens.ts / account-invites.ts. `$transaction` rolls
 * every table back when the callback throws, like a real transaction.
 */
type Row = Record<string, any>;

function matchValue(actual: any, cond: any): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    if ("equals" in cond) return typeof actual === "string" && typeof cond.equals === "string" && (cond.mode === "insensitive" ? actual.toLowerCase() === cond.equals.toLowerCase() : actual === cond.equals);
    if ("in" in cond) return (cond.in as any[]).includes(actual);
    if ("not" in cond) return cond.not === null ? actual !== null && actual !== undefined : actual !== cond.not;
    if ("gte" in cond && !(actual != null && actual >= cond.gte)) return false;
    if ("gt" in cond && !(actual != null && actual > cond.gt)) return false;
    if ("lte" in cond && !(actual != null && actual <= cond.lte)) return false;
    if (!["gte", "gt", "lte"].some((k) => k in cond)) {
      return actual !== null && typeof actual === "object" && matches(actual, cond);
    }
    return true;
  }
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  return actual === cond;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => matchValue(row[k], v));
}

export class FakeOwnerDb {
  tokens: Row[] = [];
  users: Row[] = [];
  sessions: Row[] = [];
  events: Row[] = [];
  memberships: Row[] = [];
  membershipRoles: Row[] = [];
  roles: Row[] = [{ id: "role-student", key: "STUDENT", institutionId: null }];
  /** userId -> role objects granted via membership (for isPlatformAccount) */
  membershipPerms = new Map<string, { role: { key: string; permissions: { permission: { key: string } }[] } }[]>();
  institutions: Row[] = [{ id: "inst-1", name: "Demo College", status: "ACTIVE" }];
  private seq = 0;

  addUser(u: Row): Row {
    const row = {
      id: `u${++this.seq}`,
      role: "STUDENT",
      institutionId: "inst-1",
      accountStatus: "ACTIVE",
      passwordHash: null,
      studentProfile: null,
      ...u,
    };
    this.users.push(row);
    return row;
  }

  private userView(u: Row, include?: Row) {
    const out: Row = { ...u };
    out.institution = this.institutions.find((i) => i.id === u.institutionId);
    return out;
  }

  user = {
    findMany: async (args: Row) =>
      this.users.map((u) => this.userView(u)).filter((x) => matches(x, args.where)).slice(0, args.take ?? 1e9),
    findFirst: async (args: Row) => {
      const u = this.users.find((x) => matches(x, args.where));
      return u ? this.userView(u) : null;
    },
    count: async (args: Row) => this.users.filter((x) => matches(x, args.where)).length,
    findUnique: async (args: Row) => {
      const u = this.users.find((x) => matches(x, args.where));
      return u ? this.userView(u) : null;
    },
    update: async (args: Row) => {
      const u = this.users.find((x) => matches(x, args.where))!;
      Object.assign(u, args.data);
      return u;
    },
  };

  institution = {
    findUnique: async (args: Row) => this.institutions.find((i) => matches(i, args.where)) ?? null,
  };

  institutionMembership = {
    findUnique: async (args: Row) => {
      const { userId, institutionId } = args.where.userId_institutionId;
      const m = this.memberships.find((x) => x.userId === userId && x.institutionId === institutionId);
      if (!m) {
        const perms = this.membershipPerms.get(userId);
        return perms ? { id: `virt-${userId}`, roles: perms } : null;
      }
      return { ...m, roles: this.membershipPerms.get(userId) ?? [] };
    },
    create: async (args: Row) => {
      const row = { id: `m${++this.seq}`, ...args.data };
      this.memberships.push(row);
      return row;
    },
  };

  role = {
    findFirst: async (args: Row) => this.roles.find((r) => matches(r, args.where)) ?? null,
  };

  membershipRole = {
    count: async (args: Row) => this.membershipRoles.filter((x) => matches(x, args.where)).length,
    upsert: async (args: Row) => {
      const w = args.where.membershipId_roleId;
      const ex = this.membershipRoles.find((x) => x.membershipId === w.membershipId && x.roleId === w.roleId);
      if (ex) return ex;
      const row = { id: `mr${++this.seq}`, ...args.create };
      this.membershipRoles.push(row);
      return row;
    },
  };

  accountToken = {
    count: async (args: Row) => this.tokens.filter((t) => matches(t, args.where)).length,
    updateMany: async (args: Row) => {
      const hit = this.tokens.filter((t) => matches(t, args.where));
      hit.forEach((t) => Object.assign(t, args.data));
      return { count: hit.length };
    },
    create: async (args: Row) => {
      const live = this.tokens.find(
        (t) => t.userId === args.data.userId && t.purpose === args.data.purpose && !t.usedAt && !t.supersededAt,
      );
      if (live) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      const row = {
        id: `t${++this.seq}`,
        emailSentAt: null,
        failedAt: null,
        failureReason: null,
        usedAt: null,
        supersededAt: null,
        createdByUserId: null,
        createdAt: new Date(),
        ...args.data,
      };
      this.tokens.push(row);
      return row;
    },
    findFirst: async (args: Row) => {
      const t = this.tokens.find((x) => matches(x, args.where));
      if (!t) return null;
      const u = this.users.find((x) => x.id === t.userId)!;
      return { id: t.id, userId: t.userId, user: this.userView(u) };
    },
    findUnique: async (args: Row) => this.tokens.find((x) => matches(x, args.where)) ?? null,
    update: async (args: Row) => {
      const t = this.tokens.find((x) => matches(x, args.where))!;
      Object.assign(t, args.data);
      return t;
    },
    groupBy: async (args: Row) => {
      const out = new Map<string, Row>();
      for (const t of this.tokens.filter((x) => matches(x, args.where))) {
        const g = out.get(t.userId) ?? { userId: t.userId, _max: { emailSentAt: null, failedAt: null } };
        for (const k of ["emailSentAt", "failedAt"]) {
          if (t[k] && (!g._max[k] || t[k] > g._max[k])) g._max[k] = t[k];
        }
        out.set(t.userId, g);
      }
      return [...out.values()];
    },
  };

  session = {
    updateMany: async (args: Row) => {
      const hit = this.sessions.filter((s) => matches(s, args.where));
      hit.forEach((s) => Object.assign(s, args.data));
      return { count: hit.length };
    },
  };

  securityEvent = {
    create: async (args: Row) => {
      this.events.push(args.data);
      return args.data;
    },
  };

  $executeRaw = async () => 1;

  $transaction = async (fn: (tx: FakeOwnerDb) => Promise<any>) => {
    const snap = {
      tokens: this.tokens.map((t) => ({ ...t })),
      users: this.users.map((u) => ({ ...u })),
      sessions: this.sessions.map((s) => ({ ...s })),
      events: [...this.events],
      memberships: [...this.memberships],
      membershipRoles: [...this.membershipRoles],
    };
    try {
      return await fn(this);
    } catch (err) {
      Object.assign(this, snap);
      throw err;
    }
  };
}

export const asDb = (f: FakeOwnerDb) => f as never;
