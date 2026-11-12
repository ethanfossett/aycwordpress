# AYC Operations

A standalone operations workspace for a cleaning business. An operator can find or create a customer, build an itemized quote, revise its scope, and record a decision against the exact revision the customer saw. Accepted quotes can become bookings, with a daily schedule and controls to reschedule or cancel.

This is a new JavaScript implementation of selected All Your Cleaning workflows. Pricing is illustrative. The archive contains fresh application code and uses no WordPress code, production records, credentials, or third-party assets. The MIT license applies to this implementation.

## Run locally

Use Node.js 22.21 or later. No dependency install, downloads, external database, or service credentials are required. SQLite ships with Node. Some Node 22 releases print an experimental SQLite warning.

    npm test
    npm start

Open http://127.0.0.1:3000. Add a sample customer with site reference “Demo house”. Create a deep-clean quote for 1,000 square feet and two bathrooms. Revision 1 should total $206.00. Revise the area to 1,200 square feet. Revision 2 should total $240.00 while revision 1 retains its original total. Record acceptance and restart the server. The decision and both revisions should still be visible.

The local database is created under data/ and excluded from the source archive. Use synthetic records only. The server listens on loopback and assumes a trusted local operator. Set PORT to use another port.

To explore an already populated workspace, run `npm start -- --demo`. Search for
“Apartment” and open the move-out quote to see its accepted second revision.
“Condo” has a draft with a service minimum and “Townhouse” has a declined quote.
Open the accepted quote’s booking to see the sample schedule for May 6, 2030. Demo mode uses a separate in-memory database that resets on restart.

## Booking rules

The schedule models one crew operating in Eastern local time, between 8 AM and
6 PM, in half-hour increments. Bookings use calendar dates and wall-clock
minutes. A transaction checks capacity before saving. Adjacent jobs are allowed,
and cancelled jobs release their slot while remaining visible. Each accepted
quote can have one active booking. Stale reschedule and cancel requests return
a conflict. The app assumes a trusted local operator and uses sample data.

## Code map

- server.js handles HTTP routing, form input, and status responses.
- views.js renders the customer directory, customer history, and quote detail.
- pricing.js validates quote scope and computes line items in integer cents.
- repository.js owns the SQLite schema and transaction boundaries. Quotes retain immutable estimate snapshots. A stale revision cannot be accepted, and a repeated identical decision is idempotent.
- scheduling.js validates dates, start times, and durations.
- demo.js creates synthetic cases for manual review.
- server.test.js exercises the full HTTP workflow against a temporary on-disk database, including restart.
