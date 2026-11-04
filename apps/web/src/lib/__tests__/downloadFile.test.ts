import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { downloadAuthed } from "../downloadFile";

function okResponse(disposition: string | null): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["x"]),
    headers: { get: (k: string) => (k === "Content-Disposition" ? disposition : null) },
    json: async () => ({}),
  } as unknown as Response;
}

describe("downloadAuthed", () => {
  let created: HTMLAnchorElement[];
  const create = vi.fn(() => "blob:test");
  const revoke = vi.fn();

  beforeEach(() => {
    created = [];
    create.mockClear();
    revoke.mockClear();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === "a") {
        (el as HTMLAnchorElement).click = vi.fn();
        created.push(el as HTMLAnchorElement);
      }
      return el;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads with the header filename and revokes the object URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse('attachment; filename="a-b.xlsx"')));
    await downloadAuthed("/api/x", "fallback.xlsx");
    expect(created[0].download).toBe("a-b.xlsx");
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test");
  });

  it("uses the fallback name when there is no header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(null)));
    await downloadAuthed("/api/x", "fallback.xlsx");
    expect(created[0].download).toBe("fallback.xlsx");
  });

  it("throws ApiError with the parsed body on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "nope" }) }) as unknown as Response),
    );
    await expect(downloadAuthed("/api/x", "f.xlsx")).rejects.toMatchObject({
      status: 409,
      data: { error: "nope" },
    });
    await expect(downloadAuthed("/api/x", "f.xlsx")).rejects.toBeInstanceOf(ApiError);
    expect(create).not.toHaveBeenCalled();
  });
});
