import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { defaultRateProfile, estimate } from './pricing.js';
import { openRepository } from './repository.js';

// Written out literally, not copied from pricing.js, so a silent change to the defaults fails here.
const DEMO_1 = {
  version: 'demo-1',
  bathroomCents: 1800,
  services: {
    standard: { squareFootCents: 10, minimumCents: 9000 },
    deep: { squareFootCents: 17, minimumCents: 14000 },
    moveout: { squareFootCents: 21, minimumCents: 18000 },
  },
};

// The schema exactly as the baseline release (commit caa53c7) created it.
const BASELINE_SCHEMA = `
    PRAGMA foreign_keys = ON;
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
`;

// Snapshot JSON as written by the baseline code (no rates) and by the rate-profile refactor.
const legacyDeep = '{"scope":{"service":"deep","squareFeet":1000,"bathrooms":2},'
  + '"lines":[{"label":"Floor area","cents":17000},{"label":"Bathrooms","cents":3600}],'
  + '"totalCents":20600,"rateVersion":"demo-1"}';
const legacyDeepRevised = legacyDeep.replace('"squareFeet":1000', '"squareFeet":1200')
  .replace('"cents":17000', '"cents":20400').replace('20600', '24000');
const recordedCondo = '{"scope":{"service":"standard","squareFeet":600,"bathrooms":1},'
  + '"lines":[{"label":"Floor area","cents":6000},{"label":"Bathrooms","cents":1800},'
  + '{"label":"Service minimum","cents":1200}],"totalCents":9000,"rateVersion":"demo-1",'
  + '"rates":{"squareFootCents":10,"bathroomCents":1800,"minimumCents":9000}}';
const legacyTownhouse = '{"scope":{"service":"deep","squareFeet":1750,"bathrooms":3},'
  + '"lines":[{"label":"Floor area","cents":29750},{"label":"Bathrooms","cents":5400}],'
  + '"totalCents":35150,"rateVersion":"demo-1"}';

// node:sqlite returns null-prototype rows; strict deepEqual needs plain objects.
const plain = rows => rows.map(row => ({ ...row }));

const HISTORY_TABLES = ['customers', 'quotes', 'revisions', 'decisions', 'bookings'];

function createBaselineDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(BASELINE_SCHEMA);
  db.exec(`
    INSERT INTO customers VALUES (1, 'Sample Apartment', 'Unit B'), (2, 'Sample Condo', 'North'),
      (3, 'Sample Townhouse', 'Corner');
    INSERT INTO quotes VALUES (1, 1, 'Deep clean', 'accepted', 2), (2, 2, 'Routine', 'draft', 1),
      (3, 3, 'Deep cleaning', 'declined', 1);
  `);
  const revision = db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?)');
  revision.run(1, 1, legacyDeep, '2025-01-02T10:00:00.000Z');
  revision.run(1, 2, legacyDeepRevised, '2025-01-03T10:00:00.000Z');
  revision.run(2, 1, recordedCondo, '2025-01-04T10:00:00.000Z');
  revision.run(3, 1, legacyTownhouse, '2025-01-05T10:00:00.000Z');
  db.exec(`
    INSERT INTO decisions VALUES (1, 2, 'accepted', '2025-01-06T10:00:00.000Z'),
      (3, 1, 'declined', '2025-01-07T10:00:00.000Z');
    INSERT INTO bookings VALUES (1, 1, '2030-05-06', 540, 660, 2, 'cancelled'),
      (2, 1, '2030-05-07', 600, 720, 1, 'scheduled');
  `);
  db.close();
}

function dump(file) {
  const db = new DatabaseSync(file);
  try {
    const rows = Object.fromEntries(HISTORY_TABLES.map(table =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE tbl_name IN (${HISTORY_TABLES.map(() => '?').join(',')}) ORDER BY name`).all(...HISTORY_TABLES);
    return { rows, schema };
  } finally {
    db.close();
  }
}

function rawProfiles(file) {
  const db = new DatabaseSync(file);
  try {
    return {
      profiles: plain(db.prepare('SELECT * FROM rate_profiles ORDER BY id').all()),
      services: plain(db.prepare('SELECT * FROM rate_profile_services ORDER BY rowid').all()),
    };
  } finally {
    db.close();
  }
}

const withoutCreatedAt = ({ createdAt, ...profile }) => profile;
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function withTempDir(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-rate-profiles-'));
  try {
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('initial rate profile', () => {
  test('matches the existing default rates exactly', () => withTempDir(async dir => {
    const file = join(dir, 'new.sqlite');
    const repository = openRepository(file);
    const [stored, ...others] = repository.rateProfiles();
    repository.close();
    assert.equal(others.length, 0);
    assert.deepEqual(withoutCreatedAt(stored), DEMO_1);
    assert.deepEqual(withoutCreatedAt(stored), structuredClone(defaultRateProfile));
    assert.ok(!Number.isNaN(Date.parse(stored.createdAt)));

    const { profiles, services } = rawProfiles(file);
    assert.deepEqual(profiles.map(({ created_at, ...row }) => row),
      [{ id: 1, version: 'demo-1', bathroom_cents: 1800 }]);
    assert.deepEqual(services, [
      { profile_id: 1, service: 'standard', square_foot_cents: 10, minimum_cents: 9000 },
      { profile_id: 1, service: 'deep', square_foot_cents: 17, minimum_cents: 14000 },
      { profile_id: 1, service: 'moveout', square_foot_cents: 21, minimum_cents: 18000 },
    ]);
  }));

  test('prices every scope identically to the built-in default', () => withTempDir(async dir => {
    const repository = openRepository(join(dir, 'new.sqlite'));
    const [stored] = repository.rateProfiles();
    repository.close();
    for (const service of ['standard', 'deep', 'moveout']) {
      for (const squareFeet of [100, 600, 900, 1000, 1200, 1750, 20000]) {
        for (const bathrooms of [0, 1, 2, 3, 20]) {
          const fields = { service, squareFeet, bathrooms };
          assert.deepEqual(estimate(fields, stored), estimate(fields));
        }
      }
    }
  }));

  test('is also present in in-memory demo databases', () => {
    const repository = openRepository(':memory:');
    try {
      assert.deepEqual(repository.rateProfiles().map(withoutCreatedAt), [DEMO_1]);
    } finally {
      repository.close();
    }
  });
});

describe('persistence', () => {
  test('stored profiles survive closing and reopening unchanged', () => withTempDir(async dir => {
    const file = join(dir, 'persist.sqlite');
    let repository = openRepository(file);
    const first = repository.rateProfiles();
    repository.close();

    // A second version inserted directly stands in for a future publish step.
    const db = new DatabaseSync(file);
    db.exec(`INSERT INTO rate_profiles VALUES (2, 'test-2', 2500, '2026-02-01T00:00:00.000Z');
      INSERT INTO rate_profile_services VALUES (2, 'deep', 20, 15000);`);
    db.close();

    for (let open = 0; open < 3; open++) {
      repository = openRepository(file);
      const profiles = repository.rateProfiles();
      repository.close();
      assert.deepEqual(profiles[0], first[0], 'demo-1 including createdAt is unchanged');
      assert.deepEqual(profiles[1], {
        version: 'test-2', createdAt: '2026-02-01T00:00:00.000Z', bathroomCents: 2500,
        services: { deep: { squareFootCents: 20, minimumCents: 15000 } },
      });
      assert.equal(estimate({ service: 'deep', squareFeet: 1000, bathrooms: 2 }, profiles[1]).totalCents, 25000);
    }
  }));

  test('reopening an initialized database does not write to it', () => withTempDir(async dir => {
    const file = join(dir, 'quiet.sqlite');
    openRepository(file).close();
    const before = await sha256(file);
    openRepository(file).close();
    openRepository(file).close();
    assert.equal(await sha256(file), before);
  }));

  test('stored profiles cannot be changed, removed, or given fractional cents', () => withTempDir(async dir => {
    const file = join(dir, 'immutable.sqlite');
    openRepository(file).close();
    const before = rawProfiles(file);
    const db = new DatabaseSync(file);
    try {
      for (const sql of [
        'UPDATE rate_profiles SET bathroom_cents = 1900',
        'DELETE FROM rate_profiles',
        "UPDATE rate_profile_services SET square_foot_cents = 18 WHERE service = 'deep'",
        'DELETE FROM rate_profile_services',
      ]) {
        assert.throws(() => db.exec(sql), /Rate profiles are immutable/, sql);
      }
      assert.throws(() => db.exec(
        "INSERT INTO rate_profiles (version, bathroom_cents, created_at) VALUES ('demo-1', 1800, 'x')"),
      /UNIQUE/);
      for (const [version, cents] of [['half', 17.5], ['negative', -1], ['huge', 1_000_001]]) {
        assert.throws(() => db.prepare(
          'INSERT INTO rate_profiles (version, bathroom_cents, created_at) VALUES (?, ?, ?)')
          .run(version, cents, 'x'), /constraint|cannot store/i, version);
      }
      assert.throws(() => db.exec(
        "INSERT INTO rate_profiles (version, bathroom_cents, created_at) VALUES ('  ', 0, 'x')"),
      /CHECK/);
    } finally {
      db.close();
    }
    assert.deepEqual(rawProfiles(file), before);
  }));
});

describe('upgrading existing databases', () => {
  test('adds the demo-1 profile without changing any history', () => withTempDir(async dir => {
    const file = join(dir, 'baseline.sqlite');
    createBaselineDatabase(file);
    const before = dump(file);
    assert.equal(before.rows.revisions.length, 4);

    const repository = openRepository(file);
    try {
      assert.deepEqual(repository.rateProfiles().map(withoutCreatedAt), [DEMO_1]);
      const accepted = repository.quote(1);
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(accepted.revisions.map(item => item.estimate.totalCents), [24000, 20600]);
      assert.equal(accepted.decision.revision, 2);
      assert.deepEqual(accepted.bookings.map(item => item.status), ['scheduled', 'cancelled']);
      assert.equal(repository.quote(2).revisions[0].estimate.totalCents, 9000);
      assert.equal(repository.quote(3).decision.outcome, 'declined');
    } finally {
      repository.close();
    }

    const after = dump(file);
    assert.equal(after.rows.bookings.length, before.rows.bookings.length);
    for (const row of after.rows.bookings) assert.equal(row.recurring_visit_id, null);
    const legacyBookings = after.rows.bookings.map(({ recurring_visit_id, ...row }) =>
      Object.assign(Object.create(null), row));
    assert.deepEqual({ ...after.rows, bookings: legacyBookings }, before.rows, 'historical values are unchanged');
    const unrelatedSchema = rows => rows.filter(item => item.tbl_name !== 'bookings');
    assert.deepEqual(unrelatedSchema(after.schema), unrelatedSchema(before.schema));
    const db = new DatabaseSync(file);
    try {
      assert.deepEqual(plain(db.prepare('PRAGMA integrity_check').all()), [{ integrity_check: 'ok' }]);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  }));

  test('upgraded databases keep working for quotes, decisions, and bookings', () => withTempDir(async dir => {
    const file = join(dir, 'baseline.sqlite');
    createBaselineDatabase(file);
    openRepository(file).close();
    const before = dump(file).rows;

    const repository = openRepository(file);
    try {
      repository.revise(2, 1, { service: 'standard', squareFeet: 1000, bathrooms: 1 });
      repository.decide(2, 2, 'accepted');
      repository.changeBooking(2, 1, { date: '2030-05-08', start: '09:00', duration: '120' }, false);
      const customer = repository.addCustomer({ name: 'New', reference: 'After upgrade' });
      assert.equal(repository.quote(repository.addQuote(customer,
        { title: 'New', service: 'deep', squareFeet: 1000, bathrooms: 2 })).revisions[0].estimate.totalCents, 20600);
    } finally {
      repository.close();
    }

    const after = dump(file).rows;
    const key = row => JSON.stringify(row);
    for (const table of HISTORY_TABLES) {
      const unchanged = new Set(after[table].map(key));
      for (const row of before[table]) {
        if (table === 'quotes' && row.id === 2) continue; // the draft that was revised and accepted
        if (table === 'bookings' && row.id === 2) continue; // the booking that was rescheduled
        assert.ok(unchanged.has(key(row)), table + ' row changed: ' + key(row));
      }
    }
    const revisions = new DatabaseSync(file);
    try {
      assert.equal(revisions.prepare('SELECT estimate FROM revisions WHERE quote_id = 1 AND number = 1')
        .get().estimate, legacyDeep);
    } finally {
      revisions.close();
    }
  }));
});

describe('repeated initialization', () => {
  test('reopening many times keeps exactly one demo-1 profile', () => withTempDir(async dir => {
    const file = join(dir, 'repeat.sqlite');
    openRepository(file).close();
    const first = rawProfiles(file);
    for (let open = 0; open < 10; open++) openRepository(file).close();
    assert.deepEqual(rawProfiles(file), first);
    assert.equal(first.profiles.length, 1);
    assert.equal(first.services.length, 3);
  }));

  test('overlapping connections in one process do not duplicate it', () => withTempDir(async dir => {
    const file = join(dir, 'overlap.sqlite');
    const connections = Array.from({ length: 4 }, () => openRepository(file));
    for (const connection of connections) assert.equal(connection.rateProfiles().length, 1);
    for (const connection of connections) connection.close();
    const { profiles, services } = rawProfiles(file);
    assert.equal(profiles.length, 1);
    assert.equal(services.length, 3);
  }));

  test('a failure part-way through seeding leaves no partial profile behind', () => withTempDir(async dir => {
    // Copy the real rate-profile table definitions, then add a trigger that fails on the last service.
    openRepository(join(dir, 'reference.sqlite')).close();
    const source = new DatabaseSync(join(dir, 'reference.sqlite'));
    const tables = source.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table'
      AND name IN ('rate_profiles', 'rate_profile_services') ORDER BY name DESC`).all();
    source.close();
    const file = join(dir, 'partial.sqlite');
    const db = new DatabaseSync(file);
    for (const { sql } of tables) db.exec(sql);
    db.exec(`CREATE TRIGGER sabotage BEFORE INSERT ON rate_profile_services WHEN NEW.service = 'moveout'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    db.close();

    assert.throws(() => openRepository(file), /simulated failure/);
    assert.deepEqual(rawProfiles(file), { profiles: [], services: [] });

    const fix = new DatabaseSync(file);
    fix.exec('DROP TRIGGER sabotage');
    fix.close();
    const repository = openRepository(file);
    try {
      assert.deepEqual(repository.rateProfiles().map(withoutCreatedAt), [DEMO_1]);
    } finally {
      repository.close();
    }
  }));

  test('separate processes opening a new database at once do not duplicate it', () => withTempDir(async dir => {
    const file = join(dir, 'race.sqlite');
    // Each child loads the module first, then waits for a shared start instant so the opens collide.
    const startAt = Date.now() + 1500;
    const script = `
      const { openRepository } = await import(${JSON.stringify(new URL('./repository.js', import.meta.url).href)});
      while (Date.now() < ${startAt});
      const repository = openRepository(${JSON.stringify(file)});
      // Raw write, not console.log: the test runner sets FORCE_COLOR=1 when attached to a terminal,
      // children inherit it, and console.log would then print the number wrapped in ANSI colour codes.
      process.stdout.write(String(repository.rateProfiles().length));
      repository.close();`;
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script])));
    assert.deepEqual(results.map(result => result.stdout.trim()), Array(8).fill('1'));
    const { profiles, services } = rawProfiles(file);
    assert.equal(profiles.length, 1);
    assert.equal(services.length, 3);
  }));
});
