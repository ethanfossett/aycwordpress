import { InputError, requiredText } from './pricing.js';

export function note(value, maximum = 500) {
  if (typeof value !== 'string' || value.trim().length > maximum) {
    throw new InputError('Use at most ' + maximum + ' characters.');
  }
  return value.trim();
}

export function migrateOperations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_details (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      access_notes TEXT NOT NULL,
      service_notes TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS service_locations (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      reference TEXT NOT NULL,
      access_notes TEXT NOT NULL,
      service_notes TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS default_service_location
      ON service_locations(customer_id) WHERE is_default = 1;
    CREATE TABLE IF NOT EXISTS quote_locations (
      quote_id INTEGER PRIMARY KEY REFERENCES quotes(id),
      location_id INTEGER NOT NULL REFERENCES service_locations(id)
    ) STRICT;
    INSERT OR IGNORE INTO service_locations (customer_id, reference, access_notes, service_notes, is_default)
      SELECT c.id, c.reference, coalesce(d.access_notes, ''), coalesce(d.service_notes, ''), 1
      FROM customers c LEFT JOIN customer_details d ON d.customer_id = c.id
      WHERE NOT EXISTS (
        SELECT 1 FROM service_locations l WHERE l.customer_id = c.id AND l.is_default = 1
      );
    CREATE TABLE IF NOT EXISTS booking_site_snapshots (
      booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),
      reference TEXT NOT NULL,
      access_notes TEXT NOT NULL,
      service_notes TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS crews (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
    ) STRICT;
    INSERT OR IGNORE INTO crews (id, name) VALUES (1, 'Default crew');
    CREATE TABLE IF NOT EXISTS booking_crews (
      booking_id INTEGER PRIMARY KEY REFERENCES bookings(id),
      crew_id INTEGER NOT NULL REFERENCES crews(id)
    ) STRICT;
    INSERT OR IGNORE INTO booking_crews SELECT id, 1 FROM bookings;
    CREATE TABLE IF NOT EXISTS crew_acknowledgments (
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      booking_version INTEGER NOT NULL,
      crew_id INTEGER NOT NULL REFERENCES crews(id),
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (booking_id, booking_version)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS booking_events (
      id INTEGER PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      kind TEXT NOT NULL CHECK(kind IN ('booked','rescheduled','cancelled','started','completed')),
      detail TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS booking_event_history ON booking_events(booking_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS booking_progress_once
      ON booking_events(booking_id, kind) WHERE kind IN ('started','completed');
    CREATE VIEW IF NOT EXISTS dispatch_bookings AS
      SELECT b.*, CASE
        WHEN b.status = 'cancelled' THEN 'cancelled'
        WHEN EXISTS (SELECT 1 FROM booking_events WHERE booking_id = b.id AND kind = 'completed') THEN 'completed'
        WHEN EXISTS (SELECT 1 FROM booking_events WHERE booking_id = b.id AND kind = 'started') THEN 'in_progress'
        ELSE 'scheduled'
      END AS job_state FROM bookings b;
  `);
}

export function customerFields(fields) {
  return {
    name: requiredText(fields.name, 'Name'),
    reference: requiredText(fields.reference, 'Site reference'),
    access: note(fields.access ?? ''),
    notes: note(fields.notes ?? ''),
  };
}
