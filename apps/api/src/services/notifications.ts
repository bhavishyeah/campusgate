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
    connection.send(
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
