import { describe, it, expect } from "vitest";
import { decidePlatformAccess, type PlatformAccess } from "../guard";

describe("decidePlatformAccess", () => {
  const all: boolean[] = [false, true];

  it("is exhaustive and fail-closed over {hydrated,hasSession,isSuper}", () => {
    const seen: Record<string, PlatformAccess> = {};
    for (const hydrated of all) {
      for (const hasSession of all) {
        for (const isSuper of all) {
          const decision = decidePlatformAccess({ hydrated, hasSession, isSuper });
          seen[`${hydrated}-${hasSession}-${isSuper}`] = decision;

          // Fail-closed invariant: 'allow' requires ALL THREE signals.
          if (decision === "allow") {
            expect(hydrated && hasSession && isSuper).toBe(true);
          }
        }
      }
    }
    // All 8 combinations covered.
    expect(Object.keys(seen)).toHaveLength(8);
  });

  it("not hydrated always yields skeleton (regardless of other signals)", () => {
    for (const hasSession of all) {
      for (const isSuper of all) {
        expect(decidePlatformAccess({ hydrated: false, hasSession, isSuper })).toBe(
          "skeleton",
        );
      }
    }
  });

  it("hydrated but no session yields redirect", () => {
    for (const isSuper of all) {
      expect(
        decidePlatformAccess({ hydrated: true, hasSession: false, isSuper }),
      ).toBe("redirect");
    }
  });

  it("hydrated + session but not super yields noaccess", () => {
    expect(
      decidePlatformAccess({ hydrated: true, hasSession: true, isSuper: false }),
    ).toBe("noaccess");
  });

  it("only hydrated + session + super yields allow", () => {
    expect(
      decidePlatformAccess({ hydrated: true, hasSession: true, isSuper: true }),
    ).toBe("allow");
  });
});
