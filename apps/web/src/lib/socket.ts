import { useAuthStore } from "@/stores/auth";

const WS_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let intentionalClose = false;

type MessageHandler = (data: any) => void;
const handlers = new Map<string, Set<MessageHandler>>();

export function connectSocket() {
  const token = useAuthStore.getState().token;
  if (!token) return;

  // Don't reconnect if already open or connecting
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  intentionalClose = false;

  const wsUrl = WS_URL.replace("http", "ws");
  socket = new WebSocket(`${wsUrl}/ws/connect?token=${token}`);

  socket.onopen = () => {
    console.log("[WS] Connected");
    startPing();
  };

  socket.onmessage = (event) => {
    if (event.data === "pong") return;

    try {
      const message = JSON.parse(event.data);
      const typeHandlers = handlers.get(message.type);
      if (typeHandlers) {
        typeHandlers.forEach((handler) => handler(message.data));
      }
      const wildcardHandlers = handlers.get("*");
      if (wildcardHandlers) {
        wildcardHandlers.forEach((handler) => handler(message));
      }
    } catch {
      // Ignore parse errors
    }
  };

  socket.onclose = () => {
    stopPing();
    if (!intentionalClose) {
      console.log("[WS] Disconnected, reconnecting in 5s...");
      scheduleReconnect();
    }
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

function startPing() {
  stopPing();
  pingInterval = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send("ping");
    }
  }, 30000);
}

function stopPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    const token = useAuthStore.getState().token;
    if (token && !intentionalClose) connectSocket();
  }, 5000);
}

export function disconnectSocket() {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPing();
  if (socket) {
    socket.close();
    socket = null;
  }
}

export function onMessage(type: string, handler: MessageHandler) {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  handlers.get(type)!.add(handler);

  return () => {
    handlers.get(type)?.delete(handler);
  };
}
