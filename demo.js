import { shiftDay } from './scheduling.js';

export function seedDemo(repository, today) {
  const apartment = repository.addCustomer({
    name: 'Sample Apartment Turnover', reference: 'Unit B',
  });
  const turnover = {
    title: 'Move-out cleaning', service: 'moveout', squareFeet: 1200, bathrooms: 2,
  };
  const accepted = repository.addQuote(apartment, turnover);
  repository.revise(accepted, 1, { ...turnover, squareFeet: 1400 });
  repository.decide(accepted, 2, 'accepted');
  repository.scheduleQuote(accepted, { date: '2030-05-06', start: '09:00', duration: '120' });

  const condo = repository.addCustomer({
    name: 'Sample Condo', reference: 'North Building',
  });
  repository.addQuote(condo, {
    title: 'Routine cleaning', service: 'standard', squareFeet: 600, bathrooms: 1,
  });

  const home = repository.addCustomer({
    name: 'Sample Townhouse', reference: 'Corner Unit',
  });
  const declined = repository.addQuote(home, {
    title: 'Deep cleaning', service: 'deep', squareFeet: 1750, bathrooms: 3,
  });
  repository.decide(declined, 1, 'declined');

  const portfolio = [
    { offset: -1, start: '14:00', customer: apartment, title: 'Unit A turnover', service: 'moveout' },
    { offset: 0, start: '09:00', customer: home, title: 'Townhouse maintenance', service: 'standard' },
    { offset: 0, start: '13:00', customer: condo, title: 'Condo deep clean', service: 'deep' },
    { offset: 1, start: '10:30', customer: apartment, title: 'Unit C preparation', service: 'standard' },
    { offset: 2, start: '09:30', customer: home, title: 'Guest suite cleaning', service: 'deep' },
    { offset: 3, start: '13:30', customer: condo, title: 'Common area refresh', service: 'standard' },
  ];
  if (!today) return;
  for (const item of portfolio) {
    const date = shiftDay(today, item.offset);
    if (date === '2030-05-06' || !/^20/.test(date)) continue;
    const quote = repository.addQuote(item.customer, { ...item, squareFeet: 1050, bathrooms: 2 });
    repository.decide(quote, 1, 'accepted');
    repository.scheduleQuote(quote, { date, start: item.start, duration: '120' });
  }
}
