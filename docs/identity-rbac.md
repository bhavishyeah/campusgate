# CAMPASS Identity & RBAC (B2)

> Owning doc for decision **D3 (identity & RBAC = B2)**. Supplies the authenticated
> identity and permission set that [`tenancy.md`](./tenancy.md) uses to scope every
> request, and that [`superadmin-security.md`](./superadmin-security.md) builds the
> platform/tenant split on top of.

---

## 1. Goal

One consistent identity and one central authorization engine across the entire ERP. A
user does not have separate accounts per module. Authorization is **action-level**
(permissions), not just **role-level**, because the ERP needs grants like
`attendance.mark` for an assigned class but not `attendance.correct` for the whole
institution.

**B2 = build the capability now, defer the fancy UX.** We model
`User`/`InstitutionMembership`/`Role`/`Permission` and the authz engine in Phase 0, and
migrate GatePass onto it — but we keep a single membership per user for now and do not
build multi-institution switching or self-service role management yet.

---

## 2. Why B2 (tradeoff record)

### Option B1 — keep `User.institutionId` + role enum (rejected)

- **Pros:** simplest; works today.
- **Cons:** cannot represent a user in two institutions, nor two roles in one
  institution (an HOD who also teaches), nor action-level permissions. Fees/Faculty/HR
  phases *need* granular permissions. Retrofitting membership + permissions after 8
  modules reference `user.role` everywhere is exactly the "start over" pain to avoid.

### Option B2 — membership + roles + permissions + central engine now (CHOSEN)

- **Pros:** future-proof identity and the permission granularity the ERP needs, without
  building multi-institution UX yet. New modules declare their own permissions against
  one engine. Adding a second institution to a user later is **data, not a migration.**
- **Cons:** more upfront modeling; JWT and `authenticate` middleware change; a
  compatibility shim keeps existing role checks working during transition.

**Decision:** B2, phased. Tables + engine now; multi-institution UX and self-service
role management deferred.

---

## 3. Entity model

```text
User (one person, platform-wide identity)
 ├── id, email, phone, passwordHash?, googleId?
 ├── accountStatus            (ACTIVE | INACTIVE | PENDING_APPROVAL)
 ├── mfaEnabled, mfaSecret?   (see superadmin-security.md)
 └── createdAt, lastLoginAt

InstitutionMembership (a user's belonging to ONE institution)
 ├── id
 ├── userId        -> User
 ├── institutionId -> Institution      (tenant-owned; RLS applies)
 ├── membershipStatus           (ACTIVE | SUSPENDED)
 ├── departmentScope?           (optional: limit to a department)
 └── roles  -> MembershipRole[]        (a membership can hold multiple roles)

Role (named bundle of permissions, scoped to an institution or a platform-global template)
 ├── id, key (e.g. "HOD", "LIBRARIAN"), name
 ├── institutionId?            (null = platform-provided template role)
 └── permissions -> RolePermission[]

Permission (action-level grant; defined per module)
 ├── id, key (e.g. "library.issue", "fees.refund", "attendance.mark")
 ├── module (e.g. "library", "fees", "attendance", "campus_movement")
 └── description

MembershipRole   (join)  membershipId -> Role
RolePermission   (join)  roleId -> Permission
```

**Key points**

- A `User` is **platform-wide** (identity, credentials, MFA). It is **not** tenant-owned.
- An `InstitutionMembership` is **tenant-owned** (RLS applies) and is where a user's
  belonging + roles for one institution live. Today: exactly one membership per user.
  Later: many, without schema change.
- `Role` can be a **platform template** (`institutionId = null`, e.g. a default "HOD"
  role shipped with the module) or an **institution-custom** role.
- `Permission` keys follow the `<module>.<action>` convention (§6). Modules own their
  permission catalogue.

> **Membership in one institution never implies membership in another.** This is a
> tenancy invariant, enforced because memberships are tenant-owned rows under RLS
> (see [`tenancy.md`](./tenancy.md)).

---

## 4. Relationship to today's model

Today: `User.institutionId` (single) + `User.role` (single enum:
`STUDENT|HOD|GUARD|ADMIN|SUPER_ADMIN`) + role-specific profile tables
(`StudentProfile`, `HodProfile`, `GuardProfile`).

Mapping to B2:

- `User.institutionId` → becomes a single `InstitutionMembership` per user. (`User`
  keeps platform-wide fields; institution belonging moves to the membership.)
- `User.role` enum → a `Role` held by that membership. The five enum values become
  seeded template roles.
- `SUPER_ADMIN` → a **platform** role, not an institution membership (see
  [`superadmin-security.md`](./superadmin-security.md)). Super Admins do not get a
  tenant membership by default.
- Profile tables (`StudentProfile`, etc.) remain; they attach domain data to the user
  within an institution and become tenant-owned (`institutionId` added per
  [`tenancy.md`](./tenancy.md)).

---

## 5. JWT and the authenticate middleware

### 5.1 Claims change

Today's JWT: `{ userId, role, institutionId, jti }`.

Target JWT: `{ userId, membershipId, institutionId, roles, permissions, jti }`

- `membershipId` identifies the active membership (future: the one the user "switched
  into").
- `institutionId` is still present (derived from the membership) and is the value fed to
  the tenant-scoped client / RLS (`app.current_institution_id`). **It originates only
  from the verified token**, never from request input.
- `roles` and `permissions` are the **resolved** sets for this membership, computed at
  login, so hot-path authorization checks are a set lookup, not a DB round-trip.
- `jti` keeps the existing session-revocation mechanism unchanged.

### 5.2 Request pipeline (target)

```text
Verify JWT (signature, expiry)
      |
Check session not revoked (jti -> sessions table)      [existing mechanism, kept]
      |
Load user: accountStatus ACTIVE?                        [existing check, kept]
      |
Load membership: membershipStatus ACTIVE?
Institution status ACTIVE? (not SUSPENDED)              [existing check, kept]
      |
Attach req.auth = { userId, membershipId, institutionId, roles, permissions }
Attach req.tenant = { institutionId }                   [feeds tenant-scoped client / RLS]
      |
Route authorization: require(permission) / requireModuleActive(module)
```

### 5.3 Permission freshness

Resolved permissions live in the JWT for performance. When an admin changes a role's
permissions, affected users' tokens are stale until re-issued. Mitigations (decide at
implementation):

- Short token lifetime (already 24h) + silent refresh, or
- A `permissionsVersion` per membership checked cheaply on each request, re-resolving
  when it changes, or
- Revoke affected sessions on sensitive permission changes (reuses `jti` revocation).

For high-risk actions, re-check the permission against the database at the point of
action regardless of the token (defense in depth; pairs with step-up auth in
[`superadmin-security.md`](./superadmin-security.md)).

---

## 6. Permission catalogue convention

Permissions are the vocabulary of authorization. They are **owned by modules** and live
in a central catalogue (target: `packages/shared`) so the whole platform shares one
registry.

### 6.1 Naming

```text
<module>.<resource?>.<action>
```

Examples:

```text
campus_movement.pass.request      campus_movement.pass.approve     campus_movement.pass.revoke
students.view                     students.create                  students.update       students.deactivate
attendance.view                   attendance.mark                  attendance.correct    attendance.export
library.books.view                library.books.manage             library.issue         library.return
fees.view                         fees.collect                     fees.refund           fees.adjust
exams.marks.enter                 exams.marks.approve              exams.results.publish
```

### 6.2 Each module, when built, ships

1. Its permission keys (added to the central catalogue).
2. Default **template roles** mapping (e.g. a "Librarian" template role → the `library.*`
   permissions it should hold).
3. The `requireModuleActive("<module>")` guard so its routes reject access when the
   module is not `ACTIVE` for the institution (see
   [`architecture.md`](./architecture.md) §5).

### 6.3 Authorization decision (full)

Every protected request is evaluated against (all must pass):

```text
1. Authenticated identity (valid, non-revoked session)
2. Active account + active membership
3. Institution scope (tenant context set; RLS active)
4. Module entitled + ACTIVE for this institution
5. Required permission present
6. Resource ownership / department / class / record-level scope
7. Business-state validity (legal state transition)
8. Step-up auth for sensitive actions (where configured)
```

Items 3 is enforced by [`tenancy.md`](./tenancy.md); item 4 by the module system; items
1–2, 5–8 by this engine.

---

## 7. Central authorization engine

A single service all modules call. No module invents its own authorization.

### 7.1 Core checks (sketch — final API decided at implementation)

```ts
// has a permission?
authz.can(req.auth, "library.issue")                 // -> boolean

// guard: require a permission, else 403
app.post("/loans", { preHandler: [requirePermission("library.issue")] }, handler)

// guard: require the module be active for this tenant, else 403/409
app.register(libraryRoutes, { preHandler: [requireModuleActive("library")] })

// record-level scope: faculty can mark only their assigned classes
authz.canOnResource(req.auth, "attendance.mark", { classSectionId })  // -> boolean
```

### 7.2 How a new module (e.g. Library) uses it

1. Declare permissions `library.books.view`, `library.books.manage`, `library.issue`,
   `library.return`, `library.reservations.manage` in the catalogue.
2. Ship a template role "Librarian" bound to those permissions.
3. Wrap routes: `requireModuleActive("library")` + `requirePermission("library.issue")`.
4. For record-level rules (a librarian limited to one branch), implement
   `canOnResource` with the branch scope.
5. All queries go through the tenant-scoped client (isolation is automatic).

The module writes **zero** bespoke auth logic beyond declaring its permissions and
scopes — everything funnels through the shared engine.

---

## 8. Compatibility shim (migrating off the role enum)

The existing code uses `requireRole(...)` / `requireTenantRole(...)` against
`User.role`. To migrate without a big-bang rewrite:

- Keep `requireRole`/`requireTenantRole` working by **mapping the old enum to resolved
  permissions**: a shim resolves (e.g.) role `HOD` → the permission set the `HOD`
  template role holds, so old guards keep passing during transition.
- Migrate route-by-route to `requirePermission(...)`, deleting the enum dependency as
  each module moves over. GatePass is migrated first (it is the Phase 0 proving ground).
- The JWT carries both the legacy `role` (during transition) and the new
  `roles`/`permissions`, so neither old nor new guards break mid-migration. Remove the
  legacy `role` claim once all routes use permissions.

This keeps the app running at every step and avoids a dangerous all-at-once auth
rewrite.

---

## 9. Deferred (explicitly NOT built now)

Recorded so no one assumes they exist, and so the schema stays ready for them:

- **Multi-institution-per-user UX** — the data model supports many memberships per user,
  but login/token/UI assume one. No institution switcher yet.
- **Self-service role management UI** — institution admins editing custom roles/
  permissions through the UI. Roles are seeded from templates for now.
- **Delegated administration / scoped admin roles** beyond department scope.
- **External identity providers (SSO/OIDC)** — the `User` model leaves room; not wired.

Each is additive on the B2 model, not a migration.

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-18 | Initial identity/RBAC doc: B2 entity model, B1-vs-B2 tradeoff, mapping from today's enum model, JWT claim changes, permission-catalogue convention, central engine API sketch, Library worked example, compatibility shim, deferred items. |
