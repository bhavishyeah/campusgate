import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createInventoryCategorySchema,
  patchInventoryCategorySchema,
  createInventoryAssetSchema,
  patchInventoryAssetSchema,
  inventoryTransferSchema,
  inventoryStockMovementSchema,
  createInventoryMaintenanceSchema,
  inventoryMaintenanceTransitionSchema,
  inventoryDisposalSchema,
  createInventoryAuditSessionSchema,
  inventoryAuditLineSchema,
  inventoryListQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";

const MODULE_KEY = "inventory" as const;

/**
 * Inventory & Assets Management routes (design §B.9), registered at
 * `/api/inventory` (see server.ts). Inventory is a GATED "booster" module — every
 * operational route carries `requireModuleActive("inventory")` IN ADDITION to
 * `requirePermission("inventory.*")` (the transport/hostel precedent).
 *
 * House pattern (mirrors transport.ts verbatim):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive("inventory")]`;
 *  - every handler body runs inside `withTenant(institutionId, tx => ...)` with
 *    `institutionId` from the verified token (`request.user`), never from input;
 *  - every mutation (and every DENIED lifecycle/stock decision) writes an
 *    `inventory.*` AuditEvent via `recordAuditEvent` in the SAME transaction;
 *  - deny branches record a DENIED audit then RETURN the 4xx from a
 *    normally-returning `withTenant` callback (never `throw`) so the audit
 *    commits (design §B.9);
 *  - stock concurrency: a transaction-scoped advisory lock on the
 *    tenant-qualified STOCK ITEM (`inventorystock:${institutionId}:${stockItemId}`)
 *    taken by EVERY movement kind (RECEIPT/ISSUE/ADJUSTMENT) before reading +
 *    mutating the STORED `onHandQuantity` and inserting the movement row, all in
 *    one tx (design §B.4 universal lock rule). The onHandQuantity >= 0 CHECK +
 *    balanceAfter >= 0 CHECK are the DB backstop.
 *
 * Money boundary: acquisitionCost / cost / proceeds are int minor units in the DB
 * but cross the JSON boundary as a decimal-digit STRING (money-as-string,
 * design §B.9).
 */
export async function inventoryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // ─── Shared helpers (verbatim from transport.ts) ────────────────────────────

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  interface Deny {
    deny: string;
    status: number;
  }
  function deny(message: string, status: number): Deny {
    return { deny: message, status };
  }
  function isDeny(x: unknown): x is { deny: Deny } {
    return (
      typeof x === "object" &&
      x !== null &&
      "deny" in x &&
      typeof (x as { deny: unknown }).deny === "object"
    );
  }

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  }
  function isRestrictViolation(err: unknown): boolean {
    // Postgres restrict_violation (23001) raised by the column-guard /
    // append-only triggers surfaces through Prisma carrying the trigger message.
    const msg = String((err as Error)?.message ?? err);
    return msg.includes("restrict_violation") || msg.includes("illegal") || msg.includes("append-only");
  }

  // Advisory xact lock on a tenant-qualified key (the transport advisoryLock
  // idiom). The lock key is a JS string passed as a Prisma tagged-template BOUND
  // PARAMETER — never built via in-SQL single-quoted string interpolation. Held
  // until the tx commits/rolls back.
  async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Tenant-qualified per-stock-item lock key so two tenants hashing the same
  // stockItemId do not contend (design §B.4).
  function stockLockKey(institutionId: string, stockItemId: string): string {
    return `inventorystock:${institutionId}:${stockItemId}`;
  }

  // Money fields are int minor units in the DB; serialize back as a decimal-digit
  // STRING on every response (money-as-string, design §B.9).
  function serializeAsset<
    T extends { acquisitionCost: number | null },
  >(asset: T) {
    return {
      ...asset,
      acquisitionCost: asset.acquisitionCost === null ? null : String(asset.acquisitionCost),
    };
  }
  function serializeMaintenance<T extends { cost: number | null }>(req: T) {
    return { ...req, cost: req.cost === null ? null : String(req.cost) };
  }
  function serializeDisposal<T extends { proceeds: number | null }>(d: T) {
    return { ...d, proceeds: d.proceeds === null ? null : String(d.proceeds) };
  }

  // Terminal asset statuses — no further custody/maintenance/disposal (§B.5).
  function isTerminal(status: string): boolean {
    return status === "DISPOSED" || status === "RETIRED";
  }

  // ─── 1. POST /categories — create a category ────────────────────────────────
  app.post(
    "/categories",
    { preHandler: [requirePermission("inventory.categories.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createInventoryCategorySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let category;
        try {
          category = await tx.inventoryAssetCategory.create({
            data: {
              institutionId,
              name: data.name,
              code: data.code,
              kind: data.kind,
              depreciationMethod: data.depreciationMethod ?? null,
              usefulLifeMonths: data.usefulLifeMonths ?? null,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("category code already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "inventory.category.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAssetCategory",
            resourceId: category.id,
          },
          tx,
        );
        return { category };
      });

      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.category);
    },
  );

  // ─── 2. PATCH /categories/:id — edit a category ─────────────────────────────
  app.patch(
    "/categories/:id",
    { preHandler: [requirePermission("inventory.categories.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchInventoryCategorySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const category = await tx.inventoryAssetCategory.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!category) return { notFound: true as const };

        let updated;
        try {
          updated = await tx.inventoryAssetCategory.update({
            where: { id: category.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...(data.kind !== undefined ? { kind: data.kind } : {}),
              ...("depreciationMethod" in data ? { depreciationMethod: data.depreciationMethod ?? null } : {}),
              ...("usefulLifeMonths" in data ? { usefulLifeMonths: data.usefulLifeMonths ?? null } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("category code already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "inventory.category.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAssetCategory",
            resourceId: category.id,
          },
          tx,
        );
        return { category: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "category not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.category);
    },
  );

  // ─── 3. GET /categories — staff list ────────────────────────────────────────
  app.get(
    "/categories",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = inventoryListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, kind } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.InventoryAssetCategoryWhereInput = {
          institutionId,
          ...(kind ? { kind: kind as Prisma.InventoryAssetCategoryWhereInput["kind"] } : {}),
        };
        const [total, categories] = await Promise.all([
          tx.inventoryAssetCategory.count({ where }),
          tx.inventoryAssetCategory.findMany({
            where,
            orderBy: [{ code: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, categories };
      });

      return reply.send({ categories: result.categories, total: result.total, page, pageSize });
    },
  );

  // ─── 4. POST /assets — create an asset (+ stock item for CONSUMABLE) ─────────
  app.post(
    "/assets",
    { preHandler: [requirePermission("inventory.assets.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createInventoryAssetSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        // Category must exist in-tenant (composite FK backstops too).
        const category = await tx.inventoryAssetCategory.findFirst({
          where: { id: data.categoryId, institutionId },
          select: { id: true, kind: true },
        });
        if (!category) return { notFound: "category not found" as const };

        // If a custodian is named the asset starts ASSIGNED; else IN_STORE.
        const startStatus = data.custodyUserId !== undefined || data.custodyDepartmentId !== undefined
          ? "ASSIGNED"
          : "IN_STORE";

        let asset;
        try {
          asset = await tx.inventoryAsset.create({
            data: {
              institutionId,
              assetTag: data.assetTag,
              name: data.name,
              categoryId: category.id,
              status: startStatus,
              acquisitionDate: data.acquisitionDate ?? null,
              acquisitionCost: data.acquisitionCost !== undefined ? Number(data.acquisitionCost) : null,
              currency: data.currency ?? null,
              location: data.location ?? null,
              custodyUserId: data.custodyUserId ?? null,
              custodyDepartmentId: data.custodyDepartmentId ?? null,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("asset tag already exists", 409) };
          throw err;
        }

        // A CONSUMABLE asset gets its 1:1 stock item (on-hand starts at 0).
        if (category.kind === "CONSUMABLE") {
          await tx.inventoryStockItem.create({
            data: {
              institutionId,
              assetId: asset.id,
              onHandQuantity: 0,
              createdByUserId: request.user.userId,
            },
          });
        }

        await recordAuditEvent(
          {
            action: "inventory.asset.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAsset",
            resourceId: asset.id,
            metadata: { kind: category.kind },
          },
          tx,
        );
        return { asset };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(serializeAsset(outcome.asset));
    },
  );

  // ─── 5. PATCH /assets/:id — edit asset master attributes ─────────────────────
  // Identity cols (assetTag/categoryId/acquisition*/currency) are frozen by the
  // DB guard once set at create; the guard rejects a change. Editable here:
  // name, location. Status/custody are driven by dedicated handlers only.
  app.patch(
    "/assets/:id",
    { preHandler: [requirePermission("inventory.assets.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = patchInventoryAssetSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const asset = await tx.inventoryAsset.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!asset) return { notFound: true as const };
        if (isTerminal(asset.status)) {
          await recordAuditEvent(
            {
              action: "inventory.asset.updated",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryAsset",
              resourceId: asset.id,
              metadata: { reason: "asset is terminal", status: asset.status },
            },
            tx,
          );
          return { deny: deny("asset is terminal", 409) };
        }

        let updated;
        try {
          updated = await tx.inventoryAsset.update({
            where: { id: asset.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...("location" in data ? { location: data.location ?? null } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("asset tag already exists", 409) };
          if (isRestrictViolation(err)) return { deny: deny("immutable asset column changed", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "inventory.asset.updated",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAsset",
            resourceId: asset.id,
          },
          tx,
        );
        return { asset: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "asset not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(serializeAsset(outcome.asset));
    },
  );

  // ─── 6. GET /assets — staff list (filter status/categoryId) ──────────────────
  app.get(
    "/assets",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = inventoryListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status, categoryId } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.InventoryAssetWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.InventoryAssetWhereInput["status"] } : {}),
          ...(categoryId ? { categoryId } : {}),
        };
        const [total, assets] = await Promise.all([
          tx.inventoryAsset.count({ where }),
          tx.inventoryAsset.findMany({
            where,
            orderBy: [{ assetTag: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, assets };
      });

      return reply.send({
        assets: result.assets.map(serializeAsset),
        total: result.total,
        page,
        pageSize,
      });
    },
  );

  // ─── 7. GET /assets/:id — staff detail ───────────────────────────────────────
  app.get(
    "/assets/:id",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const asset = await withTenant(institutionId, async (tx) =>
        tx.inventoryAsset.findFirst({ where: { id, institutionId } }),
      );
      if (!asset) return reply.status(404).send({ error: "asset not found" });
      return reply.send(serializeAsset(asset));
    },
  );

  // ─── 8. POST /assets/:id/transfer — custody transfer (§B.8) ──────────────────
  // Updates the asset's current custody AND inserts one append-only ledger row in
  // ONE tx. A DISPOSED/RETIRED asset cannot be transferred (409 + DENIED audit).
  app.post(
    "/assets/:id/transfer",
    { preHandler: [requirePermission("inventory.assets.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = inventoryTransferSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const asset = await tx.inventoryAsset.findFirst({
          where: { id, institutionId },
          select: {
            id: true,
            status: true,
            custodyUserId: true,
            custodyDepartmentId: true,
          },
        });
        if (!asset) return { notFound: true as const };

        if (isTerminal(asset.status)) {
          await recordAuditEvent(
            {
              action: "inventory.custody.transferred",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryAsset",
              resourceId: asset.id,
              metadata: { reason: "asset is terminal", status: asset.status },
            },
            tx,
          );
          return { deny: deny("asset is terminal", 409) };
        }

        const transferredAt = data.transferredAt ?? new Date();
        // The transfer targets a non-terminal asset; moving to ASSIGNED is always
        // legal from IN_STORE/ASSIGNED/IN_MAINTENANCE. Update custody + status.
        let updated;
        try {
          updated = await tx.inventoryAsset.update({
            where: { id: asset.id },
            data: {
              status: "ASSIGNED",
              custodyUserId: data.toUserId ?? null,
              custodyDepartmentId: data.toDepartmentId ?? null,
            },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }

        await tx.inventoryCustodyTransfer.create({
          data: {
            institutionId,
            assetId: asset.id,
            fromUserId: asset.custodyUserId,
            fromDepartmentId: asset.custodyDepartmentId,
            toUserId: data.toUserId ?? null,
            toDepartmentId: data.toDepartmentId ?? null,
            transferredAt,
            reason: data.reason ?? null,
            actorUserId: request.user.userId,
          },
        });

        await recordAuditEvent(
          {
            action: "inventory.custody.transferred",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAsset",
            resourceId: asset.id,
            metadata: {
              toUserId: data.toUserId ?? null,
              toDepartmentId: data.toDepartmentId ?? null,
            },
          },
          tx,
        );
        return { asset: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "asset not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(serializeAsset(outcome.asset));
    },
  );

  // ─── 9. POST /stock/:assetId/movements — concurrency-safe stock movement ─────
  // The advisory-lock + conditional-check idiom (design §B.4), universal across
  // RECEIPT/ISSUE/ADJUSTMENT. Reads + mutates the STORED onHandQuantity + inserts
  // the movement row under the per-item lock in one tx. ISSUE / negative
  // ADJUSTMENT that would drive on-hand < 0 → 409 "insufficient stock" + DENIED
  // audit, no mutation. balanceAfter is the post-movement on-hand snapshot.
  app.post(
    "/stock/:assetId/movements",
    { preHandler: [requirePermission("inventory.stock.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { assetId } = request.params as { assetId: string };
      const parsed = inventoryStockMovementSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { kind, quantity, reason } = parsed.data;

      const auditAction =
        kind === "RECEIPT"
          ? "inventory.stock.received"
          : kind === "ISSUE"
            ? "inventory.stock.issued"
            : "inventory.stock.adjusted";

      const outcome = await withTenant(institutionId, async (tx) => {
        const stockItem = await tx.inventoryStockItem.findFirst({
          where: { institutionId, assetId },
          select: { id: true, onHandQuantity: true },
        });
        if (!stockItem) return { notFound: "stock item not found" as const };

        // 1. Advisory lock on the stock item; held to commit (universal rule).
        await advisoryLock(tx, stockLockKey(institutionId, stockItem.id));

        // 2. Re-read on-hand UNDER the lock (the value above is pre-lock).
        const locked = await tx.inventoryStockItem.findFirst({
          where: { id: stockItem.id, institutionId },
          select: { id: true, onHandQuantity: true },
        });
        if (!locked) return { notFound: "stock item not found" as const };

        const newOnHand = locked.onHandQuantity + quantity;

        // 3. Reject an over-issue / over-draw under the lock (no mutation).
        if (newOnHand < 0) {
          await recordAuditEvent(
            {
              action: auditAction,
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryStockItem",
              resourceId: locked.id,
              metadata: {
                reason: "insufficient stock",
                onHand: locked.onHandQuantity,
                requested: quantity,
                assetId,
              },
            },
            tx,
          );
          return { deny: deny("insufficient stock", 409) };
        }

        // 4. Update the stored on-hand + insert the movement row atomically.
        const updated = await tx.inventoryStockItem.update({
          where: { id: locked.id },
          data: { onHandQuantity: newOnHand },
          select: { id: true, onHandQuantity: true },
        });

        const movement = await tx.inventoryStockMovement.create({
          data: {
            institutionId,
            stockItemId: locked.id,
            assetId,
            kind,
            quantity,
            reason: reason ?? null,
            balanceAfter: newOnHand,
            actorUserId: request.user.userId,
          },
        });

        await recordAuditEvent(
          {
            action: auditAction,
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryStockMovement",
            resourceId: movement.id,
            metadata: { stockItemId: locked.id, quantity, balanceAfter: newOnHand },
          },
          tx,
        );
        return { movement, onHandQuantity: updated.onHandQuantity };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: outcome.notFound });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send({
        movement: outcome.movement,
        onHandQuantity: outcome.onHandQuantity,
      });
    },
  );

  // ─── 10. GET /stock — staff list of stock items ──────────────────────────────
  app.get(
    "/stock",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = inventoryListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize } = parsed.data;

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.InventoryStockItemWhereInput = { institutionId };
        const [total, items] = await Promise.all([
          tx.inventoryStockItem.count({ where }),
          tx.inventoryStockItem.findMany({
            where,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, items };
      });

      return reply.send({ stockItems: result.items, total: result.total, page, pageSize });
    },
  );

  // ─── 11. GET /stock/:assetId — stock item + recent movements ──────────────────
  app.get(
    "/stock/:assetId",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { assetId } = request.params as { assetId: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const item = await tx.inventoryStockItem.findFirst({
          where: { institutionId, assetId },
        });
        if (!item) return { notFound: true as const };
        const movements = await tx.inventoryStockMovement.findMany({
          where: { institutionId, stockItemId: item.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        });
        return { item, movements };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "stock item not found" });
      return reply.send({ stockItem: outcome.item, movements: outcome.movements });
    },
  );

  // ─── 12. POST /assets/:id/maintenance — open a request (§B.7) ────────────────
  // In one tx: verify asset non-terminal; insert the request (OPEN) capturing the
  // asset's current non-terminal status in priorAssetStatus; move the asset to
  // IN_MAINTENANCE through the column guard. The partial unique prevents two opens.
  app.post(
    "/assets/:id/maintenance",
    { preHandler: [requirePermission("inventory.maintenance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = createInventoryMaintenanceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const asset = await tx.inventoryAsset.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!asset) return { notFound: true as const };

        // Only a non-terminal, non-in-maintenance asset can open a request. The
        // priorAssetStatus CHECK (IN_STORE|ASSIGNED) + the partial unique backstop.
        if (asset.status !== "IN_STORE" && asset.status !== "ASSIGNED") {
          await recordAuditEvent(
            {
              action: "inventory.maintenance.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryAsset",
              resourceId: asset.id,
              metadata: { reason: "asset not available for maintenance", status: asset.status },
            },
            tx,
          );
          return { deny: deny("asset not available for maintenance", 409) };
        }

        let created;
        try {
          created = await tx.inventoryMaintenanceRequest.create({
            data: {
              institutionId,
              assetId: asset.id,
              issue: data.issue,
              status: "OPEN",
              assigneeUserId: data.assigneeUserId ?? null,
              priorAssetStatus: asset.status,
              ...(data.cost !== undefined ? { cost: Number(data.cost) } : {}),
              reportedByUserId: request.user.userId,
            },
          });
        } catch (err) {
          // The partial unique backstops a concurrent open.
          if (isUniqueViolation(err)) return { deny: deny("maintenance already open for asset", 409) };
          throw err;
        }

        try {
          await tx.inventoryAsset.update({
            where: { id: asset.id },
            data: { status: "IN_MAINTENANCE" },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }

        await recordAuditEvent(
          {
            action: "inventory.maintenance.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryMaintenanceRequest",
            resourceId: created.id,
            metadata: { assetId: asset.id, priorAssetStatus: asset.status },
          },
          tx,
        );
        return { request: created };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "asset not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(serializeMaintenance(outcome.request));
    },
  );

  // ─── 13. PATCH /maintenance/:id — transition (§B.7, Finding HIGH-1) ──────────
  // OPEN->IN_PROGRESS keeps the asset IN_MAINTENANCE. On a close (IN_PROGRESS->
  // RESOLVED, OPEN|IN_PROGRESS->CANCELLED) the handler reads the asset first:
  //   - asset still IN_MAINTENANCE → restore it to priorAssetStatus (IN_STORE or
  //     ASSIGNED, custody intact) in the same tx.
  //   - asset DISPOSED/RETIRED (disposed mid-maintenance) → maintenance-only flip
  //     with NO asset write ({assetTerminal:true}, 200), freeing the slot.
  const MAINTENANCE_TRANSITIONS: Record<string, readonly string[]> = {
    OPEN: ["IN_PROGRESS", "CANCELLED"],
    IN_PROGRESS: ["RESOLVED", "CANCELLED"],
    RESOLVED: [],
    CANCELLED: [],
  };
  app.patch(
    "/maintenance/:id",
    { preHandler: [requirePermission("inventory.maintenance.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = inventoryMaintenanceTransitionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { toStatus, cost, resolutionNote } = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const req = await tx.inventoryMaintenanceRequest.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true, assetId: true, priorAssetStatus: true },
        });
        if (!req) return { notFound: true as const };

        const legal = MAINTENANCE_TRANSITIONS[req.status] ?? [];
        if (!legal.includes(toStatus)) {
          await recordAuditEvent(
            {
              action: "inventory.maintenance.transitioned",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryMaintenanceRequest",
              resourceId: req.id,
              metadata: { reason: "illegal status transition", from: req.status, to: toStatus },
            },
            tx,
          );
          return { deny: deny("illegal status transition", 409) };
        }

        const isClose = toStatus === "RESOLVED" || toStatus === "CANCELLED";
        let assetTerminal = false;

        if (isClose) {
          const asset = await tx.inventoryAsset.findFirst({
            where: { id: req.assetId, institutionId },
            select: { id: true, status: true },
          });
          if (!asset) return { notFound: true as const };

          if (asset.status === "IN_MAINTENANCE") {
            // Restore the asset to the exact status captured at open-time.
            try {
              await tx.inventoryAsset.update({
                where: { id: asset.id },
                data: { status: req.priorAssetStatus },
              });
            } catch (err) {
              if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
              throw err;
            }
          } else if (isTerminal(asset.status)) {
            // Disposed mid-maintenance: maintenance-only flip, NO asset write.
            assetTerminal = true;
          }
          // Any other asset status: close the request without an asset write
          // (defensive; the asset should be IN_MAINTENANCE or terminal here).
        }

        let updated;
        try {
          updated = await tx.inventoryMaintenanceRequest.update({
            where: { id: req.id },
            data: {
              status: toStatus,
              ...(toStatus === "RESOLVED" ? { resolvedAt: new Date() } : {}),
              ...(cost !== undefined ? { cost: Number(cost) } : {}),
              ...(resolutionNote !== undefined ? { resolutionNote } : {}),
            },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }

        await recordAuditEvent(
          {
            action: "inventory.maintenance.transitioned",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryMaintenanceRequest",
            resourceId: req.id,
            metadata: { from: req.status, to: toStatus, ...(assetTerminal ? { assetTerminal: true } : {}) },
          },
          tx,
        );
        return { request: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "maintenance request not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(serializeMaintenance(outcome.request));
    },
  );

  // ─── 14. GET /maintenance — staff list (filter status/assetId) ───────────────
  app.get(
    "/maintenance",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = inventoryListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { page, pageSize, status } = parsed.data;
      const { assetId } = request.query as { assetId?: string };

      const result = await withTenant(institutionId, async (tx) => {
        const where: Prisma.InventoryMaintenanceRequestWhereInput = {
          institutionId,
          ...(status ? { status: status as Prisma.InventoryMaintenanceRequestWhereInput["status"] } : {}),
          ...(assetId ? { assetId } : {}),
        };
        const [total, requests] = await Promise.all([
          tx.inventoryMaintenanceRequest.count({ where }),
          tx.inventoryMaintenanceRequest.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        return { total, requests };
      });

      return reply.send({
        requests: result.requests.map(serializeMaintenance),
        total: result.total,
        page,
        pageSize,
      });
    },
  );

  // ─── 15. POST /assets/:id/dispose — terminal disposal (§B.7a) ────────────────
  // One tx: read asset → if terminal, 409 + DENIED (no record); else transition
  // to the caller-chosen terminal status through the guard + insert one
  // append-only disposals row + SUCCESS audit.
  app.post(
    "/assets/:id/dispose",
    { preHandler: [requirePermission("inventory.disposals.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = inventoryDisposalSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const asset = await tx.inventoryAsset.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!asset) return { notFound: true as const };

        if (isTerminal(asset.status)) {
          await recordAuditEvent(
            {
              action: "inventory.asset.disposed",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryAsset",
              resourceId: asset.id,
              metadata: { reason: "asset is terminal", status: asset.status },
            },
            tx,
          );
          return { deny: deny("asset is terminal", 409) };
        }

        const disposedAt = data.disposedAt ?? new Date();
        try {
          await tx.inventoryAsset.update({
            where: { id: asset.id },
            data: { status: data.terminalStatus },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }

        let disposal;
        try {
          disposal = await tx.inventoryDisposal.create({
            data: {
              institutionId,
              assetId: asset.id,
              terminalStatus: data.terminalStatus,
              method: data.method,
              disposedAt,
              proceeds: data.proceeds !== undefined ? Number(data.proceeds) : null,
              currency: data.currency ?? null,
              reason: data.reason ?? null,
              actorUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("asset already disposed", 409) };
          throw err;
        }

        await recordAuditEvent(
          {
            action: "inventory.asset.disposed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryDisposal",
            resourceId: disposal.id,
            metadata: { assetId: asset.id, terminalStatus: data.terminalStatus, priorAssetStatus: asset.status },
          },
          tx,
        );
        return { disposal };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "asset not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(serializeDisposal(outcome.disposal));
    },
  );

  // ─── 16. POST /audits — create a stock-take session (OPEN) ───────────────────
  app.post(
    "/audits",
    { preHandler: [requirePermission("inventory.audits.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = createInventoryAuditSessionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const session = await withTenant(institutionId, async (tx) => {
        const created = await tx.inventoryAuditSession.create({
          data: {
            institutionId,
            name: data.name,
            status: "OPEN",
            createdByUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "inventory.audit.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAuditSession",
            resourceId: created.id,
          },
          tx,
        );
        return created;
      });

      return reply.status(201).send(session);
    },
  );

  // ─── 17. POST /audits/:id/lines — append an audit line ───────────────────────
  app.post(
    "/audits/:id/lines",
    { preHandler: [requirePermission("inventory.audits.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id: sessionId } = request.params as { id: string };
      const parsed = inventoryAuditLineSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const session = await tx.inventoryAuditSession.findFirst({
          where: { id: sessionId, institutionId },
          select: { id: true, status: true },
        });
        if (!session) return { notFound: true as const };
        if (session.status !== "OPEN") {
          await recordAuditEvent(
            {
              action: "inventory.audit.line_added",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryAuditSession",
              resourceId: session.id,
              metadata: { reason: "audit session not open", status: session.status },
            },
            tx,
          );
          return { deny: deny("audit session not open", 409) };
        }

        const discrepancy =
          data.expectedQuantity !== undefined && data.foundQuantity !== undefined
            ? data.foundQuantity - data.expectedQuantity
            : null;

        const line = await tx.inventoryAuditLine.create({
          data: {
            institutionId,
            sessionId: session.id,
            assetId: data.assetId ?? null,
            stockItemId: data.stockItemId ?? null,
            expectedQuantity: data.expectedQuantity ?? null,
            foundQuantity: data.foundQuantity ?? null,
            discrepancy,
            note: data.note ?? null,
            actorUserId: request.user.userId,
          },
        });
        await recordAuditEvent(
          {
            action: "inventory.audit.line_added",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAuditLine",
            resourceId: line.id,
            metadata: { sessionId: session.id },
          },
          tx,
        );
        return { line };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "audit session not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.line);
    },
  );

  // ─── 18. PATCH /audits/:id — close a session (OPEN -> CLOSED) ─────────────────
  app.patch(
    "/audits/:id",
    { preHandler: [requirePermission("inventory.audits.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const session = await tx.inventoryAuditSession.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!session) return { notFound: true as const };
        if (session.status !== "OPEN") {
          await recordAuditEvent(
            {
              action: "inventory.audit.closed",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "InventoryAuditSession",
              resourceId: session.id,
              metadata: { reason: "audit session not open", status: session.status },
            },
            tx,
          );
          return { deny: deny("audit session not open", 409) };
        }

        let updated;
        try {
          updated = await tx.inventoryAuditSession.update({
            where: { id: session.id },
            data: { status: "CLOSED", closedAt: new Date() },
          });
        } catch (err) {
          if (isRestrictViolation(err)) return { deny: deny("illegal status transition", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "inventory.audit.closed",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAuditSession",
            resourceId: session.id,
          },
          tx,
        );
        return { session: updated };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "audit session not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.session);
    },
  );

  // ─── 19. GET /reports/register — asset register (JSON) ────────────────────────
  app.get(
    "/reports/register",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const register = await withTenant(institutionId, async (tx) =>
        tx.inventoryAsset.findMany({
          where: { institutionId },
          orderBy: [{ assetTag: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send({ register: register.map(serializeAsset) });
    },
  );

  // ─── 20. GET /reports/custody — assets with a current custodian ──────────────
  app.get(
    "/reports/custody",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, async (tx) =>
        tx.inventoryAsset.findMany({
          where: {
            institutionId,
            OR: [{ custodyUserId: { not: null } }, { custodyDepartmentId: { not: null } }],
          },
          orderBy: [{ custodyUserId: "asc" }, { assetTag: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send({ custody: rows.map(serializeAsset) });
    },
  );

  // ─── 21. GET /reports/low-stock — stock items at/below reorder level ─────────
  app.get(
    "/reports/low-stock",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, async (tx) => {
        const items = await tx.inventoryStockItem.findMany({
          where: { institutionId, reorderLevel: { not: null } },
          orderBy: [{ onHandQuantity: "asc" }, { id: "asc" }],
        });
        // reorderLevel is non-null here; low stock = onHand <= reorderLevel.
        return items.filter((i) => i.reorderLevel !== null && i.onHandQuantity <= i.reorderLevel);
      });
      return reply.send({ lowStock: rows });
    },
  );

  // ─── 22. GET /reports/disposals — disposal records (money as string) ─────────
  app.get(
    "/reports/disposals",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, async (tx) =>
        tx.inventoryDisposal.findMany({
          where: { institutionId },
          orderBy: [{ disposedAt: "desc" }, { id: "asc" }],
        }),
      );
      return reply.send({ disposals: rows.map(serializeDisposal) });
    },
  );

  // ─── 23. GET /reports/register.xlsx — XLSX export (audited) ──────────────────
  app.get(
    "/reports/register.xlsx",
    { preHandler: [requirePermission("inventory.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;

      const register = await withTenant(institutionId, async (tx) => {
        const rows = await tx.inventoryAsset.findMany({
          where: { institutionId },
          orderBy: [{ assetTag: "asc" }, { id: "asc" }],
        });
        await recordAuditEvent(
          {
            action: "inventory.register.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "InventoryAsset",
            metadata: { count: rows.length },
          },
          tx,
        );
        return rows;
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Asset Register");
      sheet.columns = [
        { header: "Asset ID", key: "id", width: 26 },
        { header: "Asset Tag", key: "assetTag", width: 20 },
        { header: "Name", key: "name", width: 30 },
        { header: "Category ID", key: "categoryId", width: 26 },
        { header: "Status", key: "status", width: 16 },
        { header: "Acquisition Date", key: "acquisitionDate", width: 24 },
        { header: "Acquisition Cost", key: "acquisitionCost", width: 18 },
        { header: "Currency", key: "currency", width: 10 },
        { header: "Location", key: "location", width: 20 },
        { header: "Custody User ID", key: "custodyUserId", width: 26 },
        { header: "Custody Dept ID", key: "custodyDepartmentId", width: 26 },
      ];
      for (const a of register) {
        sheet.addRow({
          id: a.id,
          assetTag: a.assetTag,
          name: a.name,
          categoryId: a.categoryId,
          status: a.status,
          acquisitionDate: a.acquisitionDate ? a.acquisitionDate.toISOString() : "",
          acquisitionCost: a.acquisitionCost === null ? "" : String(a.acquisitionCost),
          currency: a.currency ?? "",
          location: a.location ?? "",
          custodyUserId: a.custodyUserId ?? "",
          custodyDepartmentId: a.custodyDepartmentId ?? "",
        });
      }
      sheet.getRow(1).font = { bold: true };

      const filename = `inventory-register-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  // ─── 24. GET /me/assets — custodian self-service (inventory.view_own) ─────────
  // Read-only; self-scopes by custodyUserId == the verified token userId, never
  // from input. LIST-shaped: 200 + a list (possibly empty); never 404. Writes no
  // audit. Bound to INVENTORY_MANAGER only (design §B.9 deviation).
  app.get(
    "/me/assets",
    { preHandler: [requirePermission("inventory.view_own"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const assets = await withTenant(institutionId, async (tx) =>
        tx.inventoryAsset.findMany({
          where: { institutionId, custodyUserId: userId },
          orderBy: [{ assetTag: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send({ assets: assets.map(serializeAsset) });
    },
  );
}
