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

// ─── CONFIG: env‐backed DB, JWT & S3 ──────────────────────────────────────────
const {
  DB_HOST     = 'localhost',
  DB_NAME     = 'firstclassglass_crm',
  DB_USER     = 'root',
  DB_PASS     = '',
  DB_PORT     = '3306',
  JWT_SECRET  = 'supersecretjwtkey',
  S3_BUCKET,                // e.g. 'fcg-crm-migration'
  AWS_REGION = 'us-east-2',
} = process.env;

if (!S3_BUCKET) {
  console.warn('⚠️ S3_BUCKET not set; using local disk for uploads.');
} else {
  AWS.config.update({ region: AWS_REGION });
}
const s3 = new AWS.S3();

// ─── EXPRESS SETUP ───────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ─── MYSQL POOL ───────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host:     DB_HOST,
  user:     DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  port:     Number(DB_PORT),
});

// ─── SCHEMA HELPERS ──────────────────────────────────────────────────────────
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
  ];

  console.log(`🔍 Checking schema on DB "${DB_NAME}"`);
  for (const { name, type } of colsToEnsure) {
    try {
      const [found] = await db.query(`SHOW COLUMNS FROM \`work_orders\` LIKE ?`, [name]);
      if (!found.length) {
        console.log(`⏳ Adding column ${name}`);
        await db.query(`ALTER TABLE \`work_orders\` ADD COLUMN \`${name}\` ${type}`);
        console.log(`✅ Column '${name}' added.`);
      }
    } catch (err) {
      console.warn(`⚠️ Schema-check error for '${name}':`, err.message);
    }
  }

  try {
    SCHEMA.hasAssignedTo = await columnExists('work_orders', 'assignedTo');
    console.log(`ℹ️ assignedTo column present: ${SCHEMA.hasAssignedTo}`);
  } catch (e) {
    console.warn('⚠️ Unable to detect assignedTo column:', e.message);
  }
}
ensureCols()
  .then(() => console.log('✅ Initial schema check passed'))
  .catch(err => console.warn('⚠️ Initial schema check failed (continuing):', err.message));

// ─── MULTER CONFIG (S3 or LOCAL) ──────────────────────────────────────────────
let upload;
if (S3_BUCKET) {
  upload = multer({
    storage: multerS3({
      s3,
      bucket: S3_BUCKET,
      acl: 'private',
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const base = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const ext  = path.extname(file.originalname) || '';
        cb(null, `uploads/${base}${ext}`);
      }
    })
  });
} else {
  const localDir = path.resolve(__dirname, 'uploads');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, localDir),
    filename: (req, file, cb) => {
      const base = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const ext  = path.extname(file.originalname) || '';
      cb(null, `${base}${ext}`);
    }
  });
  upload = multer({ storage });
  app.use('/uploads', express.static(localDir)); // local-only convenience
}

// ─── AUTHENTICATION ───────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { username, password, role } = req.body;
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
  const { username, password } = req.body;
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
  const authHeader = req.headers.authorization || '';
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── HEALTH & ROOT ───────────────────────────────────────────────────────────
app.get('/',    (_, res) => res.send('API running'));
app.get('/ping',(_, res) => res.send('pong'));

// ─── USERS ───────────────────────────────────────────────────────────────────
app.get('/users', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, username FROM users');
    res.json(rows);
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────
app.get('/customers', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, name, billingAddress, createdAt FROM customers'
    );
    res.json(rows);
  } catch (err) {
    console.error('Customers list error:', err);
    res.status(500).json({ error: 'Failed to fetch customers.' });
  }
});

app.get('/customers/:id', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, name, billingAddress, createdAt FROM customers WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Customer get error:', err);
    res.status(500).json({ error: 'Failed to fetch customer.' });
  }
});

app.post('/customers', authenticate, async (req, res) => {
  const { name, billingAddress } = req.body;
  if (!name || !billingAddress) {
    return res.status(400).json({ error: 'name & billingAddress required' });
  }
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

// ─── WORK ORDERS ─────────────────────────────────────────────────────────────
app.get('/work-orders', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id`
    );
    res.json(rows);
  } catch (err) {
    console.error('Work-orders list error:', err);
    res.status(500).json({ error: 'Failed to fetch work orders.' });
  }
});

app.get('/work-orders/search', authenticate, async (req, res) => {
  const { customer = '', poNumber = '', siteLocation = '' } = req.query;
  try {
    const [rows] = await db.execute(
      `SELECT w.*, u.username AS assignedToName
         FROM work_orders w
         LEFT JOIN users u ON w.assignedTo = u.id
        WHERE w.customer LIKE ?
          AND w.poNumber LIKE ?
          AND w.siteLocation LIKE ?`,
      [`%${customer}%`, `%${poNumber}%`, `%${siteLocation}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error('Work-orders search error:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.get('/work-orders/:id', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Work-order get error:', err);
    res.status(500).json({ error: 'Failed to fetch work order.' });
  }
});

app.put('/work-orders/:id', authenticate, express.json(), async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });
  try {
    await db.execute('UPDATE work_orders SET status = ? WHERE id = ?', [status, req.params.id]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Work-order status update error:', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// CREATE (null-safe, S3/local, optional assignedTo)
app.post(
  '/work-orders',
  authenticate,
  upload.fields([
    { name: 'pdfFile',   maxCount: 1 },
    { name: 'photoFile', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const {
        poNumber = '',
        customer,
        siteLocation = '',
        billingAddress,
        problemDescription,
        status = 'Needs to be Scheduled',
        assignedTo
      } = req.body;

      if (!customer || !billingAddress || !problemDescription) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const pdfPath = req.files?.pdfFile?.[0]
        ? (S3_BUCKET ? req.files.pdfFile[0].key : req.files.pdfFile[0].filename)
        : null;

      const photoPath = req.files?.photoFile?.[0]
        ? (S3_BUCKET ? req.files.photoFile[0].key : req.files.photoFile[0].filename)
        : null;

      const values = [poNumber, customer, siteLocation, billingAddress, problemDescription, status, pdfPath, photoPath];
      let sql = `INSERT INTO work_orders
                 (poNumber,customer,siteLocation,billingAddress,problemDescription,status,pdfPath,photoPath) 
                 VALUES (?,?,?,?,?,?,?,?)`;

      // If table has assignedTo, include it
      if (SCHEMA.hasAssignedTo && assignedTo !== undefined && assignedTo !== '') {
        const assignedToVal = Number.isFinite(Number(assignedTo)) ? Number(assignedTo) : null;
        sql = `INSERT INTO work_orders
               (poNumber,customer,siteLocation,billingAddress,problemDescription,status,pdfPath,photoPath,assignedTo)
               VALUES (?,?,?,?,?,?,?,?,?)`;
        values.push(assignedToVal);
      }

      const [r] = await db.execute(sql, values);
      res.status(201).json({ workOrderId: r.insertId });
    } catch (err) {
      console.error('Work-order create error:', err);
      res.status(500).json({ error: 'Failed to save work order.' });
    }
  }
);

// EDIT (handles replacing files; null-safe)
app.put(
  '/work-orders/:id/edit',
  authenticate,
  upload.fields([
    { name: 'pdfFile',   maxCount: 1 },
    { name: 'photoFile', maxCount: 20 }
  ]),
  async (req, res) => {
    try {
      const wid = req.params.id;
      const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });

      // PDF
      let pdfPath = existing.pdfPath;
      if (req.files?.pdfFile?.[0]) {
        // delete old
        if (pdfPath) {
          try {
            if (S3_BUCKET) {
              await s3.deleteObject({ Bucket: S3_BUCKET, Key: pdfPath }).promise();
            } else {
              const full = path.resolve(__dirname, 'uploads', pdfPath);
              if (fs.existsSync(full)) fs.unlinkSync(full);
            }
          } catch (e) {
            console.warn('⚠️ Failed to delete old PDF:', e.message);
          }
        }
        pdfPath = S3_BUCKET ? req.files.pdfFile[0].key : req.files.pdfFile[0].filename;
      }

      // Photos (append)
      const oldPhotos = existing.photoPath ? existing.photoPath.split(',').filter(Boolean) : [];
      const newPhotos = (req.files?.photoFile || []).map(f => (S3_BUCKET ? f.key : f.filename));
      const merged    = [...oldPhotos, ...newPhotos];

      // Fields
      const {
        poNumber = existing.poNumber,
        customer = existing.customer,
        siteLocation = existing.siteLocation,
        billingAddress = existing.billingAddress,
        problemDescription = existing.problemDescription,
        status = existing.status,
        assignedTo = existing.assignedTo
      } = req.body;

      let sql = `UPDATE work_orders
                 SET poNumber=?,customer=?,siteLocation=?,billingAddress=?,
                     problemDescription=?,status=?,pdfPath=?,photoPath=?
                 WHERE id=?`;
      const params = [poNumber, customer, siteLocation, billingAddress, problemDescription, status, pdfPath || null, merged.join(','), wid];

      if (SCHEMA.hasAssignedTo) {
        sql = `UPDATE work_orders
               SET poNumber=?,customer=?,siteLocation=?,billingAddress=?,
                   problemDescription=?,status=?,pdfPath=?,photoPath=?,assignedTo=?
               WHERE id=?`;
        const assignedToVal = (assignedTo === '' || assignedTo === undefined) ? null : Number(assignedTo);
        params.splice(8, 0, assignedToVal); // insert before wid
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

app.post('/work-orders/:id/notes', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id;
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Note text required.' });
    const [[row]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
    const arr = row?.notes ? JSON.parse(row.notes) : [];
    arr.push({ text, createdAt: new Date().toISOString() });
    await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(arr), wid]);
    res.json({ notes: arr });
  } catch (err) {
    console.error('Add note error:', err);
    res.status(500).json({ error: 'Failed to add note.' });
  }
});

app.delete('/work-orders/:id/attachment', authenticate, express.json(), async (req, res) => {
  try {
    const wid = req.params.id;
    const { photoPath } = req.body;
    if (!photoPath) return res.status(400).json({ error: 'photoPath required.' });

    // delete file
    try {
      if (S3_BUCKET) {
        await s3.deleteObject({ Bucket: S3_BUCKET, Key: photoPath }).promise();
      } else {
        const full = path.resolve(__dirname, 'uploads', photoPath);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      }
    } catch (e) {
      console.warn('⚠️ Failed to delete file:', e.message);
    }

    // update DB
    const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
    const keep = (existing.photoPath || '')
      .split(',')
      .filter(p => p && p !== photoPath);
    await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [keep.join(','), wid]);

    const [[fresh]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json(fresh);
  } catch (err) {
    console.error('Delete attachment error:', err);
    res.status(500).json({ error: 'Failed to delete attachment.' });
  }
});

app.delete('/work-orders/:id', authenticate, async (req, res) => {
  try {
    await db.execute('DELETE FROM work_orders WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted.' });
  } catch (err) {
    console.error('Work-order delete error:', err);
    res.status(500).json({ error: 'Failed to delete.' });
  }
});

// ─── FILE RESOLVER (S3 or local) ─────────────────────────────────────────────
app.get('/files', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'Missing ?key=' });

    // Only allow keys under the uploads/ prefix
    if (!String(key).startsWith('uploads/')) {
      return res.status(400).json({ error: 'Invalid key' });
    }

    if (S3_BUCKET) {
      // Pre-signed S3 URL good for 60 seconds
      const url = s3.getSignedUrl('getObject', {
        Bucket: S3_BUCKET,
        Key: key,
        Expires: 60,
      });
      return res.redirect(302, url);
    }

    // Local disk fallback
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const safePath = path.resolve(uploadsDir, key.replace(/^uploads\//, ''));
    if (!safePath.startsWith(uploadsDir)) {
      return res.status(400).json({ error: 'Bad path' });
    }
    if (!fs.existsSync(safePath)) return res.sendStatus(404);
    return res.sendFile(safePath);
  } catch (err) {
    console.error('File resolver error:', err);
    res.status(500).json({ error: 'Failed to resolve file' });
  }
});

// ─── START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
});
