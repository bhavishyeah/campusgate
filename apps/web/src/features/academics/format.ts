import { formatDate } from "@/features/hr/format";

/**
 * Display-only formatting for academic session/term dates.
 * The server returns dates as UTC-midnight ISO timestamps; reuse the shared
 * UTC-stable formatter so a value like 2026-07-01T00:00:00.000Z never shifts a
 * day and null/empty values render as a dash.
 */
export { formatDate };
