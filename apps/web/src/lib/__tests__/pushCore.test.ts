import { describe, expect, it } from "vitest";
import { parsePushPayload, safeUrl } from "../../../worker/push-core";

const origin = "https://campusgate.example";

describe("parsePushPayload", () => {
  it("parses a v1 payload", () => {
    const p = parsePushPayload(JSON.stringify({ v: 1, id: "n1", t: "Title", b: "Body", u: "/student", c: "FEES", p: "h", ts: 5 }));
    expect(p).toMatchObject({ id: "n1", title: "Title", body: "Body", url: "/student", category: "FEES", priority: "h", ts: 5 });
  });
  it("falls back for invalid JSON, wrong version, empty and missing data", () => {
    for (const raw of ["not json", JSON.stringify({ v: 2, t: "x" }), JSON.stringify({ v: 1 }), "", null, undefined]) {
      const p = parsePushPayload(raw as any);
      expect(p.title).toBe("CampusGate");
      expect(p.body).toBe("You have a new notification");
      expect(p.url).toBe("/");
    }
  });
  it("coerces unknown priority to n", () => {
    expect(parsePushPayload(JSON.stringify({ v: 1, t: "a", p: "zzz" })).priority).toBe("n");
  });
});

describe("safeUrl", () => {
  it("resolves same-origin relative paths", () => {
    expect(safeUrl("/student/history", origin)).toBe(`${origin}/student/history`);
  });
  it("rejects other origins and protocol-relative URLs", () => {
    expect(safeUrl("https://evil.com/x", origin)).toBe(`${origin}/`);
    expect(safeUrl("//evil.com/x", origin)).toBe(`${origin}/`);
    expect(safeUrl("javascript:alert(1)", origin)).toBe(`${origin}/`);
  });
  it("returns root for empty input", () => {
    expect(safeUrl(undefined, origin)).toBe(`${origin}/`);
    expect(safeUrl("", origin)).toBe(`${origin}/`);
  });
});
