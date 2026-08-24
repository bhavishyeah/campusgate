# Requirements Document

## Introduction

This feature introduces two interconnected capabilities to CAMPUSGATE: **Outside-Time Allowance** and **GatePass Reliability Score**. Both derive their data from the same raw gate events (EXIT/RETURN timestamps recorded by guards), forming a three-layer architecture: Raw Facts → Derived Metrics → Interpretation. Outside-Time Allowance tracks and limits how long students spend outside campus within a configurable policy period. GatePass Reliability Score provides an informational 0.0–5.0 metric reflecting a student's gate pass usage discipline.

## Glossary

- **Allowance_Engine**: The subsystem that computes remaining outside-time allowance for a student by summing actual durations from completed movements within the current policy period
- **Reliability_Engine**: The subsystem that computes a student's GatePass Reliability Score from completed gate pass movements
- **Policy_Period**: The configurable time window over which outside-time allowance resets (daily, weekly, monthly, or semester)
- **Allowance_Amount**: The total permitted outside-time in minutes for a student within one policy period
- **Grace_Period**: The configurable duration in minutes after expectedReturn before a return is considered late (default: 10 minutes)
- **Movement**: A completed gate pass cycle consisting of an EXIT event followed by a RETURN event, both recorded by a guard
- **Actual_Duration**: The elapsed time in minutes between a Movement's EXIT timestamp and RETURN timestamp
- **Overdue_Duration**: The elapsed time in minutes between expectedReturn and actualReturn when actualReturn exceeds expectedReturn plus Grace_Period
- **Severity_Level**: A classification of late return magnitude (minor: 1–15 min, moderate: 16–60 min, significant: 61–180 min, severe: >180 min past grace)
- **Minimum_Sample_Size**: The configurable number of completed movements required before a Reliability Score is displayed (default: 5)
- **Emergency_Override**: A mechanism allowing HOD or ADMIN to grant a gate pass request when a student's allowance is exhausted
- **Allowance_Policy**: The institution-level configuration record containing Allowance_Amount, Policy_Period, Grace_Period, and enforcement rules
- **Timely_Return_Rate**: The percentage of completed movements where actualReturn is within expectedReturn plus Grace_Period
- **Completion_Rate**: The percentage of approved gate passes that reach COMPLETED status (not EXPIRED, REVOKED, or abandoned)
- **Authorization_Compliance_Rate**: The percentage of completed movements with no authorization violations

## Requirements

### Requirement 1: Actual Duration Derivation

**User Story:** As a system operator, I want actual outside duration derived from gate event timestamps, so that all metrics are based on factual, auditable data rather than mutable counters.

#### Acceptance Criteria

1. WHEN a GatePass reaches COMPLETED status, THE Allowance_Engine SHALL compute Actual_Duration as the difference in minutes between the EXIT GateEvent timestamp and the RETURN GateEvent timestamp for that pass
2. THE Allowance_Engine SHALL derive Actual_Duration exclusively from GateEvent records and SHALL NOT store duration as a separately mutable field
3. IF a COMPLETED GatePass has no matching EXIT or RETURN GateEvent, THEN THE Allowance_Engine SHALL exclude that pass from duration calculations and log a data integrity warning

### Requirement 2: Outside-Time Allowance Computation

**User Story:** As a student, I want to see how much outside-time I have remaining in the current period, so that I can plan my campus exits responsibly.

#### Acceptance Criteria

1. THE Allowance_Engine SHALL compute remaining allowance as Allowance_Amount minus the sum of Actual_Duration values for all completed movements within the current Policy_Period
2. WHEN a student has no completed movements in the current Policy_Period, THE Allowance_Engine SHALL report remaining allowance equal to the full Allowance_Amount
3. WHILE a student is currently outside campus (pass status OUTSIDE), THE Allowance_Engine SHALL include the elapsed time since the EXIT event in the consumed allowance calculation
4. WHEN the Policy_Period boundary is crossed, THE Allowance_Engine SHALL reset consumed allowance to zero for the new period

### Requirement 3: Allowance Policy Configuration

**User Story:** As an admin, I want to configure outside-time allowance rules for the institution, so that policies can be adapted to institutional needs without code changes.

#### Acceptance Criteria

1. THE Admin_Panel SHALL allow ADMIN users to configure Allowance_Amount with a minimum value of 60 minutes and a maximum value of 10080 minutes (one week)
2. THE Admin_Panel SHALL allow ADMIN users to select Policy_Period from the values: daily, weekly, monthly, or semester
3. THE Admin_Panel SHALL allow ADMIN users to configure Grace_Period with a minimum value of 0 minutes and a maximum value of 60 minutes
4. THE Admin_Panel SHALL allow ADMIN users to configure enforcement behavior as either "block_new_requests" or "warn_only" when allowance is exhausted
5. WHEN no Allowance_Policy exists for an institution, THE System SHALL apply default values: Allowance_Amount of 1440 minutes (24 hours), Policy_Period of weekly, Grace_Period of 10 minutes, and enforcement of "warn_only"

### Requirement 4: Allowance Enforcement on New Requests

**User Story:** As an institution, I want gate pass requests prevented or flagged when a student's allowance is exhausted, so that outside-time policies are enforced consistently.

#### Acceptance Criteria

1. WHEN a student submits a gate pass request AND the enforcement mode is "block_new_requests" AND remaining allowance is zero or negative, THE System SHALL reject the request with a message indicating allowance exhaustion
2. WHEN a student submits a gate pass request AND the enforcement mode is "warn_only" AND remaining allowance is zero or negative, THE System SHALL allow the request but attach a warning visible to the approving HOD
3. WHEN a student submits a gate pass request AND remaining allowance is positive, THE System SHALL process the request without allowance-related restrictions

### Requirement 5: Emergency Override for Exhausted Allowance

**User Story:** As an HOD, I want the ability to override allowance restrictions for genuine emergencies, so that students are not stranded on campus during urgent situations.

#### Acceptance Criteria

1. WHEN a student's allowance is exhausted AND enforcement mode is "block_new_requests", THE System SHALL provide an Emergency_Override action available to users with HOD or ADMIN role
2. WHEN an Emergency_Override is invoked, THE System SHALL require the overriding user to provide a text justification of at least 10 characters
3. WHEN an Emergency_Override is invoked, THE System SHALL create an audit log entry recording the overriding user, the student, the justification, and the timestamp
4. THE System SHALL count time spent outside during an Emergency_Override toward the student's consumed allowance for the current Policy_Period

### Requirement 6: Student Allowance Dashboard

**User Story:** As a student, I want to see my remaining outside-time and usage breakdown on my dashboard, so that I understand my current allowance status at a glance.

#### Acceptance Criteria

1. THE Student_Dashboard SHALL display remaining allowance in hours and minutes for the current Policy_Period
2. THE Student_Dashboard SHALL display total consumed allowance in hours and minutes for the current Policy_Period
3. WHILE a student is currently outside campus, THE Student_Dashboard SHALL display a real-time elapsed timer showing time since EXIT
4. THE Student_Dashboard SHALL display the Policy_Period type and its start and end dates
5. WHEN remaining allowance falls below 20 percent of Allowance_Amount, THE Student_Dashboard SHALL display a visual warning indicator

### Requirement 7: HOD Allowance Visibility During Approval

**User Story:** As an HOD, I want to see a student's remaining allowance when reviewing gate pass requests, so that I can make informed approval decisions.

#### Acceptance Criteria

1. WHEN an HOD views a pending gate pass request, THE HOD_Panel SHALL display the requesting student's remaining allowance for the current Policy_Period
2. WHEN an HOD views a pending gate pass request AND the student's remaining allowance is zero or negative, THE HOD_Panel SHALL display a prominent exhaustion warning
3. WHEN an HOD views a pending gate pass request AND an allowance warning is attached, THE HOD_Panel SHALL display the warning message alongside the request details

### Requirement 8: Reliability Score Computation

**User Story:** As a student, I want a reliability score that reflects my gate pass discipline, so that I can track and improve my campus exit behavior over time.

#### Acceptance Criteria

1. THE Reliability_Engine SHALL compute the reliability score on a scale of 0.0 to 5.0 with one decimal place precision
2. THE Reliability_Engine SHALL weight the score components as: Timely_Return_Rate at 60 percent, Completion_Rate at 20 percent, and Authorization_Compliance_Rate at 20 percent
3. THE Reliability_Engine SHALL compute Timely_Return_Rate as the proportion of completed movements where actualReturn is at or before expectedReturn plus Grace_Period
4. THE Reliability_Engine SHALL compute Completion_Rate as the proportion of approved gate passes that reached COMPLETED status divided by total approved passes (excluding passes in ACTIVE or OUTSIDE status)
5. THE Reliability_Engine SHALL compute Authorization_Compliance_Rate as the proportion of completed movements with no policy violations recorded

### Requirement 9: Reliability Score Display and Access Control

**User Story:** As a student, I want to see my reliability score breakdown, so that I understand which behaviors contribute to my score.

#### Acceptance Criteria

1. THE Student_Dashboard SHALL display the overall reliability score when the student has completed at least Minimum_Sample_Size movements
2. THE Student_Dashboard SHALL display the three component scores (Timely_Return_Rate, Completion_Rate, Authorization_Compliance_Rate) individually
3. WHEN a student has completed fewer than Minimum_Sample_Size movements, THE Student_Dashboard SHALL display a message indicating insufficient data instead of a score
4. THE System SHALL NOT expose the reliability score to GUARD users through any interface or API endpoint
5. THE HOD_Panel SHALL display the student's reliability score when reviewing gate pass requests

### Requirement 10: Late Return Severity Classification

**User Story:** As a system operator, I want late returns classified by severity, so that the reliability score reflects proportional consequences for different degrees of lateness.

#### Acceptance Criteria

1. WHEN a completed movement's actualReturn exceeds expectedReturn plus Grace_Period by 1 to 15 minutes, THE Reliability_Engine SHALL classify the lateness as minor severity
2. WHEN a completed movement's actualReturn exceeds expectedReturn plus Grace_Period by 16 to 60 minutes, THE Reliability_Engine SHALL classify the lateness as moderate severity
3. WHEN a completed movement's actualReturn exceeds expectedReturn plus Grace_Period by 61 to 180 minutes, THE Reliability_Engine SHALL classify the lateness as significant severity
4. WHEN a completed movement's actualReturn exceeds expectedReturn plus Grace_Period by more than 180 minutes, THE Reliability_Engine SHALL classify the lateness as severe severity
5. THE Reliability_Engine SHALL apply severity-weighted deductions to the Timely_Return_Rate: minor deducts 0.25, moderate deducts 0.5, significant deducts 0.75, and severe deducts 1.0 per occurrence normalized across total movements

### Requirement 11: Reliability Score Exclusions

**User Story:** As a student, I want my reliability score to only reflect factors within my control, so that external circumstances do not unfairly penalize me.

#### Acceptance Criteria

1. THE Reliability_Engine SHALL NOT reduce a student's score due to gate pass rejections by HOD
2. THE Reliability_Engine SHALL NOT reduce a student's score for movements conducted under Emergency_Override
3. THE Reliability_Engine SHALL NOT reduce a student's score when a return is delayed due to a documented system failure (gate system offline, guard unavailable)
4. THE Reliability_Engine SHALL only include gate passes that reached a terminal status (COMPLETED, EXPIRED, REVOKED) in score calculations, excluding currently active passes

### Requirement 12: Reliability Score Informational Policy

**User Story:** As an institution administrator, I want the reliability score to be informational only, so that it supports decision-making without creating automated gatekeeping.

#### Acceptance Criteria

1. THE System SHALL NOT automatically reject gate pass requests based on the reliability score
2. THE System SHALL NOT prevent any gate pass workflow action based on the reliability score
3. THE System SHALL present the reliability score as advisory information alongside other request details when shown to HOD users

### Requirement 13: Reliability Score Trend Tracking

**User Story:** As a student, I want to see how my reliability score changes over time, so that I can observe the impact of my behavior improvements.

#### Acceptance Criteria

1. THE Reliability_Engine SHALL compute and store a score snapshot after each completed movement
2. THE Student_Dashboard SHALL display reliability score history as a trend for the most recent 30 completed movements
3. WHEN a student's score improves by 0.5 or more compared to 10 movements ago, THE System SHALL display an improvement indicator on the Student_Dashboard

### Requirement 14: Allowance and Reliability Configuration for Minimum Sample Size

**User Story:** As an admin, I want to configure the minimum number of movements required before scores appear, so that new students are not shown unreliable scores.

#### Acceptance Criteria

1. THE Admin_Panel SHALL allow ADMIN users to configure Minimum_Sample_Size with a minimum value of 3 and a maximum value of 20
2. WHEN no Minimum_Sample_Size is configured, THE System SHALL apply a default value of 5
3. THE Admin_Panel SHALL allow ADMIN users to configure late return severity thresholds (minor, moderate, significant, severe boundary values in minutes)
