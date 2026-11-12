import { DatabaseSync } from 'node:sqlite';
import { estimate, InputError, requiredText } from './pricing.js';

import { bookingSlot, scheduleDate } from './scheduling.js';

export class NotFound extends Error {}
export class Conflict extends Error {}

export function openRepository(file) {
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
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking
      ON bookings(quote_id) WHERE status = 'scheduled';
    CREATE INDEX IF NOT EXISTS booking_calendar ON bookings(day, status, start_minute);
    CREATE INDEX IF NOT EXISTS quotes_customer ON quotes(customer_id);
  `);

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

  function customer(id) {
    const record = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!record) throw new NotFound('Customer not found.');
    return record;
  }

  function quote(id) {
    const record = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    if (!record) throw new NotFound('Quote not found.');
    const revisions = db.prepare('SELECT * FROM revisions WHERE quote_id = ? ORDER BY number DESC')
      .all(id).map(row => ({ ...row, estimate: JSON.parse(row.estimate) }));
    const decision = db.prepare('SELECT * FROM decisions WHERE quote_id = ?').get(id);
    const bookings = db.prepare('SELECT * FROM bookings WHERE quote_id = ? ORDER BY id DESC').all(id);
    return { ...record, revisions, decision, bookings };
  }

  function recordRevision(id, revision, snapshot) {
    db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?)')
      .run(id, revision, JSON.stringify(snapshot), new Date().toISOString());
  }

  function currentDraft(id, expected) {
    const record = quote(id);
    if (record.status !== 'draft' || record.current_revision !== expected) {
      throw new Conflict('The quote has changed. Reload it before continuing.');
    }
    return record;
  }

  function booking(id) {
    const record = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!record) throw new NotFound('Booking not found.');
    return record;
  }

  function requireAvailable(slot, ignoreId = 0) {
    const conflict = db.prepare(`
      SELECT id FROM bookings WHERE day = ? AND status = 'scheduled'
      AND start_minute < ? AND end_minute > ? AND id <> ?
    `).get(slot.date, slot.end, slot.start, ignoreId);
    if (conflict) throw new Conflict('That time overlaps another scheduled job.');
  }

  return {
    booking,
    schedule(date) {
      return db.prepare(`
        SELECT b.*, q.title, c.name FROM bookings b
        JOIN quotes q ON q.id = b.quote_id JOIN customers c ON c.id = q.customer_id
        WHERE b.day = ? ORDER BY b.start_minute, b.id
      `).all(scheduleDate(date));
    },
    scheduleQuote(id, fields) {
      const slot = bookingSlot(fields);
      return transaction(() => {
        const record = quote(id);
        if (record.status !== 'accepted') throw new Conflict('Accept the quote before booking.');
        const existing = record.bookings.find(item => item.status === 'scheduled');
        if (existing) {
          if (existing.day === slot.date && existing.start_minute === slot.start
            && existing.end_minute === slot.end) return existing.id;
          throw new Conflict('This quote already has an active booking.');
        }
        requireAvailable(slot);
        return Number(db.prepare(`
          INSERT INTO bookings (quote_id, day, start_minute, end_minute) VALUES (?, ?, ?, ?)
        `).run(id, slot.date, slot.start, slot.end).lastInsertRowid);
      });
    },
    changeBooking(id, expected, fields, cancel) {
      const slot = cancel ? null : bookingSlot(fields);
      return transaction(() => {
        const record = booking(id);
        if (record.version !== expected || record.status !== 'scheduled') {
          throw new Conflict('The booking has changed. Reload it before continuing.');
        }
        if (cancel) {
          db.prepare("UPDATE bookings SET status = 'cancelled', version = version + 1 WHERE id = ?").run(id);
        } else {
          requireAvailable(slot, id);
          db.prepare(`
            UPDATE bookings SET day = ?, start_minute = ?, end_minute = ?, version = version + 1 WHERE id = ?
          `).run(slot.date, slot.start, slot.end, id);
        }
      });
    },
    close: () => db.close(),
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
      return Number(db.prepare('INSERT INTO customers (name, reference) VALUES (?, ?)')
        .run(name, reference).lastInsertRowid);
    },
    addQuote(customerId, fields) {
      const title = requiredText(fields.title, 'Job title');
      const snapshot = estimate(fields);
      return transaction(() => {
        customer(customerId);
        const id = Number(db.prepare('INSERT INTO quotes (customer_id, title) VALUES (?, ?)')
          .run(customerId, title).lastInsertRowid);
        recordRevision(id, 1, snapshot);
        return id;
      });
    },
    revise(id, expected, fields) {
      const snapshot = estimate(fields);
      return transaction(() => {
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
        db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?)')
          .run(id, expected, outcome, new Date().toISOString());
        db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(outcome, id);
      });
    },
  };
}
