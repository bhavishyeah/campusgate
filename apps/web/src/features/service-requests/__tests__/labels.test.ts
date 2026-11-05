import { describe, it, expect } from "vitest";
import { requestStatusLabel, priorityLabel, fieldTypeLabel, STATUS_LABELS, toOptions } from "../labels";

const BANNED = ["Delete", "Reopen", "Resume"];

describe("service-requests labels", () => {
  it("every request status (8) has a label", () => {
    for (const s of ["OPEN", "ASSIGNED", "IN_PROGRESS", "PENDING_APPROVAL", "RESOLVED", "CLOSED", "REJECTED", "CANCELLED"]) {
      expect(requestStatusLabel[s]).toBeTruthy();
    }
  });
  it("every priority + field type has a label", () => {
    for (const p of ["LOW", "NORMAL", "HIGH", "URGENT"]) expect(priorityLabel[p]).toBeTruthy();
    for (const t of ["TEXT", "NUMBER", "DATE", "SELECT"]) expect(fieldTypeLabel[t]).toBeTruthy();
  });
  it("no label contains a banned word", () => {
    const all = [...Object.values(requestStatusLabel), ...Object.values(priorityLabel), ...Object.values(fieldTypeLabel)];
    for (const label of all) for (const w of BANNED) expect(label).not.toContain(w);
  });
  it("STATUS_LABELS.request maps request statuses", () => {
    expect(STATUS_LABELS.request).toBe(requestStatusLabel);
  });
  it("toOptions maps entries", () => {
    expect(toOptions({ A: "a" })).toEqual([{ value: "A", label: "a" }]);
  });
});
