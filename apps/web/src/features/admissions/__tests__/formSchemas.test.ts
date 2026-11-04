import { describe, it, expect } from "vitest";
import {
  buildApplyFormSchema,
  buildApplyValues,
  buildCampaignPatch,
  campaignFormSchema,
  offerFormSchema,
  toFormData,
  type CampaignFormValues,
} from "../formSchemas";

const base: CampaignFormValues = {
  name: "Intake 2026",
  intakeSessionId: "",
  targetProgramId: "",
  programIds: [],
  openAt: "",
  closeAt: "",
  requiredFields: ["name"],
  requiredDocTypes: ["marksheet"],
};

describe("campaignFormSchema (R1 keys)", () => {
  it("accepts safe keys", () => {
    expect(campaignFormSchema.safeParse({ ...base, requiredFields: ["name", "date_of_birth"] }).success).toBe(true);
  });
  it("rejects unsafe or unrenderable keys", () => {
    for (const key of ["address.line1", "0", "a[0]", "__proto__", "constructor"]) {
      expect(campaignFormSchema.safeParse({ ...base, requiredFields: [key] }).success, key).toBe(false);
    }
  });
  it("rejects duplicate keys", () => {
    expect(campaignFormSchema.safeParse({ ...base, requiredFields: ["name", "name"] }).success).toBe(false);
  });
  it("rejects open after close", () => {
    const r = campaignFormSchema.safeParse({ ...base, openAt: "2026-05-02T10:00", closeAt: "2026-05-01T10:00" });
    expect(r.success).toBe(false);
  });
});

describe("toFormData (R1 index mapping)", () => {
  it("maps dotted and numeric keys flat, with no nesting", () => {
    const out = toFormData(["address.line1", "0", "name"], [" a ", "b", "c"]);
    expect(out).toEqual({ "address.line1": "a", "0": "b", name: "c" });
  });
  it("throws on __proto__ and leaves Object.prototype clean", () => {
    expect(() => toFormData(["__proto__"], ["x"])).toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("preserves untouched non-string values from the original", () => {
    const out = toFormData(["name"], ["Asha"], { name: "old", extra: { a: 1 }, n: 5 });
    expect(out).toEqual({ name: "Asha", extra: { a: 1 }, n: 5 });
  });
  it("buildApplyValues reads existing strings and blanks missing", () => {
    expect(buildApplyValues(["name", "dob"], { name: "Asha" })).toEqual(["Asha", ""]);
  });
});

describe("buildApplyFormSchema", () => {
  const schema = buildApplyFormSchema(["name", "dob"]);
  it("requires both values and trims", () => {
    expect(schema.safeParse({ values: ["a", ""] }).success).toBe(false);
    const r = schema.safeParse({ values: [" a ", " b "] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.values).toEqual(["a", "b"]);
  });
  it("requires the same length as keys", () => {
    expect(schema.safeParse({ values: ["a"] }).success).toBe(false);
  });
});

describe("buildCampaignPatch (R2)", () => {
  it("sends both config arrays when only requiredDocTypes is dirty", () => {
    const body = buildCampaignPatch({ requiredDocTypes: [true] }, { ...base, requiredFields: ["name", "dob"], requiredDocTypes: ["id"] });
    expect(body).toEqual({ config: { requiredFields: ["name", "dob"], requiredDocTypes: ["id"] } });
  });
  it("sends both config arrays when only requiredFields is dirty", () => {
    const body = buildCampaignPatch({ requiredFields: [true] }, base);
    expect(body).toEqual({ config: { requiredFields: ["name"], requiredDocTypes: ["marksheet"] } });
  });
  it("sends no config when neither is dirty", () => {
    expect(buildCampaignPatch({ name: true }, base)).toEqual({ name: "Intake 2026" });
  });
  it("sends null for cleared target program, intake session and openAt", () => {
    const body = buildCampaignPatch({ targetProgramId: true, intakeSessionId: true, openAt: true }, base);
    expect(body).toEqual({ targetProgramId: null, intakeSessionId: null, openAt: null });
  });
});

describe("offerFormSchema", () => {
  it("rejects a past expiry", () => {
    expect(offerFormSchema.safeParse({ offeredProgramId: "p", expiresAt: "2000-01-01T00:00" }).success).toBe(false);
  });
  it("accepts blank or future expiry", () => {
    expect(offerFormSchema.safeParse({ offeredProgramId: "p", expiresAt: "" }).success).toBe(true);
    expect(offerFormSchema.safeParse({ offeredProgramId: "p", expiresAt: "2999-01-01T00:00" }).success).toBe(true);
  });
});
