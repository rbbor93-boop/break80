'use strict';

/* ------------------------------------------------------------------ *
 * Storage
 *
 * Supabase is the source of truth for players, rounds and courses; this
 * device keeps a full copy in localStorage so the app works with no signal
 * on the course. Edited rounds are queued in `dirty` and pushed by sync().
 * ------------------------------------------------------------------ */

const KEY = 'break80.v1';
const LEGACY_KEY = 'golfstats.v1'; // single-player version, before profiles
const CFG = window.BREAK80_CONFIG || {};
const API = 'https://api.golfcourseapi.com/v1';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NEARBY_RADIUS_M = 25000; // ~15 miles

const defaults = () => ({
  password: '',      // shared app password, remembered after first entry
  golfApiKey: '',    // handed out by the server after the password check
  playerId: null,    // who is logging scores on this device right now
  pins: {},          // playerId → PIN, for profiles unlocked on this device
  active: {},        // playerId → id of their round in progress on this device
  players: [],
  courses: [],
  rounds: [],        // everyone's rounds; each has playerId
  dirty: {},         // roundId → edit version not yet on the server
  deletes: [],       // [{ id, playerId }] waiting to be deleted on the server
  courseQueue: [],   // courses not yet on the server
  lastSync: null,
});
let db = (() => {
  try { return Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return defaults(); }
})();
const save = () => localStorage.setItem(KEY, JSON.stringify(db));

// Transient UI state (not persisted)
const ui = {
  view: 'home',
  roundId: null,
  hole: 0,
  span: 'all',
  statsN: 'all',
  statsPlayer: null,
  course: null,
  manual: null,
  who: { mode: 'list', playerId: null, error: '', busy: false },
  gate: { error: '', busy: false },
  sync: 'idle', // idle | busy | offline | error
  find: { status: 'idle', busyMsg: '', error: '', query: '', pos: null, nearby: null, results: null },
};

/* ------------------------------------------------------------------ *
 * Server (Supabase RPC — every call is checked against the password/PIN in the database)
 * ------------------------------------------------------------------ */

const ERR = {
  bad_password: 'Wrong password.',
  bad_pin: 'Wrong PIN.',
  locked: 'Too many wrong PINs. This profile is locked for 15 minutes.',
  name_taken: 'That name is already taken. Pick another.',
  bad_name: 'Enter a name (up to 30 characters).',
  bad_pin_format: 'PIN must be exactly 4 digits.',
  no_player: 'That profile no longer exists.',
  offline: 'No connection. Try again when you have signal.',
  not_configured: "Break80 isn't connected to its database yet.",
};
const errMsg = e => ERR[e.message] || e.message || 'Something went wrong.';

async function rpc(fn, args) {
  if (!CFG.supabaseUrl || !CFG.supabaseKey) throw new Error('not_configured');
  const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
  // Legacy anon keys are JWTs and also go in Authorization; new sb_publishable_ keys don't
  if (!CFG.supabaseKey.startsWith('sb_')) headers.Authorization = `Bearer ${CFG.supabaseKey}`;
  let r;
  try {
    r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  } catch {
    throw new Error('offline');
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message || `Server error (${r.status})`);
  if (body?.error) throw new Error(body.error);
  return body;
}

const me = () => db.players.find(p => p.id === db.playerId && db.pins[p.id]) || null;
const playerName = id => db.players.find(p => p.id === id)?.name || 'Unknown player';

// Record a change to one of my rounds: saved locally now, pushed to the server shortly
function touch(r) {
  r._v = (r._v || 0) + 1;
  db.dirty[r.id] = r._v;
  save();
  queueSync();
}

let syncTimer = null, syncing = false;
const queueSync = (delay = 1200) => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, delay); };

async function sync() {
  if (syncing || !db.password || !CFG.supabaseUrl) return;
  syncing = true;
  setSync('busy');
  try {
    const pw = db.password;
    for (const c of db.courseQueue.splice(0)) {
      try { await rpc('b80_save_course', { pw, p_course: c }); } catch (e) { db.courseQueue.push(c); throw e; }
    }
    for (const d of [...db.deletes]) {
      if (!db.pins[d.playerId]) continue;
      await rpc('b80_delete_round', { pw, p_player: d.playerId, p_pin: db.pins[d.playerId], p_round: d.id });
      db.deletes = db.deletes.filter(x => x !== d);
    }
    // Push dirty rounds, one batch per player (each needs that player's PIN)
    const byPlayer = {};
    for (const id of Object.keys(db.dirty)) {
      const r = db.rounds.find(x => x.id === id);
      if (!r) { delete db.dirty[id]; continue; }
      (byPlayer[r.playerId] ||= []).push(r);
    }
    for (const [pid, rounds] of Object.entries(byPlayer)) {
      if (!db.pins[pid]) continue;
      const sent = rounds.map(r => [r.id, r._v]);
      await rpc('b80_save_rounds', { pw, p_player: pid, p_pin: db.pins[pid], p_rounds: rounds });
      // Only clear what was sent; an edit made mid-request stays queued
      for (const [id, v] of sent) if (db.dirty[id] === v) delete db.dirty[id];
    }
    save();

    const data = await rpc('b80_sync', { pw });
    db.golfApiKey = data.golfApiKey || '';
    db.players = data.players;
    const local = new Map(db.rounds.map(r => [r.id, r]));
    const server = data.rounds.map(r => (db.dirty[r.id] && local.get(r.id)) || r);
    const serverIds = new Set(server.map(r => r.id));
    const unsent = db.rounds.filter(r => db.dirty[r.id] && !serverIds.has(r.id));
    const deleting = new Set(db.deletes.map(d => d.id));
    db.rounds = [...unsent, ...server].filter(r => !deleting.has(r.id)).sort((a, b) => b.date.localeCompare(a.date));
    const queued = new Set(db.courseQueue.map(c => c.id));
    db.courses = [...db.courseQueue, ...data.courses.filter(c => !queued.has(c.id))];
    db.lastSync = new Date().toISOString();
    save();
    setSync('idle', true);
  } catch (e) {
    save();
    if (e.message === 'bad_password') { db.password = ''; save(); render(); }
    setSync(e.message === 'offline' ? 'offline' : 'error');
    if (e.message !== 'offline') console.warn('sync failed:', e);
  } finally {
    syncing = false;
  }
}

function setSync(state, dataChanged = false) {
  ui.sync = state;
  const el = document.getElementById('sync');
  if (el) el.outerHTML = syncBadge();
  // Fresh data from others: redraw, unless the player is mid-typing
  if (dataChanged && !document.activeElement?.matches('input, select, textarea')) render();
}

function syncBadge() {
  const pending = Object.keys(db.dirty).length + db.deletes.length;
  const [cls, label] =
    ui.sync === 'busy' ? ['busy', 'Saving…']
    : ui.sync === 'offline' ? ['warn', pending ? 'Offline · saved on phone' : 'Offline']
    : ui.sync === 'error' ? ['warn', 'Sync problem · saved on phone']
    : pending ? ['warn', 'Not synced yet'] : ['ok', 'Synced'];
  return `<span id="sync" class="sync ${cls}">${label}</span>`;
}

// Rounds saved by the old single-player version on this phone
function legacyRounds() {
  try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}').rounds || []; } catch { return []; }
}
function offerLegacyImport() {
  const old = legacyRounds().filter(r => r.done);
  if (!old.length || !me()) return;
  if (confirm(`This phone has ${old.length} round${old.length === 1 ? '' : 's'} from before profiles existed. Add ${old.length === 1 ? 'it' : 'them'} to ${me().name}'s profile?`)) {
    for (const r of old) {
      if (db.rounds.some(x => x.id === r.id)) continue;
      const nr = { ...r, playerId: db.playerId };
      db.rounds.push(nr);
      touch(nr);
    }
  }
  localStorage.removeItem(LEGACY_KEY);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (x, d = 1) => (x == null || !isFinite(x) ? '–' : (+x.toFixed(d)).toString());
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
const toParStr = d => (d === 0 ? 'E' : d > 0 ? '+' + d : String(d));
const yn = v => (v == null ? '–' : v ? 'Yes' : 'No');
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function miles(a, b) {
  const R = 3958.8, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function scoreName(score, par) {
  if (score === 1) return 'Hole in one!';
  const d = score - par;
  return { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double', 3: 'Triple' }[d] || toParStr(d);
}
function diffClass(h) {
  if (h.score == null) return '';
  const d = h.score - h.par;
  return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'dbl';
}

/* ------------------------------------------------------------------ *
 * Derived per-hole stats
 * ------------------------------------------------------------------ */

const toGreen = h => (h.score != null && h.putts != null ? h.score - h.putts : null);
const D = {
  // Green in regulation: auto from score − putts unless the player set it manually
  gir: h => h.girOverride ?? (toGreen(h) == null ? null : toGreen(h) <= h.par - 2),
  gir1: h => {
    if (D.gir(h) === true) return true;
    const t = toGreen(h);
    return t == null ? null : t <= h.par - 1;
  },
  threePutt: h => (h.putts == null ? null : h.putts >= 3),
  par5Bogey: h => (h.par !== 5 || h.score == null ? null : h.score > h.par),
};

function calc(holes) {
  const p = holes.filter(h => h.score != null);
  const cnt = (arr, f) => arr.filter(f).length;
  const sum = (arr, f) => arr.reduce((a, h) => a + (f(h) || 0), 0);

  const fw = p.filter(h => h.par >= 4 && h.fairway);
  const g = p.filter(h => D.gir(h) != null);
  const g1 = p.filter(h => D.gir1(h) != null);
  const pt = p.filter(h => h.putts != null);
  const girPt = pt.filter(h => D.gir(h) === true);
  const fp = p.filter(h => h.firstPutt != null);
  const p5 = p.filter(h => h.par === 5);
  const p3 = p.filter(h => h.par === 3);

  return {
    holes: p.length,
    score: sum(p, h => h.score),
    par: sum(p, h => h.par),
    fwN: fw.length, fwHit: cnt(fw, h => h.fairway === 'hit'), fwL: cnt(fw, h => h.fairway === 'left'), fwR: cnt(fw, h => h.fairway === 'right'),
    girN: g.length, gir: cnt(g, h => D.gir(h)),
    gir1N: g1.length, gir1: cnt(g1, h => D.gir1(h)),
    puttsN: pt.length, putts: sum(pt, h => h.putts), threePutts: cnt(pt, h => h.putts >= 3),
    girPuttsN: girPt.length, girPutts: sum(girPt, h => h.putts),
    fpN: fp.length, fp: sum(fp, h => h.firstPutt),
    wedge: cnt(p, h => h.wedgeBogey),
    p5N: p5.length, p5Bog: cnt(p5, h => h.score > h.par),
    p3N: p3.length, shortSide: cnt(p3, h => h.shortSide),
    pen: sum(p, h => h.penalties),
  };
}

/* ------------------------------------------------------------------ *
 * Data access
 * ------------------------------------------------------------------ */

const activeRound = () => db.rounds.find(r => r.id === db.active[db.playerId] && !r.done) || null;
const curRound = () => db.rounds.find(r => r.id === ui.roundId);
const curHole = () => curRound().holes[ui.hole];
const canEdit = r => !!r && r.playerId === db.playerId;

function thru(r) {
  const played = r.holes.filter(h => h.score != null);
  if (!played.length) return 'Not started';
  const d = played.reduce((a, h) => a + h.score - h.par, 0);
  return `${toParStr(d)} thru ${played.length}`;
}

// Save a course locally and share it so nobody has to look it up again
function upsertCourse(c) {
  const { dist, ...clean } = c;
  const i = db.courses.findIndex(x => x.id === c.id);
  if (i >= 0) db.courses[i] = clean; else db.courses.push(clean);
  db.courseQueue = [...db.courseQueue.filter(x => x.id !== c.id), clean];
}

function startRound(course, teeIdx) {
  const active = activeRound();
  if (active) {
    if (!confirm(`You have a round in progress at ${active.course}. Start a new one? The current round will be saved as finished.`)) return;
    finishRound(active);
  }
  const t = course.tees[teeIdx];
  let holes = t.holes.map((h, i) => ({ ...h, n: i + 1 }));
  if (holes.length === 18 && ui.span === 'front') holes = holes.slice(0, 9);
  if (holes.length === 18 && ui.span === 'back') holes = holes.slice(9);
  const r = {
    id: uid(),
    playerId: db.playerId,
    date: new Date().toISOString(),
    courseId: course.id,
    course: course.name,
    tee: t.name,
    rating: t.rating ?? null,
    slope: t.slope ?? null,
    holes: holes.map(h => ({
      n: h.n, par: h.par, yardage: h.yardage ?? null, hcp: h.hcp ?? null,
      score: null, putts: null, firstPutt: null, fairway: null, girOverride: null,
      penalties: 0, wedgeBogey: false, shortSide: false,
    })),
    done: false,
  };
  db.rounds.unshift(r);
  db.active[db.playerId] = r.id;
  upsertCourse(course);
  touch(r);
  go('hole', { roundId: r.id, hole: 0 });
}

function deleteRound(r) {
  db.rounds = db.rounds.filter(x => x !== r);
  delete db.dirty[r.id];
  db.deletes.push({ id: r.id, playerId: r.playerId });
  if (db.active[r.playerId] === r.id) delete db.active[r.playerId];
  save();
  queueSync(0);
}

function finishRound(r) {
  if (!r.holes.some(h => h.score != null)) return deleteRound(r);
  r.done = true;
  if (db.active[r.playerId] === r.id) delete db.active[r.playerId];
  touch(r);
}

/* ------------------------------------------------------------------ *
 * Course lookup: GPS → OpenStreetMap (nearby names) → GolfCourseAPI (scorecard)
 * ------------------------------------------------------------------ */

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location not supported on this device'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => reject(new Error(e.code === 1 ? 'Permission denied — allow location access for this site' : e.message || 'Location unavailable')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 }
    );
  });
}

async function nearbyCourses(pos) {
  const around = `(around:${NEARBY_RADIUS_M},${pos.lat},${pos.lon})`;
  const q = `[out:json][timeout:20];(way["leisure"="golf_course"]${around};relation["leisure"="golf_course"]${around};);out center tags;`;
  const r = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!r.ok) throw new Error(`Nearby course lookup failed (${r.status})`);
  const seen = new Set();
  return (await r.json()).elements
    .filter(e => e.tags?.name && e.center)
    .map(e => ({ name: e.tags.name, lat: e.center.lat, lon: e.center.lon }))
    .map(c => ({ ...c, dist: miles(pos, c) }))
    .sort((a, b) => a.dist - b.dist)
    .filter(c => !seen.has(c.name) && seen.add(c.name))
    .slice(0, 25);
}

async function apiSearch(q) {
  let r;
  try {
    r = await fetch(`${API}/search?search_query=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Key ${db.golfApiKey}` },
    });
  } catch {
    throw new Error("Couldn't reach GolfCourseAPI — check your signal and try again.");
  }
  if (r.status === 401 || r.status === 403) throw new Error('The course database rejected our API key. Enter the scorecard manually for now.');
  if (r.status === 429) throw new Error('GolfCourseAPI daily limit reached — try again tomorrow or enter the card manually.');
  if (!r.ok) throw new Error(`Course search failed (${r.status})`);
  return (await r.json()).courses || [];
}

// "Royal Oaks Golf & Country Club" → "royal oaks"
const simplifyName = q =>
  q.toLowerCase()
    .replace(/\b(the|golf|club|course|country|links|resort|gc|cc|g&cc|and)\b|&|-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function fromApi(c) {
  const tees = [];
  for (const [gender, list] of Object.entries(c.tees || {})) {
    for (const t of list || []) {
      if (!t.holes?.length) continue;
      tees.push({
        name: (t.tee_name || 'Tees') + (gender === 'female' ? ' (W)' : ''),
        rating: t.course_rating ?? null,
        slope: t.slope_rating ?? null,
        yards: t.total_yards ?? null,
        par: t.par_total ?? null,
        holes: t.holes.map(h => ({ par: h.par, yardage: h.yardage ?? null, hcp: h.handicap ?? null })),
      });
    }
  }
  const club = c.club_name, course = c.course_name;
  const name = club && course && club !== course ? `${club} – ${course}` : club || course || 'Course';
  const loc = c.location || {};
  return {
    id: 'api-' + c.id,
    name,
    city: [loc.city, loc.state].filter(Boolean).join(', '),
    lat: loc.latitude ?? null,
    lon: loc.longitude ?? null,
    tees,
  };
}

// Async lookups only redraw if the player is still on the course picker
const renderFind = () => { if (ui.view === 'find') render(); };

async function locate() {
  const f = ui.find;
  Object.assign(f, { error: '', status: 'busy', busyMsg: 'Finding courses near you…' });
  render();
  try {
    f.pos = await getPosition();
    f.nearby = await nearbyCourses(f.pos);
    if (!f.nearby.length) f.error = 'No golf courses found within 15 miles.';
  } catch (e) {
    f.error = e.message;
  }
  f.status = 'idle';
  renderFind();
}

async function doSearch(q, near) {
  q = (q || '').trim();
  if (!q) return;
  const f = ui.find;
  Object.assign(f, { query: q, error: '', results: null });
  if (!db.golfApiKey) {
    f.error = "Course search isn't available right now. Enter this course manually.";
    return render();
  }
  Object.assign(f, { status: 'busy', busyMsg: `Searching for “${q}”…` });
  render();
  let autoPick = null;
  try {
    let list = await apiSearch(q);
    const short = simplifyName(q);
    if (!list.length && short && short !== q.toLowerCase()) list = await apiSearch(short);
    const ref = near || f.pos;
    const cs = list.map(fromApi).filter(c => c.tees.length);
    if (ref) {
      cs.forEach(c => (c.dist = c.lat != null ? miles(ref, c) : null));
      cs.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    }
    f.results = cs;
    if (!cs.length) f.error = `No scorecard found for “${q}”. Try a shorter name, or enter the card manually.`;
    // Tapped a nearby course and exactly one scorecard sits on top of it → skip the picker
    else if (near && cs.filter(c => c.dist != null && c.dist < 2).length === 1) autoPick = cs[0];
  } catch (e) {
    f.error = e.message;
  }
  f.status = 'idle';
  if (ui.view !== 'find') return;
  if (autoPick) go('tees', { course: autoPick, span: 'all' });
  else render();
}

/* ------------------------------------------------------------------ *
 * View helpers
 * ------------------------------------------------------------------ */

const bar = (title, back) => `
  <header class="top">
    <button class="icon" data-a="go" data-v="${back}" aria-label="Back">‹</button>
    <div class="ttl"><strong>${esc(title)}</strong></div>
    <span class="icon"></span>
  </header>`;

const row = (action, value, title, sub, right = '›') => `
  <button class="row" data-a="${action}" data-v="${esc(value)}">
    <span class="row-main"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    <span class="row-right">${right}</span>
  </button>`;

const section = (title, body) => `<section><h2>${title}</h2><div class="list">${body}</div></section>`;

const stepper = (label, key, val, dflt, sub = '') => `
  <div class="field">
    <div class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</div>
    <div class="stepper">
      <button data-a="${key}" data-v="-1" aria-label="Decrease ${label}">−</button>
      <button class="val ${val == null ? 'unset' : ''}" data-a="${key}" data-v="0">${val ?? dflt}</button>
      <button data-a="${key}" data-v="1" aria-label="Increase ${label}">+</button>
    </div>
  </div>`;

const segBtn = (action, value, label, on, extra = '') =>
  `<button data-a="${action}" data-v="${value}" class="${on ? 'on' : ''} ${extra}">${label}</button>`;

const toggle = (action, label, on, disabled = false) => `
  <button class="toggle ${on ? 'on' : ''}" data-a="${action}" ${disabled ? 'disabled' : ''}>
    <span>${label}</span><span class="sw" aria-hidden="true"></span>
  </button>`;

function teeInfo(t) {
  const yards = t.yards || t.holes.reduce((a, h) => a + (h.yardage || 0), 0);
  const par = t.par || t.holes.reduce((a, h) => a + h.par, 0);
  return [yards ? `${yards.toLocaleString()} yds` : null, `Par ${par}`, `${t.holes.length} holes`, t.rating && t.slope ? `${t.rating} / ${t.slope}` : null]
    .filter(Boolean)
    .join(' · ');
}

/* ------------------------------------------------------------------ *
 * Stat definitions — one list drives the tiles, the round-by-round
 * table and the trend charts.
 *   val(s)  this stat for one round or many (s = calc(...)), null if not recorded
 *   per18   val is a count: averages and charts scale it to 18 holes (over n(s) holes)
 *   cell(s) how one round's result reads in tiles and tables (default: fmt(val))
 *   tick(v) short axis label
 * ------------------------------------------------------------------ */

const pctOf = (a, b) => (b ? (100 * a) / b : null);
const fmtPct = v => `${Math.round(v)}%`;
const pctStat = (key, label, short, better, a, b, sub) =>
  ({ key, label, short, better, val: s => pctOf(a(s), b(s)), fmt: fmtPct, tick: fmtPct, sub });

const STATS = [
  { key: 'score', label: 'Score', short: 'Score', better: 'low', per18: true,
    val: s => (s.holes ? s.score - s.par : null),
    fmt: v => toParStr(+v.toFixed(1)), tick: v => toParStr(+v.toFixed(1)),
    cell: s => `${s.score} (${toParStr(s.score - s.par)})`,
    sub: (s, avg) => (avg ? `to par · avg ${num((s.score * 18) / s.holes)} strokes` : `${s.holes} holes`) },
  pctStat('fw', 'Fairways hit', 'FW hit', 'high', s => s.fwHit, s => s.fwN, s => `${s.fwHit} of ${s.fwN}`),
  pctStat('fwL', 'Missed left', 'Miss L', 'low', s => s.fwL, s => s.fwN, s => `${s.fwL} of ${s.fwN} fairways`),
  pctStat('fwR', 'Missed right', 'Miss R', 'low', s => s.fwR, s => s.fwN, s => `${s.fwR} of ${s.fwN} fairways`),
  pctStat('gir', 'Greens in reg', 'GIR', 'high', s => s.gir, s => s.girN, s => `${s.gir} of ${s.girN}`),
  pctStat('gir1', 'GIR + 1', 'GIR+1', 'high', s => s.gir1, s => s.gir1N, s => `${s.gir1} of ${s.gir1N}`),
  { key: 'putts', label: 'Putts', short: 'Putts', better: 'low', per18: true, n: s => s.puttsN,
    val: s => (s.puttsN ? s.putts : null), fmt: v => num(v), tick: v => num(v),
    sub: s => `${num(s.putts / s.puttsN, 2)} per hole` },
  { key: 'puttsGir', label: 'Putts per GIR', short: 'Putts/GIR', better: 'low',
    val: s => (s.girPuttsN ? s.girPutts / s.girPuttsN : null), fmt: v => num(v, 2), tick: v => num(v, 2),
    sub: s => `${s.girPuttsN} greens hit` },
  { key: 'threePutt', label: '3-putts', short: '3-putts', better: 'low', per18: true, n: s => s.puttsN,
    val: s => (s.puttsN ? s.threePutts : null), fmt: v => num(v), tick: v => num(v),
    sub: s => `${pct(s.threePutts, s.puttsN)} of holes` },
  { key: 'firstPutt', label: '1st putt distance', short: '1st putt', better: 'low',
    val: s => (s.fpN ? s.fp / s.fpN : null), fmt: v => `${num(v)} ft`, tick: v => num(v),
    sub: s => `avg of ${s.fpN} holes` },
  { key: 'wedge', label: 'Bogeys with a wedge', short: 'Wedge bog', better: 'low', per18: true,
    val: s => (s.holes ? s.wedge : null), fmt: v => num(v), tick: v => num(v) },
  pctStat('p5', 'Par 5 bogeys', 'P5 bogey', 'low', s => s.p5Bog, s => s.p5N, s => `${s.p5Bog} of ${s.p5N} par 5s`),
  pctStat('short', 'Par 3 short-sided', 'P3 short', 'low', s => s.shortSide, s => s.p3N, s => `${s.shortSide} of ${s.p3N} par 3s`),
  { key: 'pen', label: 'Penalties', short: 'Pens', better: 'low', per18: true,
    val: s => (s.holes ? s.pen : null), fmt: v => num(v), tick: v => num(v) },
];

// Comparable value: per-18 rate for counts, as-is for percentages/averages
function statRate(st, s) {
  const v = st.val(s);
  if (v == null || !st.per18) return v;
  const n = st.n ? st.n(s) : s.holes;
  return n ? (v * 18) / n : null;
}
const roundVal = (st, s) => {
  const v = st.val(s);
  return v == null ? '–' : st.cell ? st.cell(s) : st.per18 ? String(v) : st.fmt(v);
};
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

function selectedRounds(pid = statsPlayerId()) {
  const done = db.rounds.filter(r => r.done && r.playerId === pid).sort((a, b) => b.date.localeCompare(a.date));
  return ui.statsN === 'all' ? done : done.slice(0, ui.statsN);
}

const rangeSeg = () => `<div class="seg four">
  ${[5, 10, 20, 'all'].map(n => segBtn('statsN', n, n === 'all' ? 'All' : `Last ${n}`, ui.statsN === n)).join('')}
</div>`;

function tiles(s, avg) {
  return `<div class="tiles">${STATS.map(st => {
    const v = avg ? statRate(st, s) : st.val(s);
    const big = v == null ? '–' : avg ? st.fmt(v) : roundVal(st, s);
    const sub = v == null ? '' : st.sub?.(s, avg) || '';
    const inner = `<span class="tl">${st.label}${avg && st.per18 ? ' / 18' : ''}</span><strong>${big}</strong>${sub ? `<small>${sub}</small>` : ''}`;
    return avg
      ? `<button class="tile tap" data-a="trend" data-v="${st.key}">${inner}<span class="more">Trend ›</span></button>`
      : `<div class="tile">${inner}</div>`;
  }).join('')}</div>`;
}

// Every round × every stat; tap a column header for its trend, a row for the round
function roundTable(rounds) {
  const d = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `<div class="rt-wrap"><table class="rt">
    <thead><tr><th>Round</th>${STATS.map(st => `<th><button class="link" data-a="trend" data-v="${st.key}">${st.short}</button></th>`).join('')}</tr></thead>
    <tbody>${rounds.map(r => {
      const s = calc(r.holes);
      return `<tr>
        <th><button class="rt-round" data-a="openRound" data-v="${r.id}"><b>${d(r.date)}${s.holes !== 18 ? ` <small>· ${s.holes}h</small>` : ''}</b><small>${esc(r.course)}</small></button></th>
        ${STATS.map(st => `<td>${roundVal(st, s)}</td>`).join('')}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// "Last k rounds vs the ones before" — needs at least 4 rounds to say anything
function trendNote(st, pts) {
  if (pts.length < 4) return '';
  const k = Math.min(5, Math.floor(pts.length / 2));
  const recent = mean(pts.slice(-k).map(p => p.v)), prior = mean(pts.slice(0, -k).map(p => p.v));
  const d = recent - prior;
  const vs = `last ${k} rounds vs previous ${pts.length - k}`;
  if (st.fmt(Math.abs(d)) === st.fmt(0)) return `<span class="trend">● Steady</span><small>${vs}</small>`;
  const good = st.better === 'low' ? d < 0 : d > 0;
  const mag = st.key === 'score' ? num(Math.abs(d)) : st.fmt === fmtPct ? `${Math.round(Math.abs(d))} pts` : st.fmt(Math.abs(d));
  return `<span class="trend ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${mag} · ${good ? 'improving' : 'getting worse'}</span><small>${vs}</small>`;
}

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(+t.toFixed(10));
  if (ticks.at(-1) < hi) ticks.push(+(ticks.at(-1) + step).toFixed(10));
  return ticks;
}

let chartState = null; // geometry + points for the tap/hover tooltip

function chart(st, pts) {
  const W = 340, H = 200, L = 40, R = 12, T = 12, B = 26;
  const vals = pts.map(p => p.v);
  const avg = vals.map((_, i) => mean(vals.slice(Math.max(0, i - 4), i + 1)));
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const lo = ticks[0], hi = ticks.at(-1);
  const x = i => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
  const y = v => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const line = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const d = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  chartState = { W, H, T, B, x, y, pts, avg, st };
  return `<div class="chart">
    <div class="legend">
      <span><i class="k-dot"></i>Each round</span>
      ${pts.length >= 3 ? '<span><i class="k-line"></i>5-round average</span>' : ''}
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(st.label)} by round">
      ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="ax" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${st.tick(t)}</text>`).join('')}
      <text class="ax" x="${L}" y="${H - 6}">${d(pts[0].r.date)}</text>
      ${pts.length > 1 ? `<text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">${d(pts.at(-1).r.date)}</text>` : ''}
      <line class="hl" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <path class="s1-line" d="${line(vals)}"/>
      ${pts.length >= 3 ? `<path class="s2-line" d="${line(avg)}"/>` : ''}
      ${vals.map((v, i) => `<circle class="s1-dot" cx="${x(i)}" cy="${y(v)}" r="4"/>`).join('')}
      <circle class="hd" r="6" cx="0" cy="0" visibility="hidden"/>
      <rect class="hit" x="0" y="0" width="${W}" height="${H}"/>
    </svg>
    <div class="tip" hidden></div>
  </div>`;
}

function chartPointer(e) {
  const svg = e.target.closest?.('.chart svg');
  if (!svg || !chartState) return;
  const { W, x, y, pts, avg, st } = chartState;
  const box = svg.getBoundingClientRect();
  const vx = ((e.clientX - box.left) * W) / box.width;
  let i = 0;
  pts.forEach((_, j) => { if (Math.abs(x(j) - vx) < Math.abs(x(i) - vx)) i = j; });
  const p = pts[i];
  const hl = svg.querySelector('.hl'), hd = svg.querySelector('.hd'), tip = svg.parentElement.querySelector('.tip');
  hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.setAttribute('visibility', 'visible');
  hd.setAttribute('cx', x(i)); hd.setAttribute('cy', y(p.v)); hd.setAttribute('visibility', 'visible');
  tip.innerHTML = `<b>${esc(p.r.course)}</b><span>${fmtDate(p.r.date)}</span>
    <span>${st.label}: <b>${roundVal(st, p.s)}</b></span>${pts.length >= 3 ? `<span>5-round avg: ${st.fmt(avg[i])}</span>` : ''}`;
  tip.hidden = false;
  const left = (x(i) / W) * box.width;
  tip.style.left = `${Math.min(Math.max(left, 80), box.width - 80)}px`;
}
document.addEventListener('pointerdown', chartPointer);
document.addEventListener('pointermove', chartPointer);

function scorecard(r, editable = true) {
  const chunks = [];
  for (let i = 0; i < r.holes.length; i += 9) chunks.push(r.holes.slice(i, i + 9));
  const fwMark = h => (h.par < 4 ? '' : { hit: '✓', left: '←', right: '→' }[h.fairway] || '');
  const girMark = h => (D.gir(h) == null ? '' : D.gir(h) ? '●' : '○');
  const tot = (hs, f) => { const v = hs.filter(h => f(h) != null); return v.length ? v.reduce((a, h) => a + f(h), 0) : ''; };
  return chunks.map((hs, ci) => {
    const label = chunks.length === 1 ? 'Tot' : ci === 0 ? 'Out' : 'In';
    const offset = r.holes.indexOf(hs[0]);
    return `<div class="sc-wrap"><table class="sc">
      <tr class="hd"><th>Hole</th>${hs.map((h, j) => `<th>${editable ? `<button class="link" data-a="hole" data-v="${offset + j}">${h.n}</button>` : h.n}</th>`).join('')}<th>${label}</th></tr>
      <tr class="muted"><th>Yds</th>${hs.map(h => `<td>${h.yardage ?? ''}</td>`).join('')}<td>${tot(hs, h => h.yardage)}</td></tr>
      <tr><th>Par</th>${hs.map(h => `<td>${h.par}</td>`).join('')}<td>${tot(hs, h => h.par)}</td></tr>
      <tr class="score"><th>Score</th>${hs.map(h => `<td><span class="sd ${diffClass(h)}">${h.score ?? ''}</span></td>`).join('')}<td><b>${tot(hs, h => h.score)}</b></td></tr>
      <tr><th>Putts</th>${hs.map(h => `<td>${h.putts ?? ''}</td>`).join('')}<td>${tot(hs, h => h.putts)}</td></tr>
      <tr><th>FW</th>${hs.map(h => `<td>${fwMark(h)}</td>`).join('')}<td></td></tr>
      <tr><th>GIR</th>${hs.map(h => `<td>${girMark(h)}</td>`).join('')}<td></td></tr>
    </table></div>`;
  }).join('');
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

const brand = `<span class="brand">Break<b>80</b></span>`;

const views = {
  gate() {
    const g = ui.gate;
    return `<main class="gate">
      <div class="gate-logo">${brand}</div>
      <p class="tagline">Track the stats that break 80.</p>
      ${!CFG.supabaseUrl ? `<div class="note warn">${ERR.not_configured}</div>` : ''}
      <form class="stack" data-f="gate">
        <label class="input">Password
          <input name="pw" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus>
        </label>
        ${g.error ? `<div class="note warn">${esc(g.error)}</div>` : ''}
        <button class="btn primary big" ${g.busy ? 'disabled' : ''}>${g.busy ? 'Checking…' : 'Enter'}</button>
      </form>
    </main>`;
  },

  who() {
    const w = ui.who;
    const err = w.error ? `<div class="note warn">${esc(w.error)}</div>` : '';
    const pinInput = (name, label) => `<label class="input">${label}
      <input name="${name}" class="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required></label>`;

    if (w.mode === 'new') return `<main class="gate">
      <div class="gate-logo sm">${brand}</div>
      <h1>New player</h1>
      <form class="stack" data-f="newPlayer">
        <label class="input">Your name<input name="name" maxlength="30" autocomplete="off" required autofocus></label>
        ${pinInput('pin', 'Choose a 4-digit PIN')}
        ${pinInput('pin2', 'Confirm PIN')}
        <p class="muted small">Your PIN stops other people logging scores on your profile. Everyone in Break80 can see everyone's scores.</p>
        ${err}
        <button class="btn primary big" ${w.busy ? 'disabled' : ''}>${w.busy ? 'Creating…' : 'Create profile'}</button>
        <button class="btn ghost" data-a="whoList">Back</button>
      </form>
    </main>`;

    if (w.mode === 'pin') return `<main class="gate">
      <div class="gate-logo sm">${brand}</div>
      <h1>Hi ${esc(playerName(w.playerId))}</h1>
      <form class="stack" data-f="pin">
        <input name="pin" class="pin big-pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="PIN" aria-label="4-digit PIN" required autofocus>
        ${err}
        <button class="btn primary big" ${w.busy ? 'disabled' : ''}>${w.busy ? 'Checking…' : 'Unlock'}</button>
        <button class="btn ghost" data-a="whoList">Back</button>
      </form>
    </main>`;

    return `<main class="gate">
      <div class="gate-logo sm">${brand}</div>
      <h1>Who's playing?</h1>
      ${db.players.length
        ? `<div class="list">${db.players.map(p => row('pickPlayer', p.id, p.name, p.id === db.playerId ? 'Current player' : db.pins[p.id] ? 'Unlocked on this phone' : '', db.pins[p.id] ? '›' : '🔒')).join('')}</div>`
        : '<p class="muted center">No players yet. Create the first profile.</p>'}
      <button class="btn primary big" data-a="whoNew">+ New player</button>
      ${me() ? '<button class="btn ghost" data-a="go" data-v="home">Cancel</button>' : ''}
    </main>`;
  },

  home() {
    const r = activeRound(), p = me();
    const done = db.rounds.filter(x => x.done && x.playerId === p.id).length;
    return `
      <header class="hero-top">
        <div class="brand">Break<b>80</b></div>
        <div class="whoami">Playing as <b>${esc(p.name)}</b> · <button class="link light" data-a="switchPlayer">Switch</button></div>
        ${syncBadge()}
      </header>
      <main class="stack">
        ${r ? `<button class="card resume" data-a="resume">
                 <span class="eyebrow">Round in progress</span>
                 <strong>${esc(r.course)}</strong>
                 <span>${esc(r.tee)} · ${thru(r)}</span>
               </button>` : ''}
        <button class="btn primary big" data-a="newRound">Start new round</button>
        <button class="btn big" data-a="myStats">My stats${done ? ` <small>· ${done} round${done === 1 ? '' : 's'}</small>` : ''}</button>
        <button class="btn big" data-a="go" data-v="board">Leaderboard</button>
        <button class="btn big" data-a="go" data-v="settings">Settings</button>
      </main>`;
  },

  find() {
    const f = ui.find;
    const saved = db.courses
      .map(c => ({ ...c, dist: f.pos && c.lat != null ? miles(f.pos, c) : null }))
      .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9) || a.name.localeCompare(b.name));
    const distStr = d => (d == null ? '›' : `${num(d)} mi`);
    return `${bar('Choose course', 'home')}
      <main class="stack">
        <form class="search" data-f="search">
          <input id="q" type="search" placeholder="Search course name" value="${esc(f.query)}" enterkeyhint="search" autocomplete="off">
          <button class="btn primary">Search</button>
        </form>
        ${f.status === 'busy' ? `<p class="muted center spin">${esc(f.busyMsg)}</p>` : ''}
        ${f.error ? `<div class="note warn">${esc(f.error)}</div>` : ''}
        ${f.results?.length ? section('Scorecards found', f.results.map((c, i) => row('pickResult', i, c.name, [c.city, `${c.tees.length} tees`].filter(Boolean).join(' · '), distStr(c.dist))).join('')) : ''}
        ${saved.length ? section('Your courses', saved.map(c => row('pickSaved', c.id, c.name, c.city || `${c.tees.length} tees`, distStr(c.dist))).join('')) : ''}
        ${f.nearby?.length
          ? section('Nearby (GPS)', f.nearby.map((c, i) => row('pickNearby', i, c.name, '', `${num(c.dist)} mi`)).join(''))
          : f.status !== 'busy' ? `<button class="btn" data-a="locate">📍 Find courses near me</button>` : ''}
        <button class="btn ghost" data-a="manual">Enter a scorecard manually</button>
      </main>`;
  },

  tees() {
    const c = ui.course;
    const has18 = c.tees.some(t => t.holes.length === 18);
    return `${bar(c.name, 'find')}
      <main class="stack">
        ${c.city ? `<p class="muted">${esc(c.city)}</p>` : ''}
        ${has18 ? `<div class="seg three">
            ${segBtn('span', 'all', '18 holes', ui.span === 'all')}
            ${segBtn('span', 'front', 'Front 9', ui.span === 'front')}
            ${segBtn('span', 'back', 'Back 9', ui.span === 'back')}
          </div>` : ''}
        ${section('Select tees', c.tees.map((t, i) => row('tee', i, t.name, teeInfo(t))).join(''))}
      </main>`;
  },

  manual() {
    const m = ui.manual;
    return `${bar('Enter scorecard', 'find')}
      <form class="stack" data-f="manual" id="manual">
        <label class="input">Course name<input name="name" required value="${esc(m.name)}" autocomplete="off"></label>
        <label class="input">Tees<input name="tee" placeholder="e.g. White" value="${esc(m.tee)}" autocomplete="off"></label>
        <div class="seg">
          ${segBtn('manN', 9, '9 holes', m.holes.length === 9)}
          ${segBtn('manN', 18, '18 holes', m.holes.length === 18)}
        </div>
        <table class="grid">
          <thead><tr><th>Hole</th><th>Par</th><th>Yards</th><th>HCP</th></tr></thead>
          <tbody>${m.holes.map((h, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><select name="par${i}">${[3, 4, 5, 6].map(p => `<option ${p === h.par ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
              <td><input name="yd${i}" type="number" inputmode="numeric" value="${h.yardage ?? ''}"></td>
              <td><input name="hcp${i}" type="number" inputmode="numeric" value="${h.hcp ?? ''}"></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <button class="btn primary big">Save course</button>
      </form>`;
  },

  hole() {
    const r = curRound(), i = ui.hole, h = r.holes[i];
    const last = i === r.holes.length - 1;
    const g = D.gir(h), g1 = D.gir1(h), tp = D.threePutt(h), p5 = D.par5Bogey(h);
    const girAuto = h.girOverride == null && g != null;
    return `
      <div class="sticky">
        <header class="top">
          <button class="icon" data-a="go" data-v="home" aria-label="Menu">☰</button>
          <div class="ttl"><strong>${esc(r.course)}</strong><small>${esc(playerName(r.playerId))} · ${thru(r)}</small></div>
          <button class="icon txt" data-a="go" data-v="round">Card</button>
        </header>
        <nav class="strip">${r.holes.map((x, j) =>
          `<button class="chip ${j === i ? 'cur' : ''} ${diffClass(x)}" data-a="hole" data-v="${j}">${x.n}</button>`).join('')}
        </nav>
      </div>
      <main class="hole">
        <div class="hole-head">
          <div class="num">Hole ${h.n}</div>
          <div class="meta"><span>Par ${h.par}</span>${h.yardage ? `<span>${h.yardage} yds</span>` : ''}${h.hcp ? `<span>HCP ${h.hcp}</span>` : ''}</div>
        </div>
        <div class="hole-sync">${syncBadge()}</div>

        ${stepper('Score', 'score', h.score, h.par, h.score != null ? scoreName(h.score, h.par) : 'tap number for par')}
        ${stepper('Putts', 'putts', h.putts, 2, h.putts == null ? 'tap number for 2' : '')}

        ${h.putts !== 0 ? `
        <div class="field col">
          <div class="lbl">First putt <small>feet</small></div>
          <div class="fp">
            <input type="number" inputmode="decimal" min="0" step="1" placeholder="ft" data-c="fp" value="${h.firstPutt ?? ''}">
            <div class="quick">${[3, 5, 8, 10, 15, 20, 30, 40, 60].map(d =>
              `<button class="mini ${h.firstPutt === d ? 'on' : ''}" data-a="fp" data-v="${d}">${d}</button>`).join('')}</div>
          </div>
        </div>` : ''}

        ${h.par >= 4 ? `
        <div class="field col">
          <div class="lbl">Fairway</div>
          <div class="seg three">
            ${segBtn('fw', 'left', '← Left', h.fairway === 'left', 'miss')}
            ${segBtn('fw', 'hit', 'Hit', h.fairway === 'hit', 'hit')}
            ${segBtn('fw', 'right', 'Right →', h.fairway === 'right', 'miss')}
          </div>
        </div>` : ''}

        <div class="field col">
          <div class="lbl">Green in regulation ${girAuto ? '<small>auto from score &amp; putts</small>' : ''}</div>
          <div class="seg">
            ${segBtn('gir', 'y', 'Hit', g === true, `hit ${girAuto ? 'auto' : ''}`)}
            ${segBtn('gir', 'n', 'Missed', g === false, `miss ${girAuto ? 'auto' : ''}`)}
          </div>
        </div>

        ${stepper('Penalties', 'pen', h.penalties, 0)}

        ${toggle('wedge', 'Bogey or worse with a wedge in hand', h.wedgeBogey, h.score != null && h.score <= h.par)}
        ${h.par === 3 ? toggle('short', 'Short-sided (par 3)', h.shortSide) : ''}

        <div class="autos">
          <span class="pill ${g1 ? 'good' : ''}">GIR+1: ${yn(g1)}</span>
          <span class="pill ${tp ? 'bad' : ''}">3-putt: ${yn(tp)}</span>
          ${h.par === 5 ? `<span class="pill ${p5 ? 'bad' : ''}">Par 5 bogey: ${yn(p5)}</span>` : ''}
        </div>
      </main>
      <footer class="nav">
        <button class="btn" data-a="prev" ${i === 0 ? 'disabled' : ''}>‹ Prev</button>
        ${last
          ? `<button class="btn primary" data-a="go" data-v="round">Scorecard ›</button>`
          : `<button class="btn primary" data-a="next">Hole ${r.holes[i + 1].n} ›</button>`}
      </footer>`;
  },

  round() {
    const r = curRound();
    const s = calc(r.holes);
    const mine = canEdit(r);
    return `${bar(r.course, mine && !r.done ? 'hole' : 'stats')}
      <main class="stack">
        <p class="muted"><b class="ink">${esc(playerName(r.playerId))}</b> · ${fmtDate(r.date)} · ${esc(r.tee)}${r.rating && r.slope ? ` · ${r.rating} / ${r.slope}` : ''}</p>
        ${scorecard(r, mine)}
        <h2>Round stats</h2>
        ${tiles(s, false)}
        ${!mine ? '' : r.done
          ? `<button class="btn" data-a="reopen">Edit round</button>`
          : `<button class="btn primary big" data-a="finish">Finish &amp; save round</button>`}
        ${mine ? '<button class="btn danger" data-a="del">Delete round</button>' : ''}
      </main>`;
  },

  stats() {
    const pid = statsPlayerId();
    const rounds = selectedRounds();
    const open = db.rounds.filter(r => !r.done && r.playerId === pid);
    const s = calc(rounds.flatMap(r => r.holes));
    return `${bar(pid === db.playerId ? 'My stats' : `${playerName(pid)}'s stats`, 'home')}
      ${playerChips()}
      <main class="stack">
        ${rounds.length ? `
          ${rangeSeg()}
          <p class="muted">${rounds.length} round${rounds.length === 1 ? '' : 's'} · ${s.holes} holes · tap a stat for its trend</p>
          ${tiles(s, true)}
          <h2>Round by round</h2>
          ${roundTable(rounds)}`
          : `<p class="muted">${pid === db.playerId ? 'Finish a round to see your stats here.' : 'No finished rounds yet.'}</p>`}
        ${open.length ? section('In progress', open.map(r => row('openRound', r.id, r.course, `${fmtDate(r.date)} · ${r.tee}`, thru(r))).join('')) : ''}
      </main>`;
  },

  trend() {
    const st = STATS.find(x => x.key === ui.stat);
    const pid = statsPlayerId();
    const rounds = selectedRounds();
    const pts = rounds.slice().reverse()
      .map(r => { const s = calc(r.holes); return { r, s, v: statRate(st, s) }; })
      .filter(p => p.v != null);
    const all = statRate(st, calc(rounds.flatMap(r => r.holes)));
    return `${bar(pid === db.playerId ? st.label : `${playerName(pid)} · ${st.label}`, 'stats')}
      <nav class="stat-strip">${STATS.map(x =>
        `<button class="mini ${x.key === st.key ? 'on cur' : ''}" data-a="trend" data-v="${x.key}">${x.short}</button>`).join('')}
      </nav>
      <main class="stack">
        ${rangeSeg()}
        <div class="hero">
          <span class="tl">Average${st.per18 ? ' per 18 holes' : ''} · ${pts.length} round${pts.length === 1 ? '' : 's'}</span>
          <strong>${all == null ? '–' : st.fmt(all)}</strong>
          ${trendNote(st, pts)}
        </div>
        ${pts.length >= 2 ? chart(st, pts) : '<p class="muted">Finish at least 2 rounds that record this stat to see a trend.</p>'}
        ${pts.length ? section('Each round', pts.slice().reverse().map(p =>
          row('openRound', p.r.id, p.r.course, [fmtDate(p.r.date), st.sub?.(p.s, false)].filter(Boolean).join(' · '), `<b>${roundVal(st, p.s)}</b>`)).join('')) : ''}
      </main>`;
  },

  board() {
    const label = ui.statsN === 'all' ? 'all their rounds' : `their last ${ui.statsN} rounds`;
    const rows = db.players.map(p => {
      const rs = selectedRounds(p.id);
      const s = calc(rs.flatMap(r => r.holes));
      const full = rs.map(r => calc(r.holes)).filter(x => x.holes === 18);
      return { p, n: rs.length, s, toPar: s.holes ? ((s.score - s.par) * 18) / s.holes : null, best: full.length ? Math.min(...full.map(x => x.score)) : null };
    }).filter(x => x.n).sort((a, b) => a.toPar - b.toPar);
    const feed = db.rounds.filter(r => r.done).slice(0, 15);
    return `${bar('Leaderboard', 'home')}
      <main class="stack">
        ${rangeSeg()}
        <p class="muted small">Ranked by average score to par per 18 holes over ${label}. Tap a player for their stats.</p>
        ${rows.length ? `<div class="list">${rows.map((x, i) => `
          <button class="row" data-a="playerStats" data-v="${x.p.id}">
            <span class="rank ${i === 0 ? 'first' : ''}">${i + 1}</span>
            <span class="row-main">
              <strong>${esc(x.p.name)}${x.p.id === db.playerId ? ' <span class="you">you</span>' : ''}</strong>
              <small>${x.n} round${x.n === 1 ? '' : 's'} · best ${x.best ?? '–'} · GIR ${pct(x.s.gir, x.s.girN)} · ${x.s.puttsN ? num((x.s.putts * 18) / x.s.puttsN) : '–'} putts</small>
            </span>
            <span class="row-right"><b>${toParStr(+x.toPar.toFixed(1))}</b></span>
          </button>`).join('')}</div>`
          : '<p class="muted">No finished rounds yet. Be the first!</p>'}
        ${feed.length ? section('Latest rounds', feed.map(r => {
          const s = calc(r.holes);
          return row('openRound', r.id, `${playerName(r.playerId)} · ${r.course}`, `${fmtDate(r.date)} · ${r.tee}${s.holes !== 18 ? ` · ${s.holes} holes` : ''}`,
            `<b>${s.score}</b>&nbsp;<small>(${toParStr(s.score - s.par)})</small>`);
        }).join('')) : ''}
      </main>`;
  },

  settings() {
    const pending = Object.keys(db.dirty).length + db.deletes.length;
    const last = db.lastSync ? new Date(db.lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
    return `${bar('Settings', 'home')}
      <main class="stack">
        ${section('Profile', `
          <div class="row static"><span class="row-main"><strong>${esc(me().name)}</strong><small>Logging scores on this phone</small></span></div>
          ${row('switchPlayer', '', 'Switch player', 'Change who is logging, or add a new player')}
          ${row('forgetPin', '', 'Lock my profile on this phone', 'Ask for my PIN next time')}
        `)}
        ${section('Sync', `
          <div class="row static"><span class="row-main"><strong>${syncBadge()}</strong><small>Last synced ${last}${pending ? ` · ${pending} change${pending === 1 ? '' : 's'} waiting` : ''}</small></span></div>
          ${row('syncNow', '', 'Sync now', 'Rounds save on your phone first and upload when you have signal', '⟳')}
        `)}
        ${section('Data', row('exportCsv', '', 'Export CSV', "Everyone's rounds, one row per hole", '↓'))}
        <button class="btn danger" data-a="logout">Log out of Break80 on this phone</button>
      </main>`;
  },
};

const statsPlayerId = () => ui.statsPlayer || db.playerId;

// Toggle between players' stats
function playerChips() {
  const pid = statsPlayerId();
  const withRounds = db.players.filter(p => p.id === db.playerId || db.rounds.some(r => r.done && r.playerId === p.id));
  if (withRounds.length < 2) return '';
  return `<nav class="stat-strip">${withRounds.map(p =>
    `<button class="mini ${p.id === pid ? 'on cur' : ''}" data-a="statsPlayer" data-v="${p.id}">${esc(p.id === db.playerId ? 'Me' : p.name)}</button>`).join('')}</nav>`;
}

/* ------------------------------------------------------------------ *
 * Rendering & navigation
 * ------------------------------------------------------------------ */

function render() {
  chartState = null;
  let view = ui.view;
  if (!db.password) view = 'gate';
  else if (!me() || view === 'who') view = 'who';
  // A round can vanish (deleted on another phone), and other players' rounds are read-only
  else if ((view === 'hole' || view === 'round') && !curRound()) view = ui.view = 'home';
  else if (view === 'hole' && !canEdit(curRound())) view = ui.view = 'round';
  $app.innerHTML = views[view]();
  $app.querySelector('[autofocus]')?.focus();
  $app.querySelector('.strip .cur, .stat-strip .cur')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function go(view, extra = {}) {
  Object.assign(ui, extra, { view });
  render();
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function editHole(fn) {
  const r = curRound();
  if (!canEdit(r)) return;
  fn(r.holes[ui.hole]);
  touch(r);
  render();
}

// −1 / +1 steps from the current (or default) value; 0 confirms the default
const step = (field, dflt, min, after) => v => editHole(h => {
  v = +v;
  const cur = h[field] ?? (typeof dflt === 'function' ? dflt(h) : dflt);
  h[field] = Math.max(min, v === 0 ? cur : cur + v);
  after?.(h);
});

function readManual() {
  const form = document.getElementById('manual');
  if (!form) return;
  const fd = new FormData(form);
  const n = v => (v === '' || v == null ? null : +v);
  ui.manual.name = fd.get('name');
  ui.manual.tee = fd.get('tee');
  ui.manual.holes = ui.manual.holes.map((h, i) => ({ par: +fd.get('par' + i), yardage: n(fd.get('yd' + i)), hcp: n(fd.get('hcp' + i)) }));
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function toCsv() {
  const cols = ['player', 'date', 'course', 'tee', 'hole', 'par', 'yards', 'hcp', 'score', 'to_par', 'putts', 'first_putt_ft', 'fairway',
    'gir', 'gir_plus_1', 'three_putt', 'penalties', 'wedge_bogey', 'par5_bogey', 'par3_short_side'];
  const b = v => (v == null ? '' : v ? 1 : 0);
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const rows = db.rounds.flatMap(r => r.holes.filter(h => h.score != null).map(h => [
    playerName(r.playerId), r.date.slice(0, 10), r.course, r.tee, h.n, h.par, h.yardage, h.hcp, h.score, h.score - h.par, h.putts, h.firstPutt,
    h.par >= 4 ? h.fairway : '', b(D.gir(h)), b(D.gir1(h)), b(D.threePutt(h)), h.penalties, b(h.wedgeBogey),
    h.par === 5 ? b(D.par5Bogey(h)) : '', h.par === 3 ? b(h.shortSide) : '',
  ]));
  return [cols, ...rows].map(r => r.map(q).join(',')).join('\n');
}

const actions = {
  go: v => go(v),
  newRound: () => {
    ui.find = { ...ui.find, error: '', results: null, query: '' };
    go('find');
    if (!ui.find.nearby) locate();
  },
  resume: () => {
    const r = activeRound();
    const next = r.holes.findIndex(h => h.score == null);
    go('hole', { roundId: r.id, hole: next < 0 ? r.holes.length - 1 : next });
  },
  locate,
  pickNearby: i => doSearch(ui.find.nearby[i].name, ui.find.nearby[i]),
  pickResult: i => go('tees', { course: ui.find.results[i], span: 'all' }),
  pickSaved: id => go('tees', { course: db.courses.find(c => c.id === id), span: 'all' }),
  span: v => { ui.span = v; render(); },
  tee: i => startRound(ui.course, +i),

  manual: () => {
    const name = ui.find.query || '';
    go('manual', { manual: { name, tee: '', holes: Array.from({ length: 18 }, () => ({ par: 4, yardage: null, hcp: null })) } });
  },
  manN: v => {
    readManual();
    const hs = ui.manual.holes;
    ui.manual.holes = +v === 9 ? hs.slice(0, 9) : [...hs, ...Array.from({ length: 18 - hs.length }, () => ({ par: 4, yardage: null, hcp: null }))];
    render();
  },

  // Hole entry
  score: step('score', h => h.par, 1, h => { if (h.score <= h.par) h.wedgeBogey = false; }),
  putts: step('putts', 2, 0, h => { if (h.putts === 0) h.firstPutt = null; }),
  pen: step('penalties', 0, 0),
  fp: v => editHole(h => { h.firstPutt = h.firstPutt === +v ? null : +v; }),
  fw: v => editHole(h => { h.fairway = h.fairway === v ? null : v; }),
  gir: v => editHole(h => {
    const val = v === 'y';
    // Tapping the active manual choice again hands control back to auto
    h.girOverride = h.girOverride === val ? null : val;
  }),
  wedge: () => editHole(h => { h.wedgeBogey = !h.wedgeBogey; }),
  short: () => editHole(h => { h.shortSide = !h.shortSide; }),
  hole: i => go('hole', { hole: +i }),
  prev: () => go('hole', { hole: Math.max(0, ui.hole - 1) }),
  next: () => go('hole', { hole: Math.min(curRound().holes.length - 1, ui.hole + 1) }),

  // Rounds
  finish: () => {
    const r = curRound();
    const missing = r.holes.filter(h => h.score == null).length;
    if (missing && !confirm(`${missing} hole${missing === 1 ? ' has' : 's have'} no score. Finish anyway?`)) return;
    finishRound(r);
    go('stats', { statsPlayer: null });
  },
  reopen: () => {
    const r = curRound();
    if (!canEdit(r)) return;
    const active = activeRound();
    if (active && active !== r) finishRound(active);
    r.done = false;
    db.active[db.playerId] = r.id;
    touch(r);
    go('hole', { hole: 0 });
  },
  del: () => {
    const r = curRound();
    if (!canEdit(r) || !confirm('Delete this round? This cannot be undone.')) return;
    deleteRound(r);
    go('stats');
  },
  openRound: id => go('round', { roundId: id, statsPlayer: db.rounds.find(r => r.id === id)?.playerId }),
  trend: key => go('trend', { stat: key }),
  statsN: v => { ui.statsN = v === 'all' ? 'all' : +v; render(); },
  myStats: () => go('stats', { statsPlayer: null }),
  statsPlayer: id => { ui.statsPlayer = id; render(); },
  playerStats: id => go('stats', { statsPlayer: id }),

  // Players
  switchPlayer: () => go('who', { who: { mode: 'list', error: '', busy: false } }),
  whoList: () => { ui.who = { mode: 'list', error: '', busy: false }; render(); },
  whoNew: () => { ui.who = { mode: 'new', error: '', busy: false }; render(); },
  pickPlayer: id => {
    // Already unlocked on this phone: switch straight away (works offline too)
    if (db.pins[id]) return becomePlayer(id);
    ui.who = { mode: 'pin', playerId: id, error: '', busy: false };
    render();
  },
  forgetPin: () => {
    if (!confirm('Lock your profile on this phone? You will need your PIN to log scores here again.')) return;
    delete db.pins[db.playerId];
    db.playerId = null;
    save();
    go('who', { who: { mode: 'list', error: '', busy: false } });
  },
  logout: () => {
    const pending = Object.keys(db.dirty).length + db.deletes.length;
    const warn = pending ? `\n\n${pending} change${pending === 1 ? " hasn't" : "s haven't"} synced yet and will be lost.` : '';
    if (!confirm(`Log out of Break80 on this phone?${warn}`)) return;
    db = defaults();
    save();
    go('home');
  },

  // Data
  syncNow: () => sync(),
  exportCsv: () => download(`break80-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(), 'text/csv'),
};

function becomePlayer(id) {
  db.playerId = id;
  save();
  go('home', { statsPlayer: null, who: { mode: 'list', error: '', busy: false } });
  offerLegacyImport();
  queueSync(0);
}

// Run a server form step with busy/error state on ui[key].
// Every redraw puts back what was typed, so a typo only needs fixing, not retyping.
async function serverStep(key, fn) {
  const st = ui[key];
  if (st.busy) return;
  const typed = [...$app.querySelectorAll('input[name]')].map(el => [el.name, el.value]);
  const redraw = () => {
    render();
    for (const [name, value] of typed) { const el = $app.querySelector(`input[name="${name}"]`); if (el) el.value = value; }
  };
  Object.assign(st, { busy: true, error: '' });
  redraw();
  try {
    await fn();
  } catch (e) {
    st.error = errMsg(e);
  }
  st.busy = false;
  if (st.error) redraw(); else render();
}

const forms = {
  search: () => doSearch(document.getElementById('q').value),
  gate: form => serverStep('gate', async () => {
    const pw = new FormData(form).get('pw');
    const data = await rpc('b80_login', { pw });
    Object.assign(db, { password: pw, golfApiKey: data.golfApiKey || '', players: data.players });
    save();
    ui.who = { mode: 'list', error: '', busy: false };
    sync();
  }),
  pin: form => serverStep('who', async () => {
    const pin = new FormData(form).get('pin');
    await rpc('b80_verify_pin', { pw: db.password, p_player: ui.who.playerId, p_pin: pin });
    db.pins[ui.who.playerId] = pin;
    becomePlayer(ui.who.playerId);
  }),
  newPlayer: form => serverStep('who', async () => {
    const fd = new FormData(form);
    const name = fd.get('name').trim(), pin = fd.get('pin');
    if (!/^\d{4}$/.test(pin)) throw new Error('bad_pin_format');
    if (pin !== fd.get('pin2')) throw new Error("PINs don't match.");
    const p = await rpc('b80_create_player', { pw: db.password, p_name: name, p_pin: pin });
    db.players = [...db.players, p].sort((a, b) => a.name.localeCompare(b.name));
    db.pins[p.id] = pin;
    becomePlayer(p.id);
  }),
  manual: () => {
    readManual();
    const m = ui.manual;
    const id = 'man-' + slug(m.name);
    const tee = { name: m.tee.trim() || 'Tees', holes: m.holes };
    const existing = db.courses.find(c => c.id === id);
    const course = existing
      ? { ...existing, tees: [...existing.tees.filter(t => t.name !== tee.name), tee] }
      : { id, name: m.name.trim(), city: '', lat: ui.find.pos?.lat ?? null, lon: ui.find.pos?.lon ?? null, tees: [tee] };
    upsertCourse(course);
    save();
    queueSync();
    go('tees', { course, span: 'all' });
  },
};

const changes = {
  // Typing a first-putt distance: update in place (no re-render) so a tap on Next isn't swallowed
  fp: el => {
    const h = curHole();
    h.firstPutt = el.value === '' ? null : Math.max(0, +el.value);
    touch(curRound());
    $app.querySelectorAll('[data-a="fp"]').forEach(b => b.classList.toggle('on', +b.dataset.v === h.firstPutt));
  },
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  e.preventDefault();
  actions[b.dataset.a]?.(b.dataset.v);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  forms[e.target.dataset.f]?.(e.target);
});
document.addEventListener('change', e => changes[e.target.dataset.c]?.(e.target));

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Keep in step with everyone else: on open, when signal returns, when the app comes back to the foreground
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 120000);

render();
sync();
