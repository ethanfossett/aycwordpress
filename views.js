const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const money = cents => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
}).format(cents / 100);

export function layout(title, content) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · AYC Operations</title>
  <style>
  body{font:16px system-ui;background:#f4f8f7;color:#16302c;margin:0}
  header{background:#143c35;padding:1rem}header a{color:white;font-weight:700}
  main{max-width:56rem;margin:auto;padding:1.5rem}a{color:#185e52}
  form,article{border:1px solid #c9dad4;background:white;border-radius:.6rem;padding:1rem;margin:1rem 0}
  label{display:block;margin:.65rem 0}input,select,button{font:inherit;padding:.45rem;margin:.15rem}
  button{background:#185e52;color:white;border:0;border-radius:.3rem}
  li{margin:.5rem 0}
  </style><header><a href="/">AYC Operations</a> · <a href="/schedule">Schedule</a></header>
  <main><h1>${escape(title)}</h1>${content}</main></html>`;
}

export function directory(customers, query) {
  const rows = customers.map(customer => `<li><a href="/customers/${customer.id}">
    ${escape(customer.name)}</a> · ${escape(customer.reference)} · ${customer.quote_count} quotes</li>`).join('');
  return layout('Customers', `
    <form method="get"><label>Search <input name="q" value="${escape(query)}"></label><button>Search</button></form>
    ${rows ? `<ul>${rows}</ul>` : '<p>No matching customers.</p>'}
    <h2>Add customer</h2>
    <form method="post" action="/customers">
      <label>Name <input name="name" required maxlength="80"></label>
      <label>Site reference <input name="reference" required maxlength="80" placeholder="Sample property"></label>
      <button>Add customer</button>
    </form>`);
}

function scopeFields(scope = {}) {
  const services = { standard: 'Standard', deep: 'Deep clean', moveout: 'Move-out' };
  const options = Object.entries(services).map(([key, label]) =>
    `<option value="${key}"${scope.service === key ? ' selected' : ''}>${label}</option>`).join('');
  return `<label>Service <select name="service">${options}</select></label>
  <label>Square feet <input type="number" name="squareFeet" required min="100" max="20000"
    value="${escape(scope.squareFeet ?? 1000)}"></label>
  <label>Bathrooms <input type="number" name="bathrooms" required min="0" max="20"
    value="${escape(scope.bathrooms ?? 1)}"></label>`;
}

export function customerPage(customer, quotes) {
  const rows = quotes.map(quote => `<li><a href="/quotes/${quote.id}">${escape(quote.title)}</a>
    · ${escape(quote.status)} · Revision ${quote.current_revision}</li>`).join('');
  return layout(customer.name, `<p>Site reference: ${escape(customer.reference)}</p>
    <h2>Quote history</h2>${rows ? `<ul>${rows}</ul>` : '<p>No quotes yet.</p>'}
    <h2>New quote</h2><form method="post" action="/customers/${customer.id}/quotes">
    <label>Job title <input name="title" required maxlength="80"></label>
    ${scopeFields()}<button>Save draft quote</button></form>`);
}

export function quotePage(quote, customer) {
  const hiddenRevision = `<input type="hidden" name="revision" value="${quote.current_revision}">`;
  const history = quote.revisions.map(({ number, estimate, created_at: date }) => `
    <article><h3>Revision ${number} · ${money(estimate.totalCents)}</h3>
      <p>${escape(estimate.scope.service)} · ${estimate.scope.squareFeet} sq ft ·
        ${estimate.scope.bathrooms} bathrooms · ${escape(estimate.rateVersion)}</p>
      <ul>${estimate.lines.map(line => `<li>${escape(line.label)} · ${money(line.cents)}</li>`).join('')}</ul>
      <small>${escape(date)}</small>
    </article>`).join('');
  const actions = quote.status === 'draft' ? `
    <h2>Revise quote</h2><form method="post" action="/quotes/${quote.id}/revise">
    ${hiddenRevision}${scopeFields(quote.revisions[0].estimate.scope)}<button>Save revision</button></form>
    <h2>Record customer decision</h2><form method="post" action="/quotes/${quote.id}/decision">
    ${hiddenRevision}<button name="outcome" value="accepted">Accept quote</button>
    <button name="outcome" value="declined">Decline quote</button></form>` : `
    <p>Revision ${quote.decision.revision} ${escape(quote.decision.outcome)}
    on ${escape(quote.decision.created_at)}.</p>`;
  return layout(quote.title, `<p><a href="/customers/${customer.id}">${escape(customer.name)}</a>
    · ${escape(quote.status)}</p><h2>Estimate history</h2>${history}${actions}${bookingSection(quote)}`);
}

function time(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

function slotFields(booking) {
  const duration = booking ? booking.end_minute - booking.start_minute : 120;
  return `<label>Date <input type="date" name="date" value="${escape(booking?.day ?? '')}" required></label>
    <label>Start (Eastern time) <input type="time" name="start" step="1800" min="08:00"
    value="${time(booking?.start_minute ?? 540)}" required></label>
    <label>Duration <select name="duration">${[60, 90, 120, 180, 240].map(minutes =>
      `<option value="${minutes}"${duration === minutes ? ' selected' : ''}>${minutes} minutes</option>`).join('')}</select></label>`;
}

function bookingSection(quote) {
  if (quote.status !== 'accepted') return '';
  const rows = quote.bookings.map(booking => `<li><a href="/bookings/${booking.id}">
    ${escape(booking.day)} at ${time(booking.start_minute)}</a> · ${escape(booking.status)}</li>`).join('');
  const active = quote.bookings.some(booking => booking.status === 'scheduled');
  return `<h2>Bookings</h2>${rows ? `<ul>${rows}</ul>` : '<p>No bookings yet.</p>'}
    ${active ? '' : `<form method="post" action="/quotes/${quote.id}/book">
    ${slotFields()}<button>Schedule cleaning</button></form>`}`;
}

export function schedulePage(day, bookings) {
  const rows = bookings.map(booking => `<li>${time(booking.start_minute)}–${time(booking.end_minute)}
    · <a href="/bookings/${booking.id}">${escape(booking.title)}</a>
    · ${escape(booking.name)} · ${escape(booking.status)}</li>`).join('');
  return layout('Cleaning schedule', `<form method="get" action="/schedule">
    <label>Day <input type="date" name="day" value="${escape(day)}" required></label>
    <button>Show day</button></form><h2>${escape(day)} · Eastern time</h2>
    ${rows ? `<ul>${rows}</ul>` : '<p>No jobs on this day.</p>'}`);
}

export function bookingPage(booking, quote) {
  const version = `<input type="hidden" name="version" value="${booking.version}">`;
  const actions = booking.status === 'scheduled' ? `
    <form method="post" action="/bookings/${booking.id}/reschedule">
      ${version}${slotFields(booking)}<button>Reschedule</button></form>
    <form method="post" action="/bookings/${booking.id}/cancel">
      ${version}<button>Cancel booking</button></form>` : '';
  return layout(quote.title, `<p><a href="/quotes/${quote.id}">Accepted quote revision ${quote.decision.revision}</a></p>
    <p><a href="/schedule?day=${escape(booking.day)}">${escape(booking.day)}</a> ·
    ${time(booking.start_minute)}–${time(booking.end_minute)} Eastern · ${escape(booking.status)}</p>${actions}`);
}
