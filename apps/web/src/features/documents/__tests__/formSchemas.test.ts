import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  createDocumentGrantSchema as serverGrant,
  createDocumentSchema as serverCreate,
  documentsUserLookupQuerySchema as serverLookup,
  newDocumentVersionSchema as serverVersion,
  upsertDocumentRetentionPolicySchema as serverPolicy,
} from "@campusgate/shared";
import {
  LOOKUP_HINT,
  buildGrantBody,
  buildRetentionPolicyBody,
  createDocumentFormSchema,
  grantFormSchema,
  newVersionFormSchema,
  retentionPolicyFormSchema,
} from "../formSchemas";

function first(schema: z.ZodTypeAny, input: unknown, field: string): string | undefined {
  const r = schema.safeParse(input);
  if (r.success) return undefined;
  return r.error.issues.find((i) => i.path[0] === field)?.message;
}

describe("serverParity — client messages equal the shared schema strings", () => {
  it("create document: title / contentType", () => {
    expect(first(createDocumentFormSchema, { title: "", contentType: "application/pdf", retentionPolicyId: "" }, "title")).toBe(
      first(serverCreate, { title: "", filename: "f", contentType: "application/pdf" }, "title"),
    );
    expect(first(createDocumentFormSchema, { title: "t", contentType: "", retentionPolicyId: "" }, "contentType")).toBe(
      first(serverCreate, { title: "t", filename: "f", contentType: "" }, "contentType"),
    );
  });

  it("new version: contentType", () => {
    expect(first(newVersionFormSchema, { contentType: "" }, "contentType")).toBe(
      first(serverVersion, { filename: "f", contentType: "" }, "contentType"),
    );
  });

  it("retention policy: name", () => {
    expect(first(retentionPolicyFormSchema, { name: "", retentionDays: "30", category: "" }, "name")).toBe(
      first(serverPolicy, { name: "", retentionDays: 30 }, "name"),
    );
  });

  it("grant XOR message equals the server string on granteeUserId", () => {
    const serverMsg = first(
      serverGrant,
      { granteeUserId: "u1", granteeDepartmentId: "d1", accessLevel: "READ" },
      "granteeUserId",
    );
    // both set → rejected
    expect(
      first(
        grantFormSchema,
        { granteeType: "user", granteeUserId: "u1", granteeDepartmentId: "d1", accessLevel: "READ" },
        "granteeUserId",
      ),
    ).toBe(serverMsg);
    // neither set → rejected with the same message
    expect(
      first(
        grantFormSchema,
        { granteeType: "user", granteeUserId: "", granteeDepartmentId: "", accessLevel: "READ" },
        "granteeUserId",
      ),
    ).toBe(serverMsg);
  });

  it("lookup hint equals the server lookup message", () => {
    const r = serverLookup.safeParse({ q: "a" });
    expect(r.success ? "" : r.error.issues[0].message).toBe(LOOKUP_HINT);
  });
});

describe("builder output passes the real shared schemas", () => {
  it("grant (user and department)", () => {
    const u = grantFormSchema.parse({ granteeType: "user", granteeUserId: "u1", granteeDepartmentId: "", accessLevel: "MANAGE" });
    expect(serverGrant.safeParse(buildGrantBody(u)).success).toBe(true);
    const d = grantFormSchema.parse({ granteeType: "department", granteeUserId: "", granteeDepartmentId: "d1", accessLevel: "READ" });
    expect(serverGrant.safeParse(buildGrantBody(d)).success).toBe(true);
  });

  it("retention policy", () => {
    const v = retentionPolicyFormSchema.parse({ name: "Default", retentionDays: "365", category: "" });
    expect(serverPolicy.safeParse(buildRetentionPolicyBody(v)).success).toBe(true);
  });
});
