import { formatEastern, isExpired } from './expiration.js';

const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const money = cents => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
}).format(cents / 100);

export function layout(title, content, { restricted = false } = {}) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · AYC Operations</title>
  <link rel="stylesheet" href="/assets/app.css">
  ${restricted ? '<header><strong>AYC Operations</strong></header>' : `<header><a class="brand" href="/today">AYC Operations</a><nav aria-label="Main navigation">
    <a href="/today">Today</a><a href="/customers">Customers</a><a href="/quotes">Quotes</a>
    <a href="/schedule">Schedule</a><a href="/crews">Crews</a><a href="/cleaner">Cleaner</a><a href="/settings">Settings</a>
  </nav><form method="post" action="/logout"><button>Sign out</button></form></header>`}
  <main><h1>${escape(title)}</h1>${content}</main></html>`;
}

export function directory(customers, query) {
  const rows = customers.map(customer => `<li><a href="/customers/${customer.id}">
    ${escape(customer.name)}</a> · ${escape(customer.reference)} · ${customer.quote_count} quotes</li>`).join('');
  return layout('Customers', `
    <form method="get" action="/customers"><label>Search <input name="q" value="${escape(query)}"></label><button>Search</button></form>
    ${rows ? `<ul>${rows}</ul>` : '<p>No matching customers.</p>'}
    <h2>Add customer</h2>
    <form method="post" action="/customers">
      <label>Name <input name="name" required maxlength="80"></label>
      <label>Site reference <input name="reference" required maxlength="80" placeholder="Sample property"></label>
      <button>Add customer</button>
    </form>`);
}

export const SERVICE_LABELS = { standard: 'Standard', deep: 'Deep clean', moveout: 'Move-out' };

function scopeFields(scope = {}) {
  const options = Object.entries(SERVICE_LABELS).map(([key, label]) =>
    `<option value="${key}"${scope.service === key ? ' selected' : ''}>${label}</option>`).join('');
  return `<label>Service <select name="service">${options}</select></label>
  <label>Square feet <input type="number" name="squareFeet" required min="100" max="20000"
    value="${escape(scope.squareFeet ?? 1000)}"></label>
  <label>Bathrooms <input type="number" name="bathrooms" required min="0" max="20"
    value="${escape(scope.bathrooms ?? 1)}"></label>`;
}

function locationForm(customerId, location) {
  const suffix = location ? '/' + location.id : '';
  return `<form method="post" action="/customers/${customerId}/locations${suffix}">
    <label>Site reference <input name="reference" required maxlength="80" value="${escape(location?.reference ?? '')}"></label>
    <label>Access instructions <textarea name="access" maxlength="500">${escape(location?.access_notes ?? '')}</textarea></label>
    <label>Service notes <textarea name="notes" maxlength="500">${escape(location?.service_notes ?? '')}</textarea></label>
    <button>${location ? 'Save location' : 'Add location'}</button></form>`;
}

export function customerPage(customer, quotes, bookings = [], locations = []) {
  const rows = quotes.map(quote => `<li><a href="/quotes/${quote.id}">${escape(quote.title)}</a>
    · ${escape(quote.status)} · Revision ${quote.current_revision}</li>`).join('');
  return layout(customer.name, `<p>Site reference: ${escape(customer.reference)}</p>
    <div class="grid"><section class="panel"><h2>Service details</h2>
    <p><strong>Access instructions</strong></p><p class="notes">${escape(customer.access_notes || 'None recorded.')}</p>
    <p><strong>Service notes</strong></p><p class="notes">${escape(customer.service_notes || 'None recorded.')}</p>
    <details><summary>Edit customer and service details</summary>
    <form method="post" action="/customers/${customer.id}/edit">
    <label>Name <input name="name" required maxlength="80" value="${escape(customer.name)}"></label>
    <label>Site reference <input name="reference" required maxlength="80" value="${escape(customer.reference)}"></label>
    <label>Access instructions <textarea name="access" maxlength="500">${escape(customer.access_notes ?? '')}</textarea></label>
    <label>Service notes <textarea name="notes" maxlength="500">${escape(customer.service_notes ?? '')}</textarea></label>
    <button>Save customer details</button></form></details></section>
    <section class="panel"><h2>Booking history</h2>${jobList(bookings)}</section></div>
    <h2>Quote history</h2>${rows ? `<ul>${rows}</ul>` : '<p>No quotes yet.</p>'}
    <h2>Service locations</h2>
    ${locations.map(location => `<details><summary>${escape(location.reference)}${location.is_default ? ' · Default' : ''}</summary>
      ${locationForm(customer.id, location)}</details>`).join('')}
    <details><summary>Add a service location</summary>${locationForm(customer.id)}</details>
    <h2>New quote</h2><form method="post" action="/customers/${customer.id}/quotes">
    <label>Job title <input name="title" required maxlength="80"></label>
    ${locations.length ? `<label>Service location <select name="locationId">${locations.map(location =>
      `<option value="${location.id}">${escape(location.reference)}</option>`).join('')}</select></label>` : ''}
    ${scopeFields()}<button>Save draft quote</button></form>`);
}

// One line about a revision's validity. Revisions saved before expiration existed have none.
function validity({ expires_at: expiresAt, expired }) {
  if (!expiresAt) return 'No expiration date (issued before quotes expired).';
  return (expired ? 'Expired after ' : 'Valid until ') + formatEastern(expiresAt) + '.';
}

export function quotePage(quote, customer, recovery, crews = []) {
  const hiddenRevision = `<input type="hidden" name="revision" value="${quote.current_revision}">`;
  const current = quote.revisions.find(revision => revision.number === quote.current_revision);
  const history = quote.revisions.map(({ number, estimate, created_at: date, ...revision }) => `
    <article><h3>Revision ${number} · ${money(estimate.totalCents)}</h3>
      <p>${escape(validity(revision))}</p>
      <p>${escape(estimate.scope.service)} · ${estimate.scope.squareFeet} sq ft ·
        ${estimate.scope.bathrooms} bathrooms · ${escape(estimate.rateVersion)}</p>
      ${estimate.rates ? `<p>Rates: ${escape(money(estimate.rates.squareFootCents))} per sq ft ·
        ${escape(money(estimate.rates.bathroomCents))} per bathroom ·
        ${escape(money(estimate.rates.minimumCents))} minimum</p>` : ''}
      <ul>${estimate.lines.map(line => `<li>${escape(line.label)} · ${money(line.cents)}</li>`).join('')}</ul>
      <small>${escape(date)}</small>
    </article>`).join('');
  const status = current.expired
    ? `Revision ${current.number} expired after ${escape(formatEastern(current.expires_at))}. It can no longer be
      accepted. Decline it, or save a revision to issue a fresh quote at the current rates.`
    : `Revision ${current.number}: ${escape(validity(current))}`;
  const actions = quote.status === 'draft' ? `
    <p><strong>${status}</strong></p>
    <h2>Revise quote</h2><form method="post" action="/quotes/${quote.id}/revise">
    ${hiddenRevision}${scopeFields(quote.revisions[0].estimate.scope)}<button>Save revision</button></form>
    <h2>Record customer decision</h2><form method="post" action="/quotes/${quote.id}/decision">
    ${hiddenRevision}${current.expired ? '' : '<button name="outcome" value="accepted">Accept quote</button>'}
    <button name="outcome" value="declined">Decline quote</button></form>` : `
    <p>Revision ${quote.decision.revision} ${escape(quote.decision.outcome)}
    on ${escape(quote.decision.created_at)}.</p>`;
  return layout(quote.title, `<p><a href="/customers/${customer.id}">${escape(customer.name)}</a>
    · ${escape(quote.status)}</p><p>Service location: ${escape(quote.site.reference)}</p><h2>Estimate history</h2>${history}${actions}${bookingSection(quote, recovery, crews)}`);
}

function time(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

function slotFields(booking, values = {}, crews = []) {
  const duration = Number(values.duration ?? (booking ? booking.end_minute - booking.start_minute : 120));
  return `<label>Crew <select name="crewId">${crews.map(crew =>
    `<option value="${crew.id}"${crew.id === Number(values.crewId ?? booking?.crew_id ?? 1) ? ' selected' : ''}>${escape(crew.name)}</option>`).join('')}</select></label>
    <label>Date <input type="date" name="date" value="${escape(values.date ?? booking?.day ?? '')}" required></label>
    <label>Start (Eastern time) <input type="time" name="start" step="1800" min="08:00"
    value="${escape(values.start ?? time(booking?.start_minute ?? 540))}" required></label>
    <label>Duration <select name="duration">${[60, 90, 120, 180, 240].map(minutes =>
      `<option value="${minutes}"${duration === minutes ? ' selected' : ''}>${minutes} minutes</option>`).join('')}</select></label>`;
}

function bookingError(recovery) {
  return recovery ? `<p role="alert">${escape(recovery.message)}</p>` : '';
}

function bookingSection(quote, recovery, crews) {
  if (quote.status !== 'accepted') return '';
  const rows = quote.bookings.map(booking => `<li><a href="/bookings/${booking.id}">
    ${escape(booking.day)} at ${time(booking.start_minute)}</a> · ${escape(booking.job_state ?? booking.status)}</li>`).join('');
  const active = quote.bookings.some(booking => booking.status === 'scheduled' && booking.recurring_visit_id == null);
  return `<h2>Bookings</h2><p><a href="/quotes/${quote.id}/recurring">Recurring service plan</a></p>${bookingError(recovery)}${rows ? `<ul>${rows}</ul>` : '<p>No bookings yet.</p>'}
    ${active ? '' : `<form method="post" action="/quotes/${quote.id}/book">
    ${slotFields(null, recovery?.fields, crews)}<button>Schedule cleaning</button></form>`}`;
}

export function schedulePage(day, bookings, week = [], crews = []) {
  const rows = bookings.map(booking => `<li>${time(booking.start_minute)}–${time(booking.end_minute)}
    · <a href="/bookings/${booking.id}">${escape(booking.title)}</a>
    · ${escape(booking.name)} · ${escape(booking.job_state ?? booking.status)} · ${escape(booking.crew_name)}</li>`).join('');
  return layout('Cleaning schedule', `<form method="get" action="/schedule">
    <label>Day <input type="date" name="day" value="${escape(day)}" required></label>
    <button>Show day</button></form><h2>${escape(day)} · Eastern time</h2>
    ${rows ? `<ul>${rows}</ul>` : '<p>No jobs on this day.</p>'}
    <h2>Week at a glance</h2>${crews.map(crew => `<section><h3>${escape(crew.name)}</h3>
    <div class="week">${week.map(({ date, jobs }) => `<article>
    <h3><a href="/schedule?day=${date}">${date}</a></h3>
    ${jobList(jobs.filter(job => job.crew_id === crew.id))}</article>`).join('')}</div></section>`).join('')}`);

}

export function bookingPage(booking, quote, customer, history = [], site, recovery, crews = [], acknowledgment) {
  const version = `<input type="hidden" name="version" value="${booking.version}">`;
  const actions = booking.job_state === 'scheduled' ? `
    <form method="post" action="/bookings/${booking.id}/reschedule">
      ${version}${slotFields(booking, recovery?.fields, crews)}<button>Reschedule</button></form>
    <form method="post" action="/bookings/${booking.id}/cancel">
      ${version}<button>Cancel booking</button></form>
    <form method="post" action="/bookings/${booking.id}/start">${version}<button>Start job</button></form>`
    : booking.job_state === 'in_progress' ? `<form method="post" action="/bookings/${booking.id}/complete">
      ${version}<label>Completion note <textarea name="detail" maxlength="500"></textarea></label>
      <button>Complete job</button></form>
      <form method="post" action="/bookings/${booking.id}/interrupt">
      ${version}<label>Why did the job stop? <textarea name="detail" maxlength="500" required>${escape(recovery?.detail ?? '')}</textarea></label>
      <button>Stop without completing</button></form>` : '';
  const estimate = quote.revisions.find(item => item.number === quote.decision.revision).estimate;
  return layout(quote.title, `<p><a href="/customers/${customer.id}">${escape(customer.name)}</a>
    · ${escape((site ?? customer).reference)}</p><p><a href="/quotes/${quote.id}">Accepted quote revision ${quote.decision.revision}</a></p>
    <p><a href="/schedule?day=${escape(booking.day)}">${escape(booking.day)}</a> ·
    ${time(booking.start_minute)}–${time(booking.end_minute)} Eastern · <span class="tag">${jobLabel(booking.job_state)}</span></p>
    <p>Crew: <strong>${escape(booking.crew_name)}</strong></p>
    ${booking.job_state === 'scheduled' ? `<p>${acknowledgment ?
      'Crew acknowledged · ' + escape(formatEastern(acknowledgment.acknowledged_at)) : 'Awaiting crew acknowledgment'}</p>` : ''}
    <div class="grid"><section class="panel"><h2>Accepted scope</h2>
    <p>${escape(SERVICE_LABELS[estimate.scope.service])} · ${estimate.scope.squareFeet} sq ft ·
    ${estimate.scope.bathrooms} bathrooms · ${money(estimate.totalCents)}</p></section>
    <section class="panel"><h2>Service instructions</h2>
    <p class="muted">${site ? 'Saved at booking.' : 'Current customer details. This older job has no saved site snapshot.'}</p>
    <p class="notes">${escape((site ?? customer).access_notes || 'No access instructions.')}</p>
    <p class="notes">${escape((site ?? customer).service_notes || 'No service notes.')}</p></section></div>
    ${bookingError(recovery)}${actions}<h2>Job history</h2>${history.length ? `<ul>${history.map(item => `<li>
      <strong>${escape(item.kind)}</strong> · ${escape(formatEastern(item.occurred_at))}
      ${item.detail ? `<p class="notes">${escape(item.detail)}</p>` : ''}</li>`).join('')}</ul>`
      : '<p>No events recorded for this booking.</p>'}`);
}

// Whole cents to the plain dollar text used in form inputs, e.g. 17 -> "0.17", 1800 -> "18.00".
const dollars = cents => Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');

function rateList(profile) {
  return `<ul>${Object.entries(SERVICE_LABELS).map(([key, label]) => `<li>${label} ·
    ${money(profile.services[key].squareFootCents)} per sq ft · ${money(profile.services[key].minimumCents)} minimum</li>`)
    .join('')}<li>Bathrooms · ${money(profile.bathroomCents)} each</li></ul>`;
}

// The rate management page. `values` holds the publish form's fields: the active rates by default,
// or exactly what was submitted when a submission is rejected.
export function ratesPage({ active, profiles, errors = [], notice = '', values }) {
  const expected = `<input type="hidden" name="expected" value="${escape(active.version)}">`;
  const field = (name, label) => `<label>${label} <input name="${name}" inputmode="decimal" required
    maxlength="12" value="${escape(values[name] ?? '')}"></label>`;
  const versions = [...profiles].reverse().map(profile => `<article>
    <h3>${escape(profile.version)}${profile.version === active.version ? ' · active' : ''}</h3>
    <p>Published ${escape(profile.createdAt)}</p>${rateList(profile)}
    ${profile.version === active.version ? '' : `<form method="post" action="/rates/activate">${expected}
      <input type="hidden" name="version" value="${escape(profile.version)}">
      <button>Activate ${escape(profile.version)}</button></form>`}</article>`).join('');
  return layout('Rates', `
    ${notice ? `<p role="status"><strong>${escape(notice)}</strong></p>` : ''}
    ${errors.length ? `<div role="alert"><p><strong>Nothing was changed.</strong></p>
      <ul>${errors.map(error => `<li>${escape(error)}</li>`).join('')}</ul></div>` : ''}
    <h2>Active pricing · ${escape(active.version)}</h2>
    <p>Active since ${escape(active.activatedAt)}. New quotes and revisions use these rates.
      Saved revisions keep the rates they were priced with.</p>
    ${rateList(active)}
    <h2>Publish a new version</h2>
    <form method="post" action="/rates">${expected}
      <p>Published versions cannot be changed later. Enter amounts in dollars with at most 2 decimal places.</p>
      <label>Version name <input name="version" required maxlength="40" value="${escape(values.version ?? '')}"
        placeholder="2026-spring"></label>
      <small>Letters, digits, dots, dashes, or underscores.</small>
      ${field('bathroom', 'Price per bathroom ($)')}
      ${Object.entries(SERVICE_LABELS).map(([key, label]) => `<fieldset><legend>${label}</legend>
        ${field(key + 'Rate', 'Price per sq ft ($)')}${field(key + 'Minimum', 'Minimum ($)')}</fieldset>`).join('')}
      <label><input type="checkbox" name="activate" value="yes"${values.activate === 'yes' ? ' checked' : ''}>
        Activate immediately for new quotes</label>
      <button>Publish version</button>
    </form>
    <h2>Published versions</h2>
    ${versions}`);
}

// The publish form's default values: the active profile's rates as dollar text.
export function rateFormValues(profile) {
  const values = { bathroom: dollars(profile.bathroomCents) };
  for (const key of Object.keys(SERVICE_LABELS)) {
    values[key + 'Rate'] = dollars(profile.services[key].squareFootCents);
    values[key + 'Minimum'] = dollars(profile.services[key].minimumCents);
  }
  return values;
}

function jobLabel(state) {
  return { scheduled: 'Scheduled', cancelled: 'Cancelled',
    in_progress: 'In progress', completed: 'Completed' }[state] ?? 'Unknown';
}

function jobList(jobs) {
  return jobs.length ? `<ul>${jobs.map(job => `<li><a href="/bookings/${job.id}">${escape(job.title)}</a>
    <div class="muted">${escape(job.day)} · ${time(job.start_minute)}${job.name ? ' · ' + escape(job.name) : ''}</div>
    <span class="tag">${jobLabel(job.job_state)}</span></li>`).join('')}</ul>` : '<p>No jobs.</p>';
}

function quoteList(quotes, now) {
  return quotes.length ? `<ul>${quotes.map(quote => `<li><a href="/quotes/${quote.id}">${escape(quote.title)}</a>
    · ${escape(quote.name)} · ${quote.status !== 'draft' ? escape(quote.status) :
      isExpired(quote.expires_at, now) ? 'Expired' : 'Awaiting decision'}</li>`).join('')}</ul>`
    : '<p>No quotes.</p>';
}

export function quotesPage(quotes, now) {
  return layout('Quotes', `<p>Open a quote to check its scope, revisions and decision.</p>
    <p><a href="/customers">Find a customer to create a quote</a></p><section class="panel">${quoteList(quotes, now)}</section>`);
}

export function todayPage(day, jobs, overdue, quotes, now) {
  return layout('Today', `<p class="muted">${escape(day)} · Eastern time</p>
    <p><a href="/customers">Find a customer</a> · <a href="/schedule?day=${day}">Open schedule</a></p>
    <div class="grid"><section class="panel"><h2>Today’s jobs</h2>${jobList(jobs)}</section>
    <section class="panel"><h2>Unfinished earlier jobs</h2>${jobList(overdue)}</section>
    <section class="panel"><h2>Quotes needing a decision</h2>${quoteList(quotes, now)}</section></div>`);
}

export function settingsPage() {
  return layout('Settings', '<section class="panel"><h2>AYC Operations</h2><p>Eastern time · 8 AM to 6 PM</p><p><a href="/rates">Manage pricing rates</a></p></section>');
}

export function crewsPage(crews, error) {
  return layout('Crews', `${error ? bookingError({ message: error }) : ''}
    <section class="panel"><h2>Crew roster</h2><ul>${crews.map(crew =>
      `<li>${escape(crew.name)} · Crew ID ${crew.id}</li>`).join('')}</ul></section>
    <form method="post" action="/crews"><label>Crew name <input name="name" maxlength="80" required></label>
      <button>Add crew</button></form>`);
}

export function cleanerPage(crews, crewId, day, jobs, restricted = false) {
  return layout('Cleaner workspace', `<p class="muted">${restricted ? 'Assigned crew' : 'Local crew preview'} · Eastern time</p>
    <form method="get" action="/cleaner">
      ${restricted ? '' : `<label>Crew <select name="crew">${crews.map(crew =>
        `<option value="${crew.id}"${crew.id === crewId ? ' selected' : ''}>${escape(crew.name)}</option>`).join('')}</select></label>`}
      <label>Day <input type="date" name="day" value="${escape(day)}" required></label>
      <button>Show jobs</button>
    </form>
    ${jobs.length ? jobs.map(job => `<article><h2>${escape(job.title)}</h2>
      <p>${time(job.start_minute)} · ${escape(job.reference ?? 'No saved site reference')}</p>
      ${job.acknowledged_at ? '<p class="tag">Acknowledged</p>' : `
      <form method="post" action="/cleaner/acknowledge">
        <input type="hidden" name="crewId" value="${crewId}">
        <input type="hidden" name="bookingId" value="${job.id}">
        <input type="hidden" name="version" value="${job.version}">
        <button>Acknowledge job</button></form>`}</article>`).join('') : '<p>No scheduled jobs for this crew.</p>'}
    ${restricted ? '<form method="post" action="/logout"><button>Sign out</button></form>' : ''}`, { restricted });
}

export function recurringPage(quote, crews, preview, fields) {
  const path = '/quotes/' + quote.id + '/recurring';
  const plan = preview?.plan;
  const values = preview?.values ?? fields;
  const cadence = values.cadence ?? 'biweekly';
  const status = plan ? (plan.paused ? 'Paused' : 'Active') : 'Preview only';
  const rows = preview?.visits.map(slot => {
    const booking = slot.visit?.booking_id;
    const result = booking ? `<a href="/bookings/${booking}">${jobLabel(slot.visit.job_state)}</a>`
      : slot.conflict ? 'Conflict · needs review' : 'Available';
    return `<li>${escape(slot.date)} · ${time(slot.start)}–${time(slot.end)} · ${result}</li>`;
  }).join('');
  const hidden = Object.entries(preview?.values ?? {}).filter(([key]) =>
    ['date', 'start', 'duration', 'crewId', 'cadence'].includes(key)).map(([key, value]) =>
    `<input type="hidden" name="${key}" value="${escape(value)}">`).join('');
  return layout('Recurring service', `<p><a href="/quotes/${quote.id}">${escape(quote.title)}</a> · ${status}</p>
    ${plan ? `<p>${escape(plan.cadence)} · ${escape(preview.assigned.name)} · ${plan.duration} minutes</p>` :
      `<form method="get" action="${path}">
        <label>Cadence <select name="cadence">${['weekly', 'biweekly', 'monthly'].map(option =>
          `<option${cadence === option ? ' selected' : ''}>${option}</option>`).join('')}</select></label>
        ${slotFields(null, values, crews)}<button>Preview four visits</button></form>`}
    ${rows ? `<section class="panel"><h2>Planned visits</h2><ul>${rows}</ul></section>` : ''}
    ${preview && !plan?.paused ? `<form method="post" action="${path}">${hidden}
      <button name="action" value="confirm">${plan ? 'Recheck and book available visits' : 'Confirm available visits'}</button>
    </form>` : ''}
    ${plan ? `<form method="post" action="${path}"><button name="action" value="${plan.paused ? 'resume' : 'pause'}">
      ${plan.paused ? 'Resume plan' : 'Pause plan'}</button></form>` : ''}`);
}
