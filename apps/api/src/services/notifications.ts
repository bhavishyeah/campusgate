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
