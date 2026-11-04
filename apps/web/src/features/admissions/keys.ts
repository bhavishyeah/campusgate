export const admissionsKeys = {
  campaignsAll: () => ["admissions", "campaigns"] as const,
  campaigns: (page: number) => ["admissions", "campaigns", "list", page] as const,
  campaign: (id: string) => ["admissions", "campaigns", "detail", id] as const,
  lookups: () => ["admissions", "lookups"] as const,
  applicationsAll: () => ["admissions", "applications"] as const,
  applications: (f: { campaignId?: string; status?: string; page: number }) =>
    ["admissions", "applications", "list", f] as const,
  application: (id: string) => ["admissions", "applications", "detail", id] as const,
  openCampaignsAll: () => ["admissions", "open-campaigns"] as const,
  openCampaigns: (page: number) => ["admissions", "open-campaigns", "list", page] as const,
  openCampaign: (id: string) => ["admissions", "open-campaigns", "detail", id] as const,
  mine: () => ["admissions", "mine"] as const,
} as const;
