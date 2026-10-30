// Phase 0 module registry + dependency graph — single source of truth for the
// CAMPASS "booster model" (architecture.md §5). Lives alongside the permission
// and audit-action catalogues so the established catalogue-sync meta-test pattern
// extends to it. Future module keys are declared as CONSTANTS here, never as
// tables (database.md §5.4): only `campus_movement` is operational in Phase 0.

export interface ModuleDef {
  key: string;
  name: string;
  description: string;
}

// Known module keys. Only campus_movement is operational in Phase 0; the rest are
// DECLARED so the dependency graph and future activation have stable keys. They are
// NOT seeded as entitlements and have NO tables yet.
export const MODULES = [
  { key: "campus_movement", name: "Campus Movement", description: "GatePass / campus movement (Phase 0, operational)" },
  { key: "student_management", name: "Student Management", description: "SIS (future)" },
  { key: "academic_sessions", name: "Academic Sessions", description: "Sessions/terms (future)" },
  { key: "class_course", name: "Class & Course", description: "Classes/courses (future)" },
  { key: "student_enrollment", name: "Student Enrollment", description: "Enrollment (future)" },
  { key: "attendance", name: "Attendance", description: "Attendance (future)" },
  { key: "examinations", name: "Examinations", description: "Exams (future)" },
  { key: "fees", name: "Fees", description: "Fees (future)" },
  { key: "library", name: "Library", description: "Library (future)" },
  { key: "admissions", name: "Admissions", description: "Admissions (Phase 6)" },
] as const satisfies readonly ModuleDef[];

export type ModuleKey = (typeof MODULES)[number]["key"];
export const MODULE_KEYS: readonly ModuleKey[] = MODULES.map((m) => m.key);
export const MODULE_KEY_SET: ReadonlySet<string> = new Set<string>(MODULE_KEYS);

// Declared dependency graph (architecture.md §5.4): moduleKey -> required moduleKeys.
// A module may activate only when EVERY listed dependency is already ACTIVE for the
// institution. Phase-0 reality: campus_movement has NO deps. Future modules' edges
// are declared now so the MECHANISM is complete and tested, but their tables do not
// exist yet.
export const MODULE_DEPENDENCIES: Record<ModuleKey, readonly ModuleKey[]> = {
  campus_movement: [],
  student_management: [],
  academic_sessions: [],
  class_course: [],
  student_enrollment: [],
  // attendance is foundational-not-gated (design §4.2 Option a): only its own row
  // must be ENTITLED->ACTIVE. Foundational prerequisites (class/student/session) are
  // validated at operation time via composite FKs + in-handler lookups, not by a
  // gated-module activation edge. Keeping edges here would permanently block
  // activation (foundational data has no ACTIVE InstitutionModule rows).
  attendance: [],
  examinations: ["academic_sessions", "class_course", "student_enrollment"],
  // fees is foundational-not-gated (design §D.9, the attendance/admissions
  // rationale): only its own row must be ENTITLED->ACTIVE. Its real prerequisite
  // is foundational StudentProfile data, which has NO ACTIVE InstitutionModule
  // row — a gated-module edge (the old ["student_management"]) would permanently
  // block activation. Those prerequisites are validated at operation time via
  // composite FKs + in-handler lookups, not by a gated-module activation edge.
  fees: [],
  library: [],
  // admissions is foundational-not-gated (design §6.1): only its own row must be
  // ENTITLED->ACTIVE. Its real prerequisites are foundational Program/Session/
  // StudentProfile data, which have NO ACTIVE InstitutionModule rows — adding
  // gated-module edges would permanently block activation. Those prerequisites are
  // validated at operation time via composite FKs + in-handler lookups, not by a
  // gated-module activation edge.
  admissions: [],
};
