// Offline test: mocks Google, exercises the Worker. Run: node test/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8')
  .replace("import PAGE from './page.html';", 'const PAGE = ' + JSON.stringify(page) + ';')
  .replace(/import (\w+) from '\.\/fonts\/[\w.-]+\.woff2';/g, 'const $1 = new Uint8Array([1, 2, 3]);')
  .replace(/from '\.\/facts\//g, "from '" + pathToFileURL(path.join(root, 'src/facts')).href + '/');
const tmp = path.join(root, 'test/.worker.tmp.mjs');
fs.writeFileSync(tmp, src);
// Pin the clock (Thu 12 Nov 2026, 3pm New York) so date-based tests don't drift with the real date.
Date.now = () => Date.parse('2026-11-12T20:00:00Z');
// The Worker logs each refused write; several tests trigger refusals on purpose. Keep the run quiet
// for those, and still print anything unexpected.
const EXPECTED_LOGS = [/not a secondary calendar; refusing to write/, /bad event id/];
const realError = console.error;
console.error = (...a) => { if (!EXPECTED_LOGS.some((r) => r.test(String(a[0]?.message ?? a[0])))) realError(...a); };
const worker = (await import(pathToFileURL(tmp))).default;

const FAMILY = 'c_abc@group.calendar.google.com';
const WORK = 'alex@work.example.com';
const env = {
  DEV_NO_AUTH: '1', HUB_EMAIL: 'hub@example.com', FAMILY_CALENDAR_ID: FAMILY, TIMEZONE: 'America/New_York',
  BUSY_CALENDARS: JSON.stringify({ [WORK]: 'Alex' }),
  CALENDAR_PEOPLE: JSON.stringify({ 'sam@example.com': 'Sam' }),
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt', KIOSK_KEY: 'k'.repeat(32),
  KV: (() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; })(),
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const method = init.method || 'GET';
  calls.push({ url, method, body: init.body });
  const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
  if (url.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'at', expires_in: 3600 });
  if (url.includes('/users/me/calendarList')) return ok({ items: [
    { id: 'hub@example.com', primary: true, accessRole: 'owner', backgroundColor: '#111' },
    { id: FAMILY, accessRole: 'owner' },
    { id: WORK, accessRole: 'reader' },
    { id: 'sam@example.com', accessRole: 'reader' },
  ] });
  if (url.endsWith('/freeBusy')) return ok({ calendars: { [WORK]: { busy: [{ start: '2026-11-12T15:00:00Z', end: '2026-11-12T16:00:00Z' }] } } });
  if (method === 'GET' && url.includes(encodeURIComponent(FAMILY) + '/events')) return ok({ items: [
    { id: 'ev1dentist', summary: 'Sam: dentist', start: { dateTime: '2026-11-10T09:30:00-05:00' }, end: { dateTime: '2026-11-10T10:30:00-05:00' } },
    { summary: 'Pizza night', start: { date: '2026-11-13' }, end: { date: '2026-11-14' } },
    { id: 'ev3swim', summary: 'Ruby & Max: swim', start: { date: '2026-11-13' }, end: { date: '2026-11-14' } },
    { id: 'ev2tacos', summary: 'Dinner: tacos', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
    { summary: 'Max: soccer', start: { dateTime: '2026-11-11T16:00:00-05:00' }, end: { dateTime: '2026-11-11T17:00:00-05:00' } },
    { summary: 'Late party', start: { dateTime: '2026-11-14T22:00:00-05:00' }, end: { dateTime: '2026-11-15T01:00:00-05:00' } },
  ] });
  if (method === 'GET' && url.includes(encodeURIComponent('hub@example.com') + '/events')) return ok({ items: [
    { summary: 'Office', eventType: 'workingLocation', workingLocationProperties: { type: 'officeLocation' }, start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
    { summary: 'Home', eventType: 'workingLocation', workingLocationProperties: { type: 'homeOffice' }, start: { date: '2026-11-13' }, end: { date: '2026-11-14' } },
  ] });
  if (method === 'GET' && url.includes(encodeURIComponent('sam@example.com') + '/events')) return ok({ items: [
    { summary: 'Max taekwondo', start: { dateTime: '2026-11-12T18:15:00-05:00' }, end: { dateTime: '2026-11-12T19:15:00-05:00' } },
    { summary: 'Max and Ruby TKD', start: { dateTime: '2026-11-14T11:00:00-05:00' }, end: { dateTime: '2026-11-14T12:00:00-05:00' } },
    { summary: 'Maxto lunch', start: { dateTime: '2026-11-12T12:00:00-05:00' }, end: { dateTime: '2026-11-12T13:00:00-05:00' } },
  ] });
  if (method === 'GET' && url.includes('/events')) return ok({ items: [] });
  if (method === 'POST' && url.includes('/events')) return ok({ id: 'new', summary: JSON.parse(init.body).summary });
  if (method === 'PATCH' && url.includes('/events/')) return ok({ id: url.split('/').pop(), summary: JSON.parse(init.body).summary });
  if (method === 'DELETE' && url.includes('/events/')) return new Response(null, { status: 204 });
  if (url.startsWith('https://api.open-meteo.com/')) return ok({
    current: { temperature_2m: 51.4, weather_code: 3 },
    daily: { time: ['2026-11-11', '2026-11-12'], weather_code: [0, 61], temperature_2m_max: [55.2, 48.6], temperature_2m_min: [40.1, 39.5] },
  });
  return new Response('{}', { status: 404 });
};

const get = (p, h) => worker.fetch(new Request('http://localhost:8787' + p, { headers: h }), env);
const post = (p, b) => worker.fetch(new Request('http://localhost:8787' + p, { method: 'POST', body: JSON.stringify(b) }), env);

// week
// rolling window: starts on the day asked for (default today), not the previous Sunday
let r = await get('/api/week?start=2026-11-11');
let w = await r.json();
assert.equal(w.start, '2026-11-11');
assert.deepEqual([w.days[0].date, w.days[6].date], ['2026-11-11', '2026-11-17']);
w = await (await get('/api/week?start=2026-11-08')).json();
assert.equal(w.days.length, 7);
const day = (d) => w.days.find((x) => x.date === d).events;
assert.deepEqual(day('2026-11-10')[0], { title: 'dentist', person: 'Sam', busy: false, time: '9:30a', allDay: false, color: '#CF4F7C', startMin: 570, endMin: 630,
  id: 'ev1dentist', edit: { date: '2026-11-10', time: '09:30', duration: 60 } });
const pizza = day('2026-11-13').find((e) => e.title === 'Pizza night');
assert.deepEqual([pizza.allDay, pizza.person], [true, 'Family']);
const busy = day('2026-11-12').find((e) => e.busy);
assert.deepEqual([busy.title, busy.person, busy.busy, busy.time], ['busy', 'Alex', true, '10a']);
assert.deepEqual([busy.from, busy.to], ['10:00', '11:00']);
assert.equal(day('2026-11-14').find((e) => e.title === 'Late party').time, '10p');
// working location: flagged so the page shows an icon, not a chip
const office = day('2026-11-12').find((e) => e.where);
assert.deepEqual([office.where, office.person, office.title], ['office', 'Alex', 'Office']);
assert.equal(day('2026-11-13').find((e) => e.where).where, 'home');

// a kid's name first on a parent's calendar makes it the kid's (whole word only)
const tkd = day('2026-11-12').find((e) => e.title === 'taekwondo');
assert.deepEqual([tkd.person, tkd.color], ['Max', '#D9762B']);
assert.deepEqual([tkd.startMin, tkd.endMin], [18 * 60 + 15, 19 * 60 + 15]);  // 6:15-7:15p
assert.equal(day('2026-11-12').find((e) => e.title === 'Maxto lunch').person, 'Sam');

// several people in one event: tagged to each, title without the names
const tkd2 = day('2026-11-14').find((e) => e.title === 'TKD');
assert.deepEqual([tkd2.people, tkd2.person, tkd2.color], [['Max', 'Ruby'], 'Max', '#D9762B']);
const swim = day('2026-11-13').find((e) => e.title === 'swim');
assert.deepEqual([swim.people, swim.id], [['Ruby', 'Max'], 'ev3swim']);

// meals and the kids
const meal = day('2026-11-12').find((e) => e.meal);
assert.deepEqual([meal.title, meal.allDay, meal.person], ['tacos', true, 'Family']);
const gus = day('2026-11-11').find((e) => e.title === 'soccer');
assert.deepEqual([gus.person, gus.color], ['Max', '#D9762B']);
// no weather configured: none fetched, none returned
assert.equal(w.now, null);
assert.ok(!calls.some((c) => c.url.includes('open-meteo')));
// work calendar: only freeBusy, never events.list
assert.ok(!calls.some((c) => c.url.includes(encodeURIComponent(WORK) + '/events')));
// spill into next week
w = await (await get('/api/week?start=2026-11-15')).json();
assert.equal(w.days[0].events[0].time, 'until 1a');

// DST week (Mar 8 2026 spring forward): still 7 days
w = await (await get('/api/week?start=2026-03-07')).json();
assert.deepEqual(w.days.map((d) => d.date), ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13']);

// add: timed
calls.length = 0;
r = await post('/api/events', { date: '2026-11-14', person: 'Sam', time: '23:30', duration: 60, title: '  eye   exam ' });
assert.equal(r.status, 200);
let writes = calls.filter((c) => c.method !== 'GET' && !c.url.includes('oauth2') && !c.url.endsWith('/freeBusy'));
assert.equal(writes.length, 1);
assert.equal(writes[0].url, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(FAMILY)}/events`);
let ev = JSON.parse(writes[0].body);
assert.equal(ev.summary, 'Sam: eye exam');
assert.deepEqual(ev.start, { dateTime: '2026-11-14T23:30:00', timeZone: 'America/New_York' });
assert.deepEqual(ev.end, { dateTime: '2026-11-15T00:30:00', timeZone: 'America/New_York' });
// add: all-day, shared person has no prefix; a client-supplied calendar id is ignored
calls.length = 0;
r = await post('/api/events', { date: '2026-11-30', person: 'Family', time: null, title: 'Trip', calendarId: 'hub@example.com' });
writes = calls.filter((c) => c.method === 'POST' && c.url.includes('/events'));
assert.ok(writes[0].url.includes(encodeURIComponent(FAMILY)));
ev = JSON.parse(writes[0].body);
assert.deepEqual([ev.summary, ev.start.date, ev.end.date], ['Trip', '2026-11-30', '2026-12-01']);
// validation
assert.equal((await post('/api/events', { date: '2026-11-30', person: 'Bob', title: 'x' })).status, 400);
assert.equal((await post('/api/events', { date: '2026-11-30', person: 'Alex', title: ' ' })).status, 400);
assert.equal((await post('/api/events', { date: '2026-11-30', person: 'Alex', title: 'x', time: '25:00' })).status, 400);
// refuses to write if the Family id is misconfigured as a primary calendar
const bad = { ...env, FAMILY_CALENDAR_ID: 'hub@example.com' };
r = await worker.fetch(new Request('http://localhost:8787/api/events', { method: 'POST', body: JSON.stringify({ date: '2026-11-30', person: 'Alex', title: 'x' }) }), bad);
assert.equal(r.status, 502);

// weather configured: per-day forecast (today and later only) + current
const wxEnv = { ...env, WEATHER_LAT: '40.7', WEATHER_LON: '-74.0' };
const ww = await (await worker.fetch(new Request('http://localhost:8787/api/week?start=2026-11-08'), wxEnv)).json();
assert.deepEqual(ww.now, { temp: 51, icon: '\u2601\uFE0F' });
assert.equal(ww.days.find((d) => d.date === '2026-11-12').weather.hi, 49);
assert.equal(ww.days.find((d) => d.date === '2026-11-10').weather, undefined);
// add a dinner: all day on Family, "Dinner: ..." even if a time is sent
calls.length = 0;
r = await post('/api/events', { date: '2026-11-20', person: 'Dinner', time: '18:00', duration: 60, title: 'lasagne' });
assert.equal(r.status, 200);
let din = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.includes('/events')).body);
assert.equal(din.summary, 'Dinner: lasagne');
assert.deepEqual(din.start, { date: '2026-11-20' });
assert.ok(calls.find((c) => c.method === 'POST' && c.url.includes('/events')).url.includes(encodeURIComponent(FAMILY)));
// add for a kid
calls.length = 0;
await post('/api/events', { date: '2026-11-20', person: 'Ruby', time: null, title: 'sleepover' });
din = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.includes('/events')).body);
assert.deepEqual([din.summary, din.colorId], ['Ruby: sleepover', '3']);

// add for several people
calls.length = 0;
r = await post('/api/events', { date: '2026-11-20', people: ['Max', 'Ruby'], person: 'Max', time: '16:00', duration: 60, title: 'TKD' });
assert.equal(r.status, 200);
din = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.includes('/events')).body);
assert.deepEqual([din.summary, din.colorId], ['Max & Ruby: TKD', '6']);
assert.equal((await post('/api/events', { date: '2026-11-20', people: ['Max', 'Family'], title: 'x' })).status, 400);

// edit + delete: only Family-calendar events carry an id, and every write targets the Family calendar
w = await (await get('/api/week?start=2026-11-08')).json();
assert.equal(day('2026-11-12').find((e) => e.meal).id, 'ev2tacos');
assert.equal(day('2026-11-12').find((e) => e.title === 'taekwondo').id, undefined);   // Sam's own calendar: read-only
const send = (method, b, prefix = '') => worker.fetch(new Request('http://localhost:8787' + prefix + '/api/events', { method, body: JSON.stringify(b) }), env);
calls.length = 0;
r = await send('PATCH', { id: 'ev1dentist', date: '2026-11-10', person: 'Sam', time: '10:00', duration: 45, title: 'dentist (moved)' });
assert.equal(r.status, 200);
let pc = calls.find((c) => c.method === 'PATCH');
assert.ok(pc.url.endsWith('/calendars/' + encodeURIComponent(FAMILY) + '/events/ev1dentist'));
let pb = JSON.parse(pc.body);
assert.equal(pb.summary, 'Sam: dentist (moved)');
assert.deepEqual(pb.start, { dateTime: '2026-11-10T10:00:00', timeZone: 'America/New_York', date: null });
assert.equal(pb.end.dateTime, '2026-11-10T10:45:00');
// timed -> all day clears the time fields
calls.length = 0;
await send('PATCH', { id: 'ev1dentist', date: '2026-11-10', person: 'Family', time: null, title: 'day off' });
pb = JSON.parse(calls.find((c) => c.method === 'PATCH').body);
assert.deepEqual([pb.summary, pb.start.date, pb.start.dateTime], ['day off', '2026-11-10', null]);
// delete
calls.length = 0;
r = await send('DELETE', { id: 'ev2tacos' });
assert.equal(r.status, 200);
assert.ok(calls.find((c) => c.method === 'DELETE').url.endsWith(encodeURIComponent(FAMILY) + '/events/ev2tacos'));
// a crafted id can't escape the Family calendar's path
calls.length = 0;
r = await send('DELETE', { id: '../../primary/events/x' });
assert.notEqual(r.status, 200);
r = await send('PATCH', { id: 'a/b', date: '2026-11-10', person: 'Alex', time: null, title: 'x' });
assert.notEqual(r.status, 200);
assert.equal(calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE').length, 0);
// no id -> rejected, not turned into an add
assert.equal((await send('DELETE', {})).status, 400);

// chores: parents add, anyone ticks, ticks give stars, untick takes it back
const cpost = (b, e = env, prefix = '') => worker.fetch(new Request('http://localhost:8787' + prefix + '/api/chores', { method: 'POST', body: JSON.stringify(b) }), e);
const callsBeforeChores = calls.length;
let ch = await (await get('/api/chores')).json();
assert.deepEqual(ch.kids.map((k) => k.name), ['Max', 'Ruby']);
assert.equal(ch.canEdit, true);
ch = await (await cpost({ action: 'add', kid: 'Max', title: '  make   bed ' })).json();
const bed = ch.kids[0].chores[0];
assert.deepEqual([bed.title, bed.done], ['make bed', false]);
assert.equal((await cpost({ action: 'add', kid: 'Alex', title: 'x' })).status, 400);
ch = await (await cpost({ action: 'toggle', id: bed.id })).json();
assert.deepEqual([ch.kids[0].chores[0].done, ch.kids[0].stars], [true, 1]);
ch = await (await cpost({ action: 'toggle', id: bed.id })).json();
assert.deepEqual([ch.kids[0].chores[0].done, ch.kids[0].stars], [false, 0]);
await cpost({ action: 'toggle', id: bed.id });
ch = await (await cpost({ action: 'stars', kid: 'Max', delta: -5 })).json();
assert.equal(ch.kids[0].stars, 0);  // never below zero
// recurring days (the clock is pinned to Thursday = 4)
ch = await (await cpost({ action: 'add', kid: 'Max', title: 'trash out', days: [4] })).json();
const trash = ch.kids[0].chores.find((x) => x.title === 'trash out');
assert.deepEqual(trash.days, [4]);                                  // due today
ch = await (await cpost({ action: 'add', kid: 'Max', title: 'piano', days: [1, 3, 5, 3] })).json();
assert.equal(ch.kids[0].chores.find((x) => x.title === 'piano'), undefined);   // not due today
const piano = ch.kids[0].later.find((x) => x.title === 'piano');
assert.deepEqual(piano.days, [1, 3, 5]);                           // deduped + sorted
assert.equal((await cpost({ action: 'toggle', id: piano.id })).status, 400);   // can't tick a chore that isn't due
ch = await (await cpost({ action: 'days', id: piano.id, days: [0, 1, 2, 3, 4, 5, 6] })).json();
assert.deepEqual(ch.kids[0].chores.find((x) => x.title === 'piano').days, []);  // all seven = every day
assert.equal((await cpost({ action: 'add', kid: 'Max', title: 'x', days: 'mon' })).status, 400);
// chores never talk to Google
assert.equal(calls.length, callsBeforeChores);

// access control
const locked = { ...env, DEV_NO_AUTH: undefined };
const lget = (p, h) => worker.fetch(new Request('https://wall.example.com' + p, { headers: h }), locked);
assert.equal((await lget('/')).status, 403);
assert.equal((await lget('/api/week', { 'Cf-Access-Jwt-Assertion': 'a.b.c' })).status, 403);
assert.equal((await lget('/kiosk/')).status, 403);
assert.equal((await lget('/kiosk/?k=wrong')).status, 403);
r = await lget('/kiosk/?k=' + 'k'.repeat(32));
assert.equal(r.status, 200);
const cookie = r.headers.get('set-cookie').split(';')[0];
assert.equal((await lget('/kiosk/api/week', { cookie })).status, 200);
assert.equal((await lget('/kiosk/oauth/start', { cookie })).status, 404);
assert.equal((await lget('/api/week', { cookie })).status, 403);
// chores on the wall: may tick, may not edit
const kpost = (b) => worker.fetch(new Request('https://wall.example.com/kiosk/api/chores', { method: 'POST', headers: { cookie }, body: JSON.stringify(b) }), locked);
let kc = await (await worker.fetch(new Request('https://wall.example.com/kiosk/api/chores', { headers: { cookie } }), locked)).json();
assert.equal(kc.canEdit, false);
assert.equal((await kpost({ action: 'toggle', id: kc.kids[0].chores[0].id })).status, 200);
assert.equal((await kpost({ action: 'add', kid: 'Max', title: 'x' })).status, 403);
assert.equal((await kpost({ action: 'stars', kid: 'Max', delta: 10 })).status, 403);
assert.equal((await kpost({ action: 'remove', id: kc.kids[0].chores[0].id })).status, 403);
assert.equal((await kpost({ action: 'days', id: kc.kids[0].chores[0].id, days: [1] })).status, 403);
assert.equal(kc.kids[0].later, undefined);   // the wall only ever sees today's chores
assert.equal((await worker.fetch(new Request('https://wall.example.com/api/chores'), locked)).status, 403);
// the dev bypass only works on localhost: set in production by mistake, it still fails closed
assert.equal((await worker.fetch(new Request('https://wall.example.com/api/week'), env)).status, 403);
// fonts: served behind the same gate, under both prefixes
assert.equal((await lget('/fonts/inter.woff2')).status, 403);
assert.equal((await lget('/kiosk/fonts/inter.woff2')).status, 403);
r = await lget('/kiosk/fonts/inter.woff2', { cookie });
assert.equal(r.status, 200);
assert.equal(r.headers.get('content-type'), 'font/woff2');
assert.equal((await lget('/kiosk/fonts/nope.woff2', { cookie })).status, 404);

fs.unlinkSync(tmp);
console.log('all tests passed');

// ---------- configuration (homeboard) ----------
const cget = (p, extra) => worker.fetch(new Request('http://localhost:8787' + p), { ...env, ...extra });
// defaults: fun facts on, every feature on, labels sensible
let cw = await (await cget('/api/week?start=2026-11-08')).json();
assert.deepEqual(cw.config, { title: 'Family', meal: 'Dinner', busyLabel: 'at work', features: { chores: true, meals: true, visitors: true, facts: true } });
let fx = await (await cget('/api/facts')).json();
assert.ok(fx.facts.length >= 30 && fx.title === 'Fun fact');
assert.equal((await (await cget('/api/facts', { FACTS: 'pokemon' })).json()).title, 'Pokémon fact');
cw = await (await cget('/api/week?start=2026-11-08', { FACTS: 'off', CHORES: 'false', VISITORS: '0', TITLE: 'The Smiths', BUSY_LABEL: 'working' })).json();
assert.deepEqual(cw.config.features, { chores: false, meals: true, visitors: false, facts: false });
assert.equal(cw.config.title, 'The Smiths');
assert.deepEqual((await (await cget('/api/facts', { FACTS: 'off' })).json()).facts, []);
assert.equal((await cget('/api/chores', { CHORES: 'off' })).status, 404);
// kids come from role: "kid"; the older `shared: true` form still marks the family calendar
const OLD = JSON.stringify([{ name: 'Pat', color: '#111111', colorId: '1' }, { name: 'Home', color: '#222222', colorId: '2', shared: true }, { name: 'Kit', color: '#333333', colorId: '3', role: 'kid' }]);
cw = await (await cget('/api/week?start=2026-11-08', { PEOPLE: OLD })).json();
assert.deepEqual(cw.people.map((p) => [p.name, p.role, p.shared]), [['Pat', 'adult', false], ['Home', 'shared', true], ['Kit', 'kid', false]]);
assert.deepEqual((await (await cget('/api/chores', { PEOPLE: OLD })).json()).kids.map((k) => k.name), ['Kit']);
// a custom meal label
calls.length = 0;
await worker.fetch(new Request('http://localhost:8787/api/events', { method: 'POST', body: JSON.stringify({ date: '2026-11-20', person: 'Supper', title: 'soup' }) }), { ...env, MEAL_LABEL: 'Supper' });
assert.equal(JSON.parse(calls.find((c) => c.method === 'POST' && c.url.includes('/events')).body).summary, 'Supper: soup');
// weather units
calls.length = 0;
await cget('/api/week?start=2026-11-08', { WEATHER_LAT: '51.5', WEATHER_LON: '-0.1', WEATHER_UNITS: 'celsius' });
assert.ok(calls.find((c) => c.url.startsWith('https://api.open-meteo.com/')).url.includes('temperature_unit=celsius'));
// chores per person: kids by default, a grown-up can opt in, a kid can opt out
const CP = JSON.stringify([
  { name: 'Pat', color: '#111111', colorId: '1', role: 'adult', chores: true },
  { name: 'Home', color: '#222222', colorId: '2', role: 'shared', chores: true },   // shared never gets a tile
  { name: 'Kit', color: '#333333', colorId: '3', role: 'kid' },
  { name: 'Lou', color: '#444444', colorId: '4', role: 'kid', chores: false }]);
assert.deepEqual((await (await cget('/api/chores', { PEOPLE: CP })).json()).kids.map((k) => k.name), ['Pat', 'Kit']);
// CHORE_PEOPLE still overrides, and no longer changes whose name tags an event
assert.deepEqual((await (await cget('/api/chores', { CHORE_PEOPLE: '["Ruby","Sam"]' })).json()).kids.map((k) => k.name), ['Ruby', 'Sam']);
cw = await (await cget('/api/week?start=2026-11-08', { CHORE_PEOPLE: '["Sam"]' })).json();
assert.equal(cw.days.find((d) => d.date === '2026-11-12').events.find((e) => e.title === 'taekwondo').person, 'Max');
console.log('config tests passed');
