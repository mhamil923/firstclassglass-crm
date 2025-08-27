// File: server.js

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
} = process.env;

const S3_SIGNED_TTL = Number(process.env.S3_SIGNED_TTL || 900);

// ⬆️ Limits (env overridable)
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 75);  // per file
const MAX_FILES        = Number(process.env.MAX_FILES || 120);        // per request (images)
const MAX_FIELDS       = Number(process.env.MAX_FIELDS || 500);       // text fields
const MAX_PARTS        = Number(process.env.MAX_PARTS  || 2000);      // total parts (files + fields)

if (S3_BUCKET) AWS.config.update({ region: AWS_REGION });
else console.warn('⚠️ S3_BUCKET not set; using local disk for uploads.');
const s3 = new AWS.S3();

// ─── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));

// ─── MYSQL ──────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
  port: Number(DB_PORT), waitForConnections: true, connectionLimit: 10, dateStrings: true,
});

// ─── SCHEMA HELPERS ─────────────────────────────────────────────────────────
const SCHEMA = { hasAssignedTo: false };
async function columnExists(table, col) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [col]);
  return rows.length > 0;
}
async function ensureCols() {
  const colsToEnsure = [
    { name: 'scheduledDate', type: 'DATETIME NULL' },
    { name: 'pdfPath',       type: 'VARCHAR(255) NULL' },
    { name: 'photoPath',     type: 'TEXT NULL' },
    { name: 'notes',         type: 'TEXT NULL' },
    { name: 'billingPhone',  type: 'VARCHAR(32) NULL' },
    { name: 'sitePhone',     type: 'VARCHAR(32) NULL' },
    { name: 'customerPhone', type: 'VARCHAR(32) NULL' },
    { name: 'customerEmail', type: 'VARCHAR(255) NULL' },
  ];
  for (const { name, type } of colsToEnsure) {
    try {
      const [found] = await db.query(`SHOW COLUMNS FROM \`work_orders\` LIKE ?`, [name]);
      if (!found.length) await db.query(`ALTER TABLE \`work_orders\` ADD COLUMN \`${name}\` ${type}`);
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
    files: MAX_FILES + 5, // wiggle room, we still enforce ourselves
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

// Error wrapper (map Multer limits to HTTP)
function withMulter(handler) {
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      // If this error came from Multer limits, 413 is appropriate.
      const MULTER_413 = new Set([
        'LIMIT_FILE_SIZE','LIMIT_FILE_COUNT','LIMIT_FIELD_COUNT',
        'LIMIT_PART_COUNT','LIMIT_FIELD_VALUE','LIMIT_FIELD_KEY'
      ]);
      if (MULTER_413.has(err.code)) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'   ? `File too large (>${MAX_FILE_SIZE_MB}MB)` :
          err.code === 'LIMIT_FILE_COUNT'   ? `Too many files (max ${MAX_FILES})` :
          err.code === 'LIMIT_PART_COUNT'   ? `Too many parts in form-data` :
          err.code === 'LIMIT_FIELD_COUNT'  ? `Too many fields (max ${MAX_FIELDS})` :
          'Request too large';
        return res.status(413).json({ error: msg, code: err.code });
      }
      // IMPORTANT: Unexpected field should be a 400, not 413.
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Unexpected file field', code: err.code });
      }
      console.error('Upload error:', err);
      return res.status(400).json({ error: 'Upload failed: ' + err.message, code: err.code });
    });
  };
}

// Helpers for .any()
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
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
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
app.get('/customers/:id', authenticate, async (req, res) => {
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
    let where = ''; const params = [];
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech') { where = ' WHERE w.assignedTo = ?'; params.push(req.user.id); }
    const [rows] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id${where}`, params
    );
    res.json(rows);
  } catch (err) { console.error('Work-orders list error:', err); res.status(500).json({ error: 'Failed to fetch work orders.' }); }
});

app.get('/work-orders/search', authenticate, async (req, res) => {
  const { customer = '', poNumber = '', siteLocation = '' } = req.query;
  try {
    const params = [`%${customer}%`, `%${poNumber}%`, `%${siteLocation}%`];
    let where = ` WHERE w.customer LIKE ? AND w.poNumber LIKE ? AND w.siteLocation LIKE ?`;
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech') { where += ' AND w.assignedTo = ?'; params.push(req.user.id); }
    const [rows] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id ${where}`, params
    );
    res.json(rows);
  } catch (err) { console.error('Work-orders search error:', err); res.status(500).json({ error: 'Search failed.' }); }
});

app.get('/work-orders/:id', authenticate, async (req, res) => {
  try {
    const [[row]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech' && row.assignedTo !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(row);
  } catch (err) { console.error('Work-order get error:', err); res.status(500).json({ error: 'Failed to fetch work order.' }); }
});

app.put('/work-orders/:id', authenticate, express.json(), async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });
  try {
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech') {
      const [[row]] = await db.execute('SELECT assignedTo FROM work_orders WHERE id = ?', [req.params.id]);
      if (!row || row.assignedTo !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    await db.execute('UPDATE work_orders SET status = ? WHERE id = ?', [status, req.params.id]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    res.json(updated);
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

// CREATE — any field names; one PDF (optional) + images
app.post(
  '/work-orders',
  authenticate,
  withMulter(upload.any()),
  async (req, res) => {
    try {
      const {
        poNumber = '', customer, siteLocation = '', billingAddress,
        problemDescription, status = 'Parts In', assignedTo,
        billingPhone = null, sitePhone = null, customerPhone = null, customerEmail = null,
      } = req.body;

      if (!customer || !billingAddress || !problemDescription) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const { pdf, images } = splitFilesAny(req.files || []);
      if (!enforceImageCountOr413(res, images)) return;

      const pdfPath   = pdf ? fileKey(pdf) : null;
      const firstImg  = images[0] ? fileKey(images[0]) : null;

      const cols = [
        'poNumber','customer','siteLocation','billingAddress',
        'problemDescription','status','pdfPath','photoPath',
        'billingPhone','sitePhone','customerPhone','customerEmail'
      ];
      const vals = [
        poNumber, customer, siteLocation, billingAddress,
        problemDescription, status, pdfPath, firstImg,
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
  }
);

// EDIT — any field names; replace PDF if present; append images
app.put(
  '/work-orders/:id/edit',
  authenticate,
  withMulter(upload.any()),
  async (req, res) => {
    try {
      const wid = req.params.id;
      const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });
      if (SCHEMA.hasAssignedTo && req.user.role === 'tech' && existing.assignedTo !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { pdf, images } = splitFilesAny(req.files || []);
      if (!enforceImageCountOr413(res, images)) return;

      // Replace PDF if provided
      let pdfPath = existing.pdfPath;
      if (pdf) {
        try {
          if (pdfPath && /^uploads\//.test(pdfPath)) {
            if (S3_BUCKET) await s3.deleteObject({ Bucket: S3_BUCKET, Key: pdfPath }).promise();
            else {
              const full = path.resolve(__dirname, 'uploads', pdfPath.replace(/^uploads\//, ''));
              if (fs.existsSync(full)) fs.unlinkSync(full);
            }
          }
        } catch (e) { console.warn('⚠️ PDF delete old:', e.message); }
        pdfPath = fileKey(pdf);
      }

      // Append images
      const oldPhotos = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
      const newPhotos = images.map(fileKey);
      const merged    = [...oldPhotos, ...newPhotos];

      const {
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

      let sql = `UPDATE work_orders
                 SET poNumber=?,customer=?,siteLocation=?,billingAddress=?,
                     problemDescription=?,status=?,pdfPath=?,photoPath=?,
                     billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?
                 WHERE id=?`;
      const params = [
        poNumber, customer, siteLocation, billingAddress,
        problemDescription, status, pdfPath || null, merged.join(','),
        billingPhone || null, sitePhone || null, customerPhone || null, customerEmail || null,
        wid
      ];
      if (SCHEMA.hasAssignedTo) {
        sql = `UPDATE work_orders
               SET poNumber=?,customer=?,siteLocation=?,billingAddress=?,
                   problemDescription=?,status=?,pdfPath=?,photoPath=?,
                   billingPhone=?,sitePhone=?,customerPhone=?,customerEmail=?,assignedTo=?
               WHERE id=?`;
        const assignedToVal = (assignedTo === '' || assignedTo === undefined) ? null : Number(assignedTo);
        params.splice(12, 0, assignedToVal);
      }

      await db.execute(sql, params);
      const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json(updated);
    } catch (err) {
      console.error('Work-order edit error:', err);
      res.status(500).json({ error: 'Failed to update work order.' });
    }
  }
);

// Append a single photo (legacy)
app.post(
  '/work-orders/:id/append-photo',
  authenticate,
  withMulter(upload.any()),
  async (req, res) => {
    try {
      const wid = req.params.id;
      const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });
      if (SCHEMA.hasAssignedTo && req.user.role === 'tech' && existing.assignedTo !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { images } = splitFilesAny(req.files || []);
      if (!images.length) return res.status(400).json({ error: 'No image provided.' });

      const oldPhotos = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
      const merged = [...oldPhotos, fileKey(images[0])];

      await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [merged.join(','), wid]);
      const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json(updated);
    } catch (err) { console.error('Append-photo error:', err); res.status(500).json({ error: 'Failed to append photo.' }); }
  }
);

// Append multiple photos (preferred)
app.post(
  '/work-orders/:id/append-photos',
  authenticate,
  withMulter(upload.any()),
  async (req, res) => {
    try {
      const wid = req.params.id;
      const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });
      if (SCHEMA.hasAssignedTo && req.user.role === 'tech' && existing.assignedTo !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { images } = splitFilesAny(req.files || []);
      if (!enforceImageCountOr413(res, images)) return;
      if (!images.length) return res.status(400).json({ error: 'No images provided.' });

      const oldPhotos = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
      const merged = [...oldPhotos, ...images.map(fileKey)];

      await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [merged.join(','), wid]);
      const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json(updated);
    } catch (err) { console.error('Append-photos error:', err); res.status(500).json({ error: 'Failed to append photos.' }); }
  }
);

// Assign / date / notes / delete endpoints (unchanged) ───────────────────────
app.put('/work-orders/:id/assign', authenticate, authorize('dispatcher', 'admin'), express.json(), async (req, res) => {
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
    res.json(updated);
  } catch (err) { console.error('Assign error:', err); res.status(500).json({ error: 'Failed to assign work order.' }); }
});

app.put('/work-orders/:id/update-date', authenticate, authorize('dispatcher', 'admin'), express.json(), async (req, res) => {
  try {
    const { scheduledDate, status } = req.body;
    if (!scheduledDate) return res.status(400).json({ error: 'scheduledDate required' });
    const params = [scheduledDate, req.params.id];
    let sql = 'UPDATE work_orders SET scheduledDate = ? WHERE id = ?';
    if (status) { sql = 'UPDATE work_orders SET scheduledDate = ?, status = ? WHERE id = ?'; params.splice(1, 0, status); }
    await db.execute(sql, params);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) { console.error('Update date error:', err); res.status(500).json({ error: 'Failed to update date.' }); }
});

app.post('/work-orders/:id/notes', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id; const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Note text required.' });
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech') {
      const [[row]] = await db.execute('SELECT assignedTo FROM work_orders WHERE id = ?', [wid]);
      if (!row || row.assignedTo !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const [[row2]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
    let arr = []; try { arr = row2?.notes ? JSON.parse(row2.notes) : []; } catch { arr = []; }
    arr.push({ text, createdAt: new Date().toISOString(), by: req.user.username });
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) { console.error('Add note error:', err); res.status(500).json({ error: 'Failed to add note.' }); }
});

app.delete('/work-orders/:id/notes/:index', authenticate, async (req, res) => {
  try {
    const wid = req.params.id; const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid note index' });
    const [[row]] = await db.execute('SELECT assignedTo, notes FROM work_orders WHERE id = ?', [wid]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech' && row.assignedTo !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    let arr = []; try { arr = row.notes ? JSON.parse(row.notes) : []; } catch { arr = []; }
    if (idx >= arr.length) return res.status(400).json({ error: 'Note index out of range' });
    arr.splice(idx, 1);
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) { console.error('Delete note error:', err); res.status(500).json({ error: 'Failed to delete note.' }); }
});

app.delete('/work-orders/:id/notes', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id; const idx = Number(req.body.index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid note index' });
    const [[row]] = await db.execute('SELECT assignedTo, notes FROM work_orders WHERE id = ?', [wid]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech' && row.assignedTo !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    let arr = []; try { arr = row.notes ? JSON.parse(row.notes) : []; } catch { arr = []; }
    if (idx >= arr.length) return res.status(400).json({ error: 'Note index out of range' });
    arr.splice(idx, 1);
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) { console.error('Delete note (body) error:', err); res.status(500).json({ error: 'Failed to delete note.' }); }
});

app.delete('/work-orders/:id/attachment', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id; const { photoPath } = req.body;
    if (!photoPath) return res.status(400).json({ error: 'photoPath required.' });
    if (SCHEMA.hasAssignedTo && req.user.role === 'tech') {
      const [[row]] = await db.execute('SELECT assignedTo FROM work_orders WHERE id = ?', [wid]);
      if (!row || row.assignedTo !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      if (S3_BUCKET) await s3.deleteObject({ Bucket: S3_BUCKET, Key: photoPath }).promise();
      else {
        const full = path.resolve(__dirname, 'uploads', photoPath.replace(/^uploads\//, ''));
        if (fs.existsSync(full)) fs.unlinkSync(full);
      }
    } catch (e) { console.warn('⚠️ Failed to delete file:', e.message); }
    const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
    const keep = (existing.photoPath || '').split(',').filter(p => p && p !== photoPath);
    await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [keep.join(','), wid]);
    const [[fresh]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json(fresh);
  } catch (err) { console.error('Delete attachment error:', err); res.status(500).json({ error: 'Failed to delete attachment.' }); }
});

app.delete('/work-orders/:id', authenticate, authorize('dispatcher', 'admin'), async (req, res) => {
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  if (err) { console.error('Unhandled error:', err); return res.status(500).json({ error: 'Server error' }); }
  next();
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server listening on 0.0.0.0:${PORT}`));
