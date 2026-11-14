import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { expirationFor, formatEastern, isExpired, QUOTE_VALID_DAYS } from './expiration.js';
import { Conflict, openRepository } from './repository.js';
import { app } from './server.js';

const DEEP = { title: 'Deep clean', service: 'deep', squareFeet: '1000', bathrooms: '2' };
const V2 = {
  version: 'v2', bathroomCents: 2000,
  services: {
    standard: { squareFootCents: 11, minimumCents: 9500 },
    deep: { squareFootCents: 18, minimumCents: 15000 },
    moveout: { squareFootCents: 22, minimumCents: 19000 },
  },
};
// Issued at noon Eastern (EDT) on Wed May 1, 2030: valid through 11:59 PM Eastern on Wed May 15.
const ISSUED = '2030-05-01T16:00:00.000Z';
const LAST_MS = '2030-05-16T03:59:59.999Z';
const FIRST_EXPIRED_MS = '2030-05-16T04:00:00.000Z';

const plain = rows => rows.map(row => ({ ...row }));
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');

function controllableClock(start) {
  let current = new Date(start);
  return { now: () => new Date(current), set: iso => { current = new Date(iso); } };
}

function rows(file, sql, ...params) {
  const db = new DatabaseSync(file);
  try {
    return plain(db.prepare(sql).all(...params));
  } finally {
    db.close();
  }
}

async function withRepository(action, start = ISSUED) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-expiration-'));
  const file = join(dir, 'quotes.sqlite');
  const clock = controllableClock(start);
  const repository = openRepository(file, { now: clock.now });
  try {
    return await action({ repository, clock, file });
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function withApp(action, start = ISSUED) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-expiration-app-'));
  const file = join(dir, 'quotes.sqlite');
  const clock = controllableClock(start);
  const server = app(file, { now: clock.now }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, fields) => fetch(base + path, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  const page = async path => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    return response.text();
  };
  try {
    return await action({ post, page, clock, file });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

const newQuote = repository => repository.addQuote(repository.addCustomer({ name: 'A', reference: 'B' }), DEEP);
const acceptButton = /<button name="outcome" value="accepted">Accept quote<\/button>/;
const declineButton = /<button name="outcome" value="declined">Decline quote<\/button>/;

describe('the 14-day Eastern expiration rule', () => {
  test('expires at 11:59 PM Eastern on the 14th calendar day after issue', () => {
    assert.equal(QUOTE_VALID_DAYS, 14);
    const cases = {
      'midday, daylight time': ['2030-05-01T16:00:00.000Z', '2030-05-16T03:59:59.999Z'],
      'midday, standard time': ['2030-01-05T17:00:00.000Z', '2030-01-20T04:59:59.999Z'],
      'first instant of the Eastern day': ['2030-05-01T04:00:00.000Z', '2030-05-16T03:59:59.999Z'],
      'last instant of the Eastern day': ['2030-05-02T03:59:59.999Z', '2030-05-16T03:59:59.999Z'],
      '11:30 PM Eastern, already tomorrow in UTC': ['2030-05-02T03:30:00.000Z', '2030-05-16T03:59:59.999Z'],
      'issued in standard time, expires in daylight time': ['2030-03-01T17:00:00.000Z', '2030-03-16T03:59:59.999Z'],
      'issued in daylight time, expires in standard time': ['2030-10-25T16:00:00.000Z', '2030-11-09T04:59:59.999Z'],
      'issued on the spring-forward day': ['2030-03-10T16:00:00.000Z', '2030-03-25T03:59:59.999Z'],
      'issued on the fall-back day': ['2030-11-03T16:00:00.000Z', '2030-11-18T04:59:59.999Z'],
      'year rollover': ['2030-12-25T17:00:00.000Z', '2031-01-09T04:59:59.999Z'],
      'leap-year February': ['2032-02-20T17:00:00.000Z', '2032-03-06T04:59:59.999Z'],
      'non-leap-year February': ['2031-02-20T17:00:00.000Z', '2031-03-07T04:59:59.999Z'],
    };
    for (const [name, [issued, expires]] of Object.entries(cases)) {
      assert.equal(expirationFor(new Date(issued)), expires, name);
      assert.match(formatEastern(expires), /, 11:59 PM Eastern$/, name);
    }
  });

  test('is valid through the last millisecond and expired from the next one', () => {
    const expiresAt = expirationFor(new Date(ISSUED));
    assert.equal(isExpired(expiresAt, new Date(ISSUED)), false);
    assert.equal(isExpired(expiresAt, new Date(LAST_MS)), false);
    assert.equal(isExpired(expiresAt, new Date(FIRST_EXPIRED_MS)), true);
    assert.equal(isExpired(null, new Date('2099-01-01T00:00:00Z')), false, 'no timestamp never expires');
    assert.equal(formatEastern(expiresAt), 'Wed, May 15, 2030, 11:59 PM Eastern');
  });
});

describe('saving expiration with each revision', () => {
  test('each new revision stores its own expiration from the clock', () => withRepository(({ repository, clock, file }) => {
    const id = newQuote(repository);
    clock.set('2030-05-10T14:00:00.000Z');
    repository.revise(id, 1, { ...DEEP, squareFeet: '1200' });
    assert.deepEqual(rows(file, 'SELECT * FROM revision_expirations ORDER BY number'), [
      { quote_id: id, number: 1, expires_at: '2030-05-16T03:59:59.999Z' },
      { quote_id: id, number: 2, expires_at: '2030-05-25T03:59:59.999Z' },
    ]);
    assert.deepEqual(rows(file, 'SELECT number, created_at FROM revisions ORDER BY number'),
      [{ number: 1, created_at: ISSUED }, { number: 2, created_at: '2030-05-10T14:00:00.000Z' }]);
    const [second, first] = repository.quote(id).revisions;
    assert.deepEqual([first.expires_at, first.expired, second.expires_at, second.expired],
      ['2030-05-16T03:59:59.999Z', false, '2030-05-25T03:59:59.999Z', false]);
  }));

  test('pricing snapshots are unchanged by expiration', () => withRepository(({ repository }) => {
    const [revision] = repository.quote(newQuote(repository)).revisions;
    assert.deepEqual(Object.keys(revision.estimate), ['scope', 'lines', 'totalCents', 'rateVersion', 'rates']);
    assert.equal(revision.estimate.totalCents, 20600);
  }));

  test('rejected operations store no expiration', () => withRepository(({ repository, file }) => {
    const id = newQuote(repository);
    const before = rows(file, 'SELECT * FROM revision_expirations');
    assert.throws(() => repository.revise(id, 1, { ...DEEP, bathrooms: '2.5' }));
    assert.throws(() => repository.revise(id, 9, DEEP), Conflict);
    assert.throws(() => repository.addQuote(999, DEEP));
    assert.deepEqual(rows(file, 'SELECT * FROM revision_expirations'), before);
  }));

  test('stored expirations cannot be changed or deleted', () => withRepository(({ repository, file }) => {
    newQuote(repository);
    const before = rows(file, 'SELECT * FROM revision_expirations');
    const db = new DatabaseSync(file);
    try {
      assert.throws(() => db.exec("UPDATE revision_expirations SET expires_at = '2099-01-01T00:00:00.000Z'"),
        /Revision expirations are immutable/);
      assert.throws(() => db.exec('DELETE FROM revision_expirations'), /Revision expirations are immutable/);
    } finally {
      db.close();
    }
    assert.deepEqual(rows(file, 'SELECT * FROM revision_expirations'), before);
  }));

  test('an invalid clock is rejected with a clear error', () => {
    for (const bad of [() => new Date('not a date'), () => '2030-05-01T16:00:00Z', () => undefined]) {
      assert.throws(() => openRepository(':memory:', { now: bad }), /^TypeError: The clock must return a valid Date\.$/);
    }
  });
});

describe('acceptance at the expiration boundary', () => {
  const boundaries = {
    'daylight time': [ISSUED, LAST_MS, FIRST_EXPIRED_MS],
    'standard time': ['2030-01-05T17:00:00.000Z', '2030-01-20T04:59:59.999Z', '2030-01-20T05:00:00.000Z'],
    'issued in standard time, expiring in daylight time':
      ['2030-03-01T17:00:00.000Z', '2030-03-16T03:59:59.999Z', '2030-03-16T04:00:00.000Z'],
    'issued late evening Eastern (next day in UTC)':
      ['2030-05-02T03:30:00.000Z', LAST_MS, FIRST_EXPIRED_MS],
  };
  for (const [name, [issued, last, expired]] of Object.entries(boundaries)) {
    test(`${name}: accepted at the last millisecond`, () => withRepository(({ repository, clock }) => {
      const id = newQuote(repository);
      clock.set(last);
      repository.decide(id, 1, 'accepted');
      assert.equal(repository.quote(id).status, 'accepted');
      assert.equal(repository.quote(id).decision.created_at, last);
    }, issued));

    test(`${name}: rejected one millisecond later, with nothing saved`, () => withRepository(async ({ repository, clock, file }) => {
      const id = newQuote(repository);
      clock.set(expired);
      const before = await sha256(file);
      assert.throws(() => repository.decide(id, 1, 'accepted'),
        error => error instanceof Conflict && /^Revision 1 expired after .*, 11:59 PM Eastern and can no longer be accepted\. Decline it, or revise the quote/.test(error.message));
      assert.equal(await sha256(file), before);
      assert.equal(repository.quote(id).status, 'draft');
      assert.equal(repository.quote(id).decision, undefined);
    }, issued));
  }

  test('the quote page hides Accept once expired, and the server refuses a stale Accept', () => withApp(async ({ post, page, clock }) => {
    const customer = (await post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
    const quote = (await post(customer + '/quotes', DEEP)).headers.get('location');
    let html = await page(quote);
    assert.match(html, /<p>Valid until Wed, May 15, 2030, 11:59 PM Eastern\.<\/p>/);
    assert.match(html, /<strong>Revision 1: Valid until Wed, May 15, 2030, 11:59 PM Eastern\.<\/strong>/);
    assert.match(html, acceptButton);

    clock.set(LAST_MS);
    assert.match(await page(quote), acceptButton);

    clock.set(FIRST_EXPIRED_MS);
    html = await page(quote);
    assert.match(html, /<p>Expired after Wed, May 15, 2030, 11:59 PM Eastern\.<\/p>/);
    assert.match(html, /Revision 1 expired after Wed, May 15, 2030, 11:59 PM Eastern\. It can no longer be\s+accepted\. Decline it, or save a revision/);
    assert.doesNotMatch(html, acceptButton);
    assert.match(html, declineButton);
    assert.match(html, /<button>Save revision<\/button>/);
    assert.match(html, /· draft<\/p>/, 'no new quote status');

    const response = await post(quote + '/decision', { revision: '1', outcome: 'accepted' });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /<h1>Revision 1 expired after Wed, May 15, 2030, 11:59 PM Eastern and can no longer be accepted\./);
  }));
});

describe('after expiration: decline or revise', () => {
  test('an expired revision can be declined', () => withRepository(({ repository, clock }) => {
    const id = newQuote(repository);
    clock.set('2030-06-30T12:00:00.000Z');
    repository.decide(id, 1, 'declined');
    const quote = repository.quote(id);
    assert.deepEqual([quote.status, quote.decision.revision, quote.decision.outcome], ['declined', 1, 'declined']);
  }));

  test('revising issues a fresh quote at the current active rates with a new 14-day window', () =>
    withRepository(({ repository, clock, file }) => {
      const id = newQuote(repository);
      const original = rows(file, 'SELECT * FROM revisions');
      clock.set('2030-06-03T13:00:00.000Z');
      repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
      repository.revise(id, 1, DEEP);
      const [fresh, old] = repository.quote(id).revisions;
      assert.deepEqual([old.expired, old.estimate.totalCents, old.estimate.rateVersion], [true, 20600, 'demo-1']);
      assert.deepEqual([fresh.expired, fresh.expires_at, fresh.estimate.totalCents, fresh.estimate.rateVersion],
        [false, '2030-06-18T03:59:59.999Z', 22000, 'v2']);
      assert.deepEqual(rows(file, 'SELECT * FROM revisions WHERE number = 1'), original, 'old revision untouched');

      clock.set('2030-06-18T03:59:59.999Z');
      repository.decide(id, 2, 'accepted');
      assert.equal(repository.quote(id).status, 'accepted');
    }));

  test('a fresh revision expires on its own schedule', () => withRepository(({ repository, clock }) => {
    const id = newQuote(repository);
    clock.set('2030-06-03T13:00:00.000Z');
    repository.revise(id, 1, DEEP);
    clock.set('2030-06-18T04:00:00.000Z');
    assert.throws(() => repository.decide(id, 2, 'accepted'), /Revision 2 expired after Mon, Jun 17, 2030/);
  }));

  test('a stale revision number is still reported as stale, not expired', () => withRepository(({ repository, clock }) => {
    const id = newQuote(repository);
    clock.set(FIRST_EXPIRED_MS);
    repository.revise(id, 1, DEEP);
    assert.throws(() => repository.decide(id, 1, 'accepted'), /The quote has changed\. Reload it before continuing\./);
    assert.throws(() => repository.decide(id, 1, 'declined'), /The quote has changed/);
  }));

  test('the HTTP revise-then-accept flow works after expiry', () => withApp(async ({ post, page, clock }) => {
    const customer = (await post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
    const quote = (await post(customer + '/quotes', DEEP)).headers.get('location');
    clock.set('2030-06-03T13:00:00.000Z');
    assert.equal((await post(quote + '/revise', { ...DEEP, revision: '1' })).status, 303);
    const html = await page(quote);
    assert.match(html, /Revision 2 · \$206\.00\s*<\/h3>\s*<p>Valid until Mon, Jun 17, 2030, 11:59 PM Eastern\.<\/p>/);
    assert.match(html, /Revision 1 · \$206\.00\s*<\/h3>\s*<p>Expired after Wed, May 15, 2030, 11:59 PM Eastern\.<\/p>/);
    assert.match(html, acceptButton);
    assert.equal((await post(quote + '/decision', { revision: '2', outcome: 'accepted' })).status, 303);
    assert.match(await page(quote), /Revision 2 accepted/);
  }));
});

describe('repeat decisions', () => {
  test('repeating an acceptance made in time still succeeds after expiry', () => withApp(async ({ post, page, clock, file }) => {
    const customer = (await post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
    const quote = (await post(customer + '/quotes', DEEP)).headers.get('location');
    clock.set(LAST_MS);
    assert.equal((await post(quote + '/decision', { revision: '1', outcome: 'accepted' })).status, 303);
    const decisions = rows(file, 'SELECT * FROM decisions');
    clock.set('2030-07-01T12:00:00.000Z');
    assert.equal((await post(quote + '/decision', { revision: '1', outcome: 'accepted' })).status, 303);
    assert.equal((await post(quote + '/decision', { revision: '1', outcome: 'declined' })).status, 409);
    assert.deepEqual(rows(file, 'SELECT * FROM decisions'), decisions);
    const html = await page(quote);
    assert.match(html, /Revision 1 accepted/);
    assert.doesNotMatch(html, /can no longer be/, 'accepted quotes show no expiry warning');
  }));

  test('repeating a decline after expiry is idempotent', () => withRepository(({ repository, clock, file }) => {
    const id = newQuote(repository);
    clock.set('2030-06-30T12:00:00.000Z');
    repository.decide(id, 1, 'declined');
    const decisions = rows(file, 'SELECT * FROM decisions');
    clock.set('2030-08-30T12:00:00.000Z');
    repository.decide(id, 1, 'declined');
    assert.throws(() => repository.decide(id, 1, 'accepted'), /The quote has changed/);
    assert.deepEqual(rows(file, 'SELECT * FROM decisions'), decisions);
  }));
});

describe('historical compatibility', () => {
  function insertLegacyQuote(file, id, status = 'draft') {
    const db = new DatabaseSync(file);
    try {
      db.prepare("INSERT INTO customers (id, name, reference) VALUES (?, 'Legacy', 'Old') ON CONFLICT DO NOTHING").run(id);
      db.prepare('INSERT INTO quotes (id, customer_id, title, status) VALUES (?, ?, ?, ?)').run(id, id, 'Legacy', status);
      db.prepare("INSERT INTO revisions VALUES (?, 1, ?, '2020-01-02T15:00:00.000Z')").run(id,
        '{"scope":{"service":"deep","squareFeet":1000,"bathrooms":2},"lines":[{"label":"Floor area","cents":17000},'
        + '{"label":"Bathrooms","cents":3600}],"totalCents":20600,"rateVersion":"demo-1"}');
    } finally {
      db.close();
    }
  }

  test('revisions saved before expiration existed never expire and can still be accepted', () =>
    withApp(async ({ post, page, clock, file }) => {
      insertLegacyQuote(file, 40);
      clock.set('2035-01-01T12:00:00.000Z');
      const html = await page('/quotes/40');
      assert.match(html, /<p>No expiration date \(issued before quotes expired\)\.<\/p>/);
      assert.match(html, /Revision 1: No expiration date/);
      assert.match(html, acceptButton);
      assert.equal((await post('/quotes/40/decision', { revision: '1', outcome: 'accepted' })).status, 303);
      assert.deepEqual(rows(file, 'SELECT * FROM revision_expirations'), [], 'no expiration invented for old revisions');
    }));

  test('revising an old draft gives only the new revision an expiration', () => withRepository(({ repository, clock, file }) => {
    insertLegacyQuote(file, 41);
    const legacy = rows(file, 'SELECT * FROM revisions');
    repository.revise(41, 1, DEEP);
    assert.deepEqual(rows(file, 'SELECT quote_id, number FROM revision_expirations'), [{ quote_id: 41, number: 2 }]);
    assert.deepEqual(rows(file, 'SELECT * FROM revisions WHERE number = 1'), legacy);
    const [fresh, old] = repository.quote(41).revisions;
    assert.deepEqual([old.expires_at, old.expired, fresh.expired], [null, false, false]);
    clock.set(FIRST_EXPIRED_MS);
    assert.throws(() => repository.decide(41, 2, 'accepted'), /expired/);
  }));

  test('existing accepted and declined quotes, totals, and rows are untouched by the clock', () =>
    withRepository(({ repository, clock, file }) => {
      insertLegacyQuote(file, 42);
      repository.decide(42, 1, 'accepted');
      repository.scheduleQuote(42, { date: '2030-05-06', start: '09:00', duration: '120' });
      const id = newQuote(repository);
      repository.decide(id, 1, 'declined');
      const before = ['revisions', 'decisions', 'bookings', 'quotes', 'revision_expirations']
        .map(table => rows(file, `SELECT * FROM ${table} ORDER BY rowid`));
      for (const time of [FIRST_EXPIRED_MS, '2031-01-01T00:00:00.000Z', '2040-01-01T00:00:00.000Z']) {
        clock.set(time);
        assert.equal(repository.quote(42).status, 'accepted');
        assert.equal(repository.quote(42).revisions[0].estimate.totalCents, 20600);
        assert.equal(repository.quote(id).status, 'declined');
      }
      assert.deepEqual(['revisions', 'decisions', 'bookings', 'quotes', 'revision_expirations']
        .map(table => rows(file, `SELECT * FROM ${table} ORDER BY rowid`)), before);
    }));

  test('opening an existing database only adds the empty expiration table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ayc-expiration-upgrade-'));
    const file = join(dir, 'old.sqlite');
    try {
      // Build a database as it was before this feature: same tables, no revision_expirations.
      openRepository(file).close();
      const db = new DatabaseSync(file);
      db.exec(`DROP TRIGGER revision_expirations_no_update; DROP TRIGGER revision_expirations_no_delete;
        DROP TABLE revision_expirations;`);
      db.close();
      insertLegacyQuote(file, 43);
      const schema = () => rows(file, `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE tbl_name <> 'revision_expirations' ORDER BY name`);
      const data = () => ['customers', 'quotes', 'revisions', 'decisions', 'bookings']
        .map(table => rows(file, `SELECT * FROM ${table} ORDER BY rowid`));
      const [schemaBefore, dataBefore] = [schema(), data()];

      const reopened = openRepository(file, { now: () => new Date('2040-01-01T00:00:00Z') });
      try {
        assert.deepEqual([reopened.quote(43).revisions[0].expires_at, reopened.quote(43).revisions[0].expired], [null, false]);
      } finally {
        reopened.close();
      }
      assert.deepEqual(schema(), schemaBefore, 'no existing table or index changed');
      assert.deepEqual(data(), dataBefore, 'no existing row changed');
      assert.deepEqual(rows(file, 'SELECT * FROM revision_expirations'), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('booking workflows', () => {
  test('a quote accepted in time can be booked, rescheduled, and cancelled after it expires', () =>
    withApp(async ({ post, page, clock }) => {
      const customer = (await post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
      const quote = (await post(customer + '/quotes', DEEP)).headers.get('location');
      assert.equal((await post(quote + '/decision', { revision: '1', outcome: 'accepted' })).status, 303);
      clock.set('2030-07-01T12:00:00.000Z');
      const slot = { date: '2030-07-15', start: '09:00', duration: '120' };
      const booked = await post(quote + '/book', slot);
      assert.equal(booked.status, 303);
      const booking = booked.headers.get('location');
      assert.equal((await post(quote + '/book', slot)).status, 303, 'identical booking retry');
      assert.equal((await post(booking + '/reschedule', { ...slot, start: '13:00', version: '1' })).status, 303);
      assert.equal((await post(booking + '/reschedule', { ...slot, start: '14:00', version: '1' })).status, 409);
      assert.match(await page('/schedule?day=2030-07-15'), /13:00–15:00[\s\S]*scheduled/);
      assert.equal((await post(booking + '/cancel', { version: '2' })).status, 303);
      assert.match(await page('/schedule?day=2030-07-15'), /13:00–15:00[\s\S]*cancelled/);
    }));

  test('an expired quote that was never accepted still cannot be booked', () => withApp(async ({ post, clock }) => {
    const customer = (await post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
    const quote = (await post(customer + '/quotes', DEEP)).headers.get('location');
    clock.set(FIRST_EXPIRED_MS);
    assert.equal((await post(quote + '/decision', { revision: '1', outcome: 'accepted' })).status, 409);
    assert.equal((await post(quote + '/book', { date: '2030-07-15', start: '09:00', duration: '120' })).status, 409);
  }));

  test('demo mode shows expiration on the seeded quotes', async () => {
    const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      const condo = await (await fetch(base + '/quotes/2')).text();
      assert.match(condo, /Revision 1 · \$90\.00[\s\S]*Valid until [^<]*11:59 PM Eastern/);
      assert.match(condo, acceptButton);
      assert.match(await (await fetch(base + '/quotes/1')).text(), /Revision 2 accepted/);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
