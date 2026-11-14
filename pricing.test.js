import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { defaultRateProfile, estimate, InputError, MAX_RATE_CENTS } from './pricing.js';
import { openRepository } from './repository.js';
import { app } from './server.js';

const cents = snapshot => snapshot.lines.map(line => [line.label, line.cents]);

const alternate = {
  version: 'test-2',
  bathroomCents: 2500,
  services: {
    standard: { squareFootCents: 12, minimumCents: 10000 },
    deep: { squareFootCents: 20, minimumCents: 15000 },
    moveout: { squareFootCents: 25, minimumCents: 20000 },
  },
};

// The exact JSON the pre-change code stored for a 1,000 sq ft, 2 bathroom deep clean.
const legacySnapshot = '{"scope":{"service":"deep","squareFeet":1000,"bathrooms":2},'
  + '"lines":[{"label":"Floor area","cents":17000},{"label":"Bathrooms","cents":3600}],'
  + '"totalCents":20600,"rateVersion":"demo-1"}';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'ayc-pricing-'));
}

describe('default pricing', () => {
  test('matches the documented totals and records demo-1 rates', () => {
    const first = estimate({ service: 'deep', squareFeet: '1000', bathrooms: '2' });
    assert.deepEqual(first, {
      scope: { service: 'deep', squareFeet: 1000, bathrooms: 2 },
      lines: [{ label: 'Floor area', cents: 17000 }, { label: 'Bathrooms', cents: 3600 }],
      totalCents: 20600,
      rateVersion: 'demo-1',
      rates: { squareFootCents: 17, bathroomCents: 1800, minimumCents: 14000 },
    });
    assert.equal(estimate({ service: 'deep', squareFeet: '1200', bathrooms: '2' }).totalCents, 24000);
  });

  test('reproduces every demo quote total', () => {
    const condo = estimate({ service: 'standard', squareFeet: 600, bathrooms: 1 });
    assert.deepEqual(cents(condo),
      [['Floor area', 6000], ['Bathrooms', 1800], ['Service minimum', 1200]]);
    assert.equal(condo.totalCents, 9000);
    assert.equal(estimate({ service: 'moveout', squareFeet: 1200, bathrooms: 2 }).totalCents, 28800);
    assert.equal(estimate({ service: 'moveout', squareFeet: 1400, bathrooms: 2 }).totalCents, 33000);
    assert.equal(estimate({ service: 'deep', squareFeet: 1750, bathrooms: 3 }).totalCents, 35150);
  });

  test('adds no minimum line when the subtotal exactly meets the minimum', () => {
    const exact = estimate({ service: 'standard', squareFeet: 900, bathrooms: 0 });
    assert.deepEqual(cents(exact), [['Floor area', 9000], ['Bathrooms', 0]]);
    assert.equal(exact.totalCents, 9000);
  });

  test('an explicit default profile prices identically to the implicit default', () => {
    for (const service of ['standard', 'deep', 'moveout']) {
      const fields = { service, squareFeet: '850', bathrooms: '1' };
      assert.deepEqual(estimate(fields, defaultRateProfile), estimate(fields));
    }
  });

  test('the default profile cannot be changed at runtime', () => {
    assert.throws(() => { defaultRateProfile.bathroomCents = 1; }, TypeError);
    assert.throws(() => { defaultRateProfile.services.deep.squareFootCents = 1; }, TypeError);
    assert.throws(() => { defaultRateProfile.services.extra = {}; }, TypeError);
  });

  test('keeps rejecting invalid scope as operator input errors', () => {
    const ok = { service: 'deep', squareFeet: '1000', bathrooms: '2' };
    for (const bad of [
      { service: 'constructor' }, { service: '__proto__' }, { service: 'premium' },
      { bathrooms: '2.5' }, { squareFeet: '1e3' }, { squareFeet: '99' }, { bathrooms: '21' },
    ]) {
      assert.throws(() => estimate({ ...ok, ...bad }), InputError, JSON.stringify(bad));
    }
  });
});

describe('alternate rate profiles', () => {
  test('price with the supplied rates and record its version and rates', () => {
    const snapshot = estimate({ service: 'deep', squareFeet: '1000', bathrooms: '2' }, alternate);
    assert.deepEqual(cents(snapshot), [['Floor area', 20000], ['Bathrooms', 5000]]);
    assert.equal(snapshot.totalCents, 25000);
    assert.equal(snapshot.rateVersion, 'test-2');
    assert.deepEqual(snapshot.rates, { squareFootCents: 20, bathroomCents: 2500, minimumCents: 15000 });
  });

  test('apply the profile minimum', () => {
    const snapshot = estimate({ service: 'standard', squareFeet: '600', bathrooms: '1' }, alternate);
    assert.deepEqual(cents(snapshot),
      [['Floor area', 7200], ['Bathrooms', 2500], ['Service minimum', 300]]);
    assert.equal(snapshot.totalCents, 10000);
  });

  test('do not leak into default pricing', () => {
    estimate({ service: 'deep', squareFeet: '1000', bathrooms: '2' }, alternate);
    assert.equal(estimate({ service: 'deep', squareFeet: '1000', bathrooms: '2' }).totalCents, 20600);
  });

  test('snapshots keep their values when the profile object is later changed', () => {
    const profile = structuredClone(alternate);
    const snapshot = estimate({ service: 'deep', squareFeet: '1000', bathrooms: '2' }, profile);
    profile.services.deep.squareFootCents = 99;
    profile.bathroomCents = 99;
    assert.equal(snapshot.totalCents, 25000);
    assert.deepEqual(snapshot.rates, { squareFootCents: 20, bathroomCents: 2500, minimumCents: 15000 });
  });

  test('only offer the services they list', () => {
    const deepOnly = { ...alternate, services: { deep: alternate.services.deep } };
    assert.equal(estimate({ service: 'deep', squareFeet: '1000', bathrooms: '0' }, deepOnly).totalCents, 20000);
    assert.throws(() => estimate({ service: 'standard', squareFeet: '1000', bathrooms: '0' }, deepOnly), InputError);
  });

  test('reject malformed profiles as configuration errors', () => {
    const fields = { service: 'deep', squareFeet: '1000', bathrooms: '2' };
    const withDeep = rates => ({ ...alternate, services: { ...alternate.services, deep: rates } });
    for (const [name, profile] of Object.entries({
      'null profile': null,
      'missing version': { ...alternate, version: undefined },
      'blank version': { ...alternate, version: '  ' },
      'long version': { ...alternate, version: 'v'.repeat(41) },
      'missing services': { ...alternate, services: undefined },
      'fractional cents': withDeep({ squareFootCents: 17.5, minimumCents: 14000 }),
      'numeric string': withDeep({ squareFootCents: '17', minimumCents: 14000 }),
      'negative minimum': withDeep({ squareFootCents: 17, minimumCents: -1 }),
      'missing minimum': withDeep({ squareFootCents: 17 }),
      'above cap': withDeep({ squareFootCents: MAX_RATE_CENTS + 1, minimumCents: 0 }),
      'fractional bathroom': { ...alternate, bathroomCents: 1800.01 },
      'bad unused service': { ...alternate, services: { ...alternate.services, standard: null } },
    })) {
      assert.throws(() => estimate(fields, profile), TypeError, name);
    }
  });
});

describe('whole-cent calculations', () => {
  test('every line and total is a safe integer that sums correctly', () => {
    const capped = {
      version: 'cap',
      bathroomCents: MAX_RATE_CENTS,
      services: { deep: { squareFootCents: MAX_RATE_CENTS, minimumCents: MAX_RATE_CENTS } },
    };
    const zero = {
      version: 'zero', bathroomCents: 0, services: { deep: { squareFootCents: 0, minimumCents: 0 } },
    };
    const cases = [[defaultRateProfile, ['standard', 'deep', 'moveout']],
      [alternate, ['standard', 'deep', 'moveout']], [capped, ['deep']], [zero, ['deep']]];
    let checked = 0;
    for (const [profile, services] of cases) {
      for (const service of services) {
        for (const squareFeet of [100, 101, 333, 999, 1000, 1001, 12345, 20000]) {
          for (const bathrooms of [0, 1, 7, 20]) {
            const snapshot = estimate({ service, squareFeet, bathrooms }, profile);
            const { minimumCents } = profile.services[service];
            for (const line of snapshot.lines) assert.ok(Number.isSafeInteger(line.cents), line.label);
            assert.ok(Number.isSafeInteger(snapshot.totalCents));
            assert.equal(snapshot.totalCents, snapshot.lines.reduce((sum, line) => sum + line.cents, 0));
            assert.equal(snapshot.totalCents,
              Math.max(squareFeet * profile.services[service].squareFootCents
                + bathrooms * profile.bathroomCents, minimumCents));
            checked++;
          }
        }
      }
    }
    assert.equal(checked, 256);
  });
});

describe('historical totals', () => {
  test('a rate change prices new revisions without altering saved ones', async () => {
    const dir = await tempDir();
    const file = join(dir, 'history.sqlite');
    const scope = { title: 'Rate change', service: 'deep', squareFeet: '1000', bathrooms: '2' };
    const stored = () => {
      const db = new DatabaseSync(file);
      try {
        return db.prepare('SELECT number, estimate FROM revisions ORDER BY number').all()
          .map(row => row.estimate);
      } finally {
        db.close();
      }
    };
    try {
      let repository = openRepository(file);
      const id = repository.addQuote(repository.addCustomer({ name: 'A', reference: 'B' }), scope);
      repository.close();
      const [original] = stored();

      repository = openRepository(file);
      repository.publishRateProfile(alternate, { activate: true, expectedActive: 'demo-1' });
      repository.revise(id, 1, scope);
      repository.close();

      repository = openRepository(file);
      const [second, first] = repository.quote(id).revisions;
      repository.decide(id, 2, 'accepted');
      repository.close();

      assert.equal(first.estimate.totalCents, 20600);
      assert.equal(first.estimate.rateVersion, 'demo-1');
      assert.deepEqual(first.estimate.rates, { squareFootCents: 17, bathroomCents: 1800, minimumCents: 14000 });
      assert.equal(second.estimate.totalCents, 25000);
      assert.equal(second.estimate.rateVersion, 'test-2');
      assert.deepEqual(second.estimate.rates, { squareFootCents: 20, bathroomCents: 2500, minimumCents: 15000 });
      assert.equal(stored()[0], original, 'revision 1 JSON must be byte-for-byte unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('revisions saved before rates were recorded still display, revise, and accept', async () => {
    const dir = await tempDir();
    const file = join(dir, 'legacy.sqlite');
    const repository = openRepository(file);
    const customer = repository.addCustomer({ name: 'Legacy', reference: 'Old house' });
    repository.close();
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO quotes (id, customer_id, title) VALUES (1, ?, 'Legacy deep clean')").run(customer);
    db.prepare("INSERT INTO revisions VALUES (1, 1, ?, '2025-01-01T00:00:00.000Z')").run(legacySnapshot);
    db.close();

    const server = app(file).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const page = async () => {
      const response = await fetch(base + '/quotes/1');
      assert.equal(response.status, 200);
      const html = await response.text();
      return Object.fromEntries(html.split('<article>').slice(1)
        .map(article => [/Revision (\d+)/.exec(article)[1], article]));
    };
    const post = (path, fields) => fetch(base + path, {
      method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
    });
    try {
      const before = await page();
      assert.match(before[1], /Revision 1 · \$206\.00/);
      assert.match(before[1], /demo-1/);
      assert.doesNotMatch(before[1], /Rates:/);

      const scope = { service: 'deep', squareFeet: '1200', bathrooms: '2' };
      assert.equal((await post('/quotes/1/revise', { ...scope, revision: '1' })).status, 303);
      assert.equal((await post('/quotes/1/decision', { revision: '2', outcome: 'accepted' })).status, 303);

      const after = await page();
      assert.match(after[1], /Revision 1 · \$206\.00/);
      assert.doesNotMatch(after[1], /Rates:/);
      assert.match(after[2], /Revision 2 · \$240\.00/);
      assert.match(after[2], /Rates: \$0\.17 per sq ft ·\s+\$18\.00 per bathroom ·\s+\$140\.00 minimum/);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const check = new DatabaseSync(file);
    try {
      assert.equal(check.prepare('SELECT estimate FROM revisions WHERE number = 1').get().estimate,
        legacySnapshot);
    } finally {
      check.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
