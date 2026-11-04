import { z } from "zod";
import { parseRupeeInput } from "./format";

// All form fields are strings (what inputs produce); builders convert to API bodies.

const isbnField = z
  .string()
  .max(20, "ISBN is too long")
  .refine((v) => {
    const t = v.trim();
    if (t === "") return true;
    const digits = t.replace(/[-\s]/g, "");
    return /^\d+$/.test(digits) && (digits.length === 10 || digits.length === 13);
  }, "ISBN must be 10 or 13 digits");

const yearField = z
  .string()
  .refine((v) => {
    const t = v.trim();
    if (t === "") return true;
    if (!/^\d+$/.test(t)) return false;
    const n = Number(t);
    return n >= 1000 && n <= 3000;
  }, "Year must be between 1000 and 3000");

export const titleFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(500),
  author: z.string().trim().min(1, "Author is required").max(300),
  publisher: z.string().trim().max(300),
  isbn: isbnField,
  category: z.string().trim().max(200),
  edition: z.string().trim().max(100),
  publicationYear: yearField,
});
export type TitleFormValues = z.infer<typeof titleFormSchema>;

export const copyFormSchema = z.object({
  accessionNumber: z.string().trim().min(1, "Accession number is required").max(100),
  shelfLocation: z.string().trim().max(200),
  condition: z.enum(["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"]),
  acquiredAt: z.string(),
});
export type CopyFormValues = z.infer<typeof copyFormSchema>;

export const fineFormSchema = z.object({
  studentId: z.string().min(1, "Choose a student"),
  reason: z.enum(["OVERDUE", "LOST", "DAMAGED"]),
  amount: z
    .string()
    .refine((v) => parseRupeeInput(v) !== null, "Enter an amount in rupees, up to 2 decimals"),
  note: z.string().trim().max(2000),
});
export type FineFormValues = z.infer<typeof fineFormSchema>;

export const noteFormSchema = z.object({
  note: z.string().trim().max(2000, "Max 2000 characters"),
});
export type NoteFormValues = z.infer<typeof noteFormSchema>;

const OPTIONAL_TITLE_KEYS = ["publisher", "isbn", "category", "edition"] as const;

/** Create: blank optionals are omitted. */
export function buildTitleCreate(v: TitleFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { title: v.title.trim(), author: v.author.trim() };
  for (const k of OPTIONAL_TITLE_KEYS) {
    const t = v[k].trim();
    if (t !== "") body[k] = t;
  }
  const y = v.publicationYear.trim();
  if (y !== "") body.publicationYear = Number(y);
  return body;
}

/** PATCH: only dirty fields; a cleared optional sends null. */
export function buildTitlePatch(
  v: TitleFormValues,
  dirty: Partial<Record<keyof TitleFormValues, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.title) body.title = v.title.trim();
  if (dirty.author) body.author = v.author.trim();
  for (const k of OPTIONAL_TITLE_KEYS) {
    if (dirty[k]) {
      const t = v[k].trim();
      body[k] = t === "" ? null : t;
    }
  }
  if (dirty.publicationYear) {
    const y = v.publicationYear.trim();
    body.publicationYear = y === "" ? null : Number(y);
  }
  return body;
}

export function buildCopyCreate(v: CopyFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    accessionNumber: v.accessionNumber.trim(),
    condition: v.condition,
  };
  if (v.shelfLocation.trim() !== "") body.shelfLocation = v.shelfLocation.trim();
  if (v.acquiredAt !== "") body.acquiredAt = new Date(v.acquiredAt).toISOString();
  return body;
}

export function buildCopyPatch(
  v: CopyFormValues,
  dirty: Partial<Record<keyof CopyFormValues, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirty.shelfLocation) body.shelfLocation = v.shelfLocation.trim() === "" ? null : v.shelfLocation.trim();
  if (dirty.condition) body.condition = v.condition;
  if (dirty.acquiredAt) body.acquiredAt = v.acquiredAt === "" ? null : new Date(v.acquiredAt).toISOString();
  return body;
}

export function buildNoteBody(v: NoteFormValues): { note?: string } {
  const n = v.note.trim();
  return n === "" ? {} : { note: n };
}
