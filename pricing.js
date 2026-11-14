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

// A rate profile is a named, versioned price list. Every amount is in whole cents:
// squareFootCents is the price per square foot, so 17 means $0.17 per square foot.
export const defaultRateProfile = Object.freeze({
  version: 'demo-1',
  bathroomCents: 1800,
  services: Object.freeze({
    standard: Object.freeze({ squareFootCents: 10, minimumCents: 9000 }),
    deep: Object.freeze({ squareFootCents: 17, minimumCents: 14000 }),
    moveout: Object.freeze({ squareFootCents: 21, minimumCents: 18000 }),
  }),
});

// Caps each unit price so that 20,000 sq ft or 20 bathrooms stays a safe integer.
export const MAX_RATE_CENTS = 1_000_000;

function rateCents(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RATE_CENTS) {
    throw new TypeError('Rate profile ' + name + ' must be whole cents from 0 to ' + MAX_RATE_CENTS + '.');
  }
  return value;
}

// The services every published profile must price. The quote form offers exactly these.
export const SERVICES = Object.freeze(Object.keys(defaultRateProfile.services));
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function rateVersion(value) {
  const version = typeof value === 'string' ? value.trim() : '';
  if (!VERSION_PATTERN.test(version)) {
    throw new InputError('Version must be 1 to 40 letters, digits, dots, dashes, or underscores, '
      + 'starting with a letter or digit.');
  }
  return version;
}

// Converts a dollar amount typed by staff ("18", "18.5", "0.17") to whole cents using string
// arithmetic only, so no floating-point rounding can occur. Sub-cent precision is rejected.
export function dollarsToCents(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new InputError(field + ' is required.');
  if (/^-/.test(text)) throw new InputError(field + ' cannot be negative.');
  if (/^\d*\.\d{3,}$/.test(text)) {
    throw new InputError(field + ' must be in whole cents: use at most 2 decimal places.');
  }
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new InputError(field + ' must be a dollar amount such as 18.00, without $ or commas.');
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents > MAX_RATE_CENTS) {
    throw new InputError(field + ' must be at most $' + (MAX_RATE_CENTS / 100).toLocaleString('en-US')
      + '.00.');
  }
  return cents;
}

// Validates a submitted rate profile (operator input) and returns a normalized copy.
// Digit strings are accepted for amounts, as with quote scope fields.
export function validateRateProfile(input) {
  if (typeof input !== 'object' || input === null) throw new InputError('A rate profile is required.');
  const version = rateVersion(input.version);
  const bathroomCents = whole(input.bathroomCents, 'Bathroom price (cents)', 0, MAX_RATE_CENTS);
  const { services } = input;
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new InputError('Rates for every service are required.');
  }
  const unknown = Object.keys(services).find(name => !SERVICES.includes(name));
  if (unknown !== undefined) throw new InputError('Unknown service: ' + unknown + '.');
  const normalized = {};
  for (const name of SERVICES) {
    const rates = Object.hasOwn(services, name) ? services[name] : undefined;
    if (typeof rates !== 'object' || rates === null) throw new InputError('Rates for ' + name + ' are required.');
    normalized[name] = {
      squareFootCents: whole(rates.squareFootCents, name + ' price per square foot (cents)', 0, MAX_RATE_CENTS),
      minimumCents: whole(rates.minimumCents, name + ' minimum (cents)', 0, MAX_RATE_CENTS),
    };
  }
  return { version, bathroomCents, services: normalized };
}

// A malformed profile is a configuration error, not operator input, so it throws TypeError.
function checkProfile(profile) {
  if (typeof profile?.version !== 'string' || !profile.version.trim() || profile.version.length > 40) {
    throw new TypeError('Rate profile version must be a non-empty string of at most 40 characters.');
  }
  rateCents(profile.bathroomCents, 'bathroomCents');
  if (typeof profile.services !== 'object' || profile.services === null) {
    throw new TypeError('Rate profile services are required.');
  }
  for (const [name, rates] of Object.entries(profile.services)) {
    rateCents(rates?.squareFootCents, name + '.squareFootCents');
    rateCents(rates?.minimumCents, name + '.minimumCents');
  }
}

export function estimate(fields, profile = defaultRateProfile) {
  checkProfile(profile);
  const { service } = fields;
  if (typeof service !== 'string' || !Object.hasOwn(profile.services, service)) {
    throw new InputError('Choose a listed service.');
  }
  const scope = {
    service,
    squareFeet: whole(fields.squareFeet, 'Square feet', 100, 20000),
    bathrooms: whole(fields.bathrooms, 'Bathrooms', 0, 20),
  };
  const { squareFootCents, minimumCents } = profile.services[service];
  const { bathroomCents } = profile;
  const lines = [
    { label: 'Floor area', cents: scope.squareFeet * squareFootCents },
    { label: 'Bathrooms', cents: scope.bathrooms * bathroomCents },
  ];
  const subtotal = lines.reduce((sum, line) => sum + line.cents, 0);
  if (subtotal < minimumCents) lines.push({ label: 'Service minimum', cents: minimumCents - subtotal });
  return {
    scope,
    lines,
    totalCents: Math.max(subtotal, minimumCents),
    rateVersion: profile.version,
    rates: { squareFootCents, bathroomCents, minimumCents },
  };
}
