# CAMPASS Documentation

> **CAMPASS** is a modular, multi-tenant Campus ERP platform. Its first operational
> module is **Campus Movement** (the existing GatePass / CampusGate system). This
> documentation set is the **single source of truth** we build every phase from.

This folder exists so that foundational architectural decisions are made **once**,
written down, and never silently re-litigated. Before starting any build phase, read
the relevant docs here. When a decision changes, change it **here first**, then build.

---

## How to use these docs

1. **Starting a new phase?** Open [`roadmap.md`](./roadmap.md), find the phase, and
   follow its cross-links into `architecture.md`, `tenancy.md`, `identity-rbac.md`,
   `superadmin-security.md`, and `database.md` for the details that phase depends on.
2. **Adding a new module or table?** You must satisfy the rules in
   [`tenancy.md`](./tenancy.md) (isolation) and [`identity-rbac.md`](./identity-rbac.md)
   (permissions) — these are non-negotiable for every tenant-owned entity.
3. **Changing a locked decision?** Update the owning doc, bump its version in the
   status table below, and record the change in that doc's changelog.

---

## Documents

| Doc | Purpose | Status | Version |
|---|---|---|---|
| [`README.md`](./README.md) | Index, locked decisions, current-vs-target summary, conventions | Complete | 1.0 |
| [`architecture.md`](./architecture.md) | Three-layer model, monorepo mapping, module entitlement/activation, Definition of Done | Complete | 1.0 |
| [`tenancy.md`](./tenancy.md) | Multi-tenant isolation (A2): `institutionId` everywhere, composite FKs, Postgres RLS, tenant-scoped Prisma client | Complete | 1.0 |
| [`identity-rbac.md`](./identity-rbac.md) | Identity + permissions (B2): membership, roles, permissions, central authz engine | Complete | 1.0 |
| [`superadmin-security.md`](./superadmin-security.md) | Super Admin model (C): zero standing access, break-glass support grants, MFA, AuditLog v2 | Complete | 1.0 |
| [`database.md`](./database.md) | Neon → Supabase migration, connection strategy, versioned migrations, Phase 0 schema additions | Complete | 1.0 |
| [`roadmap.md`](./roadmap.md) | Phases 0–10: objective, dependencies, scope, schema, security/tenancy notes, tests, Definition of Done | Complete | 1.0 |

> Status values: **Draft** (being written) → **Complete** (reviewed, build-ready) →
> **Superseded** (replaced; see changelog).

---

## Locked architectural decisions

These were decided during the planning session and are **binding** until explicitly
revisited. Each is explained with its tradeoffs in the owning doc.

| # | Decision | Choice | Owning doc |
|---|---|---|---|
| D1 | **Product identity** | CAMPASS is an umbrella, multi-tenant ERP platform; GatePass is its first module | `architecture.md` |
| D2 | **Tenant isolation** | **A2** — `institutionId` on every tenant-owned table, composite FKs enforcing same-tenant links, Postgres Row-Level Security, and a tenant-scoped Prisma client | `tenancy.md` |
| D3 | **Identity & RBAC** | **B2** — `InstitutionMembership` + `Role` + `Permission` + a central authorization engine now; multi-institution-per-user UX deferred | `identity-rbac.md` |
| D4 | **Super Admin security** | **C** — zero standing access to tenant operational data; time-limited, purpose-bound, audited break-glass `SupportGrant`; MFA for platform accounts and high-risk actions | `superadmin-security.md` |
| D5 | **Database host** | Migrate **Neon → Supabase**; design RLS + Prisma for Supabase (dedicated non-`BYPASSRLS` app role + per-transaction `SET LOCAL app.current_institution_id`) | `database.md` |
| D6 | **Architecture strategy** | Modular monolith first; split into services only when scaling/isolation/deployment needs justify it | `architecture.md` |
| D7 | **Migrations** | Replace `prisma db push --accept-data-loss` with versioned Prisma migrations before Phase 0 ships | `database.md` |
| D8 | **Feature rollout** | Incremental, dependency-ordered, tested; each phase has a demoable Definition of Done | `roadmap.md` |

---

## Non-negotiables (apply to every phase and every module)

These rules are repeated in each phase of the roadmap. A module is **not done** until
all of them hold.

- **Backend-enforced authorization.** Hiding a button is not security. Every protected
  operation is checked server-side against identity, institution scope, role,
  permission, module activation, resource ownership, and business state.
- **Tenant isolation at two layers.** Application (tenant-scoped Prisma client) **and**
  database (Postgres RLS). A bug in one layer must not create a cross-tenant leak.
- **Transactional + idempotent critical operations.** Payments, state transitions, and
  anything with money or legal consequence run in transactions and tolerate retries
  without double-posting.
- **Audit on important actions.** Who did what, to which resource, when, with what
  result — recorded and tamper-resistant.
- **Preserve history over hard delete.** Use status changes, archival, or auditable
  reversal. Historical records (grades, payments, movements) are never silently
  rewritten.
- **Module activation enforced server-side.** A disabled module's routes reject access;
  its data is preserved; dependent modules get explicit dependency warnings.
- **Shared identity, never duplicated.** One authoritative `Student` and one
  `Institution` identity, reused by every module. Modules keep their own domain records
  but reference the shared identity.

---

## Current vs. target (one-paragraph summary)

**Today** CAMPASS is a working single-purpose GatePass app on a Turborepo monorepo
(`apps/web` Next.js 15, `apps/api` Fastify, `packages/db` Prisma, `packages/shared`).
It is multi-tenant in spirit — an `Institution` model exists and tenancy is **derived**
by joining `student → user → institutionId` — but there is no `institutionId` column on
child tables, no database-level isolation (RLS), a single-institution `User` with a
coarse role enum, and an audit log that is gatepass-specific. **Target** is the same
monolith, hardened: tenant columns + composite FKs + RLS everywhere, a membership /
role / permission model with a central authz engine, a Super Admin with zero standing
tenant access plus audited break-glass, versioned migrations on Supabase, and a
generic AuditLog — all proven by a cross-tenant escape test suite, then reused by every
ERP module that follows. A full current-vs-target table lives in
[`architecture.md`](./architecture.md).

---

## Terminology

Consistent words, used the same way across all docs:

- **Platform** — the CAMPASS SaaS itself (operated by the Super Admin).
- **Institution** / **tenant** — one customer (a college/university). Used
  interchangeably; "tenant" when talking about isolation, "institution" otherwise.
- **Module** — an independently activatable business capability (Campus Movement,
  Library, Fees, …).
- **Membership** — a user's link to one institution (carries their roles there).
- **Role** — a named bundle of permissions (e.g. `HOD`, `Librarian`).
- **Permission** — an action-level grant (e.g. `library.issue`, `fees.refund`).
- **Entitlement** — an institution's right to use a module (granted by the platform).
- **Activation** — an institution turning on a module it is entitled to.

---

## Changelog

| Date | Doc | Change |
|---|---|---|
| 2026-10-18 | README | Initial index, locked decisions, conventions. |
| 2026-10-18 | all | Consistency pass: all docs reviewed, cross-references verified, terminology reconciled, every locked decision confirmed recorded (D2/D3 with explicit tradeoff records). All docs marked Complete 1.0. |
