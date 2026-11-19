// ===== Blood Bank Management System - server.js =====
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new DatabaseSync(path.join(__dirname, 'bloodbank_v2.db'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DATABASE ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, fullname TEXT, password TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS donors(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, blood_group TEXT NOT NULL, phone TEXT DEFAULT '', city TEXT DEFAULT '', gender TEXT, dob TEXT, weight REAL, last_donation TEXT, total_donations INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS donations(id INTEGER PRIMARY KEY AUTOINCREMENT, donor_id INTEGER, date TEXT, component TEXT, hemoglobin REAL, weight REAL, bp TEXT, result TEXT, reason TEXT, bag_id INTEGER);
CREATE TABLE IF NOT EXISTS stock(id INTEGER PRIMARY KEY AUTOINCREMENT, blood_group TEXT NOT NULL, component TEXT NOT NULL, collected TEXT NOT NULL, expiry TEXT NOT NULL, status TEXT DEFAULT 'available', donor_id INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS hospitals(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT, phone TEXT);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT, patient TEXT NOT NULL, blood_group TEXT NOT NULL, component TEXT DEFAULT 'Whole Blood', units INTEGER NOT NULL, priority INTEGER NOT NULL, hospital TEXT, doctor TEXT, contact TEXT, status TEXT DEFAULT 'pending', issued_bags TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS camps(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, location TEXT, date TEXT, expected INTEGER DEFAULT 0, collected INTEGER DEFAULT 0, status TEXT DEFAULT 'upcoming');
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, action TEXT, time TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// ---------- CONSTANTS ----------
// key = patient's group, value = groups that can GIVE red cells to that patient
const COMPAT = {
  'A+': ['A+', 'A-', 'O+', 'O-'], 'A-': ['A-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'], 'B-': ['B-', 'O-'],
  'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  'AB-': ['A-', 'B-', 'AB-', 'O-'],
  'O+': ['O+', 'O-'], 'O-': ['O-'],
};
const GROUPS = Object.keys(COMPAT);
const SHELF = { 'Whole Blood': 35, 'RBC': 42, 'Platelets': 5, 'Plasma': 365 }; // days
const LOW = 5; // low stock alert level

// ---------- HELPERS ----------
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);
const ageOf = dob => dob ? Math.floor(daysBetween(dob, today()) / 365.25) : null;
const isEligible = d => !d.last_donation || daysBetween(d.last_donation, today()) >= 90;
const fail = (res, msg, code = 400) => res.status(code).json({ ok: false, msg });
const log = (u, a) => db.prepare('INSERT INTO logs(username,action) VALUES(?,?)').run(u, a);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function addUser(username, fullname, pw, role) {
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO users(username,fullname,password,salt,role) VALUES(?,?,?,?,?)')
    .run(username, fullname, hashPw(pw, salt), salt, role);
}
if (!db.prepare('SELECT COUNT(*) c FROM users').get().c) {
  addUser('admin', 'Administrator', 'admin123', 'admin');
  addUser('staff', 'Lab Staff', 'staff123', 'staff');
}

// ---------- PRIORITY QUEUE (Min-Heap) ----------
// priority 1 = Emergency, 2 = Urgent, 3 = Normal. Same priority -> older request first.
class PriorityQueue {
  constructor() { this.heap = []; }
  peek() { return this.heap[0] || null; }
  less(a, b) { return a.priority < b.priority || (a.priority === b.priority && a.id < b.id); }
  push(item) {
    this.heap.push(item);
    let i = this.heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.heap[i], this.heap[p])) break;
      [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
      i = p;
    }
  }
  pop() {
    if (!this.heap.length) return null;
    const top = this.heap[0], last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.heap.length && this.less(this.heap[l], this.heap[m])) m = l;
        if (r < this.heap.length && this.less(this.heap[r], this.heap[m])) m = r;
        if (m === i) break;
        [this.heap[i], this.heap[m]] = [this.heap[m], this.heap[i]];
        i = m;
      }
    }
    return top;
  }
  rebuild() {   // reload all pending requests from database
    this.heap = [];
    db.prepare("SELECT * FROM requests WHERE status='pending'").all().forEach(r => this.push(r));
  }
}
const queue = new PriorityQueue();
queue.rebuild();

// ---------- LOGIN + AUTH ----------
const sessions = new Map();
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || hashPw(password || '', u.salt) !== u.password) return fail(res, 'Wrong username or password', 401);
  const token = crypto.randomBytes(16).toString('hex');
  const user = { id: u.id, username: u.username, role: u.role, fullname: u.fullname };
  sessions.set(token, user);
  log(u.username, 'Logged in');
  res.json({ ok: true, token, user });
});

// every /api route below needs login
app.use('/api', (req, res, next) => {
  const s = sessions.get(req.headers['x-token']);
  if (!s) return fail(res, 'Please login', 401);
  req.user = s;
  db.prepare("UPDATE stock SET status='expired' WHERE status='available' AND expiry<?").run(today()); // auto-expire
  next();
});
const admin = (req, res, next) => req.user.role === 'admin' ? next() : fail(res, 'Admin only', 403);

app.get('/api/me', (req, res) => res.json(req.user));
app.post('/api/logout', (req, res) => { sessions.delete(req.headers['x-token']); res.json({ ok: true }); });

app.post('/api/password', (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (hashPw(oldPassword || '', u.salt) !== u.password) return fail(res, 'Old password is wrong');
  if (!newPassword || newPassword.length < 4) return fail(res, 'New password too short (min 4)');
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare('UPDATE users SET password=?, salt=? WHERE id=?').run(hashPw(newPassword, salt), salt, u.id);
  log(u.username, 'Changed password');
  res.json({ ok: true, msg: 'Password changed' });
});

// ---------- USERS (admin) ----------
app.get('/api/users', admin, (req, res) => res.json(db.prepare('SELECT id,username,fullname,role FROM users').all()));
app.post('/api/users', admin, (req, res) => {
  const { username, fullname, password, role } = req.body;
  if (!username || !password || !['admin', 'staff'].includes(role)) return fail(res, 'Fill all fields');
  try { addUser(username, fullname || '', password, role); } catch (e) { return fail(res, 'Username already exists'); }
  log(req.user.username, 'Created user ' + username);
  res.json({ ok: true, msg: 'User created' });
});
app.delete('/api/users/:id', admin, (req, res) => {
  if (+req.params.id === req.user.id) return fail(res, 'You cannot delete yourself');
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  log(req.user.username, 'Deleted user #' + req.params.id);
  res.json({ ok: true, msg: 'User deleted' });
});

// ---------- DONORS ----------
app.get('/api/donors', (req, res) => {
  const { q = '', group = '', city = '' } = req.query;
  const rows = db.prepare(
    "SELECT * FROM donors WHERE (name LIKE ? OR phone LIKE ?) AND (?='' OR blood_group=?) AND city LIKE ? ORDER BY id DESC"
  ).all(`%${q}%`, `%${q}%`, group, group, `%${city}%`);
  rows.forEach(d => { d.eligible = isEligible(d); d.age = ageOf(d.dob); });
  res.json(rows);
});

app.post('/api/donors', (req, res) => {
  const { name, blood_group, phone, city, gender, dob, weight } = req.body;
  if (!name || !COMPAT[blood_group]) return fail(res, 'Name and valid blood group required');
  db.prepare('INSERT INTO donors(name,blood_group,phone,city,gender,dob,weight) VALUES(?,?,?,?,?,?,?)')
    .run(name, blood_group, phone || '', city || '', gender || '', dob || null, parseFloat(weight) || null);
  log(req.user.username, 'Added donor ' + name);
  res.json({ ok: true, msg: 'Donor added' });
});

app.put('/api/donors/:id', (req, res) => {
  const { name, phone, city } = req.body;
  if (!name) return fail(res, 'Name required');
  db.prepare('UPDATE donors SET name=?, phone=?, city=? WHERE id=?').run(name, phone || '', city || '', req.params.id);
  log(req.user.username, 'Edited donor #' + req.params.id);
  res.json({ ok: true, msg: 'Donor updated' });
});

app.delete('/api/donors/:id', admin, (req, res) => {
  db.prepare('DELETE FROM donors WHERE id=?').run(req.params.id);
  log(req.user.username, 'Deleted donor #' + req.params.id);
  res.json({ ok: true, msg: 'Donor deleted' });
});

app.get('/api/donors/:id/history', (req, res) => {
  res.json(db.prepare('SELECT * FROM donations WHERE donor_id=? ORDER BY id DESC').all(req.params.id));
});

// Donation = screening test + (if passed) one bag added to stock
app.post('/api/donors/:id/donate', (req, res) => {
  const d = db.prepare('SELECT * FROM donors WHERE id=?').get(req.params.id);
  if (!d) return fail(res, 'Donor not found', 404);
  const hb = parseFloat(req.body.hemoglobin), w = parseFloat(req.body.weight);
  const comp = SHELF[req.body.component] ? req.body.component : 'Whole Blood';
  const bp = req.body.bp || '', t = today(), age = ageOf(d.dob);
  let reason = null;
  if (age !== null && (age < 18 || age > 65)) reason = `Age ${age} not allowed (must be 18-65)`;
  else if (!(w >= 50)) reason = 'Weight must be at least 50 kg';
  else if (!(hb >= 12.5)) reason = 'Hemoglobin must be at least 12.5 g/dL';
  else if (d.last_donation && daysBetween(d.last_donation, t) < 90)
    reason = `Last donation was only ${daysBetween(d.last_donation, t)} days ago (need 90)`;

  const ins = db.prepare('INSERT INTO donations(donor_id,date,component,hemoglobin,weight,bp,result,reason,bag_id) VALUES(?,?,?,?,?,?,?,?,?)');
  if (reason) {
    ins.run(d.id, t, comp, hb || null, w || null, bp, 'deferred', reason, null);
    log(req.user.username, `Donor ${d.name} deferred: ${reason}`);
    return fail(res, 'Deferred: ' + reason);
  }
  const bag = db.prepare('INSERT INTO stock(blood_group,component,collected,expiry,donor_id) VALUES(?,?,?,?,?)')
    .run(d.blood_group, comp, t, addDays(t, SHELF[comp]), d.id);
  ins.run(d.id, t, comp, hb, w, bp, 'accepted', null, Number(bag.lastInsertRowid));
  db.prepare('UPDATE donors SET last_donation=?, total_donations=total_donations+1, weight=? WHERE id=?').run(t, w, d.id);
  log(req.user.username, `Donation from ${d.name}: BAG-${bag.lastInsertRowid} (${d.blood_group} ${comp})`);
  res.json({ ok: true, msg: `Donation accepted. BAG-${bag.lastInsertRowid} added to stock.` });
});

// Emergency donor finder: eligible donors who can give to a patient group
app.get('/api/finder', (req, res) => {
  const { group, city = '' } = req.query;
  if (!COMPAT[group]) return fail(res, 'Select a blood group');
  const g = COMPAT[group];
  const rows = db.prepare(`SELECT * FROM donors WHERE blood_group IN (${g.map(() => '?').join(',')}) AND city LIKE ?`)
    .all(...g, `%${city}%`).filter(isEligible);
  rows.sort((a, b) => (b.blood_group === group) - (a.blood_group === group));
  res.json(rows);
});

// ---------- STOCK ----------
app.get('/api/stock/summary', (req, res) => {
  res.json(db.prepare("SELECT blood_group, component, COUNT(*) n FROM stock WHERE status='available' GROUP BY blood_group, component").all());
});

app.get('/api/stock', (req, res) => {
  const { status = 'available', group = '', component = '' } = req.query;
  res.json(db.prepare(
    "SELECT * FROM stock WHERE (?='all' OR status=?) AND (?='' OR blood_group=?) AND (?='' OR component=?) ORDER BY expiry ASC LIMIT 300"
  ).all(status, status, group, group, component, component));
});

app.post('/api/stock', (req, res) => {
  const { blood_group, component } = req.body, n = parseInt(req.body.units);
  if (!COMPAT[blood_group] || !SHELF[component] || !(n > 0)) return fail(res, 'Valid group, component and units required');
  const ins = db.prepare('INSERT INTO stock(blood_group,component,collected,expiry) VALUES(?,?,?,?)');
  for (let i = 0; i < n; i++) ins.run(blood_group, component, today(), addDays(today(), SHELF[component]));
  log(req.user.username, `Added ${n} bag(s) ${blood_group} ${component}`);
  res.json({ ok: true, msg: `${n} bag(s) added` });
});

app.post('/api/stock/:id/discard', (req, res) => {
  const reason = req.body.reason || 'No reason';
  const r = db.prepare("UPDATE stock SET status='discarded', note=? WHERE id=? AND status IN ('available','expired')")
    .run(reason, req.params.id);
  if (!r.changes) return fail(res, 'Bag cannot be discarded');
  log(req.user.username, `Discarded BAG-${req.params.id}: ${reason}`);
  res.json({ ok: true, msg: 'Bag discarded' });
});

// ---------- REQUESTS ----------
app.get('/api/requests', (req, res) => {
  const s = req.query.status || 'all';
  res.json(db.prepare(
    "SELECT * FROM requests WHERE (?='all' OR status=?) ORDER BY (status='pending') DESC, priority ASC, id ASC LIMIT 300"
  ).all(s, s));
});

app.post('/api/requests', (req, res) => {
  const { patient, blood_group, component, hospital, doctor, contact } = req.body;
  const n = parseInt(req.body.units), p = parseInt(req.body.priority);
  if (!patient || !COMPAT[blood_group] || !SHELF[component] || !(n > 0) || ![1, 2, 3].includes(p))
    return fail(res, 'Fill all required fields correctly');
  const info = db.prepare('INSERT INTO requests(patient,blood_group,component,units,priority,hospital,doctor,contact) VALUES(?,?,?,?,?,?,?,?)')
    .run(patient, blood_group, component, n, p, hospital || '', doctor || '', contact || '');
  queue.push(db.prepare('SELECT * FROM requests WHERE id=?').get(info.lastInsertRowid));
  log(req.user.username, `New request #${info.lastInsertRowid} for ${patient} (${blood_group} ${component} x${n})`);
  res.json({ ok: true, msg: 'Request added to priority queue' });
});

// Serve the request at the front of the priority queue
function serve(user) {
  const r = queue.peek();
  if (!r) return { ok: false, msg: 'No pending requests' };
  // Plasma compatibility is the reverse of red cells (simplified)
  const groups = r.component === 'Plasma' ? GROUPS.filter(d => COMPAT[d].includes(r.blood_group)) : COMPAT[r.blood_group];
  const marks = groups.map(() => '?').join(',');
  const bags = db.prepare(
    `SELECT * FROM stock WHERE status='available' AND expiry>=? AND component=? AND blood_group IN (${marks})
     ORDER BY (blood_group=?) DESC, expiry ASC`
  ).all(today(), r.component, ...groups, r.blood_group);
  if (bags.length < r.units)
    return { ok: false, msg: `Cannot serve ${r.patient}: needs ${r.units} ${r.component}, only ${bags.length} compatible in stock.` };
  const used = bags.slice(0, r.units);
  db.exec('BEGIN');
  try {
    used.forEach(b => db.prepare("UPDATE stock SET status='used' WHERE id=?").run(b.id));
    db.prepare("UPDATE requests SET status='fulfilled', issued_bags=? WHERE id=?")
      .run(used.map(b => 'BAG-' + b.id).join(', '), r.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  queue.pop();
  log(user, `Issued ${r.units} ${r.component} to ${r.patient} (${r.hospital || '-'})`);
  return { ok: true, msg: `Served ${r.patient}: ${used.map(b => `BAG-${b.id} (${b.blood_group})`).join(', ')}` };
}

app.post('/api/requests/process', (req, res) => res.json(serve(req.user.username)));

app.post('/api/requests/process-all', (req, res) => {
  const msgs = [];
  for (let i = 0; i < 100; i++) {
    const r = serve(req.user.username);
    msgs.push(r.msg);
    if (!r.ok) break;
  }
  res.json({ ok: msgs.length > 1, msg: msgs.join(' | ') });
});

app.post('/api/requests/:id/:action', (req, res) => {
  const map = { reject: 'rejected', cancel: 'cancelled' };
  const st = map[req.params.action];
  if (!st) return fail(res, 'Unknown action');
  const r = db.prepare("UPDATE requests SET status=? WHERE id=? AND status='pending'").run(st, req.params.id);
  if (!r.changes) return fail(res, 'Only pending requests can be changed');
  queue.rebuild();
  log(req.user.username, `Request #${req.params.id} ${st}`);
  res.json({ ok: true, msg: 'Request ' + st });
});

// ---------- HOSPITALS ----------
app.get('/api/hospitals', (req, res) => res.json(db.prepare('SELECT * FROM hospitals ORDER BY name').all()));
app.post('/api/hospitals', (req, res) => {
  const { name, city, phone } = req.body;
  if (!name) return fail(res, 'Hospital name required');
  db.prepare('INSERT INTO hospitals(name,city,phone) VALUES(?,?,?)').run(name, city || '', phone || '');
  log(req.user.username, 'Added hospital ' + name);
  res.json({ ok: true, msg: 'Hospital added' });
});
app.delete('/api/hospitals/:id', admin, (req, res) => {
  db.prepare('DELETE FROM hospitals WHERE id=?').run(req.params.id);
  res.json({ ok: true, msg: 'Hospital deleted' });
});

// ---------- BLOOD CAMPS ----------
app.get('/api/camps', (req, res) => res.json(db.prepare('SELECT * FROM camps ORDER BY date DESC').all()));
app.post('/api/camps', (req, res) => {
  const { title, location, date, expected } = req.body;
  if (!title || !date) return fail(res, 'Title and date required');
  db.prepare('INSERT INTO camps(title,location,date,expected) VALUES(?,?,?,?)').run(title, location || '', date, parseInt(expected) || 0);
  log(req.user.username, 'Created camp ' + title);
  res.json({ ok: true, msg: 'Camp created' });
});
app.post('/api/camps/:id/complete', (req, res) => {
  db.prepare("UPDATE camps SET status='completed', collected=? WHERE id=?").run(parseInt(req.body.collected) || 0, req.params.id);
  log(req.user.username, 'Completed camp #' + req.params.id);
  res.json({ ok: true, msg: 'Camp marked completed' });
});
app.delete('/api/camps/:id', admin, (req, res) => {
  db.prepare('DELETE FROM camps WHERE id=?').run(req.params.id);
  res.json({ ok: true, msg: 'Camp deleted' });
});

// ---------- DASHBOARD ----------
app.get('/api/dashboard', (req, res) => {
  const soon = addDays(today(), 7);
  const c = (sql, ...p) => db.prepare(sql).get(...p).c;
  const byGroup = GROUPS.map(g => ({ group: g, count: c("SELECT COUNT(*) c FROM stock WHERE blood_group=? AND status='available'", g) }));
  const alerts = [];
  byGroup.forEach(b => {
    if (b.count === 0) alerts.push({ level: 'danger', text: `${b.group} stock is EMPTY` });
    else if (b.count <= LOW) alerts.push({ level: 'warn', text: `${b.group} stock is low (${b.count} bags)` });
  });
  const soonN = c("SELECT COUNT(*) c FROM stock WHERE status='available' AND expiry<=?", soon);
  if (soonN) alerts.push({ level: 'warn', text: `${soonN} bag(s) will expire within 7 days` });
  const em = c("SELECT COUNT(*) c FROM requests WHERE status='pending' AND priority=1");
  if (em) alerts.push({ level: 'danger', text: `${em} EMERGENCY request(s) waiting` });
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().slice(0, 7);
    monthly.push({ month: m, count: c("SELECT COUNT(*) c FROM donations WHERE result='accepted' AND substr(date,1,7)=?", m) });
  }
  res.json({
    totals: {
      donors: c('SELECT COUNT(*) c FROM donors'),
      available: c("SELECT COUNT(*) c FROM stock WHERE status='available'"),
      pending: c("SELECT COUNT(*) c FROM requests WHERE status='pending'"),
      fulfilled: c("SELECT COUNT(*) c FROM requests WHERE status='fulfilled'"),
      expiringSoon: soonN,
      camps: c("SELECT COUNT(*) c FROM camps WHERE status='upcoming'"),
    },
    byGroup, alerts, monthly,
    logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 8').all(),
  });
});

// ---------- LOGS + CSV EXPORT ----------
app.get('/api/logs', admin, (req, res) => res.json(db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all()));

app.get('/api/export/:t', (req, res) => {
  const ok = ['donors', 'donations', 'stock', 'requests', 'camps'];
  if (!ok.includes(req.params.t)) return fail(res, 'Unknown table', 404);
  const rows = db.prepare(`SELECT * FROM ${req.params.t}`).all();
  if (!rows.length) return res.type('text/csv').send('No data');
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g, '""') + '"').join(','))].join('\n');
  res.type('text/csv').send(csv);
});

app.listen(3000, () => console.log('Open http://localhost:3000'));
