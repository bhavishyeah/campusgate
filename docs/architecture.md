# CAMPASS Architecture

> Owning doc for decisions **D1 (product identity)** and **D6 (modular monolith first)**.
> Read alongside [`tenancy.md`](./tenancy.md), [`identity-rbac.md`](./identity-rbac.md),
> [`superadmin-security.md`](./superadmin-security.md), and [`roadmap.md`](./roadmap.md).

---

## 1. Product concept

CAMPASS is a **multi-tenant, modular Campus ERP platform**. One platform serves many
institutions; each institution activates only the modules it needs and keeps its data,
users, configuration, and permissions fully isolated from every other institution.

The existing **GatePass / Campus Movement** system is not a separate app — it is the
**first module** on this platform. Every later module (Student Information, Attendance,
Library, Fees, Exams, …) reuses the same platform foundation rather than reinventing
identity, tenancy, authorization, audit, or notifications.

```text
                          CAMPASS
                    Platform Infrastructure
                              |
           +------------------+------------------+
           |                  |                  |
      Institution A      Institution B      Institution C
           |                  |                  |
     activated modules   activated modules  activated modules
           |                  |                  |
     isolated data        isolated data      isolated data
```

**This is target architecture.** It does not claim every feature already exists. The
[current-vs-target table](#8-current-vs-target-state) records exactly what is built today.

---

## 2. The three layers

CAMPASS is organized into three logical layers. Every module lives in the Module layer
and consumes the layers beneath it; a module **must not** invent its own identity,
tenancy, authorization, or audit.

### Layer A — Platform

Operated by the **Super Admin** (the platform operator, not any college's admin).

- Institution onboarding and lifecycle (create / activate / suspend / archive).
- Module **entitlements** (which modules an institution may use).
- Subscription / plan management.
- Platform monitoring, security incident response, support operations.
- Platform-wide configuration.

The Super Admin has **no standing access** to tenant operational data — see
[`superadmin-security.md`](./superadmin-security.md).

### Layer B — Institution

Operated by each institution's **Institution Admin**.

- Departments, programs, academic sessions, academic calendar.
- Users, memberships, roles, permissions (within the institution).
- Module **activation** and configuration (within granted entitlements).
- Institution settings, notifications, institution-level reporting, Audit Explorer.

The Institution Admin can configure/operate the modules the platform has entitled, but
**cannot** enable a module the platform has not entitled.

### Layer C — Module

The actual operational applications:

Campus Movement · Admissions · Student Management · Class & Course · Attendance ·
Fees · Library · Examinations · Faculty/HR · Hostel · Transport · Inventory ·
Service Requests · Document Management · (future) Accounting, Payroll, …

**Architectural principle:** modules compose shared services. A new module brings its
own domain tables and business rules, and references shared identity
(`Institution`, `Student`, `User`/`Membership`) rather than copying it.

---

## 3. Monorepo mapping

The layers map onto the existing Turborepo structure. No new top-level apps are
required for the foundation; modules are code boundaries **inside** `apps/api` and
`apps/web`, not separate deployments.

```text
campusgate/
├── apps/
│   ├── web/                 # Next.js 15 (App Router) — all role UIs + module UIs
│   │   └── src/app/         # route groups per module/role
│   └── api/                 # Fastify API — the modular monolith
│       └── src/
│           ├── middleware/  # auth, tenant context (RLS session var), authz
│           ├── routes/      # one route file per module/role boundary
│           └── services/    # domain logic per module (authz, lifecycle engines, …)
├── packages/
│   ├── db/                  # Prisma schema, client, migrations, seed
│   └── shared/              # shared types, zod validation, constants, permission catalogue
├── docs/                    # this documentation set (source of truth)
├── docker-compose.yml       # local Postgres
├── turbo.json               # pipeline
└── railway.toml / vercel.json
```

**Where foundation pieces live (target):**

| Concern | Location |
|---|---|
| Tenant context / RLS session variable | `apps/api/src/middleware` + tenant-scoped Prisma client in `packages/db` |
| Authentication (JWT, sessions) | `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/auth.ts` |
| Central authorization engine | `apps/api/src/services` (e.g. `authz.ts`) + permission catalogue in `packages/shared` |
| Per-module domain logic | `apps/api/src/services/<module>` |
| Per-module routes | `apps/api/src/routes/<module>.ts` |
| Shared schema + migrations | `packages/db/prisma` |

---

## 4. Modular monolith first (D6)

CAMPASS starts and stays a **well-structured modular monolith** until real scaling,
isolation, or deployment pressure justifies splitting a module into its own service.

**Why:** many modules do **not** imply microservices. A single deployable with clear
internal module boundaries is simpler to operate, test, and keep transactionally
correct (critical for fees/exams). Premature service-splitting multiplies tenancy,
auth, and consistency problems across network boundaries.

**Boundary rules that keep the monolith clean:**

- Each module owns its tables and services; other modules call it through a defined
  service interface, not by reaching into its tables.
- Shared entities (`Institution`, `Student`, `User`/`Membership`) are owned by the
  platform/institution layers; modules reference them by ID.
- Cross-module reactions use **domain events** (see §6), not hidden table writes.
- Split into a service only when a module has a distinct scaling profile, independent
  deployment cadence, or isolation requirement that the monolith cannot meet.

---

## 5. Module entitlement, activation, and dependency model

This is the "booster" model: institutions turn modules on/off without separate apps.
Fully specified here; schema lands in [`database.md`](./database.md) Phase 0.

### 5.1 Two distinct concepts

- **Entitlement** — granted by the **platform** (Super Admin). "Institution X *may*
  use the Library module." Tied to subscription/plan.
- **Activation** — performed by the **Institution Admin**. "Institution X *has turned
  on* and configured the Library module."

An institution can only activate a module it is entitled to.

### 5.2 Institution-module states

```text
NOT_ENTITLED    -> platform has not granted the module
ENTITLED        -> granted, but the institution has not activated it
ACTIVE          -> activated and configured; operational
SUSPENDED       -> temporarily disabled (by platform or institution); data preserved
```

### 5.3 Activation workflow

```text
Super Admin grants entitlement
        |
Institution Admin activates module
        |
Dependency check (see 5.4) passes
        |
Required configuration completed
        |
Permissions assigned to roles
        |
Module becomes ACTIVE (routes/APIs accept requests)
```

### 5.4 Dependencies

Some modules require others. Activation is blocked until dependencies are `ACTIVE`.

```text
Attendance        requires  Student Management, Academic Sessions, Class/Course
Examinations      requires  Academic Sessions, Class/Course, Student Enrollment
Fees              requires  Student Management (charges attach to students)
Library           requires  (shared identity only)
```

The dependency graph is validated server-side **before** activation. Disabling a module
that others depend on must produce an explicit dependency warning, never a silent break.

### 5.5 Behavior when a module is `SUSPENDED` or `NOT_ENTITLED`

- Operational routes/APIs reject normal access (enforced server-side; see
  [`identity-rbac.md`](./identity-rbac.md)).
- Module-specific scheduled jobs stop their operational work.
- Historical records are **preserved** (no deletion, no corruption of records other
  modules reference).
- Dependent modules receive explicit dependency warnings.

---

## 6. Event-driven module integration (guidelines)

Within the monolith, modules react to each other through **domain events**, not direct
table access. This keeps boundaries clean and makes a future service split cheaper.

**Example events:**

```text
STUDENT_ENROLLED        (Admissions -> Student Management, then interested modules)
FEE_PAYMENT_CONFIRMED   (Fees -> ledger update, receipt, notification)
BOOK_RETURNED           (Library -> copy availability, reservation queue, notification)
PASS_REVOKED            (Campus Movement -> notification, audit)
```

**Reliability requirements for every event:**

- Every event carries its `institutionId`; consumers validate scope.
- Processing is **idempotent** where a retry could double-apply.
- Failed events are retried or routed to a controlled failure queue (never dropped
  silently).
- Event ordering is considered where business rules depend on it.
- Payloads carry only the information the consumer needs (no over-sharing of PII).

> Start with in-process events in the monolith. Introduce a durable queue/broker only
> when reliability or decoupling needs justify it (consistent with D6).

---

## 7. Per-module Definition of Done

A module is **not** complete because its screens work. Every module must pass this
checklist (repeated per phase in [`roadmap.md`](./roadmap.md)).

**Functional completeness**
- [ ] Core workflows run end-to-end.
- [ ] Invalid states are rejected (state machine enforced server-side).
- [ ] Field/validation rules work; error states handled; user-facing status accurate.

**Authorization** (see [`identity-rbac.md`](./identity-rbac.md))
- [ ] Users can perform only permitted actions (permission-level, not just role).
- [ ] Resource ownership validated; department/class/record scope enforced.
- [ ] Module activation enforced by the backend.
- [ ] Unauthorized API requests are denied (not merely hidden in the UI).

**Tenant isolation** (see [`tenancy.md`](./tenancy.md))
- [ ] Cross-tenant reads denied. Cross-tenant writes denied.
- [ ] Linked records checked for tenant consistency (parent `institutionId` alone is
      not enough).
- [ ] Reports enforce tenant scope; files and notifications respect tenant boundaries.
- [ ] Automated tests attempt tenant escape and fail to escape.

**Data integrity**
- [ ] Critical operations are transactional.
- [ ] Duplicate processing prevented (idempotency where needed).
- [ ] Concurrent actions handled correctly (constraints/locking).
- [ ] Historical records preserved; invalid state transitions rejected.

**Auditability** (see [`superadmin-security.md`](./superadmin-security.md))
- [ ] Important actions create audit events with actor, target, timestamp, result.
- [ ] Sensitive changes traceable; audit access appropriately restricted.

**Reliability**
- [ ] Failures are observable; retry behavior defined.
- [ ] External integrations handle failure; critical ops cannot silently succeed when
      their required validation fails.

**Usability & accessibility**
- [ ] Mobile and desktop layouts work.
- [ ] Loading / empty / success / failure states handled; actionable validation.
- [ ] Accessibility considered (semantic markup, keyboard, contrast).

---

## 8. Current vs. target state

Verified from the codebase during planning. "Target" is what the foundation
(Phase 0) and later phases deliver.

| Area | Today | Target |
|---|---|---|
| Product shape | Single-purpose GatePass app | Modular multi-tenant ERP; GatePass = first module |
| Tenancy | Derived via `student → user → institutionId` joins; no `institutionId` on child tables | `institutionId` on every tenant table + composite FKs + Postgres RLS + tenant-scoped Prisma client (see `tenancy.md`) |
| Identity | One `User` = one `institutionId`; single role enum | `User` + `InstitutionMembership` + `Role` + `Permission`; central authz engine (see `identity-rbac.md`) |
| Authorization | Coarse role checks (`requireRole`, `requireTenantRole`) | Action-level permissions enforced by a central engine |
| Super Admin | `SUPER_ADMIN` role; platform routes aggregate across tenants; blocked from tenant endpoints | Zero standing tenant-data access; audited, time-limited break-glass `SupportGrant`; MFA (see `superadmin-security.md`) |
| Audit | `AuditLog` with gatepass-specific action enum; no `institutionId` | AuditLog v2: generic action/resource + `institutionId` + grant reference |
| Sessions | JWT `{userId, role, institutionId, jti}`; revocation by `jti`; suspended-institution check | Carried forward; JWT gains `membershipId` + resolved permissions |
| Module system | Implicit (only GatePass) | Explicit entitlement + activation + dependency model |
| Database host | Neon (live) | Supabase (see `database.md`) |
| Schema changes | `prisma db push --accept-data-loss` in deploy | Versioned Prisma migrations (see `database.md`) |
| Modules present | Campus Movement (GatePass) with analytics, emergencies, shifts, reliability, audit explorer, PWA | + SIS, Class/Course, Attendance, Library, Admissions, Fees, Exams, institutional ops, advanced (see `roadmap.md`) |

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-18 | Initial architecture doc: three layers, monorepo mapping, modular-monolith principle, entitlement/activation/dependency model, event guidelines, Definition of Done, current-vs-target table. |
