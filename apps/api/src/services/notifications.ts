import { prisma } from "@campusgate/db";
import { wsConnections } from "../routes/ws.js";

interface NotificationPayload {
  title: string;
  body: string;
  type: string;
  data?: Record<string, any>;
}

export async function notifyUser(userId: string, payload: NotificationPayload) {
  // Persist notification
  const notification = await prisma.notification.create({
    data: {
      userId,
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
  payload: NotificationPayload
) {
  const admins = await prisma.user.findMany({
    where: { institutionId, role: "ADMIN", accountStatus: "ACTIVE" },
    select: { id: true },
  });

  for (const admin of admins) {
    await notifyUser(admin.id, payload);
  }
}

export async function notifyDepartmentHods(
  departmentId: string,
  payload: NotificationPayload
) {
  const hods = await prisma.hodProfile.findMany({
    where: { departmentId },
    include: { user: true },
  });

  for (const hod of hods) {
    await notifyUser(hod.userId, payload);
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
  payload: NotificationPayload
) {
  const users = await prisma.user.findMany({
    where: { institutionId, accountStatus: "ACTIVE" },
    select: { id: true },
  });

  for (const user of users) {
    await notifyUser(user.id, payload);
  }
}
