import { describe, it, expect } from "vitest";
import {
  SIDEBAR_STORAGE_KEY,
  contentOffsetClass,
  parseCollapsed,
  serializeCollapsed,
  sidebarWidthClass,
  toggleLabel,
} from "./sidebarState";

describe("collapsed-state storage helper", () => {
  it("uses a single key", () => {
    expect(SIDEBAR_STORAGE_KEY).toBe("cg.sidebar.collapsed");
  });
  it("defaults to expanded for missing or bad values", () => {
    for (const v of [null, undefined, "", "0", "true", "yes", "{}", "2"]) {
      expect(parseCollapsed(v as string | null | undefined)).toBe(false);
    }
  });
  it("round-trips", () => {
    expect(parseCollapsed(serializeCollapsed(true))).toBe(true);
    expect(parseCollapsed(serializeCollapsed(false))).toBe(false);
  });
});

describe("width / class decision", () => {
  it("expanded is w-64 with matching content offset", () => {
    expect(sidebarWidthClass(false)).toBe("md:w-64");
    expect(contentOffsetClass(false)).toBe("md:pl-64");
    expect(toggleLabel(false)).toBe("Collapse sidebar");
  });
  it("collapsed is a w-16 rail with matching content offset", () => {
    expect(sidebarWidthClass(true)).toBe("md:w-16");
    expect(contentOffsetClass(true)).toBe("md:pl-16");
    expect(toggleLabel(true)).toBe("Expand sidebar");
  });
});
