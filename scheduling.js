import { InputError } from './pricing.js';

export function scheduleDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) {
    throw new InputError('Enter a schedule date from 2000 to 2099.');
  }
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new InputError('Enter a valid calendar date.');
  }
  return value;
}

export function bookingSlot(fields) {
  const date = scheduleDate(fields.date);
  const match = /^(\d{2}):(\d{2})$/.exec(fields.start);
  const duration = Number(fields.duration);
  if (!match || Number(match[2]) >= 60 || ![60, 90, 120, 180, 240].includes(duration)) {
    throw new InputError('Choose a valid start time and duration.');
  }
  const start = Number(match[1]) * 60 + Number(match[2]);
  if (start < 8 * 60 || start + duration > 18 * 60 || start % 30 !== 0) {
    throw new InputError('Bookings must fit between 8 AM and 6 PM and start on the half hour.');
  }
  return { date, start, end: start + duration };
}

export function shiftDay(day, offset) {
  const date = new Date(scheduleDate(day) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
