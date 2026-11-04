export const qualificationKindLabel: Record<string, string> = {
  DEGREE: "Degree",
  CERTIFICATION: "Certification",
  DIPLOMA: "Diploma",
  OTHER: "Other",
};

export const QUALIFICATION_KIND_OPTIONS = Object.entries(qualificationKindLabel).map(
  ([value, label]) => ({ value, label }),
);

export const assignmentRoleLabel: Record<string, string> = {
  PRIMARY: "Primary",
  SUBSTITUTE: "Substitute",
  ASSISTANT: "Assistant",
};

export const changeTypeLabel: Record<string, string> = {
  ASSIGNED: "Assigned",
  ENDED: "Ended",
};

export const facultyStatusLabel: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};
