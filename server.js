// File: server.js

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const mysql      = require('mysql2/promise');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ─── MySQL Setup ─────────────────────────────────────────────────────────
const db = mysql.createPool({
  host:     process.env.RDS_HOSTNAME || process.env.DB_HOST || 'localhost',
  user:     process.env.RDS_USERNAME || process.env.DB_USER || 'root',
  password: process.env.RDS_PASSWORD || process.env.DB_PASS || '',
  database: process.env.RDS_DB_NAME || process.env.DB_NAME || 'firstclassglass_crm',
  port:     process.env.RDS_PORT     ? Number(process.env.RDS_PORT)  :
            process.env.DB_PORT      ? Number(process.env.DB_PORT)   : 3306,
});

// ensure work_orders has the needed columns (defined here, invoked on startup)
async function ensureCols() {
  const cols = [
    { name: 'scheduledDate', type: 'DATETIME NULL' },
    { name: 'pdfPath',       type: 'VARCHAR(255) NULL' },
    { name: 'photoPath',     type: 'TEXT NULL' },
    { name: 'notes',         type: 'TEXT NULL' },
  ];
  for (const { name, type } of cols) {
    const [found] = await db.query(
      `SHOW COLUMNS FROM \`work_orders\` LIKE '${name}'`
    );
    if (!found.length) {
      await db.query(
        `ALTER TABLE \`work_orders\` ADD COLUMN \`${name}\` ${type}`
      );
      console.log(`✅ Column '${name}' added.`);
    }
  }
}

// ─── Authentication ────────────────────────────────────────────────────────

// Register
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
    console.error(err);
    res.status(500).json({ error: 'Failed to register user.' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username & password required' });
  }
  try {
    const [[user]] = await db.execute(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Auth middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── File Uploads ───────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage });
app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));

// ─── Users endpoint ────────────────────────────────────────────────────────
app.get('/users', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, username FROM users WHERE role = 'tech'"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ─── Customers endpoints ────────────────────────────────────────────────────
app.get('/customers', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, name, billingAddress, createdAt FROM customers'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customers.' });
  }
});

app.get('/customers/:id', authenticate, async (req, res) => {
  const cid = +req.params.id;
  try {
    const [rows] = await db.execute(
      'SELECT id, name, billingAddress, createdAt FROM customers WHERE id = ?',
      [cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customer.' });
  }
});

app.post('/customers', authenticate, async (req, res) => {
  const { name, billingAddress } = req.body;
  if (!name || !billingAddress) {
    return res.status(400).json({ error: 'name & billingAddress required' });
  }
  try {
    const [result] = await db.execute(
      'INSERT INTO customers (name, billingAddress) VALUES (?, ?)',
      [name, billingAddress]
    );
    res.status(201).json({ customerId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create customer.' });
  }
});

// ─── Work Orders CRUD ──────────────────────────────────────────────────────
app.get('/work-orders', authenticate, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'tech') {
      const [techRows] = await db.execute(
        `SELECT w.*, u.username AS assignedToName
           FROM work_orders w
           LEFT JOIN users u ON w.assignedTo = u.id
          WHERE w.assignedTo = ?`,
        [req.user.id]
      );
      rows = techRows;
    } else {
      const [allRows] = await db.execute(
        `SELECT w.*, u.username AS assignedToName
           FROM work_orders w
           LEFT JOIN users u ON w.assignedTo = u.id`
      );
      rows = allRows;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.put('/work-orders/:id', authenticate, express.json(), async (req, res) => {
  const wid = +req.params.id;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required.' });
  }
  try {
    await db.execute('UPDATE work_orders SET status = ? WHERE id = ?', [status, wid]);
    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

app.get('/work-orders/:id', authenticate, async (req, res) => {
  const wid = +req.params.id;
  try {
    const [rows] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch work order.' });
  }
});

app.post(
  '/work-orders',
  authenticate,
  upload.fields([
    { name: 'pdfFile',   maxCount: 1 },
    { name: 'photoFile', maxCount: 1 },
  ]),
  async (req, res) => {
    const { poNumber, customer, siteLocation, billingAddress, problemDescription, status } = req.body;
    if (!customer || !siteLocation || !billingAddress || !problemDescription) {
      return res.status(400).json({
        error: 'customer, siteLocation, billingAddress, problemDescription are required.'
      });
    }
    const pdfPath   = req.files.pdfFile   ? `uploads/${req.files.pdfFile[0].filename}`  : null;
    const photoPath = req.files.photoFile ? `uploads/${req.files.photoFile[0].filename}` : null;
    try {
      const [r] = await db.execute(
        `INSERT INTO work_orders
          (poNumber,customer,siteLocation,billingAddress,problemDescription,status,pdfPath,photoPath)
         VALUES (?,?,?,?,?,?,?,?)`,
        [poNumber||'', customer, siteLocation, billingAddress, problemDescription, status, pdfPath, photoPath]
      );
      res.status(201).json({ workOrderId: r.insertId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to save work order.' });
    }
  }
);

app.put(
  '/work-orders/:id/edit',
  authenticate,
  upload.fields([
    { name: 'pdfFile',   maxCount: 1  },
    { name: 'photoFile', maxCount: 20 },  // allow up to 20 attachments
  ]),
  async (req, res) => {
    const wid = +req.params.id;
    try {
      const [[existing]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });

      // PDF replace
      let pdfPath = existing.pdfPath;
      if (req.files.pdfFile) {
        if (pdfPath) fs.unlinkSync(path.resolve(__dirname, pdfPath));
        pdfPath = `uploads/${req.files.pdfFile[0].filename}`;
      }

      // merge photoFile uploads (this includes your drawing.png)
      const oldPhotos = existing.photoPath ? existing.photoPath.split(',') : [];
      const newPhotos = (req.files.photoFile || []).map(f => `uploads/${f.filename}`);
      const mergedPhotos = [...oldPhotos, ...newPhotos];

      // preserve other fields
      const {
        poNumber = existing.poNumber,
        customer = existing.customer,
        siteLocation = existing.siteLocation,
        billingAddress = existing.billingAddress,
        problemDescription = existing.problemDescription,
        status = existing.status,
      } = req.body;

      await db.execute(
        `UPDATE work_orders
           SET poNumber = ?, customer = ?, siteLocation = ?, billingAddress = ?,
               problemDescription = ?, status = ?, pdfPath = ?, photoPath = ?
         WHERE id = ?`,
        [poNumber, customer, siteLocation, billingAddress,
         problemDescription, status, pdfPath, mergedPhotos.join(','), wid]
      );

      const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update work order.' });
    }
  }
);

app.post(
  '/work-orders/:id/notes',
  authenticate,
  express.json(),
  async (req, res) => {
    const wid = +req.params.id;
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Note text is required.' });
    }
    try {
      const [[row]] = await db.execute('SELECT notes FROM work_orders WHERE id = ?', [wid]);
      if (!row) return res.status(404).json({ error: 'Not found.' });

      let notesArr = [];
      if (row.notes) {
        try { notesArr = JSON.parse(row.notes); } catch {}
      }
      notesArr.push({ text, createdAt: new Date().toISOString() });

      await db.execute('UPDATE work_orders SET notes = ? WHERE id = ?', [JSON.stringify(notesArr), wid]);
      res.json({ notes: notesArr });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to add note.' });
    }
  }
);

app.delete(
  '/work-orders/:id/attachment',
  authenticate,
  express.json(),
  async (req, res) => {
    const wid = +req.params.id;
    const { photoPath } = req.body;
    if (!photoPath) {
      return res.status(400).json({ error: 'photoPath required.' });
    }
    try {
      const [[existing]] = await db.execute('SELECT photoPath FROM work_orders WHERE id = ?', [wid]);
      if (!existing) return res.status(404).json({ error: 'Not found.' });

      const photos = existing.photoPath ? existing.photoPath.split(',') : [];
      const updated = photos.filter(p => p !== photoPath);
      const full = path.resolve(__dirname, photoPath);
      if (fs.existsSync(full)) fs.unlinkSync(full);

      await db.execute('UPDATE work_orders SET photoPath = ? WHERE id = ?', [updated.join(','), wid]);
      const [[fresh]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);
      res.json(fresh);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete attachment.' });
    }
  }
);

app.delete(
  '/work-orders/:id',
  authenticate,
  async (req, res) => {
    const wid = +req.params.id;
    try {
      await db.execute('DELETE FROM work_orders WHERE id = ?', [wid]);
      res.json({ message: 'Deleted.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete.' });
    }
  }
);

// Health check & server startup
app.get('/', (_, res) => res.send('API running'));

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
  // Run schema check in background so container won't crash if DB isn't ready
  ensureCols()
    .then(() => console.log('✅ Schema check complete'))
    .catch(err => console.warn('⚠️ Schema check failed (will retry on request)', err.message));
});
