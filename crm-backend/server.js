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
} = process.env;

const DEFAULT_WINDOW = Math.max(15, Number(DEFAULT_WINDOW_MINUTES) || 120);
const S3_SIGNED_TTL = Number(process.env.S3_SIGNED_TTL || 900);

// ⬆️ Limits (env overridable)
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 75);
const MAX_FILES        = Number(process.env.MAX_FILES || 120);
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
    const h  = Number(m[4]), mi = Number(m[5] || 0), se = Number(m[6] || 0);
    return toSqlDateTimeFromParts(Y, Mo, D, h, mi, se);
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

// ─── STATUS CANONICALIZER ───────────────────────────────────────────────────
const STATUS_CANON = [
  'New',                    // ⬅️ NEW
  'Needs to be Quoted',     // ⬅️ NEW
  'Needs to be Scheduled',
  'Scheduled',
  'Waiting for Approval',
  'Waiting on Parts',
  'Parts In',
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
const STATUS_SYNONYMS = new Map([
  // Parts In
  ['part in','Parts In'],['parts in','Parts In'],['parts  in','Parts In'],
  ['parts-in','Parts In'],['parts_in','Parts In'],['partsin','Parts In'],['part s in','Parts In'],
  // Waiting on Parts
  ['waiting on part','Waiting on Parts'],['waiting on parts','Waiting on Parts'],
  ['waiting-on-parts','Waiting on Parts'],['waiting_on_parts','Waiting on Parts'],['waitingonparts','Waiting on Parts'],
  // Needs to be Scheduled
  ['needs to be schedule','Needs to be Scheduled'],['need to be scheduled','Needs to be Scheduled'],
  // New (permissive)
  ['new','New'],['fresh','New'],['just created','New'],
  // Needs to be Quoted (common variants)
  ['needs quote','Needs to be Quoted'],
  ['need quote','Needs to be Quoted'],
  ['quote needed','Needs to be Quoted'],
  ['to be quoted','Needs to be Quoted'],
  ['needs quotation','Needs to be Quoted'],
  ['needs-to-be-quoted','Needs to be Quoted'],
  ['needs_to_be_quoted','Needs to be Quoted'],
  ['needstobequoted','Needs to be Quoted'],
]);
function canonStatus(input) {
  const k = statusKey(input);
  return STATUS_LOOKUP.get(k) || STATUS_SYNONYMS.get(k) || null;
}
function displayStatusOrDefault(s) {
  // Default unknown/empty to "New"
  return canonStatus(s) || (String(s || '').trim() ? String(s) : 'New');
}

// ─── SCHEMA HELPERS ─────────────────────────────────────────────────────────
const SCHEMA = { hasAssignedTo: false };
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
    { name: 'scheduledDate',   type: 'DATETIME NULL' },
    { name: 'scheduledEnd',    type: 'DATETIME NULL' },
    { name: 'pdfPath',         type: 'VARCHAR(255) NULL' },
    { name: 'photoPath',       type: 'TEXT NULL' },
    { name: 'notes',           type: 'TEXT NULL' },
    { name: 'billingPhone',    type: 'VARCHAR(32) NULL' },
    { name: 'sitePhone',       type: 'VARCHAR(32) NULL' },
    { name: 'customerPhone',   type: 'VARCHAR(32) NULL' },
    { name: 'customerEmail',   type: 'VARCHAR(255) NULL' },
    { name: 'dayOrder',        type: 'INT NULL' },
    { name: 'workOrderNumber', type: 'VARCHAR(64) NULL' },
  ];
  for (const { name, type } of colsToEnsure) {
    try {
      const [found] = await db.query(`SHOW COLUMNS FROM \`work_orders\` LIKE ?`, [name]);
      if (!found.length) {
        await db.query(`ALTER TABLE \`work_orders\` ADD COLUMN \`${name}\` ${type}`);
      } else {
        if ((name === 'scheduledDate' || name === 'scheduledEnd')) {
          try {
            const t = await getColumnType('work_orders', name);
            if (t && /^date(?!time)/.test(t)) {
              await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`${name}\` DATETIME NULL`);
              console.log(`ℹ️ Upgraded column ${name} to DATETIME`);
            }
          } catch (e) {
            console.warn(`⚠️ Type check/upgrade failed for ${name}:`, e.message);
          }
        }
      }
    } catch (e) { console.warn(`⚠️ Schema check '${name}':`, e.message); }
  }
  try { SCHEMA.hasAssignedTo = await columnExists('work_orders', 'assignedTo'); }
  catch (e) { console.warn('⚠️ assignedTo detect:', e.message); }
}
ensureCols().catch(e => console.warn('⚠️ ensureCols:', e.message));

// ─── MULTER ─────────────────────────────────────────────────────────────────
const allowMime = (m) => m && (/^image\//.test(m) || m === 'application/pdf');
function makeUploader() {
  const limits = {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_FILES + 5,
    fields: MAX_FIELDS,
    parts:  MAX_PARTS,
  };
  const fileFilter = (req, file, cb) => cb(null, allowMime(file.mimetype));
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
        err.code === 'LIMIT_FILE_COUNT'  ? `Too many files (max ${MAX_FILES})` :
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

// ─── WORK ORDERS ─────────────────────────────────────────────────────────────
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
    res.json(rows);
  } catch (err) { console.error('Unscheduled list error:', err); res.status(500).json({ error: 'Failed to fetch unscheduled.' }); }
});
app.get('/work-orders/search', authenticate, async (req, res) => {
  const { customer = '', poNumber = '', siteLocation = '', workOrderNumber = '' } = req.query;
  try {
    const params = [`%${customer}%`, `%${poNumber}%`, `%${siteLocation}%`, `%${workOrderNumber}%`];
    const [rows] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id
        WHERE w.customer LIKE ? AND w.poNumber LIKE ? AND w.siteLocation LIKE ? AND COALESCE(w.workOrderNumber,'') LIKE ?`,
      params
    );
    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) { console.error('Work-orders search error:', err); res.status(500).json({ error: 'Search failed.' }); }
});

// ── BULK status update — put this BEFORE any "/:id" routes and keep it here
function parseIdArray(maybeIds) {
  if (Array.isArray(maybeIds)) return maybeIds;
  if (typeof maybeIds === 'string') return maybeIds.split(/[,\s]+/).filter(Boolean);
  return [];
}
function coerceIdsToNumbers(mixed) {
  return mixed
    .map(v => {
      const n = Number(String(v).trim());
      return Number.isFinite(n) ? n : NaN;
    })
    .filter(n => Number.isFinite(n));
}
app.put('/work-orders/bulk-status', authenticate, express.json(), async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    const rawIds = parseIdArray(ids);
    const cleanIds = coerceIdsToNumbers(rawIds);
    if (!cleanIds.length) return res.status(400).json({ error: 'ids[] required (numbers or comma-separated string)' });
    const c = canonStatus(status);
    if (!c) return res.status(400).json({ error: 'Invalid status value' });

    const placeholders = cleanIds.map(() => '?').join(',');
    const [result] = await db.execute(
      `UPDATE work_orders SET status = ? WHERE id IN (${placeholders})`,
      [c, ...cleanIds]
    );
    const [updatedRows] = await db.execute(
      `SELECT * FROM work_orders WHERE id IN (${placeholders})`,
      cleanIds
    );
    const items = updatedRows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) }));
    res.json({ ok: true, affected: result?.affectedRows ?? items.length, items });
  } catch (err) {
    console.error('Bulk-status error:', err);
    res.status(500).json({ error: 'Failed to bulk update status.' });
  }
});

// ── SINGLE-ROW routes (now numeric-only) ─────────────────────────────────────
app.get('/work-orders/:id(\\d+)', authenticate, async (req, res) => {
  try {
    const [[row]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...row, status: displayStatusOrDefault(row.status) });
  } catch (err) { console.error('Work-order get error:', err); res.status(500).json({ error: 'Failed to fetch work order.' }); }
});
app.put('/work-orders/:id(\\d+)', authenticate, express.json(), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const { status, poNumber, workOrderNumber } = req.body || {};
    if (status === undefined && poNumber === undefined && workOrderNumber === undefined) {
      return res.status(400).json({ error: 'Provide status and/or poNumber and/or workOrderNumber.' });
    }
    const sets = []; const params = [];
    if (status !== undefined) {
      const c = canonStatus(status);
      if (!c) return res.status(400).json({ error: 'Invalid status value' });
      sets.push('status = ?'); params.push(c);
    }
    if (poNumber !== undefined)        { sets.push('poNumber = ?');         params.push(poNumber || null); }
    if (workOrderNumber !== undefined) { sets.push('workOrderNumber = ?');  params.push(workOrderNumber || null); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });

    const sql = `UPDATE work_orders SET ${sets.join(', ')} WHERE id = ?`;
    params.push(wid);
    await db.execute(sql, params);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) {
    console.error('Work-order update error:', err);
    res.status(500).json({ error: 'Failed to update work order.' });
  }
});
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

// Helpers for any-field uploads
function splitFilesAny(files = []) {
  let pdf = null; const images = [];
  for (const f of files) {
    if (!allowMime(f.mimetype)) continue;
    if (isPdf(f)) { if (!pdf) pdf = f; } else if (isImage(f)) { images.push(f); }
  }
  return { pdf, images };
}
function enforceImageCountOr413(res, images) {
  if (images.length > MAX_FILES) {
    res.status(413).json({ error: `Too many photos in one request (max ${MAX_FILES})` });
    return false;
  }
  return true;
}
const isTruthy = (v) => {
  if (v === true) return true;
  const s = String(v || '').trim().toLowerCase();
  return ['1','true','on','yes','y','checked'].includes(s);
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

app.post('/work-orders', authenticate, withMulter(upload.any()), async (req, res) => {
  try {
    const {
      workOrderNumber = '',
      poNumber = '',
      customer, siteLocation = '', billingAddress,
      problemDescription, status = 'New', // ⬅️ default changed to New
      assignedTo,
      billingPhone = null, sitePhone = null, customerPhone = null, customerEmail = null,
    } = req.body;

    if (!customer || !billingAddress || !problemDescription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { pdf, images } = splitFilesAny(req.files || []);
    if (!enforceImageCountOr413(res, images)) return;

    const pdfPath   = pdf ? fileKey(pdf) : null;
    const firstImg  = images[0] ? fileKey(images[0]) : null;

    const cStatus = canonStatus(status) || 'New'; // ⬅️ default New

    const cols = [
      'workOrderNumber','poNumber','customer','siteLocation','billingAddress',
      'problemDescription','status','pdfPath','photoPath',
      'billingPhone','sitePhone','customerPhone','customerEmail'
    ];
    const vals = [
      workOrderNumber || null, poNumber || null, customer, siteLocation, billingAddress,
      problemDescription, cStatus, pdfPath, firstImg,
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
    const wid = req.params.id;
    const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    const { pdf, images } = splitFilesAny(req.files || []);
    if (!enforceImageCountOr413(res, images)) return;

    let attachments = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];

    const moveOldPdf =
      isTruthy(req.body.keepOldInAttachments) ||
      isTruthy(req.body.keepOldPdfInAttachments) ||
      isTruthy(req.body.moveOldPdfToAttachments) ||
      isTruthy(req.body.moveOldPdf) ||
      isTruthy(req.body.moveExistingPdfToAttachments);

    const wantReplacePdf =
      isTruthy(req.body.replacePdf) ||
      isTruthy(req.body.setAsPrimaryPdf) ||
      isTruthy(req.body.isPdfReplacement);

    let pdfPath = existing.pdfPath;

    if (pdf) {
      const newPdfPath = fileKey(pdf);
      const oldPdfPath = existing.pdfPath;

      if (wantReplacePdf) {
        if (oldPdfPath) {
          if (moveOldPdf) {
            if (!attachments.includes(oldPdfPath)) attachments.push(oldPdfPath);
          } else {
            try {
              if (/^uploads\//.test(oldPdfPath)) {
                if (S3_BUCKET) {
                  await s3.deleteObject({ Bucket: S3_BUCKET, Key: oldPdfPath }).promise();
                } else {
                  const full = path.resolve(__dirname, 'uploads', oldPdfPath.replace(/^uploads\//, ''));
                  if (fs.existsSync(full)) fs.unlinkSync(full);
                }
              }
            } catch (e) { console.warn('⚠️ PDF delete old:', e.message); }
          }
        }
        pdfPath = newPdfPath;
      } else {
        attachments.push(newPdfPath);
      }
    }

    const newPhotos = images.map(fileKey);
    attachments = uniq([...attachments, ...newPhotos]);

    const {
      workOrderNumber = existing.workOrderNumber,
      poNumber = existing.poNumber,
      customer = existing.customer,
      siteLocation = existing.siteLocation,
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
               SET workOrderNumber=?,poNumber=?,customer=?,siteLocation=?,billingAddress=?,
                   problemDescription=?,status=?,pdfPath=?,photoPath=?,
                   billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?
               WHERE id=?`;
    const params = [
      workOrderNumber || null, poNumber || null, customer, siteLocation, billingAddress,
      problemDescription, cStatus, pdfPath || null, attachments.join(','),
      billingPhone || null, sitePhone || null, customerPhone || null, customerEmail || null,
      wid
    ];
    if (SCHEMA.hasAssignedTo) {
      sql = `UPDATE work_orders
             SET workOrderNumber=?,poNumber=?,customer=?,siteLocation=?,billingAddress=?,
                 problemDescription=?,status=?,pdfPath=?,photoPath=?,
                 billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?,assignedTo=?
             WHERE id=?`;
      const assignedToVal = (assignedTo === '' || assignedTo === undefined) ? null : Number(assignedTo);
      params.splice(13, 0, assignedToVal);
    }

    await db.execute(sql, params);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) {
    console.error('Work-order edit error:', err);
    res.status(500).json({ error: 'Failed to update work order.' });
  }
});

app.post('/work-orders/:id(\\d+)/append-photo', authenticate, withMulter(upload.any()), async (req, res) => {
  try {
    const wid = req.params.id;
    const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    const { images } = splitFilesAny(req.files || []);
    if (!images.length) return res.status(400).json({ error: 'No image provided.' });

    const oldPhotos = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
    const merged = uniq([...oldPhotos, fileKey(images[0])]);

    await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [merged.join(','), wid]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) { console.error('Append-photo error:', err); res.status(500).json({ error: 'Failed to append photo.' }); }
});

app.post('/work-orders/:id(\\d+)/append-photos', authenticate, withMulter(upload.any()), async (req, res) => {
  try {
    const wid = req.params.id;
    const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    const { images } = splitFilesAny(req.files || []);
    if (!enforceImageCountOr413(res, images)) return;
    if (!images.length) return res.status(400).json({ error: 'No images provided.' });

    const oldPhotos = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
    const merged = uniq([...oldPhotos, ...images.map(fileKey)]);

    await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [merged.join(','), wid]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) { console.error('Append-photos error:', err); res.status(500).json({ error: 'Failed to append photos.' }); }
});

// ─── CALENDAR / SCHEDULING (dispatcher/admin) ───────────────────────────────
app.put('/work-orders/:id(\\d+)/update-date',
  authenticate,
  authorize('dispatcher','admin'),
  express.json(),
  async (req, res) => {
    try {
      const wid = req.params.id;
      const { status, scheduledDate, scheduledEnd, date, time, endTime, timeWindow } = req.body || {};

      const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });

      let startSql = parseDateTimeFlexible(scheduledDate);
      if (!startSql && date) {
        const d = String(date).trim();
        const hm = parseHHmm(time) || { h: 8, m: 0 };
        startSql = toSqlDateTimeFromParts(
          Number(d.slice(0,4)), Number(d.slice(5,7)), Number(d.slice(8,10)),
          hm.h, hm.m, 0
        );
      }
      if (startSql) startSql = roundSqlUpToHour(startSql);

      if (scheduledDate === null) {
        const nextStatus = (status !== undefined && status !== null && String(status).length)
          ? (canonStatus(status) || 'Needs to be Scheduled')
          : 'Needs to be Scheduled';
        await db.execute(
          'UPDATE work_orders SET scheduledDate = NULL, scheduledEnd = NULL, dayOrder = NULL, status = ? WHERE id = ?',
          [nextStatus, wid]
        );
      } else if (!startSql) {
        return res.status(400).json({ error: 'Invalid or missing date/time.' });
      } else {
        let endSql = parseDateTimeFlexible(scheduledEnd);
        if (endSql) {
          endSql = roundSqlUpToHour(endSql);
        } else {
          const w = windowSql({ dateSql: startSql, endTime, timeWindow });
          endSql = w.endSql;
        }

        // If caller didn't supply a status, flip pre-schedule statuses to Scheduled
        const provided = (status !== undefined && status !== null && String(status).length);
        let nextStatus;
        if (provided) {
          nextStatus = canonStatus(status) || existing.status;
        } else {
          const preSchedule = new Set(['New','Needs to be Quoted','Needs to be Scheduled']);
          nextStatus = preSchedule.has(displayStatusOrDefault(existing.status))
            ? 'Scheduled'
            : existing.status || 'Scheduled';
        }

        await db.execute(
          'UPDATE work_orders SET scheduledDate = ?, scheduledEnd = ?, status = ?, dayOrder = NULL WHERE id = ?',
          [startSql, endSql, nextStatus, wid]
        );
      }

      const [[fresh]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json({ ...fresh, status: displayStatusOrDefault(fresh.status) });
    } catch (err) {
      console.error('Update-date error:', err);
      res.status(500).json({ error: 'Failed to update date.' });
    }
  }
);

app.put('/work-orders/:id(\\d+)/unschedule',
  authenticate,
  authorize('dispatcher','admin'),
  async (req, res) => {
    try {
      const wid = req.params.id;
      const { status } = req.body || {};
      const nextStatus = (status && String(status).length) ? (canonStatus(status) || 'Needs to be Scheduled') : 'Needs to be Scheduled';
      await db.execute(
        'UPDATE work_orders SET scheduledDate = NULL, scheduledEnd = NULL, dayOrder = NULL, status = ? WHERE id = ?',
        [nextStatus, wid]
      );
      const [[fresh]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json({ ...fresh, status: displayStatusOrDefault(fresh.status) });
    } catch (err) {
      console.error('Unschedule error:', err);
      res.status(500).json({ error: 'Failed to unschedule.' });
    }
  }
);

app.get('/calendar/day', authenticate, async (req, res) => {
  try {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
    }
    const [rows] = await db.execute(
      `SELECT *
         FROM work_orders
        WHERE DATE(scheduledDate) = ?
        ORDER BY TIME(scheduledDate) ASC, COALESCE(dayOrder, 999999) ASC, id ASC`,
      [date]
    );
    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) {
    console.error('Calendar day fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch day.' });
  }
});

app.put('/calendar/day-order',
  authenticate,
  authorize('dispatcher','admin'),
  express.json(),
  async (req, res) => {
    try {
      const { date, orderedIds } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')))
        return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
      if (!Array.isArray(orderedIds))
        return res.status(400).json({ error: 'orderedIds array required' });

      await db.execute('UPDATE work_orders SET dayOrder = NULL WHERE DATE(scheduledDate) = ?', [date]);

      for (let i = 0; i < orderedIds.length; i++) {
        const id = Number(orderedIds[i]);
        if (!Number.isFinite(id)) continue;
        await db.execute(
          'UPDATE work_orders SET dayOrder = ? WHERE id = ? AND DATE(scheduledDate) = ?',
          [i + 1, id, date]
        );
      }

      const [rows] = await db.execute(
        `SELECT *
           FROM work_orders
          WHERE DATE(scheduledDate) = ?
          ORDER BY TIME(scheduledDate) ASC, COALESCE(dayOrder, 999999) ASC, id ASC`,
        [date]
      );
      res.json({ ok: true, items: rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })) });
    } catch (err) {
      console.error('Day-order error:', err);
      res.status(500).json({ error: 'Failed to save order.' });
    }
  }
);

// Assign / notes / delete endpoints
app.put('/work-orders/:id(\\d+)/assign', authenticate, authorize('dispatcher', 'admin'), express.json(), async (req, res) => {
  try {
    if (!SCHEMA.hasAssignedTo) return res.status(400).json({ error: 'assignedTo column missing' });
    const { assignedTo } = req.body;
    const val = (assignedTo === null || assignedTo === '' || assignedTo === undefined) ? null : Number(assignedTo);
    if (val !== null) {
      const [[u]] = await db.execute('SELECT id, role FROM users WHERE id = ?', [val]);
      if (!u) return res.status(400).json({ error: 'Assignee not found' });
      if (u.role !== 'tech') return res.status(400).json({ error: 'Assignee must be a tech' });
    }
    await db.execute('UPDATE work_orders SET assignedTo = ? WHERE id = ?', [val, req.params.id]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) { console.error('Assign error:', err); res.status(500).json({ error: 'Failed to assign work order.' }); }
});
app.post('/work-orders/:id(\\d+)/notes', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id; const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Note text required.' });
    const [[row2]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
    let arr = []; try { arr = row2?.notes ? JSON.parse(row2.notes) : []; } catch { arr = []; }
    arr.push({ text, createdAt: new Date().toISOString(), by: req.user.username });
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) {
    console.error('Add note error:', err);
    res.status(500).json({ error: 'Failed to add note.' });
  }
});
app.delete('/work-orders/:id(\\d+)/notes/:index', authenticate, async (req, res) => {
  try {
    const wid = req.params.id; const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid note index' });
    const [[row]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    let arr = []; try { arr = row.notes ? JSON.parse(row.notes) : []; } catch { arr = []; }
    if (idx >= arr.length) return res.status(400).json({ error: 'Note index out of range' });
    arr.splice(idx, 1);
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) { console.error('Delete note error:', err); res.status(500).json({ error: 'Failed to delete note.' }); }
});
app.delete('/work-orders/:id(\\d+)/notes', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id; const idx = Number(req.body.index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid note index' });
    const [[row]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    let arr = []; try { arr = row.notes ? JSON.parse(row.notes) : []; } catch { arr = []; }
    if (idx >= arr.length) return res.status(400).json({ error: 'Note index out of range' });
    arr.splice(idx, 1);
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) { console.error('Delete note (body) error:', err); res.status(500).json({ error: 'Failed to delete note.' }); }
});
app.delete('/work-orders/:id(\\d+)/attachment', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id; const { photoPath } = req.body;
    if (!photoPath) return res.status(400).json({ error: 'photoPath required.' });
    try {
      if (S3_BUCKET) await s3.deleteObject({ Bucket: S3_BUCKET, Key: photoPath }).promise();
      else {
        const full = path.resolve(__dirname, 'uploads', photoPath.replace(/^uploads\//, ''));
        if (fs.existsSync(full)) fs.unlinkSync(full);
      }
    } catch (e) { console.warn('⚠️ Failed to delete file:', e.message); }
    const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
    const keep = (existing?.photoPath || '').split(',').filter(p => p && p !== photoPath);
    await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [keep.join(','), wid]);
    const [[fresh]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json({ ...fresh, status: displayStatusOrDefault(fresh.status) });
  } catch (err) { console.error('Delete attachment error:', err); res.status(500).json({ error: 'Failed to delete attachment.' }); }
});
app.delete('/work-orders/:id(\\d+)', authenticate, authorize('dispatcher', 'admin'), async (req, res) => {
  try { await db.execute('DELETE FROM work_orders WHERE id = ?', [req.params.id]); res.json({ message: 'Deleted.' }); }
  catch (err) { console.error('Work-order delete error:', err); res.status(500).json({ error: 'Failed to delete.' }); }
});

// ─── FILE RESOLVER (S3 or local) — stream w/ Range support ──────────────────
app.get('/files', async (req, res) => {
  try {
    const raw = req.query.key;
    if (!raw) return res.status(400).json({ error: 'Missing ?key=' });

    let key = decodeURIComponent(String(raw));
    if (!key.startsWith('uploads/')) key = `uploads/${key.replace(/^\/+/, '')}`;

    const ext = path.extname(key).toLowerCase();
    const mimeMap = {
      '.pdf':  'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png':  'image/png',       '.gif': 'image/gif',  '.webp': 'image/webp', '.heic': 'image/heic'
    };
    const fallbackCT = mimeMap[ext] || 'application/octet-stream';
    const filename   = path.basename(key);

    if (S3_BUCKET) {
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.status(416).end();
        let head;
        try { head = await s3.headObject({ Bucket: S3_BUCKET, Key: key }).promise(); }
        catch (e) { return res.status(e?.statusCode === 404 ? 404 : 500).json({ error: 'File not found' }); }
        const size = head.ContentLength; const ct = head.ContentType || fallbackCT;
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
                 .createReadStream().on('error', e => { if (!res.headersSent) res.status(500).end(); })
                 .pipe(res);
      }
      let head;
      try { head = await s3.headObject({ Bucket: S3_BUCKET, Key: key }).promise(); }
      catch (e) { return res.status(e?.statusCode === 404 ? 404 : 500).json({ error: 'File not found' }); }
      res.status(200).set({
        'Content-Type': head.ContentType || fallbackCT,
        'Content-Length': head.ContentLength,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': `private, max-age=${S3_SIGNED_TTL}`,
      });
      return s3.getObject({ Bucket: S3_BUCKET, Key: key })
               .createReadStream().on('error', e => { if (!res.headersSent) res.status(500).end(); })
               .pipe(res);
    }

    // local
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const safeRel  = key.replace(/^uploads\//, '');
    const safePath = path.resolve(uploadsDir, safeRel);
    if (!safePath.startsWith(uploadsDir)) return res.status(400).json({ error: 'Bad path' });
    if (!fs.existsSync(safePath)) return res.sendStatus(404);
    const stat = fs.statSync(safePath);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return res.status(416).end();
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end   = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start > end || end >= stat.size) return res.status(416).end();
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(safePath, { start, end }).pipe(res);
    }
    res.setHeader('Content-Type', fallbackCT);
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(safePath).pipe(res);
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
