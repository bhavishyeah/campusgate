# Admissions to student handoff

Enrolling an applicant now turns them into a usable student. Before this, `POST /api/admissions/applications/:id/enroll` created the `StudentProfile` but left the person with the `APPLICANT` role only, so they could not use the student portal, fees, exams, library, hostel or transport.

## What enroll does

Everything below happens in one tenant transaction, so there is never a profile without a role or the reverse.

1. Resolves the application's accepted offer, program, department and intake session, and checks the applicant (see Guards).
2. Creates the `StudentProfile` (status `ENROLLED`, semester 1) for the applicant's existing user, with `CREATED` and `ENROLLED` history rows. If the person already has a profile it is linked instead, as before.
3. Adds the `STUDENT` role to the applicant's membership in that institution and increments the membership's `permissionsVersion` (only when the role row is new).
4. Creates the `Enrollment` row, moves the application to `ENROLLED`, writes the audit events (`admissions.application.enrolled`, and `admissions.student.access_granted` when the role was added) and the in-app notification.

After the commit, one email goes out (best effort, see Email). A failed or skipped email never changes the 201 response.

The `APPLICANT` role is kept. The handoff only ever adds `STUDENT`; nothing in this path can remove a role. The kept role means the person can still read their application record and the "You're enrolled" page. The web landing rule sends anyone with the `STUDENT` role to `/student`, so an enrolled applicant lands on the student home.

## Enrollment number

The officer sees a suggested number in the confirm dialog and can edit it. Leaving it unchanged or blank lets the server allocate the number when the request commits, so the number in the dialog is a preview and the real one may differ if another officer enrolled first. The result panel shows the stored number.

- Pattern: `PROGRAMCODE + YYYY + SEQ`, for example `BCA2026001`. The program code is upper-cased with other characters removed and cut to 12 characters (`STU` if nothing is left). `YYYY` is the start year of the campaign's intake session (Asia/Kolkata), or the current year in Asia/Kolkata when no session is known. `SEQ` is zero-padded to 3 digits and widens after 999.
- `StudentProfile.enrollmentNo` is unique across all institutions, so the sequence is global per prefix. Two institutions that both use program code `BCA` share one `BCA2026xxx` sequence, and each will see gaps in its own numbers. This is by design: there is no schema change.
- Generation runs under a Postgres advisory lock keyed by the prefix, so two enrolls with the same prefix cannot pick the same number. The unique index is the final backstop.
- A number typed by the officer is trimmed and checked. If another institution holds it, the answer is the generic 409 "Enrollment number already registered", which does not say who holds it. A number held by a different person in the same institution gets "Enrollment number already assigned to another student".
- When the applicant already has a student record, no number is generated. A supplied number that differs from the existing one is a 409.

## Guards

- The application must be `ACCEPTED` with an `ACCEPTED` offer, and an intake session must resolve (campaign, else the request body), as before.
- The applicant's user must be `ACTIVE`, have the legacy role `STUDENT`, and have a membership that is not `SUSPENDED`. Otherwise the answer is 409 "Applicant account cannot be enrolled as a student"; the specific reason goes only into the audit record. This stops an application created for a staff account from turning that account into a student.
- If the applicant already has a profile in `SUSPENDED`, `WITHDRAWN` or `GRADUATED` status, enroll is refused with 409 "Existing student record is not in a state that allows enrollment", and the real status is written to the audit record. `ENROLLED`, `ACTIVE` and `ON_LEAVE` are allowed.
- A unique violation (number, profile or enrollment race) rolls the whole transaction back. The 409 is returned and the DENIED audit is written afterwards.

No new permission key was added. All three endpoints use `admissions.enroll` plus the admissions module gate. The role to grant is a literal `STUDENT` inside `grantStudentRole`; nothing in the request body can choose a role or a user.

## Endpoints

| Endpoint | Permission | Purpose |
|----------|------------|---------|
| `POST /api/admissions/applications/:id/enroll` | `admissions.enroll` | Enroll. Body: optional `enrollmentNo`, optional `academicSessionId`. Returns `enrollment`, `studentProfileId`, `enrollmentNo`, `created`, `roleGranted`, `accountSetup`, `email`. |
| `GET /api/admissions/applications/:id/enroll-preview` | `admissions.enroll` | Read-only. Same guards and messages as enroll, no audit, no writes. Returns the suggested number, the student's name, program, department and session, whether a profile will be created, whether the applicant has a password, whether email is configured, and `roleMissing` for an `ENROLLED` application. |
| `POST /api/admissions/applications/:id/grant-student-access` | `admissions.enroll` | Repair for an `ENROLLED` application whose applicant lacks the `STUDENT` role (enrolled before this change, or a partial state). Creates no profile, no enrollment and sends no email. 409 if the role is already there. |
| `POST /api/auth/refresh` | any signed-in user | Re-signs the current claims. See Sessions. |

Applications enrolled before this change have no `STUDENT` role. On the staff application page a "Grant student access" button appears for such an application (visible to `admissions.enroll` holders). Use it once per applicant.

`GET /api/admissions/applications/:id` now returns `enrollment: { studentProfileId }` to staff, so the page can link to the student record.

## Email

One email is sent after the commit.

| Applicant | What is sent | Counted against the daily budget |
|-----------|--------------|----------------------------------|
| No password yet (imported or officer-created) | "Activate your account, you're enrolled - {Institution}" with a 72 hour activation link (the normal activation token) | Yes, like any invite |
| Has a password | "You're enrolled - {Institution}" with a sign-in link, no token | No. It is skipped when fewer than 20 invites remain in the rolling 24 h window, so a bulk enroll cannot use up the budget needed for activation invites and password resets |

With email unconfigured, enrollment still succeeds and the response says `email: "SKIPPED_NOT_CONFIGURED"`. A provider failure gives `FAILED`; a budget skip gives `SKIPPED_BUDGET`. In both cases the officer is told to use Resend invite on the Users page, which now accepts students whose profile is `ENROLLED` (single invite only; bulk invites and "not activated" counts still use `ACTIVE` students). Forgot password also activates a passwordless `ENROLLED` student. Both emails follow the other templates: plain, escaped, no images, no tracking.

## Sessions after a role change

The API reads roles from the database on every request, so the new role works on the very next request. The web app decoded the token once at login, so its menu and route guards would have stayed stale. Two pieces fix that:

- When a token's `permissionsVersion` is behind the membership, the API adds the response header `x-session-stale: 1` (exposed through CORS).
- The web client then calls `POST /api/auth/refresh` once (at most every 30 seconds, never for `/api/auth/*` calls). The endpoint signs a new token with the current roles and permissions, the same `jti` and an expiry that is never later than the old token's or the session row's. It does not extend the session. A failed refresh is ignored; the next 401 logs the user out as before. The endpoint is limited to 30 calls per minute per user.

A body-less POST that declares `application/json` is rejected by Fastify, so the web client sends `{}` to `refresh` and `grant-student-access`. (`POST /api/auth/sessions/revoke-all` from the student profile page is sent without a body and is affected by the same rule. That is outside this change.)

## Limits and known gaps

- The enrollment number sequence is shared by program code and year across institutions, so numbers inside one institution are not gap-free.
- There is no un-enroll or role revocation. `ENROLLED` to `ACTIVE` activation is still a manual SIS step.
- The first enroll for a passwordless applicant needs Brevo configured for the applicant to receive an activation link; otherwise use the admin invite flow later.
