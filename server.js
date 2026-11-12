import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedDemo } from './demo.js';
import { InputError } from './pricing.js';
import { Conflict, NotFound, openRepository } from './repository.js';
import { bookingPage, customerPage, directory, layout, quotePage, schedulePage } from './views.js';

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

export function app(file, { demo = false } = {}) {
  const repository = openRepository(file);
  if (demo) seedDemo(repository);
  const server = createServer(async (request, response) => {
    const html = (status, content) => response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    }).end(content);
    const redirect = location => response.writeHead(303, { Location: location }).end();
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const customer = /^\/customers\/(\d+)(\/quotes)?$/.exec(path);
      const quote = /^\/quotes\/(\d+)(?:\/(revise|decision|book))?$/.exec(path);
      const booking = /^\/bookings\/(\d+)(?:\/(reschedule|cancel))?$/.exec(path);
      if (request.method === 'GET') {
        if (path === '/schedule') {
          const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York' }).format(new Date());
          const day = url.searchParams.get('day') ?? today;
          return html(200, schedulePage(day, repository.schedule(day)));
        }
        if (booking && !booking[2]) {
          const record = repository.booking(Number(booking[1]));
          return html(200, bookingPage(record, repository.quote(record.quote_id)));
        }
        if (path === '/') {
          const query = (url.searchParams.get('q') ?? '').slice(0, 80);
          return html(200, directory(repository.customers(query), query));
        }
        if (customer && !customer[2]) {
          const id = Number(customer[1]);
          return html(200, customerPage(repository.customer(id), repository.customerQuotes(id)));
        }
        if (quote && !quote[2]) {
          const record = repository.quote(Number(quote[1]));
          return html(200, quotePage(record, repository.customer(record.customer_id)));
        }
      }
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && origin !== 'http://' + request.headers.host) {
          return html(403, layout('Forbidden', '<p>Use the local app form.</p>'));
        }
        if (path === '/customers') return redirect('/customers/' + repository.addCustomer(await form(request)));
        if (customer?.[2]) {
          return redirect('/quotes/' + repository.addQuote(Number(customer[1]), await form(request)));
        }
        if (booking?.[2]) {
          const id = Number(booking[1]);
          const fields = await form(request);
          repository.changeBooking(id, Number(fields.version), fields, booking[2] === 'cancel');
          return redirect('/bookings/' + id);
        }
        if (quote?.[2]) {
          const id = Number(quote[1]);
          const fields = await form(request);
          if (quote[2] === 'book') return redirect('/bookings/' + repository.scheduleQuote(id, fields));
          const expected = Number(fields.revision);
          if (quote[2] === 'revise') repository.revise(id, expected, fields);
          else repository.decide(id, expected, fields.outcome);
          return redirect('/quotes/' + id);
        }
      }
      throw new NotFound('Page not found.');
    } catch (error) {
      const status = error instanceof InputError ? 400 : error instanceof NotFound ? 404
        : error instanceof Conflict ? 409 : 500;
      if (status === 500) console.error(error);
      return html(status, layout(status === 500 ? 'Request failed' : error.message,
        '<p><a href="/">Return to the customer directory</a></p>'));
    }
  });
  server.once('close', () => repository.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  const demo = process.argv.includes('--demo');
  if (!demo) mkdirSync('data', { recursive: true });
  const file = demo ? ':memory:' : resolve('data/operations.sqlite');
  app(file, { demo }).listen(port, '127.0.0.1', () => {
    console.log('Open http://127.0.0.1:' + port);
  });
}
