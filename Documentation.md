**this is the specification, not the implementation.** The goal is to define exactly what the system must do before you write code.

# CAMPUSGATE

## Digital Campus Entry & Exit Management System

### Product Definition

CAMPUSGATE is a role-based campus movement management platform that digitally replaces the physical student gate-pass workflow.

It manages the complete lifecycle of a student's temporary campus exit:

**Identity → Request → Authorization → Digital Pass → Gate Verification → Exit → Return → Record**

The system consists of four operational interfaces:

1. **Student Application**
2. **HOD Approval Panel**
3. **Guard Gate Panel**
4. **Administrator Panel**

All four interfaces communicate with one centralized backend and database.

The backend is the **single source of truth** for authorization, pass state, student identity, approval records, gate events, and audit history.

---

# 1. CORE OBJECTIVE

The physical process currently depends on:

* paper forms
* handwritten information
* physical signatures
* locating an HOD
* physical pass handling
* manual registers
* manual time recording
* manual verification

CAMPUSGATE removes the physical dependencies while preserving the institutional approval process.

The system must **not simply create a QR code and call it a digital gate pass**.

The QR is only the verification mechanism.

The actual authorization exists on the backend.

That distinction is critical.

---

# 2. SYSTEM ARCHITECTURE

Conceptually:

```text
                    CAMPUSGATE
                         │
                 Central Backend
                         │
          ┌──────────────┼──────────────┐
          │              │              │
      Student          HOD           Guard
      Client           Panel          Panel
          │              │              │
          └──────────────┼──────────────┘
                         │
                    Admin Panel
                         │
                      Database
```

The browser/mobile client must never be trusted to determine whether a student is authorized to leave.

For example, the frontend must not be able to say:

```text
status = approved
```

and expect the gate to accept it.

The backend must independently determine:

> Is this student actually authorized to exit right now?

---

# 3. IDENTITY MODEL

Every person interacting with CAMPUSGATE belongs to a role.

## Student

Student identity contains institutional information such as:

* unique student ID
* enrollment number
* name
* department
* program
* semester/year
* section
* institutional email
* account status

## HOD

Contains:

* user ID
* name
* institutional email
* assigned department
* account status

## Guard

Contains:

* user ID
* name
* assigned gate(s)
* account status

## Administrator

Has system-level management privileges.

---

# 4. AUTHENTICATION

Every role requires authentication.

After login, the backend determines the user's role and permissions.

A student cannot access HOD routes simply by manually changing a URL.

For example:

```text
/student/dashboard
/hod/dashboard
/guard/dashboard
/admin/dashboard
```

The frontend may hide unauthorized navigation, but **the backend must enforce authorization independently.**

A user must never be able to obtain another role's privileges merely by manipulating frontend state.

---

# 5. ROLE-BASED ACCESS CONTROL

CAMPUSGATE uses explicit permissions.

### Student

Own data only.

### HOD

Students belonging to the HOD's authorized department.

### Guard

Gate-related operations.

### Admin

Institution-wide management.

Every protected API request must be evaluated against:

* authenticated user
* role
* resource ownership
* permitted action
* current system state

---

# 6. STUDENT APPLICATION

The student application is the starting point of the workflow.

The dashboard must immediately communicate:

### Current movement state

Examples:

**Inside Campus**

**Pending Approval**

**Gate Pass Approved**

**Currently Outside**

**Overdue**

**No Active Request**

The student should not need to navigate through multiple pages to discover their current status.

---

# 7. STUDENT PROFILE

The student profile displays institutional information.

Example:

```text
Name
Enrollment Number
Program
Department
Semester
Section
Institutional Email
Account Status
```

Most identity fields should be read-only for the student.

This prevents students from changing information that affects authorization.

---

# 8. CREATE GATE PASS REQUEST

The primary student action is:

## Request Gate Pass

The student chooses:

### Exit reason

Configured by the institution.

Examples:

* Personal Work
* Medical
* Family Emergency
* Official Work
* Home Visit
* Other

The institution should be able to configure available reasons.

---

# 9. CUSTOM REASON

If the student chooses:

**Other**

the system displays a required explanation field.

The student must provide a meaningful reason.

The backend validates that the reason exists before accepting the request.

---

# 10. TIME REQUEST

The student specifies:

### Requested exit time

and

### Expected return time

The system calculates the requested duration.

Example:

```text
Exit: 14:30
Expected Return: 16:30

Duration: 2 hours
```

The system must reject logically invalid values.

For example:

```text
Return: 13:00
Exit: 14:30
```

is invalid.

Institution-specific rules can later control:

* maximum duration
* allowed exit hours
* restricted periods

---

# 11. REQUEST REVIEW

Before submission, the student receives a final summary:

```text
Student
Reason
Exit Time
Expected Return
Duration
Approving Authority
```

Then:

## Submit Request

Once submitted, the request becomes immutable in its critical fields unless the system explicitly supports cancellation/recreation.

This prevents a student from modifying:

> “Personal Work, 2:30 PM”

into:

> “Emergency, 5:30 PM”

after approval.

---

# 12. REQUEST IDENTIFIER

Every request receives a unique system identifier.

Example:

```text
CG-2026-000421
```

This identifier is not the security token.

It is a human-readable reference.

Security-sensitive verification must use backend-controlled authorization/token mechanisms.

---

# 13. REQUEST STATUS

A request begins as:

### PENDING

It waits for the authorized HOD.

The student sees:

> Awaiting approval.

The student cannot approve it themselves.

---

# 14. HOD REQUEST QUEUE

The HOD dashboard displays requests requiring action.

Each request should show:

* Student name
* Enrollment number
* Department
* Program
* Reason
* Requested exit
* Expected return
* Request timestamp
* Current status

Requests should be ordered by operational relevance, normally with pending requests first.

---

# 15. HOD REQUEST DETAILS

The HOD opens the request.

The system displays the student's relevant institutional information and requested movement.

The HOD has two primary decisions:

### APPROVE

### REJECT

---

# 16. APPROVAL

When the HOD approves:

The backend records:

* request ID
* approving HOD
* timestamp
* approval status
* approved information
* audit event

The approval must be atomic.

The system must not produce a situation where:

> UI says approved

but:

> database still says pending.

---

# 17. REJECTION

When rejecting, the HOD must provide a reason if configured as mandatory.

The request becomes:

### REJECTED

The student receives the rejection status.

A rejected request must never generate a valid gate authorization.

---

# 18. DIGITAL GATE PASS

An approved request produces a digital pass.

The pass contains human-readable information:

```text
CAMPUSGATE

Student Name
Enrollment Number
Department

Reason

Authorized Exit
Expected Return

Pass ID
Approved By
Approval Time

QR CODE
```

The pass exists only because the backend has authorized the underlying request.

---

# 19. QR AUTHORIZATION MODEL

This is one of the most important technical concepts.

The QR must **not be treated as the authorization itself**.

It should represent a secure reference/token associated with the authorized pass.

Conceptually:

```text
QR
 ↓
Secure Token / Pass Reference
 ↓
Backend
 ↓
Pass Lookup
 ↓
Authorization Validation
 ↓
Verification Result
```

The guard client sends the scanned information to the backend.

The backend determines whether it is valid.

---

# 20. QR VALIDATION

When a guard scans a QR, the backend checks the complete state.

At minimum:

1. Does the token exist?
2. Is it authentic?
3. Is the associated pass valid?
4. Was it approved?
5. Is it revoked?
6. Is it expired?
7. Has the student already exited?
8. Has the student already returned?
9. Is the requested movement currently valid?
10. Is the guard authorized to perform this operation?

Only after successful validation does the system allow the guard to proceed.

---

# 21. GUARD APPLICATION

The guard interface is deliberately operational rather than feature-heavy.

The primary action is:

# SCAN PASS

The guard should not need to navigate through multiple screens during normal gate operations.

---

# 22. QR SCANNING

The guard opens the scanner.

The device camera reads the QR.

The application sends the token to the backend.

The backend returns the verification result.

### Valid

Green verification state.

### Invalid

Red verification state.

### Warning

A distinct warning state for situations such as overdue or already-used authorization.

---

# 23. VALID PASS SCREEN

The guard sees enough information to confidently match the person with the authorization.

Example:

```text
VALID PASS

Bhavishya Verma
BCA
Enrollment: XXXXX

Reason:
Personal Work

Approved by:
HOD — BCA

Expected Return:
4:30 PM

Status:
AUTHORIZED FOR EXIT
```

The guard then sees:

# MARK EXIT

---

# 24. EXIT EVENT

When the guard confirms exit, the backend creates a permanent gate event.

It records:

* pass ID
* student ID
* gate ID
* guard ID
* event type
* timestamp
* verification method

Example:

```text
EXIT
Main Gate
14:31:22
Guard #07
```

The pass state changes to:

### OUTSIDE

---

# 25. RETURN EVENT

When the student returns, the same authorization can be verified again.

The backend recognizes:

> This pass is currently in OUTSIDE state.

The guard performs:

# MARK RETURN

The backend records:

```text
RETURN
Main Gate
16:12:04
Guard #07
```

The movement lifecycle becomes:

### COMPLETED

---

# 26. PASS LIFECYCLE

The system must use explicit states rather than arbitrary status strings.

Core lifecycle:

```text
PENDING
   │
   ├── REJECTED
   │
   └── APPROVED
          │
          └── ACTIVE
                 │
                 └── OUTSIDE
                        │
                        └── COMPLETED
```

Additional terminal/intermediate conditions can include:

```text
CANCELLED
EXPIRED
REVOKED
OVERDUE
```

The backend controls which transitions are legal.

For example:

```text
COMPLETED → APPROVED
```

must be impossible.

---

# 27. OVERDUE LOGIC

Expected return time is not the same thing as actual return.

If:

```text
Expected Return = 16:30
Actual Return = 17:10
```

the system records:

```text
Expected: 16:30
Actual: 17:10
Overdue: 40 minutes
```

The system should not fabricate a return event.

Only a real gate interaction records actual return.

---

# 28. STUDENT ACTIVE PASS

The student's active-pass screen displays the current authorization.

If approved but not exited:

### READY FOR EXIT

If already outside:

### CURRENTLY OUTSIDE

If completed:

### COMPLETED

The QR should not remain indefinitely usable regardless of state.

---

# 29. STUDENT HISTORY

Every student can view their own historical passes.

Each record includes:

* Pass ID
* Reason
* Request time
* Approval status
* Approved time
* Exit time
* Return time
* Gate
* Final status

Students cannot modify historical records.

---

# 30. HOD HISTORY

HODs can review requests within their authorized scope.

Useful information includes:

* approved requests
* rejected requests
* completed movements
* currently outside students
* overdue students

Historical data should remain immutable from the HOD interface.

---

# 31. GUARD ACTIVITY

The guard panel shows operational records relevant to that guard/gate.

Examples:

```text
Today's Exits
Today's Returns
Currently Outside
Recent Scans
```

The guard should not receive unrestricted access to institutional student history.

---

# 32. MULTIPLE GATES

CAMPUSGATE should support multiple physical gates from the beginning at the data-model level.

Each gate has:

* unique ID
* name
* status
* location/description
* assigned guards

A gate event always identifies **which physical gate was used**.

This makes later reporting possible.

---

# 33. ADMINISTRATION

The administrator controls institutional configuration.

Admin can manage:

### Students

### HODs

### Guards

### Departments

### Gates

### Gate-pass rules

### Reasons

### Account status

### System settings

---

# 34. ADMIN STUDENT MANAGEMENT

Admin can:

* create/import student accounts
* edit institutional information
* deactivate accounts
* reactivate accounts
* assign department
* assign academic information

Students should not be able to elevate themselves to HOD/Guard/Admin.

---

# 35. ADMIN HOD MANAGEMENT

Admin can:

* create HOD account
* assign department
* change department
* deactivate account
* reactivate account
* review activity

---

# 36. ADMIN GUARD MANAGEMENT

Admin can:

* create guard account
* assign gates
* change gate assignment
* deactivate account
* review activity

---

# 37. AUDIT LOG

CAMPUSGATE must maintain an audit trail for security-sensitive operations.

Examples:

```text
HOD approved pass
HOD rejected pass
Guard verified QR
Guard marked exit
Guard marked return
Admin changed student
Admin disabled user
Pass revoked
```

Every audit event should identify:

* actor
* action
* target
* timestamp
* relevant context

Audit records should not be editable through normal application interfaces.

---

# 38. DIGITAL SIGNATURE CONCEPT

The physical HOD signature is replaced by a **digitally recorded approval event**.

The system records:

```text
Approved by:
HOD identity

Approval timestamp:
Exact server time

Request:
Specific request ID
```

The important legal/operational question is whether the institution accepts this as its official authorization mechanism.

Technically, CAMPUSGATE can record the approval securely.

Institutional policy determines whether that digital approval is formally sufficient.

---

# 39. NO FAKE “SIGNATURE IMAGE”

A stored PNG of an HOD's handwritten signature should not be considered the security mechanism.

The meaningful authorization is:

> authenticated HOD + explicit approval action + server timestamp + immutable audit record.

That is considerably stronger operationally than simply placing an image of a signature onto a PDF.

---

# 40. NOTIFICATION SYSTEM

The initial notification layer can be internal.

Student:

* request submitted
* approved
* rejected
* overdue
* pass status changed

HOD:

* new pending request
* overdue student

Admin:

* important system events

External SMS, email, WhatsApp, etc. should be treated as separate integrations rather than assumptions inside the core system.

---

# 41. DATA INTEGRITY

Critical records must be server-controlled.

The client cannot decide:

```text
approved = true
exit_time = currentTime
role = admin
```

The backend determines these values.

The frontend requests an operation.

The backend validates and performs it.

---

# 42. CONCURRENCY

This is an important real-world problem.

Imagine two guards scan the same pass at nearly the same time.

Both devices initially see:

> APPROVED

If both are allowed to mark exit, the database could contain duplicate exit events.

Therefore, the backend must perform the state transition safely.

Conceptually:

```text
APPROVED → OUTSIDE
```

must occur as a controlled transaction.

Only one request should successfully perform the transition.

The second request should receive:

> Pass already used / movement already recorded.

---

# 43. DUPLICATE RETURN

Same principle.

Two guards must not be able to mark:

```text
RETURN
RETURN
```

for the same movement.

The backend validates that the current state is actually:

```text
OUTSIDE
```

before transitioning to:

```text
COMPLETED
```

---

# 44. TIME SOURCE

Critical timestamps must come from the server/database environment rather than trusting the student's device clock.

The student's phone saying:

> 4:00 PM

does not mean the official system time is 4:00 PM.

This prevents basic clock manipulation.

---

# 45. QR EXPIRATION

A QR authorization must have a controlled validity period.

An old screenshot should not become a permanent pass.

The backend should validate the pass's current status and authorization window.

A screenshot of a completed or expired pass must not authorize a new exit.

---

# 46. SCREENSHOT PROBLEM

A student can technically screenshot their QR.

That isn't automatically a vulnerability if the QR is:

* time-bound where appropriate
* state-bound
* server-validated
* invalidated after completion/revocation
* associated with a specific authorized pass

The QR should therefore be treated as a **bearer credential**, and its lifecycle must be carefully controlled.

---

# 47. MANUAL VERIFICATION FALLBACK

QR scanning can fail because of:

* damaged screen
* camera problem
* poor lighting
* network issues
* QR rendering problems

Therefore the guard panel needs a controlled manual lookup.

Possible lookup:

* Pass ID
* Enrollment number

Manual verification must still query the backend.

It must not bypass authorization.

---

# 48. NETWORK FAILURE

This deserves explicit treatment.

The safest V1 behavior is:

### If the guard device cannot contact the backend:

**Do not claim that the pass is valid.**

The application should clearly show:

> Unable to verify with CAMPUSGATE server.

An offline mode that allows authorization is significantly harder because it requires securely synchronized authorization data, replay protection, conflict resolution, device trust, and careful handling of stale credentials.

Therefore:

## Offline authorization is NOT part of V1.

---

# 49. ADMIN REPORTING

The administrator should be able to inspect:

### Movement volume

Number of exits/returns.

### Approval volume

Requests approved/rejected/pending.

### Department activity

Movement by department.

### Gate activity

Movement through each gate.

### Time trends

Movement by day/time.

### Overdue records

Students who returned after expected time.

The system must distinguish **actual events** from calculated analytics.

---

# 50. DIGITAL RECORD / RECEIPT

CAMPUSGATE can generate a human-readable record after completion.

Example:

```text
CAMPUSGATE
DIGITAL MOVEMENT RECORD

Student:
Bhavishya Verma

Pass:
CG-2026-000421

Reason:
Personal Work

Approved:
14:12

Exit:
14:31
Main Gate

Return:
16:12
Main Gate

Final Status:
COMPLETED
```

This is a **movement record**, not a financial invoice.

---

# 51. UI PRINCIPLES

## Student

Modern, mobile-first, minimal.

The student primarily wants:

> “Can I leave?”

## HOD

Decision-oriented.

The HOD primarily wants:

> “Who is requesting permission and why?”

## Guard

Speed-oriented.

The guard primarily wants:

> “Is this pass valid, and can I record the movement?”

## Admin

Control-oriented.

The administrator primarily wants:

> “What is happening across the institution?”

The four interfaces should therefore **not look identical** simply because they belong to the same product.

---

# 52. ACCESSIBILITY

Important operational actions should have:

* clear labels
* sufficient touch area
* readable typography
* strong status distinction
* keyboard accessibility where relevant
* non-color-only status communication

For example, don't communicate invalidity only through red.

Use:

> 🔴 Invalid Pass

with explicit text.

---

# 53. RESPONSIVENESS

### Student

Mobile-first.

### Guard

Tablet/mobile optimized with large scanning and verification controls.

### HOD

Responsive desktop/tablet.

### Admin

Desktop-focused but responsive.

---

# 54. SECURITY BOUNDARY

CAMPUSGATE should assume:

> The client can be manipulated.

Therefore:

* frontend validation improves UX
* backend validation provides security

Never reverse those priorities.

---

# 55. PRIVACY

The system contains student information and movement history.

Therefore users should only access information necessary for their role.

A guard should not need unrestricted access to:

> five years of a student's movement history.

A student should not see:

> another student's gate activity.

An HOD should not automatically see:

> unrelated departments.

Data visibility follows role and institutional scope.

---

# 56. V1 EXCLUSIONS

These are deliberately excluded despite being technically interesting:

### Face recognition

Not V1.

### Facial identity verification

Not V1.

### Parent approval

Not V1.

### WhatsApp integration

Not V1.

### SMS gateway

Not V1.

### AI risk detection

Not V1.

### Geofencing

Not V1.

### Visitor management

Not V1.

### Hostel management

Not V1.

### Attendance integration

Not V1.

### Predictive analytics

Not V1.

### Offline authorization

Not V1.

### Multi-level approval workflows

Not V1 unless the institution's actual process requires it.

---

# 57. WHAT V1 ACTUALLY SOLVES

After implementation, CAMPUSGATE V1 should completely solve this workflow:

```text
Student needs to leave
        ↓
Student submits request
        ↓
HOD receives request
        ↓
HOD reviews reason
        ↓
HOD approves
        ↓
Digital authorization created
        ↓
Student receives QR
        ↓
Guard scans QR
        ↓
Backend verifies authorization
        ↓
Guard records EXIT
        ↓
Student leaves
        ↓
Student returns
        ↓
Guard scans again
        ↓
Guard records RETURN
        ↓
Movement record completed
```

That is the product.

Everything else is secondary.

---

# 58. V1 DEFINITION OF DONE

CAMPUSGATE V1 is complete only when the following chain works reliably:

### Identity

Student identity is trustworthy.

### Request

Student can request an exit.

### Authorization

Correct HOD can approve/reject.

### Pass

Approved request produces a valid digital pass.

### Verification

Guard can independently verify authorization.

### Exit

Guard can record actual exit.

### Return

Guard can record actual return.

### History

Movement remains permanently recorded.

### Security

Unauthorized users cannot manipulate the workflow.

### Auditability

Critical operations can be traced.

### Integrity

Duplicate and contradictory movements are prevented.

### Usability

The actual gate workflow is faster and clearer than paper.

---

# 59. THE ACTUAL PRODUCT BOUNDARY

This is the sentence I would put at the top of the development repository:

> **CAMPUSGATE V1 exists to digitally authorize and record temporary student campus exits through a controlled Student → HOD → Guard workflow.**

If a feature does not directly contribute to that objective, it does not automatically belong in V1.

---
