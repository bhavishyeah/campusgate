import { z } from "zod";
import { addFeeComponentSchema, postChargeSchema } from "@campusgate/shared";
import { rupeesToPaiseString } from "@/lib/money";

/**
 * Client-only, NON-transforming rupee-string field. The value stays a STRING
 * through react-hook-form (PaiseAmount transforms to bigint and so is unusable
 * as a resolver type). The second refine reuses rupeesToPaiseString as the
 * source of truth for "would this convert to a valid positive paise amount?".
 */
export const rupeeStringSchema = z
  .string()
  .refine(
    (v) =>
      /^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$/.test(v) || /^\d+(\.\d{1,2})?$/.test(v),
    "Enter a valid amount",
  )
  .refine((v) => {
    try {
      rupeesToPaiseString(v);
      return true;
    } catch {
      return false;
    }
  }, "Amount must be greater than zero");

/**
 * Add-component form: the shared schema with the bigint-transforming
 * amountPaise swapped for the client rupee-string field. Converted +
 * PaiseAmount-asserted at submit time.
 */
export const addComponentFormSchema = addFeeComponentSchema
  .omit({ amountPaise: true })
  .extend({ amountRupees: rupeeStringSchema });

/** Post-charge (single) form: same money swap as above. */
export const postChargeFormSchema = postChargeSchema
  .omit({ amountPaise: true })
  .extend({ amountRupees: rupeeStringSchema });

export type AddComponentFormValues = z.infer<typeof addComponentFormSchema>;
export type PostChargeFormValues = z.infer<typeof postChargeFormSchema>;
