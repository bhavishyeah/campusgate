import { describe, it, expect } from "vitest";
import {
  typeCreateSchema,
  typePatchSchema,
  fieldCreateSchema,
  raiseSchema,
  feedbackSchema,
  buildTypePatch,
  buildFieldCreate,
  buildFieldPatch,
  buildReject,
  buildRaise,
  type TypePatchValues,
  type FieldPatchValues,
} from "../formSchemas";
import type { z } from "zod";
import type { FieldDef } from "../types";

function msg(schema: z.ZodTypeAny, input: unknown, path?: string): string | undefined {
  const r = schema.safeParse(input);
  if (r.success) return undefined;
  const issues = path ? r.error.issues.filter((i) => i.path.join(".") === path) : r.error.issues;
  return (issues[0] ?? r.error.issues[0])?.message;
}

const typeBase = { description: "", defaultAssigneeRole: "", defaultAssigneeDepartmentId: "", slaTargetHours: "24", requiresApproval: false, isActive: true };

describe("service-requests formSchemas — literal message pins", () => {
  it("type create custom messages", () => {
    expect(msg(typeCreateSchema, { ...typeBase, name: "", code: "C", category: "C" }, "name")).toBe("Name is required");
    expect(msg(typeCreateSchema, { ...typeBase, name: "N", code: "", category: "C" }, "code")).toBe("Code is required");
    expect(msg(typeCreateSchema, { ...typeBase, name: "N", code: "a b", category: "C" }, "code")).toBe("Code must be [A-Z0-9_]");
    expect(msg(typeCreateSchema, { ...typeBase, name: "N", code: "C", category: "" }, "category")).toBe("Category is required");
  });
  it("field create custom messages + SELECT-shape", () => {
    const fb = { required: false, sortOrder: "", options: [] as string[] };
    expect(msg(fieldCreateSchema, { ...fb, fieldKey: "", label: "L", dataType: "TEXT" }, "fieldKey")).toBe("Field key is required");
    expect(msg(fieldCreateSchema, { ...fb, fieldKey: "a b", label: "L", dataType: "TEXT" }, "fieldKey")).toBe("Field key must be [a-zA-Z0-9_]");
    expect(msg(fieldCreateSchema, { ...fb, fieldKey: "k", label: "", dataType: "TEXT" }, "label")).toBe("Label is required");
    expect(msg(fieldCreateSchema, { ...fb, fieldKey: "k", label: "L", dataType: "SELECT" }, "options")).toBe(
      "SELECT fields require non-empty options; non-SELECT fields must omit options",
    );
  });
  it("raise title required", () => {
    expect(msg(raiseSchema, { requestTypeId: "t1", title: "", description: "", priority: "" }, "title")).toBe("Title is required");
  });
  it("blank-on-edit type code/category show the create text (6.2)", () => {
    expect(msg(typePatchSchema, { ...typeBase, name: "N", code: "", category: "C" }, "code")).toBe("Code is required");
    expect(msg(typePatchSchema, { ...typeBase, name: "N", code: "C", category: "" }, "category")).toBe("Category is required");
  });
});

describe("service-requests formSchemas — boundaries + priority default", () => {
  it("SLA 1 ok / 0 fails / 8760 ok / 8761 fails", () => {
    const base = { ...typeBase, name: "N", code: "C", category: "C" };
    expect(typeCreateSchema.safeParse({ ...base, slaTargetHours: "1" }).success).toBe(true);
    expect(typeCreateSchema.safeParse({ ...base, slaTargetHours: "0" }).success).toBe(false);
    expect(typeCreateSchema.safeParse({ ...base, slaTargetHours: "8760" }).success).toBe(true);
    expect(typeCreateSchema.safeParse({ ...base, slaTargetHours: "8761" }).success).toBe(false);
  });
  it("rating 1/0/5/6", () => {
    expect(feedbackSchema.safeParse({ rating: "1", comment: "" }).success).toBe(true);
    expect(feedbackSchema.safeParse({ rating: "0", comment: "" }).success).toBe(false);
    expect(feedbackSchema.safeParse({ rating: "5", comment: "" }).success).toBe(true);
    expect(feedbackSchema.safeParse({ rating: "6", comment: "" }).success).toBe(false);
  });
  it("cleared/omitted priority resolves to NORMAL", () => {
    const r = raiseSchema.safeParse({ requestTypeId: "t1", title: "Help", description: "", priority: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBe("NORMAL");
  });
});

describe("service-requests formSchemas — builders", () => {
  it("type patch is dirty-only with null clearables", () => {
    const v: TypePatchValues = {
      name: "N", code: "C", category: "Cat", description: undefined, defaultAssigneeRole: undefined,
      defaultAssigneeDepartmentId: "", slaTargetHours: 24, requiresApproval: false, isActive: true,
    };
    expect(buildTypePatch({ description: true }, v)).toEqual({ description: null });
    expect(buildTypePatch({ name: true }, v)).toEqual({ name: "N" });
  });
  it("field create sends options only for SELECT; non-SELECT omits options", () => {
    expect(buildFieldCreate({ fieldKey: "k", label: "L", dataType: "TEXT", required: false, sortOrder: undefined, options: [] }).options).toBeUndefined();
    expect(buildFieldCreate({ fieldKey: "k", label: "L", dataType: "SELECT", required: true, sortOrder: 0, options: ["a"] }).options).toEqual(["a"]);
  });
  it("field patch sends options null when switching away from SELECT", () => {
    const v: FieldPatchValues = { fieldKey: "k", label: "L", dataType: "TEXT", required: false, sortOrder: undefined, options: [] };
    expect(buildFieldPatch({ dataType: true }, v).options).toBeNull();
  });
  it("reject omits a blank reason", () => {
    expect(buildReject({ reason: undefined })).toEqual({});
    expect(buildReject({ reason: "spam" })).toEqual({ reason: "spam" });
  });
  it("buildRaise coerces NUMBER to number, DATE/TEXT/SELECT to string, omits blanks", () => {
    const fields: FieldDef[] = [
      { id: "1", fieldKey: "age", label: "Age", dataType: "NUMBER", required: true, options: null, sortOrder: 0 },
      { id: "2", fieldKey: "when", label: "When", dataType: "DATE", required: false, options: null, sortOrder: 1 },
      { id: "3", fieldKey: "empty", label: "Empty", dataType: "TEXT", required: false, options: null, sortOrder: 2 },
    ];
    const body = buildRaise({ requestTypeId: "t1", title: "Help", description: undefined, priority: "NORMAL" }, fields, { age: "30", when: "2026-01-01", empty: "" });
    const fv = body.fieldValues as Record<string, unknown>;
    expect(fv.age).toBe(30);
    expect(fv.when).toBe("2026-01-01");
    expect("empty" in fv).toBe(false);
  });
});
