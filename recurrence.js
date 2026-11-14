import { InputError } from './pricing.js';
import { bookingSlot, shiftDay } from './scheduling.js';

export function recurringSlots(fields) {
  const first = bookingSlot(fields);
  const { cadence } = fields;
  if (!['weekly', 'biweekly', 'monthly'].includes(cadence)) {
    throw new InputError('Choose a recurring cadence.');
  }
  const anchor = new Date(first.date + 'T00:00:00Z');
  return Array.from({ length: 4 }, (_, index) => {
    let date;
    if (cadence === 'monthly') {
      const next = new Date(anchor);
      next.setUTCDate(1);
      next.setUTCMonth(anchor.getUTCMonth() + index);
      const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0));
      next.setUTCDate(Math.min(anchor.getUTCDate(), last.getUTCDate()));
      date = next.toISOString().slice(0, 10);
    } else {
      date = shiftDay(first.date, index * (cadence === 'weekly' ? 7 : 14));
    }
    return bookingSlot({ ...fields, date });
  });
}
