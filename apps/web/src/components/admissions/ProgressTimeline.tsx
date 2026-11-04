import type { Application, ApplicationStatus } from "@/features/admissions/types";
import { applicationStatusLabel } from "@/features/admissions/labels";

const MAIN_PATH: ApplicationStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "ELIGIBLE",
  "SHORTLISTED",
  "OFFERED",
  "ACCEPTED",
  "ENROLLED",
];
const SIDE: ApplicationStatus[] = ["DOCUMENTS_REQUIRED", "REJECTED", "WITHDRAWN"];

/**
 * Progress of an application. Only REAL timestamps from the API are shown;
 * the applicant API has no status history, so nothing is fabricated.
 */
export function ProgressTimeline({ application }: { application: Application }) {
  const currentIndex = MAIN_PATH.indexOf(application.status);
  const side = SIDE.includes(application.status);

  const dated: { label: string; at: string }[] = [{ label: "Created", at: application.createdAt }];
  if (application.submittedAt) dated.push({ label: "Submitted", at: application.submittedAt });
  if (application.interviewAt) dated.push({ label: "Interview scheduled", at: application.interviewAt });
  for (const o of application.offers ?? []) {
    dated.push({ label: "Offer issued", at: o.offeredAt });
    if (o.acceptedAt) dated.push({ label: "Offer accepted", at: o.acceptedAt });
  }
  if (application.rejectedAt) dated.push({ label: "Rejected", at: application.rejectedAt });
  if (application.withdrawnAt) dated.push({ label: "Withdrawn", at: application.withdrawnAt });

  return (
    <section aria-labelledby="progress-heading" className="space-y-3">
      <h2 id="progress-heading" className="text-lg font-semibold text-gray-900">
        Progress
      </h2>
      {side ? (
        <div role="status" className="bg-warning-50 border border-warning-500 text-warning-600 px-4 py-3 rounded-lg text-sm">
          Current status: {applicationStatusLabel[application.status]}
        </div>
      ) : null}
      <ol className="flex flex-wrap gap-2">
        {MAIN_PATH.map((s, i) => {
          const done = !side && currentIndex >= 0 && i <= currentIndex;
          const current = !side && i === currentIndex;
          return (
            <li
              key={s}
              aria-current={current ? "step" : undefined}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
                current
                  ? "bg-primary-600 text-white border-primary-600"
                  : done
                    ? "bg-primary-50 text-primary-700 border-primary-500"
                    : "bg-gray-50 text-gray-500 border-gray-200"
              }`}
            >
              {applicationStatusLabel[s]}
            </li>
          );
        })}
      </ol>
      <ul className="text-sm text-gray-600 space-y-1">
        {dated.map((d, i) => (
          <li key={`${d.label}-${i}`}>
            {d.label}: {new Date(d.at).toLocaleString()}
          </li>
        ))}
      </ul>
    </section>
  );
}
