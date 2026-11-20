import { prisma, type Prisma } from "@campusgate/db";
import { randomUUID } from "node:crypto";
import { forEachInstitutionSocket, sendToUser } from "../routes/ws.js";
import { categoryForType, priorityFor } from "./push/categories.js";
import type { NotificationCategoryOrEmergency, NotificationPriority } from "./push/categories.js";
import { getPushDispatcher, type DeliveryEvent } from "./push/dispatcher.js";
import { getPushSender } from "./push/index.js";

export interface NotificationPayload {
  title: string;
  body: string;
  type: string;
  data?: Record<string, any>;
}

export type { DeliveryEvent };

export interface NotifyOptions {
  /** Overrides categoryForType(payload.type). */
  category?: NotificationCategoryOrEmergency;
  priority?: NotificationPriority;
  /** Relative deep link opened when the push is tapped. */
  url?: string;
  /** false = in-app row + WebSocket only. Object = override of the lock-screen text. */
  push?: false | { title?: string; body?: string };
  /** Called after the push job settles (later phases: delivery rows). */
  onDelivery?: (events: DeliveryEvent[]) => void | Promise<void>;
}

export interface NotifyUsersResult {
  /** Correlates logs and later delivery rows. */
  batchId: string;
  recipients: Array<{ userId: string; notificationId: string }>;
  /** Ids not found in this institution (cross-tenant guard). */
  skippedUserIds: string[];
}

/** Largest audience a single notifyUsers call accepts. Callers with more chunk; the helpers below do. */
export const MAX_NOTIFY_USERS = 20_000;
const VERIFY_SLICE = 1_000;
const INSERT_CHUNK = 500;
const PUSH_JOB_ITEMS = 200;

/**
 * All fan-out helpers accept an optional `db` client (default: `prisma`). When
 * called from inside a tenant request they MUST be passed the `withTenant`
 * transaction client (`tx`) so the inserts run with the tenant RLS context set and
 * satisfy the WITH CHECK policy. The `notifications` table is tenant-owned.
 *
 * Delivery: the in-app row is the source of truth. After inserting, every open
 * WebSocket of each recipient gets the message at once, and a background job sends
 * Web Push. Push and WebSocket problems never propagate to the caller; database
 * errors do, exactly as before.
 */
type NotificationRow = {
  id: string;
  userId: string;
  institutionId: string;
  title: string;
  body: string;
  type: string;
  data: unknown;
  read: boolean;
  createdAt: Date;
};

function afterInsert(
  rows: NotificationRow[],
  institutionId: string,
  payload: NotificationPayload,
  opts: NotifyOptions,
): void {
  try {
    for (const row of rows) {
      try {
        sendToUser(row.userId, JSON.stringify({ type: "notification", data: row }));
      } catch (err) {
        console.warn("notify: websocket send failed", err instanceof Error ? err.message : "unknown");
      }
    }
  } catch {
    /* never fail the caller */
  }
  if (opts.push === false) return;
  try {
    if (!getPushSender().isConfigured()) return;
    const category = opts.category ?? categoryForType(payload.type);
    const priority = opts.priority ?? priorityFor(payload.type, category);
    const dispatcher = getPushDispatcher();
    const ts = Date.now();
    for (let i = 0; i < rows.length; i += PUSH_JOB_ITEMS) {
      dispatcher.enqueue({
        institutionId,
        items: rows.slice(i, i + PUSH_JOB_ITEMS).map((r) => ({ notificationId: r.id, userId: r.userId })),
        msg: {
          title: payload.title,
          body: payload.body,
          url: opts.url,
          category,
          priority,
          ts,
          push: opts.push || undefined,
        },
        onDelivery: opts.onDelivery,
      });
    }
  } catch (err) {
    console.warn("notify: push enqueue failed", err instanceof Error ? err.message : "unknown");
  }
}

export async function notifyUser(
  userId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
  opts: NotifyOptions = {},
) {
  // Derive the tenant from the recipient user (notifications are tenant-owned).
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { institutionId: true },
  });
  if (!user) {
    throw new Error(`notifyUser: user ${userId} not found`);
  }
  // Persist notification
  const notification = await db.notification.create({
    data: {
      userId,
      institutionId: user.institutionId,
      title: payload.title,
      body: payload.body,
      type: payload.type,
      data: payload.data || {},
    },
  });
  afterInsert([notification as NotificationRow], user.institutionId, payload, opts);
  return notification;
}

/**
 * Notify many users of one institution. 3 to 4 DB round trips per 1,000
 * recipients (1 verification query, 1 insert per 500 rows) instead of 2 per user.
 * Throws RangeError above MAX_NOTIFY_USERS: that is a programming error for direct
 * callers, who must chunk. notifyInstitution, notifyInstitutionAdmins and
 * notifyDepartmentHods chunk for you and never throw on audience size.
 */
export async function notifyUsers(
  institutionId: string,
  userIds: string[],
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
  opts: NotifyOptions = {},
): Promise<NotifyUsersResult> {
  const unique = [...new Set(userIds)];
  const batchId = randomUUID();
  if (unique.length === 0) return { batchId, recipients: [], skippedUserIds: [] };
  if (unique.length > MAX_NOTIFY_USERS) {
    throw new RangeError(`notifyUsers: ${unique.length} recipients exceeds ${MAX_NOTIFY_USERS}; chunk the audience`);
  }

  // Cross-tenant guard: notifications.userId has no FK, so verify every id belongs here.
  const valid = new Set<string>();
  for (let i = 0; i < unique.length; i += VERIFY_SLICE) {
    const found = await db.user.findMany({
      where: { id: { in: unique.slice(i, i + VERIFY_SLICE) }, institutionId },
      select: { id: true },
    });
    for (const u of found) valid.add(u.id);
  }
  const accepted = unique.filter((id) => valid.has(id));
  const skippedUserIds = unique.filter((id) => !valid.has(id));

  const rows: NotificationRow[] = [];
  for (let i = 0; i < accepted.length; i += INSERT_CHUNK) {
    const created = await db.notification.createManyAndReturn({
      data: accepted.slice(i, i + INSERT_CHUNK).map((userId) => ({
        userId,
        institutionId,
        title: payload.title,
        body: payload.body,
        type: payload.type,
        data: payload.data || {},
      })),
    });
    rows.push(...(created as NotificationRow[]));
  }

  afterInsert(rows, institutionId, payload, opts);
  return {
    batchId,
    recipients: rows.map((r) => ({ userId: r.userId, notificationId: r.id })),
    skippedUserIds,
  };
}

/** Slice an audience so no single notifyUsers call exceeds its cap (F4). */
async function notifyInSlices(
  institutionId: string,
  userIds: string[],
  payload: NotificationPayload,
  db: Prisma.TransactionClient,
  opts?: NotifyOptions,
): Promise<void> {
  for (let i = 0; i < userIds.length; i += MAX_NOTIFY_USERS) {
    await notifyUsers(institutionId, userIds.slice(i, i + MAX_NOTIFY_USERS), payload, db, opts);
  }
}

export async function notifyInstitutionAdmins(
  institutionId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
  opts?: NotifyOptions,
) {
  const admins = await db.user.findMany({
    where: { institutionId, role: "ADMIN", accountStatus: "ACTIVE" },
    select: { id: true },
  });
  await notifyInSlices(institutionId, admins.map((a) => a.id), payload, db, opts);
}

export async function notifyDepartmentHods(
  departmentId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
  opts?: NotifyOptions,
) {
  const hods = await db.hodProfile.findMany({
    where: { departmentId },
    include: { user: true },
  });
  if (hods.length === 0) return;
  // All HODs of one department share an institution.
  const institutionId = hods[0].user.institutionId;
  await notifyInSlices(institutionId, hods.map((h) => h.userId), payload, db, opts);
}

/**
 * Pushes a message to every currently-connected user of an institution over
 * WebSocket, without necessarily persisting a Notification row for each one.
 * Used for time-critical broadcasts (e.g. emergency declarations) where we
 * want instant delivery to anyone online right now, in addition to the
 * persisted per-user notifications created separately.
 */
export function broadcastToInstitution(
  institutionId: string,
  message: { type: string; data: Record<string, any> }
) {
  const payload = JSON.stringify(message);
  forEachInstitutionSocket(institutionId, (meta) => {
    try {
      meta.socket.send(payload);
    } catch {
      /* a dead socket is removed on its close/error event */
    }
  });
}

/**
 * Persists + pushes a notification to every ACTIVE user of an institution.
 * Use sparingly (e.g. emergency alerts) since it fans out to the whole tenant.
 * Audiences above MAX_NOTIFY_USERS are sliced; this never throws on size.
 */
export async function notifyInstitution(
  institutionId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
  opts?: NotifyOptions,
) {
  const users = await db.user.findMany({
    where: { institutionId, accountStatus: "ACTIVE" },
    select: { id: true },
  });
  await notifyInSlices(institutionId, users.map((u) => u.id), payload, db, opts);
}
