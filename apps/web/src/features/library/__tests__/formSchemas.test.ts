import { describe, it, expect } from "vitest";
import {
  buildCopyCreate,
  buildTitleCreate,
  buildTitlePatch,
  copyFormSchema,
  fineFormSchema,
  titleFormSchema,
  type TitleFormValues,
} from "../formSchemas";

const base: TitleFormValues = {
  title: "Dune",
  author: "Herbert",
  publisher: "",
  isbn: "",
  category: "",
  edition: "",
  publicationYear: "",
};

describe("titleFormSchema", () => {
  it("accepts 10 and 13 digit ISBNs including hyphens", () => {
    expect(titleFormSchema.safeParse({ ...base, isbn: "0-306-40615-2" }).success).toBe(true);
    expect(titleFormSchema.safeParse({ ...base, isbn: "978-0-306-40615-7" }).success).toBe(true);
  });
  it("rejects a bad ISBN", () => {
    expect(titleFormSchema.safeParse({ ...base, isbn: "12345" }).success).toBe(false);
  });
  it("bounds publicationYear", () => {
    expect(titleFormSchema.safeParse({ ...base, publicationYear: "999" }).success).toBe(false);
    expect(titleFormSchema.safeParse({ ...base, publicationYear: "3001" }).success).toBe(false);
    expect(titleFormSchema.safeParse({ ...base, publicationYear: "2020" }).success).toBe(true);
  });
  it("omits blank optionals on create", () => {
    expect(buildTitleCreate(base)).toEqual({ title: "Dune", author: "Herbert" });
  });
  it("sends null to clear on patch", () => {
    expect(buildTitlePatch({ ...base, publisher: "" }, { publisher: true })).toEqual({ publisher: null });
  });
});

describe("copyFormSchema", () => {
  it("requires an accession number", () => {
    expect(copyFormSchema.safeParse({ accessionNumber: " ", shelfLocation: "", condition: "NEW", acquiredAt: "" }).success).toBe(false);
  });
  it("omits blank optionals on create", () => {
    expect(
      buildCopyCreate({ accessionNumber: "A1", shelfLocation: "", condition: "GOOD", acquiredAt: "" }),
    ).toEqual({ accessionNumber: "A1", condition: "GOOD" });
  });
});

describe("fineFormSchema", () => {
  const ok = { studentId: "s1", reason: "LOST" as const, amount: "10.50", note: "" };
  it("accepts a valid amount", () => {
    expect(fineFormSchema.safeParse(ok).success).toBe(true);
  });
  it("rejects 3 decimals, negatives and text", () => {
    for (const amount of ["1.234", "-1", "abc", ""]) {
      expect(fineFormSchema.safeParse({ ...ok, amount }).success).toBe(false);
    }
  });
});
