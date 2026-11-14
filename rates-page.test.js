import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { dollarsToCents, InputError } from './pricing.js';
import { openRepository } from './repository.js';
import { app } from './server.js';

// A valid publish form, in dollars, as the browser submits it.
const V2_FORM = {
  version: 'v2', bathroom: '20.00', expected: 'demo-1',
  standardRate: '0.11', standardMinimum: '95.00',
  deepRate: '0.18', deepMinimum: '150.00',
  moveoutRate: '0.22', moveoutMinimum: '190.00',
};
const V2 = {
  version: 'v2', bathroomCents: 2000,
  services: {
    standard: { squareFootCents: 11, minimumCents: 9500 },
    deep: { squareFootCents: 18, minimumCents: 15000 },
    moveout: { squareFootCents: 22, minimumCents: 19000 },
  },
};
const DEEP = { title: 'Deep clean', service: 'deep', squareFeet: '1000', bathrooms: '2' };

const plain = rows => rows.map(row => ({ ...row }));
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const withoutTimes = ({ createdAt, activatedAt, ...profile }) => profile;

function rateTables(file) {
  const db = new DatabaseSync(file);
  try {
    return Object.fromEntries(['rate_profiles', 'rate_profile_services', 'rate_profile_activations']
      .map(table => [table, plain(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
  } finally {
    db.close();
  }
}

function revisionsIn(file) {
  const db = new DatabaseSync(file);
  try {
    return plain(db.prepare('SELECT * FROM revisions ORDER BY rowid').all());
  } finally {
    db.close();
  }
}

// Reads state through a separate connection, as another process would.
function inspect(file, action) {
  const repository = openRepository(file);
  try {
    return action(repository);
  } finally {
    repository.close();
  }
}

async function start(file, options) {
  const server = app(file, options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, fields, headers = {}) => fetch(base + path, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual', headers,
  });
  const get = path => fetch(base + path);
  const page = async path => {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    return response.text();
  };
  const stop = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { base, post, get, page, stop };
}

async function withApp(action) {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-rates-page-'));
  const file = join(dir, 'rates.sqlite');
  let http = await start(file);
  const restart = async () => {
    await http.stop();
    http = await start(file);
    return http;
  };
  try {
    return await action({ http: new Proxy({}, { get: (_, key) => http[key] }), file, restart });
  } finally {
    await http.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

// The error list shown above the form, as plain text items.
const errorsIn = html => [...(/<div role="alert">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '')
  .matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1].replace(/\s+/g, ' ').trim());
const noticeIn = html => /<p role="status"><strong>([^<]*)<\/strong>/.exec(html)?.[1] ?? '';
const activeIn = html => /<h2>Active pricing · ([^<]*)<\/h2>/.exec(html)?.[1];
const inputValue = (html, name) => new RegExp(`name="${name}"[^>]*?value="([^"]*)"`).exec(html)?.[1];

describe('rates page and navigation', () => {
  test('every main page links to pricing through Settings', () => withApp(async ({ http }) => {
    for (const path of ['/today', '/customers', '/quotes', '/schedule', '/rates']) {
      assert.match(await http.page(path), /<header>[\s\S]*?<a href="\/settings">Settings<\/a>[\s\S]*?<\/header>/, path);
    }
    assert.match(await http.page('/settings'), /href="\/rates">Manage pricing rates/);
  }));

  test('shows the active version, service rates, bathroom price, and minimums', () => withApp(async ({ http }) => {
    const html = await http.page('/rates');
    assert.equal(activeIn(html), 'demo-1');
    const active = html.slice(html.indexOf('<h2>Active pricing'), html.indexOf('<h2>Publish'));
    assert.match(active, /Standard ·\s+\$0\.10 per sq ft · \$90\.00 minimum/);
    assert.match(active, /Deep clean ·\s+\$0\.17 per sq ft · \$140\.00 minimum/);
    assert.match(active, /Move-out ·\s+\$0\.21 per sq ft · \$180\.00 minimum/);
    assert.match(active, /Bathrooms · \$18\.00 each/);
    assert.match(active, /Active since \d{4}-\d{2}-\d{2}T/);
    assert.match(html, /<h3>demo-1 · active<\/h3>/);
    assert.doesNotMatch(html, /Activate demo-1/, 'the active version has no activate button');
  }));

  test('the publish form is prefilled with the active rates in dollars', () => withApp(async ({ http }) => {
    const html = await http.page('/rates');
    assert.deepEqual(Object.fromEntries(['version', 'bathroom', 'standardRate', 'standardMinimum', 'deepRate',
      'deepMinimum', 'moveoutRate', 'moveoutMinimum', 'expected'].map(name => [name, inputValue(html, name)])), {
      version: '', bathroom: '18.00', standardRate: '0.10', standardMinimum: '90.00', deepRate: '0.17',
      deepMinimum: '140.00', moveoutRate: '0.21', moveoutMinimum: '180.00', expected: 'demo-1',
    });
    assert.match(html, /<input type="checkbox" name="activate" value="yes">/);
  }));

  test('unsupported requests are rejected like the rest of the app', () => withApp(async ({ http, file }) => {
    const before = await sha256(file);
    assert.equal((await http.get('/rates/activate')).status, 404);
    assert.equal((await http.get('/rates/v2')).status, 404);
    const json = await fetch(http.base + '/rates', {
      method: 'POST', body: JSON.stringify(V2_FORM), headers: { 'content-type': 'application/json' },
    });
    assert.equal(json.status, 400);
    assert.equal((await http.post('/rates', V2_FORM, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await http.post('/rates/activate', { version: 'demo-1', expected: 'demo-1' },
      { origin: 'http://evil.example' })).status, 403);
    assert.equal(await sha256(file), before);
  }));
});

describe('dollar amounts', () => {
  test('convert to exact whole cents for every cent value', () => {
    // Floating-point conversion fails here: parseFloat('0.29') * 100 is 28.999999999999996.
    for (const whole of [0, 1, 4, 18, 140, 9999]) {
      for (let cents = 0; cents < 100; cents++) {
        const text = whole + '.' + String(cents).padStart(2, '0');
        assert.equal(dollarsToCents(text, 'Amount'), whole * 100 + cents, text);
        if (cents % 10 === 0) assert.equal(dollarsToCents(whole + '.' + cents / 10, 'Amount'), whole * 100 + cents);
      }
      assert.equal(dollarsToCents(String(whole), 'Amount'), whole * 100);
    }
    assert.equal(dollarsToCents(' 0.29 ', 'Amount'), 29);
    assert.equal(dollarsToCents('10000.00', 'Amount'), 1_000_000);
  });

  test('reject anything that is not a whole-cent dollar amount', () => {
    for (const text of ['', ' ', undefined, null, 18, '0.001', '1.005', '10000.01', '-0.01', '.5', '5.', '1e2',
      '$1', '1,000', '1 000', '0x10', 'Infinity', 'NaN', '１８']) {
      assert.throws(() => dollarsToCents(text, 'Amount'), InputError, String(text));
    }
  });
});

describe('publish form validation', () => {
  const cases = {
    'missing version': [{ version: '' }, /^Version must be 1 to 40/],
    'version with spaces': [{ version: 'spring rates' }, /^Version must be 1 to 40/],
    'version too long': [{ version: 'v'.repeat(41) }, /^Version must be 1 to 40/],
    'missing bathroom price': [{ bathroom: '' }, /^Price per bathroom is required\.$/],
    'blank minimum': [{ deepMinimum: '   ' }, /^Deep clean minimum is required\.$/],
    'sub-cent rate': [{ standardRate: '0.175' }, /^Standard price per sq ft must be in whole cents/],
    'sub-cent minimum': [{ moveoutMinimum: '180.001' }, /^Move-out minimum must be in whole cents/],
    'negative rate': [{ deepRate: '-0.17' }, /^Deep clean price per sq ft cannot be negative\.$/],
    'letters': [{ bathroom: 'eighteen' }, /^Price per bathroom must be a dollar amount/],
    'dollar sign': [{ bathroom: '$18' }, /^Price per bathroom must be a dollar amount/],
    'thousands separator': [{ moveoutMinimum: '1,000.00' }, /^Move-out minimum must be a dollar amount/],
    'exponent': [{ standardMinimum: '9e1' }, /^Standard minimum must be a dollar amount/],
    'above maximum': [{ deepMinimum: '10000.01' }, /^Deep clean minimum must be at most \$10,000\.00\.$/],
  };

  for (const [name, [change, message]] of Object.entries(cases)) {
    test(`${name} is rejected with a specific message and changes nothing`, () => withApp(async ({ http, file }) => {
      const before = await sha256(file);
      const response = await http.post('/rates', { ...V2_FORM, ...change, activate: 'yes' });
      assert.equal(response.status, 400);
      const html = await response.text();
      const errors = errorsIn(html);
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0], message);
      assert.match(html, /Nothing was changed\./);
      assert.equal(activeIn(html), 'demo-1');
      for (const [field, value] of Object.entries(change)) {
        assert.equal(inputValue(html, field), value.replace(/&/g, '&amp;'), 'submitted value kept: ' + field);
      }
      assert.match(html, /name="activate" value="yes" checked/, 'checkbox state kept');
      assert.equal(await sha256(file), before, 'database file unchanged');
    }));
  }

  test('every problem is reported at once', () => withApp(async ({ http, file }) => {
    const before = await sha256(file);
    const response = await http.post('/rates', { expected: 'demo-1' });
    assert.equal(response.status, 400);
    const errors = errorsIn(await response.text());
    assert.equal(errors.length, 8, JSON.stringify(errors));
    assert.deepEqual(errors.slice(1), ['Price per bathroom is required.', 'Standard price per sq ft is required.',
      'Standard minimum is required.', 'Deep clean price per sq ft is required.', 'Deep clean minimum is required.',
      'Move-out price per sq ft is required.', 'Move-out minimum is required.']);
    assert.equal(await sha256(file), before);
  }));

  test('submitted text is escaped when the form is shown again', () => withApp(async ({ http }) => {
    const response = await http.post('/rates', { ...V2_FORM, version: '<script>alert(1)</script>', bathroom: '"><b>' });
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.doesNotMatch(html, /<script>alert|"><b>/);
    assert.equal(inputValue(html, 'version'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(inputValue(html, 'bathroom'), '&quot;&gt;&lt;b&gt;');
  }));

  test('activating while publishing needs the version the page was loaded with', () => withApp(async ({ http, file }) => {
    const before = await sha256(file);
    const { expected, ...withoutExpected } = V2_FORM;
    const response = await http.post('/rates', { ...withoutExpected, activate: 'yes' });
    assert.equal(response.status, 400);
    assert.deepEqual(errorsIn(await response.text()),
      ['The currently active version is required to activate a profile.']);
    assert.equal(await sha256(file), before);
  }));

  test('a duplicate version with different rates is a conflict; the original is kept', () =>
    withApp(async ({ http, file }) => {
      assert.equal((await http.post('/rates', V2_FORM)).status, 303);
      const before = rateTables(file);
      for (const activate of ['', 'yes']) {
        const response = await http.post('/rates', { ...V2_FORM, bathroom: '21.00', activate });
        assert.equal(response.status, 409);
        const html = await response.text();
        assert.deepEqual(errorsIn(html), ['Version v2 is already published with different rates.',
          'Choose a new version name. Published versions cannot be changed.']);
        assert.equal(inputValue(html, 'bathroom'), '21.00');
      }
      assert.deepEqual(rateTables(file), before);
      assert.deepEqual(withoutTimes(inspect(file, repository => repository.findRateProfile('v2'))), V2);
    }));

  test('resubmitting an identical version is a harmless no-op', () => withApp(async ({ http, file }) => {
    assert.equal((await http.post('/rates', V2_FORM)).status, 303);
    const before = rateTables(file);
    const again = await http.post('/rates', { ...V2_FORM, version: ' v2 ', bathroom: '20' });
    assert.equal(again.status, 303);
    assert.deepEqual(rateTables(file), before);
  }));
});

describe('publishing', () => {
  test('publishing without activation stores exact cents and leaves the active version alone', () =>
    withApp(async ({ http, file }) => {
      const response = await http.post('/rates', {
        ...V2_FORM, version: '  2026-spring  ', bathroom: '20', standardRate: '0.1', deepMinimum: '150.5',
        moveoutRate: '0',
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/rates?done=published&version=2026-spring');
      const html = await http.page(response.headers.get('location'));
      assert.equal(noticeIn(html), 'Published 2026-spring.');
      assert.equal(activeIn(html), 'demo-1');
      assert.match(html, /<h3>2026-spring<\/h3>[\s\S]*?<button>Activate 2026-spring<\/button>/);
      assert.ok(html.indexOf('<h3>2026-spring</h3>') < html.indexOf('<h3>demo-1 · active</h3>'), 'newest first');
      assert.deepEqual(withoutTimes(inspect(file, repository => repository.findRateProfile('2026-spring'))), {
        version: '2026-spring', bathroomCents: 2000,
        services: {
          standard: { squareFootCents: 10, minimumCents: 9500 },
          deep: { squareFootCents: 18, minimumCents: 15050 },
          moveout: { squareFootCents: 0, minimumCents: 19000 },
        },
      });
    }));

  test('publishing with activation switches new quotes to the new rates', () => withApp(async ({ http, file }) => {
    const customer = (await http.post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
    const before = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
    assert.equal((await http.post('/rates', V2_FORM)).status, 303);
    const unchanged = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
    assert.match(await http.page(unchanged), /Revision 1 · \$206\.00[\s\S]*demo-1/, 'published only: no effect');

    const response = await http.post('/rates', { ...V2_FORM, version: 'v3', bathroom: '25.00', activate: 'yes' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/rates?done=activated&version=v3');
    const html = await http.page(response.headers.get('location'));
    assert.equal(noticeIn(html), 'Activated v3. New quotes and revisions now use it.');
    assert.equal(activeIn(html), 'v3');
    assert.match(html, /Bathrooms · \$25\.00 each/);

    const after = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
    assert.match(await http.page(after), /Revision 1 · \$230\.00[\s\S]*v3[\s\S]*Rates: \$0\.18 per sq ft/);
    assert.match(await http.page(before), /Revision 1 · \$206\.00[\s\S]*demo-1/, 'earlier quote unchanged');
    assert.equal(inspect(file, repository => repository.activeRateProfile().version), 'v3');
  }));
});

describe('activation', () => {
  test('an existing version can be activated separately, and switched back', () => withApp(async ({ http }) => {
    await http.post('/rates', V2_FORM);
    const response = await http.post('/rates/activate', { version: 'v2', expected: 'demo-1' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/rates?done=activated&version=v2');
    let html = await http.page(response.headers.get('location'));
    assert.equal(activeIn(html), 'v2');
    assert.equal(noticeIn(html), 'Activated v2. New quotes and revisions now use it.');
    assert.match(html, /<h3>v2 · active<\/h3>/);
    assert.match(html, /name="expected" value="v2">\s*<input type="hidden" name="version" value="demo-1">/);
    assert.deepEqual(['bathroom', 'standardRate', 'deepMinimum', 'moveoutRate'].map(name => inputValue(html, name)),
      ['20.00', '0.11', '150.00', '0.22'], 'the publish form is prefilled with the newly active rates');

    assert.equal((await http.post('/rates/activate', { version: 'demo-1', expected: 'v2' })).status, 303);
    html = await http.page('/rates');
    assert.equal(activeIn(html), 'demo-1');
  }));

  test('a stale activation explains what changed and changes nothing', () => withApp(async ({ http, file }) => {
    await http.post('/rates', V2_FORM);
    await http.post('/rates', { ...V2_FORM, version: 'v3' });
    // Two staff members load the page while demo-1 is active; the first activates v2.
    assert.equal((await http.post('/rates/activate', { version: 'v2', expected: 'demo-1' })).status, 303);
    const before = rateTables(file);
    const response = await http.post('/rates/activate', { version: 'v3', expected: 'demo-1' });
    assert.equal(response.status, 409);
    const html = await response.text();
    assert.deepEqual(errorsIn(html), ['The active version changed to v2 after this page was loaded, so v3 was '
      + 'not activated. Review the current rates below, then choose again.']);
    assert.equal(activeIn(html), 'v2', 'the page shows the current state');
    assert.equal(inputValue(html, 'expected'), 'v2', 'the refreshed forms carry the new expectation');
    assert.deepEqual(rateTables(file), before);
  }));

  test('a stale publish-and-activate publishes nothing', () => withApp(async ({ http, file }) => {
    await http.post('/rates', { ...V2_FORM, activate: 'yes' });
    const before = rateTables(file);
    const response = await http.post('/rates', { ...V2_FORM, version: 'v3', activate: 'yes', expected: 'demo-1' });
    assert.equal(response.status, 409);
    const html = await response.text();
    assert.deepEqual(errorsIn(html), ['The active version changed to v2 after this page was loaded, so v3 was '
      + 'not published. Review the current rates below, then submit again.']);
    assert.equal(inputValue(html, 'version'), 'v3', 'the submitted form is kept for resubmission');
    assert.deepEqual(rateTables(file), before);
    assert.doesNotMatch(await http.page('/rates'), /<h3>v3/);
  }));

  test('invalid activation requests are rejected and change nothing', () => withApp(async ({ http, file }) => {
    await http.post('/rates', V2_FORM);
    const before = await sha256(file);
    const cases = [
      [{ version: 'missing', expected: 'demo-1' }, 404, 'Rate profile not found.'],
      [{ expected: 'demo-1' }, 400, 'Choose a published version.'],
      [{ version: 'v2' }, 400, 'The currently active version is required to activate a profile.'],
    ];
    for (const [fields, status, message] of cases) {
      const response = await http.post('/rates/activate', fields);
      assert.equal(response.status, status, JSON.stringify(fields));
      assert.deepEqual(errorsIn(await response.text()), [message]);
    }
    assert.equal(await sha256(file), before);
  }));

  test('re-activating the active version is a harmless no-op', () => withApp(async ({ http, file }) => {
    const before = rateTables(file);
    assert.equal((await http.post('/rates/activate', { version: 'demo-1', expected: 'demo-1' })).status, 303);
    assert.deepEqual(rateTables(file), before);
  }));

  test('success notices are shown only when they describe the current state', () => withApp(async ({ http }) => {
    await http.post('/rates', V2_FORM);
    assert.equal(noticeIn(await http.page('/rates?done=published&version=v2')), 'Published v2.');
    assert.equal(noticeIn(await http.page('/rates?done=published&version=nope')), '');
    assert.equal(noticeIn(await http.page('/rates?done=activated&version=v2')), '', 'v2 is not active');
    assert.equal(noticeIn(await http.page('/rates?done=other&version=v2')), '');
    assert.doesNotMatch(await http.page('/rates?done=published&version=%3Cb%3E'), /<b>/);
  }));
});

describe('persistence', () => {
  test('published versions and the active version survive a restart', () => withApp(async ({ http, file, restart }) => {
    await http.post('/rates', V2_FORM);
    await http.post('/rates', { ...V2_FORM, version: 'v3', deepRate: '0.20', activate: 'yes' });
    const before = rateTables(file);
    const html = await http.page('/rates');
    await restart();
    assert.deepEqual(rateTables(file), before);
    const after = await http.page('/rates');
    assert.equal(activeIn(after), 'v3');
    assert.equal(after.replace(/Active since [^.]*\./, ''), html.replace(/Active since [^.]*\./, ''));
    const customer = (await http.post('/customers', { name: 'A', reference: 'B' })).headers.get('location');
    const quote = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
    assert.match(await http.page(quote), /Revision 1 · \$240\.00[\s\S]*v3/);
  }));
});

describe('regression protection', () => {
  test('customer, quote, approval, and booking workflows are unaffected by rate changes', () =>
    withApp(async ({ http, file }) => {
      const customer = (await http.post('/customers', { name: 'Flow', reference: 'Demo house' })).headers.get('location');
      const accepted = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
      assert.equal((await http.post(accepted + '/revise', { ...DEEP, squareFeet: '1200', revision: '1' })).status, 303);
      assert.equal((await http.post(accepted + '/decision', { revision: '2', outcome: 'accepted' })).status, 303);
      const booked = await http.post(accepted + '/book', { date: '2030-05-06', start: '09:00', duration: '120' });
      assert.equal(booked.status, 303);
      const draft = (await http.post(customer + '/quotes', DEEP)).headers.get('location');
      const revisionsBefore = revisionsIn(file);
      const demo1 = rateTables(file).rate_profiles[0];

      assert.equal((await http.post('/rates', { ...V2_FORM, activate: 'yes' })).status, 303);

      const acceptedPage = await http.page(accepted);
      assert.match(acceptedPage, /Revision 2 · \$240\.00[\s\S]*Revision 1 · \$206\.00[\s\S]*Revision 2 accepted/);
      assert.match(await http.page(booked.headers.get('location')), /09:00–11:00 Eastern · <span class="tag">Scheduled/);
      assert.equal((await http.post(draft + '/decision', { revision: '2', outcome: 'accepted' })).status, 409);
      assert.equal((await http.post(draft + '/revise', { ...DEEP, revision: '1' })).status, 303);
      assert.match(await http.page(draft), /Revision 2 · \$220\.00[\s\S]*v2[\s\S]*Revision 1 · \$206\.00[\s\S]*demo-1/);
      assert.equal((await http.post(draft + '/revise', { ...DEEP, revision: '1' })).status, 409, 'stale revision');
      assert.equal((await http.post(draft + '/decision', { revision: '2', outcome: 'accepted' })).status, 303);
      assert.equal((await http.post(draft + '/book', { date: '2030-05-06', start: '10:00', duration: '60' })).status,
        409, 'overlap');
      assert.match(await http.page('/?q=Flow'), /Flow/);

      assert.deepEqual(revisionsIn(file).slice(0, revisionsBefore.length), revisionsBefore, 'saved revisions untouched');
      assert.deepEqual(rateTables(file).rate_profiles[0], demo1, 'demo-1 profile untouched');
    }));

  test('other error pages are unchanged', () => withApp(async ({ http }) => {
    const response = await http.get('/quotes/999');
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /<h1>Quote not found\.<\/h1>/);
    assert.match(html, /Return to the customer directory/);
  }));

  test('demo mode shows the rates page', async () => {
    const http = await start(':memory:', { demo: true });
    try {
      const html = await http.page('/rates');
      assert.equal(activeIn(html), 'demo-1');
      assert.match(await http.page('/quotes/2'), /Revision 1 · \$90\.00[\s\S]*Service minimum · \$12\.00/);
    } finally {
      await http.stop();
    }
  });
});
