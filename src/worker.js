// homeboard: a family wall calendar in one Cloudflare Worker. Google Calendar is the data store.
// Reads every calendar on the hub account. Writes ONLY to the shared family calendar.
// MIT licensed. Configure everything in wrangler.toml (see wrangler.example.toml).
import PAGE from './page.html';
import FUN_FACTS from './facts/fun.js';
import POKEMON_FACTS from './facts/pokemon.js';
import INTER from './fonts/inter.woff2';
import FRAUNCES from './fonts/fraunces.woff2';
import FRAUNCES_ITALIC from './fonts/fraunces-italic.woff2';

// Self-hosted (OFL). Served after the access check, so the kiosk path gets them too.
const FONTS = { 'inter.woff2': INTER, 'fraunces.woff2': FRAUNCES, 'fraunces-italic.woff2': FRAUNCES_ITALIC };

const GAPI = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

// Used only if PEOPLE isn't configured. role: adult | kid | shared (exactly one shared entry =
// the family calendar itself). colorId is Google Calendar's event colour (1-11).
const DEFAULT_PEOPLE = [
  { name: 'Alex', color: '#3F67CF', colorId: '9', role: 'adult' },
  { name: 'Sam', color: '#CF4F7C', colorId: '4', role: 'adult' },
  { name: 'Family', color: '#2F8F5E', colorId: '10', role: 'shared' },
  { name: 'Max', color: '#D9762B', colorId: '6', role: 'kid' },
  { name: 'Ruby', color: '#8A55C9', colorId: '3', role: 'kid' },
];
// Fact packs for the occasional fact card. FACTS = fun | pokemon | off.
const FACT_PACKS = { fun: FUN_FACTS, pokemon: POKEMON_FACTS };
const flag = (v, dflt) => (v == null || v === '' ? dflt : !/^(0|false|off|no)$/i.test(String(v).trim()));

const enc = new TextEncoder();
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const parseJson = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

function cfg(env) {
  // `shared: true` (older configs) and `role: "shared"` mean the same thing.
  const people = parseJson(env.PEOPLE, DEFAULT_PEOPLE).map((p) => {
    const role = p.role || (p.shared ? 'shared' : 'adult');
    return { ...p, role, shared: role === 'shared' };
  });
  const adults = people.filter((p) => p.role === 'adult');
  return {
    hub: env.HUB_EMAIL,
    family: env.FAMILY_CALENDAR_ID,
    tz: env.TIMEZONE || 'America/New_York',
    people,
    // calendarId -> person shown as "<person>: busy" with no details
    busy: parseJson(env.BUSY_CALENDARS, {}),
    // calendarId -> person (for colour + "Name: title")
    owners: parseJson(env.CALENDAR_PEOPLE, {}),
    hubPerson: env.HUB_PERSON || (adults[0] || {}).name || null,
    kids: parseJson(env.CHORE_PEOPLE, null) || people.filter((p) => p.role === 'kid').map((p) => p.name),
    meal: env.MEAL_LABEL || 'Dinner',            // "Dinner: tacos" on the family calendar = that day's meal
    busyLabel: env.BUSY_LABEL || 'at work',      // "10a-5p  Alex at work"
    units: /^c/i.test(env.WEATHER_UNITS || '') ? 'celsius' : 'fahrenheit',
    title: env.TITLE || 'Family',
    features: {
      chores: flag(env.CHORES, true),
      meals: flag(env.MEALS, true),
      visitors: flag(env.VISITORS, true),        // a little animal wanders across now and then
      facts: FACT_PACKS[String(env.FACTS || 'fun').toLowerCase()] ? String(env.FACTS || 'fun').toLowerCase() : null,
    },
  };
}

// ---------- time helpers (all "local" maths happens in cfg.tz) ----------
function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}` };
}
function localToUtc(date, hm, tz) {
  const naive = Date.parse(`${date}T${hm}:00Z`);
  let t = naive;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(t, tz);
    t += naive - Date.parse(`${p.date}T${p.hm}:00Z`);
  }
  return t;
}
const addDays = (date, n) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function fmtTime(hm) {
  let [h, m] = hm.split(':').map(Number);
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

// ---------- Google auth ----------
let tokenCache = { token: null, exp: 0 };
class NotConnected extends Error {}

async function refreshToken(env) {
  return env.GOOGLE_REFRESH_TOKEN || (env.KV && (await env.KV.get('refresh_token'))) || null;
}
async function accessToken(env) {
  if (tokenCache.token && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const rt = await refreshToken(env);
  if (!rt) throw new NotConnected('no refresh token');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: rt, grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!r.ok) {
    if (d.error === 'invalid_grant') throw new NotConnected('refresh token rejected');
    throw new Error('token refresh failed: ' + (d.error || r.status));
  }
  tokenCache = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return d.access_token;
}
async function gRead(token, path, body) {
  // Read-only helper. The POST form is used only for freeBusy queries.
  const r = await fetch(GAPI + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Google ${r.status} on ${path.split('?')[0]}`);
  return r.json();
}
// THE ONLY WRITE PATH. The calendar id comes from config, never from the client.
// THE write path. Every write (add, edit, delete) goes through here, and the calendar is
// always FAMILY_CALENDAR_ID from config, never anything the browser sends. An event id that
// isn't on the Family calendar just gets a 404 from Google.
async function writeFamilyEvent(env, token, method, id, event) {
  const c = cfg(env);
  if (!c.family || !c.family.endsWith('@group.calendar.google.com') || c.family === c.hub) {
    throw new Error('FAMILY_CALENDAR_ID is not a secondary calendar; refusing to write');
  }
  if (id != null && !/^[A-Za-z0-9_]{1,200}$/.test(id)) throw new Error('bad event id');
  const url = `${GAPI}/calendars/${encodeURIComponent(c.family)}/events` + (id != null ? '/' + id : '');
  const r = await fetch(url, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: event ? JSON.stringify(event) : undefined,
  });
  if (method === 'DELETE' && (r.status === 410 || r.status === 404)) return {};   // already gone
  if (!r.ok) throw new Error('Google ' + r.status + (method === 'POST' ? ' creating' : method === 'PATCH' ? ' updating' : ' deleting') + ' event');
  return method === 'DELETE' ? {} : r.json();
}
const insertFamilyEvent = (env, token, event) => writeFamilyEvent(env, token, 'POST', null, event);

// ---------- week view ----------
// "Max and Ruby TKD", "Max & Ruby: TKD", "Ruby, Max soccer" -> { people:[Max,Ruby], rest:'TKD' }.
// Only a leading run of known names joined by and / & / , / + / "/" counts.
function leadingPeople(title, names) {
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = (str) => names.find((n) => new RegExp('^' + esc(n) + '(?![\\w])', 'i').test(str));
  let rest = title; const got = [];
  for (;;) {
    const n = at(rest);
    if (!n) break;
    if (!got.includes(n)) got.push(n);
    rest = rest.slice(n.length);
    const sep = rest.match(/^\s*(?:,\s*(?:and\b|&)?|&|\+|\/|and\b)\s*/i);
    if (!sep || !at(rest.slice(sep[0].length))) break;
    rest = rest.slice(sep[0].length);
  }
  return { people: got, rest: rest.replace(/^[\s:\-\u2013\u2014]+/, '') };
}
async function loadCalendar(token, c, cal, timeMin, timeMax) {
  const busyOwner = c.busy[cal.id];
  if (busyOwner !== undefined || cal.accessRole === 'freeBusyReader') {
    const d = await gRead(token, '/freeBusy', { timeMin, timeMax, items: [{ id: cal.id }] });
    const blocks = (d.calendars && d.calendars[cal.id] && d.calendars[cal.id].busy) || [];
    const person = busyOwner || c.owners[cal.id] || null;
    return blocks.map((b) => ({
      title: 'busy', person, busy: true, allDay: false,
      startMs: Date.parse(b.start), endMs: Date.parse(b.end),
    }));
  }
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 4; page++) {
    const q = new URLSearchParams({
      singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const d = await gRead(token, `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
    for (const e of d.items || []) {
      if (e.status === 'cancelled') continue;
      if ((e.attendees || []).some((a) => a.self && a.responseStatus === 'declined')) continue;
      let title = e.summary || (e.visibility === 'private' ? 'busy' : '(no title)');
      let person = null, meal = false, people = null;
      const names = c.people.filter((p) => !p.shared).map((p) => p.name);
      const many = e.eventType === 'workingLocation' ? { people: [] } : leadingPeople(title, names);
      if (many.people.length > 1) {
        // Several people at once: tagged to each of them (first one leads the colour).
        people = many.people; person = people[0];
        if (many.rest) title = many.rest;
      } else if (cal.id === c.family) {
        person = 'Family';
        const m = title.match(/^([^:]{1,20}):\s*(.+)$/);
        const p = m && c.people.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
        if (p) { person = p.name; title = m[2]; }
        else if (m && m[1].trim().toLowerCase() === c.meal.toLowerCase() && e.start.date) { meal = true; title = m[2]; }
      } else {
        person = c.owners[cal.id] || (cal.primary ? c.hubPerson : null);
        // "Max taekwondo" on a parent's calendar is Max's: his colour and initial, title kept.
        const kid = c.kids.find((k) => new RegExp('^' + k + '\\b', 'i').test(title));
        if (kid && e.eventType !== 'workingLocation') {
          person = kid;
          // The chip already says whose it is: "Max taekwondo" -> "taekwondo".
          const rest = title.replace(new RegExp('^' + kid + '\\b[\\s:\\-–—]*', 'i'), '');
          if (rest) title = rest;
        }
      }
      const ev = { title, person, busy: false, color: cal.backgroundColor };
      if (people) ev.people = people;
      if (cal.id === c.family && /^[A-Za-z0-9_]{1,200}$/.test(e.id || '')) ev.id = e.id;   // editable on the wall
      if (meal) ev.meal = true;
      // Google "working location" (Office / Home): shown as a small icon by the date, not a chip.
      if (e.eventType === 'workingLocation') ev.where = (e.workingLocationProperties || {}).type === 'homeOffice' ? 'home' : (e.workingLocationProperties || {}).type === 'officeLocation' ? 'office' : 'other';
      if (e.start.date) {
        ev.allDay = true; ev.startDate = e.start.date; ev.endDate = e.end.date;
      } else {
        ev.allDay = false; ev.startMs = Date.parse(e.start.dateTime); ev.endMs = Date.parse(e.end.dateTime);
      }
      out.push(ev);
    }
    pageToken = d.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// ---------- weather (Open-Meteo: free, no key; only the configured lat/lon is sent) ----------
const WX_ICON = (code) =>
  code === 0 ? '\u2600\uFE0F' : code <= 2 ? '\u{1F324}\uFE0F' : code === 3 ? '\u2601\uFE0F' : code <= 48 ? '\u{1F32B}\uFE0F'
  : code <= 57 ? '\u{1F326}\uFE0F' : code <= 67 ? '\u{1F327}\uFE0F' : code <= 77 ? '\u2744\uFE0F' : code <= 82 ? '\u{1F327}\uFE0F'
  : code <= 86 ? '\u2744\uFE0F' : '\u26C8\uFE0F';
async function weather(env, c) {
  if (!env.WEATHER_LAT || !env.WEATHER_LON) return null;
  try {
    const q = new URLSearchParams({
      latitude: env.WEATHER_LAT, longitude: env.WEATHER_LON, timezone: c.tz, forecast_days: '8',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min', current: 'temperature_2m,weather_code',
      temperature_unit: c.units,
    });
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { cf: { cacheTtl: 1800, cacheEverything: true } });
    if (!r.ok) return null;
    const d = await r.json();
    const days = {};
    (d.daily.time || []).forEach((date, i) => {
      days[date] = { hi: Math.round(d.daily.temperature_2m_max[i]), lo: Math.round(d.daily.temperature_2m_min[i]), icon: WX_ICON(d.daily.weather_code[i]) };
    });
    return { days, now: d.current ? { temp: Math.round(d.current.temperature_2m), icon: WX_ICON(d.current.weather_code) } : null };
  } catch { return null; }  // weather is decoration: never break the calendar over it
}

async function week(env, url) {
  const c = cfg(env);
  const today = tzParts(Date.now(), c.tz).date;
  let start = url.searchParams.get('start');
  if (!/^\d{4}-\d\d-\d\d$/.test(start || '') || isNaN(Date.parse(start))) start = today;
  // Rolling seven days from `start` (default today), so the wall never shows past days.
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    days.push({
      date, events: [],
      startMs: localToUtc(date, '00:00', c.tz),
      endMs: localToUtc(addDays(date, 1), '00:00', c.tz),
    });
  }
  const timeMin = new Date(days[0].startMs).toISOString();
  const timeMax = new Date(days[6].endMs).toISOString();

  const token = await accessToken(env);
  const list = await gRead(token, '/users/me/calendarList?maxResults=250');
  const cals = (list.items || []).filter((x) => !x.deleted);
  const errors = [];
  const loaded = await Promise.all(
    cals.map((cal) =>
      loadCalendar(token, c, cal, timeMin, timeMax).catch(() => {
        errors.push(cal.summaryOverride || cal.summary || cal.id);
        return [];
      })
    )
  );
  const colorOf = (name) => (c.people.find((p) => p.name === name) || {}).color;
  for (const ev of loaded.flat()) {
    for (const d of days) {
      let time = '', sort;
      if (ev.allDay) {
        if (!(ev.startDate <= d.date && d.date < ev.endDate)) continue;
        sort = -1;
      } else {
        if (!(ev.startMs < d.endMs && ev.endMs > d.startMs)) continue;
        if (ev.startMs <= d.startMs && ev.endMs >= d.endMs) { sort = -1; }
        else if (ev.startMs < d.startMs) { time = 'until ' + fmtTime(tzParts(ev.endMs, c.tz).hm); sort = 0; }
        else { time = fmtTime(tzParts(ev.startMs, c.tz).hm); sort = ev.startMs - d.startMs; }
      }
      const out = {
        title: ev.title, person: ev.person, busy: ev.busy, time, sort,
        allDay: sort === -1,
        color: ev.busy ? null : colorOf(ev.person) || ev.color || null,
      };
      if (ev.meal) out.meal = true;
      if (ev.where) out.where = ev.where;
      if (ev.people) out.people = ev.people;
      if (ev.id) {
        // For the edit sheet: the event as it was entered (first day, local start, length).
        out.id = ev.id;
        if (ev.allDay) out.edit = { date: ev.startDate, time: null };
        else {
          const s = tzParts(ev.startMs, c.tz);
          out.edit = { date: s.date, time: s.hm, duration: Math.round((ev.endMs - ev.startMs) / 60000) };
        }
      }
      // Minutes after local midnight (clipped to the day), so the page can dim past events and flag the next one.
      if (!out.allDay && !ev.busy) {
        out.startMin = Math.max(0, Math.round((ev.startMs - d.startMs) / 60000));
        out.endMin = Math.round((Math.min(ev.endMs, d.endMs) - d.startMs) / 60000);
      }
      if (ev.busy) {
        // Clipped to this day, 24h "HH:MM", so the page can fold a day's busy blocks into one span.
        out.from = ev.startMs <= d.startMs ? '00:00' : tzParts(ev.startMs, c.tz).hm;
        out.to = ev.endMs >= d.endMs ? '24:00' : tzParts(ev.endMs, c.tz).hm;
      }
      d.events.push(out);
    }
  }
  const wx = await weather(env, c);
  for (const d of days) {
    if (wx && wx.days[d.date] && d.date >= today) d.weather = wx.days[d.date];
    d.events.sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
    d.events.forEach((e) => delete e.sort);
    delete d.startMs; delete d.endMs;
  }
  return json({
    today, start, days, errors, now: wx ? wx.now : null,
    people: c.people.map(({ name, color, role, shared }) => ({ name, color, role, shared: !!shared })),
    // what the page needs to know about this household's setup
    config: { title: c.title, meal: c.meal, busyLabel: c.busyLabel, features: { ...c.features, facts: !!c.features.facts } },
  });
}

// ---------- add event (Family only) ----------
// Who/when/what from the sheet -> a Google event body. Shared by add and edit.
function buildEvent(c, b, forPatch) {
  let many = null;   // several people: "Max & Ruby: TKD", coloured as the first
  if (Array.isArray(b.people) && new Set(b.people).size > 1) {
    many = [...new Set(b.people)].map((n) => c.people.find((p) => p.name === n && !p.shared));
    if (many.some((p) => !p) || many.length > 5) return { error: 'pick people' };
  }
  const person = many
    ? { name: many.map((p) => p.name).join(' & '), colorId: many[0].colorId }
    : b.person === c.meal && c.features.meals
    ? { name: c.meal, colorId: (c.people.find((p) => p.shared) || {}).colorId, meal: true }
    : c.people.find((p) => p.name === b.person);
  const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!person) return { error: 'pick a person' };
  if (!title) return { error: 'enter a title' };
  if (!/^\d{4}-\d\d-\d\d$/.test(b.date || '') || isNaN(Date.parse(b.date))) return { error: 'bad date' };
  const event = {
    summary: person.shared ? title : `${person.name}: ${title}`,  // a meal becomes "Dinner: tacos"
    colorId: person.colorId,
  };
  if (!forPatch) event.description = 'Added from the family wall calendar';
  if (b.time == null || person.meal) {
    event.start = { date: b.date };
    event.end = { date: addDays(b.date, 1) };
    if (forPatch) { event.start.dateTime = null; event.end.dateTime = null; event.start.timeZone = null; event.end.timeZone = null; }
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) return { error: 'bad time' };
    // the sheet's own choices, or (when editing) whatever length the event already had
    const dur = Number.isInteger(b.duration) && b.duration >= 5 && b.duration <= 1440 ? b.duration : 60;
    const endNaive = new Date(Date.parse(`${b.date}T${b.time}:00Z`) + dur * 60000).toISOString().slice(0, 19);
    event.start = { dateTime: `${b.date}T${b.time}:00`, timeZone: c.tz };
    event.end = { dateTime: endNaive, timeZone: c.tz };
    if (forPatch) { event.start.date = null; event.end.date = null; }
  }
  return { event };
}
async function addEvent(env, request) {
  const c = cfg(env);
  const b = await request.json().catch(() => null);
  if (!b) return json({ error: 'bad json' }, 400);
  const { event, error } = buildEvent(c, b, false);
  if (error) return json({ error }, 400);
  const token = await accessToken(env);
  const created = await insertFamilyEvent(env, token, event);
  return json({ ok: true, id: created.id, summary: created.summary });
}
async function editEvent(env, request) {
  const c = cfg(env);
  const b = await request.json().catch(() => null);
  if (!b || typeof b.id !== 'string') return json({ error: 'bad request' }, 400);
  const { event, error } = buildEvent(c, b, true);
  if (error) return json({ error }, 400);
  const token = await accessToken(env);
  const saved = await writeFamilyEvent(env, token, 'PATCH', b.id, event);
  return json({ ok: true, id: saved.id, summary: saved.summary });
}
async function deleteEvent(env, request) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b.id !== 'string') return json({ error: 'bad request' }, 400);
  const token = await accessToken(env);
  await writeFamilyEvent(env, token, 'DELETE', b.id, null);
  return json({ ok: true });
}

// ---------- chores (KV only, never Google) ----------
// One small JSON doc: { list:[{id,kid,title,days?}], done:{date:{id:true}}, stars:{kid:n} }.
// days = weekdays the chore is due (0=Sun..6=Sat); missing or empty means every day.
// The wall (kiosk) may only tick/untick; adding, removing and spending stars need a
// signed-in parent (Cloudflare Access), so the kids can't award themselves stars.
const CHORES_KEY = 'chores';
async function loadChores(env) {
  const s = parseJson(await env.KV.get(CHORES_KEY), {});
  return { list: s.list || [], done: s.done || {}, stars: s.stars || {} };
}
function choreKids(env, c) {
  return c.kids.map((n) => c.people.find((p) => p.name === n)).filter(Boolean);
}
const weekday = (date) => { const p = date.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); };
const dueOn = (ch, date) => !ch.days || !ch.days.length || ch.days.includes(weekday(date));
function cleanDays(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const d = [...new Set(v.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort();
  return d.length === 7 ? [] : d;   // all seven = every day
}
function choresView(env, s, kiosk) {
  const c = cfg(env);
  const today = tzParts(Date.now(), c.tz).date;
  const done = s.done[today] || {};
  const row = (x) => ({ id: x.id, title: x.title, days: x.days || [], done: !!done[x.id] });
  return json({
    date: today, canEdit: !kiosk,
    kids: choreKids(env, c).map((k) => {
      const mine = s.list.filter((x) => x.kid === k.name);
      const out = { name: k.name, color: k.color, stars: s.stars[k.name] || 0,
        chores: mine.filter((x) => dueOn(x, today)).map(row) };          // what's due today (the wall sees only this)
      if (!kiosk) out.later = mine.filter((x) => !dueOn(x, today)).map(row);   // parents also see the rest
      return out;
    }),
  });
}
async function chores(env, request, kiosk) {
  const s = await loadChores(env);
  if (request.method === 'GET') return choresView(env, s, kiosk);
  const c = cfg(env);
  const today = tzParts(Date.now(), c.tz).date;
  const b = await request.json().catch(() => null);
  if (!b) return json({ error: 'bad json' }, 400);
  const kids = choreKids(env, c).map((k) => k.name);
  if (b.action === 'toggle') {
    const ch = s.list.find((x) => x.id === b.id);
    if (!ch) return json({ error: 'no such chore' }, 404);
    if (!dueOn(ch, today)) return json({ error: 'not due today' }, 400);
    const d = (s.done[today] = s.done[today] || {});
    if (d[ch.id]) { delete d[ch.id]; s.stars[ch.kid] = Math.max(0, (s.stars[ch.kid] || 0) - 1); }
    else { d[ch.id] = true; s.stars[ch.kid] = (s.stars[ch.kid] || 0) + 1; }
  } else if (kiosk) {
    return json({ error: 'change chores from a phone' }, 403);
  } else if (b.action === 'add') {
    const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!kids.includes(b.kid)) return json({ error: 'pick a kid' }, 400);
    if (!title) return json({ error: 'enter a chore' }, 400);
    if (s.list.length >= 40) return json({ error: 'too many chores' }, 400);
    const days = cleanDays(b.days);
    if (!days) return json({ error: 'bad days' }, 400);
    const ch = { id: crypto.randomUUID().slice(0, 8), kid: b.kid, title };
    if (days.length) ch.days = days;
    s.list.push(ch);
  } else if (b.action === 'days') {
    const ch = s.list.find((x) => x.id === b.id);
    const days = cleanDays(b.days);
    if (!ch) return json({ error: 'no such chore' }, 404);
    if (!days) return json({ error: 'bad days' }, 400);
    if (days.length) ch.days = days; else delete ch.days;
  } else if (b.action === 'remove') {
    s.list = s.list.filter((x) => x.id !== b.id);
  } else if (b.action === 'stars') {
    const delta = Math.trunc(Number(b.delta));
    if (!kids.includes(b.kid) || !delta || Math.abs(delta) > 50) return json({ error: 'bad stars' }, 400);
    s.stars[b.kid] = Math.max(0, (s.stars[b.kid] || 0) + delta);
  } else {
    return json({ error: 'bad action' }, 400);
  }
  const keep = addDays(today, -14);  // ticks reset daily; stars are the running total
  for (const d of Object.keys(s.done)) if (d < keep) delete s.done[d];
  await env.KV.put(CHORES_KEY, JSON.stringify(s));
  return choresView(env, s, kiosk);
}

// ---------- one-time Google connect ----------
function redirectUri(url) { return `${url.origin}/oauth/callback`; }
function oauthStart(env, url) {
  const state = crypto.randomUUID();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent',
    login_hint: env.HUB_EMAIL, hd: env.HUB_EMAIL.split('@')[1], state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q,
      'set-cookie': `fw_state=${state}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
async function oauthCallback(env, request, url) {
  const state = url.searchParams.get('state');
  const cookie = (request.headers.get('cookie') || '').match(/fw_state=([^;]+)/);
  if (!state || !cookie || cookie[1] !== state) return new Response('State mismatch. Start again at /oauth/start', { status: 400 });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: 'authorization_code',
    }),
  });
  const d = await r.json();
  if (!r.ok || !d.refresh_token) return new Response('Google did not return a refresh token: ' + (d.error || 'unknown'), { status: 400 });
  const me = await gRead(d.access_token, '/calendars/primary');
  if (me.id !== env.HUB_EMAIL) return new Response(`Signed in as ${me.id}. Only ${env.HUB_EMAIL} may connect.`, { status: 403 });
  await env.KV.put('refresh_token', d.refresh_token);
  tokenCache = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return new Response(null, { status: 302, headers: { location: '/' } });
}

// ---------- access control ----------
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
let certCache = { keys: null, exp: 0 };
async function verifyAccess(request, env) {
  // Local `wrangler dev` only: honoured on localhost and nowhere else, so a stray
  // DEV_NO_AUTH in production config can't open the calendar to the internet.
  if (env.DEV_NO_AUTH === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) return true;
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64u(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64u(p)));
    if (!(payload.exp * 1000 > Date.now())) return false;
    if (![].concat(payload.aud).includes(env.ACCESS_AUD)) return false;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return false;
    if (!certCache.keys || certCache.exp < Date.now()) {
      const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      certCache = { keys: (await r.json()).keys, exp: Date.now() + 3600_000 };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), enc.encode(`${h}.${p}`));
  } catch { return false; }
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// The wall tablet uses /kiosk/?k=<KIOSK_KEY>. That path is a Bypass app in Cloudflare Access.
async function kioskAuth(request, env, url) {
  if (!env.KIOSK_KEY || env.KIOSK_KEY.length < 24) return { ok: false };
  const want = await sha256hex('fw1:' + env.KIOSK_KEY);
  const k = url.searchParams.get('k');
  if (k && (await sha256hex('fw1:' + k)) === want) return { ok: true, setCookie: want };
  const m = (request.headers.get('cookie') || '').match(/fw_kiosk=([a-f0-9]{64})/);
  return { ok: !!m && m[1] === want };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname, kiosk = false;
    const html = (extra = {}) =>
      new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });
    try {
      if (path === '/kiosk') return Response.redirect(url.origin + '/kiosk/' + url.search, 302);
      if (path.startsWith('/kiosk/')) {
        const a = await kioskAuth(request, env, url);
        if (!a.ok) return new Response('Forbidden', { status: 403 });
        path = path.slice(6);
        kiosk = true;
        if (path === '/' && a.setCookie) {
          return html({ 'set-cookie': `fw_kiosk=${a.setCookie}; Path=/kiosk; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000` });
        }
        if (path.startsWith('/oauth')) return new Response('Not found', { status: 404 });
      } else if (!(await verifyAccess(request, env))) {
        return new Response('Forbidden: this app must sit behind Cloudflare Access.', { status: 403 });
      }

      if (path === '/' && request.method === 'GET') return html();
      if (path.startsWith('/fonts/') && FONTS[path.slice(7)]) {
        return new Response(FONTS[path.slice(7)], {
          headers: { 'content-type': 'font/woff2', 'cache-control': 'private, max-age=31536000, immutable' },
        });
      }
      if (path === '/api/week' && request.method === 'GET') return await week(env, url);
      if (path === '/api/events' && request.method === 'POST') return await addEvent(env, request);
      if (path === '/api/events' && request.method === 'PATCH') return await editEvent(env, request);
      if (path === '/api/events' && request.method === 'DELETE') return await deleteEvent(env, request);
      if (path === '/api/chores' && (request.method === 'GET' || request.method === 'POST')) {
        if (!cfg(env).features.chores) return json({ error: 'chores are turned off' }, 404);
        return await chores(env, request, kiosk);
      }
      if (path === '/api/facts' && request.method === 'GET') {
        const pack = FACT_PACKS[cfg(env).features.facts];
        return json(pack ? { title: pack.title, icon: pack.icon, facts: pack.facts } : { facts: [] });
      }
      if (path === '/oauth/start') return oauthStart(env, url);
      if (path === '/oauth/callback') return await oauthCallback(env, request, url);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (e instanceof NotConnected) return json({ error: 'not_connected' }, 503);
      console.error(e);
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
