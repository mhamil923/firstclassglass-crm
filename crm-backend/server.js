// ─── IMPORTS ─────────────────────────────────────────────────────────────────
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const mysql      = require('mysql2/promise');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const AWS        = require('aws-sdk');    // v2 (works with multer-s3)
const multerS3   = require('multer-s3');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');

process.env.TZ = process.env.APP_TZ || 'America/Chicago';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const {
  DB_HOST     = 'localhost',
  DB_NAME     = 'firstclassglass_crm',
  DB_USER     = 'root',
  DB_PASS     = '',
  DB_PORT     = '3306',
  JWT_SECRET  = 'supersecretjwtkey',
  S3_BUCKET,
  AWS_REGION = 'us-east-2',
  ASSIGNEE_EXTRA_USERNAMES = 'Jeff,tech1',
  DEFAULT_WINDOW_MINUTES = '120',
  // New toggles
  FILES_VERBOSE = process.env.FILES_VERBOSE || '0',
} = process.env;

const DEFAULT_WINDOW = Math.max(15, Number(DEFAULT_WINDOW_MINUTES) || 120);
const S3_SIGNED_TTL = Number(process.env.S3_SIGNED_TTL || 900);

// ⬆️ Limits (env overridable)
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 75);
const MAX_FILES_PER_REQUEST = Number(process.env.MAX_FILES_PER_REQUEST || process.env.MAX_FILES || 300);
const MAX_FIELDS       = Number(process.env.MAX_FIELDS || 500);
const MAX_PARTS        = Number(process.env.MAX_PARTS  || 2000);

if (S3_BUCKET) AWS.config.update({ region: AWS_REGION });
else console.warn('⚠️ S3_BUCKET not set; using local disk for uploads.');
const s3 = new AWS.S3();

// ─── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

// ─── MYSQL ──────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
  port: Number(DB_PORT), waitForConnections: true, connectionLimit: 10, dateStrings: true,
});

// ─── SMALL UTILITIES ─────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function toSqlDateTimeFromParts(Y, M, D, h = 0, m = 0, s = 0) {
  return `${Y}-${pad2(M)}-${pad2(D)} ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
function addMinutesToSql(sqlStr, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(sqlStr);
  if (!m) return sqlStr;
  const Y = Number(m[1]), Mo = Number(m[2]), D = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] || 0);
  const d = new Date(Y, Mo - 1, D, h, mi, s);
  d.setMinutes(d.getMinutes() + minutes);
  return toSqlDateTimeFromParts(
    d.getFullYear(), d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds()
  );
}
function roundUpDateToHour(d) {
  const r = new Date(d.getTime());
  if (r.getMinutes() > 0 || r.getSeconds() > 0 || r.getMilliseconds() > 0) {
    r.setHours(r.getHours() + 1);
  }
  r.setMinutes(0, 0, 0);
  return r;
}
function roundSqlUpToHour(sqlStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(sqlStr || '');
  if (!m) return sqlStr;
  const Y = Number(m[1]), Mo = Number(m[2]), D = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] || 0);
  const d = new Date(Y, Mo - 1, D, h, mi, s);
  const r = roundUpDateToHour(d);
  return toSqlDateTimeFromParts(r.getFullYear(), r.getMonth()+1, r.getDate(), r.getHours(), r.getMinutes(), r.getSeconds());
}
function parseDateTimeFlexible(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) { const [ , Y, Mo, D ] = m.map(Number); return toSqlDateTimeFromParts(Y, Mo, D, 8, 0, 0); }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2})(?::(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const Y  = Number(m[1]), Mo = Number(m[2]), D  = Number(m[3]);
    const hh = Number(m[4]);
    const mi = Number(m[5] || 0), se = Number(m[6] || 0);
    return toSqlDateTimeFromParts(Y, Mo, D, hh, mi, se);
  }
  return null;
}
function parseHHmm(s) {
  if (!s) return null;
  const v = String(s).trim();
  let m = /^(\d{1,2})$/.exec(v);
  if (m) { const h = Number(m[1]); if (h >= 0 && h <= 23) return { h, m: 0 }; return null; }
  m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m) { const h = Number(m[1]), mi = Number(m[2]); if (h < 0 || h > 23 || mi < 0 || mi > 59) return null; return { h, m: mi }; }
  return null;
}
function windowSql({ dateSql, endTime, timeWindow }) {
  if (!dateSql) return { startSql: null, endSql: null };
  const datePartMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateSql);
  const Y = datePartMatch ? Number(datePartMatch[1]) : null;
  const Mo = datePartMatch ? Number(datePartMatch[2]) : null;
  const D = datePartMatch ? Number(datePartMatch[3]) : null;
  let endSql = null;
  if (timeWindow && Y) {
    const tw = String(timeWindow).trim();
    const wm = /^(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)$/.exec(tw);
    if (wm) {
      const startHm = parseHHmm(wm[1]);
      const endHm   = parseHHmm(wm[2]);
      if (startHm && endHm) {
        const endD = roundUpDateToHour(new Date(Y, Mo - 1, D, endHm.h, endHm.m, 0));
        endSql = toSqlDateTimeFromParts(endD.getFullYear(), endD.getMonth()+1, endD.getDate(), endD.getHours(), 0, 0);
      }
    }
  }
  if (!endSql && endTime && Y) {
    const hm = parseHHmm(endTime);
    if (hm) {
      const endD = roundUpDateToHour(new Date(Y, Mo - 1, D, hm.h, hm.m, 0));
      endSql = toSqlDateTimeFromParts(endD.getFullYear(), endD.getMonth()+1, endD.getDate(), endD.getHours(), 0, 0);
    }
  }
  if (!endSql) {
    endSql = addMinutesToSql(dateSql, DEFAULT_WINDOW);
    endSql = roundSqlUpToHour(endSql);
  }
  return { startSql: dateSql, endSql };
}

// ─── STATUS CANONICALIZER (UPDATED) ─────────────────────────────────────────
const STATUS_CANON = [
  'New',
  'Needs to be Quoted',
  'Needs to be Scheduled',
  'Scheduled',
  'Waiting for Approval',
  'Approved',
  'Waiting on Parts',
  'Needs to be Invoiced',
  'Completed',
];
function statusKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const STATUS_LOOKUP = new Map(STATUS_CANON.map(s => [statusKey(s), s]));

// Map legacy/variants → canonical
const STATUS_SYNONYMS = new Map([
  ['part in','Needs to be Scheduled'],
  ['parts in','Needs to be Scheduled'],
  ['parts  in','Needs to be Scheduled'],
  ['parts-in','Needs to be Scheduled'],
  ['parts_in','Needs to be Scheduled'],
  ['partsin','Needs to be Scheduled'],
  ['part s in','Needs to be Scheduled'],
  ['waiting on approval','Waiting for Approval'],
  ['waiting-on-approval','Waiting for Approval'],
  ['waiting_on_approval','Waiting for Approval'],
  ['waiting on part','Waiting on Parts'],
  ['waiting on parts','Waiting on Parts'],
  ['waiting-on-parts','Waiting on Parts'],
  ['waiting_on_parts','Waiting on Parts'],
  ['waitingonparts','Waiting on Parts'],
  ['needs to be schedule','Needs to be Scheduled'],
  ['need to be scheduled','Needs to be Scheduled'],
  ['new','New'],['fresh','New'],['just created','New'],
  ['needs quote','Needs to be Quoted'],
  ['need quote','Needs to be Quoted'],
  ['quote needed','Needs to be Quoted'],
  ['to be quoted','Needs to be Quoted'],
  ['needs quotation','Needs to be Quoted'],
  ['needs-to-be-quoted','Needs to be Quoted'],
  ['needs_to_be_quoted','Needs to be Quoted'],
  ['needstobequoted','Needs to be Quoted'],
  ['needs to be invoiced','Needs to be Invoiced'],
  ['need to be invoiced','Needs to be Invoiced'],
  ['needs invoiced','Needs to be Invoiced'],
  ['needs invoicing','Needs to be Invoiced'],
  ['to be invoiced','Needs to be Invoiced'],
  ['invoice needed','Needs to be Invoiced'],
  ['needs-invoicing','Needs to be Invoiced'],
  ['needs_to_be_invoiced','Needs to be Invoiced'],
  ['needsinvoice','Needs to be Invoiced'],
  ['needsinvoiced','Needs to be Invoiced'],
  ['needs to invoice','Needs to be Invoiced'],
  ['approved','Approved'],
]);
function canonStatus(input) {
  const k = statusKey(input);
  return STATUS_LOOKUP.get(k) || STATUS_SYNONYMS.get(k) || null;
}
function displayStatusOrDefault(s) {
  return canonStatus(s) || (String(s || '').trim() ? String(s) : 'New');
}

// ─── SCHEMA HELPERS ─────────────────────────────────────────────────────────
const SCHEMA = { hasAssignedTo: false, columnsReady: true };
async function columnExists(table, col) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [col]);
  return rows.length > 0;
}
async function getColumnType(table, col) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [col]);
  return rows.length ? String(rows[0].Type || '').toLowerCase() : null;
}
async function ensureCols() {
  const colsToEnsure = [
    { name: 'scheduledDate',     type: 'DATETIME NULL' },
    { name: 'scheduledEnd',      type: 'DATETIME NULL' },
    { name: 'pdfPath',           type: 'VARCHAR(255) NULL' },
    { name: 'estimatePdfPath',   type: 'VARCHAR(255) NULL' },
    { name: 'poPdfPath',         type: 'VARCHAR(255) NULL' },
    { name: 'photoPath',         type: 'MEDIUMTEXT NULL' },
    { name: 'notes',             type: 'TEXT NULL' },
    { name: 'billingPhone',      type: 'VARCHAR(32) NULL' },
    { name: 'sitePhone',         type: 'VARCHAR(32) NULL' },
    { name: 'customerPhone',     type: 'VARCHAR(32) NULL' },
    { name: 'customerEmail',     type: 'VARCHAR(255) NULL' },
    { name: 'dayOrder',          type: 'INT NULL' },
    { name: 'workOrderNumber',   type: 'VARCHAR(64) NULL' },
    { name: 'siteAddress',       type: 'VARCHAR(255) NULL' },
  ];
  try {
    for (const { name, type } of colsToEnsure) {
      const [found] = await db.query(`SHOW COLUMNS FROM \`work_orders\` LIKE ?`, [name]);
      if (!found.length) {
        await db.query(`ALTER TABLE \`work_orders\` ADD COLUMN \`${name}\` ${type}`);
        console.log(`ℹ️ Added column ${name}`);
      }
    }
  } catch (e) {
    SCHEMA.columnsReady = false;
    console.warn(`⚠️ Schema ensure failed (check DB privileges): ${e.message}`);
  }
  try {
    const t1 = await getColumnType('work_orders', 'scheduledDate');
    if (t1 && /^date(?!time)/.test(t1)) {
      await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`scheduledDate\` DATETIME NULL`);
      console.log('ℹ️ Upgraded column scheduledDate to DATETIME');
    }
  } catch (e) { console.warn('⚠️ Type check/upgrade failed for scheduledDate:', e.message); }
  try {
    const t2 = await getColumnType('work_orders', 'scheduledEnd');
    if (t2 && /^date(?!time)/.test(t2)) {
      await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`scheduledEnd\` DATETIME NULL`);
      console.log('ℹ️ Upgraded column scheduledEnd to DATETIME');
    }
  } catch (e) { console.warn('⚠️ Type check/upgrade failed for scheduledEnd:', e.message); }
  try {
    const tPP = await getColumnType('work_orders', 'photoPath');
    const small = !tPP || /^varchar\(/.test(tPP) || /^tinytext$/.test(tPP) || /^text$/.test(tPP);
    if (small) {
      await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`photoPath\` MEDIUMTEXT NULL`);
      console.log('ℹ️ Upgraded column photoPath to MEDIUMTEXT');
    }
  } catch (e) { console.warn('⚠️ Type check/upgrade failed for photoPath:', e.message); }
  try { SCHEMA.hasAssignedTo = await columnExists('work_orders', 'assignedTo'); }
  catch (e) { console.warn('⚠️ assignedTo detect:', e.message); }
}
ensureCols().catch(e => console.warn('⚠️ ensureCols:', e.message));

// ─── MULTER ─────────────────────────────────────────────────────────────────
const allowMime = (fOrMime) => {
  const m = typeof fOrMime === 'string' ? fOrMime : (fOrMime?.mimetype || '');
  const name = typeof fOrMime === 'string' ? '' : ((fOrMime?.originalname || fOrMime?.key || '') + '');
  return (/^image\//.test(m)) || m === 'application/pdf' || /\.pdf$/i.test(name);
};
function makeUploader() {
  const limits = {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_FILES_PER_REQUEST + 5,
    fields: MAX_FIELDS,
    parts:  MAX_PARTS,
  };
  const fileFilter = (req, file, cb) => cb(null, allowMime(file));
  if (S3_BUCKET) {
    return multer({
      storage: multerS3({
        s3, bucket: S3_BUCKET, acl: 'private',
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
          const base = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const ext  = path.extname(file.originalname || '');
          cb(null, `uploads/${base}${ext}`);
        }
      }),
      limits, fileFilter,
    });
  }
  const localDir = path.resolve(__dirname, 'uploads');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, localDir),
    filename: (req, file, cb) => {
      const base = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const ext  = path.extname(file.originalname || '');
      cb(null, `${base}${ext}`);
    }
  });
  return multer({ storage, limits, fileFilter });
}
const upload = makeUploader();
if (!S3_BUCKET) {
  const localDir = path.resolve(__dirname, 'uploads');
  app.use('/uploads', express.static(localDir));
}

// ─── FIELDNAME NORMALIZATION (STRICT) ────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELD_SETS = {
  work: new Set(['workorderpdf','primarypdf','pdf']),
  est:  new Set(['estimatepdf']),
  po:   new Set(['popdf']),
};
function pickPdfByFields(files, allowedSet) {
  for (const f of (files || [])) {
    if (!isPdf(f)) continue;
    const nf = norm(f.fieldname);
    if (allowedSet.has(nf)) return f;
  }
  return null;
}
function withMulter(handler) {
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      const MULTER_413 = new Set([
        'LIMIT_FILE_SIZE','LIMIT_FILE_COUNT','LIMIT_FIELD_COUNT',
        'LIMIT_PART_COUNT','LIMIT_FIELD_VALUE','LIMIT_FIELD_KEY'
      ]);
      const msg =
        err.code === 'LIMIT_FILE_SIZE'   ? `File too large (>${MAX_FILE_SIZE_MB}MB)` :
        err.code === 'LIMIT_FILE_COUNT'  ? `Too many files in one request (max ${MAX_FILES_PER_REQUEST})` :
        err.code === 'LIMIT_PART_COUNT'  ? `Too many parts in form-data` :
        err.code === 'LIMIT_FIELD_COUNT' ? `Too many fields (max ${MAX_FIELDS})` :
        'Request too large';
      if (MULTER_413.has(err.code)) return res.status(413).json({ error: msg, code: err.code });
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Unexpected file field', code: err.code });
      console.error('Upload error:', err);
      return res.status(400).json({ error: 'Upload failed: ' + err.message, code: err.code });
    });
  };
}
const isPdf = (f) =>
  f?.mimetype === 'application/pdf' ||
  /\.pdf$/i.test(f?.originalname || '') ||
  /\.pdf$/i.test(f?.key || '');
const isImage = (f) => /^image\//.test(f?.mimetype || '');
const fileKey = (f) => (S3_BUCKET ? f.key : f.filename);

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password & role required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.execute('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)', [username, hash, role]);
    res.sendStatus(201);
  } catch (err) { console.error('Register error:', err); res.status(500).json({ error: 'Failed to register user.' }); }
});
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  try {
    const [[user]] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'Login failed.' }); }
});
function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (req.user && req.user.username && req.user.username.toLowerCase() === 'mark') {
      req.user.role = 'admin';
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function authorize(...roles) {
  return (req, res, next) => (!req.user || !roles.includes(req.user.role)) ? res.status(403).json({ error: 'Forbidden' }) : next();
}
app.get('/auth/me', authenticate, (req, res) => res.json(req.user));
app.get('/', (_, res) => res.send('API running'));
app.get('/ping', (_, res) => res.send('pong'));
app.get('/health', (_, res) => res.status(200).json({ ok: true }));

// ─── USERS ───────────────────────────────────────────────────────────────────
app.get('/users', authenticate, async (req, res) => {
  try {
    const { role, assignees, include } = req.query;
    if (assignees === '1') {
      const extras = (include && String(include).length ? include : ASSIGNEE_EXTRA_USERNAMES)
        .split(',').map(s => s.trim()).filter(Boolean);
      let sql = 'SELECT id, username, role FROM users WHERE role = ?';
      const params = ['tech'];
      if (extras.length) { sql += ` OR username IN (${extras.map(()=>'?').join(',')})`; params.push(...extras); }
      const [rows] = await db.execute(sql, params);
      return res.json(rows);
    }
    let sql = 'SELECT id, username, role FROM users'; const params = [];
    if (role) { sql += ' WHERE role = ?'; params.push(role); }
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) { console.error('Users list error:', err); res.status(500).json({ error: 'Failed to fetch users.' }); }
});

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────
app.get('/customers', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, name, billingAddress, createdAt FROM customers');
    res.json(rows);
  } catch (err) { console.error('Customers list error:', err); res.status(500).json({ error: 'Failed to fetch customers.' }); }
});
app.get('/customers/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, name, billingAddress, createdAt FROM customers WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(rows[0]);
  } catch (err) { console.error('Customer get error:', err); res.status(500).json({ error: 'Failed to fetch customer.' }); }
});
app.post('/customers', authenticate, async (req, res) => {
  const { name, billingAddress } = req.body;
  if (!name || !billingAddress) return res.status(400).json({ error: 'name & billingAddress required' });
  try {
    const [r] = await db.execute('INSERT INTO customers (name,billingAddress) VALUES (?,?)', [name, billingAddress]);
    res.status(201).json({ customerId: r.insertId });
  } catch (err) { console.error('Customer create error:', err); res.status(500).json({ error: 'Failed to create customer.' }); }
});

// ─── WORK ORDERS (helpers) ───────────────────────────────────────────────────
function pickPdfKeyFromRow(r) {
  if (r?.pdfPath && /\.pdf$/i.test(r.pdfPath)) return r.pdfPath;
  const list = (r?.photoPath || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of list) {
    if (/\.pdf$/i.test(k)) return k;
  }
  return null;
}
const isTruthy = (v) => {
  if (v === true) return true;
  const s = String(v || '').trim().toLowerCase();
  return ['1','true','on','yes','y','checked'].includes(s);
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

// ─── SEARCH/LIST/CRUD (unchanged logic) ─────────────────────────────────────
// ... (same as you had — omitted comments to keep total length manageable)
app.get('/work-orders', authenticate, async (req, res) => {
  try {
    const [raw] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id`
    );
    const rows = raw.map(r => ({ ...r, status: displayStatusOrDefault(r.status) }));
    res.json(rows);
  } catch (err) { console.error('Work-orders list error:', err); res.status(500).json({ error: 'Failed to fetch work orders.' }); }
});
app.get('/work-orders/unscheduled', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM work_orders WHERE scheduledDate IS NULL ORDER BY id DESC'
    );
    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) { console.error('Unscheduled list error:', err); res.status(500).json({ error: 'Failed to fetch unscheduled.' }); }
});
app.get('/work-orders/search', authenticate, async (req, res) => {
  const {
    customer = '',
    poNumber = '',
    siteLocation = '',
    siteAddress = '',
    workOrderNumber = '',
    status = '',
  } = req.query || {};
  try {
    const terms = [];
    const params = [];
    terms.push(`COALESCE(w.customer,'')      LIKE ?`); params.push(`%${customer}%`);
    terms.push(`COALESCE(w.siteLocation,'')  LIKE ?`); params.push(`%${siteLocation}%`);
    terms.push(`COALESCE(w.siteAddress,'')   LIKE ?`); params.push(`%${siteAddress}%`);
    if (String(status).trim()) { terms.push(`COALESCE(w.status,'') LIKE ?`); params.push(`%${status}%`); }
    const combined = String(poNumber || '').trim();
    const woOnly   = String(workOrderNumber || '').trim();
    if (combined || woOnly) {
      const needle = combined || woOnly;
      terms.push(`(COALESCE(w.poNumber,'') LIKE ? OR COALESCE(w.workOrderNumber,'') LIKE ?)`);
      params.push(`%${needle}%`, `%${needle}%`);
    }
    if (combined && woOnly && combined !== woOnly) {
      terms.push(`COALESCE(w.workOrderNumber,'') LIKE ?`); params.push(`%${woOnly}%`);
      terms.push(`COALESCE(w.poNumber,'') LIKE ?`);       params.push(`%${combined}%`);
    }
    const where = terms.length ? `WHERE ${terms.join(' AND ')}` : '';
    const [rows] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id
       ${where}
       ORDER BY w.id DESC`,
      params
    );
    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) {
    console.error('Work-orders search error:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});
app.get('/work-orders/by-po/:poNumber', authenticate, async (req, res) => {
  try {
    const po = decodeURIComponent(String(req.params.poNumber || '').trim());
    const useLike = String(req.query.like || '').trim() === '1';
    if (!po) return res.status(400).json({ error: 'poNumber is required' });
    let sql =
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id
        WHERE `;
    const params = [];
    if (useLike) { sql += 'COALESCE(w.poNumber, \'\') LIKE ?'; params.push(`%${po}%`); }
    else         { sql += 'COALESCE(w.poNumber, \'\') = ?';     params.push(po); }
    sql += ' ORDER BY w.id DESC';
    const [rows] = await db.execute(sql, params);
    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) {
    console.error('By-PO lookup error:', err);
    res.status(500).json({ error: 'Failed to lookup by PO number.' });
  }
});
app.get('/work-orders/by-po/:poNumber/pdf', authenticate, async (req, res) => {
  try {
    const po = decodeURIComponent(String(req.params.poNumber || '').trim());
    const useLike = String(req.query.like || '').trim() === '1';
    const format = String(req.query.format || '').trim().toLowerCase();
    if (!po) return res.status(400).json({ error: 'poNumber is required' });
    let sql =
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id
        WHERE `;
    const params = [];
    if (useLike) { sql += 'COALESCE(w.poNumber, \'\') LIKE ?'; params.push(`%${po}%`); }
    else         { sql += 'COALESCE(w.poNumber, \'\') = ?';     params.push(po); }
    sql += ' ORDER BY w.id DESC LIMIT 1';
    const [rows] = await db.execute(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'No work order found for that PO.' });
    const row = rows[0];
    const key = pickPdfKeyFromRow(row);
    if (!key) return res.status(404).json({ error: 'No PDF found for that PO.' });
    const href = `/files?key=${encodeURIComponent(key)}`;
    if (format === 'json') {
      return res.json({
        workOrderId: row.id,
        key,
        href,
        customer: row.customer || null,
        siteLocation: row.siteLocation || null,
        siteAddress: row.siteAddress || null,
        status: displayStatusOrDefault(row.status),
      });
    }
    return res.redirect(302, href);
  } catch (err) {
    console.error('PDF-by-PO error:', err);
    res.status(500).json({ error: 'Failed to resolve PDF by PO.' });
  }
});

// CREATE / EDIT (same as before; preserves correct keys on new uploads)
app.post('/work-orders', authenticate, withMulter(upload.any()), async (req, res) => {
  try {
    if (!SCHEMA.columnsReady) return res.status(500).json({ error: 'Database columns missing (estimatePdfPath/poPdfPath). Check DB privileges.' });
    const {
      workOrderNumber = '',
      poNumber = '',
      customer, siteLocation = '', siteAddress = null, billingAddress,
      problemDescription, status = 'New',
      assignedTo,
      billingPhone = null, sitePhone = null, customerPhone = null, customerEmail = null,
    } = req.body;
    if (!customer || !billingAddress || !problemDescription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const files = req.files || [];
    const primaryPdf   = pickPdfByFields(files, FIELD_SETS.work);
    const estimatePdf  = pickPdfByFields(files, FIELD_SETS.est);
    const poPdf        = pickPdfByFields(files, FIELD_SETS.po);
    const otherPdfs    = files.filter(f => isPdf(f) && ![primaryPdf, estimatePdf, poPdf].includes(f));
    const images       = files.filter(isImage);
    if (!enforceImageCountOr413(res, images)) return;
    const pdfPath         = primaryPdf ? fileKey(primaryPdf)   : null;
    const estimatePdfPath = estimatePdf ? fileKey(estimatePdf) : null;
    const poPdfPath       = poPdf ? fileKey(poPdf)             : null;
    const firstImg = images[0] ? fileKey(images[0]) : null;
    const extraPdfKeys = otherPdfs.map(fileKey);
    const initialAttachments = [firstImg, ...extraPdfKeys].filter(Boolean).join(',');
    const cStatus = canonStatus(status) || 'New';
    const cols = [
      'workOrderNumber','poNumber','customer','siteLocation','siteAddress','billingAddress',
      'problemDescription','status','pdfPath','estimatePdfPath','poPdfPath','photoPath',
      'billingPhone','sitePhone','customerPhone','customerEmail'
    ];
    const vals = [
      workOrderNumber || null, poNumber || null, customer, siteLocation, siteAddress || null, billingAddress,
      problemDescription, cStatus, pdfPath, estimatePdfPath, poPdfPath, initialAttachments,
      billingPhone || null, sitePhone || null, customerPhone || null, customerEmail || null
    ];
    if (SCHEMA.hasAssignedTo && assignedTo !== undefined && assignedTo !== '') {
      const assignedToVal = Number.isFinite(Number(assignedTo)) ? Number(assignedTo) : null;
      cols.push('assignedTo'); vals.push(assignedToVal);
    }
    const placeholders = cols.map(() => '?').join(',');
    const [r] = await db.execute(`INSERT INTO work_orders (${cols.join(',')}) VALUES (${placeholders})`, vals);
    if (images.length > 1) {
      const wid = r.insertId;
      const moreKeys = images.slice(1).map(fileKey);
      const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
      const current = (existing?.photoPath || '').split(',').filter(Boolean);
      await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [[...current, ...moreKeys].join(','), wid]);
    }
    res.status(201).json({ workOrderId: r.insertId });
  } catch (err) {
    console.error('Work-order create error:', err);
    res.status(500).json({ error: 'Failed to save work order.' });
  }
});
app.put('/work-orders/:id(\\d+)/edit', authenticate, withMulter(upload.any()), async (req, res) => {
  try {
    if (!SCHEMA.columnsReady) return res.status(500).json({ error: 'Database columns missing (estimatePdfPath/poPdfPath). Check DB privileges.' });
    const wid = req.params.id;
    const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const files = req.files || [];
    const primaryPdf   = pickPdfByFields(files, FIELD_SETS.work);
    const estimatePdf  = pickPdfByFields(files, FIELD_SETS.est);
    const poPdf        = pickPdfByFields(files, FIELD_SETS.po);
    const otherPdfs    = files.filter(f => isPdf(f) && ![primaryPdf, estimatePdf, poPdf].includes(f));
    const images       = files.filter(isImage);
    if (!enforceImageCountOr413(res, images)) return;
    let attachments = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
    const moveOldPdf        = isTruthy(req.body.keepOldInAttachments) || isTruthy(req.body.keepOldPdfInAttachments) || isTruthy(req.body.moveOldPdfToAttachments) || isTruthy(req.body.moveOldPdf) || isTruthy(req.body.moveExistingPdfToAttachments);
    const wantReplacePdf    = isTruthy(req.body.replacePdf) || isTruthy(req.body.setAsPrimaryPdf) || isTruthy(req.body.isPdfReplacement);
    const moveOldEstimate   = isTruthy(req.body.moveOldEstimatePdfToAttachments) || isTruthy(req.body.keepOldEstimateInAttachments);
    const wantReplaceEst    = isTruthy(req.body.replaceEstimatePdf) || isTruthy(req.body.setAsEstimatePdf);
    const moveOldPo         = isTruthy(req.body.moveOldPoPdfToAttachments) || isTruthy(req.body.keepOldPoInAttachments);
    const wantReplacePo     = isTruthy(req.body.replacePoPdf) || isTruthy(req.body.setAsPoPdf);
    let pdfPath         = existing.pdfPath;
    let estimatePdfPath = existing.estimatePdfPath;
    let poPdfPath       = existing.poPdfPath;
    if (primaryPdf) {
      const newPath = fileKey(primaryPdf);
      const oldPath = existing.pdfPath;
      if (wantReplacePdf || !oldPath) {
        if (oldPath) {
          if (moveOldPdf) { if (!attachments.includes(oldPath)) attachments.push(oldPath); }
          else {
            try {
              if (/^uploads\//.test(oldPath)) {
                if (S3_BUCKET) await s3.deleteObject({ Bucket: S3_BUCKET, Key: oldPath }).promise();
                else {
                  const full = path.resolve(__dirname, 'uploads', oldPath.replace(/^uploads\//, ''));
                  if (fs.existsSync(full)) fs.unlinkSync(full);
                }
              }
            } catch (e) { console.warn('⚠️ PDF delete old (primary):', e.message); }
          }
        }
        pdfPath = newPath;
      } else {
        attachments.push(newPath);
      }
    }
    if (estimatePdf) {
      const newPath = fileKey(estimatePdf);
      const oldPath = existing.estimatePdfPath;
      if (wantReplaceEst || !oldPath) {
        if (oldPath) {
          if (moveOldEstimate) { if (!attachments.includes(oldPath)) attachments.push(oldPath); }
          else {
            try {
              if (/^uploads\//.test(oldPath)) {
                if (S3_BUCKET) await s3.deleteObject({ Bucket: S3_BUCKET, Key: oldPath }).promise();
                else {
                  const full = path.resolve(__dirname, 'uploads', oldPath.replace(/^uploads\//, ''));
                  if (fs.existsSync(full)) fs.unlinkSync(full);
                }
              }
            } catch (e) { console.warn('⚠️ PDF delete old (estimate):', e.message); }
          }
        }
        estimatePdfPath = newPath;
      } else {
        attachments.push(newPath);
      }
    }
    if (poPdf) {
      const newPath = fileKey(poPdf);
      const oldPath = existing.poPdfPath;
      if (wantReplacePo || !oldPath) {
        if (oldPath) {
          if (moveOldPo) { if (!attachments.includes(oldPath)) attachments.push(oldPath); }
          else {
            try {
              if (/^uploads\//.test(oldPath)) {
                if (S3_BUCKET) await s3.deleteObject({ Bucket: S3_BUCKET, Key: oldPath }).promise();
                else {
                  const full = path.resolve(__dirname, 'uploads', oldPath.replace(/^uploads\//, ''));
                  if (fs.existsSync(full)) fs.unlinkSync(full);
                }
              }
            } catch (e) { console.warn('⚠️ PDF delete old (po):', e.message); }
          }
        }
        poPdfPath = newPath;
      } else {
        attachments.push(newPath);
      }
    }
    const newPhotos    = images.map(fileKey);
    const extraPdfKeys = (otherPdfs || []).map(fileKey);
    attachments = uniq([...attachments, ...newPhotos, ...extraPdfKeys]);
    const {
      workOrderNumber = existing.workOrderNumber,
      poNumber = existing.poNumber,
      customer = existing.customer,
      siteLocation = existing.siteLocation,
      siteAddress = existing.siteAddress,
      billingAddress = existing.billingAddress,
      problemDescription = existing.problemDescription,
      status = existing.status,
      assignedTo = existing.assignedTo,
      billingPhone = existing.billingPhone,
      sitePhone = existing.sitePhone,
      customerPhone = existing.customerPhone,
      customerEmail = existing.customerEmail,
    } = req.body;
    const cStatus = canonStatus(status) || existing.status;
    let sql = `UPDATE work_orders
               SET workOrderNumber=?,poNumber=?,customer=?,siteLocation=?,siteAddress=?,billingAddress=?,
                   problemDescription=?,status=?,pdfPath=?,estimatePdfPath=?,poPdfPath=?,photoPath=?,
                   billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?
               WHERE id=?`;
    const params = [
      workOrderNumber || null, poNumber || null, customer, siteLocation, siteAddress || null, billingAddress,
      problemDescription, cStatus, pdfPath || null, estimatePdfPath || null, poPdfPath || null, attachments.join(','),
      billingPhone || null, sitePhone || null, customerPhone || null, customerEmail || null,
      wid
    ];
    if (SCHEMA.hasAssignedTo) {
      sql = `UPDATE work_orders
             SET workOrderNumber=?,poNumber=?,customer=?,siteLocation=?,siteAddress=?,billingAddress=?,
                 problemDescription=?,status=?,pdfPath=?,estimatePdfPath=?,poPdfPath=?,photoPath=?,
                 billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?,assignedTo=?
             WHERE id=?`;
      const assignedToVal = (assignedTo === '' || assignedTo === undefined) ? null : Number(assignedTo);
      params.splice(16, 0, assignedToVal);
    }
    await db.execute(sql, params);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) {
    console.error('Work-order edit error:', err);
    res.status(500).json({ error: 'Failed to update work order.' });
  }
});

// Notes / assign / day order / scheduling (unchanged)
app.put('/work-orders/:id(\\d+)/status', authenticate, express.json(), async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required.' });
  try {
    const c = canonStatus(status);
    if (!c) return res.status(400).json({ error: 'Invalid status value' });
    await db.execute('UPDATE work_orders SET status = ? WHERE id = ?', [c, req.params.id]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) { console.error('Work-order status update error:', err); res.status(500).json({ error: 'Failed to update status.' }); }
});
// (… keep your other calendar/day-order/assign/notes/delete routes identical …)

// ─── KEY NORMALIZATION / REPAIR HELPERS ─────────────────────────────────────
function logFiles(...args){ if (FILES_VERBOSE === '1') console.log('[files]', ...args); }

/**
 * Accepts anything we might have stored historically:
 *  - "uploads/123.pdf"
 *  - "/uploads/123.pdf"
 *  - "123.pdf"
 *  - "https://.../uploads/123.pdf"
 *  - "http://domain/uploads/123.pdf"
 * Returns a normalized key like "uploads/123.pdf"
 */
function normalizeStoredKey(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  try { v = decodeURIComponent(v); } catch {}
  // If it's a full URL, try to extract the path after /uploads/
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const p = u.pathname || '';
      const idx = p.toLowerCase().lastIndexOf('/uploads/');
      if (idx >= 0) v = p.slice(idx + 1); // drop leading slash before uploads
      else {
        const base = path.posix.basename(p);
        v = `uploads/${base}`;
      }
    } catch { /* leave v as-is */ }
  }
  // Strip leading slashes
  v = v.replace(/^\/+/, '');
  // Ensure uploads/ prefix
  if (!v.toLowerCase().startsWith('uploads/')) v = `uploads/${path.posix.basename(v)}`;
  // Normalize to posix
  v = v.split('\\').join('/');
  return v;
}

/**
 * For LOCAL filesystem, try multiple candidates for a given key
 */
function localCandidatesFromKey(key) {
  const norm = normalizeStoredKey(key);
  const base = path.posix.basename(norm);
  const rel1 = norm.replace(/^uploads\//i, '');
  return [rel1, base]; // checked under uploads directory
}

/**
 * HEAD-check an S3 key; returns { ok, head }
 */
async function s3HeadKey(Key) {
  try {
    const head = await s3.headObject({ Bucket: S3_BUCKET, Key }).promise();
    return { ok: true, head };
  } catch (e) {
    return { ok: false, err: e };
  }
}

// ─── OPTIONAL: DB MIGRATION HELPERS TO FIX EXISTING ROWS ────────────────────
async function fixRowKeys(row) {
  const upd = {};
  const fields = ['pdfPath','estimatePdfPath','poPdfPath'];
  for (const f of fields) {
    if (row[f]) {
      const fixed = normalizeStoredKey(row[f]);
      if (fixed !== row[f]) upd[f] = fixed;
    }
  }
  if (row.photoPath) {
    const parts = String(row.photoPath).split(',').map(s => s.trim()).filter(Boolean);
    const fixedParts = parts.map(normalizeStoredKey);
    if (fixedParts.join(',') !== parts.join(',')) upd.photoPath = fixedParts.join(',');
  }
  return upd;
}
app.post('/work-orders/:id(\\d+)/fix-keys', authenticate, authorize('admin','dispatcher'), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const [[row]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const upd = await fixRowKeys(row);
    if (Object.keys(upd).length === 0) return res.json({ ok: true, changed: 0 });
    const sets = Object.keys(upd).map(k => `${k}=?`).join(',');
    await db.execute(`UPDATE work_orders SET ${sets} WHERE id = ?`, [...Object.values(upd), wid]);
    res.json({ ok: true, changed: Object.keys(upd) });
  } catch (e) { console.error('fix-keys error:', e); res.status(500).json({ error: 'Failed to fix keys' }); }
});
app.post('/work-orders/fix-keys', authenticate, authorize('admin','dispatcher'), async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id,pdfPath,estimatePdfPath,poPdfPath,photoPath FROM work_orders');
    let changed = 0;
    for (const r of rows) {
      const upd = await fixRowKeys(r);
      if (Object.keys(upd).length) {
        const sets = Object.keys(upd).map(k => `${k}=?`).join(',');
        await db.execute(`UPDATE work_orders SET ${sets} WHERE id = ?`, [...Object.values(upd), r.id]);
        changed++;
      }
    }
    res.json({ ok: true, changed });
  } catch (e) { console.error('bulk fix-keys error:', e); res.status(500).json({ error: 'Failed to bulk fix keys' }); }
});

// ─── FILE RESOLVER (S3 or local) — now robust with fallbacks ────────────────
app.get('/files', async (req, res) => {
  try {
    const raw = req.query.key;
    if (!raw) return res.status(400).json({ error: 'Missing ?key=' });

    // Normalize incoming key (repairs old/bad formats)
    let key = normalizeStoredKey(raw);
    const ext = path.extname(key).toLowerCase();
    const mimeMap = {
      '.pdf':  'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png':  'image/png',       '.gif': 'image/gif',  '.webp': 'image/webp', '.heic': 'image/heic'
    };
    const fallbackCT = mimeMap[ext] || 'application/octet-stream';
    const filename   = path.basename(key);

    // ── S3 MODE ──────────────────────────────────────────────────────────────
    if (S3_BUCKET) {
      const range = req.headers.range;

      // Try primary key
      const primaryKey = key;
      let head = await s3HeadKey(primaryKey);
      logFiles('S3 head primary', primaryKey, head.ok ? 'OK' : 'MISS');

      // Try fallbacks if primary missing
      if (!head.ok) {
        const base = path.posix.basename(primaryKey);
        const alt1 = `uploads/${base}`;
        if (alt1 !== primaryKey) {
          const h2 = await s3HeadKey(alt1);
          logFiles('S3 head alt1', alt1, h2.ok ? 'OK' : 'MISS');
          if (h2.ok) { key = alt1; head = h2; }
        }
      }
      if (!head.ok) {
        // last-ditch: try basename without uploads/ if our primary had it
        const base = path.posix.basename(primaryKey);
        const alt2 = base;
        if (alt2 !== primaryKey) {
          const h3 = await s3HeadKey(alt2);
          logFiles('S3 head alt2', alt2, h3.ok ? 'OK' : 'MISS');
          if (h3.ok) { key = alt2; head = h3; }
        }
      }
      if (!head.ok) {
        return res.status(404).json({ error: 'File not found' });
      }

      const size = head.head.ContentLength;
      const ct = head.head.ContentType || fallbackCT;

      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.status(416).end();
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end   = m[2] ? parseInt(m[2], 10) : size - 1;
        if (isNaN(start) || isNaN(end) || start > end || end >= size) return res.status(416).end();
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': ct,
          'Content-Disposition': `inline; filename="${filename}"`,
          'Cache-Control': `private, max-age=${S3_SIGNED_TTL}`,
        });
        return s3.getObject({ Bucket: S3_BUCKET, Key: key, Range: `bytes=${start}-${end}` })
                 .createReadStream()
                 .on('error', e => { if (!res.headersSent) res.status(500).end(); })
                 .pipe(res);
      }

      res.status(200).set({
        'Content-Type': ct,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': `private, max-age=${S3_SIGNED_TTL}`,
      });
      return s3.getObject({ Bucket: S3_BUCKET, Key: key })
               .createReadStream()
               .on('error', e => { if (!res.headersSent) res.status(500).end(); })
               .pipe(res);
    }

    // ── LOCAL DISK MODE ──────────────────────────────────────────────────────
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const candidateRels = localCandidatesFromKey(key); // relative to /uploads
    let chosenPath = null;
    for (const rel of candidateRels) {
      const p = path.resolve(uploadsDir, rel);
      if (p.startsWith(uploadsDir) && fs.existsSync(p)) { chosenPath = p; break; }
    }
    if (!chosenPath) {
      // As absolute fallback, scan for file with same basename in uploads dir
      const base = path.basename(key);
      const p = path.resolve(uploadsDir, base);
      if (p.startsWith(uploadsDir) && fs.existsSync(p)) chosenPath = p;
    }
    if (!chosenPath) {
      return res.sendStatus(404);
    }

    const stat = fs.statSync(chosenPath);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const rangeLocal = req.headers.range;
    if (rangeLocal) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeLocal);
      if (!m) return res.status(416).end();
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end   = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start > end || end >= stat.size) return res.status(416).end();
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': fallbackCT,
      });
      return fs.createReadStream(chosenPath, { start, end }).pipe(res);
    }
    res.setHeader('Content-Type', fallbackCT);
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(chosenPath).pipe(res);
  } catch (err) {
    console.error('File resolver error:', err);
    res.status(500).json({ error: 'Failed to resolve file' });
  }
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (err && err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
  next();
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server listening on 0.0.0.0:${PORT}`));
