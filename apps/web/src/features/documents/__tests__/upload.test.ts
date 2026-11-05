import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  buildCreateHeaders,
  buildVersionHeaders,
  validateUploadSize,
  type UploadMeta,
} from "../upload";

describe("MAX_UPLOAD_BYTES", () => {
  it("is exactly 25 MiB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(26214400);
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("buildCreateHeaders", () => {
  const base: UploadMeta = { title: "Report", filename: "report.pdf", contentType: "application/pdf" };

  it("produces exactly the required lowercase headers (no optional, no token)", () => {
    expect(buildCreateHeaders(base, null)).toEqual({
      "content-type": "application/octet-stream",
      "x-title": "Report",
      "x-filename": "report.pdf",
      "x-contenttype": "application/pdf",
    });
  });

  it("adds authorization only when a token exists", () => {
    const h = buildCreateHeaders(base, "tok123");
    expect(h["authorization"]).toBe("Bearer tok123");
  });

  it("includes optional headers only when non-empty", () => {
    const h = buildCreateHeaders(
      { ...base, description: "d", category: "", retentionPolicyId: "rp1" },
      null,
    );
    expect(h["x-description"]).toBe("d");
    expect(h["x-retentionpolicyid"]).toBe("rp1");
    expect("x-category" in h).toBe(false);
  });

  it("omits every optional header when all empty/undefined", () => {
    const h = buildCreateHeaders({ ...base, description: "", category: "", retentionPolicyId: undefined }, null);
    expect("x-description" in h).toBe(false);
    expect("x-category" in h).toBe(false);
    expect("x-retentionpolicyid" in h).toBe(false);
  });
});

describe("buildVersionHeaders", () => {
  it("carries only octet-stream + filename + contenttype (+ token)", () => {
    expect(buildVersionHeaders({ filename: "v2.pdf", contentType: "application/pdf" }, null)).toEqual({
      "content-type": "application/octet-stream",
      "x-filename": "v2.pdf",
      "x-contenttype": "application/pdf",
    });
    const h = buildVersionHeaders({ filename: "v2.pdf", contentType: "application/pdf" }, "t");
    expect(h["authorization"]).toBe("Bearer t");
  });
});

describe("validateUploadSize", () => {
  it("rejects an empty file with the select-file message", () => {
    expect(validateUploadSize(0)).toEqual({ ok: false, message: "Select a file to upload." });
  });
  it("accepts exactly 25 MiB", () => {
    expect(validateUploadSize(MAX_UPLOAD_BYTES)).toEqual({ ok: true });
  });
  it("rejects one byte over the limit", () => {
    expect(validateUploadSize(MAX_UPLOAD_BYTES + 1)).toEqual({
      ok: false,
      message: "File is larger than the 25 MiB limit.",
    });
  });
  it("accepts a normal small file", () => {
    expect(validateUploadSize(1024)).toEqual({ ok: true });
  });
});
