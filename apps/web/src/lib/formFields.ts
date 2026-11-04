import { z } from "zod";
import { minuteFromTime } from "@/features/hr/format";

/**
 * Pure zod field builders for forms. All form values are strings; these wrap the
 * same zod chains the shared server schemas use, so the client messages are the
 * server's messages by construction (pinned in lib/__tests__/formFields.test.ts
 * and in each module's serverParity test).
 */

/** Required trimmed text. The server does not trim; the client trims (UI choice). */
export const reqText = (requiredMsg: string, max: number) =>
  z.string().trim().min(1, requiredMsg).max(max);

/** Optional trimmed text: blank becomes undefined. */
export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v));

/** Required integer. A blank value coerces to 0 exactly as the server's z.coerce.number() does. */
export const reqInt = (opts: { min: number; max?: number }) => {
  const base = z.coerce.number().int().min(opts.min);
  return z.string().pipe(opts.max === undefined ? base : base.max(opts.max));
};

/** Optional integer: blank becomes undefined. */
export const optInt = (opts: { min: number; max?: number }) => {
  const base = z.coerce.number().int().min(opts.min);
  return z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .pipe((opts.max === undefined ? base : base.max(opts.max)).optional());
};

/** Optional number: blank becomes undefined. */
export const optNumber = () =>
  z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .pipe(z.coerce.number().optional());

/** Required date (YYYY-MM-DD input). Blank or invalid gives the server's `Invalid date`. */
export const reqDate = () => z.string().pipe(z.coerce.date());

/** Required enum. A blank value behaves like a missing server field (`Required`). */
export const reqEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.enum(values));

/** Required picker id. Unselected gives `Required`. */
export const reqId = () =>
  z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().min(1).max(64));

/**
 * Required HH:MM time converted to minutes of day. Blank or invalid input maps to NaN,
 * which fails with the server's `Expected number, received nan` (never 00:00).
 */
export const reqTime = () =>
  z
    .string()
    .transform((v) => minuteFromTime(v) ?? NaN)
    .pipe(z.number().int().min(0).max(1439));

/** Optional HH:MM time: blank becomes undefined; an invalid value fails like reqTime. */
export const optTime = () =>
  z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : (minuteFromTime(v) ?? NaN)))
    .pipe(z.number().int().min(0).max(1439).optional());

/** A digit string of paise (already converted from rupees). */
export const digitString = () =>
  z.string().regex(/^\d+$/, "must be a non-negative integer number of paise");
