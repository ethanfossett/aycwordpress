import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { estimate } from './pricing.js';
import { Conflict, NotFound, openRepository } from './repository.js';
import { app } from './server.js';

const profile = (version, bathroomCents, standard, deep, moveout) => ({
  version,
  bathroomCents,
  services: {
    standard: { squareFootCents: standard[0], minimumCents: standard[1] },
    deep: { squareFootCents: deep[0], minimumCents: deep[1] },
    moveout: { squareFootCents: moveout[0], minimumCents: moveout[1] },
  },
});
const V2 = profile('v2', 2000, [11, 9500], [18, 15000], [22, 19000]);
const V3 = profile('v3', 2500, [12, 10000], [20, 16000], [25, 21000]);
const DEEP = { title: 'Deep clean', service: 'deep', squareFeet: '1000', bathrooms: '2' };

// The exact JSON the baseline code stored (no recorded rates).
const LEGACY_DEEP = '{"scope":{"service":"deep","squareFeet":1000,"bathrooms":2},'
  + '"lines":[{"label":"Floor area","cents":17000},{"label":"Bathrooms","cents":3600}],'
  + '"totalCents":20600,"rateVersion":"demo-1"}';

const plain = rows => rows.map(row => ({ ...row }));

function rawRevisions(file) {
  const db = new DatabaseSync(file);
  try {
    return plain(db.prepare('SELECT * FROM revisions ORDER BY quote_id, number').all());
  } finally {
    db.close();
  }
}

async function withRepository(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-quote-pricing-'));
  const file = join(dir, 'quotes.sqlite');
  const repository = openRepository(file);
  try {
    return await action(repository, file);
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Starts the HTTP app on an existing database file.
async function serve(file) {
  const server = app(file).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    post: (path, fields) => fetch(base + path, {
      method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
    }),
    page: async path => {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      return response.text();
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

// Each snapshot must be exactly what its recorded version's stored rates produce.
function assertSelfConsistent(repository, snapshot) {
  const stored = repository.findRateProfile(snapshot.rateVersion);
  assert.deepEqual(snapshot, estimate(snapshot.scope, stored), JSON.stringify(snapshot));
}

describe('new quotes use the active pricing version', () => {
  test('a fresh database prices new quotes with demo-1 exactly as before', () => withRepository(repository => {
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const [revision] = repository.quote(repository.addQuote(customer, DEEP)).revisions;
    assert.deepEqual(revision.estimate, {
      scope: { service: 'deep', squareFeet: 1000, bathrooms: 2 },
      lines: [{ label: 'Floor area', cents: 17000 }, { label: 'Bathrooms', cents: 3600 }],
      totalCents: 20600,
      rateVersion: 'demo-1',
      rates: { squareFootCents: 17, bathroomCents: 1800, minimumCents: 14000 },
    });
  }));

  test('every service is priced with the activated profile and records its rates', () => withRepository(repository => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const expected = { standard: 16500 + 4000, deep: 27000 + 4000, moveout: 33000 + 4000 };
    for (const service of ['standard', 'deep', 'moveout']) {
      const id = repository.addQuote(customer, { title: service, service, squareFeet: 1500, bathrooms: 2 });
      const { estimate: snapshot } = repository.quote(id).revisions[0];
      assert.equal(snapshot.rateVersion, 'v2');
      assert.equal(snapshot.totalCents, expected[service], service);
      assert.deepEqual(snapshot.rates, { ...V2.services[service], bathroomCents: 2000 });
      assertSelfConsistent(repository, snapshot);
    }
  }));

  test('publishing without activating does not affect quotes', () => withRepository(repository => {
    repository.publishRateProfile(V2);
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const { estimate: snapshot } = repository.quote(repository.addQuote(customer, DEEP)).revisions[0];
    assert.equal(snapshot.rateVersion, 'demo-1');
    assert.equal(snapshot.totalCents, 20600);
  }));

  test('switching back to an older version prices with it again', () => withRepository(repository => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    repository.activateRateProfile('demo-1', 'v2');
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const { estimate: snapshot } = repository.quote(repository.addQuote(customer, DEEP)).revisions[0];
    assert.equal(snapshot.rateVersion, 'demo-1');
    assert.equal(snapshot.totalCents, 20600);
  }));
});

describe('changing the active version and revising', () => {
  test('a new revision uses the newly active version; the earlier one is untouched', () =>
    withRepository((repository, file) => {
      const customer = repository.addCustomer({ name: 'A', reference: 'B' });
      const id = repository.addQuote(customer, DEEP);
      const [original] = rawRevisions(file);
      repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
      repository.revise(id, 1, DEEP);
      const [second, first] = repository.quote(id).revisions;
      assert.equal(first.estimate.rateVersion, 'demo-1');
      assert.equal(first.estimate.totalCents, 20600);
      assert.equal(second.estimate.rateVersion, 'v2');
      assert.equal(second.estimate.totalCents, 18000 + 4000);
      assert.deepEqual(rawRevisions(file)[0], original, 'revision 1 row is byte-for-byte unchanged');
    }));

  test('each revision records the version active when it was saved', () => withRepository((repository, file) => {
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const id = repository.addQuote(customer, DEEP);
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    repository.revise(id, 1, { ...DEEP, squareFeet: '1200' });
    const afterTwo = rawRevisions(file);
    repository.publishRateProfile(V3, { activate: true, expectedActive: 'v2' });
    repository.revise(id, 2, { ...DEEP, squareFeet: '1200' });
    const revisions = repository.quote(id).revisions.reverse();
    assert.deepEqual(revisions.map(item => [item.estimate.rateVersion, item.estimate.totalCents]),
      [['demo-1', 20600], ['v2', 21600 + 4000], ['v3', 24000 + 5000]]);
    assert.deepEqual(rawRevisions(file).slice(0, 2), afterTwo);
    for (const item of revisions) assertSelfConsistent(repository, item.estimate);
  }));

  test('a quote saved before rates were recorded can be revised with the active version', () =>
    withRepository((repository, file) => {
      const customer = repository.addCustomer({ name: 'Legacy', reference: 'Old' });
      const db = new DatabaseSync(file);
      db.prepare("INSERT INTO quotes (id, customer_id, title) VALUES (50, ?, 'Legacy')").run(customer);
      db.prepare("INSERT INTO revisions VALUES (50, 1, ?, '2025-01-01T00:00:00.000Z')").run(LEGACY_DEEP);
      db.close();
      repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
      repository.revise(50, 1, DEEP);
      repository.decide(50, 2, 'accepted');
      const [second, first] = repository.quote(50).revisions;
      assert.equal(second.estimate.rateVersion, 'v2');
      assert.equal(second.estimate.totalCents, 22000);
      assert.equal(rawRevisions(file).find(row => row.number === 1).estimate, LEGACY_DEEP);
      assert.equal(first.estimate.rates, undefined);
    }));
});

describe('historical versions keep their totals and saved rates', () => {
  test('activating new versions and restarting changes no saved revision', () => withRepository(async (repository, file) => {
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const draft = repository.addQuote(customer, { ...DEEP, service: 'standard', squareFeet: '600', bathrooms: '1' });
    const accepted = repository.addQuote(customer, DEEP);
    repository.revise(accepted, 1, { ...DEEP, squareFeet: '1200' });
    repository.decide(accepted, 2, 'accepted');
    const declined = repository.addQuote(customer, { ...DEEP, service: 'moveout' });
    repository.decide(declined, 1, 'declined');
    const before = rawRevisions(file);
    const totals = id => repository.quote(id).revisions.map(item => item.estimate.totalCents);
    assert.deepEqual([totals(draft), totals(accepted), totals(declined)], [[9000], [24000, 20600], [24600]]);

    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    repository.publishRateProfile(V3, { activate: true, expectedActive: 'v2' });
    const reopened = openRepository(file);
    try {
      assert.deepEqual(rawRevisions(file), before);
      assert.deepEqual([draft, accepted, declined].map(id => reopened.quote(id).revisions.map(item =>
        [item.estimate.rateVersion, item.estimate.totalCents, item.estimate.rates.squareFootCents])),
      [[['demo-1', 9000, 10]], [['demo-1', 24000, 17], ['demo-1', 20600, 17]], [['demo-1', 24600, 21]]]);
    } finally {
      reopened.close();
    }

    const http = await serve(file);
    try {
      const html = await http.page('/quotes/' + accepted);
      assert.match(html, /Revision 2 · \$240\.00[\s\S]*demo-1[\s\S]*Rates: \$0\.17 per sq ft/);
      assert.match(html, /Revision 1 · \$206\.00/);
      assert.match(html, /Revision 2 accepted/);
    } finally {
      await http.close();
    }
  }));
});

describe('service minimums and whole cents with a stored profile', () => {
  test('minimums come from the active profile', () => withRepository(repository => {
    repository.publishRateProfile(profile('high-min', 2000, [11, 20000], [18, 30000], [22, 40000]),
      { activate: true, expectedActive: 'demo-1' });
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const lines = fields => {
      const { estimate: snapshot } = repository.quote(repository.addQuote(customer, { title: 'T', ...fields })).revisions[0];
      return [snapshot.lines.map(line => [line.label, line.cents]), snapshot.totalCents];
    };
    // Below the minimum: 600 * 11 + 1 * 2000 = 8,600, topped up to 20,000.
    assert.deepEqual(lines({ service: 'standard', squareFeet: 600, bathrooms: 1 }),
      [[['Floor area', 6600], ['Bathrooms', 2000], ['Service minimum', 11400]], 20000]);
    // Exactly the minimum: 1,000 * 18 + 6 * 2000 = 30,000, so no minimum line.
    assert.deepEqual(lines({ service: 'deep', squareFeet: 1000, bathrooms: 6 }),
      [[['Floor area', 18000], ['Bathrooms', 12000]], 30000]);
    // Above the minimum.
    assert.deepEqual(lines({ service: 'moveout', squareFeet: 2000, bathrooms: 1 }),
      [[['Floor area', 44000], ['Bathrooms', 2000]], 46000]);
    // The demo-1 condo case under v2-style rates: 600 * 11 + 2000 = 8,600 < 9,500.
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'high-min' });
    assert.deepEqual(lines({ service: 'standard', squareFeet: 600, bathrooms: 1 }),
      [[['Floor area', 6600], ['Bathrooms', 2000], ['Service minimum', 900]], 9500]);
  }));

  test('every saved line and total is exact whole cents', () => withRepository(repository => {
    repository.publishRateProfile(profile('odd', 1999, [13, 12345], [19, 23457], [23, 34567]),
      { activate: true, expectedActive: 'demo-1' });
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    let checked = 0;
    for (const service of ['standard', 'deep', 'moveout']) {
      for (const squareFeet of [100, 333, 1001, 20000]) {
        for (const bathrooms of [0, 1, 7, 20]) {
          const id = repository.addQuote(customer, { title: 'T', service, squareFeet, bathrooms });
          const { estimate: snapshot } = repository.quote(id).revisions[0];
          for (const line of snapshot.lines) assert.ok(Number.isSafeInteger(line.cents));
          assert.equal(snapshot.totalCents, snapshot.lines.reduce((sum, line) => sum + line.cents, 0));
          assert.equal(snapshot.totalCents, Math.max(squareFeet * snapshot.rates.squareFootCents
            + bathrooms * 1999, snapshot.rates.minimumCents));
          assertSelfConsistent(repository, snapshot);
          checked++;
        }
      }
    }
    assert.equal(checked, 48);
  }));
});

describe('concurrent activation and quote creation', () => {
  // A child process opens a write transaction that activates `version` and holds it open for
  // holdMs. Resolves once the lock is held; `exited` resolves when the child has committed.
  async function holdActivation(file, version, holdMs) {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE');
      db.prepare('INSERT INTO rate_profile_activations (profile_id, activated_at) '
        + 'SELECT id, ? FROM rate_profiles WHERE version = ?').run(new Date().toISOString(), ${JSON.stringify(version)});
      process.stdout.write('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});`]);
    const [chunk] = await once(child.stdout, 'data');
    assert.equal(String(chunk), 'locked');
    return { exited: once(child, 'exit') };
  }

  test('quote creation waits for an in-flight activation and prices with it', () =>
    withRepository(async (repository, file) => {
      repository.publishRateProfile(V2);
      const customer = repository.addCustomer({ name: 'A', reference: 'B' });
      const { exited } = await holdActivation(file, 'v2', 400);
      const started = Date.now();
      const id = repository.addQuote(customer, DEEP);
      const waited = Date.now() - started;
      assert.deepEqual(await exited, [0, null]);
      assert.ok(waited >= 250, 'addQuote should have waited for the lock, waited ' + waited + 'ms');
      const { estimate: snapshot } = repository.quote(id).revisions[0];
      assert.equal(snapshot.rateVersion, 'v2');
      assert.equal(snapshot.totalCents, 22000);
      assert.equal(repository.activeRateProfile().version, 'v2');
    }));

  test('a revision waits for an in-flight activation and prices with it', () =>
    withRepository(async (repository, file) => {
      repository.publishRateProfile(V2);
      const customer = repository.addCustomer({ name: 'A', reference: 'B' });
      const id = repository.addQuote(customer, DEEP);
      const { exited } = await holdActivation(file, 'v2', 400);
      const started = Date.now();
      repository.revise(id, 1, DEEP);
      const waited = Date.now() - started;
      assert.deepEqual(await exited, [0, null]);
      assert.ok(waited >= 250, 'revise should have waited for the lock, waited ' + waited + 'ms');
      const [second, first] = repository.quote(id).revisions;
      assert.deepEqual([first.estimate.rateVersion, first.estimate.totalCents], ['demo-1', 20600]);
      assert.deepEqual([second.estimate.rateVersion, second.estimate.totalCents], ['v2', 22000]);
    }));

  test('parallel quote writers and activators never save a mismatched version or total', () =>
    withRepository(async (repository, file) => {
      repository.publishRateProfile(V2);
      repository.publishRateProfile(V3);
      const customer = repository.addCustomer({ name: 'A', reference: 'B' });
      const module = JSON.stringify(new URL('./repository.js', import.meta.url).href);
      const startAt = Date.now() + 1500;
      const deadline = startAt + 20000;
      const markers = [0, 1].map(index => file + '.activator-' + index + '.done');
      // Work-based, not time-based: activators each make 6 activations, and quote writers keep going
      // until both activators have finished, then write 2 more rounds. A short pause after each
      // operation lets the lock change hands. Under heavy machine load a lock wait can exceed the
      // app's 3 s busy_timeout (SQLITE_BUSY, errcode 5); nothing is written in that case, so the
      // child retries like a real client would and counts it. Children report with a raw stdout
      // write (never console.log, which colours under FORCE_COLOR). Any other error fails the child.
      const worker = (keepGoing, body, after = '') => promisify(execFile)(process.execPath, [
        '--no-warnings', '--input-type=module', '-e', `
        import { existsSync, writeFileSync } from 'node:fs';
        const { openRepository, Conflict } = await import(${module});
        let busy = 0;
        const retry = operation => {
          for (;;) {
            try { return operation(); } catch (error) {
              if (error.errcode !== 5 || Date.now() > ${deadline}) throw error;
              busy++;
            }
          }
        };
        const repository = retry(() => openRepository(${JSON.stringify(file)}));
        const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        const markers = ${JSON.stringify(markers)};
        while (Date.now() < ${startAt});
        let done = 0;
        while ((${keepGoing}) && Date.now() < ${deadline}) { ${body} pause(); }
        ${after}
        repository.close();
        process.stdout.write(JSON.stringify({ done, busy }));`]);
      const writeQuote = `
        const id = retry(() => repository.addQuote(${customer}, { title: 'Race',
          service: ['standard', 'deep', 'moveout'][done % 3], squareFeet: 500 + done, bathrooms: done % 4 }));
        retry(() => repository.revise(id, 1, { service: 'deep', squareFeet: 900 + done, bathrooms: 1 }));
        done++;`;
      const quoteWriter = () => worker('!markers.every(existsSync)', writeQuote,
        `for (let extra = 0; extra < 2; extra++) { ${writeQuote} }`);
      const activator = index => worker('done < 6', `
        const current = retry(() => repository.activeRateProfile().version);
        const next = ['demo-1', 'v2', 'v3'][(['demo-1', 'v2', 'v3'].indexOf(current) + 1) % 3];
        try { retry(() => repository.activateRateProfile(next, current)); done++; }
        catch (error) { if (!(error instanceof Conflict)) throw error; }`,
      `writeFileSync(markers[${index}], '');`);
      // Three quote writers and two activators, all started together.
      const results = await Promise.all([quoteWriter(), quoteWriter(), quoteWriter(), activator(0), activator(1)]);
      assert.ok(Date.now() < deadline, 'the race hit its safety deadline');
      const reports = results.map(result => JSON.parse(result.stdout));
      const [written, switched] = [reports.slice(0, 3), reports.slice(3)]
        .map(group => group.reduce((sum, report) => sum + report.done, 0));
      const busyRetries = reports.reduce((sum, report) => sum + report.busy, 0);
      assert.equal(switched, 12, 'each activator completed its 6 activations');
      assert.ok(written >= 6, `wrote ${written} quotes`);

      const db = new DatabaseSync(file);
      const activations = db.prepare(`SELECT a.activated_at, p.version FROM rate_profile_activations a
        JOIN rate_profiles p ON p.id = a.profile_id ORDER BY a.id`).all();
      const revisions = db.prepare('SELECT estimate, created_at FROM revisions').all();
      db.close();
      assert.equal(revisions.length, written * 2);

      const used = new Set();
      for (const row of revisions) {
        const snapshot = JSON.parse(row.estimate);
        used.add(snapshot.rateVersion);
        // 1. Version, lines, total, and rates all agree with the stored profile for that version.
        assertSelfConsistent(repository, snapshot);
        // 2. The version is the one active when the revision was saved. Timestamps are taken inside
        //    each transaction; same-millisecond activations could have committed on either side.
        const before = activations.filter(item => item.activated_at < row.created_at).at(-1);
        const allowed = new Set([before?.version,
          ...activations.filter(item => item.activated_at === row.created_at).map(item => item.version)]);
        assert.ok(allowed.has(snapshot.rateVersion),
          `revision at ${row.created_at} used ${snapshot.rateVersion}, allowed ${[...allowed]}`);
      }
      assert.ok(used.size >= 2, 'the race should have produced revisions under several versions');
      process.stderr.write(`race: ${written} quotes, ${switched} activations, `
        + `versions used: ${[...used]}, lock-timeout retries: ${busyRetries}\n`);
    }));
});

describe('approval, booking, and stale revision workflows', () => {
  test('the full HTTP workflow behaves as before under a non-default active version', () =>
    withRepository(async (repository, file) => {
      repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
      repository.publishRateProfile(V3);
      const http = await serve(file);
      try {
        const customer = (await http.post('/customers', { name: 'Flow', reference: 'Demo house' }))
          .headers.get('location');
        const created = await http.post(customer + '/quotes', DEEP);
        assert.equal(created.status, 303);
        const quote = created.headers.get('location');
        assert.match(await http.page(quote), /Revision 1 · \$220\.00[\s\S]*v2[\s\S]*Rates: \$0\.18 per sq ft/);

        assert.equal((await http.post(quote + '/revise', { ...DEEP, squareFeet: '1200', revision: '1' })).status, 303);
        const decide = (revision, outcome = 'accepted') => http.post(quote + '/decision', { revision, outcome });
        assert.equal((await decide('1')).status, 409, 'stale revision rejected');
        repository.activateRateProfile('v3', 'v2');
        assert.equal((await decide('2')).status, 303);
        assert.equal((await decide('2')).status, 303, 'repeated identical decision is idempotent');
        assert.equal((await decide('2', 'declined')).status, 409);
        assert.equal((await http.post(quote + '/revise', { ...DEEP, revision: '2' })).status, 409);

        const html = await http.page(quote);
        assert.match(html, /Revision 2 accepted/);
        assert.match(html, /Revision 2 · \$256\.00[\s\S]*v2/, 'accepted total not repriced after activation');
        assert.match(html, /Revision 1 · \$220\.00/);
        assert.doesNotMatch(html, /v3/);

        const slot = { date: '2030-05-06', start: '09:00', duration: '120' };
        const booked = await http.post(quote + '/book', slot);
        assert.equal(booked.status, 303);
        const booking = booked.headers.get('location');
        assert.equal((await http.post(quote + '/book', slot)).status, 303, 'identical booking retry');
        const other = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
        assert.match(await http.page(other), /Revision 1 · \$250\.00[\s\S]*v3/);
        assert.equal((await http.post(other + '/book', slot)).status, 409, 'not accepted yet');
        assert.equal((await http.post(other + '/decision', { revision: '1', outcome: 'accepted' })).status, 303);
        assert.equal((await http.post(other + '/book', { ...slot, start: '10:00' })).status, 409, 'overlap');
        assert.equal((await http.post(booking + '/reschedule', { ...slot, start: '13:00', version: '9' })).status, 409);
        assert.equal((await http.post(booking + '/reschedule', { ...slot, start: '13:00', version: '1' })).status, 303);
        assert.equal((await http.post(other + '/book', { ...slot, start: '10:00' })).status, 303);
        assert.equal((await http.post(booking + '/cancel', { version: '2' })).status, 303);
        assert.match(await http.page('/schedule?day=2030-05-06'),
          /10:00–12:00[\s\S]*scheduled[\s\S]*13:00–15:00[\s\S]*cancelled/);
      } finally {
        await http.close();
      }
    }));

  test('error precedence is unchanged: scope errors, then missing records, then stale revisions', () =>
    withRepository(async (repository, file) => {
      repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
      const customer = repository.addCustomer({ name: 'A', reference: 'B' });
      const id = repository.addQuote(customer, DEEP);
      repository.revise(id, 1, DEEP);
      const before = rawRevisions(file);
      const http = await serve(file);
      try {
        const bad = { ...DEEP, bathrooms: '2.5' };
        assert.equal((await http.post('/customers/999/quotes', bad)).status, 400);
        assert.equal((await http.post('/customers/999/quotes', DEEP)).status, 404);
        assert.equal((await http.post(`/quotes/${id}/revise`, { ...bad, revision: '1' })).status, 400);
        assert.equal((await http.post(`/quotes/${id}/revise`, { ...DEEP, revision: '1' })).status, 409);
        assert.equal((await http.post('/quotes/999/revise', { ...DEEP, revision: '1' })).status, 404);
        assert.equal((await http.post(`/quotes/${id}/revise`, { ...DEEP, service: 'premium', revision: '2' })).status, 400);
      } finally {
        await http.close();
      }
      assert.deepEqual(rawRevisions(file), before, 'rejected requests saved nothing');
      assert.throws(() => repository.revise(id, 1, DEEP), Conflict);
      assert.throws(() => repository.addQuote(999, DEEP), NotFound);
    }));

  test('demo mode is unchanged', async () => {
    const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      const condo = await (await fetch(base + '/quotes/2')).text();
      assert.match(condo, /Revision 1 · \$90\.00[\s\S]*demo-1[\s\S]*Service minimum · \$12\.00/);
      const apartment = await (await fetch(base + '/quotes/1')).text();
      assert.match(apartment, /Revision 2 · \$330\.00[\s\S]*Revision 1 · \$288\.00[\s\S]*Revision 2 accepted/);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
