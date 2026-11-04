import type { Resolver } from "react-hook-form";
import type { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

/**
 * zodResolver typed for useForm<z.input<S>, unknown, z.output<S>>: form fields are strings and the
 * submit handler receives the parsed (output) values. The installed resolver typing does not infer
 * the transformed output on its own, so the cast lives here once.
 */
export function zodFormResolver<S extends z.ZodTypeAny>(schema: S): Resolver<z.input<S>, unknown, z.output<S>> {
  return zodResolver(schema) as unknown as Resolver<z.input<S>, unknown, z.output<S>>;
}
