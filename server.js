import { openStaff, sampleAccounts } from './staff.js';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scheduleDate, shiftDay } from './scheduling.js';
import { seedDemo } from './demo.js';
import { dollarsToCents, InputError, rateVersion } from './pricing.js';
import { Conflict, NotFound, openRepository } from './repository.js';
import {
  bookingPage, recurringPage, cleanerPage, crewsPage, customerPage, directory, layout, quotePage, rateFormValues, ratesPage, schedulePage,
  quotesPage, settingsPage, todayPage, SERVICE_LABELS,
} from './views.js';

const stylesheet = readFileSync(new URL('./app.css', import.meta.url));

async function form(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    throw new InputError('Submit this action from the app form.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new InputError('Form is too large.');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

const statusOf = error => error instanceof InputError ? 400 : error instanceof NotFound ? 404
  : error instanceof Conflict ? 409 : 500;

// Reads the publish form into a rate profile, collecting every problem so staff can fix them in one pass.
function rateProfileFromForm(fields) {
  const errors = [];
  const read = parse => {
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      errors.push(error.message);
    }
  };
  const version = read(() => rateVersion(fields.version));
  const bathroomCents = read(() => dollarsToCents(fields.bathroom, 'Price per bathroom'));
  const services = {};
  for (const [key, label] of Object.entries(SERVICE_LABELS)) {
    services[key] = {
      squareFootCents: read(() => dollarsToCents(fields[key + 'Rate'], label + ' price per sq ft')),
      minimumCents: read(() => dollarsToCents(fields[key + 'Minimum'], label + ' minimum')),
    };
  }
  return { errors, profile: { version, bathroomCents, services } };
}

export function app(file, { demo = false, now, staffFile, accounts = [] } = {}) {
  const repository = openRepository(file, { now });
  const clock = now ?? (() => new Date());
  const easternDay = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York' }).format(date);
  if (demo) seedDemo(repository, easternDay(clock()));
  if (demo && staffFile) repository.addCrew({ name: 'Demo crew B' });
  const staff = staffFile ? openStaff(staffFile, accounts) : null;
  const server = createServer(async (request, response) => {
    const html = (status, content) => response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    }).end(content);
    const redirect = location => response.writeHead(303, { Location: location }).end();
    const rates = (status, options = {}) => {
      const active = repository.activeRateProfile();
      return html(status, ratesPage({
        active, profiles: repository.rateProfiles(), values: rateFormValues(active), ...options,
      }));
    };
    const showBooking = (id, status = 200, recovery) => {
      const record = repository.booking(id);
      const quote = repository.quote(record.quote_id);
      return html(status, bookingPage(record, quote, repository.customer(quote.customer_id),
        repository.history(id), repository.bookingSite(id), recovery, repository.crews(), repository.acknowledgment(record)));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const account = staff?.account(request);
      const loginPage = (status, error = '') => html(status, layout('Staff sign-in',
        (error ? '<p role="alert">Sign-in failed.</p>' : '') +
        '<form method="post" action="/login"><label>Username <input name="name" autocomplete="username" required></label>' +
        '<label>Password <input type="password" name="password" autocomplete="current-password" required></label>' +
        '<button>Sign in</button></form>', { restricted: true }));
      if (staff && path !== '/assets/app.css') {
        if (request.method === 'POST' && request.headers.origin !== 'http://' + request.headers.host) {
          return html(403, layout('Forbidden', '<p>Use the local app form.</p>', { restricted: true }));
        }
        if (path === '/login') {
          if (request.method === 'GET') return loginPage(200);
          if (request.method !== 'POST') return loginPage(405);
          const fields = await form(request);
          const result = staff.login(fields.name, fields.password);
          if (!result) return loginPage(401, 'invalid');
          response.setHeader('Set-Cookie', result.cookie);
          return redirect(result.role === 'cleaner' ? '/cleaner' : '/today');
        }
        if (!account) return request.method === 'GET' ? redirect('/login') : loginPage(401);
        if (path === '/logout' && request.method === 'POST') {
          response.setHeader('Set-Cookie', staff.logout(request));
          return redirect('/login');
        }
        if (account.role === 'cleaner' && !(
          (request.method === 'GET' && path === '/cleaner') ||
          (request.method === 'POST' && path === '/cleaner/acknowledge'))) {
          return html(403, layout('Forbidden', '<p>This page requires dispatcher access.</p>', { restricted: true }));
        }
      }
      const customer = /^\/customers\/(\d+)(?:\/(quotes|edit))?$/.exec(path);
      const quote = /^\/quotes\/(\d+)(?:\/(revise|decision|book))?$/.exec(path);
      const recurring = /^\/quotes\/(\d+)\/recurring$/.exec(path);
      const booking = /^\/bookings\/(\d+)(?:\/(reschedule|cancel|start|complete|interrupt))?$/.exec(path);
      if (request.method === 'GET') {
        if (path === '/assets/app.css') {
          return response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(stylesheet);
        }
        const time = clock();
        const today = easternDay(time);
        if (path === '/cleaner') {
          const crews = account?.role === 'cleaner' ? [] : repository.crews();
          const crewId = account?.crew_id ?? Number(url.searchParams.get('crew') ?? crews[0].id);
          const day = scheduleDate(url.searchParams.get('day') ?? today);
          return html(200, cleanerPage(crews, crewId, day, repository.cleanerJobs(crewId, day), account?.role === 'cleaner'));
        }
        if (path === '/today') {
          return html(200, todayPage(today, repository.schedule(today), repository.overdueJobs(today),
            repository.listQuotes({ draftsOnly: true }), time));
        }
        if (recurring) {
          const id = Number(recurring[1]);
          const record = repository.quote(id);
          if (record.status !== 'accepted') throw new Conflict('Accept the quote before creating a plan.');
          const fields = Object.fromEntries(url.searchParams);
          const preview = fields.date || repository.planForQuote(id) ? repository.previewPlan(id, fields) : null;
          return html(200, recurringPage(record, repository.crews(), preview, fields));
        }
        if (path === '/quotes') return html(200, quotesPage(repository.listQuotes(), time));
        if (path === '/crews') return html(200, crewsPage(repository.crews()));
        if (path === '/settings') return html(200, settingsPage());
        if (path === '/schedule') {
          const day = scheduleDate(url.searchParams.get('day') ?? today);
          const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
          const week = Array.from({ length: 7 }, (_, offset) => shiftDay(day, offset - (weekday + 6) % 7))
            .filter(date => /^20/.test(date)).map(date => ({ date, jobs: repository.schedule(date) }));
          return html(200, schedulePage(day, repository.schedule(day), week, repository.crews()));
        }
        if (booking && !booking[2]) {
          return showBooking(Number(booking[1]));
        }
        if (path === '/rates') {
          // A success notice is shown only if it still describes the current state.
          const version = url.searchParams.get('version');
          const active = repository.activeRateProfile().version;
          const published = repository.rateProfiles().some(profile => profile.version === version);
          const notices = {
            published: published && `Published ${version}.`,
            activated: version === active && `Activated ${version}. New quotes and revisions now use it.`,
          };
          return rates(200, { notice: notices[url.searchParams.get('done')] || '' });
        }
        if (path === '/' && !url.searchParams.has('q')) return redirect('/today');
        if (path === '/customers' || path === '/') {
          const query = (url.searchParams.get('q') ?? '').slice(0, 80);
          return html(200, directory(repository.customers(query), query));
        }
        if (customer && !customer[2]) {
          const id = Number(customer[1]);
          return html(200, customerPage(repository.customer(id), repository.customerQuotes(id), repository.customerBookings(id), repository.locations(id)));
        }
        if (quote && !quote[2]) {
          const record = repository.quote(Number(quote[1]));
          return html(200, quotePage(record, repository.customer(record.customer_id), null, repository.crews()));
        }
      }
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && origin !== 'http://' + request.headers.host) {
          return html(403, layout('Forbidden', '<p>Use the local app form.</p>'));
        }
        if (path === '/rates') {
          const fields = await form(request);
          const { errors, profile } = rateProfileFromForm(fields);
          if (errors.length) return rates(400, { errors, values: fields });
          const activate = fields.activate === 'yes';
          try {
            repository.publishRateProfile(profile, activate ? { activate, expectedActive: fields.expected } : {});
          } catch (error) {
            if (statusOf(error) === 500) throw error;
            const active = repository.activeRateProfile().version;
            let messages = [error.message];
            if (activate && error instanceof Conflict && fields.expected !== active) {
              messages = [`The active version changed to ${active} after this page was loaded, so `
                + `${profile.version} was not published. Review the current rates below, then submit again.`];
            } else if (error instanceof Conflict) {
              messages.push('Choose a new version name. Published versions cannot be changed.');
            }
            return rates(statusOf(error), { errors: messages, values: fields });
          }
          return redirect('/rates?' + new URLSearchParams({ done: activate ? 'activated' : 'published',
            version: profile.version }));
        }
        if (path === '/rates/activate') {
          const fields = await form(request);
          try {
            repository.activateRateProfile(fields.version, fields.expected);
          } catch (error) {
            if (statusOf(error) === 500) throw error;
            const messages = error instanceof Conflict
              ? [`The active version changed to ${repository.activeRateProfile().version} after this page `
                + `was loaded, so ${fields.version} was not activated. Review the current rates below, then choose again.`]
              : [error.message];
            return rates(statusOf(error), { errors: messages });
          }
          return redirect('/rates?' + new URLSearchParams({ done: 'activated', version: fields.version }));
        }
        if (recurring) {
          const id = Number(recurring[1]);
          const fields = await form(request);
          if (fields.action === 'pause' || fields.action === 'resume') {
            repository.pausePlan(id, fields.action === 'pause');
          } else if (fields.action === 'confirm') {
            repository.confirmPlan(id, fields);
          } else {
            throw new InputError('Choose a plan action.');
          }
          return redirect('/quotes/' + id + '/recurring');
        }
        if (path === '/cleaner/acknowledge') {
          const fields = await form(request);
          const crewId = account?.crew_id ?? Number(fields.crewId);
          repository.acknowledgeJob(crewId, Number(fields.bookingId), Number(fields.version));
          return redirect('/cleaner?' + new URLSearchParams({ crew: crewId, day: repository.booking(Number(fields.bookingId)).day }));
        }
        if (path === '/crews') {
          try {
            repository.addCrew(await form(request));
          } catch (error) {
            if (!(error instanceof InputError || error instanceof Conflict)) throw error;
            return html(statusOf(error), crewsPage(repository.crews(), error.message));
          }
          return redirect('/crews');
        }
        if (path === '/customers') return redirect('/customers/' + repository.addCustomer(await form(request)));
        const location = /^\/customers\/(\d+)\/locations(?:\/(\d+))?$/.exec(path);
        if (location) {
          const id = Number(location[1]);
          const fields = await form(request);
          if (location[2]) repository.editLocation(id, Number(location[2]), fields);
          else repository.addLocation(id, fields);
          return redirect('/customers/' + id);
        }
        if (customer?.[2] === 'edit') {
          const id = Number(customer[1]);
          repository.updateCustomer(id, await form(request));
          return redirect('/customers/' + id);
        }
        if (customer?.[2] === 'quotes') {
          return redirect('/quotes/' + repository.addQuote(Number(customer[1]), await form(request)));
        }
        if (booking?.[2]) {
          const id = Number(booking[1]);
          const fields = await form(request);
          const action = booking[2];
          const version = Number(fields.version);
          try {
            if (action === 'start' || action === 'complete') {
              repository.advanceJob(id, version, action, fields.detail ?? '');
            } else if (action === 'interrupt') {
              repository.interruptJob(id, version, fields.detail ?? '');
            } else {
              repository.changeBooking(id, version, fields, action === 'cancel', account?.name);
            }
          } catch (error) {
            if (!(error instanceof InputError || error instanceof Conflict)) throw error;
            const current = repository.booking(id);
            const stale = current.version !== version;
            return showBooking(id, statusOf(error), {
              message: stale ? 'The job changed. Review the current booking above before submitting again.' : error.message,
              fields: action === 'reschedule' ? fields : undefined,
              detail: action === 'interrupt' ? fields.detail : undefined,
            });
          }
          return redirect('/bookings/' + id);
        }
        if (quote?.[2]) {
          const id = Number(quote[1]);
          const fields = await form(request);
          if (quote[2] === 'book') {
            try {
              return redirect('/bookings/' + repository.scheduleQuote(id, fields));
            } catch (error) {
              if (!(error instanceof InputError || error instanceof Conflict)) throw error;
              const record = repository.quote(id);
              return html(statusOf(error), quotePage(record, repository.customer(record.customer_id),
                { message: error.message, fields }, repository.crews()));
            }
          }
          const expected = Number(fields.revision);
          if (quote[2] === 'revise') repository.revise(id, expected, fields);
          else repository.decide(id, expected, fields.outcome);
          return redirect('/quotes/' + id);
        }
      }
      throw new NotFound('Page not found.');
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) console.error(error);
      return html(status, layout(status === 500 ? 'Request failed' : error.message,
        '<p><a href="/customers">Return to the customer directory</a></p>'));
    }
  });
  server.once('close', () => { staff?.close(); repository.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  const demo = process.argv.includes('--demo');
  process.umask(0o077);
  const temp = demo ? mkdtempSync(join(tmpdir(), 'ayc-demo-')) : null;
  if (temp) process.once('exit', () => rmSync(temp, { recursive: true, force: true }));
  const file = temp ? join(temp, 'demo.sqlite') : resolve(process.env.AYC_DATABASE ?? 'data/operations.sqlite');
  if (!demo) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const password = process.env.AYC_DISPATCHER_PASSWORD;
  if (!demo && (!password || password.length < 12 || password.length > 256)) {
    throw new Error('Set AYC_DISPATCHER_PASSWORD to a private password of at least 12 characters.');
  }
  const accounts = demo ? sampleAccounts : [{ name: 'dispatcher', password, role: 'dispatcher' }];
  app(file, { demo, staffFile: file, accounts }).listen(port, '127.0.0.1', () => {
    console.log('Open http://127.0.0.1:' + port);
  });
}
