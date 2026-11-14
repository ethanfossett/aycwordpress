import { recurringSlots } from './recurrence.js';
import { customerFields, migrateOperations, note } from './operations.js';
import { DatabaseSync } from 'node:sqlite';
import {
  defaultRateProfile, estimate, InputError, MAX_RATE_CENTS, requiredText, validateRateProfile,
} from './pricing.js';

import { expirationFor, formatEastern, isExpired } from './expiration.js';
import { bookingSlot, scheduleDate } from './scheduling.js';

export class NotFound extends Error {}
export class Conflict extends Error {}

// `now` is the clock for every timestamp the repository records and for deciding expiration.
// Tests pass a controllable clock; the app uses the real time.
export function openRepository(file, { now = () => new Date() } = {}) {
  const clock = () => {
    const time = now();
    if (!(time instanceof Date) || Number.isNaN(time.getTime())) throw new TypeError('The clock must return a valid Date.');
    return time;
  };
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      reference TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','accepted','declined')),
      current_revision INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE TABLE IF NOT EXISTS revisions (
      quote_id INTEGER NOT NULL REFERENCES quotes(id),
      number INTEGER NOT NULL,
      estimate TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (quote_id, number)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS decisions (
      quote_id INTEGER PRIMARY KEY REFERENCES quotes(id),
      revision INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted','declined')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (quote_id, revision) REFERENCES revisions(quote_id, number)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY,
      quote_id INTEGER NOT NULL REFERENCES decisions(quote_id),
      day TEXT NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
      CHECK(start_minute < end_minute)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS booking_calendar ON bookings(day, status, start_minute);
    CREATE INDEX IF NOT EXISTS quotes_customer ON quotes(customer_id);

    -- Versioned rate profiles. Amounts are whole cents with the same bounds as pricing.js.
    -- Rows are write-once: a version, once stored, can never be changed or removed.
    CREATE TABLE IF NOT EXISTS rate_profiles (
      id INTEGER PRIMARY KEY,
      version TEXT NOT NULL UNIQUE CHECK(length(version) BETWEEN 1 AND 40 AND trim(version) <> ''),
      bathroom_cents INTEGER NOT NULL CHECK(bathroom_cents BETWEEN 0 AND ${MAX_RATE_CENTS}),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS rate_profile_services (
      profile_id INTEGER NOT NULL REFERENCES rate_profiles(id),
      service TEXT NOT NULL CHECK(length(service) BETWEEN 1 AND 40),
      square_foot_cents INTEGER NOT NULL CHECK(square_foot_cents BETWEEN 0 AND ${MAX_RATE_CENTS}),
      minimum_cents INTEGER NOT NULL CHECK(minimum_cents BETWEEN 0 AND ${MAX_RATE_CENTS}),
      PRIMARY KEY (profile_id, service)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS rate_profiles_no_update BEFORE UPDATE ON rate_profiles
      BEGIN SELECT RAISE(ABORT, 'Rate profiles are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS rate_profiles_no_delete BEFORE DELETE ON rate_profiles
      BEGIN SELECT RAISE(ABORT, 'Rate profiles are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS rate_profile_services_no_update BEFORE UPDATE ON rate_profile_services
      BEGIN SELECT RAISE(ABORT, 'Rate profiles are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS rate_profile_services_no_delete BEFORE DELETE ON rate_profile_services
      BEGIN SELECT RAISE(ABORT, 'Rate profiles are immutable.'); END;

    -- Which profile is active, kept apart from the profiles themselves. Append-only: the newest
    -- row is the active profile, so activating never edits pricing data and keeps a full history.
    CREATE TABLE IF NOT EXISTS rate_profile_activations (
      id INTEGER PRIMARY KEY,
      profile_id INTEGER NOT NULL REFERENCES rate_profiles(id),
      activated_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS rate_profile_activations_no_update BEFORE UPDATE ON rate_profile_activations
      BEGIN SELECT RAISE(ABORT, 'Rate profile activations are append-only.'); END;
    CREATE TRIGGER IF NOT EXISTS rate_profile_activations_no_delete BEFORE DELETE ON rate_profile_activations
      BEGIN SELECT RAISE(ABORT, 'Rate profile activations are append-only.'); END;

    -- When each revision stops being acceptable, saved with the revision in the same transaction.
    -- Revisions saved before this table existed have no row and never expire. Write-once.
    CREATE TABLE IF NOT EXISTS revision_expirations (
      quote_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (quote_id, number),
      FOREIGN KEY (quote_id, number) REFERENCES revisions(quote_id, number)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS revision_expirations_no_update BEFORE UPDATE ON revision_expirations
      BEGIN SELECT RAISE(ABORT, 'Revision expirations are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS revision_expirations_no_delete BEFORE DELETE ON revision_expirations
      BEGIN SELECT RAISE(ABORT, 'Revision expirations are immutable.'); END;
  `);

  migrateOperations(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_plans (
      id INTEGER PRIMARY KEY,
      quote_id INTEGER NOT NULL UNIQUE REFERENCES decisions(quote_id),
      crew_id INTEGER NOT NULL REFERENCES crews(id),
      cadence TEXT NOT NULL,
      first_day TEXT NOT NULL,
      start_time TEXT NOT NULL,
      duration INTEGER NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS recurring_visits (
      id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES recurring_plans(id),
      day TEXT NOT NULL,
      UNIQUE(plan_id, day)
    ) STRICT;
  `);
  transaction(() => {
    if (!db.prepare('PRAGMA table_info(bookings)').all().some(column => column.name === 'recurring_visit_id')) {
      db.exec('ALTER TABLE bookings ADD COLUMN recurring_visit_id INTEGER REFERENCES recurring_visits(id)');
    }
    db.exec(`
      DROP INDEX IF EXISTS one_active_booking;
      CREATE UNIQUE INDEX IF NOT EXISTS one_standalone_booking
        ON bookings(quote_id) WHERE status = 'scheduled' AND recurring_visit_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_visit
        ON bookings(recurring_visit_id) WHERE recurring_visit_id IS NOT NULL;
    `);
  });

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function insertProfile({ version, bathroomCents, services }) {
    const id = Number(db.prepare('INSERT INTO rate_profiles (version, bathroom_cents, created_at) VALUES (?, ?, ?)')
      .run(version, bathroomCents, clock().toISOString()).lastInsertRowid);
    const insert = db.prepare(`INSERT INTO rate_profile_services
      (profile_id, service, square_foot_cents, minimum_cents) VALUES (?, ?, ?, ?)`);
    for (const [service, rates] of Object.entries(services)) {
      insert.run(id, service, rates.squareFootCents, rates.minimumCents);
    }
    return id;
  }

  function recordActivation(profileId) {
    db.prepare('INSERT INTO rate_profile_activations (profile_id, activated_at) VALUES (?, ?)')
      .run(profileId, clock().toISOString());
  }

  // Stores the built-in default profile if its version is missing, and activates it if nothing has
  // ever been activated. Safe to repeat: existing rows are left untouched, and BEGIN IMMEDIATE
  // serializes concurrent first opens. A later activation is never reset on reopen.
  function initializeRateProfiles() {
    transaction(() => {
      const existing = db.prepare('SELECT id FROM rate_profiles WHERE version = ?').get(defaultRateProfile.version);
      const id = existing ? existing.id : insertProfile(defaultRateProfile);
      if (!db.prepare('SELECT 1 FROM rate_profile_activations LIMIT 1').get()) recordActivation(id);
    });
  }
  try {
    initializeRateProfiles();
  } catch (error) {
    db.close();
    throw error;
  }

  // Converts a rate_profiles row to the shape estimate() accepts, plus createdAt.
  function loadProfile(row) {
    const services = db.prepare(`SELECT * FROM rate_profile_services
      WHERE profile_id = ? ORDER BY rowid`).all(row.id);
    return {
      version: row.version,
      createdAt: row.created_at,
      bathroomCents: row.bathroom_cents,
      services: Object.fromEntries(services.map(item => [item.service, {
        squareFootCents: item.square_foot_cents, minimumCents: item.minimum_cents,
      }])),
    };
  }

  // Returns stored profiles, oldest first.
  function rateProfiles() {
    return db.prepare('SELECT * FROM rate_profiles ORDER BY id').all().map(loadProfile);
  }

  function findRateProfile(version) {
    const row = db.prepare('SELECT * FROM rate_profiles WHERE version = ?').get(version);
    if (!row) throw new NotFound('Rate profile not found.');
    return loadProfile(row);
  }

  function activeRow() {
    return db.prepare(`SELECT p.*, a.activated_at FROM rate_profile_activations a
      JOIN rate_profiles p ON p.id = a.profile_id ORDER BY a.id DESC LIMIT 1`).get();
  }

  function activeRateProfile() {
    const row = activeRow();
    return { ...loadProfile(row), activatedAt: row.activated_at };
  }

  function sameRates(stored, profile) {
    const names = Object.keys(stored.services);
    return stored.bathroomCents === profile.bathroomCents
      && names.length === Object.keys(profile.services).length
      && names.every(name => Object.hasOwn(profile.services, name)
        && stored.services[name].squareFootCents === profile.services[name].squareFootCents
        && stored.services[name].minimumCents === profile.services[name].minimumCents);
  }

  function expectedVersion(value) {
    if (typeof value !== 'string' || !value) {
      throw new InputError('The currently active version is required to activate a profile.');
    }
    return value;
  }

  // Must run inside a transaction. Re-activating the active profile is an idempotent no-op;
  // otherwise the caller's expected active version must still be current.
  function activateVersion(version, expectedActive) {
    const target = db.prepare('SELECT id FROM rate_profiles WHERE version = ?').get(version);
    if (!target) throw new NotFound('Rate profile not found.');
    const current = activeRow();
    if (current?.id === target.id) return;
    if (current?.version !== expectedActive) {
      throw new Conflict('The active rate profile has changed. Reload it before continuing.');
    }
    recordActivation(target.id);
  }

  function customer(id) {
    const record = db.prepare('SELECT c.*, d.access_notes, d.service_notes FROM customers c LEFT JOIN customer_details d ON d.customer_id = c.id WHERE c.id = ?').get(id);
    if (!record) throw new NotFound('Customer not found.');
    return record;
  }

  function locations(id) {
    return db.prepare('SELECT * FROM service_locations WHERE customer_id = ? ORDER BY is_default DESC, id').all(id);
  }

  function addLocation(id, fields, isDefault = 0) {
    const reference = requiredText(fields.reference, 'Site reference');
    return Number(db.prepare(`INSERT INTO service_locations
      (customer_id, reference, access_notes, service_notes, is_default) VALUES (?, ?, ?, ?, ?)`)
      .run(id, reference, note(fields.access ?? ''), note(fields.notes ?? ''), isDefault).lastInsertRowid);
  }

  function quoteSite(id, customerId) {
    return db.prepare(`SELECT l.* FROM quote_locations q JOIN service_locations l ON l.id = q.location_id
      WHERE q.quote_id = ?`).get(id) ?? locations(customerId)[0] ?? customer(customerId);
  }

  function quote(id) {
    const record = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    if (!record) throw new NotFound('Quote not found.');
    // Expiration is derived, not a status: `expired` is computed from the stored timestamp and the clock.
    const time = clock();
    const revisions = db.prepare(`SELECT r.*, e.expires_at FROM revisions r
      LEFT JOIN revision_expirations e ON e.quote_id = r.quote_id AND e.number = r.number
      WHERE r.quote_id = ? ORDER BY r.number DESC`)
      .all(id).map(row => ({ ...row, estimate: JSON.parse(row.estimate), expired: isExpired(row.expires_at, time) }));
    const decision = db.prepare('SELECT * FROM decisions WHERE quote_id = ?').get(id);
    const bookings = db.prepare('SELECT * FROM dispatch_bookings WHERE quote_id = ? ORDER BY id DESC').all(id);
    return { ...record, revisions, decision, bookings, site: quoteSite(id, record.customer_id) };
  }

  function recordRevision(id, revision, snapshot) {
    const issuedAt = clock();
    db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?)')
      .run(id, revision, JSON.stringify(snapshot), issuedAt.toISOString());
    db.prepare('INSERT INTO revision_expirations VALUES (?, ?, ?)').run(id, revision, expirationFor(issuedAt));
  }

  function currentDraft(id, expected) {
    const record = quote(id);
    if (record.status !== 'draft' || record.current_revision !== expected) {
      throw new Conflict('The quote has changed. Reload it before continuing.');
    }
    return record;
  }

  function booking(id) {
    const record = db.prepare(`SELECT b.*, coalesce(c.id, 1) AS crew_id, c.name AS crew_name
      FROM dispatch_bookings b LEFT JOIN booking_crews a ON a.booking_id = b.id
      JOIN crews c ON c.id = coalesce(a.crew_id, 1) WHERE b.id = ?`).get(id);
    if (!record) throw new NotFound('Booking not found.');
    return record;
  }

  function crew(value) {
    if (!/^[1-9]\d*$/.test(String(value))) throw new InputError('Choose a crew.');
    const row = db.prepare('SELECT * FROM crews WHERE id = ?').get(Number(value));
    if (!row) throw new InputError('Choose an existing crew.');
    return row;
  }

  function overlappingJob(slot, crewId, ignoreId = 0) {
    return db.prepare(`
      SELECT b.id FROM bookings b LEFT JOIN booking_crews a ON a.booking_id = b.id
      WHERE b.day = ? AND b.status = 'scheduled' AND coalesce(a.crew_id, 1) = ?
      AND b.start_minute < ? AND b.end_minute > ? AND b.id <> ?
    `).get(slot.date, crewId, slot.end, slot.start, ignoreId);
  }

  function requireAvailable(slot, crewId, ignoreId = 0) {
    if (overlappingJob(slot, crewId, ignoreId)) {
      throw new Conflict('That time overlaps another scheduled job for this crew.');
    }
  }

  function event(id, kind, detail = '') {
    db.prepare('INSERT INTO booking_events (booking_id, kind, detail, occurred_at) VALUES (?, ?, ?, ?)')
      .run(id, kind, detail, now().toISOString());
  }

  function insertBooking(record, slot, assigned, startTime, visitId = null) {
    const id = record.id;
    const bookingId = Number(db.prepare(`
      INSERT INTO bookings (quote_id, day, start_minute, end_minute, recurring_visit_id) VALUES (?, ?, ?, ?, ?)
    `).run(id, slot.date, slot.start, slot.end, visitId).lastInsertRowid);
    db.prepare('INSERT INTO booking_crews VALUES (?, ?)').run(bookingId, assigned.id);
    const site = record.site;
    db.prepare('INSERT INTO booking_site_snapshots VALUES (?, ?, ?, ?)')
      .run(bookingId, site.reference, site.access_notes ?? '', site.service_notes ?? '');
    event(bookingId, 'booked', slot.date + ' · ' + startTime + ' · ' + assigned.name);
    return bookingId;
  }

  function planForQuote(id) {
    return db.prepare('SELECT * FROM recurring_plans WHERE quote_id = ?').get(id);
  }

  function planFields(plan) {
    return { date: plan.first_day, start: plan.start_time, cadence: plan.cadence,
      duration: plan.duration, crewId: plan.crew_id };
  }

  function previewPlan(id, fields) {
    const record = quote(id);
    if (record.status !== 'accepted') throw new Conflict('Accept the quote before creating a plan.');
    const plan = planForQuote(id);
    const values = plan ? planFields(plan) : fields;
    const assigned = crew(values.crewId ?? 1);
    const slots = recurringSlots(values);
    const visits = slots.map(slot => {
      const visit = plan && db.prepare(`SELECT v.id, b.id AS booking_id, b.job_state
        FROM recurring_visits v LEFT JOIN dispatch_bookings b ON b.recurring_visit_id = v.id
        WHERE v.plan_id = ? AND v.day = ?`).get(plan.id, slot.date);
      return { ...slot, visit, conflict: !visit?.booking_id && Boolean(overlappingJob(slot, assigned.id)) };
    });
    return { record, plan, values, assigned, visits };
  }

  return {
    planForQuote,
    previewPlan,
    pausePlan(id, paused) {
      const result = db.prepare('UPDATE recurring_plans SET paused = ? WHERE quote_id = ?').run(Number(paused), id);
      if (!result.changes) throw new NotFound('Recurring plan not found.');
    },
    confirmPlan(id, fields) {
      return transaction(() => {
        const preview = previewPlan(id, fields);
        const { record, plan, values, assigned, visits } = preview;
        if (plan && ['date', 'start', 'cadence', 'duration', 'crewId'].some(key =>
          String(fields[key]) !== String(values[key]))) {
          throw new Conflict('The plan already exists with different settings. Open it before confirming visits.');
        }
        if (plan?.paused) throw new Conflict('Resume this plan before confirming visits.');
        const planId = plan?.id ?? Number(db.prepare(`INSERT INTO recurring_plans
          (quote_id, crew_id, cadence, first_day, start_time, duration) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, assigned.id, values.cadence, values.date, values.start, Number(values.duration)).lastInsertRowid);
        for (const slot of visits) {
          const visitId = slot.visit?.id ?? Number(db.prepare('INSERT INTO recurring_visits (plan_id, day) VALUES (?, ?)')
            .run(planId, slot.date).lastInsertRowid);
          if (!slot.visit?.booking_id && !slot.conflict) insertBooking(record, slot, assigned, values.start, visitId);
        }
      });
    },
    crews() {
      return db.prepare('SELECT * FROM crews ORDER BY id').all();
    },
    addCrew(fields) {
      const name = requiredText(fields.name, 'Crew name');
      return transaction(() => {
        if (db.prepare('SELECT id FROM crews WHERE name = ?').get(name)) {
          throw new Conflict('A crew with that name already exists.');
        }
        db.prepare('INSERT INTO crews (name) VALUES (?)').run(name);
      });
    },
    booking,
    acknowledgment(record) {
      return db.prepare(`SELECT acknowledged_at FROM crew_acknowledgments
        WHERE booking_id = ? AND booking_version = ? AND crew_id = ?`)
        .get(record.id, record.version, record.crew_id);
    },
    cleanerJobs(crewId, day) {
      crew(crewId);
      return db.prepare(`
        SELECT b.id, b.version, b.start_minute, q.title, s.reference, a.acknowledged_at
        FROM dispatch_bookings b JOIN booking_crews bc ON bc.booking_id = b.id
        JOIN quotes q ON q.id = b.quote_id
        LEFT JOIN booking_site_snapshots s ON s.booking_id = b.id
        LEFT JOIN crew_acknowledgments a ON a.booking_id = b.id
          AND a.booking_version = b.version AND a.crew_id = bc.crew_id
        WHERE b.day = ? AND bc.crew_id = ? AND b.job_state = 'scheduled'
        ORDER BY b.start_minute, b.id`).all(scheduleDate(day), crewId);
    },
    acknowledgeJob(crewId, id, expected) {
      transaction(() => {
        crew(crewId);
        const record = booking(id);
        if (record.crew_id !== crewId || record.version !== expected || record.job_state !== 'scheduled') {
          throw new Conflict('This assignment changed. Reload your crew schedule.');
        }
        db.prepare(`INSERT INTO crew_acknowledgments VALUES (?, ?, ?, ?)
          ON CONFLICT(booking_id, booking_version) DO NOTHING`)
          .run(id, expected, crewId, clock().toISOString());
      });
    },
    locations,
    addLocation(id, fields) {
      return transaction(() => {
        customer(id);
        return addLocation(id, fields);
      });
    },
    editLocation(id, locationId, fields) {
      const reference = requiredText(fields.reference, 'Site reference');
      const access = note(fields.access ?? '');
      const notes = note(fields.notes ?? '');
      transaction(() => {
        const location = locations(id).find(item => item.id === locationId);
        if (!location) throw new NotFound('Service location not found.');
        db.prepare('UPDATE service_locations SET reference = ?, access_notes = ?, service_notes = ? WHERE id = ?')
          .run(reference, access, notes, locationId);
        if (location.is_default) {
          db.prepare('UPDATE customers SET reference = ? WHERE id = ?').run(reference, id);
          db.prepare(`INSERT INTO customer_details VALUES (?, ?, ?) ON CONFLICT(customer_id)
            DO UPDATE SET access_notes = excluded.access_notes, service_notes = excluded.service_notes`)
            .run(id, access, notes);
        }
      });
    },
    bookingSite(id) {
      return db.prepare('SELECT * FROM booking_site_snapshots WHERE booking_id = ?').get(id);
    },
    interruptJob(id, expected, reason) {
      const detail = note(reason);
      if (!detail) throw new InputError('Enter a reason for stopping the job.');
      transaction(() => {
        const record = booking(id);
        if (record.job_state !== 'in_progress' || record.version !== expected) {
          throw new Conflict('The job has changed. Reload it before continuing.');
        }
        db.prepare("UPDATE bookings SET status = 'cancelled', version = version + 1 WHERE id = ?").run(id);
        event(id, 'cancelled', 'Stopped before completion: ' + detail);
      });
    },
    history(id) {
      return db.prepare('SELECT * FROM booking_events WHERE booking_id = ? ORDER BY id DESC').all(id);
    },
    advanceJob(id, expected, action, detail) {
      const comments = action === 'complete' ? note(detail) : '';
      transaction(() => {
        const record = booking(id);
        const required = action === 'start' ? 'scheduled' : 'in_progress';
        if (record.job_state !== required || record.version !== expected) {
          throw new Conflict('The job has changed. Reload it before continuing.');
        }
        db.prepare('UPDATE bookings SET version = version + 1 WHERE id = ?').run(id);
        event(id, action === 'start' ? 'started' : 'completed', comments);
      });
    },
    updateCustomer(id, fields) {
      const details = customerFields(fields);
      transaction(() => {
        customer(id);
        db.prepare('UPDATE customers SET name = ?, reference = ? WHERE id = ?')
          .run(details.name, details.reference, id);
        db.prepare(`INSERT INTO customer_details VALUES (?, ?, ?)
          ON CONFLICT(customer_id) DO UPDATE SET access_notes = excluded.access_notes,
            service_notes = excluded.service_notes`).run(id, details.access, details.notes);
        db.prepare(`UPDATE service_locations SET reference = ?, access_notes = ?, service_notes = ?
          WHERE customer_id = ? AND is_default = 1`).run(details.reference, details.access, details.notes, id);
      });
    },
    customerBookings(id) {
      return db.prepare(`SELECT b.*, q.title FROM dispatch_bookings b JOIN quotes q ON b.quote_id = q.id
        WHERE q.customer_id = ? ORDER BY day DESC, start_minute DESC`).all(id);
    },
    listQuotes({ draftsOnly = false } = {}) {
      return db.prepare(`SELECT q.id, q.title, q.status, c.name, e.expires_at
        FROM quotes q JOIN customers c ON c.id = q.customer_id
        LEFT JOIN revision_expirations e ON e.quote_id = q.id AND e.number = q.current_revision
        WHERE (? = 0 OR q.status = 'draft') ORDER BY q.id DESC`).all(Number(draftsOnly));
    },
    overdueJobs(day) {
      return db.prepare(`SELECT b.*, q.title, c.name FROM dispatch_bookings b
        JOIN quotes q ON q.id = b.quote_id JOIN customers c ON c.id = q.customer_id
        WHERE b.day < ? AND b.job_state IN ('scheduled', 'in_progress')
        ORDER BY b.day DESC, b.start_minute`).all(day);
    },
    schedule(date) {
      return db.prepare(`
        SELECT b.*, q.title, c.name, crew.id AS crew_id, crew.name AS crew_name
        FROM dispatch_bookings b
        JOIN quotes q ON q.id = b.quote_id JOIN customers c ON c.id = q.customer_id
        LEFT JOIN booking_crews a ON a.booking_id = b.id
        JOIN crews crew ON crew.id = coalesce(a.crew_id, 1)
        WHERE b.day = ? ORDER BY b.start_minute, b.id
      `).all(scheduleDate(date));
    },
    scheduleQuote(id, fields) {
      const slot = bookingSlot(fields);
      return transaction(() => {
        const record = quote(id);
        if (record.status !== 'accepted') throw new Conflict('Accept the quote before booking.');
        const assigned = crew(fields.crewId ?? 1);
        const existing = record.bookings.find(item => item.status === 'scheduled' && item.recurring_visit_id == null);
        if (existing) {
          if (existing.job_state === 'scheduled' && existing.day === slot.date && existing.start_minute === slot.start
            && existing.end_minute === slot.end && booking(existing.id).crew_id === assigned.id) return existing.id;
          throw new Conflict('This quote already has an active booking.');
        }
        requireAvailable(slot, assigned.id);
        return insertBooking(record, slot, assigned, fields.start);
      });
    },
    changeBooking(id, expected, fields, cancel, actor) {
      const slot = cancel ? null : bookingSlot(fields);
      return transaction(() => {
        const record = booking(id);
        if (record.version !== expected || record.job_state !== 'scheduled') {
          throw new Conflict('The booking has changed. Reload it before continuing.');
        }
        let detail = record.day;
        if (cancel) {
          db.prepare("UPDATE bookings SET status = 'cancelled', version = version + 1 WHERE id = ?").run(id);
        } else {
          const assigned = crew(fields.crewId ?? record.crew_id);
          requireAvailable(slot, assigned.id, id);
          db.prepare(`INSERT INTO booking_crews VALUES (?, ?)
            ON CONFLICT(booking_id) DO UPDATE SET crew_id = excluded.crew_id`).run(id, assigned.id);
          detail = record.day + ' · ' + record.crew_name + ' → ' + slot.date + ' · ' + fields.start + ' · ' + assigned.name;
          db.prepare(`
            UPDATE bookings SET day = ?, start_minute = ?, end_minute = ?, version = version + 1 WHERE id = ?
          `).run(slot.date, slot.start, slot.end, id);
        }
        event(id, cancel ? 'cancelled' : 'rescheduled', actor ? detail + ' · By ' + actor : detail);
      });
    },
    close: () => db.close(),
    rateProfiles,
    findRateProfile,
    activeRateProfile,
    // Publishes a new immutable profile, optionally activating it in the same transaction. Repeating
    // an identical publish is a no-op; reusing a version with different rates is a conflict.
    publishRateProfile(input, { activate = false, expectedActive } = {}) {
      const profile = validateRateProfile(input);
      if (activate) expectedVersion(expectedActive);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM rate_profiles WHERE version = ?').get(profile.version);
        if (!existing) insertProfile(profile);
        else if (!sameRates(loadProfile(existing), profile)) {
          throw new Conflict('Version ' + profile.version + ' is already published with different rates.');
        }
        if (activate) activateVersion(profile.version, expectedActive);
        return profile.version;
      });
    },
    activateRateProfile(version, expectedActive) {
      if (typeof version !== 'string' || !version) throw new InputError('Choose a published version.');
      expectedVersion(expectedActive);
      transaction(() => activateVersion(version, expectedActive));
    },
    customer,
    quote,
    customers(query = '') {
      return db.prepare(`
        SELECT c.*, COUNT(q.id) AS quote_count
        FROM customers c LEFT JOIN quotes q ON q.customer_id = c.id
        WHERE instr(lower(c.name || ' ' || c.reference), lower(?)) > 0
        GROUP BY c.id ORDER BY c.name, c.id
      `).all(query);
    },
    customerQuotes(id) {
      return db.prepare('SELECT * FROM quotes WHERE customer_id = ? ORDER BY id DESC').all(id);
    },
    addCustomer(fields) {
      const name = requiredText(fields.name, 'Name');
      const reference = requiredText(fields.reference, 'Site reference');
      return transaction(() => {
        const id = Number(db.prepare('INSERT INTO customers (name, reference) VALUES (?, ?)')
          .run(name, reference).lastInsertRowid);
        addLocation(id, { reference }, 1);
        return id;
      });
    },
    // New quotes and revisions are priced with the active profile. Reading it, pricing, and saving
    // happen in one BEGIN IMMEDIATE transaction, so an activation cannot land in between.
    // Scope errors are still reported before a missing customer or a stale revision.
    addQuote(customerId, fields) {
      const title = requiredText(fields.title, 'Job title');
      return transaction(() => {
        const snapshot = estimate(fields, activeRateProfile());
        customer(customerId);
        const id = Number(db.prepare('INSERT INTO quotes (customer_id, title) VALUES (?, ?)')
          .run(customerId, title).lastInsertRowid);
        const sites = locations(customerId);
        const site = fields.locationId == null ? sites[0] : sites.find(item => String(item.id) === String(fields.locationId));
        if (fields.locationId != null && !site) throw new InputError('Choose a location belonging to this customer.');
        if (site) db.prepare('INSERT INTO quote_locations VALUES (?, ?)').run(id, site.id);
        recordRevision(id, 1, snapshot);
        return id;
      });
    },
    revise(id, expected, fields) {
      return transaction(() => {
        const snapshot = estimate(fields, activeRateProfile());
        const next = currentDraft(id, expected).current_revision + 1;
        recordRevision(id, next, snapshot);
        db.prepare('UPDATE quotes SET current_revision = ? WHERE id = ?').run(next, id);
      });
    },
    decide(id, expected, outcome) {
      if (outcome !== 'accepted' && outcome !== 'declined') throw new InputError('Invalid outcome.');
      return transaction(() => {
        const existing = quote(id);
        if (existing.decision?.revision === expected && existing.decision.outcome === outcome) return;
        currentDraft(id, expected);
        // Checked after the idempotency and stale-revision checks, so those behave exactly as before.
        const revision = existing.revisions.find(item => item.number === expected);
        if (outcome === 'accepted' && revision.expired) {
          throw new Conflict(`Revision ${expected} expired after ${formatEastern(revision.expires_at)} and can no `
            + 'longer be accepted. Decline it, or revise the quote to issue a fresh one at the current rates.');
        }
        db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?)')
          .run(id, expected, outcome, clock().toISOString());
        db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(outcome, id);
      });
    },
  };
}
