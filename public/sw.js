self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "Agent 已完成任务。" };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Codex Agent", {
      body: payload.body || "任务已完成，点开查看结果。",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.tag || "agent-turn-complete",
      renotify: true,
      silent: false,
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const targetSession = destination.searchParams.get("attach");
      const matchingClient = clients.find((client) => {
        const current = new URL(client.url);
        return targetSession && current.searchParams.get("attach") === targetSession;
      });
      if (matchingClient && "focus" in matchingClient) return matchingClient.focus();
      return self.clients.openWindow(destination.href);
    }),
  );
});
