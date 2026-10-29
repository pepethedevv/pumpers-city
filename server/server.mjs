// Pumpers City game server
// One Node process: players see each other, and everything that matters is decided here:
// who may open boxes (signed wallet login + holdings), where boxes are, lock timing, XP, prizes.
// Each district is split into channels of CHANNEL_CAP players. Positions are only sent to players nearby.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { decide, verifySigned, holdings, addr, dbReady, db } from "./lib.mjs";
import { getMap, SOLID, MAP_NAMES, T } from "./mapgen.mjs";

const env = process.env;
const PORT = +env.PORT || 8080;
const CAP = +env.CHANNEL_CAP || 100;
const MAX_PLAYERS = +env.MAX_PLAYERS || 600;
const SITES = (env.ALLOWED_SITES || "pumperscity.com").split(",").map(s => s.trim().replace(/^www\./, "")).filter(Boolean);
const DEV = env.DEV_OPEN === "1";            // local testing only: guests pick a level and may open boxes
const SECRET = env.SERVER_SECRET || (env.SUPABASE_SERVICE_KEY ? crypto.createHash("sha256").update("pc-session:" + env.SUPABASE_SERVICE_KEY).digest("hex") : crypto.randomBytes(32).toString("hex"));
const BOXES_PER_ROOM = +env.BOXES_PER_ROOM || 120, RESPAWN_MS = 30_000, JAM_MS = 2000;
const OPENS_PER_HOUR = +env.OPENS_PER_HOUR || 150;
const TICK_MS = 100, VIEW_X = 900, VIEW_Y = 620;
const TIERS = {
  none: { speed: 1.00, xp: 1.0 }, common: { speed: 1.05, xp: 1.2 }, rare: { speed: 1.10, xp: 1.4 },
  epic: { speed: 1.15, xp: 1.6 }, legendary: { speed: 1.22, xp: 1.8 }, oneofone: { speed: 1.30, xp: 2.0 },
};
const ONES = ["Trencher", "Diamond", "Lava", "Ghost", "Glitch", "Robot", "Zombie", "Ice", "The Mayor", "Shadow"];
const MAPKEYS = Object.keys(MAP_NAMES);
const short = w => w.slice(0, 4) + "…" + w.slice(-4);
// player names: 3-16 letters, numbers or _, unique (case-insensitive), nothing that looks official
const RESERVED = /admin|support|official|pumperscity|moderator|^mod$|^dev$|^team$|^guest$|^you$/i;
function checkName(n) {
  n = String(n || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) return { err: "Use 3-16 letters, numbers or _" };
  if (RESERVED.test(n)) return { err: "That name isn't allowed" };
  return { name: n };
}
// is this name used by someone else (online now, or a wallet that saved it before)?
async function nameTaken(name, wallet) {
  const k = name.toLowerCase();
  for (const o of players.values()) if (o.nick && o.nick.toLowerCase() === k && (!wallet || o.wallet !== wallet)) return true;
  for (const [w, s] of known) if (w !== wallet && s.name && s.name.toLowerCase() === k) return true;
  if (dbReady()) try { const r = await db(`players?name_key=eq.${encodeURIComponent(k)}${wallet ? "&wallet=neq." + wallet : ""}&select=wallet&limit=1`); if (r.length) return true; } catch (e) { log("name check:", e.message); }
  return false;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- maps (same generator as the browser, so walls and boxes line up exactly) ----------------
for (const k of MAPKEYS) getMap(k);
const solidAt = (m, px, py) => { const t = m.g[Math.floor(py / T)]?.[Math.floor(px / T)]; return t === undefined || SOLID.has(t); };
const blocked = (m, x, y) => solidAt(m, x - 5, y - 3) || solidAt(m, x + 5, y - 3) || solidAt(m, x - 5, y + 1) || solidAt(m, x + 5, y + 1);
// positions arrive rounded to whole pixels, so movement is checked with a box half a pixel smaller
const blockedMove = (m, x, y) => solidAt(m, x - 4.5, y - 2.5) || solidAt(m, x + 4.5, y - 2.5) || solidAt(m, x - 4.5, y + 0.5) || solidAt(m, x + 4.5, y + 0.5);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function randomWalkable(m) {
  for (let k = 0; k < 200; k++) {
    const i = m.spots[Math.floor(Math.random() * m.spots.length)], tx = i % m.W, ty = (i - tx) / m.W, x = tx * T + 8, y = ty * T + 8;
    if (!blocked(m, x, y)) return { x, y };
  }
  return { x: m.spawn.x * T + 8, y: m.spawn.y * T + 8 };
}
// where you appear after coming through a black hole (identical to the browser's nearFree)
function arrival(m, fromKey) {
  const back = fromKey && m.portals.find(p => p.to === fromKey);
  if (back) for (let rad = 3; rad < 9; rad++) for (const [dx, dy] of [[0, rad], [rad, 0], [-rad, 0], [0, -rad], [rad, rad], [-rad, rad]]) {
    const x = back.x + dx, y = back.y + dy;
    if (x >= 0 && y >= 0 && x < m.W && y < m.H && m.reach[y * m.W + x] && !SOLID.has(m.g[y][x])) { const X = x * T + 8, Y = y * T + 8; if (!blocked(m, X, Y)) return { x: X, y: Y }; }
  }
  return { x: m.spawn.x * T + 8, y: m.spawn.y * T + 8 };
}
// players entering a district start a few steps apart instead of on top of each other
function spawnSpot(m) {
  const c = { x: m.spawn.x * T + 8, y: m.spawn.y * T + 8 };
  for (let k = 0; k < 40; k++) {
    const x = c.x + Math.round((Math.random() - 0.5) * 120), y = c.y + Math.round((Math.random() - 0.5) * 80);
    const tx = Math.floor(x / T), ty = Math.floor(y / T);
    if (tx >= 0 && ty >= 0 && tx < m.W && ty < m.H && m.reach[ty * m.W + tx] && !blocked(m, x, y) && m.portals.every(P => Math.hypot(x - (P.x * T + 8), y - (P.y * T + 8)) > 30)) return { x, y };
  }
  return c;
}
function rollXp() {
  const r = Math.random(), n = k => Math.floor(Math.random() * k);
  if (r < 0.55) return 5 + n(5); if (r < 0.85) return 10 + n(5); if (r < 0.96) return 15 + n(5); return 20 + n(6);
}
// the lock needle bounces 0 → 1 → 0 at `speed` bar-widths per second
const needle = (speed, ms) => { const u = (speed * ms / 1000) % 2; return u <= 1 ? u : 2 - u; };

// ---------------- settings (one row in Supabase, edited in the table editor) ----------------
let settings = { boxes_open: true, prize_amount: 0, prizes_active: 5, prizes_left: 0, wave: 1, max_wins_per_wallet: 1, daily_top: [10000, 5000, 2500] };
// the daily leaderboard runs from 19:00 to 19:00 UTC (22:00 Turkey time). A "day" is named after the
// date it starts on, so the race that starts at 19:00 UTC on Oct 28 is "2026-10-28".
const RESET_HOUR = env.RESET_HOUR_UTC !== undefined ? +env.RESET_HOUR_UTC : 19;
const dayOf = ms => new Date(ms - RESET_HOUR * 3600_000).toISOString().slice(0, 10);
const today = () => dayOf(Date.now());
let curDay = today();
let stats = { won: 0, sent: 0, wins: 0, recent: [] };
async function loadSettings() {
  if (!dbReady()) return;
  try { const [s] = await db("game_settings?id=eq.1&select=*"); if (s) settings = s; } catch (e) { log("settings:", e.message); }
  refillPrizes();
}
async function loadStats() {
  if (!dbReady()) return;
  try {
    const [s] = await db("prize_stats?select=*");
    const recent = await db("prizes?select=wallet,amount,district,status,signature,created_at&order=created_at.desc&limit=30");
    // show the winners' player names (from memory, else from the players table)
    const need = [...new Set(recent.map(r => r.wallet))].filter(w => !known.get(w)?.name);
    const names = new Map();
    if (need.length) for (const row of await db(`players?wallet=in.(${need.join(",")})&select=wallet,name,name_key`)) if (row.name_key) names.set(row.wallet, row.name);
    stats = { won: +s?.won || 0, sent: +s?.sent || 0, wins: +s?.wins || 0,
      recent: recent.map(r => ({ who: known.get(r.wallet)?.name || names.get(r.wallet) || short(r.wallet), amount: +r.amount, district: r.district,
        status: r.status, sig: r.status === "sent" ? r.signature : null, at: r.created_at })) };
  } catch (e) { log("stats:", e.message); }
}

// ---------------- rooms: one per district channel ----------------
const rooms = new Map();   // "downtown#1" → room
const players = new Map(); // id → player
const byWallet = new Map();
const known = new Map();   // wallet → { xp, opened, found, dirty }
let nextId = 1, nextBox = 1;
const prizeBoxes = new Set(); // box ids holding a prize right now; only the server knows them
let takesInFlight = 0;
let batch = 0; // prizes of the current batch still hidden; the next batch only starts once all of these are found

function roomFor(mapKey) {
  for (let ch = 1; ; ch++) {
    const key = mapKey + "#" + ch;
    let r = rooms.get(key);
    if (!r) { r = { key, map: mapKey, ch, m: getMap(mapKey), players: new Set(), boxes: new Map(), timers: new Set(), empty: 0 }; rooms.set(key, r); for (let i = 0; i < BOXES_PER_ROOM; i++) spawnBox(r, false); refillPrizes(); }
    if (r.players.size < CAP) return r;
  }
}
function spawnBox(r, announce = true) {
  let p;
  for (let k = 0; k < 60; k++) {
    p = randomWalkable(r.m);
    if (r.m.portals.every(P => Math.hypot(p.x - (P.x * T + 8), p.y - (P.y * T + 8)) > 64) && [...r.boxes.values()].every(b => dist(p, b) > 160)) break;
  }
  const b = { id: nextBox++, x: p.x, y: p.y };
  r.boxes.set(b.id, b);
  if (announce) roomSend(r, { t: "b", id: b.id, x: b.x, y: b.y });
  return b;
}
function dropRoom(r) {
  for (const id of r.boxes.keys()) prizeBoxes.delete(id);
  for (const t of r.timers) clearTimeout(t);
  rooms.delete(r.key);
  refillPrizes();
}
// Prizes go out in batches: `prizes_active` are hidden at once, and only when every one of them has been
// found does the next batch (up to what is left of `prizes_left`) get hidden somewhere in the city.
function refillPrizes() {
  const max = settings.boxes_open && dbReady() ? Math.max(0, settings.prizes_left - takesInFlight) : 0;
  if (batch > max) batch = max;
  if (batch === 0 && takesInFlight === 0 && max > 0) { batch = Math.min(settings.prizes_active, max); log("new prize batch:", batch); }
  const want = batch;
  const live = [];
  for (const r of rooms.values()) for (const id of r.boxes.keys()) live.push(id);
  for (const id of [...prizeBoxes]) if (!live.includes(id)) prizeBoxes.delete(id);
  while (prizeBoxes.size > want) prizeBoxes.delete(prizeBoxes.values().next().value);
  const free = live.filter(id => !prizeBoxes.has(id));
  while (prizeBoxes.size < want && free.length) prizeBoxes.add(free.splice(Math.floor(Math.random() * free.length), 1)[0]);
}

// ---------------- messaging ----------------
const send = (p, msg) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); };
const roomSend = (r, msg, except) => { const s = JSON.stringify(msg); for (const p of r.players) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
const allSend = msg => { const s = JSON.stringify(msg); for (const p of players.values()) if (p.room && p.ws.readyState === 1) p.ws.send(s); };
// name colour: gold = 20M+ tokens or a 1/1, silver = 10M+ or Legendary, bronze = 5M+ or Epic (same as the level)
const BADGE = { oneofone: "gold", legendary: "silver", epic: "bronze" };
const badge = p => BADGE[p.acc.level] || null;
const pub = p => ({ id: p.id, name: p.name, b: badge(p), skin: p.skin, trail: p.trail, x: Math.round(p.x), y: Math.round(p.y), f: p.f ? 1 : 0 });

function joinRoom(p, mapKey, at) {
  if (p.room) leaveRoom(p);
  const r = roomFor(mapKey);
  r.players.add(p); r.empty = 0;
  p.room = r; p.x = at.x; p.y = at.y; p.budget = 40; p.mt = Date.now(); p.seen = new Map(); p.lock = null; p.jam = new Map();
  roomSend(r, { t: "j", p: pub(p) }, p);
  const others = [...r.players].filter(o => o !== p).map(pub);
  for (const o of r.players) if (o !== p) p.seen.set(o.id, o.x + "," + o.y + "," + o.f);
  const sp = surprise[mapKey];
  send(p, { t: "room", map: mapKey, ch: r.ch, you: p.id, x: p.x, y: p.y, players: others, boxes: [...r.boxes.values()], sp: sp.alive ? { x: Math.round(sp.x), y: Math.round(sp.y) } : null });
}
function leaveRoom(p) {
  const r = p.room; if (!r) return;
  if (p.lock?.id === SURPRISE_ID) releaseSurprise(p);
  r.players.delete(p); p.room = null; p.lock = null;
  roomSend(r, { t: "l", id: p.id });
  for (const o of r.players) o.seen.delete(p.id);
  if (!r.players.size) r.empty = Date.now();
}

// ---------------- login ----------------
function token(wallet) { const exp = Date.now() + 12 * 3600_000, body = wallet + "." + exp; return body + "." + crypto.createHmac("sha256", SECRET).update(body).digest("hex").slice(0, 32); }
function checkToken(tok) {
  const [wallet, exp, mac] = String(tok || "").split(".");
  if (!wallet || !mac || +exp < Date.now()) return null;
  const want = crypto.createHmac("sha256", SECRET).update(wallet + "." + exp).digest("hex").slice(0, 32);
  return mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want)) ? wallet : null;
}
const usedSigs = new Map(); // signature → forget after
setInterval(() => { const now = Date.now(); for (const [k, t] of usedSigs) if (t < now) usedSigs.delete(k); }, 60_000);
const holdCache = new Map(); // wallet → { at, h }
async function getHoldings(wallet, fresh) {
  const c = holdCache.get(wallet);
  if (c && !fresh && Date.now() - c.at < 60_000) return c.h;
  const h = await holdings(wallet);
  holdCache.set(wallet, { at: Date.now(), h });
  return h;
}
// level, box access and allowed looks for a wallet
async function access(p, fresh) {
  if (!p.wallet || (!addr("PUMPERS_MINT") && !addr("NFT_COLLECTION")) || !env.HELIUS_API_KEY) { p.nfts = []; p.acc = { canOpen: false, level: "none", trail: false }; return; }
  const { tokens, nfts } = await getHoldings(p.wallet, fresh);
  p.nfts = nfts; p.acc = decide(tokens, nfts);
}
// skin = { n: atlas number } | { o: 1/1 name } | null (default look). Only Pumpers the wallet owns are accepted.
function applyLook(p, skin) {
  let s = null;
  if (skin && DEV) s = skin.o && ONES.includes(skin.o) ? { o: skin.o } : skin.n ? { n: Math.max(1, Math.min(3333, skin.n | 0)) } : null;
  else if (skin?.o) s = p.nfts.some(n => n.oneofone === skin.o) ? { o: skin.o } : null;
  else if (skin?.n) s = p.nfts.some(n => !n.oneofone && n.number === (skin.n | 0)) ? { n: skin.n | 0 } : null;
  p.skin = s;
  p.trail = s?.o || (p.acc.trail ? "whale" : null);
  if (DEV && p.dev?.trail !== undefined && !s?.o) p.trail = p.dev.trail;
  const nft = s && p.nfts.find(n => (s.o ? n.oneofone === s.o : n.number === s.n));
  p.name = p.nick || (p.wallet ? (nft ? (s.o || "#" + nft.number) : short(p.wallet)) : (DEV && p.dev?.name ? String(p.dev.name).slice(0, 16) : "Guest"));
}
async function hello(p, msg) {
  let wallet = null, err = null;
  if (msg.token) { wallet = checkToken(msg.token); err = wallet ? null : "session expired"; }
  else if (msg.wallet) {
    const lines = String(msg.message || "").split("\n"), site = (lines.find(l => l.startsWith("Site: ")) || "").slice(6).replace(/^www\./, "");
    err = verifySigned("login", msg.wallet, msg.message, msg.signature, null) || (!DEV && !SITES.includes(site) ? "wrong site" : null)
      || (usedSigs.has(msg.signature) ? "login already used" : null);
    if (!err) { wallet = msg.wallet; usedSigs.set(msg.signature, Date.now() + 11 * 60_000); } // a login signature works once (it expires after 10 min anyway)
  }
  if (wallet) {
    const old = byWallet.get(wallet);
    if (old && old !== p) { send(old, { t: "bye", msg: "You opened Pumpers City somewhere else." }); old.ws.close(4001); }
    byWallet.set(wallet, p);
    p.wallet = wallet;
    // XP lives in memory while the server runs (saved to Supabase every 15 s), so a quick reconnect never loses any
    if (!known.has(wallet)) {
      const s = { xp: 0, opened: 0, found: 0, day: curDay, dayXp: 0, dirty: false };
      if (dbReady()) try { const [row] = await db(`players?wallet=eq.${wallet}&select=xp,opened,found,day,day_xp,name,name_key`); if (row) Object.assign(s, { xp: +row.xp, opened: +row.opened, found: +row.found, dayXp: row.day === curDay ? +row.day_xp : 0, name: row.name_key ? row.name : null }); } catch (e) { log("load player:", e.message); }
      if (!known.has(wallet)) known.set(wallet, s);
    }
    p.s = known.get(wallet);
  }
  if (DEV && msg.dev) p.dev = msg.dev;
  // the name the player picked; if someone grabbed it a moment ago, add a number
  const cn = checkName(msg.nick);
  if (cn.name) {
    let n = cn.name;
    for (let k = 0; k < 20 && await nameTaken(n, wallet); k++) n = cn.name.slice(0, 13) + Math.floor(10 + Math.random() * 990);
    p.nick = n;
    if (wallet && p.s.name !== n) { p.s.name = n; p.s.dirty = true; }
  } else if (wallet && p.s.name) p.nick = p.s.name;
  try { await access(p); } catch (e) { log("holdings:", e.message); p.nfts = []; p.acc = { canOpen: false, level: "none", trail: false }; err = err || "holdings check failed"; }
  if (DEV && p.dev) p.acc = { canOpen: !!p.dev.canOpen, level: TIERS[p.dev.tier] ? p.dev.tier : "none", trail: false };
  applyLook(p, msg.skin);
  p.ready = true;
  send(p, { t: "hi", id: p.id, token: wallet ? token(wallet) : null, wallet, err, name: p.name, level: p.acc.level, canOpen: p.acc.canOpen,
    resetHour: RESET_HOUR, inUse: inUseList(), b: badge(p), chat: chatLog.slice(-30), xp: p.s.xp, dayXp: p.s.day === curDay ? p.s.dayXp || 0 : 0, opened: p.s.opened, found: p.s.found, online: players.size, boxesOpen: settings.boxes_open,
    wins: stats.recent.filter(w => Date.now() - Date.parse(w.at) < 300_000).slice(0, 3) });
  sendBoard(p);
}

// ---------------- boxes ----------------
async function openBox(p, id) {
  if (id === SURPRISE_ID) return openSurprise(p);
  const r = p.room, b = r?.boxes.get(id), now = Date.now();
  const no = (msg, extra) => send(p, { t: "D", id, msg, ...extra });
  if (!b) return no("Too late, that box is gone.");
  if (!p.acc.canOpen) return no("Hold $PUMPERS to open boxes");
  if (!settings.boxes_open) return no("Boxes open at launch");
  if (dist(p, b) > 34) return no("Walk up to the box first");
  if ((p.jam.get(id) || 0) > now) return no("Lock jammed. Wait a moment");
  p.opens = p.opens.filter(t => now - t < 3600_000);
  if (p.opens.length >= OPENS_PER_HOUR) return no("You've opened a lot of boxes. Take a short break");
  const w = 0.3, a = 0.1 + Math.random() * (0.8 - w);
  p.lock = { id, zone: [a, a + w], speed: 0.5 + Math.random() * 0.15, t0: now };
  send(p, { t: "L", id, zone: p.lock.zone, speed: p.lock.speed });
}
async function hitLock(p, id, e) {
  const L = p.lock, r = p.room, now = Date.now();
  if (!L || L.id !== id || !r) return;
  p.lock = null;
  const E = now - L.t0;
  e = +e;
  // the client says when it pressed, counted from when the lock reached it. It can't be later than what the
  // server saw (no peeking into the future); slow phones may be a little behind, so earlier is allowed.
  const plausible = Number.isFinite(e) && e >= 150 && e <= E + 60 && e >= E - (p.rtt || 200) - 3000;
  const pos = needle(L.speed, e);
  if (env.DEBUG) log("hit", { e, E, rtt: p.rtt, pos, zone: L.zone });
  if (!plausible || pos < L.zone[0] - 0.03 || pos > L.zone[1] + 0.03) { p.jam.set(id, now + JAM_MS); if (id === SURPRISE_ID) releaseSurprise(p); return send(p, { t: "X", id }); }
  if (id === SURPRISE_ID) return catchSurprise(p);
  const b = r.boxes.get(id);
  if (!b) return send(p, { t: "D", id, msg: "Someone else got that one." });
  if (dist(p, b) > 40) return send(p, { t: "D", id, msg: "You moved away from the box." });
  // the box is yours: it disappears for everyone, XP is added, and the server alone knows if it held a prize
  r.boxes.delete(id);
  const isPrize = prizeBoxes.delete(id);
  if (isPrize) batch--;
  p.opens.push(now);
  const xp = Math.round(rollXp() * TIERS[p.acc.level].xp);
  if (p.s.day !== curDay) { p.s.day = curDay; p.s.dayXp = 0; }
  p.s.xp += xp; p.s.dayXp = (p.s.dayXp || 0) + xp; p.s.opened++; p.s.dirty = p.wallet ? true : false;
  roomSend(r, { t: "g", id, by: p.id }, p);
  const t = setTimeout(() => { r.timers.delete(t); if (rooms.get(r.key) === r) { spawnBox(r); refillPrizes(); } }, RESPAWN_MS);
  r.timers.add(t);
  let prize = 0;
  if (isPrize && p.wallet && dbReady()) {
    takesInFlight++;
    try { prize = +(await db("rpc/take_prize", { method: "POST", body: { p_wallet: p.wallet, p_district: MAP_NAMES[r.map] } })) || 0; }
    catch (e2) { log("take_prize:", e2.message); }
    takesInFlight--;
    if (!prize) batch++; // not taken (this wallet already won this wave, etc.): it goes into another box
    if (prize) { settings.prizes_left = Math.max(0, settings.prizes_left - 1); p.s.found += prize; stats.won += prize; stats.wins++; }
  } else if (isPrize) batch++;
  refillPrizes();
  send(p, { t: "O", id, xp, total: p.s.xp, dayXp: p.s.dayXp, opened: p.s.opened, found: p.s.found, prize });
  if (prize) {
    log("PRIZE", short(p.wallet), prize, MAP_NAMES[r.map], "· still hidden in this batch:", batch);
    const w = { who: p.name, wallet: p.wallet, amount: prize, district: MAP_NAMES[r.map], at: new Date().toISOString() };
    stats.recent.unshift({ who: p.name, amount: prize, district: w.district, status: "ready", sig: null, at: w.at }); stats.recent.length = Math.min(stats.recent.length, 30);
    allSend({ t: "W", ...w });
  }
}

// ---------------- XP saving and leaderboard ----------------
let board = [];
async function saveXp() {
  if (!dbReady()) return true;
  const rows = [];
  for (const [wallet, s] of known) if (s.dirty) { rows.push({ wallet, name: s.name || short(wallet), name_key: s.name ? s.name.toLowerCase() : null, xp: s.xp, opened: s.opened, found: s.found, day: s.day, day_xp: s.dayXp || 0, updated_at: new Date().toISOString() }); s.dirty = false; }
  if (!rows.length) return true;
  try { await db("players?on_conflict=wallet", { method: "POST", body: rows, prefer: "resolution=merge-duplicates" }); return true; }
  catch (e) { log("save xp:", e.message); for (const r of rows) known.get(r.wallet).dirty = true; return false; }
}
async function loadBoard() {
  let rows = [];
  // today's XP only: the board starts from zero every day at the reset hour
  if (dbReady()) try { rows = await db(`players?day=eq.${curDay}&day_xp=gt.0&select=wallet,day_xp,name&order=day_xp.desc&limit=10`); } catch (e) { log("board:", e.message); }
  const m = new Map(rows.map(r => [r.wallet, +r.day_xp])), names = new Map(rows.map(r => [r.wallet, r.name]));
  for (const [w, s] of known) { if (s.day === curDay && s.dayXp) m.set(w, Math.max(m.get(w) || 0, s.dayXp)); if (s.name) names.set(w, s.name); }
  board = [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w, xp]) => ({ w, name: names.get(w) || short(w), xp }));
}
const sendBoard = p => send(p, { t: "B", rows: board, online: players.size });

// ---------------- movement ----------------
function move(p, x, y, f) {
  const r = p.room; if (!r) return;
  x = +x; y = +y; if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const now = Date.now(), dt = Math.min(1500, now - p.mt); p.mt = now;
  // walking budget: refills at your top speed (plus some slack for network bunching)
  p.budget = Math.min(70, p.budget + 0.11 * TIERS[p.acc.level].speed * dt * 1.3);
  const d = Math.hypot(x - p.x, y - p.y);
  if (d > p.budget || blockedMove(r.m, x, y)) { p.bad = (p.bad || 0) + 1; return send(p, { t: "pos", x: Math.round(p.x), y: Math.round(p.y) }); }
  p.budget -= d; p.x = x; p.y = y; p.f = !!f;
  if (p.lock && d > 2) p.lock = null;
}
function travel(p, to) {
  const r = p.room; if (!r || !MAP_NAMES[to]) return;
  const P = r.m.portals.find(q => q.to === to);
  if (!P || Math.hypot(p.x - (P.x * T + 8), p.y - (P.y * T + 8)) > 40) return joinRoom(p, r.map, { x: p.x, y: p.y }); // not at that black hole: stay
  joinRoom(p, to, arrival(getMap(to), r.map));
}
function tick() {
  stepSurprises();
  for (const r of rooms.values()) {
    if (!r.players.size) { if (r.empty && Date.now() - r.empty > 120_000) dropRoom(r); continue; }
    for (const me of r.players) {
      const u = [];
      for (const o of r.players) {
        if (o === me || Math.abs(o.x - me.x) > VIEW_X || Math.abs(o.y - me.y) > VIEW_Y) continue;
        const k = Math.round(o.x) + "," + Math.round(o.y) + "," + (o.f ? 1 : 0);
        if (me.seen.get(o.id) !== k) { me.seen.set(o.id, k); u.push(o.id, Math.round(o.x), Math.round(o.y), o.f ? 1 : 0); }
      }
      if (u.length) send(me, { t: "u", u });
    }
  }
}

// ---------------- surprise pills: one per district, wandering around ----------------
// Catch it, pick its lock, get a big XP boost. A new one appears in that district 12 hours later.
const SURPRISE_ID = -1, SURPRISE_RESPAWN = 12 * 3600_000, SURPRISE_SPEED = 0.06; // px per ms, about half walking speed (players walk 0.11+)
const surprise = {};
for (const k of MAPKEYS) surprise[k] = { map: k, alive: false, x: 0, y: 0, goal: null, respawnAt: 0, heldBy: null, heldUntil: 0, sent: "" };
const pillSend = (map, msg) => { const s = JSON.stringify(msg); for (const r of rooms.values()) if (r.map === map) for (const p of r.players) if (p.ws.readyState === 1) p.ws.send(s); };
function spawnSurprise(sp) {
  const m = getMap(sp.map), c = { x: m.spawn.x * T + 8, y: m.spawn.y * T + 8 };
  let at = randomWalkable(m);
  for (let k = 0; k < 30 && Math.hypot(at.x - c.x, at.y - c.y) < 400; k++) at = randomWalkable(m); // not right at the entrance
  Object.assign(sp, { alive: true, x: at.x, y: at.y, path: null, heldBy: null, sent: "" });
  pillSend(sp.map, { t: "sp", x: Math.round(sp.x), y: Math.round(sp.y), born: 1 });
  log("surprise pill in", MAP_NAMES[sp.map]);
}
function stepSurprises() {
  const now = Date.now();
  for (const sp of Object.values(surprise)) {
    if (!sp.alive) { if (sp.respawnAt <= now && surpriseLoaded) spawnSurprise(sp); continue; }
    if (sp.heldBy && sp.heldUntil > now) continue; // someone is picking its lock: it holds still
    sp.heldBy = null;
    const m = getMap(sp.map);
    // it walks the same ground players walk on (never into water), along a path, so it never gets stuck
    // and wherever it goes, players can follow
    if (!sp.path || !sp.path.length) { sp.path = pillPath(m, sp.x, sp.y); if (!sp.path.length) continue; }
    let left = SURPRISE_SPEED * TICK_MS, dx = 0;
    while (left > 0 && sp.path.length) {
      const g = sp.path[0], ddx = g.x - sp.x, ddy = g.y - sp.y, d = Math.hypot(ddx, ddy);
      if (d <= left) { sp.x = g.x; sp.y = g.y; left -= d; sp.path.shift(); dx = ddx || dx; }
      else { sp.x += ddx / d * left; sp.y += ddy / d * left; dx = ddx; left = 0; }
    }
    const k = Math.round(sp.x) + "," + Math.round(sp.y);
    if (k !== sp.sent) { sp.sent = k; pillSend(sp.map, { t: "sp", x: Math.round(sp.x), y: Math.round(sp.y), f: dx < 0 ? 1 : 0 }); }
  }
}
// a walkable route from (x, y) to a random reachable spot a few hundred pixels away
function pillPath(m, x, y) {
  const W = m.W, sx = Math.floor(x / T), sy = Math.floor(y / T);
  let goal = null;
  for (let k = 0; k < 30; k++) { const g = randomWalkable(m); if (Math.hypot(g.x - x, g.y - y) < 420 && Math.hypot(g.x - x, g.y - y) > 64) { goal = g; break; } }
  if (!goal) goal = randomWalkable(m);
  const gx = Math.floor(goal.x / T), gy = Math.floor(goal.y / T), start = sy * W + sx, end = gy * W + gx;
  const prev = new Int32Array(W * m.H).fill(-1), q = [start]; prev[start] = start;
  const ok = (X, Y) => X >= 0 && Y >= 0 && X < W && Y < m.H && m.reach[Y * W + X] && !SOLID.has(m.g[Y][X]);
  for (let i = 0; i < q.length && prev[end] < 0; i++) {
    const c = q[i], cx = c % W, cy = (c - cx) / W;
    for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = cx + ddx, Y = cy + ddy, k = Y * W + X; if (!ok(X, Y) || prev[k] >= 0) continue; prev[k] = c; q.push(k); }
  }
  if (prev[end] < 0) return [];
  const pts = []; for (let c = end; c !== start; c = prev[c]) pts.push({ x: (c % W) * T + 8, y: Math.floor(c / W) * T + 8 });
  return pts.reverse();
}
function releaseSurprise(p) { const sp = p.room && surprise[p.room.map]; if (sp && sp.heldBy === p.id) sp.heldBy = null; }
function openSurprise(p) {
  const r = p.room, sp = r && surprise[r.map], now = Date.now();
  const no = msg => send(p, { t: "D", id: SURPRISE_ID, msg });
  if (!sp || !sp.alive) return no("Too late, someone caught it.");
  if (!p.acc.canOpen) return no("Hold $PUMPERS to catch the surprise pill");
  if (!settings.boxes_open) return no("Boxes open at launch");
  if (Math.hypot(p.x - sp.x, p.y - sp.y) > 40) return no("Get closer to catch it");
  if (sp.heldBy && sp.heldBy !== p.id && sp.heldUntil > now) return no("Someone else is catching it");
  if ((p.jam.get(SURPRISE_ID) || 0) > now) return no("Lock jammed. Wait a moment");
  sp.heldBy = p.id; sp.heldUntil = now + 10_000;
  const w = 0.24, a = 0.1 + Math.random() * (0.8 - w); // a little harder than a box
  p.lock = { id: SURPRISE_ID, zone: [a, a + w], speed: 0.6 + Math.random() * 0.15, t0: now };
  send(p, { t: "L", id: SURPRISE_ID, zone: p.lock.zone, speed: p.lock.speed });
}
async function catchSurprise(p) {
  const r = p.room, sp = r && surprise[r.map];
  if (!sp || !sp.alive || sp.heldBy !== p.id) return send(p, { t: "D", id: SURPRISE_ID, msg: "Too late, someone caught it." });
  sp.alive = false; sp.heldBy = null; sp.respawnAt = Date.now() + SURPRISE_RESPAWN;
  const xp = 100 + Math.floor(Math.random() * 51); // same for everyone: no level multiplier on the surprise pill
  if (p.s.day !== curDay) { p.s.day = curDay; p.s.dayXp = 0; }
  p.s.xp += xp; p.s.dayXp = (p.s.dayXp || 0) + xp; p.s.dirty = !!p.wallet;
  send(p, { t: "O", id: SURPRISE_ID, xp, total: p.s.xp, dayXp: p.s.dayXp, opened: p.s.opened, found: p.s.found, prize: 0 });
  pillSend(r.map, { t: "sg", by: p.id });
  allSend({ t: "SW", who: p.name, wallet: p.wallet, xp, district: MAP_NAMES[r.map] });
  log("surprise caught", MAP_NAMES[r.map], p.name, xp);
  if (dbReady()) db("surprise_pills?on_conflict=map", { method: "POST", prefer: "resolution=merge-duplicates", body: [{ map: r.map, respawn_at: new Date(sp.respawnAt).toISOString(), caught_by: p.wallet || null, caught_at: new Date().toISOString() }] }).catch(e => log("save pill:", e.message));
}
// after a restart, pills that were caught less than 12 hours ago stay away until their time
let surpriseLoaded = false;
async function loadSurprises() {
  if (dbReady()) try { for (const row of await db("surprise_pills?select=map,respawn_at")) if (surprise[row.map]) surprise[row.map].respawnAt = Date.parse(row.respawn_at) || 0; } catch (e) { log("load pills:", e.message); }
  surpriseLoaded = true;
}

// ---------------- NFTs being played ----------------
// Every client gets the list of NFT numbers players are using, so citizens (NPCs) that look the same can step aside.
let inUseSent = "";
const inUseList = () => [...new Set([...players.values()].filter(p => p.ready && p.skin?.n).map(p => p.skin.n))].sort((a, b) => a - b);
function pushInUse() { const l = inUseList(), k = l.join(","); if (k === inUseSent) return; inUseSent = k; allSend({ t: "use", n: l }); }
setInterval(pushInUse, 2000);

// ---------------- chat ----------------
// One chat for the whole city. No links and no wallet / contract addresses (the usual scam bait).
const chatLog = [];
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|net|org|app|fun|gg|co|me|link|site|online|top|live|tk|ru|cc)\b|t\.me|discord\.gg)/i;
const ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
function say(p, text) {
  const now = Date.now(), gap = p.wallet ? 1500 : 4000;
  text = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!text || !p.nick && !p.wallet) return;
  const no = msg => send(p, { t: "cx", msg });
  if (now - (p.lastSay || 0) < gap) return no("Slow down a little.");
  if (LINK.test(text)) return no("Links aren't allowed in chat.");
  if (ADDRESS.test(text)) return no("Wallet and contract addresses aren't allowed in chat.");
  if (text === p.lastText) return no("You just said that.");
  p.lastSay = now; p.lastText = text;
  const msg = { t: "c", n: p.name, b: badge(p), x: text, at: now };
  chatLog.push(msg); if (chatLog.length > 60) chatLog.shift();
  allSend(msg);
}

// ---------------- connections ----------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*");
  if (u.pathname === "/status") { res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); return res.end(JSON.stringify({ online: players.size, won: stats.won, wins: stats.wins, recent: stats.recent, daily: settings.daily_top })); }
  // name check for the "pick a name" screen: /name?n=Name&w=wallet
  if (u.pathname === "/name") {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    const w = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(u.searchParams.get("w") || "") ? u.searchParams.get("w") : null;
    const cn = checkName(u.searchParams.get("n"));
    if (cn.err) return res.end(JSON.stringify({ ok: false, err: cn.err }));
    nameTaken(cn.name, w).then(t => res.end(JSON.stringify(t ? { ok: false, err: "That name is taken" } : { ok: true })));
    return;
  }
  if (u.pathname === "/" || u.pathname === "/health") return res.end("ok");
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 4096, perMessageDeflate: false });
const originOk = o => { if (DEV) return true; try { return SITES.includes(new URL(o).host.replace(/^www\./, "")); } catch { return false; } };

wss.on("connection", (ws, req) => {
  if (!originOk(req.headers.origin) || players.size >= MAX_PLAYERS) { ws.close(4003, players.size >= MAX_PLAYERS ? "full" : "origin"); return; }
  const p = { id: nextId++, ws, wallet: null, name: "Guest", skin: null, trail: null, nfts: [], acc: { canOpen: false, level: "none", trail: false },
    x: 0, y: 0, f: false, room: null, s: { xp: 0, opened: 0, found: 0 }, opens: [], jam: new Map(), seen: new Map(), alive: true, rate: 0, rateT: Date.now() };
  players.set(p.id, p);
  ws.on("pong", () => { p.alive = true; });
  ws.on("message", async raw => {
    const now = Date.now();
    if (now - p.rateT > 1000) { p.rateT = now; p.rate = 0; }
    if (++p.rate > 60) return; // flood: ignore
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.t === "hello" && !p.ready && !p.helloing) { p.helloing = true; await hello(p, m); return; }
      if (!p.ready) return;
      switch (m.t) {
        case "j": if (MAP_NAMES[m.map]) joinRoom(p, m.map, spawnSpot(getMap(m.map))); break;
        case "m": move(p, m.x, m.y, m.f); break;
        case "go": travel(p, m.to); break;
        case "o": openBox(p, m.id | 0); break;
        case "h": await hitLock(p, m.id | 0, m.e); break;
        case "c": if (p.lock?.id === SURPRISE_ID) releaseSurprise(p); p.lock = null; break;
        case "say": say(p, m.text); break;
        case "look": applyLook(p, m.skin); if (p.room) roomSend(p.room, { t: "k", id: p.id, name: p.name, b: badge(p), skin: p.skin, trail: p.trail }, p); send(p, { t: "me", name: p.name, trail: p.trail }); break;
        case "po": if (p.pingAt && m.s === p.pingAt) p.rtt = Math.min(2000, now - p.pingAt); break;
      }
    } catch (e) { log("msg error:", e.message); }
  });
  ws.on("close", () => {
    leaveRoom(p); players.delete(p.id);
    if (p.wallet && byWallet.get(p.wallet) === p) byWallet.delete(p.wallet);
  });
});

setInterval(tick, TICK_MS);
setInterval(() => { for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; p.ws.ping(); p.pingAt = Date.now(); send(p, { t: "pi", s: p.pingAt }); } }, 10_000);
setInterval(saveXp, 15_000);
setInterval(async () => { await loadBoard(); for (const p of players.values()) if (p.ready) sendBoard(p); }, 15_000);
setInterval(loadSettings, 20_000);
setInterval(loadStats, 60_000);
// holdings are checked again every 5 minutes: sell your tokens and the boxes lock
setInterval(async () => {
  for (const p of players.values()) if (p.wallet && p.ready && !(DEV && p.dev)) {
    const before = p.acc.canOpen + p.acc.level;
    try { await access(p, true); } catch { continue; }
    if (before !== p.acc.canOpen + p.acc.level) { const s = p.skin; applyLook(p, s); send(p, { t: "me", level: p.acc.level, canOpen: p.acc.canOpen, name: p.name, b: badge(p), trail: p.trail }); if (p.room) roomSend(p.room, { t: "k", id: p.id, name: p.name, b: badge(p), skin: p.skin, trail: p.trail }, p); }
  }
}, 300_000);
process.on("SIGTERM", async () => { await saveXp(); process.exit(0); });

// ---------------- daily reset ----------------
// At the reset hour (19:00 UTC): save everyone's XP, then the database picks the day's top 3 and puts their prizes
// in MY PRIZES (award_daily does this once per day, even if called again).
const fmtN = n => Number(n).toLocaleString("en-US");
async function awardDay(day) {
  if (!dbReady()) return;
  try {
    const n = await db("rpc/award_daily", { method: "POST", body: { p_day: day } });
    if (!n) return;
    const res = await db(`daily_results?day=eq.${day}&rank=gt.0&select=rank,wallet,amount&order=rank`);
    const nm = w => known.get(w)?.name || short(w);
    log("daily winners", day, res.map(r => short(r.wallet) + " " + r.amount).join(", "));
    return "Yesterday's winners: " + res.map(r => ["🥇", "🥈", "🥉"][r.rank - 1] + " " + nm(r.wallet) + " " + fmtN(r.amount) + " $PUMP").join(" · ");
  } catch (e) { log("award_daily:", e.message); }
}
let rolling = false;
setInterval(async () => {
  if (rolling || today() === curDay) return;
  rolling = true;
  const old = curDay;
  // everyone's XP must be in the database before the winners are picked; if saving fails, try again in 15 s
  if (!(await saveXp())) { rolling = false; return; }
  const msg = await awardDay(old);
  curDay = today(); board = [];
  allSend({ t: "day", msg: "A new day has started. The leaderboard is back to zero." + (msg ? " " + msg : "") });
  await loadStats(); await loadBoard();
  rolling = false;
}, 15_000);

await loadSettings(); await loadStats(); await loadSurprises();
// the server may have been off at midnight: hand out yesterday's prizes now (no-op if already done)
await awardDay(dayOf(Date.now() - 86400_000));
await loadBoard();
server.listen(PORT, () => log(`Pumpers City server on :${PORT} · db ${dbReady() ? "on" : "off"} · helius ${env.HELIUS_API_KEY ? "on" : "off"}${DEV ? " · DEV" : ""}`));
