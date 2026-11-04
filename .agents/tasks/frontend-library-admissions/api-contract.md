# API contract: Library + Admissions UI (ground truth)

Source of truth read at HEAD 15c9ddd: `apps/api/src/routes/library.ts`, `admissions.ts`, `auth.ts` (claims), `server.ts`, `packages/shared/src/{permissions,modules,validation}.ts`, `apps/api/src/services/{admissions-state,library-policy}.ts`, seed.

## Prefixes and gating
- Library: `/api/library` (server.ts). Every route: `authenticate` + `requirePermission(key)` + `requireModuleActive("library")`.
- Admissions: `/api/admissions`. Authenticated routes: `authenticate` + `requireModuleActive("admissions")` (+ permission). The ONE public route is `POST /api/admissions/register` (no auth, tenant `institutionId` in body, module gate read via privileged client).
- Module keys: `library`, `admissions` (both `ModuleKey`). Both are foundational-not-gated in the dependency graph (no deps).
- Module-inactive signal: 403 with `error` starting `Module not active` (probe in `useModuleActive` already keys on this).
- Error body shape everywhere: `{ error: string | zodFlatten }`. 400 = zod flatten, 404 not found, 409 conflict (message string), 422 unprocessable (message string).
- Pagination: `{ <items>, total, page, pageSize }` for `/titles`, `/catalogue`, admissions `/campaigns`, `/applications` (admissions pageSize max 100, default 20; library pageSize max 100, default 20).

## Permission keys (exact)
Library: `library.books.view`, `library.books.manage`, `library.issue`, `library.return`, `library.reservations.manage`, `library.fines.manage`, `library.view_own`.
Admissions: `admissions.campaigns.manage`, `admissions.applications.view`, `admissions.applications.manage`, `admissions.applications.review`, `admissions.offers.manage`, `admissions.enroll`, `admissions.view_own`.

## ROLE_PERMISSIONS (relevant subset)
- LIBRARIAN: `library.books.view, library.books.manage, library.issue, library.return, library.reservations.manage, library.fines.manage, documents.download`. Nothing else (no students.*, no academics.*).
- ADMISSION_OFFICER: `admissions.campaigns.manage, applications.view, applications.manage, applications.review, offers.manage, enroll, documents.download`. No academics.*, no students.*.
- APPLICANT: `admissions.view_own` ONLY.
- STUDENT: includes `library.view_own`, `academics.view`, `students.view_own`; NO `admissions.*`.
- ADMIN: all six library staff keys (no `library.view_own`), all six admissions staff keys (no `admissions.view_own`), `academics.sessions.manage`, `academics.programs.manage`, `students.view`, `classes.*`. ADMIN has no `*.view_own` for library/admissions.
- Seeded users: librarian (see seed), `admissions@demo.edu / officer123` (ADMISSION_OFFICER), `applicant@demo.edu / applicant123` (legacy `User.role=STUDENT`, membership role APPLICANT, NO StudentProfile), student `bhavishya@demo.edu`.

## How lib/landing.ts reads roles
`landingRoute(roles: string[], permissions: string[])`. `roles` is the JWT `roles[]` = sorted membership role KEYS (auth.ts line ~154: `membership.roles.map(mr => mr.role.key)`), NOT the legacy `User.role` enum. So the seeded applicant has `roles=["APPLICANT"]`, and `roles.includes("STUDENT")` is false: the applicant is NOT sent to `/student`. Order is SUPER_ADMIN, STUDENT, HOD, GUARD, ADMIN, then permission landings (STAFF_FEES -> `/fees`, `fees.view_own` -> `/fees/me`), else `/app`. Permissions are plain strings there. Planned extension (after the fees checks, so ACCOUNTANT/fees users are unchanged): `library.books.view|issue|return|books.manage` -> `/library`; `admissions.applications.view|campaigns.manage` -> `/admissions`; `admissions.view_own` -> `/admissions/my`. Tests to add in `apps/web/src/lib/__tests__/landing.test.ts`: LIBRARIAN, ADMISSION_OFFICER, APPLICANT (roles `["APPLICANT"]`, perms `["admissions.view_own"]`), STUDENT with `library.view_own` still `/student`, ADMIN with library+admissions staff keys still `/admin`.

## LIBRARY endpoints (`/api/library`)

Staff catalogue
- `POST /titles` (`library.books.manage`) body `createBookTitleSchema` {title, author, publisher?, isbn?, category?, edition?, publicationYear?}. 201 `{ title, possibleDuplicate: {id,title}|null }`. ISBN normalised to digits; not 10/13 digits -> 400 `isbn must be 10 or 13 digits`.
- `PATCH /titles/:id` (`books.manage`) body `patchBookTitleSchema` (strict, nullish clears). 200 title; 404; 409 `title withdrawn`.
- `GET /titles?q&category&page&pageSize` (`library.books.view`) -> `{ titles:[{...BookTitle, availableCopies}], total, page, pageSize }`. Search matches title/author (insensitive) and isbn (contains). Includes non-ACTIVE titles.
- `GET /titles/:id` (`library.books.view`) -> title + `copies[]` (ordered by accessionNumber) + `availableCopies`.
- `POST /titles/:titleId/copies` (`books.manage`) body {accessionNumber, shelfLocation?, condition?(NEW|GOOD|FAIR|POOR|DAMAGED), acquiredAt?}. 201 copy; 409 `accession number already exists` | `title withdrawn`.
- `PATCH /copies/:id` (`books.manage`) {shelfLocation?, condition?, acquiredAt?} strict. Never status.
- `POST /copies/:id/withdraw` (`books.manage`) no body; 409 `copy has an active loan`. Status flip to WITHDRAWN.
- `POST /copies/:id/damaged` (`books.manage`) {note?}; 409 `copy is on an active loan`. Sets DAMAGED.
- Copy status values seen: AVAILABLE, ISSUED, RESERVED, LOST, DAMAGED, WITHDRAWN. Title status: ACTIVE, WITHDRAWN. Copy fields: id, accessionNumber, shelfLocation, condition, status, acquiredAt, bookTitleId.

Circulation (librarian)
- `POST /loans` (`library.issue`) body {bookCopyId, studentId} (studentId = StudentProfile.id). 201 loan {id, bookCopyId, studentId, issueDate, dueDate, status ACTIVE, renewalCount, issuedByUserId}. 404 `student not found`. 409 messages: `borrowing limit reached`, `copy not available` (race loser / not AVAILABLE). Only an AVAILABLE copy can be issued at the desk. Auto-fulfils the student's own PENDING reservation on that title.
- `POST /loans/:id/return` (`library.return`) body `{}` strict. 200 `{loanId, overdueDays, fineId|null}`. 409 `loan not active`. Auto-creates an OVERDUE fine only if policy `finesEnabled`. Parks copy RESERVED if a PENDING hold exists, else AVAILABLE.
- `POST /loans/:id/renew` (`library.return`) body `{}` strict. 200 loan. 409 `title has a pending reservation` | `loan not renewable` (not ACTIVE or at renewal cap). Note: renew only works on ACTIVE, not OVERDUE.
- `POST /loans/:id/lost` (`library.return`) {note?}. 200 `{loanId, fineId|null}`. 409 `loan not active`.
- Loan statuses: ACTIVE, OVERDUE, RETURNED, LOST. "Overdue" is also derivable as dueDate < now while ACTIVE.
- Policy (server-side only, InstitutionModule.settings, NOT exposed by any GET): loanPeriodDays 14, maxActiveLoansPerStudent 3, maxRenewals 2, finesEnabled false, overdueFinePerDay, lostFineAmount, reservationExpiryDays 7.
- `POST /overdue/remind` (`library.books.view`, MUTATING sweep: flips overdue ACTIVE->OVERDUE, expires stale FULFILLED reservations, sends notifications) -> `{overdueCount, reminded}`. It is not a list endpoint; label it for what it does.

Reservations
- `POST /reservations` (`library.view_own`) body {bookTitleId}; needs caller StudentProfile. 201 reservation {id, bookTitleId, studentId, queuePosition, status PENDING, reservedAt}. 404 `student not found`|`title not found`; 409 `title withdrawn` | `copy available - borrow instead` | `reservation already pending`.
- `POST /reservations/:id/cancel` (`library.view_own`) {reason?}. Own PENDING only; 409 `reservation not pending`.
- `POST /reservations/:id/fulfil` (`library.reservations.manage`) body {bookCopyId}: parks a copy for the FIFO head (status PENDING->FULFILLED, copy->RESERVED). 409 `not the head of the queue` | `reservation not pending` | `copy not available`.
- `POST /reservations/:id/collect` (`reservations.manage`) body `{}`: issues the parked copy as a loan (201 loan). 409 `reservation not ready to collect` | `borrowing limit reached` | `copy not available`.
- `POST /reservations/:id/cancel-hold` (`reservations.manage`) {reason?}: cancels PENDING or FULFILLED (releases parked copy).
- Reservation statuses: PENDING, FULFILLED, CANCELLED, EXPIRED (and collected = loan created; reservation stays FULFILLED).

Fines (any API support exists, so UI may show it)
- `GET /fines?status=PENDING|PAID|WAIVED` (`library.fines.manage`) -> `{ fines: [...] }` (no pagination, no student name).
- `POST /fines` (`fines.manage`) {studentId, libraryLoanId?, reason OVERDUE|LOST|DAMAGED, amount (number >= 0), note?}. 201.
- `POST /fines/:id/waive` | `/pay` (`fines.manage`) {note?}.
- MONEY NOTE: library fine `amount` is a Prisma Decimal in major units (rupees), serialised by Fastify as a decimal string; request `amount` is a JSON number. This is NOT the paise-string convention of Fees. If the UI shows fines, format via a display-only decimal helper and do not use paise `lib/money.ts` on it; the designer must decide (flag to orchestrator).
- `GET /me/fines` (`library.view_own`) -> `{fines}`.

Student self-service (`library.view_own`; all `/me/*` need a StudentProfile, else 404 `student not found`)
- `GET /catalogue?q&category&page&pageSize` -> ACTIVE titles only: {id,title,author,publisher,isbn,category,edition,publicationYear,availableCopies}.
- `GET /me/loans` -> `{loans}` ACTIVE+OVERDUE, ordered by dueDate, each with `bookCopy.bookTitle{title,author}`.
- `GET /me/loans/history` -> `{loans}` RETURNED+LOST.
- `GET /me/reservations` -> `{reservations}` with `bookTitle{title,author}`, `queuePosition`, `status`.
- No student title-detail/copies endpoint (titles/:id needs `library.books.view`).

Reports (`library.books.view`)
- `GET /reports/summary` -> {totalTitles, totalCopies, copiesByStatus{}, activeLoans, overdueLoans, pendingReservations, outstandingFinesTotal (string)}.
- `GET /reports/circulation?from&to` -> {from,to,issued,returned}.

## ADMISSIONS endpoints (`/api/admissions`)

Public
- `POST /register` body `admissionRegisterSchema` {institutionId, email, password>=8, name 2..200} strict. 201 `{ applicant:{id,email,name} }`. 404 institution not found; 403 institution not active / module not active; 409 `email already registered`; 422 `applicant role not provisioned`. Creates User + ACTIVE membership + APPLICANT role, no StudentProfile. The web `/register` page calls `/api/auth/register` (student flow), a different endpoint; it does not know `institutionId`. Do not touch it.

Campaigns
- `POST /campaigns` (`admissions.campaigns.manage`) body `createCampaignSchema` {name, status? DRAFT|OPEN|CLOSED, intakeSessionId?, targetProgramId?, programIds?[], openAt?, closeAt? (ISO datetime), config?{requiredFields[], requiredDocTypes[]}} strict; openAt <= closeAt. 201 campaign. 404 `intake session not found`|`target program not found`; 422 `one or more programIds do not resolve`; 409 `campaign name already exists`.
- `PATCH /campaigns/:id` (`campaigns.manage`) `updateCampaignSchema`. Open/close is a plain `status` flip (DRAFT->OPEN->CLOSED, no transition validation, no seats concept). `programIds` replaces the join set.
- `GET /campaigns?page&pageSize` and `GET /campaigns/:id` (`admissions.applications.view`) -> campaign + `programs:[{programId}]` (IDs only, no names). Campaign fields: id, name, status, intakeSessionId, targetProgramId, openAt, closeAt, config, createdAt.
- NO `seats` field and no seat/capacity logic anywhere. The brief's "seats" must not be invented.

Applications (staff reads)
- `GET /applications?status&campaignId&page&pageSize` (`applications.view`) -> `{applications, total, page, pageSize}`; items are bare Application rows (id, applicationNumber, campaignId, applicantUserId, programId, status, formData, submittedAt, interviewAt, rejectedAt, withdrawnAt, createdAt). No applicant name or email field (name lives in `formData.name|fullName`).
- `GET /applications/:id` (no `requirePermission`; inline: `applications.view` sees any, `view_own` sees only own; else 403 `Forbidden: missing permission admissions.applications.view`) -> application + `documents[]` + `offers[]` (+ `reviews[]` for staff only). Document: id, docType, reference, fileName, contentType, verified, verifiedAt. Offer: id, offeredProgramId, status ISSUED|ACCEPTED|DECLINED|EXPIRED, offeredAt, expiresAt, acceptedAt. Review: id, reviewerUserId, decision, notes, reviewedAt.
- `GET /applications/mine` (`admissions.view_own`) -> `{ applications: [...with offers] }`.

Application lifecycle (`LEGAL_TRANSITIONS`, forward-only with a few return edges)
- DRAFT -> SUBMITTED | WITHDRAWN
- SUBMITTED -> UNDER_REVIEW | DOCUMENTS_REQUIRED | REJECTED | WITHDRAWN
- UNDER_REVIEW -> DOCUMENTS_REQUIRED | ELIGIBLE | REJECTED | WITHDRAWN
- DOCUMENTS_REQUIRED -> UNDER_REVIEW | REJECTED | WITHDRAWN
- ELIGIBLE -> UNDER_REVIEW | SHORTLISTED | OFFERED | REJECTED | WITHDRAWN
- SHORTLISTED -> OFFERED | REJECTED | WITHDRAWN
- OFFERED -> ACCEPTED | ELIGIBLE | SHORTLISTED | REJECTED | WITHDRAWN
- ACCEPTED -> ENROLLED | REJECTED | WITHDRAWN
- ENROLLED, REJECTED, WITHDRAWN terminal.
- There is NO "waitlist" status and NO "approve" status. Allowed staff labels must map to real statuses: Shortlist (->SHORTLISTED), Reject (->REJECTED), Mark under review, Request documents (->DOCUMENTS_REQUIRED), Mark eligible. Do not build Approve or Waitlist.
- `PATCH /applications/:id/status` (`admissions.applications.manage`) body {status, reason?}. Server REFUSES target ACCEPTED (only offer-accept sets it) and ENROLLED (only enroll sets it) with 409; illegal hop -> 409 `Illegal application transition: A -> B`. Sets rejectedAt on REJECTED; notifies applicant.
- `POST /applications/:id/interview` (`applications.manage`) {interviewAt ISO datetime}. Sets the field only; no status change.
- `POST /applications/:id/documents/:docId/verify` (`applications.manage`) -> document verified=true.
- `POST /applications/:id/reviews` (`admissions.applications.review`) {decision RECOMMEND_ELIGIBLE|RECOMMEND_REJECT|REQUEST_DOCUMENTS|SHORTLIST|NOTE, notes?}. APPEND-ONLY note/decision record; it does NOT change application status (status changes only via PATCH /status). 409 `application is in a terminal state`. Label as "Record review", not "Approve".
- `POST /applications` (self-service `admissions.view_own`, or officer-on-behalf `admissions.applications.manage` with applicantEmail/applicantName) body {campaignId, programId, formData?, applicantEmail?, applicantName?} strict. Creates a DRAFT (applicationNumber auto). 404 campaign not found; 409 `campaign is not open` | `an application already exists for this campaign` (one per applicant per campaign); 422 `program is not offered by this campaign`.
- `POST /applications/:id/submit` (`view_own`, own only) body `{}`: DRAFT->SUBMITTED. 422 `Missing required field: <key>` / `Missing required document: <docType>` / `campaign is not open`; 409 illegal transition. NOTE: `formData` can only be set at create (POST /applications); there is NO endpoint to edit formData or update a draft afterwards. Required fields are checked against formData keys.
- `POST /applications/:id/withdraw` (`view_own`, own) {reason?}.
- `POST /applications/:id/documents` (`view_own`, own) body {docType, reference, fileName?, contentType?}. A document is a METADATA reference string (URL/ref), NOT a file upload. docType must be in campaign `requiredDocTypes` when that list is non-empty, else 422 `docType not allowed for this campaign`. No list-documents endpoint other than the application detail; no delete.
- Offers: `POST /applications/:id/offers` (`admissions.offers.manage`) {offeredProgramId, expiresAt? future ISO}; app must be ELIGIBLE or SHORTLISTED (409), program must be in campaign (422), 409 live offer exists. Moves app to OFFERED. `POST /offers/:id/expire` (`offers.manage`, body `{}`): offer EXPIRED, app->ELIGIBLE. `POST /offers/:id/accept` (`view_own`, own, body `{}`): offer ACCEPTED, app ACCEPTED. `POST /offers/:id/decline` (`view_own`, own) {reason?}: offer DECLINED, app->ELIGIBLE. 403 `not your offer`, 409 `offer is not open`.
- Enroll: `POST /applications/:id/enroll` (`admissions.enroll`) body {enrollmentNo, academicSessionId?}. Requires status ACCEPTED + ACCEPTED offer. 201 `{ enrollment, studentProfileId, created:boolean }`. 409 messages: `Application already enrolled`, `application is not in ACCEPTED state`, `no accepted offer for this application`, `a student profile already exists for this identity`, and the cross-person identity message (`CROSS_PERSON_MESSAGE` in admissions-enroll.ts: enrollmentNo or userId matches a different person). 422 `No intake session: campaign has no intakeSessionId and none supplied` / `academicSessionId does not resolve` / `offered program no longer exists`. Enroll creates the StudentProfile (or links/flips an existing APPLICANT-status one). It does NOT add a STUDENT membership role (see gap G8).

## Academics lookups the screens need (existing endpoints)
- Programs list: `GET /api/admin/academic/programs` requires `academics.programs.manage`. Sessions list: `GET /api/admin/academic/sessions` requires `academics.sessions.manage`. Existing hooks live in `features/academics/hooks.ts`.
- Student lookup: `GET /api/students?...` requires `students.view` (hook `features/sis`).

## Module probe paths to add in useModuleActive.ts
- `library`: `library.books.view` -> `/api/library/titles?pageSize=1`; else `library.view_own` -> `/api/library/catalogue?pageSize=1`. (Probes that return 404 student-not-found are fine; only a 403 `Module not active` hides nav. Prefer `/catalogue`, which has no StudentProfile dependency.)
- `admissions`: `admissions.applications.view` -> `/api/admissions/campaigns?pageSize=1`; else `admissions.view_own` -> `/api/admissions/applications/mine`.

## NEW ENDPOINTS (backend fixes G1-G6, added in the setup step)
All are tenant-scoped (`institutionId` from the token via `withTenant`), module-gated, and reuse existing permission keys only (no new permissions, no migrations, no new audit keys).

### Library (`/api/library`)
- `GET /loans?status=ACTIVE|OVERDUE|RETURNED|LOST&overdue=true|false&studentId=&page=&pageSize=` (`library.books.view`) -> `{ loans, total, page, pageSize }`. Each loan = LibraryLoan row (id, bookCopyId, studentId, issuedByUserId, issueDate, dueDate, returnDate, renewalCount, status) plus `student: {id, name, enrollmentNo, program}`, `bookCopy: {id, accessionNumber, bookTitle: {id, title, author}}` and a derived `isOverdue` boolean (open loan, not returned, past due). `overdue=true` = status in (ACTIVE, OVERDUE), `returnDate` null, `dueDate < now`, ordered by dueDate ascending; closed/other lists are ordered by issueDate descending. pageSize max 100, default 20. 400 on a bad status/page.
- `GET /reservations?status=PENDING|FULFILLED|CANCELLED|EXPIRED&bookTitleId=&page=&pageSize=` (`library.books.view`) -> `{ reservations, total, page, pageSize }`. Each = BookReservation (id, bookTitleId, studentId, reservedAt, queuePosition, status, fulfilledByCopyId, fulfilledAt, cancelledAt, expiredAt) plus `student: {id,name,enrollmentNo,program}`, `bookTitle: {id,title,author}`, `fulfilledByCopy: {id, accessionNumber} | null`. Ordered oldest first for PENDING/FULFILLED/unfiltered, newest first otherwise. The row actions `fulfil` / `collect` / `cancel-hold` still need `library.reservations.manage` (LIBRARIAN and ADMIN hold it).
- `GET /students/lookup?q=&limit=` (`library.issue`) -> `{ students: [{ id, name, enrollmentNo, program }] }`. `q` required, 2..100 chars (400 otherwise); `limit` 1..25 default 10; matches name or enrollmentNo, case-insensitive contains; excludes StudentProfile status APPLICANT; ordered by name. `id` is the StudentProfile id to send as `studentId` in `POST /loans`. LIBRARIAN does NOT gain `students.view`.

### Admissions (`/api/admissions`)
- `GET /lookups` (`admissions.campaigns.manage`) -> `{ programs: [{id,name,code}] (ACTIVE only), sessions: [{id,name,status}] }`. Read-only, tenant-scoped. Use for the campaign form (program multi-select, intake session) and the offer program picker. ADMISSION_OFFICER does NOT gain `academics.*`.
- `GET /campaigns` and `GET /campaigns/:id` (`admissions.applications.view`) now ALSO return `programs: [{ programId, program: {id,name,code} }]`, `intakeSession: {id,name} | null`, `targetProgram: {id,name,code} | null` (existing fields unchanged).
- `GET /campaigns/open?page=&pageSize=` and `GET /campaigns/open/:id` (`admissions.view_own`) -> OPEN campaigns only (DRAFT/CLOSED are never returned; detail of a non-OPEN or foreign campaign is 404 `open campaign not found`). Shape: `{ id, name, openAt, closeAt, programs: [{id,name,code}], config: { requiredFields: string[], requiredDocTypes: string[] } }` and nothing else. `programs` = target program plus the join-table programs, deduped, sorted by name; this is the exact set `POST /applications` validates `programId` against. List response: `{ campaigns, total, page, pageSize }`; detail returns the bare object. Note: the server only checks `status === "OPEN"` when applying; `openAt`/`closeAt` are display data (the UI may show them but must rely on the server's 409 `campaign is not open`).
- `GET /applications/mine` now also returns on each application `campaign: {id,name}` and `program: {id,name,code}` (offers array unchanged). `GET /applications` (staff list) and `GET /applications/:id` also include `campaign: {id,name}` and `program: {id,name,code}`.
- `PATCH /applications/:id` (`admissions.view_own`, own application only) body `{ formData: Record<string, unknown> }` strict (extra keys -> 400). REPLACES the whole `formData` (send the full object). 200 returns the updated application. 404 `application not found` (also for someone else's). 409 `only a DRAFT application can be edited` if status is not DRAFT (including a concurrent submit). Staff roles (no `view_own`) get 403. Audited (reuses `admissions.application.status_changed` with `draftEdited: true`).
- Applicant flow is now: `GET /campaigns/open` -> pick campaign + program -> render `config.requiredFields` fields -> `POST /applications` {campaignId, programId, formData} (DRAFT) -> optional `PATCH /applications/:id` -> `POST /applications/:id/documents` {docType, reference...} -> `POST /applications/:id/submit`.

## ROLE-CAPABILITY MATRIX (after backend fixes)
Legend: every row lists the endpoints the screen calls; "Holds" is checked against `ROLE_PERMISSIONS`. All rows OK.

### LIBRARIAN (holds books.view, books.manage, issue, return, reservations.manage, fines.manage)
| Screen | Endpoints | Keys needed | Result |
|---|---|---|---|
| Catalogue list/search | GET /titles | books.view | OK |
| Title detail + copies | GET /titles/:id | books.view | OK |
| Create/edit title; add/edit/withdraw/damage copy | POST/PATCH /titles, /titles/:id/copies, /copies/:id... | books.view (to render) + books.manage (write) | OK |
| Issue a copy | GET /students/lookup, GET /titles/:id (pick copy), POST /loans | library.issue + books.view | OK |
| Active loans / Overdue lists | GET /loans | books.view | OK |
| Return / renew / mark lost | GET /loans (list), POST /loans/:id/return, /renew, /lost | books.view + library.return | OK |
| Reservation queue; fulfil / collect / cancel-hold | GET /reservations, GET /titles/:id (copies for fulfil), POST /reservations/:id/fulfil, /collect, /cancel-hold | books.view + reservations.manage | OK |
| Fines (list, create, waive, mark paid) | GET /fines, POST /fines, /fines/:id/waive, /pay; student picker GET /students/lookup needs library.issue (held) | fines.manage (+ library.issue for the picker) | OK |
| Dashboard / overdue sweep | GET /reports/summary, /reports/circulation, POST /overdue/remind | books.view | OK |

### ADMIN (library staff) holds the same six library keys
Same screens as LIBRARIAN, all OK. ADMIN also holds `students.view`, but the UI should use `/students/lookup` for both roles (single code path).

### STUDENT (holds library.view_own; needs a StudentProfile)
| Screen | Endpoints | Keys | Result |
|---|---|---|---|
| Catalogue search | GET /catalogue | view_own | OK |
| Reserve / cancel own | POST /reservations, POST /reservations/:id/cancel | view_own | OK |
| My loans / loan history / reservations / fines | GET /me/loans, /me/loans/history, /me/reservations, /me/fines | view_own | OK |

### ADMISSION_OFFICER (holds campaigns.manage, applications.view, applications.manage, applications.review, offers.manage, enroll)
| Screen | Endpoints | Keys needed | Result |
|---|---|---|---|
| Campaign list / detail | GET /campaigns, /campaigns/:id | applications.view | OK |
| Create / edit / open / close campaign | GET /lookups, POST/PATCH /campaigns | campaigns.manage (lookups + write) + applications.view (re-read) | OK |
| Applications queue (filter campaign/status) | GET /applications (needs campaign names: included) | applications.view | OK |
| Application detail (form data, documents, reviews, offers) | GET /applications/:id | applications.view | OK |
| Status actions (under review, docs required, eligible, shortlist, reject) | PATCH /applications/:id/status | applications.manage | OK |
| Interview, verify document | POST /applications/:id/interview, /documents/:docId/verify | applications.manage | OK |
| Record review | POST /applications/:id/reviews | applications.review | OK |
| Issue / expire offer | GET /lookups or campaign.programs (program names), POST /applications/:id/offers, POST /offers/:id/expire | offers.manage + campaigns.manage/applications.view | OK |
| Enroll accepted applicant | POST /applications/:id/enroll | admissions.enroll | OK |
| Officer-on-behalf application | POST /applications | applications.manage | OK |

### ADMIN (admissions staff) holds the same six admissions keys (plus academics.*)
Same screens as ADMISSION_OFFICER, all OK.

### APPLICANT (holds admissions.view_own only)
| Screen | Endpoints | Keys | Result |
|---|---|---|---|
| Open campaigns list/detail (what to apply to) | GET /campaigns/open, /campaigns/open/:id | view_own | OK |
| Apply (create DRAFT) | POST /applications | view_own | OK |
| Edit DRAFT | PATCH /applications/:id | view_own | OK |
| My applications / status timeline / offers | GET /applications/mine, GET /applications/:id | view_own | OK |
| Add document reference | POST /applications/:id/documents | view_own | OK |
| Submit / withdraw | POST /applications/:id/submit, /withdraw | view_own | OK |
| Accept / decline offer | POST /offers/:id/accept, /decline | view_own | OK |

Probes: library staff `GET /api/library/titles?pageSize=1`, library student `GET /api/library/catalogue?pageSize=1`; admissions staff `GET /api/admissions/campaigns?pageSize=1`, applicant `GET /api/admissions/campaigns/open?pageSize=1`.

## BACKEND GAPS
Status: G1-G6 FIXED in the backend (this setup step, same commit as the contract). No open mismatches remain for any intended screen/role.

- G1 FIXED: `GET /api/library/loans` (see New Endpoints).
- G2 FIXED: `GET /api/library/reservations`.
- G3 FIXED: `GET /api/library/students/lookup` (gated by `library.issue`; LIBRARIAN still has no `students.view`).
- G4 FIXED: `GET /api/admissions/lookups` (gated by `admissions.campaigns.manage`) and program/session names on campaign reads.
- G5 FIXED: `GET /api/admissions/campaigns/open` and `/open/:id` (gated by `admissions.view_own`), campaign/program names on `/applications/mine`.
- G6 FIXED: `PATCH /api/admissions/applications/:id` (DRAFT-only, owner-only).

## KNOWN LIMITATIONS (accepted; UI must be honest about them)
- G7 Documents are references (URL/ref string + optional fileName/contentType), not file uploads. Label them "Document link / reference". No list endpoint other than the application detail; no delete.
- G8 (out of scope, left as is) Enrolling creates/links a StudentProfile but does NOT add a STUDENT membership role. After enrollment the user's JWT roles stay `["APPLICANT"]` and permissions `["admissions.view_own"]`, so they get no student pages (no fees/library/etc.). UI shows an "Enrolled" state and must not promise student access.
- Library fines money: `amount` is a rupee Decimal string (e.g. "12.50"), request `amount` is a JSON number. Do NOT convert via paise `lib/money.ts`. Display with a rupee decimal formatter; send the typed number.
- Library policy (loan period, max loans, renewal cap, fines enabled) is not exposed by any GET. The UI cannot pre-validate limits; it surfaces the server's 409 messages (`borrowing limit reached`, `copy not available`, `title has a pending reservation`, `loan not renewable`).
- Renew works only on ACTIVE loans (not OVERDUE-status rows); the server's 409 `loan not renewable` is the message.
- No seats / capacity, no waitlist or "approve" status; open/close is a plain campaign `status` flip. Review decisions are append-only notes; status changes only via PATCH /status.
- Staff `GET /applications` has no applicant name/email field (only `formData.name|fullName` when present); show application number + that name, falling back to the id. Library fines list has no student name.
- The public `POST /api/admissions/register` needs an `institutionId`; the web `/register` page (student flow) does not know it. No applicant self-registration UI is planned unless the orchestrator supplies a tenant selector.

## Orchestrator decision
G1-G6: fix in the backend now, before design, least privilege (existing keys only, no migrations), tenant-scoped, with fast + live tests. Done in this step. G8 out of scope (recorded above). Fine amounts stay rupee Decimal strings.

## Verification record (backend step)
- `npx tsc --noEmit` in apps/api: clean. `npm run build -w @campusgate/shared`: clean.
- apps/api fast suite `npx vitest run`: 62 files, 720 tests passed (baseline 692; +28 new in `library-staff-reads.test.ts` and `admissions-applicant-reads.test.ts`).
- Live suites in isolation: `library-behavioral.integration.test.ts` 15 passed (3 new: loans, reservations, student lookup, incl. tenant B isolation and role/module denial); `admissions-behavioral.integration.test.ts` 18 passed (3 new: lookups, open campaigns + enriched reads, draft edit).