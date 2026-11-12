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
