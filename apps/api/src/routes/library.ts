import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createBookTitleSchema,
  patchBookTitleSchema,
  registerBookCopySchema,
  patchBookCopySchema,
  issueLoanSchema,
  returnLoanSchema,
  renewLoanSchema,
  markLoanLostSchema,
  markCopyDamagedSchema,
  createReservationSchema,
  fulfilReservationSchema,
  collectReservationSchema,
  cancelReservationSchema,
  createLibraryFineSchema,
  waiveLibraryFineSchema,
  payLibraryFineSchema,
  catalogueSearchQuerySchema,
  libraryReportQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { notifyUser } from "../services/notifications.js";
import {
  libraryPolicy,
  computeDueDate,
  computeOverdueDays,
  computeOverdueFine,
  type LibraryPolicy,
} from "../services/library-policy.js";

const MODULE_KEY = "library" as const;

/**
 * Library routes (design §8), registered at `/api/library` (see server.ts).
 * Library is a GATED module — every operational route carries
 * `requireModuleActive("library")` IN ADDITION to `requirePermission(...)`
 * (the attendance precedent).
 *
 * House pattern (mirrors attendance.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `requirePermission(key)` AND `requireModuleActive("library")`;
 *  - every handler runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation writes a `library.*` AuditEvent via `recordAuditEvent` in
 *    the SAME transaction;
 *  - deny branches record a DENIED audit then RETURN the 4xx from a
 *    normally-returning `withTenant` callback (never `throw`) so the audit
 *    commits;
 *  - concurrency: issue/collect take a per-student transaction-scoped advisory
 *    lock then a conditional claim UPDATE on the copy, backstopped by the two
 *    partial unique indexes created in the migration (design §5).
 */
export async function libraryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // ─── Shared helpers ────────────────────────────────────────────────────────

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  // Read the tenant's library module policy (settings JSON) under RLS.
  async function loadPolicy(
    tx: Prisma.TransactionClient,
    institutionId: string,
  ): Promise<LibraryPolicy> {
    const row = await tx.institutionModule.findUnique({
      where: { institutionId_moduleKey: { institutionId, moduleKey: MODULE_KEY } },
      select: { settings: true },
    });
    return libraryPolicy(row?.settings ?? null);
  }

  // Per-student transaction-scoped advisory lock (design §5.4). Keyed on the
  // tenant-qualified student identity so two tenants that hash the same raw
  // studentId do not contend. Held until the tx commits/rolls back.
  async function lockStudent(
    tx: Prisma.TransactionClient,
    institutionId: string,
    studentId: string,
  ): Promise<void> {
    const key = `${institutionId}:${studentId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Count AVAILABLE copies of a title (the `availableCopies` projection, §8.1).
  async function availableCopies(
    tx: Prisma.TransactionClient,
    institutionId: string,
    bookTitleId: string,
  ): Promise<number> {
    return tx.bookCopy.count({
      where: { institutionId, bookTitleId, status: "AVAILABLE" },
    });
  }

  // Normalize an ISBN to digits only; return null for an all-blank input.
  // A present-but-not-10/13-digit value is rejected by the caller.
  function normalizeIsbn(raw: string | undefined | null): string | null {
    if (raw == null) return null;
    const digits = raw.replace(/[^0-9Xx]/g, "");
    return digits.length === 0 ? null : digits;
  }

  function isUniqueViolation(err: unknown, indexHint?: string): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      if (!indexHint) return true;
      const target = err.meta?.target;
      const asText = Array.isArray(target) ? target.join(",") : String(target ?? "");
      return asText.includes(indexHint);
    }
    return false;
  }

  // ─── 8.1 CATALOGUE — BookTitle (librarian) ───────────────────────────────────

  // POST /titles — create a title.
  app.post(
    "/titles",
    { preHandler: [requirePermission("library.books.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createBookTitleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      // ISBN: normalize to digits; a present-but-malformed ISBN is a 400.
      let isbn: string | null = null;
      if (data.isbn != null && data.isbn.trim() !== "") {
        isbn = normalizeIsbn(data.isbn);
        if (!isbn || !(isbn.length === 10 || isbn.length === 13)) {
          return reply.status(400).send({ error: "isbn must be 10 or 13 digits" });
        }
      }

      const outcome = await withTenant(institutionId, async (tx) => {
        // Soft duplicate hint (no hard unique on ISBN, §3.1).
        let duplicateHint: { id: string; title: string } | null = null;
        if (isbn) {
          const existing = await tx.bookTitle.findFirst({
            where: { institutionId, isbn },
            select: { id: true, title: true },
          });
          if (existing) duplicateHint = existing;
        }

        const title = await tx.bookTitle.create({
          data: {
            institutionId,
            title: data.title,
            author: data.author,
            publisher: data.publisher ?? null,
            isbn,
            category: data.category ?? null,
            edition: data.edition ?? null,
            publicationYear: data.publicationYear ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "library.title.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookTitle",
            resourceId: title.id,
            metadata: { isbn: isbn ?? undefined },
          },
          tx,
        );
        return { title, duplicateHint };
      });

      return reply.status(201).send({ title: outcome.title, possibleDuplicate: outcome.duplicateHint });
    },
  );

  // PATCH /titles/:id — edit bibliographic fields.
  app.patch(
    "/titles/:id",
    { preHandler: [requirePermission("library.books.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchBookTitleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      // Normalize a provided ISBN the same way as create.
      let isbnUpdate: string | null | undefined = undefined;
      if ("isbn" in data) {
        if (data.isbn == null || data.isbn.trim() === "") {
          isbnUpdate = null;
        } else {
          const n = normalizeIsbn(data.isbn);
          if (!n || !(n.length === 10 || n.length === 13)) {
            return reply.status(400).send({ error: "isbn must be 10 or 13 digits" });
          }
          isbnUpdate = n;
        }
      }

      const outcome = await withTenant(institutionId, async (tx) => {
        const title = await tx.bookTitle.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!title) return { notFound: true as const };
        if (title.status === "WITHDRAWN") return { conflict: "title withdrawn" as const };

        const updated = await tx.bookTitle.update({
          where: { id: title.id },
          data: {
            ...(data.title !== undefined ? { title: data.title } : {}),
            ...(data.author !== undefined ? { author: data.author } : {}),
            ...("publisher" in data ? { publisher: data.publisher ?? null } : {}),
            ...(isbnUpdate !== undefined ? { isbn: isbnUpdate } : {}),
            ...("category" in data ? { category: data.category ?? null } : {}),
            ...("edition" in data ? { edition: data.edition ?? null } : {}),
            ...("publicationYear" in data ? { publicationYear: data.publicationYear ?? null } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "library.title.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookTitle",
            resourceId: title.id,
          },
          tx,
        );
        return { title: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "title not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.title);
    },
  );

  // GET /titles — staff catalogue read with availableCopies.
  app.get(
    "/titles",
    { preHandler: [requirePermission("library.books.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = catalogueSearchQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, category, page, pageSize } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.BookTitleWhereInput = {
          institutionId,
          ...(category ? { category } : {}),
          ...(q
            ? {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { author: { contains: q, mode: "insensitive" } },
                  { isbn: { contains: q } },
                ],
              }
            : {}),
        };
        const [total, titles] = await Promise.all([
          tx.bookTitle.count({ where }),
          tx.bookTitle.findMany({
            where,
            orderBy: [{ title: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        const withCounts = await Promise.all(
          titles.map(async (t) => ({
            ...t,
            availableCopies: await availableCopies(tx, institutionId, t.id),
          })),
        );
        return { total, titles: withCounts };
      });

      return reply.send({ titles: result.titles, total: result.total, page, pageSize });
    },
  );

  // GET /titles/:id — staff detail with copies + availableCopies.
  app.get(
    "/titles/:id",
    { preHandler: [requirePermission("library.books.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const outcome = await withTenant(institutionId, async (tx) => {
        const title = await tx.bookTitle.findFirst({
          where: { id, institutionId },
          include: { copies: { orderBy: { accessionNumber: "asc" } } },
        });
        if (!title) return { notFound: true as const };
        const available = title.copies.filter((c) => c.status === "AVAILABLE").length;
        return { title, available };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "title not found" });
      return reply.send({ ...outcome.title, availableCopies: outcome.available });
    },
  );

  // ─── 8.2 PHYSICAL COPIES — BookCopy (librarian) ──────────────────────────────

  // POST /titles/:titleId/copies — register a copy.
  app.post(
    "/titles/:titleId/copies",
    { preHandler: [requirePermission("library.books.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { titleId } = request.params as { titleId: string };
      const parsed = registerBookCopySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const title = await tx.bookTitle.findFirst({
          where: { id: titleId, institutionId },
          select: { id: true, status: true },
        });
        if (!title) return { notFound: true as const };
        if (title.status === "WITHDRAWN") return { conflict: "title withdrawn" as const };

        let copy;
        try {
          copy = await tx.bookCopy.create({
            data: {
              institutionId,
              bookTitleId: title.id,
              accessionNumber: data.accessionNumber,
              shelfLocation: data.shelfLocation ?? null,
              condition: data.condition ?? "GOOD",
              acquiredAt: data.acquiredAt ?? null,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "accession number already exists" as const };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "library.copy.registered",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookCopy",
            resourceId: copy.id,
            metadata: { bookTitleId: title.id, accessionNumber: data.accessionNumber },
          },
          tx,
        );
        return { copy };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "title not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(outcome.copy);
    },
  );

  // PATCH /copies/:id — edit shelf/condition (never status directly).
  app.patch(
    "/copies/:id",
    { preHandler: [requirePermission("library.books.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchBookCopySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const copy = await tx.bookCopy.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!copy) return { notFound: true as const };

        const updated = await tx.bookCopy.update({
          where: { id: copy.id },
          data: {
            ...("shelfLocation" in data ? { shelfLocation: data.shelfLocation ?? null } : {}),
            ...(data.condition !== undefined ? { condition: data.condition } : {}),
            ...("acquiredAt" in data ? { acquiredAt: data.acquiredAt ?? null } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "library.copy.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookCopy",
            resourceId: copy.id,
          },
          tx,
        );
        return { copy: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "copy not found" });
      return reply.send(outcome.copy);
    },
  );

  // POST /copies/:id/withdraw — refuse if the copy has an ACTIVE loan.
  app.post(
    "/copies/:id/withdraw",
    { preHandler: [requirePermission("library.books.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const copy = await tx.bookCopy.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!copy) return { notFound: true as const };

        const activeLoan = await tx.libraryLoan.findFirst({
          where: { institutionId, bookCopyId: copy.id, status: "ACTIVE" },
          select: { id: true },
        });
        if (activeLoan) return { conflict: "copy has an active loan" as const };

        const updated = await tx.bookCopy.update({
          where: { id: copy.id },
          data: { status: "WITHDRAWN" },
        });
        await recordAuditEvent(
          {
            action: "library.copy.withdrawn",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookCopy",
            resourceId: copy.id,
          },
          tx,
        );
        return { copy: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "copy not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.copy);
    },
  );

  // POST /copies/:id/damaged — remove a copy from circulation.
  app.post(
    "/copies/:id/damaged",
    { preHandler: [requirePermission("library.books.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = markCopyDamagedSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const copy = await tx.bookCopy.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!copy) return { notFound: true as const };
        if (copy.status === "ISSUED") return { conflict: "copy is on an active loan" as const };

        const updated = await tx.bookCopy.update({
          where: { id: copy.id },
          data: { condition: "DAMAGED", status: "DAMAGED" },
        });
        await recordAuditEvent(
          {
            action: "library.copy.marked_damaged",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookCopy",
            resourceId: copy.id,
          },
          tx,
        );
        return { copy: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "copy not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.copy);
    },
  );

  // ─── 8.3 ISSUE (librarian, concurrency-safe) — POST /loans ───────────────────
  app.post(
    "/loans",
    { preHandler: [requirePermission("library.issue"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = issueLoanSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { bookCopyId, studentId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // 1. Serialize per student so the ACTIVE-loan count below is authoritative.
        await lockStudent(tx, institutionId, studentId);

        // 2. Load the student (tenant-filtered).
        const student = await tx.studentProfile.findFirst({
          where: { id: studentId, institutionId },
          select: { id: true },
        });
        if (!student) return { notFound: true as const };

        // 3. Borrowing limit.
        const policy = await loadPolicy(tx, institutionId);
        const activeCount = await tx.libraryLoan.count({
          where: { institutionId, studentId, status: "ACTIVE" },
        });
        if (activeCount >= policy.maxActiveLoansPerStudent) {
          await recordAuditEvent(
            {
              action: "library.loan.issued",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "LibraryLoan",
              metadata: { reason: "borrowing limit reached", studentId, bookCopyId },
            },
            tx,
          );
          return { deny: "borrowing limit reached" as const };
        }

        // 4. Conditional claim: only an AVAILABLE copy can be issued at the walk-up desk.
        const claimed = await tx.$queryRaw<{ id: string; bookTitleId: string }[]>`
          UPDATE "book_copies"
          SET "status" = 'ISSUED', "updatedAt" = now()
          WHERE "id" = ${bookCopyId} AND "institutionId" = ${institutionId} AND "status" = 'AVAILABLE'
          RETURNING "id", "bookTitleId"
        `;
        if (claimed.length === 0) {
          await recordAuditEvent(
            {
              action: "library.loan.issued",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "LibraryLoan",
              metadata: { reason: "copy not available", studentId, bookCopyId },
            },
            tx,
          );
          return { deny: "copy not available" as const };
        }
        const bookTitleId = claimed[0].bookTitleId;

        // 5. Insert the loan (partial unique backstops the per-copy race).
        const now = new Date();
        let loan;
        try {
          loan = await tx.libraryLoan.create({
            data: {
              institutionId,
              bookCopyId,
              studentId,
              issuedByUserId: request.user.userId,
              issueDate: now,
              dueDate: computeDueDate(now, policy.loanPeriodDays),
              status: "ACTIVE",
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: "copy not available" as const };
          throw err;
        }

        // 6. If this issue fulfils the student's own PENDING reservation, mark it FULFILLED.
        const ownReservation = await tx.bookReservation.findFirst({
          where: { institutionId, bookTitleId, studentId, status: "PENDING" },
          select: { id: true },
        });
        if (ownReservation) {
          await tx.bookReservation.update({
            where: { id: ownReservation.id },
            data: { status: "FULFILLED", fulfilledByCopyId: bookCopyId, fulfilledAt: now },
          });
        }

        await recordAuditEvent(
          {
            action: "library.loan.issued",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryLoan",
            resourceId: loan.id,
            metadata: { studentId, bookCopyId, bookTitleId },
          },
          tx,
        );
        return { loan };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      if ("deny" in outcome) return reply.status(409).send({ error: outcome.deny });
      return reply.status(201).send(outcome.loan);
    },
  );

  // ─── 8.4 RETURN / RENEW (librarian) ──────────────────────────────────────────

  // POST /loans/:id/return
  app.post(
    "/loans/:id/return",
    { preHandler: [requirePermission("library.return"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = returnLoanSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const loan = await tx.libraryLoan.findFirst({
          where: { id, institutionId },
          select: { id: true, bookCopyId: true, studentId: true, dueDate: true, status: true },
        });
        if (!loan) return { notFound: true as const };

        const now = new Date();
        // Conditional close: only an ACTIVE/OVERDUE loan can be returned.
        const closed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "library_loans"
          SET "status" = 'RETURNED', "returnDate" = ${now}, "updatedAt" = now()
          WHERE "id" = ${loan.id} AND "institutionId" = ${institutionId}
            AND "status" IN ('ACTIVE', 'OVERDUE')
          RETURNING "id"
        `;
        if (closed.length === 0) return { conflict: "loan not active" as const };

        // Resolve the copy's title for the reservation handoff.
        const copy = await tx.bookCopy.findFirst({
          where: { id: loan.bookCopyId, institutionId },
          select: { id: true, bookTitleId: true },
        });

        const policy = await loadPolicy(tx, institutionId);
        const overdueDays = computeOverdueDays(loan.dueDate, now);
        let fineId: string | null = null;
        if (policy.finesEnabled && overdueDays > 0) {
          const amount = computeOverdueFine(overdueDays, policy.overdueFinePerDay);
          if (amount > 0) {
            const fine = await tx.libraryFine.create({
              data: {
                institutionId,
                studentId: loan.studentId,
                libraryLoanId: loan.id,
                amount: new Prisma.Decimal(amount),
                reason: "OVERDUE",
                status: "PENDING",
              },
            });
            fineId = fine.id;
            await recordAuditEvent(
              {
                action: "library.fine.created",
                result: "SUCCESS",
                ...actor(request),
                institutionId,
                resourceType: "LibraryFine",
                resourceId: fine.id,
                metadata: { reason: "OVERDUE", overdueDays, libraryLoanId: loan.id },
              },
              tx,
            );
          }
        }

        // Reservation handoff: park the copy RESERVED if a PENDING hold exists, else AVAILABLE.
        let pendingHold = false;
        if (copy) {
          const head = await tx.bookReservation.findFirst({
            where: { institutionId, bookTitleId: copy.bookTitleId, status: "PENDING" },
            orderBy: [{ queuePosition: "asc" }, { reservedAt: "asc" }],
            select: { id: true },
          });
          pendingHold = head !== null;
          await tx.bookCopy.update({
            where: { id: copy.id },
            data: { status: pendingHold ? "RESERVED" : "AVAILABLE" },
          });
        }

        await recordAuditEvent(
          {
            action: "library.loan.returned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryLoan",
            resourceId: loan.id,
            metadata: { overdueDays, fineCreated: fineId !== null, parkedReserved: pendingHold },
          },
          tx,
        );
        return { ok: true as const, loanId: loan.id, overdueDays, fineId };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "loan not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send({ loanId: outcome.loanId, overdueDays: outcome.overdueDays, fineId: outcome.fineId });
    },
  );

  // POST /loans/:id/renew
  app.post(
    "/loans/:id/renew",
    { preHandler: [requirePermission("library.return"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = renewLoanSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const loan = await tx.libraryLoan.findFirst({
          where: { id, institutionId },
          select: { id: true, bookCopyId: true, status: true, dueDate: true },
        });
        if (!loan) return { notFound: true as const };

        // Refuse if the title has a PENDING reservation queue.
        const copy = await tx.bookCopy.findFirst({
          where: { id: loan.bookCopyId, institutionId },
          select: { bookTitleId: true },
        });
        if (copy) {
          const pending = await tx.bookReservation.findFirst({
            where: { institutionId, bookTitleId: copy.bookTitleId, status: "PENDING" },
            select: { id: true },
          });
          if (pending) return { conflict: "title has a pending reservation" as const };
        }

        const policy = await loadPolicy(tx, institutionId);
        const newDue = computeDueDate(new Date(), policy.loanPeriodDays);
        // Conditional renew: ACTIVE and under the renewal cap.
        const renewed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "library_loans"
          SET "renewalCount" = "renewalCount" + 1, "dueDate" = ${newDue}, "updatedAt" = now()
          WHERE "id" = ${loan.id} AND "institutionId" = ${institutionId}
            AND "status" = 'ACTIVE' AND "renewalCount" < ${policy.maxRenewals}
          RETURNING "id"
        `;
        if (renewed.length === 0) return { conflict: "loan not renewable" as const };

        const updated = await tx.libraryLoan.findFirst({
          where: { id: loan.id, institutionId },
        });
        await recordAuditEvent(
          {
            action: "library.loan.renewed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryLoan",
            resourceId: loan.id,
            metadata: { dueDate: newDue.toISOString() },
          },
          tx,
        );
        return { loan: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "loan not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.loan);
    },
  );

  // ─── 8.5 MARK LOST (librarian) — POST /loans/:id/lost ────────────────────────
  app.post(
    "/loans/:id/lost",
    { preHandler: [requirePermission("library.return"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = markLoanLostSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const loan = await tx.libraryLoan.findFirst({
          where: { id, institutionId },
          select: { id: true, bookCopyId: true, studentId: true, status: true },
        });
        if (!loan) return { notFound: true as const };

        const now = new Date();
        // Conditional: only an ACTIVE/OVERDUE loan can be marked lost.
        const closed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "library_loans"
          SET "status" = 'LOST', "returnDate" = ${now}, "updatedAt" = now()
          WHERE "id" = ${loan.id} AND "institutionId" = ${institutionId}
            AND "status" IN ('ACTIVE', 'OVERDUE')
          RETURNING "id"
        `;
        if (closed.length === 0) return { conflict: "loan not active" as const };

        await tx.bookCopy.update({
          where: { id: loan.bookCopyId },
          data: { status: "LOST" },
        });

        const policy = await loadPolicy(tx, institutionId);
        let fineId: string | null = null;
        if (policy.finesEnabled && policy.lostFineAmount > 0) {
          const fine = await tx.libraryFine.create({
            data: {
              institutionId,
              studentId: loan.studentId,
              libraryLoanId: loan.id,
              amount: new Prisma.Decimal(policy.lostFineAmount),
              reason: "LOST",
              status: "PENDING",
              note: data.note ?? null,
            },
          });
          fineId = fine.id;
          await recordAuditEvent(
            {
              action: "library.fine.created",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "LibraryFine",
              resourceId: fine.id,
              metadata: { reason: "LOST", libraryLoanId: loan.id },
            },
            tx,
          );
        }

        await recordAuditEvent(
          {
            action: "library.copy.marked_lost",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookCopy",
            resourceId: loan.bookCopyId,
            metadata: { libraryLoanId: loan.id, fineCreated: fineId !== null },
          },
          tx,
        );
        return { ok: true as const, loanId: loan.id, fineId };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "loan not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send({ loanId: outcome.loanId, fineId: outcome.fineId });
    },
  );

  // ─── 8.6 RESERVATIONS ─────────────────────────────────────────────────────────

  // Resolve the caller's own StudentProfile id (never from input).
  async function callerStudentId(
    tx: Prisma.TransactionClient,
    institutionId: string,
    userId: string,
  ): Promise<string | null> {
    const student = await tx.studentProfile.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    return student?.id ?? null;
  }

  // POST /reservations (student) — create a hold on a title.
  app.post(
    "/reservations",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createReservationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { bookTitleId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await callerStudentId(tx, institutionId, request.user.userId);
        if (!studentId) return { notFound: "student" as const };

        const title = await tx.bookTitle.findFirst({
          where: { id: bookTitleId, institutionId },
          select: { id: true, status: true },
        });
        if (!title) return { notFound: "title" as const };
        if (title.status === "WITHDRAWN") return { conflict: "title withdrawn" as const };

        // Refuse if a copy is currently available — borrow instead.
        const available = await availableCopies(tx, institutionId, bookTitleId);
        if (available > 0) return { conflict: "copy available - borrow instead" as const };

        const maxQueue = await tx.bookReservation.aggregate({
          where: { institutionId, bookTitleId, status: "PENDING" },
          _max: { queuePosition: true },
        });
        const queuePosition = (maxQueue._max.queuePosition ?? 0) + 1;

        let reservation;
        try {
          reservation = await tx.bookReservation.create({
            data: { institutionId, bookTitleId, studentId, queuePosition, status: "PENDING" },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { conflict: "reservation already pending" as const };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "library.reservation.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookReservation",
            resourceId: reservation.id,
            metadata: { bookTitleId, queuePosition },
          },
          tx,
        );
        return { reservation };
      });

      if ("notFound" in outcome) {
        return reply
          .status(404)
          .send({ error: outcome.notFound === "student" ? "student not found" : "title not found" });
      }
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.status(201).send(outcome.reservation);
    },
  );

  // POST /reservations/:id/cancel (student) — cancel own PENDING hold.
  app.post(
    "/reservations/:id/cancel",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = cancelReservationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await callerStudentId(tx, institutionId, request.user.userId);
        if (!studentId) return { notFound: true as const };

        const reservation = await tx.bookReservation.findFirst({
          where: { id, institutionId, studentId },
          select: { id: true, status: true },
        });
        if (!reservation) return { notFound: true as const };
        if (reservation.status !== "PENDING") return { conflict: "reservation not pending" as const };

        const updated = await tx.bookReservation.update({
          where: { id: reservation.id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });
        await recordAuditEvent(
          {
            action: "library.reservation.cancelled",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookReservation",
            resourceId: reservation.id,
          },
          tx,
        );
        return { reservation: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "reservation not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.reservation);
    },
  );

  // POST /reservations/:id/fulfil (librarian) — designate-and-hold a copy.
  app.post(
    "/reservations/:id/fulfil",
    { preHandler: [requirePermission("library.reservations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = fulfilReservationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { bookCopyId } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const reservation = await tx.bookReservation.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, bookTitleId: true, queuePosition: true },
        });
        if (!reservation) return { notFound: true as const };
        if (reservation.status !== "PENDING") return { conflict: "reservation not pending" as const };

        // Assert this is the FIFO-head PENDING reservation for the title.
        const head = await tx.bookReservation.findFirst({
          where: { institutionId, bookTitleId: reservation.bookTitleId, status: "PENDING" },
          orderBy: [{ queuePosition: "asc" }, { reservedAt: "asc" }],
          select: { id: true },
        });
        if (!head || head.id !== reservation.id) return { conflict: "not the head of the queue" as const };

        // The copy must belong to the reserved title.
        const copy = await tx.bookCopy.findFirst({
          where: { id: bookCopyId, institutionId, bookTitleId: reservation.bookTitleId },
          select: { id: true },
        });
        if (!copy) return { notFound: true as const };

        // Conditional claim: an AVAILABLE copy (or one already parked RESERVED).
        const now = new Date();
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "book_copies"
          SET "status" = 'RESERVED', "updatedAt" = now()
          WHERE "id" = ${bookCopyId} AND "institutionId" = ${institutionId}
            AND "status" IN ('AVAILABLE', 'RESERVED')
          RETURNING "id"
        `;
        if (claimed.length === 0) return { conflict: "copy not available" as const };

        const updated = await tx.bookReservation.update({
          where: { id: reservation.id },
          data: { status: "FULFILLED", fulfilledByCopyId: bookCopyId, fulfilledAt: now },
        });
        await recordAuditEvent(
          {
            action: "library.reservation.fulfilled",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookReservation",
            resourceId: reservation.id,
            metadata: { bookCopyId, bookTitleId: reservation.bookTitleId },
          },
          tx,
        );
        return { reservation: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "reservation or copy not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.reservation);
    },
  );

  // POST /reservations/:id/collect (librarian) — the reservation-fulfilment issue.
  app.post(
    "/reservations/:id/collect",
    { preHandler: [requirePermission("library.reservations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = collectReservationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const reservation = await tx.bookReservation.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, studentId: true, fulfilledByCopyId: true, bookTitleId: true },
        });
        if (!reservation) return { notFound: true as const };
        if (reservation.status !== "FULFILLED" || !reservation.fulfilledByCopyId) {
          return { conflict: "reservation not ready to collect" as const };
        }
        const studentId = reservation.studentId;
        const bookCopyId = reservation.fulfilledByCopyId;

        // Per-student advisory lock + borrowing-limit enforcement (§5.4).
        await lockStudent(tx, institutionId, studentId);
        const policy = await loadPolicy(tx, institutionId);
        const activeCount = await tx.libraryLoan.count({
          where: { institutionId, studentId, status: "ACTIVE" },
        });
        if (activeCount >= policy.maxActiveLoansPerStudent) {
          await recordAuditEvent(
            {
              action: "library.loan.issued",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "LibraryLoan",
              metadata: { reason: "borrowing limit reached", studentId, bookCopyId },
            },
            tx,
          );
          return { deny: "borrowing limit reached" as const };
        }

        // Conditional claim guarded on RESERVED (the parked copy).
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "book_copies"
          SET "status" = 'ISSUED', "updatedAt" = now()
          WHERE "id" = ${bookCopyId} AND "institutionId" = ${institutionId} AND "status" = 'RESERVED'
          RETURNING "id"
        `;
        if (claimed.length === 0) return { deny: "copy not available" as const };

        const now = new Date();
        let loan;
        try {
          loan = await tx.libraryLoan.create({
            data: {
              institutionId,
              bookCopyId,
              studentId,
              issuedByUserId: request.user.userId,
              issueDate: now,
              dueDate: computeDueDate(now, policy.loanPeriodDays),
              status: "ACTIVE",
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: "copy not available" as const };
          throw err;
        }

        await recordAuditEvent(
          {
            action: "library.loan.issued",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryLoan",
            resourceId: loan.id,
            metadata: { studentId, bookCopyId, reservationId: reservation.id },
          },
          tx,
        );
        return { loan };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "reservation not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      if ("deny" in outcome) return reply.status(409).send({ error: outcome.deny });
      return reply.status(201).send(outcome.loan);
    },
  );

  // POST /reservations/:id/cancel-hold (librarian) — cancel on behalf of circulation.
  app.post(
    "/reservations/:id/cancel-hold",
    { preHandler: [requirePermission("library.reservations.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = cancelReservationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const outcome = await withTenant(institutionId, async (tx) => {
        const reservation = await tx.bookReservation.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, bookTitleId: true, fulfilledByCopyId: true },
        });
        if (!reservation) return { notFound: true as const };
        if (reservation.status !== "PENDING" && reservation.status !== "FULFILLED") {
          return { conflict: "reservation not cancellable" as const };
        }

        const now = new Date();
        // Release a parked copy, if any: re-park for the next PENDING head else AVAILABLE.
        if (reservation.status === "FULFILLED" && reservation.fulfilledByCopyId) {
          const nextHead = await tx.bookReservation.findFirst({
            where: {
              institutionId,
              bookTitleId: reservation.bookTitleId,
              status: "PENDING",
              id: { not: reservation.id },
            },
            orderBy: [{ queuePosition: "asc" }, { reservedAt: "asc" }],
            select: { id: true },
          });
          await tx.bookCopy.update({
            where: { id: reservation.fulfilledByCopyId },
            data: { status: nextHead ? "RESERVED" : "AVAILABLE" },
          });
        }

        const updated = await tx.bookReservation.update({
          where: { id: reservation.id },
          data: { status: "CANCELLED", cancelledAt: now },
        });
        await recordAuditEvent(
          {
            action: "library.reservation.cancelled",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "BookReservation",
            resourceId: reservation.id,
          },
          tx,
        );
        return { reservation: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "reservation not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.reservation);
    },
  );

  // ─── 8.? FINES (librarian) ────────────────────────────────────────────────────

  // GET /fines — list fines (optionally filter by status).
  app.get(
    "/fines",
    { preHandler: [requirePermission("library.fines.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { status } = request.query as { status?: string };
      const fines = await withTenant(institutionId, (tx) =>
        tx.libraryFine.findMany({
          where: {
            institutionId,
            ...(status === "PENDING" || status === "PAID" || status === "WAIVED"
              ? { status }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        }),
      );
      return reply.send({ fines });
    },
  );

  // POST /fines — create a manual fine (rule-driven elsewhere, manual here).
  app.post(
    "/fines",
    { preHandler: [requirePermission("library.fines.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createLibraryFineSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const student = await tx.studentProfile.findFirst({
          where: { id: data.studentId, institutionId },
          select: { id: true },
        });
        if (!student) return { notFound: "student" as const };

        if (data.libraryLoanId) {
          const loan = await tx.libraryLoan.findFirst({
            where: { id: data.libraryLoanId, institutionId },
            select: { id: true },
          });
          if (!loan) return { notFound: "loan" as const };
        }

        const fine = await tx.libraryFine.create({
          data: {
            institutionId,
            studentId: data.studentId,
            libraryLoanId: data.libraryLoanId ?? null,
            amount: new Prisma.Decimal(data.amount),
            reason: data.reason,
            status: "PENDING",
            note: data.note ?? null,
          },
        });
        await recordAuditEvent(
          {
            action: "library.fine.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryFine",
            resourceId: fine.id,
            metadata: { studentId: data.studentId, reason: data.reason },
          },
          tx,
        );
        return { fine };
      });

      if ("notFound" in outcome) {
        return reply
          .status(404)
          .send({ error: outcome.notFound === "student" ? "student not found" : "loan not found" });
      }
      return reply.status(201).send(outcome.fine);
    },
  );

  // POST /fines/:id/waive
  app.post(
    "/fines/:id/waive",
    { preHandler: [requirePermission("library.fines.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = waiveLibraryFineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const fine = await tx.libraryFine.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, note: true },
        });
        if (!fine) return { notFound: true as const };
        if (fine.status !== "PENDING") return { conflict: "fine not pending" as const };

        const updated = await tx.libraryFine.update({
          where: { id: fine.id },
          data: {
            status: "WAIVED",
            waivedByUserId: request.user.userId,
            waivedAt: new Date(),
            ...(data.note !== undefined ? { note: data.note } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "library.fine.waived",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryFine",
            resourceId: fine.id,
          },
          tx,
        );
        return { fine: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "fine not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.fine);
    },
  );

  // POST /fines/:id/pay
  app.post(
    "/fines/:id/pay",
    { preHandler: [requirePermission("library.fines.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = payLibraryFineSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const fine = await tx.libraryFine.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!fine) return { notFound: true as const };
        if (fine.status !== "PENDING") return { conflict: "fine not pending" as const };

        const updated = await tx.libraryFine.update({
          where: { id: fine.id },
          data: {
            status: "PAID",
            paidRecordedByUserId: request.user.userId,
            paidAt: new Date(),
            ...(data.note !== undefined ? { note: data.note } : {}),
          },
        });
        await recordAuditEvent(
          {
            action: "library.fine.paid",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "LibraryFine",
            resourceId: fine.id,
          },
          tx,
        );
        return { fine: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "fine not found" });
      if ("conflict" in outcome) return reply.status(409).send({ error: outcome.conflict });
      return reply.send(outcome.fine);
    },
  );

  // ─── 8.8 OVERDUE REMINDERS — POST /overdue/remind ────────────────────────────
  app.post(
    "/overdue/remind",
    { preHandler: [requirePermission("library.books.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const now = new Date();

      // 1. Sweep: gather overdue loans + optionally flip them to OVERDUE, and
      //    expire stale FULFILLED reservations, in one tenant tx.
      let targets: Array<{ loanId: string; studentId: string; dueDate: Date }> = [];
      try {
        targets = await withTenant(institutionId, async (tx) => {
          const overdueLoans = await tx.libraryLoan.findMany({
            where: {
              institutionId,
              status: "ACTIVE",
              returnDate: null,
              dueDate: { lt: now },
            },
            select: { id: true, studentId: true, dueDate: true },
          });

          // Flip long-overdue ACTIVE loans to OVERDUE (derived predicate holds either way).
          if (overdueLoans.length > 0) {
            await tx.libraryLoan.updateMany({
              where: { institutionId, status: "ACTIVE", returnDate: null, dueDate: { lt: now } },
              data: { status: "OVERDUE" },
            });
          }

          // Expire stale FULFILLED reservations whose pickup clock elapsed; release parked copies.
          const policy = await loadPolicy(tx, institutionId);
          const expiryMs = policy.reservationExpiryDays * 24 * 60 * 60 * 1000;
          const cutoff = new Date(now.getTime() - expiryMs);
          const stale = await tx.bookReservation.findMany({
            where: {
              institutionId,
              status: "FULFILLED",
              fulfilledAt: { lt: cutoff },
              NOT: { fulfilledByCopyId: null },
            },
            select: { id: true, fulfilledByCopyId: true, bookTitleId: true },
          });
          for (const res of stale) {
            const nextHead = await tx.bookReservation.findFirst({
              where: {
                institutionId,
                bookTitleId: res.bookTitleId,
                status: "PENDING",
                id: { not: res.id },
              },
              orderBy: [{ queuePosition: "asc" }, { reservedAt: "asc" }],
              select: { id: true },
            });
            if (res.fulfilledByCopyId) {
              await tx.bookCopy.update({
                where: { id: res.fulfilledByCopyId },
                data: { status: nextHead ? "RESERVED" : "AVAILABLE" },
              });
            }
            await tx.bookReservation.update({
              where: { id: res.id },
              data: { status: "EXPIRED", expiredAt: now },
            });
            await recordAuditEvent(
              {
                action: "library.reservation.expired",
                result: "SUCCESS",
                ...actor(request),
                institutionId,
                resourceType: "BookReservation",
                resourceId: res.id,
              },
              tx,
            );
          }

          return overdueLoans.map((l) => ({ loanId: l.id, studentId: l.studentId, dueDate: l.dueDate }));
        });
      } catch (err) {
        request.log.warn({ err }, "overdue sweep failed");
        return reply.status(500).send({ error: "overdue sweep failed" });
      }

      // 2. Per-student reminder in a FRESH short withTenant tx (best-effort; one
      //    failure does not roll back the others — the Phase-4 post-commit shape).
      const act = actor(request);
      let reminded = 0;
      for (const t of targets) {
        try {
          await withTenant(institutionId, async (tx) => {
            const student = await tx.studentProfile.findFirst({
              where: { id: t.studentId, institutionId },
              select: { userId: true },
            });
            if (!student) return;
            await notifyUser(
              student.userId,
              {
                title: "Overdue library book",
                body: "You have an overdue library book. Please return it.",
                type: "library.overdue",
                data: { loanId: t.loanId, dueDate: t.dueDate.toISOString() },
              },
              tx,
            );
            await recordAuditEvent(
              {
                action: "library.overdue.reminded",
                result: "SUCCESS",
                ...act,
                institutionId,
                resourceType: "LibraryLoan",
                resourceId: t.loanId,
              },
              tx,
            );
          });
          reminded += 1;
        } catch (err) {
          request.log.warn({ err, loanId: t.loanId }, "overdue reminder failed");
        }
      }

      return reply.send({ overdueCount: targets.length, reminded });
    },
  );

  // ─── 8.9 STUDENT SELF-SERVICE (library.view_own) ─────────────────────────────

  // GET /catalogue — search titles by title/author/isbn/category with availableCopies.
  app.get(
    "/catalogue",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = catalogueSearchQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, category, page, pageSize } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.BookTitleWhereInput = {
          institutionId,
          status: "ACTIVE",
          ...(category ? { category } : {}),
          ...(q
            ? {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { author: { contains: q, mode: "insensitive" } },
                  { isbn: { contains: q } },
                ],
              }
            : {}),
        };
        const [total, titles] = await Promise.all([
          tx.bookTitle.count({ where }),
          tx.bookTitle.findMany({
            where,
            orderBy: [{ title: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
              id: true,
              title: true,
              author: true,
              publisher: true,
              isbn: true,
              category: true,
              edition: true,
              publicationYear: true,
            },
          }),
        ]);
        const withCounts = await Promise.all(
          titles.map(async (t) => ({
            ...t,
            availableCopies: await availableCopies(tx, institutionId, t.id),
          })),
        );
        return { total, titles: withCounts };
      });

      return reply.send({ titles: result.titles, total: result.total, page, pageSize });
    },
  );

  // GET /me/loans — the caller's OWN active/overdue loans.
  app.get(
    "/me/loans",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await callerStudentId(tx, institutionId, request.user.userId);
        if (!studentId) return { notFound: true as const };
        const loans = await tx.libraryLoan.findMany({
          where: { institutionId, studentId, status: { in: ["ACTIVE", "OVERDUE"] } },
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          include: { bookCopy: { include: { bookTitle: { select: { title: true, author: true } } } } },
        });
        return { loans };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      return reply.send({ loans: outcome.loans });
    },
  );

  // GET /me/loans/history — the caller's OWN returned/lost loan history.
  app.get(
    "/me/loans/history",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await callerStudentId(tx, institutionId, request.user.userId);
        if (!studentId) return { notFound: true as const };
        const loans = await tx.libraryLoan.findMany({
          where: { institutionId, studentId, status: { in: ["RETURNED", "LOST"] } },
          orderBy: [{ returnDate: "desc" }, { id: "asc" }],
          include: { bookCopy: { include: { bookTitle: { select: { title: true, author: true } } } } },
        });
        return { loans };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      return reply.send({ loans: outcome.loans });
    },
  );

  // GET /me/reservations — the caller's OWN reservations + queue positions.
  app.get(
    "/me/reservations",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await callerStudentId(tx, institutionId, request.user.userId);
        if (!studentId) return { notFound: true as const };
        const reservations = await tx.bookReservation.findMany({
          where: { institutionId, studentId },
          orderBy: [{ reservedAt: "desc" }, { id: "asc" }],
          include: { bookTitle: { select: { title: true, author: true } } },
        });
        return { reservations };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      return reply.send({ reservations: outcome.reservations });
    },
  );

  // GET /me/fines — the caller's OWN fines.
  app.get(
    "/me/fines",
    { preHandler: [requirePermission("library.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const outcome = await withTenant(institutionId, async (tx) => {
        const studentId = await callerStudentId(tx, institutionId, request.user.userId);
        if (!studentId) return { notFound: true as const };
        const fines = await tx.libraryFine.findMany({
          where: { institutionId, studentId },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        });
        return { fines };
      });
      if ("notFound" in outcome) return reply.status(404).send({ error: "student not found" });
      return reply.send({ fines: outcome.fines });
    },
  );

  // ─── 8.10 REPORTS (librarian / admin, library.books.view) ────────────────────

  // GET /reports/summary — tenant-scoped library aggregates.
  app.get(
    "/reports/summary",
    { preHandler: [requirePermission("library.books.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const now = new Date();
      const summary = await withTenant(institutionId, async (tx) => {
        const [
          totalTitles,
          totalCopies,
          copiesByStatus,
          activeLoans,
          overdueLoans,
          pendingReservations,
          outstanding,
        ] = await Promise.all([
          tx.bookTitle.count({ where: { institutionId } }),
          tx.bookCopy.count({ where: { institutionId } }),
          tx.bookCopy.groupBy({
            by: ["status"],
            where: { institutionId },
            _count: { _all: true },
          }),
          tx.libraryLoan.count({ where: { institutionId, status: "ACTIVE" } }),
          tx.libraryLoan.count({
            where: { institutionId, status: { in: ["ACTIVE", "OVERDUE"] }, returnDate: null, dueDate: { lt: now } },
          }),
          tx.bookReservation.count({ where: { institutionId, status: "PENDING" } }),
          tx.libraryFine.aggregate({
            where: { institutionId, status: "PENDING" },
            _sum: { amount: true },
          }),
        ]);

        const byStatus: Record<string, number> = {};
        for (const row of copiesByStatus) byStatus[row.status] = row._count._all;

        return {
          totalTitles,
          totalCopies,
          copiesByStatus: byStatus,
          activeLoans,
          overdueLoans,
          pendingReservations,
          outstandingFinesTotal: outstanding._sum.amount ? outstanding._sum.amount.toString() : "0",
        };
      });
      return reply.send(summary);
    },
  );

  // GET /reports/circulation?from=&to= — issue/return counts over a window.
  app.get(
    "/reports/circulation",
    { preHandler: [requirePermission("library.books.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = libraryReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { from, to } = parsed.data;

      const report = await withTenant(institutionId, async (tx) => {
        const issueWindow: Prisma.LibraryLoanWhereInput = {
          institutionId,
          ...(from || to ? { issueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        };
        const returnWindow: Prisma.LibraryLoanWhereInput = {
          institutionId,
          returnDate: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
        };
        const [issued, returned] = await Promise.all([
          tx.libraryLoan.count({ where: issueWindow }),
          tx.libraryLoan.count({ where: returnWindow }),
        ]);
        return { issued, returned };
      });

      return reply.send({
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        ...report,
      });
    },
  );
}
