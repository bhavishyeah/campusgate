import { useAuthStore } from "@/stores/auth";

// Swap an http(s) scheme for ws(s), anchored to the START of the string so an
// embedded "http" later in the URL is never rewritten. Any other value is
// returned unchanged.
function toWsScheme(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

// Resolve the WebSocket base URL per connection so env is read at connect time.
// The WS server shares the API host (the API serves /ws/connect), so by default
// the URL is derived from NEXT_PUBLIC_API_URL. NEXT_PUBLIC_WS_URL is an optional
// override used ONLY when explicitly set and non-empty: a ws(s):// value is used
// verbatim, an http(s):// value gets the scheme swap.
function resolveWsUrl(): string {
  const override = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (override) {
    if (override.startsWith("ws://") || override.startsWith("wss://")) return override;
    return toWsScheme(override);
  }
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  return toWsScheme(apiUrl);
}

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

  const wsUrl = resolveWsUrl();
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
