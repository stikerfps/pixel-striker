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
const LOBBY_MAX = 10, TICK_MS = 66, KEY = 'pixelstrike:db';

// ---------------- game rules (must match the client) ----------------
const RANKS = [[0, 3], [400, 6], [800, 9], [1400, 12], [2200, 15], [3200, 18], [7000, 20], [15000, 25]];
const rankIdx = e => { let r = 0; RANKS.forEach((x, i) => { if (e >= x[0]) r = i }); return r };
const killGain = e => { const i = rankIdx(e); return i <= 2 ? 35 : i <= 5 ? 30 : 28 };
const WEAP = [{ d: 18, h: 34, r: .14, rng: 90, n: 1 }, { d: 100, h: 150, r: 1.1, rng: 220, n: 1 }, { d: 9, h: 16, r: .85, rng: 28, n: 8 }, { d: 11, h: 20, r: .07, rng: 55, n: 1 }];
const KNIVES = { gut: 0, combat: 1, kukri: 2, m9: 3, kara: 4, skel: 4, bfo: 5, bfe: 5 };
const ODDS = [41, 35, 15, 5, 3, 1], CRATE_COST = 100, KNIFE_DMG = 100, KNIFE_CD = 2800;
const MAPS = ['snow', 'desert', 'arena'];
const slotNow = () => Math.floor(Date.now() / 18e4);
const hh = s => Math.imul(s, 2654435761) >>> 0;
const mapIdx = s => { const a = hh(s) % 3; return a == hh(s - 1) % 3 ? (a + 1) % 3 : a };
function rollKnife() { let r = Math.random() * 100, t = 0; for (; t < ODDS.length - 1; t++) { r -= ODDS[t]; if (r < 0) break }
  const pool = Object.keys(KNIVES).filter(k => KNIVES[k] == t); return pool[Math.random() * pool.length | 0] }

// ---------------- storage ----------------
let db = { users: {}, tokens: {} }, dirty = false;
const newSave = u => ({ user: u, name: u, elo: 0, coins: 0, inv: {}, knife: null, arm: 0, cls: 0, gfx: 1, sens: 1 });
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('Upstash HTTP ' + r.status); return (await r.json()).result }
async function load() {
  try {
    if (UP_URL && UP_TOKEN) { const s = await upstash(['GET', KEY]); if (s) db = JSON.parse(s); console.log('Loaded saves from Upstash:', Object.keys(db.users).length, 'players') }
    else if (fs.existsSync(DATA_FILE)) { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); console.log('Loaded saves from', DATA_FILE, ':', Object.keys(db.users).length, 'players') }
  } catch (e) { console.error('Could not load saves:', e.message); if (UP_URL) process.exit(1) }
  db.users = db.users || {}; db.tokens = db.tokens || {};
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
function pInfo(c) { const s = db.users[c.user].save; return { id: c.id, name: s.name, arm: s.arm, cls: s.cls, knife: s.knife } }
function joinLobby(c) {
  leaveLobby(c); let L = lobbies.find(l => l.players.size < LOBBY_MAX);
  if (!L) { L = { id: lobbies.length ? Math.max(...lobbies.map(l => l.id)) + 1 : 1, players: new Set() }; lobbies.push(L) }
  Object.assign(c, { lobby: L, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: db.users[c.user].save.cls == 2 ? 1 : 0, ws: 0, hp: 100, dead: 0, k: 0, d: 0, lastShot: 0, lastKnife: 0, god: false });
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
      if (c.dead && now >= c.dead) { c.dead = 0; c.hp = 100; wsSend(c.sock, { t: 'spawn' }) }
      p.push([c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yaw), r2(c.pitch), c.w, c.ws, c.hp, c.dead ? 1 : 0, c.k, c.d]);
    }
    if (p.length) bcast(L, { t: 'snap', p });
  }
}, TICK_MS);

// ---------------- leaderboard ----------------
let boardDirty = true;
function boardRows() { return Object.entries(db.users).filter(([, u]) => !u.banned).map(([id, u]) => ({ id, name: u.save.name, elo: u.save.elo })).sort((a, b) => b.elo - a.elo).slice(0, 50) }
setInterval(() => { if (boardDirty) { boardDirty = false; bcastAll({ t: 'board', rows: boardRows() }) } }, 2000);

// ---------------- combat ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function damage(att, vic, dmg, hd, kn) {
  if (vic.dead || vic.god || att.dead) return;
  vic.hp = Math.max(0, vic.hp - dmg); const L = att.lobby;
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
  for (const o of clients) if (o !== c && o.user === u) { wsSend(o.sock, { t: 'kicked', reason: 'You logged in somewhere else.' }); leaveLobby(o); o.user = null }
  c.user = u; const token = crypto.randomBytes(24).toString('hex'); db.tokens[token] = { u, t: Date.now() }; markDirty();
  wsSend(c.sock, { t: 'auth_ok', token, save: publicSave(u), admin: u === ADMIN }); wsSend(c.sock, { t: 'board', rows: boardRows() }); return true;
}
const isAdmin = c => c.user === ADMIN;
function handle(c, m) {
  if (typeof m !== 'object' || !m) return; const t = m.t;
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
  if (t == 'logout') { for (const k in db.tokens) if (db.tokens[k].u === c.user && k === m.token) delete db.tokens[k]; leaveLobby(c); c.user = null; markDirty(); return }
  if (t == 'set') {
    if (m.name != null) { const n = cleanName(m.name); if (n) s.name = n }
    if (Number.isInteger(m.arm) && m.arm >= 0 && m.arm < 8) s.arm = m.arm;
    if (Number.isInteger(m.cls) && m.cls >= 0 && m.cls < 4) s.cls = m.cls;
    if (Number.isInteger(m.gfx) && m.gfx >= 0 && m.gfx < 3) s.gfx = m.gfx;
    if (typeof m.sens == 'number' && m.sens >= .2 && m.sens <= 3) s.sens = Math.round(m.sens * 10) / 10;
    if (m.knife === null || (typeof m.knife == 'string' && s.inv[m.knife])) s.knife = m.knife;
    markDirty(); boardDirty = true; return;
  }
  if (t == 'crate') {
    if (s.coins < CRATE_COST) return wsSend(c.sock, { t: 'crate_err', msg: 'Not enough coins' });
    s.coins -= CRATE_COST; const k = rollKnife(); s.inv[k] = (s.inv[k] || 0) + 1; if (!s.knife) s.knife = k; markDirty();
    return wsSend(c.sock, { t: 'crate', item: k, save: publicSave(c.user) });
  }
  if (t == 'join') return joinLobby(c);
  if (t == 'leave') return leaveLobby(c);
  const L = c.lobby;
  if (t == 'st' && L) {
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) if (typeof m[k] == 'number' && isFinite(m[k])) c[k] = m[k];
    c.x = Math.max(-80, Math.min(80, c.x)); c.z = Math.max(-80, Math.min(80, c.z)); c.y = Math.max(-5, Math.min(60, c.y));
    if (Number.isInteger(m.w) && m.w >= 0 && m.w < 4) c.w = m.w; c.ws = m.s ? 1 : 0; return;
  }
  if (t == 'shot' && L && !c.dead) {
    const w = WEAP[c.w], now = Date.now(); if (now - c.lastShot < w.r * 1000 * .75) return; c.lastShot = now;
    bcast(L, { t: 'fire', id: c.id, w: c.w }, c);
    const hits = Array.isArray(m.hits) ? m.hits.slice(0, w.n) : [], tally = new Map();
    for (const h of hits) { if (!Array.isArray(h)) continue; const v = [...L.players].find(p => p.id === h[0]); if (!v || v === c || v.dead || dist(c, v) > w.rng + 8) continue;
      const e = tally.get(v) || { dmg: 0, hd: false }; e.dmg += h[1] ? w.h : w.d; e.hd = e.hd || !!h[1]; tally.set(v, e) }
    for (const [v, e] of tally) damage(c, v, e.dmg, e.hd, false); return;
  }
  if (t == 'throw' && L && !c.dead) { if (!s.knife) return; bcast(L, { t: 'throw', id: c.id, to: m.to | 0, knife: s.knife }, c); return }
  if (t == 'knife' && L && !c.dead) {
    const now = Date.now(); if (!s.knife || now - c.lastKnife < KNIFE_CD) return; const v = [...L.players].find(p => p.id === m.id);
    if (!v || v === c || dist(c, v) > 65) return; c.lastKnife = now; damage(c, v, KNIFE_DMG, false, true); return;
  }
  if (t == 'admin') return adminCmd(c, m);
}
function adminCmd(c, m) {
  const reply = msg => wsSend(c.sock, { t: 'admin_msg', msg });
  if (!isAdmin(c)) return reply('You are not an admin.');
  const s = db.users[c.user].save, cmd = m.cmd;
  if (cmd == 'coins') { const n = Math.max(0, Math.min(1e6, m.n | 0)); s.coins += n; markDirty(); sendSave(c); return reply('Added ' + n + ' coins. You now have ' + s.coins + '.') }
  if (cmd == 'elo') { const v = Math.max(0, Math.min(999999, Math.round(+m.v || 0))); s.elo = v; markDirty(); boardDirty = true; sendSave(c); return reply('ELO set to ' + v + '.') }
  if (cmd == 'knife') { if (!(m.id in KNIVES)) return; s.inv[m.id] = (s.inv[m.id] || 0) + 1; if (!s.knife) s.knife = m.id; markDirty(); sendSave(c); return reply('Knife added.') }
  if (cmd == 'heal' || cmd == 'hp' || cmd == 'god') {
    if (!c.lobby || c.dead) return reply('Join a match first.');
    if (cmd == 'heal') c.hp = 100; if (cmd == 'hp') c.hp = 500; if (cmd == 'god') c.god = !c.god;
    return reply(cmd == 'god' ? 'God mode ' + (c.god ? 'ON' : 'OFF') + '.' : 'Health set to ' + c.hp + '.');
  }
  if (cmd == 'map') { if (!MAPS.includes(m.k)) return; forced = { k: m.k, slot: curSlot }; bcastAll({ t: 'map', k: m.k, slot: curSlot }); return reply('Every lobby is now on ' + m.k + ' until the next rotation.') }
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
  wsAccept(req, sock, m => handle(c, m), () => { leaveLobby(c); clients.delete(c) });
});
async function shutdown() { console.log('Saving before shutdown…'); await persist(true); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
load().then(() => server.listen(PORT, () => console.log('Pixel Strike server running on port ' + PORT + ' · admin: ' + ADMIN + ' · storage: ' + (UP_URL ? 'Upstash' : DATA_FILE))));
