export class InputError extends Error {}

export function requiredText(value, field, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new InputError(field + ' is required and must be at most ' + max + ' characters.');
  }
  return value.trim();
}

function whole(value, field, minimum, maximum) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new InputError(field + ' must be a whole number from ' + minimum + ' to ' + maximum + '.');
  }
  return value;
}

const services = {
  standard: { rate: 10, minimum: 9000 },
  deep: { rate: 17, minimum: 14000 },
  moveout: { rate: 21, minimum: 18000 },
};

export function estimate(fields) {
  const { service } = fields;
  if (typeof service !== 'string' || !Object.hasOwn(services, service)) {
    throw new InputError('Choose a listed service.');
  }
  const scope = {
    service,
    squareFeet: whole(fields.squareFeet, 'Square feet', 100, 20000),
    bathrooms: whole(fields.bathrooms, 'Bathrooms', 0, 20),
  };
  const { rate, minimum } = services[service];
  const lines = [
    { label: 'Floor area', cents: scope.squareFeet * rate },
    { label: 'Bathrooms', cents: scope.bathrooms * 1800 },
  ];
  const subtotal = lines.reduce((sum, line) => sum + line.cents, 0);
  if (subtotal < minimum) lines.push({ label: 'Service minimum', cents: minimum - subtotal });
  return { scope, lines, totalCents: Math.max(subtotal, minimum), rateVersion: 'demo-1' };
}
