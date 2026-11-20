// Pure helpers for the push service worker. No DOM or worker globals here so
// they can be unit-tested under jsdom.

export interface ParsedPush {
  id: string;
  title: string;
  body: string;
  url: string;
  category: string;
  priority: "n" | "h" | "e";
  ts: number;
}

const FALLBACK_TITLE = "CampusGate";
const FALLBACK_BODY = "You have a new notification";

/** Browsers require every push to show a notification, so bad input still yields one. */
export function parsePushPayload(raw: string | null | undefined): ParsedPush {
  const fallback: ParsedPush = {
    id: "",
    title: FALLBACK_TITLE,
    body: FALLBACK_BODY,
    url: "/",
    category: "SYSTEM",
    priority: "n",
    ts: Date.now(),
  };
  if (!raw) return fallback;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!data || typeof data !== "object" || data.v !== 1) return fallback;
  const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
  const title = str(data.t, 120).trim();
  const body = str(data.b, 300).trim();
  if (!title && !body) return fallback;
  return {
    id: str(data.id, 64),
    title: title || FALLBACK_TITLE,
    body: body || FALLBACK_BODY,
    url: str(data.u, 200) || "/",
    category: str(data.c, 32) || "SYSTEM",
    priority: data.p === "h" || data.p === "e" ? data.p : "n",
    ts: typeof data.ts === "number" && Number.isFinite(data.ts) ? data.ts : Date.now(),
  };
}

/** Returns an absolute same-origin URL, or the origin root for anything else. */
export function safeUrl(url: string | null | undefined, origin: string): string {
  const root = `${origin}/`;
  if (!url || typeof url !== "string") return root;
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return root;
    return parsed.href;
  } catch {
    return root;
  }
}
