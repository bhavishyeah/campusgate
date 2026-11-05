import { describe, it, expect } from "vitest";
import { platformKeys } from "../keys";

describe("platformKeys", () => {
  it("stats() is a stable static key", () => {
    expect(platformKeys.stats()).toEqual(["platform", "stats"]);
  });

  it("institutions() is a stable static key", () => {
    expect(platformKeys.institutions()).toEqual(["platform", "institutions"]);
  });

  it("modules(id) embeds the institution id", () => {
    expect(platformKeys.modules("inst-1")).toEqual([
      "platform",
      "institutions",
      "inst-1",
      "modules",
    ]);
  });

  it("grants() embeds both institutionId and status (null when omitted)", () => {
    expect(platformKeys.grants()).toEqual([
      "platform",
      "support-grants",
      { institutionId: null, status: null },
    ]);
    expect(platformKeys.grants("inst-9", "ACTIVE")).toEqual([
      "platform",
      "support-grants",
      { institutionId: "inst-9", status: "ACTIVE" },
    ]);
    expect(platformKeys.grants("inst-9")).toEqual([
      "platform",
      "support-grants",
      { institutionId: "inst-9", status: null },
    ]);
  });

  it("grantOverview(grantId) embeds the grant id", () => {
    expect(platformKeys.grantOverview("g-1")).toEqual([
      "platform",
      "support-grants",
      "g-1",
      "overview",
    ]);
  });

  it("audit() embeds scope, grantId and limit", () => {
    expect(platformKeys.audit("platform", null, 50)).toEqual([
      "platform",
      "audit-events",
      { scope: "platform", grantId: null, limit: 50 },
    ]);
    expect(platformKeys.audit("grant", "g-2", 10)).toEqual([
      "platform",
      "audit-events",
      { scope: "grant", grantId: "g-2", limit: 10 },
    ]);
  });

  it("distinct inputs produce distinct serialized keys", () => {
    const a = JSON.stringify(platformKeys.grants("inst-1", "ACTIVE"));
    const b = JSON.stringify(platformKeys.grants("inst-1", "REVOKED"));
    const c = JSON.stringify(platformKeys.grants("inst-2", "ACTIVE"));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
