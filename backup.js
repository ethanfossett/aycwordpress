import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, openSync, rmSync } from 'node:fs';

export async function copyDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  let reserved = false;
  try {
    closeSync(openSync(destination, 'wx', 0o600));
    reserved = true;
    await backup(db, destination);
    const copy = new DatabaseSync(destination);
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
        || copy.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('Database verification failed.');
      }
      if (copy.prepare("SELECT name FROM sqlite_master WHERE name = 'staff_sessions' AND type = 'table'").get()) {
        copy.exec('DELETE FROM staff_sessions');
      }
    } finally {
      copy.close();
    }
  } catch (error) {
    if (reserved) rmSync(destination, { force: true });
    throw error;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error('Usage: node backup.js SOURCE DESTINATION');
  await copyDatabase(source, destination);
  console.log('Verified database copy created.');
}
