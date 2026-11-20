/// <reference lib="webworker" />
// Push handlers imported into the generated sw.js by next-pwa (customWorkerSrc).
// No fetch or caching logic lives here.
import { parsePushPayload, safeUrl } from "./push-core";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  const msg = parsePushPayload(event.data ? event.data.text() : null);
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.id || undefined,
      data: { url: msg.url, id: msg.id },
      icon: "/icons/icon-192.svg",
      badge: "/icons/icon-192.svg",
      requireInteraction: msg.priority === "e",
      timestamp: msg.ts,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data?.url, self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => c.url.startsWith(self.location.origin));
      if (existing) {
        await existing.focus();
        if (existing.url !== target && "navigate" in existing) {
          await existing.navigate(target);
        }
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});
