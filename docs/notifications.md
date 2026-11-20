# Notifications and Web Push

Every in-app notification is also sent as a standard Web Push (VAPID) to the user's
registered devices. In-app rows and WebSocket delivery work as before. Email is a
separate channel and is not touched.

## How it works

1. A caller uses `notifyUser`, `notifyUsers`, `notifyInstitution`,
   `notifyInstitutionAdmins` or `notifyDepartmentHods` (`apps/api/src/services/notifications.ts`).
   These insert the `notifications` rows, in the caller's tenant transaction when one is passed.
2. Every open WebSocket of each recipient gets the message at once (phone and laptop both).
3. A background job is handed to the in-memory `PushDispatcher`
   (`services/push/dispatcher.ts`). The HTTP response never waits for it.
4. The job confirms the rows are committed, drops muted categories and inactive
   accounts, sends through `PushSender` in batches of 16, and records the outcome.

`notifyUsers` costs about 4 database round trips per 1,000 recipients (one user check,
one insert per 500 rows, plus the caller's own audience query).

## Enabling push

1. Generate keys locally. Never commit them:
   `npm exec -w @campusgate/api -- web-push generate-vapid-keys --json`
2. In Railway > Variables set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
   `VAPID_SUBJECT` (`mailto:you@example.com` or an `https://` URL), then redeploy.
3. The web app needs no rebuild: it reads the public key from `GET /api/notifications/push/config`.

If any variable is unset or invalid, push is disabled. The API still boots,
`/push/config` returns `{enabled:false, publicKey:null}`, subscribe returns 503, and
in-app and WebSocket delivery continue. Rotating the keys invalidates every existing
subscription; users re-enable from the prompt or the next login resync.

`PUSH_ENDPOINT_HOSTS` (optional) adds extra exact push-service hostnames. Built in:
`fcm.googleapis.com`, `*.push.services.mozilla.com`, `web.push.apple.com`,
`*.notify.windows.com`. This allowlist is the SSRF control, because the server posts to
the stored URL.

## Categories and preferences

Each notification `type` maps to a category (`services/push/categories.ts`): gate
passes, fees, exams, attendance, library, admissions, announcements, system, and
EMERGENCY. Users can turn push off per category (`PUT /api/notifications/preferences`).
Absence of a row means enabled. EMERGENCY cannot be disabled: it is not a member of the
`NotificationCategory` database enum and the API rejects it. The in-app row is always created.

## Lock-screen privacy

A push is visible to anyone holding the phone, so the payload is
`{v,id,t,b,u,c,p,ts}` only (at most 2048 bytes). It never carries `data`, user or tenant
ids, amounts, receipt or pass numbers, grades or names.

| Category | Body shown |
|---|---|
| EMERGENCY, ANNOUNCEMENTS, LIBRARY | The notification body, cut to 120 characters |
| GATEPASS, FEES, EXAMS, ATTENDANCE, ADMISSIONS, SYSTEM | "Open CampusGate to see the details." |

A caller can pass `opts.push = { title?, body? }` to replace the text (the guardian
phase should, to avoid the child's full name). Deep links are relative paths only.

## Delivery behaviour

- 404 and 410 remove the subscription.
- 5xx, network errors and timeouts add to `failureCount`. From 3 failures the device is
  skipped for 15 min, doubling up to 24 h. A device is deleted only after 8 failures and
  7 days without a success.
- 429 does not count against the device. The push-service host is paused for the
  `Retry-After` time (at most 60 s); only targets on that host wait. A second 429 for the
  same item is reported as `failed`.
- 401 and 403 mean the VAPID key or subject is wrong. They never count against devices
  and log `push.vapid_rejected`.
- EMERGENCY and gate pass jobs use an urgent queue that runs before the normal one.
- If the notification row is not visible yet (caller transaction still open), the job
  retries after 3, 6, 12, 24 and 48 s, then drops with `push.job.rows_missing`.

## Limitations

- One API instance. The queue and the WebSocket registry are in memory. More than one
  instance needs a shared bus.
- A restart loses queued pushes. The in-app row is the source of truth. A DB outbox is
  the upgrade path once delivery state (read receipts, notice board) lands.
- Platform (SUPER_ADMIN) accounts get no push; every push route returns 403 for them.
- Logging out removes the current device's subscription.

## Later phases

The notice board and guardian phases call `notifyUsers`, which returns
`{batchId, recipients:[{userId, notificationId}], skippedUserIds}`, and may pass
`onDelivery` to receive per-recipient push results (`pushed`, `no_device`, `muted`,
`inactive`, `failed`, `dropped`, `skipped_read`). No change to the fan-out is needed.

## Swapping the provider

`PushSender` (`services/push/sender.ts`) is the seam, like the email sender. An FCM or
OneSignal adapter implements it and receives the same target (its token can live in
`endpoint`, keys ignored). A provider keyed by user id would need a second method; that is
not built.
