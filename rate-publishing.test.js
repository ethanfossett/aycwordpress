import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { InputError, MAX_RATE_CENTS } from './pricing.js';
import { Conflict, NotFound, openRepository } from './repository.js';

const DEMO_1 = {
  version: 'demo-1',
  bathroomCents: 1800,
  services: {
    standard: { squareFootCents: 10, minimumCents: 9000 },
    deep: { squareFootCents: 17, minimumCents: 14000 },
    moveout: { squareFootCents: 21, minimumCents: 18000 },
  },
};

const V2 = {
  version: 'v2',
  bathroomCents: 2000,
  services: {
    standard: { squareFootCents: 11, minimumCents: 9500 },
    deep: { squareFootCents: 18, minimumCents: 15000 },
    moveout: { squareFootCents: 22, minimumCents: 19000 },
  },
};

const withVersion = (version, bathroomCents = V2.bathroomCents) => ({ ...structuredClone(V2), version, bathroomCents });
const withoutTimes = ({ createdAt, activatedAt, ...profile }) => profile;
const plain = rows => rows.map(row => ({ ...row }));
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');

// Raw table contents, read through a separate connection.
function raw(file) {
  const db = new DatabaseSync(file);
  try {
    return {
      profiles: plain(db.prepare('SELECT * FROM rate_profiles ORDER BY id').all()),
      services: plain(db.prepare('SELECT * FROM rate_profile_services ORDER BY rowid').all()),
      activations: plain(db.prepare('SELECT * FROM rate_profile_activations ORDER BY id').all()),
    };
  } finally {
    db.close();
  }
}

function exec(file, sql) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function withRepository(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-publishing-'));
  const file = join(dir, 'rates.sqlite');
  const repository = openRepository(file);
  try {
    return await action(repository, file);
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Runs `operation` once per input in separate processes that all start at the same instant.
// Children report with a raw stdout write (never console.log, which colours output under FORCE_COLOR).
async function inParallel(file, inputs, operation) {
  const module = JSON.stringify(new URL('./repository.js', import.meta.url).href);
  const startAt = Date.now() + 1500;
  const run = promisify(execFile);
  const results = await Promise.all(inputs.map(input => run(process.execPath, [
    '--no-warnings', '--input-type=module', '-e', `
      const { openRepository } = await import(${module});
      const operation = ${operation};
      const input = ${JSON.stringify(input)};
      while (Date.now() < ${startAt});
      const repository = openRepository(${JSON.stringify(file)});
      let result;
      try {
        operation(repository, input);
        result = { outcome: 'ok' };
      } catch (error) {
        result = { outcome: error.constructor.name, message: error.message };
      }
      repository.close();
      process.stdout.write(JSON.stringify(result));`,
  ])));
  return results.map(({ stdout }) => JSON.parse(stdout));
}

const count = (results, outcome) => results.filter(result => result.outcome === outcome).length;

describe('publishing', () => {
  test('stores a validated profile without changing the active one', () => withRepository((repository, file) => {
    const before = raw(file);
    assert.equal(repository.publishRateProfile(V2), 'v2');
    assert.deepEqual(withoutTimes(repository.findRateProfile('v2')), V2);
    assert.deepEqual(repository.rateProfiles().map(profile => profile.version), ['demo-1', 'v2']);
    assert.deepEqual(withoutTimes(repository.activeRateProfile()), DEMO_1);
    const after = raw(file);
    assert.deepEqual(after.profiles.slice(0, 1), before.profiles, 'demo-1 row unchanged');
    assert.deepEqual(after.services.slice(0, 3), before.services, 'demo-1 rates unchanged');
    assert.deepEqual(after.activations, before.activations, 'no activation recorded');
  }));

  test('normalizes digit strings, surrounding spaces, and service order', () => withRepository(repository => {
    repository.publishRateProfile({
      version: '  2026-spring_a.1  ',
      bathroomCents: '2000',
      services: {
        moveout: { squareFootCents: '22', minimumCents: '19000' },
        deep: { squareFootCents: 18, minimumCents: 15000 },
        standard: { squareFootCents: '11', minimumCents: 9500 },
      },
    });
    const stored = repository.findRateProfile('2026-spring_a.1');
    assert.deepEqual(withoutTimes(stored), { ...V2, version: '2026-spring_a.1' });
    assert.deepEqual(Object.keys(stored.services), ['standard', 'deep', 'moveout']);
  }));

  test('publishes and activates in one step', () => withRepository((repository, file) => {
    const demoRows = raw(file);
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const active = repository.activeRateProfile();
    assert.deepEqual(withoutTimes(active), V2);
    assert.ok(!Number.isNaN(Date.parse(active.activatedAt)));
    const after = raw(file);
    assert.deepEqual(after.activations.map(row => row.profile_id), [1, 2]);
    assert.deepEqual(after.profiles[0], demoRows.profiles[0]);
    assert.deepEqual(after.services.slice(0, 3), demoRows.services);
  }));

  test('activation switches versions without touching any pricing rows', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2);
    const pricing = ({ profiles, services }) => ({ profiles, services });
    const before = pricing(raw(file));
    repository.activateRateProfile('v2', 'demo-1');
    assert.equal(repository.activeRateProfile().version, 'v2');
    repository.activateRateProfile('demo-1', 'v2');
    assert.equal(repository.activeRateProfile().version, 'demo-1');
    assert.deepEqual(pricing(raw(file)), before);
    assert.deepEqual(raw(file).activations.map(row => row.profile_id), [1, 2, 1], 'full history kept');
  }));

  test('re-activating the active version is a no-op, even with a stale expectation', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const before = raw(file);
    repository.activateRateProfile('v2', 'v2');
    repository.activateRateProfile('v2', 'demo-1');
    assert.deepEqual(raw(file), before);
  }));

  test('new quotes are priced with the activated profile', () => withRepository(repository => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const customer = repository.addCustomer({ name: 'A', reference: 'B' });
    const quote = repository.quote(repository.addQuote(customer,
      { title: 'T', service: 'deep', squareFeet: 1000, bathrooms: 2 }));
    assert.equal(quote.revisions[0].estimate.totalCents, 22000);
    assert.equal(quote.revisions[0].estimate.rateVersion, 'v2');
  }));
});

describe('validation failures', () => {
  const services = V2.services;
  const withService = (name, rates) => ({ ...V2, services: { ...services, [name]: rates } });
  const invalid = {
    'not an object': null,
    'missing version': { ...V2, version: undefined },
    'numeric version': { ...V2, version: 2 },
    'blank version': { ...V2, version: '   ' },
    'version with a space': { ...V2, version: 'v 2' },
    'version with a slash': { ...V2, version: 'v2/x' },
    'version starting with a dash': { ...V2, version: '-v2' },
    'version over 40 characters': { ...V2, version: 'v'.repeat(41) },
    'missing bathroom price': { ...V2, bathroomCents: undefined },
    'fractional bathroom price': { ...V2, bathroomCents: 1800.5 },
    'decimal string': { ...V2, bathroomCents: '18.00' },
    'negative bathroom price': { ...V2, bathroomCents: -1 },
    'bathroom price above cap': { ...V2, bathroomCents: MAX_RATE_CENTS + 1 },
    'missing services': { ...V2, services: undefined },
    'services as array': { ...V2, services: [] },
    'missing a service': { ...V2, services: { standard: services.standard, deep: services.deep } },
    'unknown service': { ...V2, services: { ...services, premium: services.deep } },
    '__proto__ service': { ...V2, services: { ...JSON.parse('{"__proto__":{}}'), ...services } },
    'service rates not an object': withService('deep', 17),
    'missing square-foot price': withService('deep', { minimumCents: 15000 }),
    'fractional square-foot price': withService('deep', { squareFootCents: 17.5, minimumCents: 15000 }),
    'negative minimum': withService('moveout', { squareFootCents: 22, minimumCents: -5 }),
    'minimum above cap': withService('moveout', { squareFootCents: 22, minimumCents: MAX_RATE_CENTS + 1 }),
  };

  test('every invalid profile is rejected as input and writes nothing', () => withRepository(async (repository, file) => {
    const before = await sha256(file);
    for (const [name, profile] of Object.entries(invalid)) {
      assert.throws(() => repository.publishRateProfile(profile), InputError, name);
      assert.throws(() => repository.publishRateProfile(profile, { activate: true, expectedActive: 'demo-1' }),
        InputError, name + ' (with activation)');
    }
    assert.equal(await sha256(file), before, 'database file unchanged');
    assert.equal(repository.activeRateProfile().version, 'demo-1');
  }));

  test('invalid activation requests change nothing', () => withRepository(async (repository, file) => {
    repository.publishRateProfile(V2);
    const before = await sha256(file);
    assert.throws(() => repository.publishRateProfile(withVersion('v3'), { activate: true }), InputError);
    assert.throws(() => repository.publishRateProfile(withVersion('v3'), { activate: true, expectedActive: '' }),
      InputError);
    assert.throws(() => repository.activateRateProfile('v2'), InputError);
    assert.throws(() => repository.activateRateProfile(2, 'demo-1'), InputError);
    assert.throws(() => repository.activateRateProfile('missing', 'demo-1'), NotFound);
    assert.equal(await sha256(file), before, 'database file unchanged');
    assert.throws(() => repository.findRateProfile('v3'), NotFound);
    assert.equal(repository.activeRateProfile().version, 'demo-1');
  }));
});

describe('duplicate versions', () => {
  test('an identical republish is a no-op', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2);
    const before = raw(file);
    assert.equal(repository.publishRateProfile(structuredClone(V2)), 'v2');
    assert.equal(repository.publishRateProfile({ ...V2, version: ' v2 ', bathroomCents: '2000' }), 'v2');
    assert.deepEqual(raw(file), before);
  }));

  test('reusing a version with different rates is a conflict and keeps the original', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2);
    const before = raw(file);
    assert.throws(() => repository.publishRateProfile(withVersion('v2', 2100)), Conflict);
    assert.throws(() => repository.publishRateProfile(
      { ...V2, services: { ...V2.services, deep: { squareFootCents: 19, minimumCents: 15000 } } }), Conflict);
    assert.throws(() => repository.publishRateProfile(withVersion('v2', 2100),
      { activate: true, expectedActive: 'demo-1' }), Conflict);
    assert.throws(() => repository.publishRateProfile({ ...V2, version: 'demo-1' }), Conflict);
    assert.deepEqual(raw(file), before);
    assert.deepEqual(withoutTimes(repository.findRateProfile('v2')), V2);
    assert.deepEqual(withoutTimes(repository.findRateProfile('demo-1')), DEMO_1);
    assert.equal(repository.activeRateProfile().version, 'demo-1');
  }));

  test('retrying a successful publish-and-activate is a no-op', () => withRepository((repository, file) => {
    const request = [V2, { activate: true, expectedActive: 'demo-1' }];
    repository.publishRateProfile(...request);
    const before = raw(file);
    repository.publishRateProfile(...request);
    assert.deepEqual(raw(file), before);
  }));

  test('publishing an existing identical version can activate it', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2);
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    assert.equal(repository.activeRateProfile().version, 'v2');
    assert.equal(raw(file).profiles.length, 2);
  }));
});

describe('rollback', () => {
  test('a stale publish-and-activate publishes nothing', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const before = raw(file);
    assert.throws(() => repository.publishRateProfile(withVersion('v3'),
      { activate: true, expectedActive: 'demo-1' }), Conflict);
    assert.throws(() => repository.findRateProfile('v3'), NotFound);
    assert.deepEqual(raw(file), before);
  }));

  test('a failure while storing rates leaves no partial profile', () => withRepository((repository, file) => {
    const before = raw(file);
    exec(file, `CREATE TRIGGER sabotage BEFORE INSERT ON rate_profile_services
      WHEN NEW.service = 'moveout' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    assert.throws(() => repository.publishRateProfile(V2), /simulated failure/);
    assert.throws(() => repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' }),
      /simulated failure/);
    assert.deepEqual(raw(file), before);
    exec(file, 'DROP TRIGGER sabotage');
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    assert.deepEqual(withoutTimes(repository.activeRateProfile()), V2);
  }));

  test('a failure while activating also undoes the publish', () => withRepository((repository, file) => {
    const before = raw(file);
    exec(file, `CREATE TRIGGER sabotage BEFORE INSERT ON rate_profile_activations
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    assert.throws(() => repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' }),
      /simulated failure/);
    assert.deepEqual(raw(file), before);
    assert.throws(() => repository.findRateProfile('v2'), NotFound);

    repository.publishRateProfile(V2);
    const published = raw(file);
    assert.throws(() => repository.activateRateProfile('v2', 'demo-1'), /simulated failure/);
    assert.deepEqual(raw(file), published);
    assert.equal(repository.activeRateProfile().version, 'demo-1');
  }));
});

describe('concurrent requests', () => {
  test('a request based on a stale active version is rejected', () => withRepository((first, file) => {
    const second = openRepository(file);
    try {
      first.publishRateProfile(V2);
      first.publishRateProfile(withVersion('v3'));
      const seen = second.activeRateProfile().version;
      first.activateRateProfile('v2', 'demo-1');
      assert.throws(() => second.activateRateProfile('v3', seen), Conflict);
      assert.throws(() => second.publishRateProfile(withVersion('v4'), { activate: true, expectedActive: seen }),
        Conflict);
      assert.equal(second.activeRateProfile().version, 'v2');
      assert.throws(() => second.findRateProfile('v4'), NotFound);
    } finally {
      second.close();
    }
  }));

  test('simultaneous publish-and-activate requests: exactly one wins, the rest roll back', () =>
    withRepository(async (repository, file) => {
      const inputs = Array.from({ length: 8 }, (_, i) => withVersion('race-' + i, 2000 + i));
      const results = await inParallel(file, inputs,
        '(repository, input) => repository.publishRateProfile(input, { activate: true, expectedActive: "demo-1" })');
      assert.equal(count(results, 'ok'), 1, JSON.stringify(results));
      assert.equal(count(results, 'Conflict'), 7, JSON.stringify(results));
      const winner = inputs[results.findIndex(result => result.outcome === 'ok')];
      const { profiles, activations } = raw(file);
      assert.deepEqual(profiles.map(row => row.version), ['demo-1', winner.version]);
      assert.equal(activations.length, 2);
      assert.deepEqual(withoutTimes(repository.activeRateProfile()), winner);
    }));

  test('simultaneous publishes of one version with different rates: exactly one is stored', () =>
    withRepository(async (repository, file) => {
      const inputs = Array.from({ length: 8 }, (_, i) => withVersion('v2', 2000 + i));
      const results = await inParallel(file, inputs, '(repository, input) => repository.publishRateProfile(input)');
      assert.equal(count(results, 'ok'), 1, JSON.stringify(results));
      assert.equal(count(results, 'Conflict'), 7, JSON.stringify(results));
      const winner = inputs[results.findIndex(result => result.outcome === 'ok')];
      assert.deepEqual(withoutTimes(repository.findRateProfile('v2')), winner);
      assert.equal(raw(file).profiles.length, 2);
      assert.equal(raw(file).services.length, 6);
    }));

  test('simultaneous identical publishes all succeed and store one copy', () =>
    withRepository(async (repository, file) => {
      const results = await inParallel(file, Array(8).fill(V2),
        '(repository, input) => repository.publishRateProfile(input)');
      assert.equal(count(results, 'ok'), 8, JSON.stringify(results));
      assert.equal(raw(file).profiles.length, 2);
      assert.equal(raw(file).services.length, 6);
    }));

  test('simultaneous activations of different versions: exactly one wins', () =>
    withRepository(async (repository, file) => {
      const versions = Array.from({ length: 8 }, (_, i) => 'pick-' + i);
      for (const version of versions) repository.publishRateProfile(withVersion(version));
      const results = await inParallel(file, versions,
        '(repository, version) => repository.activateRateProfile(version, "demo-1")');
      assert.equal(count(results, 'ok'), 1, JSON.stringify(results));
      assert.equal(count(results, 'Conflict'), 7, JSON.stringify(results));
      const winner = versions[results.findIndex(result => result.outcome === 'ok')];
      assert.equal(repository.activeRateProfile().version, winner);
      assert.equal(raw(file).activations.length, 2);
    }));
});

describe('persistence', () => {
  test('the active version and published profiles survive restarts', () => withRepository(async (repository, file) => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    repository.publishRateProfile(withVersion('v3'));
    const before = raw(file);
    const profiles = repository.rateProfiles();
    const hash = await sha256(file);
    for (let open = 0; open < 3; open++) {
      const reopened = openRepository(file);
      try {
        assert.equal(reopened.activeRateProfile().version, 'v2', 'not reset to demo-1');
        assert.deepEqual(reopened.rateProfiles(), profiles);
      } finally {
        reopened.close();
      }
    }
    assert.deepEqual(raw(file), before);
    assert.equal(await sha256(file), hash, 'reopening writes nothing');
  }));

  test('switching back to an older version also persists', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    repository.activateRateProfile('demo-1', 'v2');
    const reopened = openRepository(file);
    try {
      assert.deepEqual(withoutTimes(reopened.activeRateProfile()), DEMO_1);
    } finally {
      reopened.close();
    }
  }));

  test('databases from before activations existed get demo-1 active and nothing else changes', () =>
    withRepository((repository, file) => {
      repository.publishRateProfile(V2);
      exec(file, 'DROP TABLE rate_profile_activations');
      const db = new DatabaseSync(file);
      const pricing = { profiles: plain(db.prepare('SELECT * FROM rate_profiles').all()),
        services: plain(db.prepare('SELECT * FROM rate_profile_services').all()) };
      db.close();
      const upgraded = openRepository(file);
      try {
        assert.equal(upgraded.activeRateProfile().version, 'demo-1');
        const after = raw(file);
        assert.deepEqual({ profiles: after.profiles, services: after.services }, pricing);
        assert.equal(after.activations.length, 1);
      } finally {
        upgraded.close();
      }
    }));

  test('the activation history cannot be edited or deleted', () => withRepository((repository, file) => {
    repository.publishRateProfile(V2, { activate: true, expectedActive: 'demo-1' });
    const before = raw(file);
    for (const sql of ['UPDATE rate_profile_activations SET profile_id = 1',
      'DELETE FROM rate_profile_activations']) {
      assert.throws(() => exec(file, sql), /append-only/, sql);
    }
    assert.deepEqual(raw(file), before);
  }));
});
