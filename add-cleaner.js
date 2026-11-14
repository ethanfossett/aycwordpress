import { resolve } from 'node:path';
import { openRepository } from './repository.js';
import { openStaff } from './staff.js';

const [, , name, crew] = process.argv;
const password = process.env.AYC_NEW_STAFF_PASSWORD;
if (!/^[a-z][a-z0-9-]{2,39}$/.test(name ?? '') || !/^[1-9]\d*$/.test(crew ?? '') ||
    !password || password.length < 12 || password.length > 256) {
  throw new Error('Supply a username, crew ID, and AYC_NEW_STAFF_PASSWORD (12–256 characters).');
}
process.umask(0o077);
const file = resolve(process.env.AYC_DATABASE ?? 'data/operations.sqlite');
const repository = openRepository(file);
try {
  if (!repository.crews().some(item => item.id === Number(crew))) throw new Error('Crew not found.');
  openStaff(file, [{ name, crewId: Number(crew), password, role: 'cleaner' }]).close();
  console.log('Cleaner account available. Existing accounts retain their original password and crew.');
} finally {
  repository.close();
}
