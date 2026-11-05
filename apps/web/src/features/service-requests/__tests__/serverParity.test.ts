import { describe, it, expect } from "vitest";
import {
  createServiceRequestTypeSchema,
  patchServiceRequestTypeSchema,
  createServiceRequestFieldSchema,
  patchServiceRequestFieldSchema,
  raiseServiceRequestSchema,
  assignServiceRequestSchema,
  serviceRequestStatusPatchSchema,
  resolveServiceRequestSchema,
  rejectServiceRequestSchema,
  serviceRequestCommentSchema,
  serviceRequestFeedbackSchema,
  serviceRequestUserLookupQuerySchema,
} from "@campusgate/shared";
import {
  typeCreateSchema,
  typePatchSchema,
  fieldCreateSchema,
  resolveSchema,
  commentSchema,
  buildTypeCreate,
  buildFieldCreate,
  buildAssign,
  buildStatus,
  buildResolve,
  buildComment,
  buildFeedback,
  buildRaise,
} from "../formSchemas";
import type { z } from "zod";
import type { FieldDef } from "../types";

function firstMessage(schema: z.ZodTypeAny, input: unknown, path?: string): string | undefined {
  const r = schema.safeParse(input);
  if (r.success) return undefined;
  const issues = path ? r.error.issues.filter((i) => i.path.join(".") === path) : r.error.issues;
  return (issues[0] ?? r.error.issues[0])?.message;
}

const typeBase = { description: "", defaultAssigneeRole: "", defaultAssigneeDepartmentId: "", slaTargetHours: "24", requiresApproval: false, isActive: true };

describe("service-requests serverParity — type create messages", () => {
  it("code blank / bad-chars and category blank match the server (custom messages)", () => {
    expect(firstMessage(typeCreateSchema, { ...typeBase, name: "N", code: "", category: "C" }, "code")).toBe(
      firstMessage(createServiceRequestTypeSchema, { name: "N", code: "", category: "C", slaTargetHours: 24 }, "code"),
    );
    expect(firstMessage(createServiceRequestTypeSchema, { name: "N", code: "", category: "C", slaTargetHours: 24 }, "code")).toBe("Code is required");
    expect(firstMessage(typeCreateSchema, { ...typeBase, name: "N", code: "a b", category: "C" }, "code")).toBe(
      firstMessage(createServiceRequestTypeSchema, { name: "N", code: "a b", category: "C", slaTargetHours: 24 }, "code"),
    );
    expect(firstMessage(createServiceRequestTypeSchema, { name: "N", code: "a b", category: "C", slaTargetHours: 24 }, "code")).toBe("Code must be [A-Z0-9_]");
    expect(firstMessage(typeCreateSchema, { ...typeBase, name: "N", code: "C", category: "" }, "category")).toBe(
      firstMessage(createServiceRequestTypeSchema, { name: "N", code: "C", category: "", slaTargetHours: 24 }, "category"),
    );
    expect(firstMessage(createServiceRequestTypeSchema, { name: "N", code: "C", category: "", slaTargetHours: 24 }, "category")).toBe("Category is required");
  });
  it("name blank matches", () => {
    expect(firstMessage(createServiceRequestTypeSchema, { name: "", code: "C", category: "C", slaTargetHours: 24 }, "name")).toBe("Name is required");
  });
});

describe("service-requests serverParity — type patch drops custom code/category messages (6.2)", () => {
  it("patch code/category use the message-less standard zod strings", () => {
    const clientMsg = firstMessage(typePatchSchema, { ...typeBase, name: "N", code: "", category: "C" }, "code");
    const serverMsg = firstMessage(patchServiceRequestTypeSchema, { code: "" }, "code");
    // Server PATCH says the standard "String must contain at least 1 character(s)".
    expect(serverMsg).toBe("String must contain at least 1 character(s)");
    // Client PATCH intentionally shows the create text on blank (6.2 exception).
    expect(clientMsg).toBe("Code is required");
    // Bad chars on PATCH -> standard zod regex message on the server.
    expect(firstMessage(patchServiceRequestTypeSchema, { code: "a b" }, "code")).toBe("Invalid");
  });
});

describe("service-requests serverParity — field create messages", () => {
  it("field key blank/bad-chars, label blank, SELECT-shape match", () => {
    expect(firstMessage(createServiceRequestFieldSchema, { fieldKey: "", label: "L", dataType: "TEXT" }, "fieldKey")).toBe("Field key is required");
    expect(firstMessage(createServiceRequestFieldSchema, { fieldKey: "a b", label: "L", dataType: "TEXT" }, "fieldKey")).toBe("Field key must be [a-zA-Z0-9_]");
    expect(firstMessage(createServiceRequestFieldSchema, { fieldKey: "k", label: "", dataType: "TEXT" }, "label")).toBe("Label is required");
    expect(firstMessage(createServiceRequestFieldSchema, { fieldKey: "k", label: "L", dataType: "SELECT" }, "options")).toBe(
      "SELECT fields require non-empty options; non-SELECT fields must omit options",
    );
    // client mirrors
    expect(firstMessage(fieldCreateSchema, { fieldKey: "", label: "L", dataType: "TEXT", required: false, sortOrder: "", options: [] }, "fieldKey")).toBe("Field key is required");
    expect(firstMessage(fieldCreateSchema, { fieldKey: "a b", label: "L", dataType: "TEXT", required: false, sortOrder: "", options: [] }, "fieldKey")).toBe("Field key must be [a-zA-Z0-9_]");
    expect(firstMessage(fieldCreateSchema, { fieldKey: "k", label: "L", dataType: "SELECT", required: false, sortOrder: "", options: [] }, "options")).toBe(
      "SELECT fields require non-empty options; non-SELECT fields must omit options",
    );
  });
});

describe("service-requests serverParity — other required messages", () => {
  it("resolve note / comment body match", () => {
    expect(firstMessage(resolveSchema, { resolutionNote: "" }, "resolutionNote")).toBe(
      firstMessage(resolveServiceRequestSchema, { resolutionNote: "" }, "resolutionNote"),
    );
    expect(firstMessage(resolveServiceRequestSchema, { resolutionNote: "" }, "resolutionNote")).toBe("Resolution note is required");
    expect(firstMessage(commentSchema, { body: "" }, "body")).toBe(
      firstMessage(serviceRequestCommentSchema, { body: "" }, "body"),
    );
    expect(firstMessage(serviceRequestCommentSchema, { body: "" }, "body")).toBe("Comment body is required");
  });
  it("raise title + user-lookup short-q messages", () => {
    expect(firstMessage(raiseServiceRequestSchema, { requestTypeId: "t1", title: "" }, "title")).toBe("Title is required");
    expect(firstMessage(serviceRequestUserLookupQuerySchema, { q: "a" }, "q")).toBe("Enter at least 2 characters");
  });
});

describe("service-requests serverParity — priority optional/defaulted to NORMAL", () => {
  it("omitted priority defaults to NORMAL on the shared schema", () => {
    const r = raiseServiceRequestSchema.safeParse({ requestTypeId: "t1", title: "Help" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBe("NORMAL");
  });
  it("a cleared priority on the client resolves to NORMAL (not Required)", () => {
    const body = buildRaise({ requestTypeId: "t1", title: "Help", description: undefined, priority: "NORMAL" }, [], {});
    expect(body.priority).toBe("NORMAL");
    expect(raiseServiceRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe("service-requests serverParity — builder outputs pass the shared schema", () => {
  it("type create", () => {
    const body = buildTypeCreate({
      name: "Wifi",
      code: "WIFI",
      category: "IT",
      description: undefined,
      defaultAssigneeRole: undefined,
      defaultAssigneeDepartmentId: "",
      slaTargetHours: 24,
      requiresApproval: false,
      isActive: true,
    });
    expect(createServiceRequestTypeSchema.safeParse(body).success).toBe(true);
  });
  it("field create (SELECT + non-SELECT)", () => {
    const select = buildFieldCreate({ fieldKey: "pick", label: "Pick", dataType: "SELECT", required: true, sortOrder: 0, options: ["a", "b"] });
    expect(createServiceRequestFieldSchema.safeParse(select).success).toBe(true);
    const text = buildFieldCreate({ fieldKey: "txt", label: "Text", dataType: "TEXT", required: false, sortOrder: undefined, options: [] });
    expect(createServiceRequestFieldSchema.safeParse(text).success).toBe(true);
  });
  it("assign / status / resolve / comment / feedback", () => {
    expect(assignServiceRequestSchema.safeParse(buildAssign({ assigneeUserId: "u1" })).success).toBe(true);
    expect(serviceRequestStatusPatchSchema.safeParse(buildStatus({ toStatus: "IN_PROGRESS" })).success).toBe(true);
    expect(resolveServiceRequestSchema.safeParse(buildResolve({ resolutionNote: "fixed" })).success).toBe(true);
    expect(serviceRequestCommentSchema.safeParse(buildComment({ body: "hi" })).success).toBe(true);
    expect(serviceRequestFeedbackSchema.safeParse(buildFeedback({ rating: 5, comment: undefined })).success).toBe(true);
  });
  it("reject with no reason passes", () => {
    expect(rejectServiceRequestSchema.safeParse({}).success).toBe(true);
    expect(patchServiceRequestFieldSchema.safeParse({ label: "New" }).success).toBe(true);
  });
  it("raise with fieldValues (NUMBER coerced) passes the shared envelope", () => {
    const fields: FieldDef[] = [
      { id: "1", fieldKey: "age", label: "Age", dataType: "NUMBER", required: true, options: null, sortOrder: 0 },
      { id: "2", fieldKey: "note", label: "Note", dataType: "TEXT", required: false, options: null, sortOrder: 1 },
    ];
    const body = buildRaise({ requestTypeId: "t1", title: "Help", description: undefined, priority: "HIGH" }, fields, { age: "30", note: "hi" });
    expect(raiseServiceRequestSchema.safeParse(body).success).toBe(true);
    expect((body.fieldValues as Record<string, unknown>).age).toBe(30);
  });
  it("raise MAY omit fieldValues and still pass the shared envelope (.default({}))", () => {
    const body = buildRaise({ requestTypeId: "t1", title: "Help", description: undefined, priority: "NORMAL" }, [], {});
    expect("fieldValues" in body).toBe(false);
    expect(raiseServiceRequestSchema.safeParse(body).success).toBe(true);
  });
});
