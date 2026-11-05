import { describe, expect, it } from "vitest";
import { ACCESS_LEVEL_LABEL, DOC_STATUS_LABEL, canDownloadStatus, formatBytes } from "../labels";

describe("DOC_STATUS_LABEL / ACCESS_LEVEL_LABEL", () => {
  it("maps every status", () => {
    expect(DOC_STATUS_LABEL.ACTIVE).toBe("Active");
    expect(DOC_STATUS_LABEL.ARCHIVED).toBe("Archived");
    expect(DOC_STATUS_LABEL.PURGE_PENDING).toBe("Purge pending");
    expect(DOC_STATUS_LABEL.PURGED).toBe("Purged");
  });
  it("maps every access level", () => {
    expect(ACCESS_LEVEL_LABEL.READ).toBe("Read");
    expect(ACCESS_LEVEL_LABEL.MANAGE).toBe("Manage");
  });
});

describe("formatBytes (BigInt-string input)", () => {
  it("formats bytes under 1 KiB", () => {
    expect(formatBytes("0")).toBe("0 B");
    expect(formatBytes("512")).toBe("512 B");
    expect(formatBytes("1023")).toBe("1023 B");
  });
  it("formats KiB and MiB", () => {
    expect(formatBytes("1024")).toBe("1 KiB");
    expect(formatBytes("1536")).toBe("1.5 KiB");
    expect(formatBytes(String(1024 * 1024))).toBe("1 MiB");
    expect(formatBytes(String(25 * 1024 * 1024))).toBe("25 MiB");
  });
  it("handles very large BigInt strings (never Number-overflows the API contract)", () => {
    expect(formatBytes(String(1024 ** 4))).toBe("1 TiB");
  });
  it("returns an em dash for garbage / negatives", () => {
    expect(formatBytes("not-a-number")).toBe("—");
    expect(formatBytes("-5")).toBe("—");
  });
});

describe("canDownloadStatus", () => {
  it("true for ACTIVE/ARCHIVED, false for purge states", () => {
    expect(canDownloadStatus("ACTIVE")).toBe(true);
    expect(canDownloadStatus("ARCHIVED")).toBe(true);
    expect(canDownloadStatus("PURGE_PENDING")).toBe(false);
    expect(canDownloadStatus("PURGED")).toBe(false);
  });
});
