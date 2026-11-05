/** TanStack Query key factory for the fees domain. */
export const feesKeys = {
  structures: () => ["fees", "structures"] as const,
  structure: (id: string) => ["fees", "structure", id] as const,
  components: (id: string) => ["fees", "structure", id, "components"] as const,
  ledger: (sid: string) => ["fees", "ledger", sid] as const,
  payments: () => ["fees", "payments"] as const,
  receipts: () => ["fees", "receipts"] as const,
  reconciliation: (q: unknown) => ["fees", "reconciliation", q] as const,
  meCharges: () => ["fees", "me", "charges"] as const,
  meReceipts: () => ["fees", "me", "receipts"] as const,
  meOutstanding: () => ["fees", "me", "outstanding"] as const,
  studentLookup: (q: string) => ["fees", "student-lookup", q] as const,
} as const;
