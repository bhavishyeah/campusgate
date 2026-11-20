import { describe, expect, it } from "vitest";
import { buildPushPayload, GENERIC_BODY, safeRelativeUrl } from "../payload.js";

const base = { notificationId: "n1", title: "Payment received", body: "Receipt R-1001 for Rs 50,000 from Asha K", ts: 1700000000000 };

describe("buildPushPayload", () => {
  it("uses the generic body for private categories and carries no amounts or names", () => {
    for (const category of ["GATEPASS", "FEES", "EXAMS", "ATTENDANCE", "ADMISSIONS", "SYSTEM"] as const) {
      const raw = buildPushPayload({ ...base, category, priority: "NORMAL" });
      const p = JSON.parse(raw);
      expect(p.b).toBe(GENERIC_BODY);
      expect(raw).not.toMatch(/R-1001|50,000|Asha/);
      expect(Object.keys(p).sort()).toEqual(["b", "c", "id", "p", "t", "ts", "u", "v"]);
      expect(p).not.toHaveProperty("data");
    }
  });

  it("uses the real body (cut to 120) for EMERGENCY, ANNOUNCEMENTS and LIBRARY", () => {
    const long = "x".repeat(300);
    for (const category of ["EMERGENCY", "ANNOUNCEMENTS", "LIBRARY"] as const) {
      const p = JSON.parse(buildPushPayload({ ...base, body: long, category, priority: "NORMAL" }));
      expect(p.b.length).toBe(120);
      expect(p.b.endsWith("…")).toBe(true);
    }
    expect(JSON.parse(buildPushPayload({ ...base, body: "Campus closed", category: "ANNOUNCEMENTS", priority: "NORMAL" })).b).toBe("Campus closed");
  });

  it("cleans and truncates the title and strips control characters", () => {
    const p = JSON.parse(buildPushPayload({ ...base, title: `A\u0000B\n${"t".repeat(100)}`, category: "FEES", priority: "NORMAL" }));
    expect(p.t.length).toBeLessThanOrEqual(60);
    expect(p.t).not.toMatch(/[\u0000-\u001f]/);
  });

  it("encodes priority and honours a caller override", () => {
    expect(JSON.parse(buildPushPayload({ ...base, category: "EMERGENCY", priority: "EMERGENCY" })).p).toBe("e");
    expect(JSON.parse(buildPushPayload({ ...base, category: "GATEPASS", priority: "HIGH" })).p).toBe("h");
    const p = JSON.parse(
      buildPushPayload({ ...base, category: "GATEPASS", priority: "HIGH", push: { title: "Update", body: "Your child has left campus" } }),
    );
    expect(p).toMatchObject({ t: "Update", b: "Your child has left campus" });
  });

  it("stays within 2048 bytes", () => {
    const raw = buildPushPayload({ ...base, title: "é".repeat(60), body: "é".repeat(500), category: "EMERGENCY", priority: "EMERGENCY", url: "/" + "a".repeat(150) });
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(2048);
  });
});

describe("safeRelativeUrl", () => {
  it("accepts single-slash relative paths", () => {
    expect(safeRelativeUrl("/student/fees?x=1")).toBe("/student/fees?x=1");
    expect(safeRelativeUrl(undefined)).toBe("/");
  });
  it.each(["//evil.com", "http://evil.com", "https://evil.com/x", "\\evil", "/a\\b", "evil", "/\u0007x", "/" + "a".repeat(200)])(
    "replaces %s with /",
    (u) => {
      expect(safeRelativeUrl(u)).toBe("/");
    },
  );
});
