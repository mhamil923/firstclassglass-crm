// ===============================
// server.js — FULL FILE (Part 1/6)
// Copy/paste in order: Part 1 → Part 6
// ===============================

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

// ✅ use axios so we don't depend on Node's global fetch() (EB can be Node < 18)
const axios      = require('axios');

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
  AWS_REGION  = 'us-east-2',
  ASSIGNEE_EXTRA_USERNAMES = 'Jeff,tech1',
  DEFAULT_WINDOW_MINUTES = '120',
  FILES_VERBOSE = process.env.FILES_VERBOSE || '0',

  // ROUTE OPTIMIZATION
  GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '',
  ROUTE_START_ADDRESS = process.env.ROUTE_START_ADDRESS || '1513 Industrial Dr, Itasca, IL 60143',
  ROUTE_END_ADDRESS   = process.env.ROUTE_END_ADDRESS   || '1513 Industrial Dr, Itasca, IL 60143',

  // ROUTE: limits/timeouts (Google optimize:true max is 23 waypoints)
  ROUTE_MAX_WAYPOINTS = process.env.ROUTE_MAX_WAYPOINTS || '23',
  ROUTE_TIMEOUT_MS    = process.env.ROUTE_TIMEOUT_MS    || '20000',

  // AUTO STATUS RULE
  AUTO_NEW_TO_NEEDS_SCHEDULED_AFTER_HOURS = process.env.AUTO_NEW_TO_NEEDS_SCHEDULED_AFTER_HOURS || '48',
  // Interval: 60 minutes (less DB activity)
  AUTO_NEW_TO_NEEDS_SCHEDULED_INTERVAL_MINUTES = process.env.AUTO_NEW_TO_NEEDS_SCHEDULED_INTERVAL_MINUTES || '60',
  AUTO_NEW_TO_NEEDS_SCHEDULED_ENABLED = process.env.AUTO_NEW_TO_NEEDS_SCHEDULED_ENABLED || '1',
} = process.env;

const DEFAULT_WINDOW = Math.max(15, Number(DEFAULT_WINDOW_MINUTES) || 120);
const S3_SIGNED_TTL = Number(process.env.S3_SIGNED_TTL || 900);

// Limits (env overridable)
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 75);
const MAX_FILES_PER_REQUEST = Number(process.env.MAX_FILES_PER_REQUEST || process.env.MAX_FILES || 300);
const MAX_FIELDS = Number(process.env.MAX_FIELDS || 500);
const MAX_PARTS  = Number(process.env.MAX_PARTS  || 2000);

if (S3_BUCKET) AWS.config.update({ region: AWS_REGION });
else console.warn('⚠️ S3_BUCKET not set; using local disk for uploads.');
const s3 = new AWS.S3();

// ─── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));

// Parse JSON + URL-encoded as usual
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

// Also accept text/plain bodies
app.use(bodyParser.text({ type: 'text/plain', limit: '1mb' }));

// Coerce text bodies to objects the endpoints can use
function coerceBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  const str = String(req.body).trim();
  if (!str) return {};
  try { return JSON.parse(str); } catch (_) { return { text: str, value: str, notes: str }; }
}

// ─── ROUTE PARAM GUARDS ─────────────────────────────────────────────────────
function requireNumericParam(paramName) {
  return (req, res, next) => {
    const raw = String(req.params[paramName] ?? '').trim();
    if (!/^\d+$/.test(raw)) return res.status(400).json({ error: `${paramName} must be a numeric id` });
    req.params[paramName] = raw;
    next();
  };
}

// ─── MYSQL ──────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  port: Number(DB_PORT),
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
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
  if (m) {
    const [ , Y, Mo, D ] = m.map(Number);
    return toSqlDateTimeFromParts(Y, Mo, D, 8, 0, 0);
  }

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
  if (m) {
    const h = Number(m[1]);
    if (h >= 0 && h <= 23) return { h, m: 0 };
    return null;
  }

  m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2]);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return { h, m: mi };
  }

  return null;
}

function windowSql({ dateSql, endTime, timeWindow }) {
  if (!dateSql) return { startSql: null, endSql: null };

  const datePartMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateSql);
  const Y  = datePartMatch ? Number(datePartMatch[1]) : null;
  const Mo = datePartMatch ? Number(datePartMatch[2]) : null;
  const D  = datePartMatch ? Number(datePartMatch[3]) : null;

  let endSql = null;

  if (timeWindow && Y) {
    const tw = String(timeWindow).trim();
    const wm = /^(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)$/.exec(tw);
    if (wm) {
      const endHm   = parseHHmm(wm[2]);
      if (endHm) {
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

const STATUS_SHORT = new Map([
  ['ne', 'New'],
  ['sc', 'Scheduled'],
  ['ap', 'Approved'],
  ['wf', 'Waiting for Approval'],
  ['wa', 'Waiting on Parts'],
  ['nq', 'Needs to be Quoted'],
  ['ns', 'Needs to be Scheduled'],
  ['ni', 'Needs to be Invoiced'],
  ['co', 'Completed'],
]);

function canonStatus(input) {
  const k = statusKey(input);
  return STATUS_LOOKUP.get(k) || STATUS_SYNONYMS.get(k) || STATUS_SHORT.get(k) || null;
}

function displayStatusOrDefault(s) {
  return canonStatus(s) || (String(s || '').trim() ? String(s) : 'New');
}

// ===============================
// END Part 1/6
// Next: Part 2/6
// ===============================
// ===============================
// server.js — FULL FILE (Part 2/6)
// ===============================

// ─── SCHEMA HELPERS ─────────────────────────────────────────────────────────
const SCHEMA = {
  hasAssignedTo: false,
  columnsReady: true,
  createdAtCol: null,
};

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
    { name: 'poSupplier',        type: 'VARCHAR(128) NULL' },
    { name: 'poPickedUp',        type: 'TINYINT(1) NOT NULL DEFAULT 0' },
    { name: 'photoPath',         type: 'MEDIUMTEXT NULL' },
    { name: 'notes',             type: 'TEXT NULL' },
    { name: 'billingPhone',      type: 'VARCHAR(32) NULL' },
    { name: 'sitePhone',         type: 'VARCHAR(32) NULL' },
    { name: 'customerPhone',     type: 'VARCHAR(32) NULL' },
    { name: 'customerEmail',     type: 'VARCHAR(255) NULL' },
    { name: 'dayOrder',          type: 'INT NULL' },
    { name: 'workOrderNumber',   type: 'VARCHAR(64) NULL' },
    { name: 'siteAddress',       type: 'VARCHAR(255) NULL' },
    { name: 'assignedTo',        type: 'INT NULL' },
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
    console.warn(`⚠️ Schema ensure failed: ${e.message}`);
  }

  try {
    const t1 = await getColumnType('work_orders', 'scheduledDate');
    if (t1 && /^date(?!time)/.test(t1)) {
      await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`scheduledDate\` DATETIME NULL`);
    }
  } catch {}

  try {
    const t2 = await getColumnType('work_orders', 'scheduledEnd');
    if (t2 && /^date(?!time)/.test(t2)) {
      await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`scheduledEnd\` DATETIME NULL`);
    }
  } catch {}

  try {
    const tPP = await getColumnType('work_orders', 'photoPath');
    const small = !tPP || /^varchar\(/.test(tPP) || /^tinytext$/.test(tPP) || /^text$/.test(tPP);
    if (small) {
      await db.query(`ALTER TABLE \`work_orders\` MODIFY COLUMN \`photoPath\` MEDIUMTEXT NULL`);
    }
  } catch {}

  try {
    SCHEMA.hasAssignedTo = await columnExists('work_orders', 'assignedTo');
  } catch {}

  try {
    const hasCreatedAt  = await columnExists('work_orders', 'createdAt');
    const hasCreated_at = await columnExists('work_orders', 'created_at');

    if (hasCreatedAt) {
      SCHEMA.createdAtCol = 'createdAt';
    } else if (hasCreated_at) {
      SCHEMA.createdAtCol = 'created_at';
    } else {
      await db.query(
        `ALTER TABLE \`work_orders\` ADD COLUMN \`createdAt\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`
      );
      SCHEMA.createdAtCol = 'createdAt';
    }
  } catch {}
}

ensureCols().catch(() => {});

// ─── SAFE SELECT BUILDER ────────────────────────────────────────────────────
function workOrdersSelectSQL({ whereSql = '', orderSql = 'ORDER BY w.id DESC', limitSql = '' } = {}) {
  const hasA = !!SCHEMA.hasAssignedTo;
  const join = hasA ? 'LEFT JOIN users u ON w.assignedTo = u.id' : '';
  const assignedSel = hasA ? 'u.username AS assignedToName' : 'NULL AS assignedToName';

  const createdSel =
    SCHEMA.createdAtCol === 'created_at' ? 'w.created_at AS createdAt' :
    SCHEMA.createdAtCol === 'createdAt'  ? 'w.createdAt AS createdAt'  :
    'NULL AS createdAt';

  return `
    SELECT w.*, ${assignedSel}, ${createdSel}
      FROM work_orders w
      ${join}
      ${whereSql}
      ${orderSql}
      ${limitSql}
  `;
}

// ─── AUTO STATUS JOB ─────────────────────────────────────────────────────────
function envOn(v, def = true) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return ['1','true','yes','y','on'].includes(s);
}

async function autoMoveNewToNeedsScheduled() {
  try {
    if (!envOn(AUTO_NEW_TO_NEEDS_SCHEDULED_ENABLED, true)) return;

    const hours = Math.max(1, Number(AUTO_NEW_TO_NEEDS_SCHEDULED_AFTER_HOURS) || 48);
    const createdCol = SCHEMA.createdAtCol || 'createdAt';
    if (!SCHEMA.createdAtCol) return;

    const sql = `
      UPDATE work_orders
         SET status = 'Needs to be Scheduled'
       WHERE status = 'New'
         AND scheduledDate IS NULL
         AND \`${createdCol}\` <= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `;
    await db.execute(sql, [hours]);
  } catch {}
}

function startAutoStatusJob() {
  const minutes = Math.max(5, Number(AUTO_NEW_TO_NEEDS_SCHEDULED_INTERVAL_MINUTES) || 60);
  const ms = minutes * 60 * 1000;

  setTimeout(() => {
    autoMoveNewToNeedsScheduled().catch(() => {});
  }, 15000).unref?.();

  const t = setInterval(() => {
    autoMoveNewToNeedsScheduled().catch(() => {});
  }, ms);

  if (typeof t.unref === 'function') t.unref();
}

startAutoStatusJob();

// ===============================
// END Part 2/6
// Next: Part 3/6
// ===============================
// ===============================
// server.js — FULL FILE (Part 3/6)
// ===============================

// ─── MULTER / UPLOADS ───────────────────────────────────────────────────────
const allowMime = (fOrMime) => {
  const m = typeof fOrMime === 'string' ? fOrMime : (fOrMime?.mimetype || '');
  const name = typeof fOrMime === 'string' ? '' : ((fOrMime?.originalname || fOrMime?.key || '') + '');
  return (/^image\//.test(m)) || m === 'application/pdf' || /\.pdf$/i.test(name);
};

function sanitizeFilename(originalname) {
  const ext  = path.extname(originalname || '');
  const base = path.basename(originalname || '', ext)
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 200);
  const fallback = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return (base || fallback) + ext;
}

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
        s3,
        bucket: S3_BUCKET,
        acl: 'private',
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
          cb(null, `uploads/${sanitizeFilename(file.originalname)}`);
        }
      }),
      limits,
      fileFilter,
    });
  }

  const localDir = path.resolve(__dirname, 'uploads');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, localDir),
    filename: (req, file, cb) => {
      cb(null, sanitizeFilename(file.originalname));
    }
  });

  return multer({ storage, limits, fileFilter });
}

const upload = makeUploader();

if (!S3_BUCKET) {
  const localDir = path.resolve(__dirname, 'uploads');
  app.use('/uploads', express.static(localDir));
}

// ─── FIELDNAME NORMALIZATION (STRICT) ───────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_SETS = {
  work: new Set(['workorderpdf','primarypdf','pdf']),
  est:  new Set(['estimatepdf']),
  po:   new Set(['popdf']),
};

const isPdf = (f) =>
  f?.mimetype === 'application/pdf' ||
  /\.pdf$/i.test(f?.originalname || '') ||
  /\.pdf$/i.test(f?.key || '');

const isImage = (f) => /^image\//.test(f?.mimetype || '');

const fileKey = (f) => (S3_BUCKET ? f.key : f.filename);

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

// Guard for huge photo dumps
function enforceImageCountOr413(res, images) {
  if ((images || []).length > MAX_FILES_PER_REQUEST) {
    res.status(413).json({ error: `Too many photos in one request (max ${MAX_FILES_PER_REQUEST})` });
    return false;
  }
  return true;
}

// ===============================
// END Part 3/6
// Next: Part 4/6 (Auth + Users + Customers + Work-order helpers)
// ===============================
// ===============================
// server.js — FULL FILE (Part 4/6)
// ===============================

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, password, role } = coerceBody(req);
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password & role required' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.execute(
      'INSERT INTO users (username,password_hash,role) VALUES (?,?,?)',
      [username, hash, role]
    );
    res.sendStatus(201);
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to register user.' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = coerceBody(req);
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });

  try {
    const [[user]] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // keep your convenience override
    if (req.user && req.user.username && req.user.username.toLowerCase() === 'mark') {
      req.user.role = 'admin';
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

app.get('/auth/me', authenticate, (req, res) => res.json(req.user));

// ─── BASIC ───────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send('API running'));
app.get('/ping', (_, res) => res.send('pong'));
app.get('/health', (_, res) => res.status(200).json({ ok: true }));

// ─── USERS ───────────────────────────────────────────────────────────────────
app.get('/users', authenticate, async (req, res) => {
  try {
    const { role, assignees, include } = req.query;

    // Assignee list helper: techs + optional extras
    if (assignees === '1') {
      const extras = (include && String(include).length ? include : ASSIGNEE_EXTRA_USERNAMES)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      let sql = 'SELECT id, username, role FROM users WHERE role = ?';
      const params = ['tech'];

      if (extras.length) {
        sql += ` OR username IN (${extras.map(() => '?').join(',')})`;
        params.push(...extras);
      }

      const [rows] = await db.execute(sql, params);
      return res.json(rows);
    }

    let sql = 'SELECT id, username, role FROM users';
    const params = [];
    if (role) {
      sql += ' WHERE role = ?';
      params.push(role);
    }

    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────
app.get('/customers', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, name, billingAddress, createdAt FROM customers');
    res.json(rows);
  } catch (err) {
    console.error('Customers list error:', err);
    res.status(500).json({ error: 'Failed to fetch customers.' });
  }
});

app.get('/customers/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, name, billingAddress, createdAt FROM customers WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Customer get error:', err);
    res.status(500).json({ error: 'Failed to fetch customer.' });
  }
});

app.post('/customers', authenticate, async (req, res) => {
  const { name, billingAddress } = coerceBody(req);
  if (!name || !billingAddress) return res.status(400).json({ error: 'name & billingAddress required' });

  try {
    const [r] = await db.execute(
      'INSERT INTO customers (name,billingAddress) VALUES (?,?)',
      [name, billingAddress]
    );
    res.status(201).json({ customerId: r.insertId });
  } catch (err) {
    console.error('Customer create error:', err);
    res.status(500).json({ error: 'Failed to create customer.' });
  }
});

// ─── WORK ORDERS HELPERS ────────────────────────────────────────────────────
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

const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

function poStatusFromRow(r) {
  return Number(r.poPickedUp || 0) ? 'Picked Up' : 'On Order';
}

// ===============================
// END Part 4/6
// Next: Part 5/6 (Work Orders routes: list/search/get/create/edit/notes/status/delete + Purchase Orders)
// ===============================
// ===============================
// server.js — FULL FILE (Part 5/6)
// ===============================

// ─── WORK ORDERS SEARCH/LIST/CRUD ───────────────────────────────────────────

// LIST ALL
app.get('/work-orders', authenticate, async (req, res) => {
  try {
    const [raw] = await db.execute(workOrdersSelectSQL({ orderSql: 'ORDER BY w.id DESC' }));
    const rows = raw.map(r => ({ ...r, status: displayStatusOrDefault(r.status) }));
    res.json(rows);
  } catch (err) {
    console.error('Work-orders list error:', err);
    res.status(500).json({ error: 'Failed to fetch work orders.' });
  }
});

// Unscheduled bar
app.get('/work-orders/unscheduled', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM work_orders WHERE scheduledDate IS NULL ORDER BY id DESC'
    );
    const normalized = rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) }));
    const ALLOWED = new Set(['New','Scheduled','Needs to be Scheduled']);
    const filtered = normalized.filter(r => ALLOWED.has(r.status));
    res.json(filtered);
  } catch (err) {
    console.error('Unscheduled list error:', err);
    res.status(500).json({ error: 'Failed to fetch unscheduled.' });
  }
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

    if (String(status).trim()) {
      terms.push(`COALESCE(w.status,'') LIKE ?`);
      params.push(`%${status}%`);
    }

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
      workOrdersSelectSQL({ whereSql: where, orderSql: 'ORDER BY w.id DESC' }),
      params
    );

    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) {
    console.error('Work-orders search error:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// Lookup by PO (list)
app.get('/work-orders/by-po/:poNumber', authenticate, async (req, res) => {
  try {
    const po = decodeURIComponent(String(req.params.poNumber || '').trim());
    const useLike = String(req.query.like || '').trim() === '1';
    if (!po) return res.status(400).json({ error: 'poNumber is required' });

    let where = 'WHERE ';
    const params = [];
    if (useLike) { where += 'COALESCE(w.poNumber, \'\') LIKE ?'; params.push(`%${po}%`); }
    else         { where += 'COALESCE(w.poNumber, \'\') = ?';     params.push(po); }

    const [rows] = await db.execute(
      workOrdersSelectSQL({ whereSql: where, orderSql: 'ORDER BY w.id DESC' }),
      params
    );

    res.json(rows.map(r => ({ ...r, status: displayStatusOrDefault(r.status) })));
  } catch (err) {
    console.error('By-PO lookup error:', err);
    res.status(500).json({ error: 'Failed to lookup by PO number.' });
  }
});

// Lookup by PO -> redirect to PDF (or return JSON)
app.get('/work-orders/by-po/:poNumber/pdf', authenticate, async (req, res) => {
  try {
    const po = decodeURIComponent(String(req.params.poNumber || '').trim());
    const useLike = String(req.query.like || '').trim() === '1';
    const format = String(req.query.format || '').trim().toLowerCase();
    if (!po) return res.status(400).json({ error: 'poNumber is required' });

    let where = 'WHERE ';
    const params = [];
    if (useLike) { where += 'COALESCE(w.poNumber, \'\') LIKE ?'; params.push(`%${po}%`); }
    else         { where += 'COALESCE(w.poNumber, \'\') = ?';     params.push(po); }

    const [rows] = await db.execute(
      workOrdersSelectSQL({ whereSql: where, orderSql: 'ORDER BY w.id DESC', limitSql: 'LIMIT 1' }),
      params
    );

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

// GET single by ID
app.get('/work-orders/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const where = 'WHERE w.id = ?';

    const [rows] = await db.execute(
      workOrdersSelectSQL({ whereSql: where, orderSql: '', limitSql: 'LIMIT 1' }),
      [id]
    );

    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Not found.' });

    row.status = (row.status && canonStatus(row.status))
      ? canonStatus(row.status)
      : displayStatusOrDefault(row.status);

    res.json(row);
  } catch (err) {
    console.error('Work-order get-by-id error:', err);
    res.status(500).json({ error: 'Failed to fetch work order.' });
  }
});

// CREATE work order
app.post('/work-orders', authenticate, withMulter(upload.any()), async (req, res) => {
  try {
    if (!SCHEMA.columnsReady) {
      return res.status(500).json({ error: 'Database columns missing (estimatePdfPath/poPdfPath). Check DB privileges.' });
    }

    const {
      workOrderNumber = '',
      poNumber = '',
      customer,
      siteLocation = '',
      siteAddress = null,
      billingAddress,
      problemDescription,
      status = 'New',
      assignedTo,

      billingPhone = null,
      sitePhone = null,
      customerPhone = null,
      customerEmail = null,
      notes = null,

      poSupplier = null,
      poPickedUp = 0,

      scheduledDate: scheduledDateRaw = null,
      endTime = null,
      timeWindow = null
    } = req.body;

    if (!customer || !billingAddress || !problemDescription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let startSqlMaybe = (scheduledDateRaw === '') ? null : parseDateTimeFlexible(scheduledDateRaw);
    const { startSql, endSql } = windowSql({ dateSql: startSqlMaybe, endTime, timeWindow });
    const scheduledDate = startSql || null;
    const scheduledEnd  = endSql   || null;

    const files = req.files || [];
    const primaryPdf   = pickPdfByFields(files, FIELD_SETS.work);
    const estimatePdf  = pickPdfByFields(files, FIELD_SETS.est);
    const poPdf        = pickPdfByFields(files, FIELD_SETS.po);
    const otherPdfs    = files.filter(f => isPdf(f) && ![primaryPdf, estimatePdf, poPdf].includes(f));
    const images       = files.filter(isImage);

    if (!enforceImageCountOr413(res, images)) return;

    const pdfPath         = primaryPdf  ? fileKey(primaryPdf)  : null;
    const estimatePdfPath = estimatePdf ? fileKey(estimatePdf) : null;
    const poPdfPath       = poPdf       ? fileKey(poPdf)       : null;

    const firstImg = images[0] ? fileKey(images[0]) : null;
    const extraPdfKeys = otherPdfs.map(fileKey);
    const initialAttachments = [firstImg, ...extraPdfKeys].filter(Boolean).join(',');

    const cStatus = canonStatus(status) || 'New';

    const cols = [
      'workOrderNumber','poNumber','customer','siteLocation','siteAddress','billingAddress',
      'problemDescription','status',
      'pdfPath','estimatePdfPath','poPdfPath','photoPath',
      'billingPhone','sitePhone','customerPhone','customerEmail','notes',
      'poSupplier','poPickedUp',
      'scheduledDate','scheduledEnd'
    ];

    const vals = [
      workOrderNumber || null,
      poNumber || null,
      customer,
      siteLocation,
      siteAddress || null,
      billingAddress,
      problemDescription,
      cStatus,
      pdfPath,
      estimatePdfPath,
      poPdfPath,
      initialAttachments,
      billingPhone || null,
      sitePhone || null,
      customerPhone || null,
      customerEmail || null,
      notes,
      poSupplier || null,
      Number(poPickedUp) ? 1 : 0,
      scheduledDate,
      scheduledEnd
    ];

    if (SCHEMA.hasAssignedTo && assignedTo !== undefined && assignedTo !== '') {
      const assignedToVal = Number.isFinite(Number(assignedTo)) ? Number(assignedTo) : null;
      cols.push('assignedTo');
      vals.push(assignedToVal);
    }

    const placeholders = cols.map(() => '?').join(',');
    const [r] = await db.execute(
      `INSERT INTO work_orders (${cols.join(',')}) VALUES (${placeholders})`,
      vals
    );

    // If more than 1 image uploaded, append remaining to photoPath
    if (images.length > 1) {
      const wid = r.insertId;
      const moreKeys = images.slice(1).map(fileKey);
      const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
      const current = (existing?.photoPath || '').split(',').filter(Boolean);
      await db.execute(
        'UPDATE work_orders SET photoPath = ? WHERE id = ?',
        [[...current, ...moreKeys].join(','), wid]
      );
    }

    res.status(201).json({ workOrderId: r.insertId });
  } catch (err) {
    console.error('Work-order create error:', err);
    res.status(500).json({ error: 'Failed to save work order.' });
  }
});

// EDIT work order
app.put('/work-orders/:id/edit', authenticate, requireNumericParam('id'), withMulter(upload.any()), async (req, res) => {
  try {
    if (!SCHEMA.columnsReady) {
      return res.status(500).json({ error: 'Database columns missing (estimatePdfPath/poPdfPath). Check DB privileges.' });
    }

    const wid = Number(req.params.id);
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

    const moveOldPdf      = isTruthy(req.body.keepOldInAttachments) ||
                            isTruthy(req.body.keepOldPdfInAttachments) ||
                            isTruthy(req.body.moveOldPdfToAttachments) ||
                            isTruthy(req.body.moveOldPdf) ||
                            isTruthy(req.body.moveExistingPdfToAttachments);

    const wantReplacePdf  = isTruthy(req.body.replacePdf) ||
                            isTruthy(req.body.setAsPrimaryPdf) ||
                            isTruthy(req.body.isPdfReplacement);

    const moveOldEstimate = isTruthy(req.body.moveOldEstimatePdfToAttachments) ||
                            isTruthy(req.body.keepOldEstimateInAttachments);

    const wantReplaceEst  = isTruthy(req.body.replaceEstimatePdf) ||
                            isTruthy(req.body.setAsEstimatePdf);

    const moveOldPo       = isTruthy(req.body.moveOldPoPdfToAttachments) ||
                            isTruthy(req.body.keepOldPoInAttachments);

    const wantReplacePo   = isTruthy(req.body.replacePoPdf) ||
                            isTruthy(req.body.setAsPoPdf);

    let pdfPath         = existing.pdfPath;
    let estimatePdfPath = existing.estimatePdfPath;
    let poPdfPath       = existing.poPdfPath;

    const fileKeySafe = (f) => (S3_BUCKET ? f.key : f.filename);

    if (primaryPdf) {
      const newPath = fileKeySafe(primaryPdf);
      const oldPath = existing.pdfPath;
      if (wantReplacePdf || !oldPath) {
        if (oldPath && moveOldPdf && !attachments.includes(oldPath)) attachments.push(oldPath);
        pdfPath = newPath;
      } else {
        attachments.push(newPath);
      }
    }

    if (estimatePdf) {
      const newPath = fileKeySafe(estimatePdf);
      const oldPath = existing.estimatePdfPath;
      if (wantReplaceEst || !oldPath) {
        if (oldPath && moveOldEstimate && !attachments.includes(oldPath)) attachments.push(oldPath);
        estimatePdfPath = newPath;
      } else {
        attachments.push(newPath);
      }
    }

    if (poPdf) {
      const newPath = fileKeySafe(poPdf);
      const oldPath = existing.poPdfPath;
      if (wantReplacePo || !oldPath) {
        if (oldPath && moveOldPo && !attachments.includes(oldPath)) attachments.push(oldPath);
        poPdfPath = newPath;
      } else {
        attachments.push(newPath);
      }
    }

    const newPhotos    = images.map(fileKeySafe);
    const extraPdfKeys = (otherPdfs || []).map(fileKeySafe);
    attachments = uniq([...attachments, ...newPhotos, ...extraPdfKeys]);

    const body = { ...existing, ...req.body };
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
      notes = existing.notes,

      poSupplier = existing.poSupplier,
      poPickedUp = existing.poPickedUp,

      scheduledDate: scheduledDateRaw = undefined,
      endTime = null,
      timeWindow = null
    } = body;

    const cStatus = canonStatus(status) || existing.status;

    let scheduledDate = existing.scheduledDate || null;
    let scheduledEnd  = existing.scheduledEnd  || null;

    if (scheduledDateRaw !== undefined) {
      if (scheduledDateRaw === '') {
        scheduledDate = null;
        scheduledEnd = null;
      } else {
        const startSqlMaybe = parseDateTimeFlexible(scheduledDateRaw);
        const win = windowSql({ dateSql: startSqlMaybe, endTime, timeWindow });
        scheduledDate = win.startSql || startSqlMaybe || null;
        scheduledEnd  = win.endSql || null;
      }
    }

    let sql = `
      UPDATE work_orders
         SET workOrderNumber=?,poNumber=?,customer=?,siteLocation=?,siteAddress=?,billingAddress=?,
             problemDescription=?,status=?,pdfPath=?,estimatePdfPath=?,poPdfPath=?,photoPath=?,
             billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?,notes=?,
             poSupplier=?,poPickedUp=?,
             scheduledDate=?,scheduledEnd=?
    `;
    const params = [
      workOrderNumber || null,
      poNumber || null,
      customer,
      siteLocation,
      siteAddress || null,
      billingAddress,
      problemDescription,
      cStatus,
      pdfPath || null,
      estimatePdfPath || null,
      poPdfPath || null,
      attachments.join(','),
      billingPhone || null,
      sitePhone || null,
      customerPhone || null,
      customerEmail || null,
      notes,
      poSupplier || null,
      Number(poPickedUp) ? 1 : 0,
      scheduledDate,
      scheduledEnd
    ];

    if (SCHEMA.hasAssignedTo) {
      sql += `, assignedTo=?`;
      params.push((assignedTo === '' || assignedTo === undefined) ? null : Number(assignedTo));
    }

    sql += ` WHERE id=?`;
    params.push(wid);

    await db.execute(sql, params);

    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) {
    console.error('Work-order edit error:', err);
    res.status(500).json({ error: 'Failed to update work order.' });
  }
});

// NOTES
app.put('/work-orders/:id/notes', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const b = coerceBody(req);
    const notes = b.notes ?? b.note ?? b.text ?? b.message;
    const append = isTruthy(b.append) || isTruthy(b.appendNotes) || isTruthy(b.a);

    if (notes == null || String(notes).trim() === '') {
      return res.status(400).json({ error: 'notes is required.' });
    }

    if (append) {
      const [[row]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
      if (!row) return res.status(404).json({ error: 'Not found.' });

      const who = req.user?.username || 'system';
      const stamp = new Date().toISOString().replace('T',' ').replace('Z','');
      const sep = row.notes ? '\n\n' : '';
      const newNotes = (row.notes || '') + `${sep}[${stamp}] ${who}: ${notes}`;
      await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [newNotes, wid]);
    } else {
      await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [String(notes), wid]);
    }

    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json(updated);
  } catch (err) {
    console.error('Work-order notes update error:', err);
    res.status(500).json({ error: 'Failed to update notes.' });
  }
});

// STATUS
app.put('/work-orders/:id/status', authenticate, requireNumericParam('id'), async (req, res) => {
  const b = coerceBody(req);
  const incoming = b.status ?? b.value ?? b.newStatus ?? b.s ?? b.text;
  if (incoming == null || String(incoming).trim() === '') {
    return res.status(400).json({ error: 'status is required.' });
  }

  try {
    const c = canonStatus(incoming);
    if (!c) return res.status(400).json({ error: 'Invalid status value' });

    await db.execute('UPDATE work_orders SET status = ? WHERE id = ?', [c, Number(req.params.id)]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [Number(req.params.id)]);
    if (!updated) return res.status(404).json({ error: 'Not found.' });

    res.json({ ...updated, status: displayStatusOrDefault(updated.status) });
  } catch (err) {
    console.error('Work-order status update error:', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// ─── WORK ORDERS: DELETE (and optional file cleanup) ─────────────────────────

// Delete a file from S3 or local disk (best-effort, does not throw)
async function deleteStoredFileByKey(rawKey) {
  const key = normalizeStoredKey(rawKey);
  if (!key) return;

  // Safety: only allow deletes inside uploads/
  if (!key.toLowerCase().startsWith('uploads/')) return;

  // S3 mode
  if (S3_BUCKET) {
    try {
      await s3.deleteObject({ Bucket: S3_BUCKET, Key: key }).promise();
    } catch (e) {
      console.warn('⚠️ S3 deleteObject failed:', key, e?.message || e);
    }
    return;
  }

  // Local mode
  try {
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const candidates = localCandidatesFromKey(key); // returns [rel1, base]
    for (const rel of candidates) {
      const p = path.resolve(uploadsDir, rel);
      if (p.startsWith(uploadsDir) && fs.existsSync(p)) {
        fs.unlinkSync(p);
        return;
      }
    }
  } catch (e) {
    console.warn('⚠️ Local file delete failed:', key, e?.message || e);
  }
}

// DELETE /work-orders/:id
// Optional: pass ?deleteFiles=1 to also delete stored uploads linked to the work order
app.delete(
  '/work-orders/:id',
  authenticate,
  authorize('admin', 'dispatcher'),
  requireNumericParam('id'),
  async (req, res) => {
    const wid = Number(req.params.id);
    const deleteFiles = String(req.query.deleteFiles || '').trim() === '1';

    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      const [[row]] = await conn.execute('SELECT * FROM work_orders WHERE id = ? LIMIT 1', [wid]);
      if (!row) {
        await conn.rollback();
        return res.status(404).json({ error: 'Work order not found.' });
      }

      const [del] = await conn.execute('DELETE FROM work_orders WHERE id = ?', [wid]);
      if (!del.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: 'Work order not found.' });
      }

      await conn.commit();

      // Best-effort file cleanup AFTER commit
      if (deleteFiles) {
        const keys = [];

        if (row.pdfPath) keys.push(row.pdfPath);
        if (row.estimatePdfPath) keys.push(row.estimatePdfPath);
        if (row.poPdfPath) keys.push(row.poPdfPath);

        if (row.photoPath) {
          const parts = String(row.photoPath).split(',').map(s => s.trim()).filter(Boolean);
          keys.push(...parts);
        }

        const uniqKeys = Array.from(new Set(keys.map(normalizeStoredKey).filter(Boolean)));
        await Promise.all(uniqKeys.map(k => deleteStoredFileByKey(k)));
      }

      return res.status(200).json({ ok: true, deletedId: wid, deletedFiles: deleteFiles });
    } catch (err) {
      try { if (conn) await conn.rollback(); } catch {}
      console.error('Work-order delete error:', err);
      return res.status(500).json({ error: 'Failed to delete work order.' });
    } finally {
      try { if (conn) conn.release(); } catch {}
    }
  }
);

// DELETE /work-orders/:id/attachments
// Removes a single attachment (photo/pdf) from the work order's photoPath list and deletes the file.
// Body: { key: "uploads/Photo-12345-2025-02-05-1703345678901.jpg" }
app.delete(
  '/work-orders/:id/attachments',
  authenticate,
  requireNumericParam('id'),
  async (req, res) => {
    const wid = Number(req.params.id);
    const key = String(req.body?.key || '').trim();

    if (!key) {
      return res.status(400).json({ error: 'Missing attachment key.' });
    }

    try {
      const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Work order not found.' });

      const attachments = existing.photoPath
        ? existing.photoPath.split(',').filter(Boolean)
        : [];

      const normalizedKey = normalizeStoredKey(key);
      const updated = attachments.filter(
        (a) => normalizeStoredKey(a) !== normalizedKey
      );

      if (updated.length === attachments.length) {
        return res.status(404).json({ error: 'Attachment not found on this work order.' });
      }

      await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [
        updated.join(','),
        wid,
      ]);

      // Best-effort file deletion
      await deleteStoredFileByKey(key);

      return res.json({ ok: true, remaining: updated.length });
    } catch (err) {
      console.error('Attachment delete error:', err);
      return res.status(500).json({ error: 'Failed to delete attachment.' });
    }
  }
);

// ─── PURCHASE ORDERS (derived from work_orders) ─────────────────────────────

// GET /purchase-orders?supplier=Chicago%20Tempered&status=on-order|picked-up
app.get('/purchase-orders', authenticate, async (req, res) => {
  try {
    const supplierQ = String(req.query.supplier || '').trim();
    const statusQ   = String(req.query.status || '').trim().toLowerCase();

    const whereParts = [
      `(COALESCE(w.poNumber,'') <> '' OR COALESCE(w.poPdfPath,'') <> '' OR COALESCE(w.poSupplier,'') <> '')`
    ];
    const params = [];

    if (supplierQ) {
      whereParts.push(`COALESCE(w.poSupplier,'') LIKE ?`);
      params.push(`%${supplierQ}%`);
    }

    if (statusQ === 'on-order' || statusQ === 'on' || statusQ === 'open') {
      whereParts.push(`COALESCE(w.poPickedUp,0) = 0`);
    } else if (statusQ === 'picked-up' || statusQ === 'picked' || statusQ === 'closed') {
      whereParts.push(`COALESCE(w.poPickedUp,0) = 1`);
    }

    const whereSql = `WHERE ${whereParts.join(' AND ')}`;

    const [rows] = await db.execute(
      workOrdersSelectSQL({
        whereSql,
        orderSql: 'ORDER BY w.poSupplier ASC, w.id DESC'
      }),
      params
    );

    const out = rows.map(r => ({
      id: r.id,
      workOrderId: r.id,
      workOrderNumber: r.workOrderNumber || null,
      poNumber: r.poNumber || null,
      supplier: r.poSupplier || '',
      customer: r.customer || '',
      siteLocation: r.siteLocation || '',
      siteAddress: r.siteAddress || '',
      poPdfPath: r.poPdfPath || null,
      poPickedUp: !!Number(r.poPickedUp || 0),
      poStatus: poStatusFromRow(r),
      createdAt: r.createdAt || null,
      workOrderStatus: displayStatusOrDefault(r.status),
    }));

    res.json(out);
  } catch (err) {
    console.error('Purchase-orders list error:', err);
    res.status(500).json({ error: 'Failed to fetch purchase orders.' });
  }
});

// PUT /purchase-orders/:id/mark-picked-up   (id = work_orders.id)
app.put('/purchase-orders/:id/mark-picked-up', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const wid = Number(req.params.id);

    const [[row]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!row) return res.status(404).json({ error: 'Work order not found.' });

    const who = req.user?.username || 'system';
    const stamp = new Date().toISOString().replace('T',' ').replace('Z','');
    const poNumber = row.poNumber || '';
    const supplier = row.poSupplier || '';

    const line = `[${stamp}] ${who}: Purchase order ${poNumber || '(no PO #)'}${supplier ? ` (${supplier})` : ''} marked PICKED UP.`;
    const newNotes = (row.notes || '') + (row.notes ? '\n\n' : '') + line;

    await db.execute(
      'UPDATE work_orders SET poPickedUp = 1, notes = ? WHERE id = ?',
      [newNotes, wid]
    );

    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);

    res.json({
      id: updated.id,
      workOrderId: updated.id,
      workOrderNumber: updated.workOrderNumber || null,
      poNumber: updated.poNumber || null,
      supplier: updated.poSupplier || '',
      poPickedUp: !!Number(updated.poPickedUp || 0),
      poStatus: poStatusFromRow(updated),
      notes: updated.notes || '',
      workOrderStatus: displayStatusOrDefault(updated.status),
    });
  } catch (err) {
    console.error('Purchase-order mark-picked-up error:', err);
    res.status(500).json({ error: 'Failed to mark purchase order as picked up.' });
  }
});

// ===============================
// END Part 5/6
// Next: Part 6/6 (calendar feed + route optimizer + key fixing + /files resolver + global error + listen)
// ===============================
// ===============================
// server.js — FULL FILE (Part 6/6)
// ===============================

// ─── CALENDAR FEED ──────────────────────────────────────────────────────────
app.get('/calendar/events', authenticate, async (req, res) => {
  try {
    const startQ = String(req.query.start || '').trim();
    const endQ   = String(req.query.end   || '').trim();

    const asSqlDayStart = (dStr) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
      if (m) return `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
      return parseDateTimeFlexible(dStr) || null;
    };
    const asSqlDayEnd = (dStr) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
      if (m) return `${m[1]}-${m[2]}-${m[3]} 23:59:59`;
      const p = parseDateTimeFlexible(dStr);
      if (!p) return null;
      return p;
    };

    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultStart = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())} 00:00:00`;
    const d60 = new Date(today); d60.setDate(d60.getDate() + 60);
    const defaultEnd = `${d60.getFullYear()}-${pad(d60.getMonth()+1)}-${pad(d60.getDate())} 23:59:59`;

    const startSql = startQ ? asSqlDayStart(startQ) : defaultStart;
    const endSql   = endQ   ? asSqlDayEnd(endQ)     : defaultEnd;

    const [rows] = await db.execute(
      `SELECT id, workOrderNumber, poNumber, customer, siteLocation, siteAddress, problemDescription, status,
              scheduledDate, scheduledEnd
         FROM work_orders
        WHERE scheduledDate IS NOT NULL
          AND scheduledDate <= ?
          AND (scheduledEnd IS NULL OR scheduledEnd >= ?)
        ORDER BY scheduledDate ASC`,
      [endSql, startSql]
    );

    const events = rows.map(r => ({
      id: r.id,
      workOrderNumber: r.workOrderNumber || null,
      poNumber: r.poNumber || null,
      title: [
        r.customer || null,
        (r.workOrderNumber ? `WO #${r.workOrderNumber}` : (r.poNumber ? `PO #${r.poNumber}` : null)),
        r.siteLocation || r.siteAddress || null
      ].filter(Boolean).join(' — '),
      start: r.scheduledDate,
      end:   r.scheduledEnd || null,
      allDay: false,
      meta: {
        status: displayStatusOrDefault(r.status),
        customer: r.customer,
        siteLocation: r.siteLocation,
        siteAddress: r.siteAddress,
        problemDescription: r.problemDescription,
        workOrderNumber: r.workOrderNumber || null,
        poNumber: r.poNumber || null,
      }
    }));

    res.json(events);
  } catch (err) {
    console.error('Calendar events error:', err);
    res.status(500).json({ error: 'Failed to load calendar events.' });
  }
});

// ─── ROUTE OPTIMIZER (BEST ROUTE) ───────────────────────────────────────────
function sqlDayRange(dateStrYYYYMMDD) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStrYYYYMMDD || '').trim());
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  const Y = d.getFullYear();
  const Mo = d.getMonth() + 1;
  const Da = d.getDate();
  const start = toSqlDateTimeFromParts(Y, Mo, Da, 0, 0, 0);
  const end   = toSqlDateTimeFromParts(Y, Mo, Da, 23, 59, 59);
  return { start, end, ymd: `${Y}-${pad2(Mo)}-${pad2(Da)}` };
}

function cleanAddr(a) {
  const s = String(a || '').trim();
  return s.replace(/\s+/g, ' ');
}

function mapsUrlForStops(origin, destination, waypointsArr) {
  const o = encodeURIComponent(origin);
  const d = encodeURIComponent(destination);
  const wp = waypointsArr && waypointsArr.length
    ? `&waypoints=${encodeURIComponent(waypointsArr.join('|'))}`
    : '';
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}${wp}&travelmode=driving`;
}

function normalizeStops(arr) {
  const raw = Array.isArray(arr) ? arr : [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const id = s?.id;
    const address = cleanAddr(s?.address || '');
    if (!address) continue;
    const k = address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id, address, label: s?.label || null });
  }
  return out;
}

async function handleBestRoute(req, res) {
  try {
    const b = coerceBody(req);

    const startIn = (b.start ?? req.query.start ?? ROUTE_START_ADDRESS);
    const endIn   = (b.end   ?? req.query.end   ?? ROUTE_END_ADDRESS);
    const travelMode = String(b.travelMode || req.query.travelMode || 'driving').toLowerCase();

    const startAddress = cleanAddr(startIn || ROUTE_START_ADDRESS);
    const endAddress   = cleanAddr(endIn   || ROUTE_END_ADDRESS);

    let stops = [];
    if (Array.isArray(b.stops) && b.stops.length) {
      stops = normalizeStops(b.stops).filter(s => s.address);
    } else {
      const dateQ = String((b.date ?? req.query.date) || '').trim();
      const { start, end, ymd } = sqlDayRange(dateQ);

      const [rows] = await db.execute(
        `SELECT id, workOrderNumber, poNumber, customer, siteLocation, siteAddress, scheduledDate
           FROM work_orders
          WHERE scheduledDate IS NOT NULL
            AND scheduledDate >= ?
            AND scheduledDate <= ?
          ORDER BY scheduledDate ASC, id ASC`,
        [start, end]
      );

      const list = [];
      for (const r of rows) {
        const addr = cleanAddr(r.siteAddress || r.siteLocation || '');
        if (!addr) continue;

        const lk = addr.toLowerCase();
        if (lk === startAddress.toLowerCase()) continue;
        if (lk === endAddress.toLowerCase()) continue;

        const labelParts = [];
        if (r.workOrderNumber) labelParts.push(`WO ${r.workOrderNumber}`);
        if (r.poNumber) labelParts.push(`PO ${r.poNumber}`);
        if (r.customer) labelParts.push(r.customer);
        if (r.siteLocation) labelParts.push(r.siteLocation);

        list.push({
          id: r.id,
          address: addr,
          label: labelParts.join(' • ') || null,
        });
      }
      stops = normalizeStops(list);
      res.setHeader('X-Route-Date', ymd);
    }

    const fallbackMapsUrl = mapsUrlForStops(startAddress, endAddress, stops.map(s => s.address));

    if (stops.length < 2) {
      return res.json({
        ok: true,
        optimized: false,
        message: stops.length === 0 ? 'No usable stops provided.' : 'Need at least 2 stops to optimize.',
        start: startAddress,
        end: endAddress,
        stops,
        orderedStops: stops,
        orderedIds: stops.map(s => s.id),
        totalDistanceMeters: null,
        totalDurationSeconds: null,
        googleMapsUrl: fallbackMapsUrl,
      });
    }

    const maxWpts = Math.max(1, Number(ROUTE_MAX_WAYPOINTS) || 23);
    let trimmed = false;
    if (stops.length > maxWpts) {
      stops = stops.slice(0, maxWpts);
      trimmed = true;
    }

    if (!GOOGLE_MAPS_API_KEY) {
      return res.json({
        ok: true,
        optimized: false,
        warning: 'GOOGLE_MAPS_API_KEY not set. Returning stops in current order.',
        start: startAddress,
        end: endAddress,
        stops,
        orderedStops: stops,
        orderedIds: stops.map(s => s.id),
        totalDistanceMeters: null,
        totalDurationSeconds: null,
        googleMapsUrl: mapsUrlForStops(startAddress, endAddress, stops.map(s => s.address)),
      });
    }

    const waypointAddresses = stops.map(s => s.address);
    const wpParam = `optimize:true|${waypointAddresses.join('|')}`;

    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${encodeURIComponent(startAddress)}` +
      `&destination=${encodeURIComponent(endAddress)}` +
      `&waypoints=${encodeURIComponent(wpParam)}` +
      `&mode=${encodeURIComponent(travelMode)}` +
      `&departure_time=now` +
      `&traffic_model=best_guess` +
      `&alternatives=false` +
      `&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;

    let data = null;
    try {
      const resp = await axios.get(url, { timeout: Math.max(2000, Number(ROUTE_TIMEOUT_MS) || 20000) });
      data = resp?.data || null;
    } catch (e) {
      console.warn('⚠️ Google Directions call failed:', e?.message || e);
      return res.json({
        ok: true,
        optimized: false,
        warning: 'Route service failed; returning current order.',
        start: startAddress,
        end: endAddress,
        stops,
        orderedStops: stops,
        orderedIds: stops.map(s => s.id),
        totalDistanceMeters: null,
        totalDurationSeconds: null,
        googleMapsUrl: mapsUrlForStops(startAddress, endAddress, stops.map(s => s.address)),
        error: { message: String(e?.message || 'Route service error') },
      });
    }

    if (!data || data.status !== 'OK' || !Array.isArray(data.routes) || !data.routes.length) {
      return res.json({
        ok: true,
        optimized: false,
        warning: `Google Directions returned status=${data?.status || 'UNKNOWN'}`,
        start: startAddress,
        end: endAddress,
        stops,
        orderedStops: stops,
        orderedIds: stops.map(s => s.id),
        totalDistanceMeters: null,
        totalDurationSeconds: null,
        googleMapsUrl: mapsUrlForStops(startAddress, endAddress, stops.map(s => s.address)),
        google: { status: data?.status || 'UNKNOWN', error_message: data?.error_message || null },
        ...(trimmed ? { trimmed: true, trimmedTo: maxWpts } : {}),
      });
    }

    const route = data.routes[0];
    const orderIdx = Array.isArray(route.waypoint_order) ? route.waypoint_order : [];
    const orderedStopsBase = orderIdx.length
      ? orderIdx.map(i => stops[i]).filter(Boolean)
      : stops;

    const legs = Array.isArray(route.legs) ? route.legs : [];

    const orderedStops = orderedStopsBase.map((s, idx) => {
      const leg = legs[idx];
      return {
        ...s,
        legDistanceMeters: leg?.distance?.value ?? null,
        legDurationSeconds: leg?.duration?.value ?? null,
        legDurationInTrafficSeconds: leg?.duration_in_traffic?.value ?? null,
      };
    });

    const totalDistanceMeters = legs.reduce((sum, l) => sum + (l?.distance?.value || 0), 0) || null;
    const totalDurationSeconds = legs.reduce((sum, l) => sum + (l?.duration?.value || 0), 0) || null;
    const totalDurationInTrafficSeconds = legs.reduce((sum, l) => sum + (l?.duration_in_traffic?.value || 0), 0) || null;

    const orderedWaypointAddresses = orderedStops.map(s => s.address);

    return res.json({
      ok: true,
      optimized: true,
      start: startAddress,
      end: endAddress,
      stops,
      orderedStops,
      orderedIds: orderedStops.map(s => s.id),
      totalDistanceMeters,
      totalDurationSeconds,
      totalDurationInTrafficSeconds,
      googleMapsUrl: mapsUrlForStops(startAddress, endAddress, orderedWaypointAddresses),
      google: { status: data.status, waypoint_order: orderIdx },
      ...(trimmed ? { trimmed: true, trimmedTo: maxWpts } : {}),
    });
  } catch (e) {
    console.error('Best route error:', e);
    res.status(500).json({ error: 'Failed to generate best route.' });
  }
}

app.get('/routes/best', authenticate, handleBestRoute);
app.post('/routes/best', authenticate, handleBestRoute);

// ─── KEY NORMALIZATION / FIXERS ──────────────────────────────────────────────
function logFiles(...args){ if (FILES_VERBOSE === '1') console.log('[files]', ...args); }

function normalizeStoredKey(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  try { v = decodeURIComponent(v); } catch {}
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const p = u.pathname || '';
      const idx = p.toLowerCase().lastIndexOf('/uploads/');
      if (idx >= 0) v = p.slice(idx + 1);
      else v = `uploads/${path.posix.basename(p)}`;
    } catch {}
  }
  v = v.replace(/^\/+/, '');
  if (!v.toLowerCase().startsWith('uploads/')) v = `uploads/${path.posix.basename(v)}`;
  v = v.split('\\').join('/');
  return v;
}

function localCandidatesFromKey(key) {
  const n = normalizeStoredKey(key);
  const base = path.posix.basename(n);
  const rel1 = n.replace(/^uploads\//i, '');
  return [rel1, base];
}

async function s3HeadKey(Key) {
  try {
    const meta = await s3.headObject({ Bucket: S3_BUCKET, Key }).promise();
    return { ok: true, meta };
  } catch (e) { return { ok: false, err: e }; }
}

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

app.post('/work-orders/:id/fix-keys', authenticate, authorize('admin','dispatcher'), requireNumericParam('id'), async (req, res) => {
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

// ─── FILE RESOLVER (S3 or local) ────────────────────────────────────────────
app.get('/files', async (req, res) => {
  try {
    const raw = req.query.key;
    if (!raw) return res.status(400).json({ error: 'Missing ?key=' });

    let key = normalizeStoredKey(raw);
    const ext = path.extname(key).toLowerCase();
    const mimeMap = {
      '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic'
    };
    const fallbackCT = mimeMap[ext] || 'application/octet-stream';
    const filename = path.basename(key);

    // S3 mode
    if (S3_BUCKET) {
      const range = req.headers.range;

      const primaryKey = key;
      let head = await s3HeadKey(primaryKey);
      logFiles('S3 head primary', primaryKey, head.ok ? 'OK' : 'MISS');

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
        const base = path.posix.basename(primaryKey);
        const alt2 = base;
        if (alt2 !== primaryKey) {
          const h3 = await s3HeadKey(alt2);
          logFiles('S3 head alt2', alt2, h3.ok ? 'OK' : 'MISS');
          if (h3.ok) { key = alt2; head = h3; }
        }
      }

      if (!head.ok) return res.status(404).json({ error: 'File not found' });

      const size = head.meta.ContentLength;
      const ct   = head.meta.ContentType || fallbackCT;

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
          .on('error', () => { if (!res.headersSent) res.status(500).end(); })
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
        .on('error', () => { if (!res.headersSent) res.status(500).end(); })
        .pipe(res);
    }

    // Local mode
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const candidateRels = localCandidatesFromKey(key);
    let chosenPath = null;

    for (const rel of candidateRels) {
      const p = path.resolve(uploadsDir, rel);
      if (p.startsWith(uploadsDir) && fs.existsSync(p)) { chosenPath = p; break; }
    }

    if (!chosenPath) {
      const base = path.basename(key);
      const p = path.resolve(uploadsDir, base);
      if (p.startsWith(uploadsDir) && fs.existsSync(p)) chosenPath = p;
    }

    if (!chosenPath) return res.sendStatus(404);

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

// ===============================
// END Part 6/6
// ===============================
