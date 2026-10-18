import { prisma, type Prisma } from "@campusgate/db";
import { wsConnections } from "../routes/ws.js";

interface NotificationPayload {
  title: string;
  body: string;
  type: string;
  data?: Record<string, any>;
}

/**
 * All fan-out helpers accept an optional `db` client (default: `prisma`). When
 * called from inside a tenant request they MUST be passed the `withTenant`
 * transaction client (`tx`) so the `notification.create` runs with the tenant
 * RLS context set and satisfies the WITH CHECK policy. The `notifications` table
 * is tenant-owned.
 */

export async function notifyUser(
  userId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
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

  // Push via WebSocket if connected
  const connection = wsConnections.get(userId);
  if (connection) {
    connection.socket.send(
      JSON.stringify({
        type: "notification",
        data: notification,
      })
    );
  }

  return notification;
}

export async function notifyInstitutionAdmins(
  institutionId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
) {
  const admins = await db.user.findMany({
    where: { institutionId, role: "ADMIN", accountStatus: "ACTIVE" },
    select: { id: true },
  });

  for (const admin of admins) {
    await notifyUser(admin.id, payload, db);
  }
}

export async function notifyDepartmentHods(
  departmentId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
) {
  const hods = await db.hodProfile.findMany({
    where: { departmentId },
    include: { user: true },
  });

  for (const hod of hods) {
    await notifyUser(hod.userId, payload, db);
  }
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
  for (const [userId, meta] of wsConnections.entries()) {
    if (meta.institutionId === institutionId) {
      meta.socket.send(payload);
    }
  }
}

/**
 * Persists + pushes a notification to every ACTIVE user of an institution.
 * Use sparingly (e.g. emergency alerts) since it fans out to the whole tenant.
 */
export async function notifyInstitution(
  institutionId: string,
  payload: NotificationPayload,
  db: Prisma.TransactionClient = prisma,
) {
  const users = await db.user.findMany({
    where: { institutionId, accountStatus: "ACTIVE" },
    select: { id: true },
  });

  for (const user of users) {
    await notifyUser(user.id, payload, db);
  }
}
