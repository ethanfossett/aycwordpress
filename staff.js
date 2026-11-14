import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const sampleAccounts = [
  { name: 'demo-dispatcher', password: 'DUMMY-DISPATCHER-ONLY', role: 'dispatcher' },
  { name: 'demo-cleaner-a', password: 'DUMMY-CLEANER-A-ONLY', role: 'cleaner', crewId: 1 },
  { name: 'demo-cleaner-b', password: 'DUMMY-CLEANER-B-ONLY', role: 'cleaner', crewId: 2 },
];

const digest = token => createHash('sha256').update(token).digest('hex');
const lifetime = 8 * 60 * 60;

export function openStaff(file, accounts = []) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS staff_accounts (
      name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('dispatcher', 'cleaner')),
      crew_id INTEGER REFERENCES crews(id),
      CHECK((role = 'dispatcher' AND crew_id IS NULL) OR (role = 'cleaner' AND crew_id IS NOT NULL))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS staff_sessions (
      digest TEXT PRIMARY KEY, name TEXT NOT NULL REFERENCES staff_accounts(name), expires INTEGER NOT NULL
    ) STRICT;`);
  for (const { name, password, role, crewId } of accounts) {
    const salt = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING')
      .run(name, salt, scryptSync(password, salt, 64).toString('hex'), role, crewId ?? null);
  }
  function token(request) {
    return /(?:^|;\s*)ayc_session=([0-9a-f]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
  }
  const dummySalt = randomBytes(16).toString('hex');
  return {
    close: () => db.close(),
    account(request) {
      const cookie = token(request);
      if (!cookie) return;
      return db.prepare(`SELECT a.name, a.role, a.crew_id FROM staff_sessions s
        JOIN staff_accounts a ON a.name = s.name WHERE s.digest = ? AND s.expires > ?`)
        .get(digest(cookie), Math.floor(Date.now() / 1000));
    },
    login(name, password) {
      if (typeof name !== 'string' || typeof password !== 'string' || password.length > 256) return;
      const account = db.prepare('SELECT * FROM staff_accounts WHERE name = ?').get(name);
      const hash = scryptSync(password, account?.salt ?? dummySalt, 64);
      if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) return;
      const cookie = randomBytes(32).toString('hex');
      const now = Math.floor(Date.now() / 1000);
      db.prepare('DELETE FROM staff_sessions WHERE expires <= ?').run(now);
      db.prepare('INSERT INTO staff_sessions VALUES (?, ?, ?)').run(digest(cookie), name, now + lifetime);
      return { cookie: 'ayc_session=' + cookie + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + lifetime, role: account.role };
    },
    logout(request) {
      const cookie = token(request);
      if (cookie) db.prepare('DELETE FROM staff_sessions WHERE digest = ?').run(digest(cookie));
      return 'ayc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
    },
  };
}
