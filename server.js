// Pixel Strike game server — no dependencies, just Node 18+.
// Serves the game website, runs live multiplayer lobbies, and keeps accounts + saves.
// Settings (environment variables):
//   PORT                       port to listen on (hosts set this for you)
//   ADMIN_USER                 the one username that gets the admin panel (default "Gus")
//   UPSTASH_REDIS_REST_URL     optional: cloud storage so saves survive restarts
//   UPSTASH_REDIS_REST_TOKEN   optional: token for the above
//   DATA_FILE                  optional: local save file (default ./data.json)
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const ADMIN = String(process.env.ADMIN_USER || 'Gus').toLowerCase();
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');
const LOBBY_MAX = 8, TICK_MS = 66, KEY = 'pixelstrike:db';

// ---------------- game rules (must match the client) ----------------
const RANKS = [[0, 3], [400, 6], [800, 9], [1400, 12], [2200, 15], [3200, 18], [7000, 20], [15000, 25]];
const rankIdx = e => { let r = 0; RANKS.forEach((x, i) => { if (e >= x[0]) r = i }); return r };
const killGain = e => { const i = rankIdx(e); return i <= 2 ? 35 : i <= 5 ? 30 : 28 };
const WEAP = [{ d: 18, h: 23, r: .14, rng: 200, n: 1 }, { d: 100, h: 150, r: 1.1, rng: 260, n: 1 }, { d: 9, h: 16, r: .85, rng: 60, n: 8 }, { d: 11, h: 20, r: .07, rng: 160, n: 1 }];
const KNIVES = { gut: 0, combat: 1, kukri: 2, m9: 3, kara: 4, skel: 4, bfo: 5, bfe: 5, prism: 6,
  skelf: 0, flipf: 0, stils: 1, switchp: 1, m9spit: 2, shadow: 3, kukfade: 3, talon: 4, bfdop: 5, m9ruby: 5, mint: 6 };
const KCASE2 = new Set(['skelf', 'flipf', 'stils', 'switchp', 'm9spit', 'shadow', 'kukfade', 'talon', 'bfdop', 'm9ruby', 'mint']);
const KODDS = [40.5, 35, 15, 5, 3, 1, .5]; // knife cases: common, uncommon, rare, epic, legendary, mythic, LEGEND
const ODDS = [41, 35, 15, 5, 3, 1], CRATE_COST = 100, KNIFE_DMG = 100, KNIFE_CD = 1600;
const MAPS = ['snow', 'desert', 'atomic', 'halloween', 'towers'];
const slotNow = () => Math.floor(Date.now() / 18e4);
const hh = s => Math.imul(s, 2654435761) >>> 0;
const mapIdx = s => { const n = MAPS.length, a = hh(s) % n; return a == hh(s - 1) % n ? (a + 1) % n : a };
function rollKnife(cs) { let r = Math.random() * 100, t = 0; for (; t < KODDS.length - 1; t++) { r -= KODDS[t]; if (r < 0) break }
  const pool = Object.keys(KNIVES).filter(k => KNIVES[k] == t && (cs == 2) == KCASE2.has(k)); return pool[Math.random() * pool.length | 0] }

// ---------------- storage ----------------
let db = { users: {}, tokens: {} }, dirty = false;
const newSave = u => ({ user: u, name: u, elo: 0, coins: 0, inv: {}, knife: null, arm: 0, cls: 0, gfx: 1, sens: 1, fov: 75, skins: {}, skin: null, guns: {}, gsk: {}, brWins: 0 });
// gun skins: id -> [weapon (0 AK, 1 AWP, 2 pump, 3 MP7), rarity]; gun crate uses the knife crate odds
const GUN_SKINS = { pumpkiss: [2, 0], pumpwaifu: [2, 1], mp7flower: [3, 2], mp7fade: [3, 3], awpprint: [1, 3], akinherit: [0, 4], awplight: [1, 4], awpdragon: [1, 5], akbluegem: [0, 5] }, GCRATE_COST = 100;
function rollGun() { let r = Math.random() * 100, t = 0; for (; t < ODDS.length - 1; t++) { r -= ODDS[t]; if (r < 0) break } const pool = Object.keys(GUN_SKINS).filter(k => GUN_SKINS[k][1] == t); return pool[Math.random() * pool.length | 0] }
// 50 skins: s01-s14 common, s15-s26 uncommon, s27-s36 rare, s37-s43 epic, s44-s47 legendary, s48-s50 mythic
const SKIN_R = {}; for (let i = 1; i <= 50; i++) SKIN_R['s' + String(i).padStart(2, '0')] = i <= 14 ? 0 : i <= 26 ? 1 : i <= 36 ? 2 : i <= 43 ? 3 : i <= 47 ? 4 : 5;
const SKIN_ODDS = [35, 33, 18, 8, 4, 2], SPIN_COST = 150, SPECIAL_SKINS = ['champ'];
function rollSkin() { let r = Math.random() * 100, t = 0; for (; t < SKIN_ODDS.length - 1; t++) { r -= SKIN_ODDS[t]; if (r < 0) break }
  const pool = Object.keys(SKIN_R).filter(k => SKIN_R[k] == t); return pool[Math.random() * pool.length | 0] }
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('Upstash HTTP ' + r.status); return (await r.json()).result }
async function load() {
  try {
    if (UP_URL && UP_TOKEN) { const s = await upstash(['GET', KEY]); if (s) db = JSON.parse(s); console.log('Loaded saves from Upstash:', Object.keys(db.users).length, 'players') }
    else if (fs.existsSync(DATA_FILE)) { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); console.log('Loaded saves from', DATA_FILE, ':', Object.keys(db.users).length, 'players') }
  } catch (e) { console.error('Could not load saves:', e.message); if (UP_URL) process.exit(1) }
  db.users = db.users || {}; db.tokens = db.tokens || {}; db.updates = Array.isArray(db.updates) ? db.updates : [];
}
let saving = false;
async function persist(force) {
  if ((!dirty && !force) || saving) return; saving = true; dirty = false; const json = JSON.stringify(db);
  try {
    if (UP_URL && UP_TOKEN) await upstash(['SET', KEY, json]);
    else { fs.writeFileSync(DATA_FILE + '.tmp', json); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE) }
  } catch (e) { console.error('Save failed:', e.message); dirty = true }
  saving = false;
}
setInterval(persist, 10000);
const markDirty = () => { dirty = true };

// ---------------- passwords ----------------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const validUser = u => /^[A-Za-z0-9_]{3,14}$/.test(u);
const cleanName = n => String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14);

// ---------------- minimal WebSocket ----------------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSend(sock, obj) {
  if (sock.destroyed || !sock.wsOpen) return; const data = Buffer.from(typeof obj == 'string' ? obj : JSON.stringify(obj)); let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2) }
  sock.write(Buffer.concat([head, data]));
}
function wsClose(sock) { if (sock.wsOpen) { sock.wsOpen = false; try { sock.write(Buffer.from([0x88, 0])) } catch (e) { } } sock.end(); setTimeout(() => sock.destroy(), 500) }
function wsAccept(req, sock, onMsg, onClose) {
  const key = req.headers['sec-websocket-key']; if (!key) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.wsOpen = true; sock.setNoDelay(true); let buf = Buffer.alloc(0), parts = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len == 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len == 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (len > 16 * 1024 * 1024) return wsClose(sock);
      const mOff = off; if (masked) off += 4; if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(mOff, mOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3] }
      buf = buf.subarray(off + len);
      if (op == 8) return wsClose(sock);
      if (op == 9) { const h = Buffer.from([0x8a, payload.length]); sock.write(Buffer.concat([h, payload])); continue }
      if (op == 10) { sock.alive = true; continue }
      if (op == 1 || op == 0) { parts.push(payload); if (fin) { const txt = Buffer.concat(parts).toString('utf8'); parts = []; let o; try { o = JSON.parse(txt) } catch (e) { continue } try { onMsg(o) } catch (e) { console.error('handler error', e) } } }
    }
  });
  sock.alive = true; sock.on('close', onClose); sock.on('error', () => { });
}
setInterval(() => { for (const c of clients) { if (!c.sock.alive) { c.sock.destroy(); continue } c.sock.alive = false; try { c.sock.write(Buffer.from([0x89, 0])) } catch (e) { } } }, 25000);

// ---------------- players, lobbies ----------------
const clients = new Set(); let nextId = 1, lobbies = [], forced = null, curSlot = slotNow();
const mapFor = s => forced && forced.slot == s ? forced.k : MAPS[mapIdx(s)];
const publicSave = u => { const s = db.users[u].save; return Object.assign({}, s) };
function sendSave(c) { if (c.user) wsSend(c.sock, { t: 'save', save: publicSave(c.user) }) }
function lobbyOf(c) { return c.lobby }
function bcast(lobby, obj, except) { const s = JSON.stringify(obj); for (const c of lobby.players) if (c !== except) wsSend(c.sock, s) }
function bcastAll(obj) { const s = JSON.stringify(obj); for (const c of clients) if (c.user) wsSend(c.sock, s) }
function pInfo(c) { const s = db.users[c.user].save; return { id: c.id, name: s.name, arm: s.arm, cls: s.cls, knife: s.knife, skin: s.skin && s.skins && s.skins[s.skin] ? s.skin : null, gsk: (() => { const gw = [0, 2, 1, 3][s.cls] || 0, id = s.gsk && s.gsk[gw]; return id && s.guns && s.guns[id] ? id : null })() } }
function joinLobby(c) {
  leaveLobby(c); let L = lobbies.find(l => l.players.size < LOBBY_MAX);
  if (!L) { L = { id: lobbies.length ? Math.max(...lobbies.map(l => l.id)) + 1 : 1, players: new Set() }; lobbies.push(L) }
  Object.assign(c, { lobby: L, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: db.users[c.user].save.cls == 2 ? 1 : 0, ws: 0, hp: 100, dead: 0, k: 0, d: 0, lastShot: 0, lastKnife: 0, god: false, prot: Date.now() + 1500, lastPvp: 0, lastRegen: 0, lastSt: Date.now() });
  c.w = [0, 2, 1, 3][db.users[c.user].save.cls] || 0;
  L.players.add(c);
  wsSend(c.sock, { t: 'joined', lobby: L.id, you: c.id, map: mapFor(curSlot), slot: curSlot, players: [...L.players].filter(p => p !== c).map(pInfo) });
  bcast(L, Object.assign({ t: 'pj' }, pInfo(c)), c);
}
function leaveLobby(c) {
  const L = c.lobby; if (!L) return; L.players.delete(c); c.lobby = null; bcast(L, { t: 'pl', id: c.id });
  if (!L.players.size && lobbies.length > 1) lobbies = lobbies.filter(l => l !== L);
}
const r2 = v => Math.round(v * 100) / 100;
setInterval(() => {
  const now = Date.now(), s = slotNow();
  if (s != curSlot) { curSlot = s; for (const L of lobbies) { for (const c of L.players) { c.k = 0; c.d = 0 } } bcastAll({ t: 'map', k: mapFor(s), slot: s }) }
  for (const L of lobbies) {
    const p = [];
    for (const c of L.players) {
      if (now - (c.lastSt || now) > 6000) { wsSend(c.sock, { t: 'afk' }); leaveLobby(c); continue } // phone asleep / tabbed out: send back to menu
      if (c.dead && now >= c.dead) { c.dead = 0; c.hp = 100; c.prot = now + 1500; wsSend(c.sock, { t: 'spawn' }) }
      if (!c.dead && c.hp < 100 && now - c.lastPvp >= 4000 && now - c.lastRegen >= 500) { c.hp = Math.min(100, c.hp + 5); c.lastRegen = now } // regen after 4s of no PvP
      p.push([c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yaw), r2(c.pitch), c.w, c.ws, c.hp, c.dead ? 1 : 0, c.k, c.d, c.prot > now ? 1 : 0]);
    }
    if (p.length) bcast(L, { t: 'snap', p });
  }
}, TICK_MS);

// ---------------- battle royale (duos) ----------------
// A match starts every 10 minutes for everyone in the queue: up to 100 players (50 teams of 2) per match.
// Everyone starts with only their knife. Red drops = random gun, blue = +50 shield, green = +50 health. The zone shrinks until one team is left.
const BR_EVERY = 6e5, BR_MAX_TEAMS = 50, BR_MB = 150, BR_KNIFE_DMG = 40, BR_VIEW = 170;
const BR_PLAN = [[60, 60, 95], [60, 50, 60], [50, 40, 34], [40, 35, 16], [30, 30, 0]], BR_ZDMG = [1, 2, 3, 5, 8, 10];
const BR_PRIZE = p => p == 1 ? 100 : p == 2 ? 50 : p == 3 ? 30 : p <= 10 ? 15 : 0;
const brSlot = () => Math.floor(Date.now() / BR_EVERY);
const brQueue = new Set(), parties = new Map(); let brMatches = [], brNextId = 1, brLast = brSlot();
function makeZone() {
  const segs = []; let cx = 0, cz = 0, r = BR_MB * 1.5, t = 0;
  for (const [hold, shr, nr] of BR_PLAN) {
    segs.push([t, t + hold, cx, cz, r, cx, cz, r]); t += hold;
    const lim = BR_MB - nr - 4, a = Math.random() * 6.283, d = Math.random() * Math.max(0, Math.min(r, BR_MB) - nr) * .7;
    const nx = Math.max(-lim, Math.min(lim, cx + Math.cos(a) * d)), nz = Math.max(-lim, Math.min(lim, cz + Math.sin(a) * d));
    segs.push([t, t + shr, cx, cz, r, nx, nz, nr]); t += shr; cx = nx; cz = nz; r = nr;
  }
  segs.push([t, t + 900, cx, cz, 0, cx, cz, 0]); return segs;
}
function zoneAt(segs, t) {
  let i = 0; while (i < segs.length - 1 && t >= segs[i][1]) i++; const g = segs[i], k = Math.max(0, Math.min(1, (t - g[0]) / ((g[1] - g[0]) || 1)));
  return { x: g[2] + (g[5] - g[2]) * k, z: g[3] + (g[6] - g[3]) * k, r: g[4] + (g[7] - g[4]) * k, ph: Math.min(BR_ZDMG.length - 1, i >> 1) };
}
const brName = c => db.users[c.user] ? db.users[c.user].save.name : '?';
function partyMsg(p) { const o = { t: 'party', code: p.code, members: p.members.map(m => ({ id: m.id, name: brName(m) })), queued: p.members.some(m => brQueue.has(m)) }; for (const m of p.members) wsSend(m.sock, o) }
function leaveParty(c) { const p = c.party; if (!p) return; p.members = p.members.filter(m => m !== c); c.party = null; wsSend(c.sock, { t: 'party', code: null, members: [] }); if (!p.members.length) parties.delete(p.code); else partyMsg(p) }
function newCode() { let s; do { s = ''; for (let i = 0; i < 4; i++) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0] } while (parties.has(s)); return s }
function brInfo(c) { wsSend(c.sock, { t: 'brinfo', in: (brSlot() + 1) * BR_EVERY - Date.now(), q: brQueue.size, me: brQueue.has(c) ? 1 : 0, live: brMatches.reduce((n, M) => n + [...M.players].filter(p => !p.out).length, 0) }) }
setInterval(() => { for (const c of clients) if (c.user && !c.br) brInfo(c) }, 2000);
function brTeams(list) {
  const used = new Set(), teams = [], solos = [];
  for (const c of list) { if (used.has(c)) continue; const p = c.party, ready = p ? p.members.filter(m => list.includes(m) && !used.has(m)) : [];
    if (ready.length >= 2) { ready.slice(0, 2).forEach(m => used.add(m)); teams.push(ready.slice(0, 2)) } else { used.add(c); solos.push(c) } }
  solos.sort(() => Math.random() - .5); for (let i = 0; i < solos.length; i += 2) teams.push(solos.slice(i, i + 2));
  if (teams.length == 1 && teams[0].length == 2 && !(teams[0][0].party && teams[0][0].party === teams[0][1].party)) return [[teams[0][0]], [teams[0][1]]];
  return teams;
}
function startBR(why) {
  const list = [...brQueue].filter(c => c.user && clients.has(c) && !c.br); const teams = brTeams(list);
  if (teams.length < 2) { for (const c of list) wsSend(c.sock, { t: 'brcancel', msg: list.length ? 'Not enough players for a match. You stay queued for the next one.' : '' }); return 0 }
  teams.sort(() => Math.random() - .5); let made = 0;
  for (let i = 0; i < teams.length; i += BR_MAX_TEAMS) {
    let chunk = teams.slice(i, i + BR_MAX_TEAMS); if (chunk.length < 2 && brMatches.length && made) continue;
    const M = { id: brNextId++, players: new Set(), teams: [], seed: (Math.random() * 1e9 | 0) + 1, t0: Date.now(), zone: makeZone(), drops: new Map(), dropId: 1, lastZ: 0, lastDrop: 0, ended: false };
    chunk.forEach((tm, ti) => {
      const a = Math.random() * 6.283, d = 20 + Math.random() * (BR_MB - 30), bx = Math.max(-BR_MB + 10, Math.min(BR_MB - 10, Math.cos(a) * d)), bz = Math.max(-BR_MB + 10, Math.min(BR_MB - 10, Math.sin(a) * d));
      M.teams.push(tm); tm.forEach((c, j) => {
        if (c.lobby) leaveLobby(c); brQueue.delete(c);
        Object.assign(c, { br: M, team: ti, x: bx + j * 2.5, y: 45, z: bz, yaw: 0, pitch: 0, hp: 100, sh: 0, w: -1, ws: 1, dead: 0, out: false, k: 0, d: 0, lastShot: 0, lastKnife: 0, lastSt: Date.now(), god: false, prot: 0, lastPvp: 0, place: 0 });
        M.players.add(c);
      });
    });
    const n = M.players.size; for (let k = 0; k < Math.max(40, n * 1.3); k++) brAddDrop(M, 0, true); for (let k = 0; k < Math.max(20, n * .7); k++) { brAddDrop(M, 1, true); brAddDrop(M, 2, true) }
    const info = [...M.players].map(c => { const sv = db.users[c.user].save, gs = {}; for (const w in (sv.gsk || {})) { const id = sv.gsk[w]; if (id && sv.guns && sv.guns[id]) gs[w] = id } return Object.assign(pInfo(c), { team: c.team, gs }) });
    for (const c of M.players) wsSend(c.sock, { t: 'brstart', id: M.id, you: c.id, team: c.team, seed: M.seed, zone: M.zone, players: info, x: c.x, z: c.z, drops: [...M.drops.values()], teams: M.teams.length });
    brMatches.push(M); made++;
  }
  for (const p of parties.values()) partyMsg(p); return made;
}
function brAddDrop(M, type, initial) {
  if (type == null) { const r = Math.random(); type = r < .5 ? 0 : r < .75 ? 1 : 2 }
  let x, z; if (initial) { x = (Math.random() - .5) * 2 * (BR_MB - 6); z = (Math.random() - .5) * 2 * (BR_MB - 6) }
  else { const Z = zoneAt(M.zone, (Date.now() - M.t0) / 1000), a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * Math.max(4, Math.min(Z.r, BR_MB) - 3); x = Math.max(-BR_MB + 5, Math.min(BR_MB - 5, Z.x + Math.cos(a) * d)); z = Math.max(-BR_MB + 5, Math.min(BR_MB - 5, Z.z + Math.sin(a) * d)) }
  const d = [M.dropId++, type, r2(x), r2(z)]; M.drops.set(d[0], d); return d;
}
const brAlive = M => [...M.players].filter(c => !c.out);
const brTeamsAlive = M => M.teams.filter(tm => tm.some(c => !c.out)).length;
function brBcast(M, obj) { const s = JSON.stringify(obj); for (const c of M.players) if (c.br === M) wsSend(c.sock, s) }
function brNear(M, src, obj, R) { const s = JSON.stringify(obj); for (const c of M.players) if (c.br === M && c !== src && Math.hypot(c.x - src.x, c.z - src.z) < (R || BR_VIEW)) wsSend(c.sock, s) }
function brDamage(M, att, vic, dmg, hd, kn) {
  if (vic.out || M.ended || vic.god) return; if (att && (att.out || att.team === vic.team)) return;
  let left = dmg; if (vic.sh > 0) { const a = Math.min(vic.sh, left); vic.sh -= a; left -= a } vic.hp = Math.max(0, vic.hp - left);
  const o = { t: 'hit', by: att ? att.id : 0, to: vic.id, dmg, hd: hd ? 1 : 0, hp: vic.hp, sh: vic.sh }; wsSend(vic.sock, o); if (att) wsSend(att.sock, o);
  if (vic.hp <= 0) brOut(M, vic, att, hd, kn);
}
function brOut(M, vic, att, hd, kn, why) {
  if (vic.out) return; vic.out = true; vic.dead = 1; vic.hp = 0; vic.d++; M.lastOut = vic.team;
  if (att && db.users[att.user]) { att.k++; db.users[att.user].save.coins += 10; markDirty(); sendSave(att) }
  brBcast(M, { t: 'brkill', by: att ? att.id : 0, to: vic.id, byName: att ? brName(att) : '', toName: brName(vic), hd: hd ? 1 : 0, kn: kn ? 1 : 0, why: why || (att ? '' : 'zone'), alive: brAlive(M).length, teams: brTeamsAlive(M) });
  const tm = M.teams[vic.team]; if (tm.every(c => c.out)) { const place = brTeamsAlive(M) + 1; for (const c of tm) brResult(M, c, place) }
  brCheckEnd(M);
}
function brResult(M, c, place) { if (c.place) return; c.place = place; const prize = BR_PRIZE(place), u = db.users[c.user];
  if (u && place == 1) { const sv = u.save; sv.brWins = (sv.brWins || 0) + 1; sv.skins = sv.skins || {}; sv.skins.champ = (sv.skins.champ || 0) + 1; boardDirty = true }
  if (u && (prize || place == 1)) { u.save.coins += prize; markDirty(); sendSave(c) }
  if (c.br === M) wsSend(c.sock, { t: 'brout', place, teams: M.teams.length, k: c.k, prize }) }
function brCheckEnd(M, force) {
  if (M.ended) return; const left = M.teams.filter(tm => tm.some(c => !c.out));
  if (left.length > 1 && !force) return; M.ended = true;
  const pow = tm => tm.reduce((n, c) => n + (c.out ? 0 : c.hp + c.sh), 0);
  let win = left.length ? left.slice().sort((a, b) => pow(b) - pow(a))[0] : M.teams[M.lastOut != null ? M.lastOut : 0];
  for (const tm of left) if (tm !== win) for (const c of tm) brResult(M, c, 2);
  for (const c of win) brResult(M, c, 1);
  brBcast(M, { t: 'brend', winners: win.map(brName), team: win[0].team });
  setTimeout(() => { for (const c of M.players) if (c.br === M) c.br = null; brMatches = brMatches.filter(x => x !== M) }, 15000);
}
function brLeave(c, why) { const M = c.br; if (!M) return; if (!c.out && !M.ended) brOut(M, c, null, 0, 0, why || 'left'); c.br = null; M.players.delete(c) }
setInterval(() => {
  const now = Date.now(), s = brSlot();
  if (s != brLast) { brLast = s; startBR('slot') }
  for (const M of brMatches) {
    if (M.ended) continue; const t = (now - M.t0) / 1000, Z = zoneAt(M.zone, t);
    if (now - M.lastZ >= 1000) { M.lastZ = now;
      for (const c of [...M.players]) { if (c.out) continue; if (now - c.lastSt > 20000) { brLeave(c, 'afk'); wsSend(c.sock, { t: 'afk' }); continue }
        if (Math.hypot(c.x - Z.x, c.z - Z.z) > Z.r && c.y < 30) brDamage(M, null, c, BR_ZDMG[Z.ph], false, false) } }
    if (now - M.lastDrop >= 2500 && M.drops.size < M.players.size * 2.5 + 60) { M.lastDrop = now; const d = brAddDrop(M, null, false); brBcast(M, { t: 'drop', d }) }
    if (t > 560) brCheckEnd(M, true);
    const rows = new Map(); for (const c of M.players) if (c.br === M) rows.set(c, JSON.stringify([c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yaw), r2(c.pitch), c.w, c.ws, c.hp, c.out ? 1 : 0, c.k, c.team, c.sh]));
    const full = (M.tick = (M.tick || 0) + 1) % 3 == 0; // players further than 60 blocks: 3 updates a second, closer: 10
    for (const c of M.players) { if (c.br !== M) continue; const out = [];
      for (const [o, row] of rows) { if (o === c || o.team === c.team) { out.push(row); continue } const d = Math.hypot(o.x - c.x, o.z - c.z); if (d < 60 || (full && d < BR_VIEW)) out.push(row) }
      wsSend(c.sock, '{"t":"bsnap","z":' + JSON.stringify([r2(Z.x), r2(Z.z), r2(Z.r)]) + ',"a":' + brAlive(M).length + ',"tm":' + brTeamsAlive(M) + ',"p":[' + out.join(',') + ']}') }
  }
}, 100);

// ---------------- leaderboard ----------------
let boardDirty = true;
function boardRows() { return Object.entries(db.users).filter(([, u]) => !u.banned).map(([id, u]) => ({ id, name: u.save.name, elo: u.save.elo, w: u.save.brWins || 0 })).sort((a, b) => b.elo - a.elo).slice(0, 50) }
function brRows() { return Object.entries(db.users).filter(([, u]) => !u.banned && (u.save.brWins || 0) > 0).map(([id, u]) => ({ id, name: u.save.name, elo: u.save.elo, w: u.save.brWins })).sort((a, b) => b.w - a.w || b.elo - a.elo).slice(0, 25) }
setInterval(() => { if (boardDirty) { boardDirty = false; bcastAll({ t: 'board', rows: boardRows(), br: brRows() }) } }, 2000);

// ---------------- combat ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function damage(att, vic, dmg, hd, kn) {
  if (vic.dead || vic.god || att.dead || vic.prot > Date.now()) return;
  vic.hp = Math.max(0, vic.hp - dmg); const L = att.lobby; att.lastPvp = vic.lastPvp = Date.now();
  bcast(L, { t: 'hit', by: att.id, to: vic.id, dmg, hd: hd ? 1 : 0, hp: vic.hp });
  if (vic.hp <= 0) {
    vic.dead = Date.now() + 3000; att.k++; vic.d++;
    const as = db.users[att.user].save, vs = db.users[vic.user].save, g = killGain(as.elo), loss = RANKS[rankIdx(vs.elo)][1];
    as.elo += g; as.coins += 10; vs.elo = Math.max(0, vs.elo - loss); markDirty(); boardDirty = true;
    bcast(L, { t: 'kill', by: att.id, to: vic.id, hd: hd ? 1 : 0, kn: kn ? 1 : 0, gain: g, loss, byName: as.name, toName: vs.name });
    sendSave(att); sendSave(vic);
  }
}

// ---------------- message handling ----------------
const authTries = new Map();
function okAuthRate(ip) { const now = Date.now(), a = (authTries.get(ip) || []).filter(t => now - t < 60000); a.push(now); authTries.set(ip, a); return a.length <= 120 }
const badLogins = new Map(); // wrong passwords per username
function lockedOut(u) { const now = Date.now(), a = (badLogins.get(u) || []).filter(t => now - t < 300000); badLogins.set(u, a); return a.length >= 8 }
setInterval(() => { authTries.clear(); for (const [k, v] of badLogins) if (!v.length || Date.now() - v[v.length - 1] > 300000) badLogins.delete(k) }, 600000);
function login(c, u) {
  const acc = db.users[u]; if (acc.banned) { wsSend(c.sock, { t: 'banned', reason: acc.banned.reason || '' }); return false }
  for (const o of clients) if (o !== c && o.user === u) { wsSend(o.sock, { t: 'kicked', reason: 'You logged in somewhere else.' }); leaveLobby(o); brLeave(o, 'left'); brQueue.delete(o); leaveParty(o); o.user = null }
  c.user = u; const token = crypto.randomBytes(24).toString('hex'); db.tokens[token] = { u, t: Date.now() }; markDirty();
  wsSend(c.sock, { t: 'auth_ok', token, save: publicSave(u), admin: u === ADMIN }); wsSend(c.sock, { t: 'board', rows: boardRows(), br: brRows() }); wsSend(c.sock, { t: 'updates', list: db.updates }); brInfo(c); return true;
}
const isAdmin = c => c.user === ADMIN;
function handle(c, m) {
  if (typeof m !== 'object' || !m) return; const t = m.t;
  if (t == 'ping') return wsSend(c.sock, { t: 'pong', c: +m.c || 0 });
  if (t == 'auth') {
    if (!okAuthRate(c.ip)) return wsSend(c.sock, { t: 'auth_err', msg: 'Too many tries. Wait a minute.' });
    const user = String(m.user || '').trim(), pass = String(m.pass || ''), u = user.toLowerCase();
    if (!validUser(user)) return wsSend(c.sock, { t: 'auth_err', msg: 'Username: 3–14 letters, numbers or _' });
    if (pass.length < 4 || pass.length > 64) return wsSend(c.sock, { t: 'auth_err', msg: 'Password must be 4–64 characters' });
    if (m.mode == 'up') {
      if (db.users[u]) return wsSend(c.sock, { t: 'auth_err', msg: 'That username is already taken' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[u] = { salt, hash: hashPw(pass, salt), save: newSave(user), banned: null, created: Date.now() }; markDirty(); boardDirty = true;
      return login(c, u);
    }
    if (lockedOut(u)) return wsSend(c.sock, { t: 'auth_err', msg: 'Too many wrong passwords. Try again in 5 minutes.' });
    const acc = db.users[u]; if (!acc || hashPw(pass, acc.salt) !== acc.hash) { badLogins.get(u).push(Date.now()); return wsSend(c.sock, { t: 'auth_err', msg: 'Wrong username or password' }) }
    return login(c, u);
  }
  if (t == 'resume') { const tk = db.tokens[String(m.token || '')]; if (!tk || !db.users[tk.u]) return wsSend(c.sock, { t: 'auth_err', msg: '', relog: 1 }); delete db.tokens[m.token]; return login(c, tk.u) }
  if (!c.user) return;
  const acc = db.users[c.user], s = acc.save;
  if (t == 'logout') { for (const k in db.tokens) if (db.tokens[k].u === c.user && k === m.token) delete db.tokens[k]; leaveLobby(c); brLeave(c, 'left'); brQueue.delete(c); leaveParty(c); c.user = null; markDirty(); return }
  if (t == 'set') {
    if (m.name != null) { const n = cleanName(m.name); if (n) s.name = n }
    if (Number.isInteger(m.arm) && m.arm >= 0 && m.arm < 8) s.arm = m.arm;
    if (Number.isInteger(m.cls) && m.cls >= 0 && m.cls < 4) s.cls = m.cls;
    if (Number.isInteger(m.gfx) && m.gfx >= 0 && m.gfx < 3) s.gfx = m.gfx;
    if (typeof m.sens == 'number' && m.sens >= .2 && m.sens <= 3) s.sens = Math.round(m.sens * 10) / 10;
    if (Number.isInteger(m.fov) && m.fov >= 70 && m.fov <= 105) s.fov = m.fov;
    if (m.knife === null || (typeof m.knife == 'string' && s.inv[m.knife])) s.knife = m.knife;
    if (m.skin === null || (typeof m.skin == 'string' && s.skins && s.skins[m.skin])) s.skin = m.skin;
    if (m.gsk && typeof m.gsk == 'object') { s.gsk = s.gsk || {}; for (const w of ['0', '1', '2', '3']) { if (!(w in m.gsk)) continue; const v = m.gsk[w];
      if (v === null) s.gsk[w] = null; else if (GUN_SKINS[v] && GUN_SKINS[v][0] == +w && s.guns && s.guns[v]) s.gsk[w] = v } }
    markDirty(); boardDirty = true; return;
  }
  if (t == 'gcrate') {
    s.guns = s.guns || {}; s.gsk = s.gsk || {}; if (s.coins < GCRATE_COST) return wsSend(c.sock, { t: 'crate_err', msg: 'Not enough coins' });
    s.coins -= GCRATE_COST; const k = rollGun(), w = String(GUN_SKINS[k][0]); s.guns[k] = (s.guns[k] || 0) + 1; if (!s.gsk[w] || !s.guns[s.gsk[w]]) s.gsk[w] = k; markDirty();
    return wsSend(c.sock, { t: 'gcrate', item: k, save: publicSave(c.user) });
  }
  if (t == 'spin') {
    s.skins = s.skins || {}; if (s.coins < SPIN_COST) return wsSend(c.sock, { t: 'spin_err', msg: 'Not enough coins' });
    s.coins -= SPIN_COST; const k = rollSkin(); s.skins[k] = (s.skins[k] || 0) + 1; markDirty();
    return wsSend(c.sock, { t: 'spin', item: k, save: publicSave(c.user) });
  }
  if (t == 'crate') {
    if (s.coins < CRATE_COST) return wsSend(c.sock, { t: 'crate_err', msg: 'Not enough coins' });
    s.coins -= CRATE_COST; const k = rollKnife(m.c == 2 ? 2 : 1); s.inv[k] = (s.inv[k] || 0) + 1; if (!s.knife) s.knife = k; markDirty();
    return wsSend(c.sock, { t: 'crate', item: k, save: publicSave(c.user) });
  }
  if (t == 'party_new') { if (c.br) return; leaveParty(c); const p = { code: newCode(), members: [c] }; parties.set(p.code, p); c.party = p; return partyMsg(p) }
  if (t == 'party_join') { const p = parties.get(String(m.code || '').toUpperCase().trim()); if (!p) return wsSend(c.sock, { t: 'party_err', msg: 'No party with that code' }); if (p.members.includes(c)) return partyMsg(p);
    if (p.members.length >= 2) return wsSend(c.sock, { t: 'party_err', msg: 'That party is full (duos)' }); leaveParty(c); p.members.push(c); c.party = p; if (p.members.some(x => brQueue.has(x))) brQueue.add(c); return partyMsg(p) }
  if (t == 'party_leave') { brQueue.delete(c); leaveParty(c); return brInfo(c) }
  if (t == 'brq') { if (c.br) return; const who = c.party ? c.party.members : [c]; for (const x of who) { if (m.on) brQueue.add(x); else brQueue.delete(x) } if (c.party) partyMsg(c.party); for (const x of who) brInfo(x); return }
  if (t == 'brleave') return brLeave(c);
  if (c.br) return brMsg(c, m, s);
  if (t == 'join') return joinLobby(c);
  if (t == 'leave') return leaveLobby(c);
  const L = c.lobby;
  if (t == 'st' && L) { c.lastSt = Date.now();
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) if (typeof m[k] == 'number' && isFinite(m[k])) c[k] = m[k];
    c.x = Math.max(-95, Math.min(95, c.x)); c.z = Math.max(-95, Math.min(95, c.z)); c.y = Math.max(-5, Math.min(100, c.y));
    if (Number.isInteger(m.w) && m.w >= 0 && m.w < 4) c.w = m.w; c.ws = m.s ? 1 : 0; return;
  }
  if (t == 'shot' && L && !c.dead) {
    const w = WEAP[c.w], now = Date.now(); if (c.prot > now) return; // no shooting while spawn-protected
    if (now - c.lastShot < w.r * 1000 * .75) return; c.lastShot = now;
    bcast(L, { t: 'fire', id: c.id, w: c.w }, c);
    const hits = Array.isArray(m.hits) ? m.hits.slice(0, w.n) : [], tally = new Map();
    for (const h of hits) { if (!Array.isArray(h)) continue; const v = [...L.players].find(p => p.id === h[0]); if (!v || v === c || v.dead || dist(c, v) > w.rng + 8) continue;
      const e = tally.get(v) || { dmg: 0, hd: false }; e.dmg += h[1] ? w.h : w.d; e.hd = e.hd || !!h[1]; tally.set(v, e) }
    for (const [v, e] of tally) damage(c, v, e.dmg, e.hd, false); return;
  }
  if (t == 'throw' && L && !c.dead) { if (!s.knife || c.prot > Date.now()) return; bcast(L, { t: 'throw', id: c.id, to: m.to | 0, knife: s.knife }, c); return }
  if (t == 'knife' && L && !c.dead) {
    const now = Date.now(); if (!s.knife || c.prot > now || now - c.lastKnife < KNIFE_CD) return; const v = [...L.players].find(p => p.id === m.id);
    if (!v || v === c || dist(c, v) > 65) return; c.lastKnife = now; damage(c, v, KNIFE_DMG, false, true); return;
  }
  if (t == 'admin') return adminCmd(c, m);
}

function brMsg(c, m, s) {
  const M = c.br, t = m.t;
  if (t == 'admin') return adminCmd(c, m);
  if (t == 'leave') return brLeave(c);
  if (t == 'st') { c.lastSt = Date.now(); if (c.out) return;
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) if (typeof m[k] == 'number' && isFinite(m[k])) c[k] = m[k];
    c.x = Math.max(-BR_MB, Math.min(BR_MB, c.x)); c.z = Math.max(-BR_MB, Math.min(BR_MB, c.z)); c.y = Math.max(-5, Math.min(80, c.y)); c.ws = m.s ? 1 : 0; return }
  if (c.out || M.ended) return;
  if (t == 'pick') { const d = M.drops.get(m.id | 0); if (!d || Math.hypot(c.x - d[2], c.z - d[3]) > 4.5) return;
    if (d[1] == 1 && c.sh >= 100) return; if (d[1] == 2 && c.hp >= 100) return;
    if (d[1] == 0) c.w = Math.random() * 4 | 0; else if (d[1] == 1) c.sh = Math.min(100, c.sh + 50); else c.hp = Math.min(100, c.hp + 50);
    M.drops.delete(d[0]); brBcast(M, { t: 'dpick', id: d[0], by: c.id }); return wsSend(c.sock, { t: 'got', type: d[1], w: c.w, hp: c.hp, sh: c.sh }) }
  if (t == 'shot') { if (c.w < 0) return; const w = WEAP[c.w], now = Date.now(); if (now - c.lastShot < w.r * 1000 * .75) return; c.lastShot = now;
    brNear(M, c, { t: 'fire', id: c.id, w: c.w }, 150);
    const hits = Array.isArray(m.hits) ? m.hits.slice(0, w.n) : [], tally = new Map();
    for (const h of hits) { if (!Array.isArray(h)) continue; const v = [...M.players].find(p => p.id === h[0]); if (!v || v === c || v.out || v.team === c.team || dist(c, v) > w.rng + 8) continue;
      const e = tally.get(v) || { dmg: 0, hd: false }; e.dmg += h[1] ? w.h : w.d; e.hd = e.hd || !!h[1]; tally.set(v, e) }
    for (const [v, e] of tally) brDamage(M, c, v, e.dmg, e.hd, false); return }
  if (t == 'throw') { brNear(M, c, { t: 'throw', id: c.id, to: m.to | 0, knife: s.knife || 'gut' }, 120); return }
  if (t == 'knife') { const now = Date.now(); if (now - c.lastKnife < KNIFE_CD) return; const v = [...M.players].find(p => p.id === m.id);
    if (!v || v === c || v.team === c.team || dist(c, v) > 65) return; c.lastKnife = now; brDamage(M, c, v, BR_KNIFE_DMG, false, true); return }
}
function adminCmd(c, m) {
  const reply = msg => wsSend(c.sock, { t: 'admin_msg', msg });
  if (!isAdmin(c)) return reply('You are not an admin.');
  const s = db.users[c.user].save, cmd = m.cmd;
  if (cmd == 'coins') { const n = Math.max(0, Math.min(1e6, m.n | 0)); s.coins += n; markDirty(); sendSave(c); return reply('Added ' + n + ' coins. You now have ' + s.coins + '.') }
  if (cmd == 'elo') { const v = Math.max(0, Math.min(999999, Math.round(+m.v || 0))); s.elo = v; markDirty(); boardDirty = true; sendSave(c); return reply('ELO set to ' + v + '.') }
  if (cmd == 'gskin') { if (!(m.id in GUN_SKINS)) return; s.guns = s.guns || {}; s.gsk = s.gsk || {}; s.guns[m.id] = (s.guns[m.id] || 0) + 1; const w = String(GUN_SKINS[m.id][0]); if (!s.gsk[w]) s.gsk[w] = m.id; markDirty(); sendSave(c); return reply('Gun skin added.') }
  if (cmd == 'give') {
    const u = String(m.user || '').toLowerCase().trim(), acc = db.users[u]; if (!acc) return reply('No player called ' + (m.user || '?') + '.'); const t = acc.save, k = m.kind;
    if (k == 'coins') { const n = Math.max(1, Math.min(1e6, m.n | 0)); t.coins += n }
    else if (k == 'knife') { if (!(m.id in KNIVES)) return; t.inv[m.id] = (t.inv[m.id] || 0) + 1; if (!t.knife) t.knife = m.id }
    else if (k == 'skin') { if (!(m.id in SKIN_R) && !SPECIAL_SKINS.includes(m.id)) return; t.skins = t.skins || {}; t.skins[m.id] = (t.skins[m.id] || 0) + 1 }
    else if (k == 'gskin') { if (!(m.id in GUN_SKINS)) return; t.guns = t.guns || {}; t.gsk = t.gsk || {}; t.guns[m.id] = (t.guns[m.id] || 0) + 1; const w = String(GUN_SKINS[m.id][0]); if (!t.gsk[w]) t.gsk[w] = m.id }
    else return; markDirty(); for (const o of clients) if (o.user === u) { sendSave(o); wsSend(o.sock, { t: 'gift', from: brName(c), kind: k, id: m.id || null, n: k == 'coins' ? Math.max(1, Math.min(1e6, m.n | 0)) : 0 }) }
    return reply('Gave ' + (k == 'coins' ? (m.n | 0) + ' coins' : m.id) + ' to ' + t.name + '.');
  }
  if (cmd == 'coinsall') { const n = [100, 500, 1000].includes(m.n | 0) ? m.n | 0 : 0; if (!n) return; let k = 0;
    for (const u in db.users) { if (db.users[u].banned) continue; db.users[u].save.coins += n; k++ } markDirty();
    for (const o of clients) if (o.user) { sendSave(o); wsSend(o.sock, { t: 'ann', text: brName(c) + ' gave out ' + n + ' coins to everyone!' }) }
    return reply('Gave ' + n + ' coins to all ' + k + ' players.') }
  if (cmd == 'skin') { if (!(m.id in SKIN_R) && !SPECIAL_SKINS.includes(m.id)) return; s.skins = s.skins || {}; s.skins[m.id] = (s.skins[m.id] || 0) + 1; markDirty(); sendSave(c); return reply('Skin added.') }
  if (cmd == 'knife') { if (!(m.id in KNIVES)) return; s.inv[m.id] = (s.inv[m.id] || 0) + 1; if (!s.knife) s.knife = m.id; markDirty(); sendSave(c); return reply('Knife added.') }
  if (cmd == 'heal' || cmd == 'hp' || cmd == 'god') {
    if ((!c.lobby && !c.br) || c.dead) return reply('Join a match first.');
    if (cmd == 'heal') c.hp = 100; if (cmd == 'hp') c.hp = 500; if (cmd == 'god') c.god = !c.god;
    return reply(cmd == 'god' ? 'God mode ' + (c.god ? 'ON' : 'OFF') + '.' : 'Health set to ' + c.hp + '.');
  }
  if (cmd == 'map') { if (!MAPS.includes(m.k)) return; forced = { k: m.k, slot: curSlot }; bcastAll({ t: 'map', k: m.k, slot: curSlot }); return reply('Every lobby is now on ' + m.k + ' until the next rotation.') }
  if (cmd == 'brnow') { const n = startBR('admin'); return reply(n ? 'Battle royale started (' + n + ' match' + (n > 1 ? 'es' : '') + ').' : 'Need at least 2 teams in the queue to start.') }
  if (cmd == 'update_post' || cmd == 'update_del') { // daily sum-ups for the UPDATES log
    const d = String(m.d || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return reply('Bad date.');
    if (cmd == 'update_del') db.updates = db.updates.filter(e => e.d !== d);
    else { const items = (Array.isArray(m.items) ? m.items : []).map(x => String(x).trim().slice(0, 140)).filter(Boolean).slice(0, 12); if (!items.length) return reply('Write at least one line first.');
      let e = db.updates.find(e => e.d === d); if (!e) { e = { d, items: [] }; db.updates.push(e) } for (const it of items) if (!e.items.includes(it) && e.items.length < 30) e.items.push(it);
      db.updates.sort((a, b) => a.d.localeCompare(b.d)); db.updates = db.updates.slice(-60) }
    markDirty(); for (const o of clients) if (o.user) wsSend(o.sock, { t: 'updates', list: db.updates });
    return reply(cmd == 'update_del' ? 'Removed the post for ' + d + '.' : 'Posted to the update log for ' + d + '. Everyone sees it now.') }
  if (cmd == 'announce') { const text = String(m.text || '').slice(0, 120).trim(); if (!text) return; for (const o of clients) if (o.user) wsSend(o.sock, { t: 'ann', text }); return reply('Announcement sent to ' + [...clients].filter(o => o.user).length + ' players.') }
  if (cmd == 'ban' || cmd == 'unban') {
    const u = String(m.user || '').toLowerCase(), acc = db.users[u]; if (!acc) return reply('No player called ' + m.user + '.'); if (u === ADMIN) return reply("You can't ban the admin.");
    if (cmd == 'ban') { acc.banned = { reason: String(m.reason || '').slice(0, 60), t: Date.now() }; for (const k in db.tokens) if (db.tokens[k].u === u) delete db.tokens[k];
      for (const o of clients) if (o.user === u) { wsSend(o.sock, { t: 'banned', reason: acc.banned.reason }); leaveLobby(o); o.user = null } }
    else acc.banned = null;
    markDirty(); boardDirty = true; reply(acc.save.user + (cmd == 'ban' ? ' is banned.' : ' is unbanned.'));
  }
  if (cmd == 'ban' || cmd == 'unban' || cmd == 'bans') return wsSend(c.sock, { t: 'bans', list: Object.values(db.users).filter(u => u.banned).map(u => ({ user: u.save.user, reason: u.banned.reason })) });
  if (cmd == 'export') return wsSend(c.sock, { t: 'export', data: { version: 1, made: new Date().toISOString(), users: db.users } });
  if (cmd == 'import') {
    const users = m.data && m.data.users; if (!users || typeof users != 'object') return reply('That is not a Pixel Strike server backup.');
    let n = 0; for (const u in users) { const a = users[u]; if (a && a.salt && a.hash && a.save) { db.users[u] = a; n++ } } markDirty(); boardDirty = true; persist(true); return reply('Restored ' + n + ' players.');
  }
}

// ---------------- http ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url == '/api/ping') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ pixelstrike: 1, players: [...clients].filter(c => c.user).length })) }
  let file = path.normalize(path.join(PUBLIC, url == '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end() }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found') }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext == '.html' || ext == '.js' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
});
server.on('upgrade', (req, sock) => {
  if ((req.url || '').split('?')[0] !== '/ws') return sock.destroy();
  const c = { id: nextId++, sock, user: null, lobby: null, ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() };
  clients.add(c);
  wsAccept(req, sock, m => handle(c, m), () => { leaveLobby(c); brLeave(c, 'left'); brQueue.delete(c); leaveParty(c); clients.delete(c) });
});
async function shutdown() { console.log('Saving before shutdown…'); await persist(true); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
load().then(() => server.listen(PORT, () => console.log('Pixel Strike server running on port ' + PORT + ' · admin: ' + ADMIN + ' · storage: ' + (UP_URL ? 'Upstash' : DATA_FILE))));
