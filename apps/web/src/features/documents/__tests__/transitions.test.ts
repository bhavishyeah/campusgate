import { describe, expect, it } from "vitest";
import { DOC_STATUS_TRANSITIONS, lifecycleActions } from "../transitions";

describe("DOC_STATUS_TRANSITIONS", () => {
  it("mirrors the server machine", () => {
    expect(DOC_STATUS_TRANSITIONS.ACTIVE).toEqual(["ARCHIVED", "PURGE_PENDING"]);
    expect(DOC_STATUS_TRANSITIONS.ARCHIVED).toEqual(["ACTIVE", "PURGE_PENDING"]);
    expect(DOC_STATUS_TRANSITIONS.PURGE_PENDING).toEqual(["PURGED"]);
    expect(DOC_STATUS_TRANSITIONS.PURGED).toEqual([]);
  });
});

describe("lifecycleActions", () => {
  it("ACTIVE → archive, purge-request", () => {
    expect(lifecycleActions("ACTIVE")).toEqual(["archive", "purge-request"]);
  });
  it("ARCHIVED → unarchive, purge-request", () => {
    expect(lifecycleActions("ARCHIVED")).toEqual(["unarchive", "purge-request"]);
  });
  it("PURGE_PENDING → purge", () => {
    expect(lifecycleActions("PURGE_PENDING")).toEqual(["purge"]);
  });
  it("PURGED → [] (terminal)", () => {
    expect(lifecycleActions("PURGED")).toEqual([]);
  });
});
