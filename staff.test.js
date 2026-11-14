import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { app } from './server.js';
import { sampleAccounts } from './staff.js';
import { copyDatabase } from './backup.js';

test('staff boundaries, reassignment audit and restored records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ayc-synthetic-'));
  const file = join(dir, 'demo.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const restored = join(dir, 'restored.sqlite');
  let server;
  let base;
  async function start(path, demo) {
    server = app(path, { staffFile: path, demo, accounts: demo ? sampleAccounts : [] })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  const stop = () => new Promise(resolve => server.close(resolve));
  const send = (path, cookie, fields) => fetch(base + path, {
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { Origin: base } : {}) },
    ...(fields ? { method: 'POST', body: new URLSearchParams(fields) } : {}),
  });
  async function login(index) {
    const result = await send('/login', '', sampleAccounts[index]);
    assert.equal(result.status, 303);
    return result.headers.get('set-cookie').split(';')[0];
  }
  try {
    await start(file, true);
    assert.equal((await send('/customers')).headers.get('location'), '/login');
    assert.equal((await send('/login', '', { name: 'demo-dispatcher', password: 'DUMMY-WRONG' })).status, 401);
    const dispatch = await login(0);
    const cleanerA = await login(1);
    const cleanerB = await login(2);
    const day = '2030-05-06';
    const list = '/cleaner?day=' + day;
    assert.match(await (await send(list + '&crew=2', cleanerA)).text(), /Move-out cleaning/);
    assert.doesNotMatch(await (await send(list + '&crew=1', cleanerB)).text(), /Move-out cleaning/);
    assert.equal((await send('/bookings/1', cleanerA)).status, 403);
    assert.equal((await send('/bookings/1/reschedule', cleanerA, {})).status, 403);
    const ack = (cookie, crewId, version) => send('/cleaner/acknowledge', cookie, { bookingId: 1, crewId, version });
    assert.equal((await ack(cleanerA, 1, 1)).status, 303);
    assert.equal((await send('/bookings/1/reschedule', dispatch, {
      crewId: 2, version: 1, date: day, start: '09:00', duration: 120,
    })).status, 303);
    assert.doesNotMatch(await (await send(list, cleanerA)).text(), /Move-out cleaning/);
    assert.equal((await ack(cleanerA, 2, 2)).status, 409);
    assert.equal((await ack(cleanerB, 1, 2)).status, 303);
    assert.match(await (await send('/bookings/1', dispatch)).text(), /By demo-dispatcher/);
    await copyDatabase(file, backup);
    await copyDatabase(backup, restored);
    await assert.rejects(copyDatabase(backup, restored), { code: 'EEXIST' });
    await stop();

    await start(restored, false);
    assert.equal((await send('/bookings/1', dispatch)).headers.get('location'), '/login');
    const fresh = await login(0);
    assert.match(await (await send('/bookings/1', fresh)).text(), /Demo crew B[\s\S]*By demo-dispatcher/);
    assert.match(await (await send('/quotes/1', fresh)).text(), /Revision 2 accepted/);
    assert.match(await (await send('/customers/1', fresh)).text(), /Sample Apartment Turnover/);
    assert.equal((await send('/logout', fresh, {})).status, 303);
    assert.equal((await send('/today', fresh)).headers.get('location'), '/login');
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
