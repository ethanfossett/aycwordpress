# AYC Operations

A standalone operations workspace for a cleaning business. An operator can find or create a customer, build an itemized quote, revise its scope, and record a decision against the exact revision the customer saw. Accepted quotes can become bookings, with a daily schedule and controls to reschedule or cancel.

This is a new JavaScript implementation of selected All Your Cleaning workflows. Pricing is illustrative. The archive contains fresh application code and uses no WordPress code, production records, live credentials, or third-party assets. The MIT license applies to this implementation.

## Run locally

Use Node.js 22.21 or later. No dependency install, downloads, external database, or external service credentials are required. SQLite ships with Node. Some Node 22 releases print an experimental SQLite warning.

    npm test
    npm start -- --demo

Open [the local app](http://127.0.0.1:3000) and sign in as
`demo-dispatcher` with `DUMMY-DISPATCHER-ONLY`. **Today** opens with fictional
jobs. Demo mode starts with a fresh temporary database each time.

To check quoting, add a sample customer with site reference “Demo house”.
Create a deep-clean quote for 1,000 square feet and two bathrooms. Revision 1
should total $206.00. Change the area to 1,200 square feet and save a revision.
Revision 2 should total $240.00, and revision 1 should still show $206.00.

## Dispatcher workflow

The home page opens **Today**, with scheduled work, unfinished jobs from earlier
days, and quotes needing attention. **Customers** shows service details, quote
revisions, and job history. Customers can have multiple service locations. Choose a location when creating a quote. Existing sites become default locations.
**Schedule** includes a week overview and a detailed day view. **Settings**
links to versioned pricing and lists the operating window.

In demo mode, open a job from Today. Reschedule it to an open slot, click
**Start job**, then enter a note and click **Complete job**. From the job page,
open the linked customer and find the completed job in **Booking history**.
Use ordinary mode to retain changes across restarts.

## Booking rules

Open **Crews** to add crews. Existing bookings are assigned to **Default crew**.
Choose a crew when booking or rescheduling. The weekly schedule groups jobs by
crew. Different crews can work at the same time. Each crew operates in Eastern
local time from 8 AM to 6 PM, with starts on half-hour increments. A transaction
checks that crew’s capacity before saving. Adjacent jobs are allowed,
and cancelled jobs release their slot while remaining visible. Each accepted
quote can have one standalone booking and separate recurring visits. A cancelled
booking can be replaced. A job can be moved or cancelled before start.
Starting and completing a job preserve its booked slot and accepted price.
If a started job needs to stop, use **Stop without completing** and enter a
reason. The job is cancelled, its history remains visible, and dispatch can
schedule a replacement. A booking conflict shows the proposed slot again so
you can adjust it.

New bookings save the service site reference and instructions as they were
when booked. Edits to a customer affect future bookings. Older bookings
without a snapshot display current customer details with a clear label. Stale reschedule and cancel requests return
a conflict. The app assumes a trusted local operator and uses sample data.

## Quote expiration

Each new revision is valid for 14 calendar days: a revision issued on an Eastern calendar date
stays acceptable through 11:59 PM Eastern on the date 14 days later, and is expired from the next
instant. The quote page shows when each revision is or was valid. An expired revision cannot be
accepted (Accept is hidden and the server refuses it), but it can be declined, or revised to issue
a fresh revision at the current rates with a new 14-day window. Expiration is worked out from the
stored timestamp, so quotes keep their existing statuses. Revisions saved before expiration existed
have no expiration date and never expire. Accepted quotes, their bookings, and repeated identical
decisions are unaffected.

## Rate management

Open **Settings → Manage pricing rates** to see the active pricing version and its rates. To change prices,
fill in the publish form (it starts with the active rates) with a new version name and amounts
in dollars, at most 2 decimal places. Tick "Activate immediately" to use the new rates for new
quotes and revisions right away, or publish first and press "Activate" on that version later.
Published versions cannot be changed, saved quotes keep the rates they were priced with, and
if someone else changed the active version since the page was loaded, nothing is changed and
the page explains what happened.

## Code map

- server.js handles HTTP routing, form input, and status responses, including the rate management routes (`GET /rates`, `POST /rates`, `POST /rates/activate`).
- views.js renders the customer directory, customer history, quote detail, and rate management page.
- pricing.js validates quote scope and computes line items in integer cents against a versioned rate profile (default `demo-1`). New revisions record the profile version and the unit rates used; older revisions without recorded rates still display.
- pricing.test.js covers default and alternate rate profiles, whole-cent arithmetic, and historical totals.
- repository.js owns the SQLite schema and transaction boundaries. Quotes retain immutable estimate snapshots. A stale revision cannot be accepted, and a repeated identical decision is idempotent.
  It also stores versioned rate profiles (`rate_profiles`, `rate_profile_services`). Stored profiles are write-once, and opening any database adds the default `demo-1` profile once if it is missing, without touching existing quotes, revisions, decisions, or bookings.
  `publishRateProfile` validates and stores a new version, optionally activating it in the same transaction; `activateRateProfile` switches the active version. The active version lives in the append-only `rate_profile_activations` log (newest row wins), so activation never edits pricing rows. Activation requires the caller's expected active version and returns a conflict if it is stale. An identical republish or re-activation is a no-op; reusing a version with different rates is a conflict. New quotes and revisions are priced with the active profile: reading it, pricing, and saving the revision happen in one transaction, so a concurrent activation can never produce a revision whose version and total disagree. Saved revisions are never repriced.
- rate-profiles.test.js covers the initial profile, persistence, upgrades of existing databases, and repeated initialization.
- rate-publishing.test.js covers publishing, validation failures, duplicate versions, rollback, concurrent requests, and persistence of the active version.
- rates-page.test.js covers the rate management page: routes, form validation, publishing, activation, stale requests, persistence, and regressions.
- quote-pricing.test.js covers quotes and revisions priced with the active profile, unchanged history, minimums and whole cents, concurrent activation, and the approval and booking workflows.
- operations.js adds customer details and timestamped job history to existing databases.
- app.css defines the shared dispatcher layout.
- scheduling.js validates dates, start times, and durations.
- expiration.js computes and formats the 14-day Eastern expiration of a revision. Expiration timestamps are stored in `revision_expirations`, written with each revision; the repository takes a `now` clock so tests can control time.
- expiration.test.js covers expiration boundaries (including daylight-saving changes), historical compatibility, repeat decisions, revised quotes, and booking workflows.
- recurrence.js computes visit dates for weekly, biweekly and monthly plans.
- staff.js handles local staff accounts and sessions. server.js enforces route access and crew scope.
- backup.js creates and checks SQLite copies for backup and restore.
- demo.js creates synthetic cases for manual review.
- server.test.js exercises the full HTTP workflow against a temporary on-disk database, including restart.

## Cleaner workspace

Sign in as a cleaner and select a date to see scheduled work for your crew.
For the sample move-out booking, use May 6, 2030 with `demo-cleaner-a`.
Dispatch sees the acknowledgment on the booking. Changing the time or crew
requires a new acknowledgment. Dispatchers can preview any crew from **Cleaner**.

## Staff sign-in and database recovery

Demo mode uses temporary storage and these fictional accounts:

| Username | Demo password |
|---|---|
| demo-dispatcher | DUMMY-DISPATCHER-ONLY |
| demo-cleaner-a | DUMMY-CLEANER-A-ONLY |
| demo-cleaner-b | DUMMY-CLEANER-B-ONLY |

For persistent local use, set `AYC_DISPATCHER_PASSWORD` in your shell and run
`npm start`. Sign in as `dispatcher`. The password must have 12–256 characters.
It initializes the account once. Later starts preserve the stored password.
To provision a cleaner, create a crew in the app, set `AYC_NEW_STAFF_PASSWORD`
in your shell, then run `node add-cleaner.js USERNAME CREW_ID` from the app
folder. Use synthetic records for demos. The server binds to localhost.

Create a backup with `node backup.js data/operations.sqlite data/backup.sqlite`.
To verify a restore without touching the original, run
`node backup.js data/backup.sqlite data/restored.sqlite`. The tool checks
database integrity and refuses to overwrite an existing file. It removes
sessions from the copy, so restored accounts must sign in again. Keep backup
files private because they contain records and password hashes. To open the
restored copy, set `AYC_DATABASE=data/restored.sqlite` and start the app with
your existing dispatcher password in the environment. Sign in again and check
the customer, accepted quote, booking, and job history.


## Recurring service

Open an accepted quote and select **Recurring service plan**. Choose a crew,
first date, local start time, duration, and cadence. Preview four visits,
then confirm the available ones. Monthly plans use the original day of the
month or the last day in shorter months.

Confirming rechecks availability before saving. If a conflict clears, reopen
the plan and recheck to book the missing visit. Repeating confirmation keeps
existing visits, including visits moved or cancelled individually. Pause
stops confirmation of additional visits in this batch while leaving existing
bookings in place. Plans cover four occurrences and do not extend automatically.
