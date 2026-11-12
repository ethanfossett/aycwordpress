export function seedDemo(repository) {
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
}
