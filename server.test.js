import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { app } from './server.js';

test('customer search, quote revision, stale decision rejection, and persistent approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-operations-'));
  let server;
  let base;
  async function start() {
    server = app(join(dir, 'test.sqlite')).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  const stop = () => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  const post = (path, fields) => fetch(base + path, {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
  const page = async path => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    return response.text();
  };

  try {
    await start();
    const created = await post('/customers', { name: 'Sample <Customer>', reference: 'Demo house' });
    assert.equal(created.status, 303);
    const customer = created.headers.get('location');
    assert.match(await page('/?q=Demo'), /Sample &lt;Customer&gt;/);
    assert.match(await page('/?q=Missing'), /No matching customers/);
    assert.doesNotMatch(await page('/?q=Missing'), /Sample &lt;Customer&gt;/);

    const scope = { title: 'Demo move-out', service: 'deep', squareFeet: '1000', bathrooms: '2' };
    assert.equal((await post(customer + '/quotes', { ...scope, bathrooms: '2.5' })).status, 400);
    const draft = await post(customer + '/quotes', scope);
    assert.equal(draft.status, 303);
    const quote = draft.headers.get('location');
    assert.match(await page(customer), /Demo move-out/);
    assert.match(await page(quote), /Revision 1 · \$206\.00/);

    assert.equal((await post(quote + '/revise', {
      ...scope, squareFeet: '1200', revision: '1',
    })).status, 303);
    const decision = revision => post(quote + '/decision', { revision, outcome: 'accepted' });
    assert.equal((await decision('1')).status, 409);
    assert.equal((await decision('2')).status, 303);
    assert.equal((await decision('2')).status, 303);
    assert.equal((await post(quote + '/revise', { ...scope, revision: '2' })).status, 409);
    await stop();

    await start();
    const saved = await page(quote);
    assert.match(saved, /Revision 2 accepted/);
    assert.match(saved, /Revision 1 · \$206\.00/);
    assert.match(saved, /Revision 2 · \$240\.00/);
    assert.doesNotMatch(saved, /Save revision/);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('demo mode exposes draft, revised accepted, and declined quotes', async () => {
  const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = async path => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    assert.match(await page('/?q=Apartment'), /Sample Apartment Turnover/);
    assert.match(await page('/quotes/1'), /Revision 2 accepted/);
    assert.match(await page('/quotes/2'), /Service minimum/);
    assert.match(await page('/quotes/3'), /Revision 1 declined/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('booking workflow rejects overlaps and stale changes, and releases cancelled capacity', async () => {
  const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, fields) => fetch(base + path, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  const day = '2030-05-06';
  const slot = { date: day, start: '09:00', duration: '120' };
  try {
    const retry = await post('/quotes/1/book', slot);
    assert.equal(retry.status, 303);
    assert.equal(retry.headers.get('location'), '/bookings/1');
    assert.equal((await post('/quotes/2/book', slot)).status, 409);
    assert.equal((await post('/quotes/2/decision', { revision: '1', outcome: 'accepted' })).status, 303);
    assert.equal((await post('/quotes/2/book', { ...slot, date: '2030-02-30' })).status, 400);
    assert.equal((await post('/quotes/2/book', { ...slot, start: '10:30' })).status, 409);
    assert.equal((await post('/quotes/2/book', { ...slot, start: '11:00' })).status, 303);
    assert.equal((await post('/bookings/1/reschedule', { ...slot, start: '12:00', version: '1' })).status, 409);
    assert.equal((await post('/bookings/1/reschedule', { ...slot, start: '08:00', duration: '60', version: '1' })).status, 303);
    assert.equal((await post('/bookings/1/cancel', { version: '1' })).status, 409);
    assert.equal((await post('/bookings/1/cancel', { version: '2' })).status, 303);
    assert.equal((await post('/bookings/2/reschedule', { ...slot, start: '08:00', version: '1' })).status, 303);
    const response = await fetch(base + '/schedule?day=' + day);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /08:00–10:00[\s\S]*Routine cleaning[\s\S]*scheduled/);
    assert.match(html, /Move-out cleaning[\s\S]*cancelled/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('dispatcher updates customer details and closes a job with durable history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-dispatch-'));
  const file = join(dir, 'dispatch.sqlite');
  let server;
  let base;
  async function start(demo) {
    server = app(file, { demo, now: () => new Date('2030-05-06T16:00:00Z') }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  const stop = () => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  const post = (path, fields) => fetch(base + path, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  const page = async path => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    return response.text();
  };

  try {
    await start(true);
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).headers.get('location'), '/today');
    assert.match(await page('/today'), /Today’s jobs[\s\S]*Move-out cleaning/);
    assert.match(await page('/schedule?day=2030-05-06'), /Week at a glance[\s\S]*2030-05-12/);
    assert.match((await fetch(base + '/assets/app.css')).headers.get('content-type'), /text\/css/);
    assert.equal((await post('/customers/1/edit', {
      name: 'Sample Turnover', reference: 'Unit B', access: 'Use sample side entrance', notes: '<Pets>',
    })).status, 303);
    assert.doesNotMatch(await page('/bookings/1'), /Use sample side entrance|&lt;Pets&gt;/);
    assert.match(await page('/customers/1'), /Use sample side entrance[\s\S]*&lt;Pets&gt;/);
    assert.equal((await post('/quotes/2/decision', { revision: 1, outcome: 'accepted' })).status, 303);
    const clash = await post('/quotes/2/book', {date:'2030-05-06', start:'09:30', duration: 90});
    assert.equal(clash.status, 409);
    assert.match(await clash.text(), /role="alert"[\s\S]*09:30/);
    const created = await post('/quotes/2/book', {date:'2030-05-06', start:'11:00', duration: 90});
    assert.equal(created.status, 303);
    const other = created.headers.get('location');
    assert.equal((await post('/customers/2/edit', {
      name: 'Sample Condo', reference: 'Changed location', access: 'Changed access',
    })).status, 303);
    assert.match(await page(other), /North Building/);
    assert.doesNotMatch(await page(other), /Changed location|Changed access/);
    const move = await post(other + '/reschedule', {version:1, date:'2030-05-06', start:'09:30', duration:90});
    assert.equal(move.status, 409);
    assert.match(await move.text(), /11:00–12:30[\s\S]*role="alert"[\s\S]*09:30/);
    assert.equal((await post(other + '/start', {version:1})).status, 303);
    assert.equal((await post(other + '/interrupt', {version:2, detail:''})).status, 400);
    assert.equal((await post(other + '/interrupt', {version:2, detail:'Started by mistake'})).status, 303);
    assert.match(await page(other), /Cancelled[\s\S]*Stopped before completion: Started by mistake/);
    assert.equal((await post('/quotes/2/book', {date:'2030-05-06', start:'11:00', duration:90})).status, 303);
    assert.equal((await post('/bookings/1/complete', { version: 1 })).status, 409);
    assert.equal((await post('/bookings/1/start', { version: 1 })).status, 303);
    assert.equal((await post('/bookings/1/cancel', { version: 1 })).status, 409);
    assert.equal((await post('/bookings/1/complete', { version: 2, detail: 'Final walkthrough done.' })).status, 303);
    assert.equal((await post('/bookings/1/complete', { version: 2 })).status, 409);
    await stop();

    await start(false);
    const job = await page('/bookings/1');
    assert.match(job, /Completed[\s\S]*Final walkthrough done\.[\s\S]*started/);
    assert.match(job, /Accepted quote revision 2/);
    assert.match(await page('/customers/1'), /Booking history[\s\S]*Move-out cleaning[\s\S]*Completed/);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('location selection is customer-scoped and booking instructions are frozen', async () => {
  const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, fields) => fetch(base + path, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  const page = async path => (await fetch(base + path)).text();
  try {
    assert.equal((await post('/customers/1/locations', { reference: 'Annex', access: 'East entrance' })).status, 303);
    const customer = await page('/customers/1');
    const [, id] = customer.match(/<option value="(\d+)">Annex<\/option>/);
    assert.equal((await post('/customers/2/locations/' + id, { reference: 'Wrong owner' })).status, 404);
    const draft = { title: 'Annex clean', service: 'deep', squareFeet: 1000, bathrooms: 1, locationId: id };
    assert.equal((await post('/customers/2/quotes', draft)).status, 400);
    async function book(start) {
      const created = await post('/customers/1/quotes', draft);
      assert.equal(created.status, 303);
      const quote = created.headers.get('location');
      assert.match(await page(quote), /Service location: Annex/);
      assert.equal((await post(quote + '/decision', { revision: 1, outcome: 'accepted' })).status, 303);
      const booking = await post(quote + '/book', { date: '2030-05-06', start, duration: 60 });
      assert.equal(booking.status, 303);
      return booking.headers.get('location');
    }
    const old = await book('12:00');
    assert.equal((await post('/customers/1/locations/' + id, { reference: 'Annex', access: 'West entrance' })).status, 303);
    const recent = await book('13:00');
    assert.match(await page(old), /East entrance/);
    assert.match(await page(recent), /West entrance/);
    assert.doesNotMatch(await page('/bookings/1'), /East entrance|West entrance/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('crew capacity, reassignment recovery and legacy booking migration', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openRepository } = await import('./repository.js');
  const { seedDemo } = await import('./demo.js');
  const dir = await mkdtemp(join(tmpdir(), 'ayc-crews-'));
  const file = join(dir, 'operations.sqlite');
  let server;
  try {
    const repo = openRepository(file);
    seedDemo(repo);
    repo.close();
    const legacy = new DatabaseSync(file);
    legacy.exec('DROP TABLE booking_crews; DROP TABLE crews;');
    legacy.close();
    server = app(file).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (path, fields) => fetch(base + path, {
      method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
    });
    const page = async path => (await fetch(base + path)).text();

    assert.match(await page('/bookings/1'), /Crew: <strong>Default crew/);
    assert.equal((await post('/crews', { name: 'Green crew' })).status, 303);
    assert.equal((await post('/crews', { name: 'green crew' })).status, 409);
    assert.equal((await post('/quotes/2/decision', { revision: 1, outcome: 'accepted' })).status, 303);
    const slot = { date: '2030-05-06', start: '09:00', duration: 120 };
    assert.equal((await post('/quotes/2/book', { ...slot, crewId: 1 })).status, 409);
    assert.equal((await post('/quotes/2/book', { ...slot, crewId: 999 })).status, 400);
    const result = await post('/quotes/2/book', { ...slot, crewId: 2 });
    assert.equal(result.status, 303);
    const path = result.headers.get('location');
    const move = await post(path + '/reschedule', { ...slot, crewId: 1, version: 1 });
    assert.equal(move.status, 409);
    assert.match(await move.text(), /Green crew[\s\S]*role="alert"[\s\S]*value="1" selected/);
    assert.match(await page(path), /Crew: <strong>Green crew/);
    assert.match(await page('/bookings/1'), /Crew: <strong>Default crew/);
    const schedule = await page('/schedule?day=2030-05-06');
    assert.match(schedule, /<h3>Default crew<\/h3>[\s\S]*Move-out cleaning[\s\S]*<h3>Green crew<\/h3>[\s\S]*Routine cleaning/);
    assert.equal((await post(path + '/reschedule', {
      ...slot, start: '11:00', crewId: 1, version: 1,
    })).status, 303);
    assert.match(await page(path), /Crew: <strong>Default crew/);
    assert.equal((await post(path + '/reschedule', { ...slot, crewId: 2, version: 1 })).status, 409);
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('crew acknowledgment follows the current assignment and booking version', async () => {
  const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, fields) => fetch(base + path, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  const page = async path => (await fetch(base + path)).text();
  const day = '2030-05-06';
  const ack = (crewId, version) => post('/cleaner/acknowledge', { crewId, version, bookingId: 1 });
  try {
    assert.equal((await post('/crews', { name: 'Replacement crew' })).status, 303);
    assert.match(await page('/cleaner?crew=1&day=' + day), /Move-out cleaning/);
    assert.doesNotMatch(await page('/cleaner?crew=2&day=' + day), /Move-out cleaning/);
    assert.equal((await ack(2, 1)).status, 409);
    assert.equal((await ack(1, 1)).status, 303);
    assert.equal((await ack(1, 1)).status, 303);
    assert.match(await page('/bookings/1'), /Crew acknowledged/);

    assert.equal((await post('/bookings/1/reschedule', {
      crewId: 2, version: 1, date: day, start: '09:00', duration: 120,
    })).status, 303);
    assert.equal((await ack(1, 1)).status, 409);
    assert.match(await page('/bookings/1'), /Awaiting crew acknowledgment/);
    assert.equal((await ack(2, 2)).status, 303);
    assert.equal((await post('/bookings/1/reschedule', {
      crewId: 2, version: 2, date: day, start: '11:00', duration: 120,
    })).status, 303);
    assert.equal((await ack(2, 2)).status, 409);
    assert.match(await page('/bookings/1'), /Awaiting crew acknowledgment/);
    assert.equal((await ack(2, 3)).status, 303);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('recurring confirmation books available visits once and allows conflict recovery', async () => {
  const server = app(':memory:', { demo: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, fields) => fetch(base + path, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  const path = '/quotes/1/recurring';
  const fields = { date: '2030-05-06', start: '09:00', duration: '90', cadence: 'biweekly', crewId: '1' };
  const page = async (suffix = '') => (await fetch(base + path + suffix)).text();
  try {
    const preview = await page('?' + new URLSearchParams(fields));
    assert.match(preview, /2030-05-06 · 09:00–10:30 · Conflict/);
    assert.match(preview, /2030-06-17 · 09:00–10:30 · Available/);
    assert.equal((await post(path, { ...fields, action: 'confirm' })).status, 303);
    const booked = await page();
    assert.equal(booked.match(/<a href="\/bookings\//g).length, 3);
    assert.equal((await post(path, { ...fields, action: 'confirm' })).status, 303);
    assert.equal(await page(), booked);
    assert.equal((await post(path, { action: 'pause' })).status, 303);
    assert.equal((await post(path, { ...fields, action: 'confirm' })).status, 409);
    assert.equal((await post('/bookings/1/cancel', { version: 1 })).status, 303);
    assert.equal((await post(path, { action: 'resume' })).status, 303);
    assert.equal((await post(path, { ...fields, action: 'confirm' })).status, 303);
    const recovered = await page();
    assert.equal(recovered.match(/<a href="\/bookings\//g).length, 4);
    const [, visit] = recovered.match(/2030-05-06 · 09:00–10:30 · <a href="(\/bookings\/\d+)"/);
    assert.equal((await post(visit + '/reschedule', { ...fields, date: '2030-05-07', version: 1 })).status, 303);
    assert.equal((await post(path, { ...fields, action: 'confirm' })).status, 303);
    assert.equal((await page()).match(/<a href="\/bookings\//g).length, 4);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
