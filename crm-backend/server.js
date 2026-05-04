// ===============================
// server.js — FULL FILE (Part 1/6)
// Copy/paste in order: Part 1 → Part 6
// ===============================

// ─── IMPORTS ─────────────────────────────────────────────────────────────────
require('dotenv').config(); // Load .env file FIRST before accessing process.env

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
const nodemailer = require('nodemailer');
const crypto     = require('crypto');

// PO PDF vendor/number detection from PDF content (with OCR support)
const { analyzePoPdf, detectSupplierFromText, detectPoNumberFromText, extractWorkOrderFields, extractTextSmart, extractTextFromPdf, extractTextFromScannedPdf } = require('./utils/poVendorDetector');
const PDFDocument = require('pdfkit');

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
  ASSIGNEE_EXTRA_USERNAMES = 'Jeff,tech1,Mikey',
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
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  APP_PUBLIC_URL = '',
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

// Log route optimization configuration
if (GOOGLE_MAPS_API_KEY) {
  console.log('✅ GOOGLE_MAPS_API_KEY is set (route optimization enabled)');
} else {
  console.warn('⚠️ GOOGLE_MAPS_API_KEY not set; route optimization will use fallback algorithm');
}

// ─── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));

// Stripe webhook needs raw body BEFORE global JSON parser
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  await handleStripeWebhook(req, res);
});

// Parse JSON + URL-encoded as usual
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

// Also accept text/plain bodies
app.use(bodyParser.text({ type: 'text/plain', limit: '1mb' }));

// Block known vulnerability scanners by IP (return 200 to avoid EB 4xx health penalty)
app.use((req, res, next) => {
  const blockedIPs = ['217.76.55.57'];
  const clientIP = req.headers['x-forwarded-for'] || req.ip || '';
  if (blockedIPs.some(ip => clientIP.includes(ip))) {
    return res.status(200).end();
  }
  next();
});

// Block common bot scanner paths (return 200 to avoid EB 4xx health penalty)
app.use((req, res, next) => {
  if (/wp-config|wp-admin|wp-login|\.env$|phpmyadmin|xmlrpc/i.test(req.path)) {
    return res.status(200).end();
  }
  next();
});

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
  'Declined',
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
  ['declined','Declined'],
]);

const STATUS_SHORT = new Map([
  ['ne', 'New'],
  ['sc', 'Scheduled'],
  ['ap', 'Approved'],
  ['wf', 'Waiting for Approval'],
  ['de', 'Declined'],
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
    { name: 'customerId',        type: 'INT NULL' },
    { name: 'updatedAt',         type: 'DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
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

// ─── WORK_ORDER_POS TABLE (multi-PO support) ────────────────────────────────
async function ensurePoTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_order_pos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        workOrderId INT NOT NULL,
        poNumber    VARCHAR(64)  NULL,
        poSupplier  VARCHAR(128) NULL,
        poPdfPath   VARCHAR(255) NULL,
        poPickedUp  TINYINT(1) NOT NULL DEFAULT 0,
        createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workOrderId) REFERENCES work_orders(id) ON DELETE CASCADE
      )
    `);
    console.log('[PO Table] work_order_pos table ready');
  } catch (e) {
    console.warn('[PO Table] Could not create work_order_pos:', e.message);
    return;
  }

  // One-time migration: copy legacy PO data from work_orders into work_order_pos
  try {
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM work_order_pos');
    if (cnt === 0) {
      const [legacyRows] = await db.query(`
        SELECT id, poNumber, poSupplier, poPdfPath, poPickedUp
        FROM work_orders
        WHERE poNumber IS NOT NULL OR poSupplier IS NOT NULL OR poPdfPath IS NOT NULL
      `);
      if (legacyRows.length) {
        for (const r of legacyRows) {
          await db.query(
            `INSERT INTO work_order_pos (workOrderId, poNumber, poSupplier, poPdfPath, poPickedUp)
             VALUES (?, ?, ?, ?, ?)`,
            [r.id, r.poNumber || null, r.poSupplier || null, r.poPdfPath || null, Number(r.poPickedUp) ? 1 : 0]
          );
        }
        console.log(`[PO Table] Migrated ${legacyRows.length} legacy PO(s) into work_order_pos`);
      } else {
        console.log('[PO Table] No legacy PO data to migrate');
      }
    }
  } catch (e) {
    console.warn('[PO Table] Migration check failed:', e.message);
  }
}

ensurePoTable().catch(() => {});

// ─── WORK_ORDER_ESTIMATE_PDFS TABLE (multi estimate PDFs) ───────────────────
async function ensureEstimatePdfsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_order_estimate_pdfs (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        workOrderId  INT NOT NULL,
        filename     VARCHAR(500) NULL,
        originalName VARCHAR(500) NULL,
        uploadedAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workOrderId) REFERENCES work_orders(id) ON DELETE CASCADE
      )
    `);
    console.log('[Estimate PDF Table] work_order_estimate_pdfs table ready');
  } catch (e) {
    console.warn('[Estimate PDF Table] Could not create work_order_estimate_pdfs:', e.message);
  }
}

ensureEstimatePdfsTable().catch(() => {});

// ─── SUPPLIER_PICKUPS TABLE ─────────────────────────────────────────────────
async function ensureSupplierPickupsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS supplier_pickups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        supplier VARCHAR(255) NOT NULL,
        scheduledDate DATE NULL,
        notes TEXT,
        assignedTech VARCHAR(100),
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[Supplier Pickups Table] supplier_pickups table ready');
  } catch (e) {
    console.warn('[Supplier Pickups Table] Could not create supplier_pickups:', e.message);
  }
}

ensureSupplierPickupsTable().catch(() => {});

/**
 * Sync the first (oldest) PO from work_order_pos back to the legacy columns
 * on work_orders so existing code that reads those columns still works.
 */
async function syncLegacyPoColumns(workOrderId) {
  try {
    const [rows] = await db.query(
      'SELECT poNumber, poSupplier, poPdfPath, poPickedUp FROM work_order_pos WHERE workOrderId = ? ORDER BY createdAt ASC LIMIT 1',
      [workOrderId]
    );
    if (rows.length) {
      const r = rows[0];
      await db.query(
        'UPDATE work_orders SET poNumber=?, poSupplier=?, poPdfPath=?, poPickedUp=? WHERE id=?',
        [r.poNumber || null, r.poSupplier || null, r.poPdfPath || null, Number(r.poPickedUp) ? 1 : 0, workOrderId]
      );
    } else {
      // No POs left — clear legacy columns
      await db.query(
        'UPDATE work_orders SET poNumber=NULL, poSupplier=NULL, poPdfPath=NULL, poPickedUp=0 WHERE id=?',
        [workOrderId]
      );
    }
  } catch (e) {
    console.warn('[PO Sync] Failed to sync legacy columns for WO', workOrderId, ':', e.message);
  }
}

// ─── CUSTOMERS TABLE SCHEMA ─────────────────────────────────────────────────
async function ensureCustomerCols() {
  const custCols = [
    { name: 'companyName',  type: 'VARCHAR(255) NULL' },
    { name: 'contactName',  type: 'VARCHAR(255) NULL' },
    { name: 'email',        type: 'VARCHAR(255) NULL' },
    { name: 'phone',        type: 'VARCHAR(50) NULL' },
    { name: 'fax',          type: 'VARCHAR(50) NULL' },
    { name: 'billingCity',  type: 'VARCHAR(100) NULL' },
    { name: 'billingState', type: 'VARCHAR(50) NULL' },
    { name: 'billingZip',   type: 'VARCHAR(20) NULL' },
    { name: 'siteAddress',  type: 'VARCHAR(255) NULL' },
    { name: 'siteCity',     type: 'VARCHAR(100) NULL' },
    { name: 'siteState',    type: 'VARCHAR(50) NULL' },
    { name: 'siteZip',      type: 'VARCHAR(20) NULL' },
    { name: 'notes',        type: 'TEXT NULL' },
    { name: 'isActive',     type: 'TINYINT(1) NOT NULL DEFAULT 1' },
    { name: 'updatedAt',    type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
  ];

  try {
    for (const { name, type } of custCols) {
      const [found] = await db.query(`SHOW COLUMNS FROM \`customers\` LIKE ?`, [name]);
      if (!found.length) {
        await db.query(`ALTER TABLE \`customers\` ADD COLUMN \`${name}\` ${type}`);
        console.log(`[Customers] Added column ${name}`);
      }
    }
  } catch (e) {
    console.warn('[Customers] Schema ensure failed:', e.message);
    return;
  }

  // One-time migration: copy name → companyName where companyName is null
  try {
    await db.query(`UPDATE customers SET companyName = name WHERE companyName IS NULL AND name IS NOT NULL`);
  } catch (e) {
    console.warn('[Customers] name→companyName migration failed:', e.message);
  }

  // Seed/update known customers with full details
  const seeds = [
    { name: 'Clear Vision',         companyName: 'Clear Vision',   billingCity: 'Newbury Park', billingState: 'CA', billingZip: '91320' },
    { name: 'True Source',           companyName: 'True Source',    billingCity: 'Lincoln',      billingState: 'RI', billingZip: '02865-4415', phone: '800-556-6484', fax: '800-334-5277' },
    { name: 'CLM',                   companyName: 'CLM Midwest',   billingCity: 'River Grove',  billingState: 'IL', billingZip: '60171' },
    { name: 'KFM247',               companyName: 'KFM',           billingCity: 'Woodbine',     billingState: 'MD', billingZip: '21797' },
    { name: '1st Time Fixed LLC',   companyName: '1st Time Fixed', billingCity: 'Bensenville',  billingState: 'IL', billingZip: '60106' },
  ];

  for (const s of seeds) {
    try {
      const sets = [];
      const vals = [];
      if (s.companyName)  { sets.push('companyName = ?');  vals.push(s.companyName); }
      if (s.billingCity)  { sets.push('billingCity = ?');   vals.push(s.billingCity); }
      if (s.billingState) { sets.push('billingState = ?');  vals.push(s.billingState); }
      if (s.billingZip)   { sets.push('billingZip = ?');    vals.push(s.billingZip); }
      if (s.phone)        { sets.push('phone = ?');         vals.push(s.phone); }
      if (s.fax)          { sets.push('fax = ?');           vals.push(s.fax); }
      if (sets.length) {
        vals.push(s.name);
        await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE name = ? AND (billingCity IS NULL OR billingCity = '')`, vals);
      }
    } catch (e) {
      // Seeded customer may not exist yet — that's fine
    }
  }

  console.log('[Customers] Schema and seed data ready');
}

ensureCustomerCols().catch(() => {});

// ─── ENSURE TECH USERS ──────────────────────────────────────────────────────
async function ensureTechUsers() {
  const requiredTechs = [
    { username: 'Mikey', password: '1234!', role: 'dispatcher' },
  ];

  for (const t of requiredTechs) {
    try {
      const [existing] = await db.execute('SELECT id FROM users WHERE username = ?', [t.username]);
      if (existing.length === 0) {
        const hash = await bcrypt.hash(t.password, 10);
        await db.execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [t.username, hash, t.role]);
        console.log(`[Users] Created tech user: ${t.username}`);
      }
    } catch (e) {
      console.warn(`[Users] Failed to ensure tech user ${t.username}:`, e.message);
    }
  }
}

ensureTechUsers().catch(() => {});

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
    SELECT w.*, ${assignedSel}, ${createdSel},
           poAgg.allPoNumbers
      FROM work_orders w
      ${join}
      LEFT JOIN (
        SELECT workOrderId, GROUP_CONCAT(poNumber ORDER BY createdAt ASC) AS allPoNumbers
        FROM work_order_pos
        WHERE poNumber IS NOT NULL AND poNumber <> ''
        GROUP BY workOrderId
      ) poAgg ON poAgg.workOrderId = w.id
      ${whereSql}
      ${orderSql}
      ${limitSql}
  `;
}

/**
 * Format a comma-separated list of PO numbers with # prefix.
 * E.g. "485,486,498" → "#485, #486, #498"
 */
function formatPoNumberList(csv) {
  if (!csv) return '';
  return csv.split(',').filter(Boolean).map(n => `#${n.trim()}`).join(', ');
}

// ─── ESTIMATES TABLES ────────────────────────────────────────────────────────
async function ensureEstimateTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS estimates (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        customerId      INT NOT NULL,
        workOrderId     INT NULL,
        status          VARCHAR(50) NOT NULL DEFAULT 'Draft',
        issueDate       DATE DEFAULT (CURRENT_DATE),
        expirationDate  DATE NULL,
        poNumber        VARCHAR(100) NULL,
        projectName     VARCHAR(255) NULL,
        projectAddress  VARCHAR(255) NULL,
        projectCity     VARCHAR(100) NULL,
        projectState    VARCHAR(50) NULL,
        projectZip      VARCHAR(20) NULL,
        subtotal        DECIMAL(10,2) DEFAULT 0,
        taxRate         DECIMAL(5,2) DEFAULT 0,
        taxAmount       DECIMAL(10,2) DEFAULT 0,
        total           DECIMAL(10,2) DEFAULT 0,
        notes           TEXT NULL,
        terms           TEXT NULL,
        billingAddress  VARCHAR(255) NULL,
        billingCity     VARCHAR(100) NULL,
        billingState    VARCHAR(50) NULL,
        billingZip      VARCHAR(20) NULL,
        pdfPath         VARCHAR(255) NULL,
        sentAt          DATETIME NULL,
        acceptedAt      DATETIME NULL,
        declinedAt      DATETIME NULL,
        createdAt       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt       DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[Estimates] estimates table ready');
  } catch (e) {
    console.warn('[Estimates] Could not create estimates table:', e.message);
  }

  // Ensure billing address columns exist (for existing installs)
  try {
    const billingCols = [
      { name: 'billingAddress', type: 'VARCHAR(255) NULL' },
      { name: 'billingCity',    type: 'VARCHAR(100) NULL' },
      { name: 'billingState',   type: 'VARCHAR(50) NULL' },
      { name: 'billingZip',     type: 'VARCHAR(20) NULL' },
    ];
    for (const { name, type } of billingCols) {
      const [found] = await db.query(`SHOW COLUMNS FROM \`estimates\` LIKE ?`, [name]);
      if (!found.length) {
        await db.query(`ALTER TABLE \`estimates\` ADD COLUMN \`${name}\` ${type}`);
        console.log(`[Estimates] Added column ${name}`);
      }
    }
  } catch (e) {
    console.warn('[Estimates] Could not ensure billing columns:', e.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS estimate_line_items (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        estimateId  INT NOT NULL,
        sortOrder   INT DEFAULT 0,
        description VARCHAR(500) NOT NULL,
        quantity    DECIMAL(10,2) NULL,
        amount      DECIMAL(10,2) NOT NULL,
        createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (estimateId) REFERENCES estimates(id) ON DELETE CASCADE
      )
    `);
    console.log('[Estimates] estimate_line_items table ready');
    // Add itemName column if missing
    const [estLiCols] = await db.query("SHOW COLUMNS FROM estimate_line_items LIKE 'itemName'");
    if (!estLiCols.length) {
      await db.query("ALTER TABLE estimate_line_items ADD COLUMN itemName VARCHAR(500) NULL AFTER sortOrder");
      console.log('[Estimates] Added itemName column to estimate_line_items');
    }
  } catch (e) {
    console.warn('[Estimates] Could not create estimate_line_items table:', e.message);
  }
}

ensureEstimateTables().catch(() => {});

// ─── INVOICES / PAYMENTS / SETTINGS TABLES ──────────────────────────────────
async function ensureInvoiceTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        settingKey   VARCHAR(100) PRIMARY KEY,
        settingValue TEXT NULL,
        updatedAt    DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query("INSERT IGNORE INTO settings (settingKey, settingValue) VALUES ('nextInvoiceNumber', '1')");
    await db.query("INSERT IGNORE INTO settings (settingKey, settingValue) VALUES ('defaultInvoiceTerms', ?)", [
      'ALL PAYMENTS MUST BE MADE 45 DAYS AFTER INVOICE DATE OR A 15% LATE FEE WILL BE APPLIED'
    ]);
    console.log('[Invoices] settings table ready');
  } catch (e) {
    console.warn('[Invoices] Could not create settings table:', e.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        invoiceNumber   VARCHAR(50) NOT NULL,
        customerId      INT NOT NULL,
        workOrderId     INT NULL,
        estimateId      INT NULL,
        status          VARCHAR(50) NOT NULL DEFAULT 'Draft',
        issueDate       DATE DEFAULT (CURRENT_DATE),
        dueDate         DATE NULL,
        poNumber        VARCHAR(100) NULL,
        projectName     VARCHAR(255) NULL,
        shipToAddress   VARCHAR(255) NULL,
        shipToCity      VARCHAR(100) NULL,
        shipToState     VARCHAR(50) NULL,
        shipToZip       VARCHAR(20) NULL,
        billingAddress  VARCHAR(255) NULL,
        billingCity     VARCHAR(100) NULL,
        billingState    VARCHAR(50) NULL,
        billingZip      VARCHAR(20) NULL,
        subtotal        DECIMAL(10,2) DEFAULT 0,
        taxRate         DECIMAL(5,2) DEFAULT 0,
        taxAmount       DECIMAL(10,2) DEFAULT 0,
        total           DECIMAL(10,2) DEFAULT 0,
        amountPaid      DECIMAL(10,2) DEFAULT 0,
        balanceDue      DECIMAL(10,2) DEFAULT 0,
        notes           TEXT NULL,
        terms           TEXT NULL,
        pdfPath         VARCHAR(255) NULL,
        sentAt          DATETIME NULL,
        paidAt          DATETIME NULL,
        createdAt       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt       DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[Invoices] invoices table ready');
  } catch (e) {
    console.warn('[Invoices] Could not create invoices table:', e.message);
  }

  // Ensure billing address columns exist (for existing installs)
  try {
    const billingCols = [
      { name: 'billingAddress', type: 'VARCHAR(255) NULL' },
      { name: 'billingCity',    type: 'VARCHAR(100) NULL' },
      { name: 'billingState',   type: 'VARCHAR(50) NULL' },
      { name: 'billingZip',     type: 'VARCHAR(20) NULL' },
    ];
    for (const { name, type } of billingCols) {
      const [found] = await db.query(`SHOW COLUMNS FROM \`invoices\` LIKE ?`, [name]);
      if (!found.length) {
        await db.query(`ALTER TABLE \`invoices\` ADD COLUMN \`${name}\` ${type}`);
        console.log(`[Invoices] Added column ${name}`);
      }
    }
  } catch (e) {
    console.warn('[Invoices] Could not ensure billing columns:', e.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS invoice_line_items (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        invoiceId   INT NOT NULL,
        sortOrder   INT DEFAULT 0,
        description VARCHAR(500) NOT NULL,
        quantity    DECIMAL(10,2) NULL,
        amount      DECIMAL(10,2) NOT NULL,
        createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoiceId) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `);
    console.log('[Invoices] invoice_line_items table ready');
    // Add itemName column if missing
    const [invLiCols] = await db.query("SHOW COLUMNS FROM invoice_line_items LIKE 'itemName'");
    if (!invLiCols.length) {
      await db.query("ALTER TABLE invoice_line_items ADD COLUMN itemName VARCHAR(500) NULL AFTER sortOrder");
      console.log('[Invoices] Added itemName column to invoice_line_items');
    }
  } catch (e) {
    console.warn('[Invoices] Could not create invoice_line_items table:', e.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        invoiceId       INT NOT NULL,
        paymentDate     DATE NOT NULL,
        amount          DECIMAL(10,2) NOT NULL,
        paymentMethod   VARCHAR(50) NULL,
        referenceNumber VARCHAR(100) NULL,
        notes           TEXT NULL,
        createdAt       DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoiceId) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `);
    console.log('[Invoices] payments table ready');
  } catch (e) {
    console.warn('[Invoices] Could not create payments table:', e.message);
  }
}
ensureInvoiceTables().catch(() => {});

// ─── LINE ITEM TEMPLATES TABLE ──────────────────────────────────────────────
async function ensureLineItemTemplateTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS line_item_templates (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        description     VARCHAR(500) NOT NULL,
        defaultQuantity DECIMAL(10,2) DEFAULT 1,
        defaultAmount   DECIMAL(10,2) NULL,
        category        VARCHAR(100) NULL,
        sortOrder       INT DEFAULT 0,
        isActive        TINYINT(1) DEFAULT 1,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[Templates] line_item_templates table ready');

    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM line_item_templates');
    if (cnt === 0) {
      const seeds = [
        ['INITIAL SERVICE CALL', 1, 150.00, 'Service Calls', 1],
        ['EMERGENCY SERVICE CALL', 1, 250.00, 'Service Calls', 2],
        ['RETURN TRIP', 1, 75.00, 'Service Calls', 3],
        ['LABOR', null, null, 'Labor', 4],
      ];
      for (const [desc, qty, amt, cat, ord] of seeds) {
        await db.query(
          'INSERT INTO line_item_templates (description, defaultQuantity, defaultAmount, category, sortOrder) VALUES (?,?,?,?,?)',
          [desc, qty, amt, cat, ord]
        );
      }
      console.log('[Templates] Seeded 4 default templates');
    }
  } catch (e) {
    console.warn('[Templates] Could not create line_item_templates:', e.message);
  }
}
ensureLineItemTemplateTable().catch(() => {});

// ─── PDF TEMPLATES TABLE ────────────────────────────────────────────────────
const DEFAULT_TEMPLATE_CONFIG = {
  pageSize: 'LETTER',
  margins: { top: 40, bottom: 40, left: 50, right: 50 },
  companyInfo: {
    show: true, x: 50, y: 40, width: 220, height: 80, textAlign: 'left',
    name: 'First Class Glass & Mirror, Inc.',
    line1: '1513 Industrial Drive',
    line2: 'Itasca, IL. 60143',
    phone: '630-250-9777',
    fax: '630-250-9727',
    fontSize: 11,
    linesFontSize: 9
  },
  logo: { show: true, x: 260, y: 40, width: 72, height: 72 },
  title: { show: true, x: 400, y: 40, width: 162, height: 40, textAlign: 'right', fontSize: 22, align: 'right' },
  dateBox: { show: true, x: 400, y: 90, width: 162, height: 55, position: 'right' },
  billTo: { show: true, x: 50, y: 155, width: 245, height: 90, textAlign: 'left', label: 'BILL TO', widthPercent: 48 },
  projectBox: { show: true, x: 305, y: 155, width: 257, height: 90, textAlign: 'left', estimateLabel: 'PROJECT NAME/ADDRESS', invoiceLabel: 'SHIP TO' },
  poNumber: { show: true, x: 400, y: 255, width: 162, height: 35, label: 'P.O. No.' },
  lineItems: {
    show: true, x: 50, y: 300, width: 512, height: 130,
    displayMode: 'detailed',
    headerBgColor: '#E0E0E0',
    headerFontSize: 7,
    bodyFontSize: 8,
    qtyColumnWidth: 50,
    totalColumnWidth: 75,
    estimateHeaders: { qty: 'Qty', description: 'DESCRIPTION', total: 'TOTAL' },
    invoiceHeaders: { qty: 'QUANTITY', description: 'DESCRIPTION', total: 'AMOUNT' },
    bidDescriptionLabel: 'Scope of Work'
  },
  footer: {
    show: true, x: 50, y: 700, width: 512, height: 52,
    showTerms: true,
    termsText: '',
    termsFontSize: 8,
    termsBold: false,
    termsAlign: 'left',
    totalLabelWidth: 60,
    totalAmountWidth: 100,
    totalFontSize: 10,
    totalAmountFontSize: 11
  },
  customTextBoxes: [],
  fonts: { body: 'Helvetica', bold: 'Helvetica-Bold' },
  colors: { text: '#000000', headerBg: '#E0E0E0', lineStroke: '#000000' }
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

async function ensurePdfTemplateTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS pdf_templates (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(200) NOT NULL,
        type        ENUM('estimate','invoice','both') DEFAULT 'both',
        config      TEXT NOT NULL,
        isDefault   TINYINT(1) DEFAULT 0,
        isActive    TINYINT(1) DEFAULT 1,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('[PdfTemplates] pdf_templates table ready');

    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM pdf_templates');
    if (cnt === 0) {
      await db.query(
        'INSERT INTO pdf_templates (name, type, config, isDefault) VALUES (?, ?, ?, 1)',
        ['Standard', 'both', JSON.stringify(DEFAULT_TEMPLATE_CONFIG)]
      );
      console.log('[PdfTemplates] Seeded default Standard template');
    }
  } catch (e) {
    console.warn('[PdfTemplates] Could not create pdf_templates:', e.message);
  }
}
ensurePdfTemplateTable().catch(() => {});

// Add templateId column to estimates and invoices if not present
(async () => {
  try {
    const [[estCols]] = await db.query("SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='estimates' AND COLUMN_NAME='templateId'");
    if (!estCols.cnt) await db.query('ALTER TABLE estimates ADD COLUMN templateId INT NULL');
    const [[invCols]] = await db.query("SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='invoices' AND COLUMN_NAME='templateId'");
    if (!invCols.cnt) await db.query('ALTER TABLE invoices ADD COLUMN templateId INT NULL');
    console.log('[Migration] templateId columns ensured on estimates/invoices');
  } catch (e) { console.warn('[Migration] templateId columns:', e.message); }
})();

// One-time migration: set invoice template as default if not already set
(async () => {
  try {
    const [rows] = await db.query("SELECT id FROM pdf_templates WHERE isDefault = 1 AND type = 'invoice' AND isActive = 1");
    if (rows.length === 0) {
      const [result] = await db.query("UPDATE pdf_templates SET isDefault = 1 WHERE type = 'invoice' AND isActive = 1 AND name LIKE '%Invoice%' LIMIT 1");
      if (result.affectedRows) console.log('[Migration] Set invoice template as default');
    }
  } catch (e) { console.warn('[Migration] invoice default:', e.message); }
})();

// ─── EMAIL TABLES ───────────────────────────────────────────────────────────
async function ensureEmailTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_settings (
        id            INT PRIMARY KEY DEFAULT 1,
        smtpHost      VARCHAR(255) DEFAULT 'smtp.mail.yahoo.com',
        smtpPort      INT DEFAULT 465,
        smtpSecure    TINYINT(1) DEFAULT 1,
        senderEmail   VARCHAR(255) NULL,
        senderPassword VARCHAR(500) NULL,
        senderName    VARCHAR(255) DEFAULT 'First Class Glass & Mirror, Inc.',
        replyTo       VARCHAR(255) NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await db.query('INSERT IGNORE INTO email_settings (id) VALUES (1)');

    await db.query(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        type        VARCHAR(50) NOT NULL,
        subject     VARCHAR(500) NOT NULL,
        body        TEXT NOT NULL,
        isDefault   TINYINT(1) DEFAULT 0,
        isActive    TINYINT(1) DEFAULT 1,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS email_log (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        templateId      INT NULL,
        estimateId      INT NULL,
        invoiceId       INT NULL,
        recipientEmail  VARCHAR(255) NOT NULL,
        recipientName   VARCHAR(255) NULL,
        subject         VARCHAR(500) NULL,
        body            TEXT NULL,
        attachmentPath  VARCHAR(255) NULL,
        status          VARCHAR(50) DEFAULT 'sent',
        errorMessage    TEXT NULL,
        sentAt          DATETIME DEFAULT CURRENT_TIMESTAMP,
        sentBy          VARCHAR(100) NULL
      )
    `);

    // Seed default email templates if none exist
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM email_templates');
    if (cnt === 0) {
      const seeds = [
        {
          name: 'Estimate - Standard',
          type: 'estimate',
          subject: 'Estimate from First Class Glass & Mirror, Inc.',
          body: `Dear {{customerName}},

Please find attached the estimate for the following project:

Project: {{projectName}}
Location: {{projectAddress}}
P.O. Reference: {{poNumber}}
Total: {{total}}

This estimate is valid for 30 days from the date of issue.

If you have any questions or would like to proceed, please don't hesitate to contact us.

Thank you for your business.

Best regards,
First Class Glass & Mirror, Inc.
1513 Industrial Drive, Itasca, IL 60143
Phone: 630-250-9777`,
          isDefault: 1
        },
        {
          name: 'Invoice - Standard',
          type: 'invoice',
          subject: 'Invoice #{{invoiceNumber}} from First Class Glass & Mirror, Inc.',
          body: `Dear {{customerName}},

Please find attached Invoice #{{invoiceNumber}} for services rendered.

Project: {{shipToName}}
Location: {{shipToAddress}}
P.O. Reference: {{poNumber}}
Amount Due: {{total}}
Due Date: {{dueDate}}

Payment Terms: {{terms}}

Please remit payment at your earliest convenience.

Thank you for your business.

Best regards,
First Class Glass & Mirror, Inc.
1513 Industrial Drive, Itasca, IL 60143
Phone: 630-250-9777`,
          isDefault: 1
        },
        {
          name: 'Payment Reminder - Friendly',
          type: 'payment_reminder',
          subject: 'Payment Reminder - Invoice #{{invoiceNumber}}',
          body: `Dear {{customerName}},

This is a friendly reminder that Invoice #{{invoiceNumber}} for {{total}} is currently outstanding.

Invoice Date: {{issueDate}}
Due Date: {{dueDate}}
Amount Due: {{balanceDue}}

If payment has already been sent, please disregard this notice.

Please let us know if you have any questions.

Thank you,
First Class Glass & Mirror, Inc.
Phone: 630-250-9777`,
          isDefault: 1
        },
        {
          name: 'Payment Reminder - Overdue',
          type: 'payment_reminder',
          subject: 'OVERDUE: Invoice #{{invoiceNumber}} - Payment Required',
          body: `Dear {{customerName}},

Our records indicate that Invoice #{{invoiceNumber}} is past due.

Invoice Date: {{issueDate}}
Due Date: {{dueDate}}
Days Overdue: {{daysOverdue}}
Amount Due: {{balanceDue}}

Per our payment terms, a 15% late fee may be applied to overdue balances.

Please arrange payment as soon as possible. If you have any questions or need to discuss payment arrangements, please contact us immediately.

Thank you,
First Class Glass & Mirror, Inc.
Phone: 630-250-9777`,
          isDefault: 0
        }
      ];

      for (const s of seeds) {
        await db.query(
          'INSERT INTO email_templates (name, type, subject, body, isDefault) VALUES (?, ?, ?, ?, ?)',
          [s.name, s.type, s.subject, s.body, s.isDefault]
        );
      }
      console.log('[Email] Seeded 4 default email templates');
    }
  } catch (e) {
    console.warn('[Email] Could not create email tables:', e.message);
  }
}
ensureEmailTables().catch(() => {});

// ─── PUBLIC TOKEN + PAYMENT TABLES ──────────────────────────────────────────
async function ensurePublicTokenTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public_tokens (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        token         VARCHAR(64) NOT NULL UNIQUE,
        type          ENUM('estimate_review','invoice_payment') NOT NULL,
        estimateId    INT NULL,
        invoiceId     INT NULL,
        recipientEmail VARCHAR(255) NULL,
        expiresAt     DATETIME NULL,
        usedAt        DATETIME NULL,
        response      VARCHAR(50) NULL,
        responseNotes TEXT NULL,
        respondedAt   DATETIME NULL,
        createdAt     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_token (token),
        INDEX idx_estimate (estimateId),
        INDEX idx_invoice (invoiceId)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        invoiceId             INT NOT NULL,
        amount                DECIMAL(10,2) NOT NULL,
        paymentMethod         VARCHAR(50) DEFAULT 'card',
        stripeSessionId       VARCHAR(255) NULL,
        stripePaymentIntentId VARCHAR(255) NULL,
        stripeChargeId        VARCHAR(255) NULL,
        status                VARCHAR(50) DEFAULT 'completed',
        customerEmail         VARCHAR(255) NULL,
        paidAt                DATETIME DEFAULT CURRENT_TIMESTAMP,
        notes                 TEXT NULL,
        createdAt             DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoice (invoiceId)
      )
    `);

    // Add Stripe columns to email_settings
    const cols = [
      { name: 'stripePublishableKey', def: 'VARCHAR(255) NULL' },
      { name: 'stripeSecretKey', def: 'VARCHAR(500) NULL' },
      { name: 'stripeWebhookSecret', def: 'VARCHAR(255) NULL' },
      { name: 'stripeEnabled', def: "TINYINT(1) DEFAULT 0" },
      { name: 'appPublicUrl', def: 'VARCHAR(500) NULL' },
    ];
    for (const col of cols) {
      try {
        const [[exists]] = await db.query(
          "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='email_settings' AND COLUMN_NAME=?",
          [col.name]
        );
        if (!exists.cnt) await db.query(`ALTER TABLE email_settings ADD COLUMN ${col.name} ${col.def}`);
      } catch (e) { /* column may already exist */ }
    }

    // Add publicToken/tokenExpiresAt to estimates
    const estCols = [
      { name: 'publicToken', def: 'VARCHAR(64) NULL' },
      { name: 'tokenExpiresAt', def: 'DATETIME NULL' },
    ];
    for (const col of estCols) {
      try {
        const [[exists]] = await db.query(
          "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='estimates' AND COLUMN_NAME=?",
          [col.name]
        );
        if (!exists.cnt) await db.query(`ALTER TABLE estimates ADD COLUMN ${col.name} ${col.def}`);
      } catch (e) { /* */ }
    }

    // Add publicToken/tokenExpiresAt/payment columns to invoices
    const invCols = [
      { name: 'publicToken', def: 'VARCHAR(64) NULL' },
      { name: 'tokenExpiresAt', def: 'DATETIME NULL' },
      { name: 'stripePaymentIntentId', def: 'VARCHAR(255) NULL' },
      { name: 'paidAt', def: 'DATETIME NULL' },
      { name: 'paidAmount', def: 'DECIMAL(10,2) NULL' },
      { name: 'paymentMethod', def: "VARCHAR(50) NULL" },
    ];
    for (const col of invCols) {
      try {
        const [[exists]] = await db.query(
          "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='invoices' AND COLUMN_NAME=?",
          [col.name]
        );
        if (!exists.cnt) await db.query(`ALTER TABLE invoices ADD COLUMN ${col.name} ${col.def}`);
      } catch (e) { /* */ }
    }

    console.log('[Migration] Public token + payment tables ensured');
  } catch (e) {
    console.warn('[Migration] Public token tables:', e.message);
  }
}
ensurePublicTokenTables().catch(() => {});

// ─── PUBLIC TOKEN HELPERS ───────────────────────────────────────────────────
function generatePublicToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getAppPublicUrl(req) {
  if (APP_PUBLIC_URL) return APP_PUBLIC_URL.replace(/\/$/, '');
  try {
    const [[settings]] = await db.query('SELECT appPublicUrl FROM email_settings WHERE id = 1');
    if (settings?.appPublicUrl) return settings.appPublicUrl.replace(/\/$/, '');
  } catch (e) { /* */ }
  // Fallback: derive from the incoming request
  if (req && req.get && req.get('host')) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${req.get('host')}`;
  }
  return '';
}

async function getStripeInstance() {
  let key = STRIPE_SECRET_KEY;
  if (!key) {
    try {
      const [[settings]] = await db.query('SELECT stripeSecretKey FROM email_settings WHERE id = 1');
      key = settings?.stripeSecretKey || '';
    } catch (e) { /* */ }
  }
  if (!key) throw new Error('Stripe is not configured. Go to Settings → Stripe Configuration.');
  return require('stripe')(key);
}

// ─── EMAIL UTILITIES ────────────────────────────────────────────────────────

function mergeEmailFields(template, data) {
  let result = template;
  const fmtMoney = v => '$' + (Number(v) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US') : '';
  const fields = {
    customerName: data.companyName || data.custName || '',
    projectName: data.projectName || '',
    projectAddress: [data.projectAddress, data.projectCity, data.projectState, data.projectZip].filter(Boolean).join(', '),
    poNumber: data.poNumber || '',
    total: fmtMoney(data.total),
    invoiceNumber: data.invoiceNumber || '',
    shipToName: data.shipToName || data.projectName || '',
    shipToAddress: [data.shipToAddress || data.projectAddress, data.shipToCity || data.projectCity, data.shipToState || data.projectState, data.shipToZip || data.projectZip].filter(Boolean).join(', '),
    issueDate: fmtDate(data.issueDate),
    dueDate: fmtDate(data.dueDate),
    balanceDue: fmtMoney(data.balanceDue ?? data.total),
    daysOverdue: data.daysOverdue || '0',
    terms: data.terms || '',
    companyName: 'First Class Glass & Mirror, Inc.',
    companyPhone: '630-250-9777',
    estimateLink: data.estimateLink || '',
    paymentLink: data.paymentLink || '',
  };
  for (const [key, value] of Object.entries(fields)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

async function createEmailTransport() {
  const [[settings]] = await db.query('SELECT * FROM email_settings WHERE id = 1');
  if (!settings || !settings.senderEmail || !settings.senderPassword) {
    throw new Error('Email settings not configured. Go to Settings to configure Yahoo Mail.');
  }
  return { transport: nodemailer.createTransport({
    host: settings.smtpHost || 'smtp.mail.yahoo.com',
    port: settings.smtpPort || 465,
    secure: settings.smtpSecure !== 0,
    auth: { user: settings.senderEmail, pass: settings.senderPassword },
  }), settings };
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

// Separate uploader for temporary extraction (always uses disk, not S3)
const extractUploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, require('os').tmpdir()),
    filename: (req, file, cb) => cb(null, `extract-${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'), false);
    }
  }
});

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

// ─── TEST PDF EXTRACTION WITH OCR (debug endpoint) ─────────────────────────
app.get('/test-pdf-extract', authenticate, async (req, res) => {
  try {
    const testKey = req.query.key; // e.g., ?key=uploads/PO_123.pdf
    if (!testKey) {
      // List available PDFs in uploads folder
      const uploadsDir = path.resolve(__dirname, 'uploads');
      let files = [];
      if (fs.existsSync(uploadsDir)) {
        files = fs.readdirSync(uploadsDir).filter(f => f.toLowerCase().endsWith('.pdf')).slice(0, 20);
      }
      return res.json({
        message: 'Pass ?key=uploads/filename.pdf to test extraction (includes OCR for scanned PDFs)',
        availablePdfs: files.map(f => `uploads/${f}`),
        s3Mode: !!S3_BUCKET,
        note: 'OCR may take 5-15 seconds for scanned documents'
      });
    }

    let pdfFilePath;
    let shouldCleanup = false;

    if (S3_BUCKET) {
      const tmpPath = path.join(require('os').tmpdir(), `test-${Date.now()}.pdf`);
      const s3Obj = await s3.getObject({ Bucket: S3_BUCKET, Key: testKey }).promise();
      fs.writeFileSync(tmpPath, s3Obj.Body);
      pdfFilePath = tmpPath;
      shouldCleanup = true;
    } else {
      const uploadsDir = path.resolve(__dirname, 'uploads');
      const filename = testKey.replace(/^uploads\//i, '');
      pdfFilePath = path.resolve(uploadsDir, filename);
    }

    if (!fs.existsSync(pdfFilePath)) {
      return res.status(404).json({ error: 'File not found', path: pdfFilePath });
    }

    // Use smart analysis with OCR fallback
    const startTime = Date.now();
    const analysis = await analyzePoPdf(pdfFilePath);
    const elapsed = Date.now() - startTime;

    // Cleanup temp file for S3
    if (shouldCleanup && fs.existsSync(pdfFilePath)) {
      try { fs.unlinkSync(pdfFilePath); } catch {}
    }

    res.json({
      key: testKey,
      processingTimeMs: elapsed,
      textLength: analysis.textLength,
      textPreview: analysis.text ? analysis.text.substring(0, 1000) : '(empty)',
      detectedSupplier: analysis.supplier || '(none)',
      detectedPoNumber: analysis.poNumber || '(none)',
      fullText: analysis.text // Include full text for debugging
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

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

// GET /customers — list all customers (active by default)
app.get('/customers', authenticate, async (req, res) => {
  try {
    const { search, includeInactive } = req.query;
    let where = '(c.isActive = 1 OR c.isActive IS NULL)';
    const params = [];

    if (includeInactive === 'true') where = '1=1';

    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      where += ` AND (c.companyName LIKE ? OR c.name LIKE ? OR c.contactName LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)`;
      params.push(term, term, term, term, term);
    }

    const sql = `
      SELECT c.*,
             COALESCE(wc.cnt, 0) AS woCount
        FROM customers c
        LEFT JOIN (
          SELECT customerId, COUNT(*) AS cnt FROM work_orders WHERE customerId IS NOT NULL GROUP BY customerId
        ) wc ON wc.customerId = c.id
       WHERE ${where}
       ORDER BY COALESCE(c.companyName, c.name) ASC
    `;
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Customers list error:', err);
    res.status(500).json({ error: 'Failed to fetch customers.' });
  }
});

// GET /customers/duplicates — find potential duplicate customers (must be before :id route)
app.get('/customers/duplicates', authenticate, async (req, res) => {
  try {
    const [all] = await db.execute('SELECT id, name, companyName, contactName, phone, email, billingAddress FROM customers WHERE isActive = 1 OR isActive IS NULL ORDER BY companyName');

    const pairs = [];
    const seen = new Set();

    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      const normA = normalizeCustomerName(a.companyName || a.name);
      if (!normA) continue;

      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        const normB = normalizeCustomerName(b.companyName || b.name);
        if (!normB) continue;

        const pairKey = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
        if (seen.has(pairKey)) continue;

        let isDupe = false;
        if (normA === normB) {
          isDupe = true;
        } else if (normA.length >= 3 && normB.length >= 3) {
          if (normA.includes(normB) || normB.includes(normA)) {
            isDupe = true;
          }
        }

        if (isDupe) {
          seen.add(pairKey);
          pairs.push({ a, b });
        }
      }
    }

    res.json(pairs);
  } catch (err) {
    console.error('Duplicates scan error:', err);
    res.status(500).json({ error: 'Failed to scan for duplicates.' });
  }
});

// GET /customers/:id — single customer with work order count
app.get('/customers/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.execute('SELECT * FROM customers WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });

    const cust = rows[0];
    // Count WOs linked by customerId OR by name match
    const [countRows] = await db.execute(
      `SELECT COUNT(*) AS cnt FROM work_orders WHERE customerId = ? OR customer = ? OR customer = ?`,
      [id, cust.companyName || '', cust.name || '']
    );
    cust.woCount = countRows[0]?.cnt || 0;

    res.json(cust);
  } catch (err) {
    console.error('Customer get error:', err);
    res.status(500).json({ error: 'Failed to fetch customer.' });
  }
});

// POST /customers — create new customer
app.post('/customers', authenticate, async (req, res) => {
  const body = coerceBody(req);
  const companyName = body.companyName || body.name;
  if (!companyName) return res.status(400).json({ error: 'companyName is required' });

  try {
    const cols = ['name', 'companyName', 'billingAddress'];
    const vals = [companyName, companyName, body.billingAddress || null];

    const optFields = ['contactName','email','phone','fax','billingCity','billingState','billingZip',
                       'siteAddress','siteCity','siteState','siteZip','notes'];
    for (const f of optFields) {
      if (body[f] !== undefined && body[f] !== null) {
        cols.push(f);
        vals.push(body[f]);
      }
    }

    const placeholders = cols.map(() => '?').join(',');
    const [r] = await db.execute(
      `INSERT INTO customers (${cols.join(',')}) VALUES (${placeholders})`,
      vals
    );

    const [[newCust]] = await db.execute('SELECT * FROM customers WHERE id = ?', [r.insertId]);
    res.status(201).json(newCust);
  } catch (err) {
    console.error('Customer create error:', err);
    res.status(500).json({ error: 'Failed to create customer.' });
  }
});

// --- Helper: normalize customer name for fuzzy comparison ---
function normalizeCustomerName(str) {
  return (str || '').toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'"]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co|company|incorporated|limited|the)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Helper: find existing customer by name (case-insensitive + fuzzy) or create one ---
async function findOrCreateCustomer(customerName, billingInfo = {}) {
  const trimmed = (customerName || '').trim();
  if (!trimmed) throw new Error('customerName is required');

  // 1. Exact match (case-insensitive)
  const [exact] = await db.execute(
    'SELECT * FROM customers WHERE LOWER(name) = LOWER(?) OR LOWER(companyName) = LOWER(?) LIMIT 1',
    [trimmed, trimmed]
  );
  if (exact.length) return exact[0];

  // 2. Fuzzy match — check if name contains or is contained by existing customer
  const [fuzzy] = await db.execute(
    'SELECT * FROM customers WHERE LOWER(companyName) LIKE LOWER(?) OR LOWER(?) LIKE CONCAT("%", LOWER(companyName), "%") LIMIT 10',
    [`%${trimmed}%`, trimmed]
  );

  if (fuzzy.length > 0) {
    const normalizedInput = normalizeCustomerName(trimmed);
    for (const match of fuzzy) {
      const normalizedMatch = normalizeCustomerName(match.companyName || match.name);
      if (normalizedInput === normalizedMatch) {
        console.log(`[findOrCreateCustomer] Fuzzy matched "${trimmed}" to existing customer #${match.id} "${match.companyName}"`);
        return match;
      }
    }
  }

  // 3. No match found — create new customer
  console.log(`[findOrCreateCustomer] No match for "${trimmed}", creating new customer`);
  const cols = ['name', 'companyName'];
  const vals = [trimmed, trimmed];
  for (const [col, val] of Object.entries(billingInfo)) {
    if (val != null && String(val).trim()) {
      cols.push(col);
      vals.push(String(val).trim());
    }
  }

  try {
    const [r] = await db.execute(
      `INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals
    );
    const [[newCust]] = await db.execute('SELECT * FROM customers WHERE id = ?', [r.insertId]);
    return newCust;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const [retry] = await db.execute('SELECT * FROM customers WHERE LOWER(name) = LOWER(?) LIMIT 1', [trimmed]);
      if (retry.length) return retry[0];
    }
    throw err;
  }
}

// PUT /customers/:id — update customer
app.put('/customers/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[existing]] = await db.execute('SELECT id FROM customers WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });

    const body = coerceBody(req);
    const allowed = ['companyName','contactName','email','phone','fax',
                     'billingAddress','billingCity','billingState','billingZip',
                     'siteAddress','siteCity','siteState','siteZip','notes','isActive'];
    const sets = [];
    const vals = [];

    for (const f of allowed) {
      if (body[f] !== undefined) {
        sets.push(`\`${f}\` = ?`);
        vals.push(body[f]);
      }
    }

    // Keep name in sync with companyName
    if (body.companyName) {
      sets.push('`name` = ?');
      vals.push(body.companyName);
    }

    sets.push('`updatedAt` = NOW()');

    if (sets.length <= 1) return res.status(400).json({ error: 'No fields to update.' });

    vals.push(id);
    await db.execute(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, vals);

    const [[updated]] = await db.execute('SELECT * FROM customers WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error('Customer update error:', err);
    res.status(500).json({ error: 'Failed to update customer.' });
  }
});

// DELETE /customers/:id — soft delete
app.delete('/customers/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.execute('UPDATE customers SET isActive = 0, updatedAt = NOW() WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Customer delete error:', err);
    res.status(500).json({ error: 'Failed to deactivate customer.' });
  }
});

// GET /customers/:id/work-orders — work orders for a customer
app.get('/customers/:id/work-orders', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[cust]] = await db.execute('SELECT companyName, name FROM customers WHERE id = ?', [id]);
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const [rows] = await db.execute(
      workOrdersSelectSQL({
        whereSql: 'WHERE w.customerId = ? OR w.customer = ? OR w.customer = ?',
        orderSql: 'ORDER BY w.id DESC',
      }),
      [id, cust.companyName || '', cust.name || '']
    );
    const formatted = rows.map(r => ({
      ...r,
      status: displayStatusOrDefault(r.status),
      allPoNumbersFormatted: formatPoNumberList(r.allPoNumbers),
    }));
    res.json(formatted);
  } catch (err) {
    console.error('Customer work-orders error:', err);
    res.status(500).json({ error: 'Failed to fetch work orders for customer.' });
  }
});

// POST /customers/:targetId/merge — merge source customer into target
app.post('/customers/:targetId/merge', authenticate, requireNumericParam('targetId'), async (req, res) => {
  try {
    const targetId = Number(req.params.targetId);
    const body = coerceBody(req);
    const sourceId = Number(body.sourceId);
    if (!sourceId || sourceId === targetId) {
      return res.status(400).json({ error: 'Valid sourceId is required and must differ from targetId.' });
    }

    const [[target]] = await db.execute('SELECT * FROM customers WHERE id = ?', [targetId]);
    const [[source]] = await db.execute('SELECT * FROM customers WHERE id = ?', [sourceId]);
    if (!target) return res.status(404).json({ error: 'Target customer not found.' });
    if (!source) return res.status(404).json({ error: 'Source customer not found.' });

    // Update all foreign keys from source to target
    const [woResult] = await db.execute('UPDATE work_orders SET customerId = ? WHERE customerId = ?', [targetId, sourceId]);
    const [estResult] = await db.execute('UPDATE estimates SET customerId = ? WHERE customerId = ?', [targetId, sourceId]);
    const [invResult] = await db.execute('UPDATE invoices SET customerId = ? WHERE customerId = ?', [targetId, sourceId]);

    // Also update legacy string-based customer field on work orders
    if (source.companyName || source.name) {
      const srcName = source.companyName || source.name;
      const tgtName = target.companyName || target.name;
      await db.execute('UPDATE work_orders SET customer = ? WHERE customer = ?', [tgtName, srcName]);
    }

    // Smart merge: fill in target's empty fields with source's data
    const isEmpty = (v) => !v || !String(v).trim() || String(v).trim() === '—' || String(v).trim() === '-';
    const copyFields = ['contactName', 'phone', 'email', 'fax', 'billingAddress', 'billingCity', 'billingState', 'billingZip', 'siteAddress', 'siteCity', 'siteState', 'siteZip'];
    const sets = [];
    const vals = [];
    const fieldsFilled = [];
    for (const f of copyFields) {
      if (isEmpty(target[f]) && !isEmpty(source[f])) {
        sets.push(`\`${f}\` = ?`);
        vals.push(source[f]);
        fieldsFilled.push(f);
      }
    }
    // Append source notes to target if source has notes
    if (!isEmpty(source.notes)) {
      const combined = [target.notes, `[Merged from ${source.companyName || source.name}]: ${source.notes}`].filter(Boolean).join('\n');
      sets.push('`notes` = ?');
      vals.push(combined);
    }
    if (sets.length > 0) {
      sets.push('`updatedAt` = NOW()');
      vals.push(targetId);
      await db.execute(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
    if (fieldsFilled.length > 0) {
      console.log(`[Merge] Filled empty fields on target: ${fieldsFilled.join(', ')}`);
    }

    // Delete the source customer
    await db.execute('DELETE FROM customers WHERE id = ?', [sourceId]);

    const woCount = woResult.affectedRows || 0;
    const estCount = estResult.affectedRows || 0;
    const invCount = invResult.affectedRows || 0;
    console.log(`[Merge] Merged customer #${sourceId} "${source.companyName}" into #${targetId} "${target.companyName}", updated ${woCount} work orders, ${estCount} estimates, ${invCount} invoices`);

    res.json({
      success: true,
      merged: { sourceId, targetId },
      updated: { workOrders: woCount, estimates: estCount, invoices: invCount },
    });
  } catch (err) {
    console.error('Customer merge error:', err);
    res.status(500).json({ error: 'Failed to merge customers.' });
  }
});

// GET /customers/:id/merge-preview — preview what a merge would affect
app.get('/customers/:id/merge-preview', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[customer]] = await db.execute('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const [[woCount]] = await db.execute('SELECT COUNT(*) as cnt FROM work_orders WHERE customerId = ?', [id]);
    const [[estCount]] = await db.execute('SELECT COUNT(*) as cnt FROM estimates WHERE customerId = ?', [id]);
    const [[invCount]] = await db.execute('SELECT COUNT(*) as cnt FROM invoices WHERE customerId = ?', [id]);
    res.json({
      customer,
      workOrders: woCount?.cnt || 0,
      estimates: estCount?.cnt || 0,
      invoices: invCount?.cnt || 0,
    });
  } catch (err) {
    console.error('Merge preview error:', err);
    res.status(500).json({ error: 'Failed to get merge preview.' });
  }
});

// ─── ESTIMATES ──────────────────────────────────────────────────────────────

const DEFAULT_TERMS = 'ALL PAYMENTS MUST BE MADE 45 DAYS AFTER INVOICE DATE OR A 15% LATE FEE WILL BE APPLIED';

// Upload a local file to S3 if S3_BUCKET is configured (used for generated PDFs)
async function uploadToS3IfConfigured(localFilePath, s3Key) {
  if (!S3_BUCKET) return;
  try {
    const fileBuffer = fs.readFileSync(localFilePath);
    await s3.putObject({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: 'application/pdf',
    }).promise();
    console.log(`Uploaded PDF to S3: ${s3Key}`);
  } catch (err) {
    console.error(`Failed to upload PDF to S3 (${s3Key}):`, err.message);
  }
}

async function recalcEstimateTotals(estimateId) {
  const [[{ s }]] = await db.query(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM estimate_line_items WHERE estimateId = ?',
    [estimateId]
  );
  const subtotal = Number(s) || 0;
  const [[est]] = await db.query('SELECT taxRate FROM estimates WHERE id = ?', [estimateId]);
  const taxRate = Number(est?.taxRate) || 0;
  const taxAmount = Math.round(subtotal * taxRate) / 100;
  const total = subtotal + taxAmount;
  await db.query(
    'UPDATE estimates SET subtotal=?, taxAmount=?, total=?, updatedAt=NOW() WHERE id=?',
    [subtotal, taxAmount, total, estimateId]
  );
}

// Format amount to $X,XXX.XX
function fmtMoney(val) {
  const n = Number(val) || 0;
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// --- Shared PDF generation with template config ---
async function loadTemplateConfig(templateId, docType) {
  let tplConfig = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE_CONFIG));
  console.log('[PDF Gen] loadTemplateConfig called — templateId:', templateId, 'docType:', docType);
  try {
    if (templateId) {
      const [[tpl]] = await db.query('SELECT id, config FROM pdf_templates WHERE id = ? AND isActive = 1', [templateId]);
      console.log('[PDF Gen] Looked up template id=' + templateId + ' — found:', tpl ? 'YES (config length=' + (tpl.config || '').length + ')' : 'NO');
      if (tpl && tpl.config) {
        const parsed = JSON.parse(tpl.config);
        console.log('[PDF Gen] Parsed template config keys:', Object.keys(parsed));
        console.log('[PDF Gen] Template companyInfo.name:', parsed.companyInfo?.name || '(not set)');
        console.log('[PDF Gen] Template lineItems.displayMode:', parsed.lineItems?.displayMode || '(not set)');
        tplConfig = deepMerge(DEFAULT_TEMPLATE_CONFIG, parsed);
      }
    } else {
      const [[defTpl]] = await db.query(
        "SELECT id, config FROM pdf_templates WHERE isDefault = 1 AND isActive = 1 AND type IN (?, 'both') ORDER BY CASE WHEN type = ? THEN 0 ELSE 1 END LIMIT 1",
        [docType, docType]
      );
      console.log('[PDF Gen] Looked up default template — found:', defTpl ? 'YES (id=' + defTpl.id + ', config length=' + (defTpl.config || '').length + ')' : 'NO');
      if (defTpl && defTpl.config) {
        const parsed = JSON.parse(defTpl.config);
        console.log('[PDF Gen] Default template companyInfo.name:', parsed.companyInfo?.name || '(not set)');
        tplConfig = deepMerge(DEFAULT_TEMPLATE_CONFIG, parsed);
      }
    }
  } catch (e) {
    console.warn('[PDF Gen] Error loading template config, using defaults:', e.message, e.stack);
  }
  console.log('[PDF Gen] Final config companyInfo.name:', tplConfig.companyInfo?.name);
  console.log('[PDF Gen] Final config lineItems.displayMode:', tplConfig.lineItems?.displayMode);
  return tplConfig;
}

/* ════════════════════════════════════════════════════════════════
   ZONE-BASED PDF RENDERER
   Used by the rebuilt PdfTemplateBuilder. Templates store an array of
   elements per named zone. We render zones top-to-bottom, applying the
   selected font theme and color scheme. Live data values are
   substituted in for `data` elements.
   ════════════════════════════════════════════════════════════════ */

const ZONE_FONT_THEMES = {
  modern:  { body: 'Helvetica',  bold: 'Helvetica-Bold' },
  classic: { body: 'Times-Roman', bold: 'Times-Bold' },
  clean:   { body: 'Helvetica',  bold: 'Helvetica-Bold' },
};

const ZONE_COLOR_SCHEMES = {
  default: { primary: '#000000', tableHeader: '#e5e7eb', titleColor: '#000000' },
  blue:    { primary: '#1a56db', tableHeader: '#e8f0fe', titleColor: '#1a56db' },
  green:   { primary: '#166534', tableHeader: '#dcfce7', titleColor: '#166534' },
  gray:    { primary: '#374151', tableHeader: '#f3f4f6', titleColor: '#374151' },
  navy:    { primary: '#1e3a5f', tableHeader: '#dbeafe', titleColor: '#1e3a5f' },
  custom:  { primary: '#000000', tableHeader: '#e5e7eb', titleColor: '#000000' },
};

function generateZonePdf(data, lineItems, cfg, docType) {
  return new Promise((resolve, reject) => {
    try {
      const PAGE_W = 612;
      const PAGE_H = 792;
      const MARGIN_X = 50;
      const MARGIN_TOP = 40;
      const MARGIN_BOTTOM = 40;
      const COL_GAP = 20;
      const CONTENT_W = PAGE_W - MARGIN_X * 2;
      const COL_W = (CONTENT_W - COL_GAP) / 2;

      const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const theme = ZONE_FONT_THEMES[cfg.fontTheme] || ZONE_FONT_THEMES.modern;
      const baseScheme = ZONE_COLOR_SCHEMES[cfg.colorScheme] || ZONE_COLOR_SCHEMES.default;
      const scheme = cfg.colorScheme === 'custom' && cfg.customColors
        ? { ...baseScheme, primary: cfg.customColors.primary || baseScheme.primary, titleColor: cfg.customColors.primary || baseScheme.titleColor }
        : baseScheme;

      const zones = cfg.zones || {};
      const isInvoice = docType === 'invoice';

      // ───── data lookup ─────
      const fmtMoneyZ = (v) => '$' + (Number(v) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const fmtDate = (d) => {
        if (!d) return new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
        return new Date(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
      };

      const billToBlock = () => {
        const out = [];
        const name = (data.companyName || data.custName || '').toUpperCase();
        if (name) out.push(name);
        const addr = (data.effectiveBillingAddress || data.billingAddress || '').trim();
        if (addr) out.push(addr.toUpperCase());
        const csz = [data.effectiveBillingCity || data.billingCity, data.effectiveBillingState || data.billingState].filter(Boolean).join(', ');
        const zip = data.effectiveBillingZip || data.billingZip;
        const cszLine = (csz + (zip ? ' ' + zip : '')).trim();
        if (cszLine) out.push(cszLine.toUpperCase());
        if (data.custPhone) out.push(data.custPhone);
        return out.join('\n');
      };

      const shipToBlock = () => {
        const out = [];
        if (isInvoice) {
          if (data.projectName) out.push(String(data.projectName).toUpperCase());
          if (data.shipToAddress) out.push(String(data.shipToAddress).toUpperCase());
          const csz = [data.shipToCity, data.shipToState].filter(Boolean).join(' ');
          if (csz || data.shipToZip) out.push(((csz || '') + (data.shipToZip ? ' ' + data.shipToZip : '')).toUpperCase());
        } else {
          if (data.projectName) out.push(String(data.projectName).toUpperCase());
          if (data.projectAddress) out.push(String(data.projectAddress).toUpperCase());
          const csz = [data.projectCity, data.projectState].filter(Boolean).join(' ');
          if (csz || data.projectZip) out.push(((csz || '') + (data.projectZip ? ' ' + data.projectZip : '')).toUpperCase());
        }
        return out.join('\n');
      };

      const dataValue = (key) => {
        switch (key) {
          case 'companyName':    return 'First Class Glass & Mirror, Inc.';
          case 'companyAddress': return '1513 Industrial Drive\nItasca, IL 60143';
          case 'companyPhoneFax':return 'Phone: 630-250-9777\nFax: 630-250-9727';
          case 'companyEmail':   return 'office@firstclassglass.com';
          case 'documentTitle':  return isInvoice ? 'INVOICE' : 'ESTIMATE';
          case 'documentNumber': return String(isInvoice ? (data.invoiceNumber || '') : (data.id || data.estimateNumber || ''));
          case 'date':           return fmtDate(data.issueDate);
          case 'dueDate':        return fmtDate(data.expirationDate || data.dueDate);
          case 'poNumber':       return String(data.poNumber || '');
          case 'billToBlock':    return billToBlock();
          case 'shipToBlock':    return shipToBlock();
          case 'paymentTerms':   return String(data.terms || '');
          case 'notes':          return String(data.notes || '');
          default: return '';
        }
      };

      const totals = {
        subtotal: Number(data.subtotal || data.total || 0),
        tax:      Number(data.taxAmount || 0),
        total:    Number(data.total || 0),
        balance:  Number(data.balance ?? data.total ?? 0),
      };

      // ───── element renderer ─────
      // Returns the height (in pt) consumed by this element.
      const renderElement = (el, x, y, w) => {
        const padTop = el.paddingTop ?? 4;
        const padBot = el.paddingBottom ?? 4;
        const fontSize = el.fontSize || 10;
        const fontName = el.bold ? theme.bold : theme.body;
        const align = el.align || 'left';
        const color = el.color || '#000000';

        let drawn = 0;

        if (el.type === 'text') {
          doc.font(fontName).fontSize(fontSize).fillColor(color);
          const txt = el.text || '';
          const h = doc.heightOfString(txt, { width: w, align });
          doc.text(txt, x, y + padTop, { width: w, align });
          drawn = h;
        } else if (el.type === 'data') {
          let val = dataValue(el.dataKey);
          if (el.dataKey === 'documentTitle') {
            doc.font(theme.bold).fontSize(Math.max(fontSize, 18)).fillColor(scheme.titleColor);
            const h = doc.heightOfString(val, { width: w, align });
            doc.text(val, x, y + padTop, { width: w, align });
            drawn = h;
          } else {
            let labelH = 0;
            if (el.showLabel && el.label) {
              doc.font(theme.bold).fontSize(Math.max(7, fontSize - 2)).fillColor(scheme.primary);
              const lh = doc.heightOfString(String(el.label).toUpperCase(), { width: w, align });
              doc.text(String(el.label).toUpperCase(), x, y + padTop, { width: w, align });
              labelH = lh + 1;
            }
            doc.font(fontName).fontSize(fontSize).fillColor(color);
            const h = doc.heightOfString(val, { width: w, align });
            doc.text(val, x, y + padTop + labelH, { width: w, align });
            drawn = labelH + h;
          }
        } else if (el.type === 'logo' || el.type === 'image') {
          const logoPath = path.resolve(__dirname, 'assets', 'logo.png');
          if (fs.existsSync(logoPath)) {
            const iw = el.width || 90;
            const ih = el.height || 90;
            let ix = x;
            if (align === 'center') ix = x + (w - iw) / 2;
            if (align === 'right')  ix = x + (w - iw);
            try { doc.image(logoPath, ix, y + padTop, { width: iw, height: ih }); } catch (e) {}
            drawn = ih;
          }
        } else if (el.type === 'divider') {
          const yy = y + padTop + 1;
          doc.lineWidth(el.thickness || 1).strokeColor(el.color || '#000000');
          doc.moveTo(x, yy).lineTo(x + w, yy).stroke();
          doc.strokeColor('#000000').lineWidth(0.75);
          drawn = (el.thickness || 1) + 2;
        } else if (el.type === 'colorBar') {
          const t = el.thickness || 8;
          doc.save();
          doc.rect(x, y + padTop, w, t).fill(el.color || scheme.primary);
          doc.restore();
          drawn = t;
        } else if (el.type === 'borderBox') {
          const h = el.height || 60;
          doc.lineWidth(el.borderWidth || 1).strokeColor(el.borderColor || '#000000');
          doc.rect(x, y + padTop, w, h).stroke();
          doc.strokeColor('#000000').lineWidth(0.75);
          drawn = h;
        } else if (el.type === 'spacer') {
          drawn = el.height || 12;
        } else if (el.type === 'signature') {
          const lineY = y + padTop + 18;
          doc.lineWidth(0.75).strokeColor('#000000');
          doc.moveTo(x, lineY).lineTo(x + Math.min(w, 240), lineY).stroke();
          doc.font(theme.body).fontSize(fontSize || 9).fillColor('#000000');
          doc.text(el.signatureLabel || 'Authorized Signature', x, lineY + 4, { width: w });
          drawn = 30;
        } else if (el.type === 'totals') {
          const lines = [];
          if (el.totalsKind === 'subtotal' || el.totalsKind === 'block') lines.push(['Subtotal', totals.subtotal]);
          if (el.totalsKind === 'tax'      || el.totalsKind === 'block') lines.push(['Tax',      totals.tax]);
          if (el.totalsKind === 'total'    || el.totalsKind === 'block') lines.push(['Total',    totals.total]);
          if (el.totalsKind === 'balance') lines.push(['Balance Due', totals.balance]);
          doc.font(fontName).fontSize(fontSize).fillColor(color);
          let yy = y + padTop;
          for (const [k, v] of lines) {
            doc.text(k, x, yy, { width: w / 2 });
            doc.text(fmtMoneyZ(v), x + w / 2, yy, { width: w / 2, align: 'right' });
            yy += fontSize + 4;
          }
          drawn = yy - (y + padTop);
        } else if (el.type === 'table') {
          const cols = el.columns || { qty: true, description: true, amount: true };
          const labels = el.columnLabels || {};
          const colList = [];
          if (cols.qty)         colList.push({ key: 'qty',         label: labels.qty || 'QTY',                 width: 50,  align: 'center' });
          if (cols.description) colList.push({ key: 'description', label: labels.description || 'DESCRIPTION', width: null, align: 'left' });
          if (cols.unitPrice)   colList.push({ key: 'unitPrice',   label: labels.unitPrice || 'UNIT PRICE',    width: 75,  align: 'right' });
          if (cols.amount)      colList.push({ key: 'amount',      label: labels.amount || 'AMOUNT',           width: 75,  align: 'right' });

          const fixedW = colList.reduce((s, c) => s + (c.width || 0), 0);
          const flexCols = colList.filter((c) => c.width == null);
          const flexW = Math.max(80, w - fixedW);
          flexCols.forEach((c) => { c.width = flexW / flexCols.length; });

          const headerH = 18;
          const headerBg = el.headerBgColor || scheme.tableHeader;
          let cx = x;
          doc.save();
          doc.rect(x, y + padTop, w, headerH).fill(headerBg);
          doc.restore();
          if (el.showBorders !== false) {
            doc.lineWidth(0.75).strokeColor('#000000');
            doc.rect(x, y + padTop, w, headerH).stroke();
          }
          doc.font(theme.bold).fontSize(8).fillColor('#000000');
          for (const c of colList) {
            doc.text(c.label, cx + 4, y + padTop + 5, { width: c.width - 8, align: c.align });
            cx += c.width;
          }

          let ry = y + padTop + headerH;
          doc.font(theme.body).fontSize(9).fillColor(color);
          (lineItems || []).forEach((row, i) => {
            const desc = String(row.description || '').toUpperCase();
            const descCol = colList.find((c) => c.key === 'description');
            const descW = descCol ? descCol.width - 8 : w - 8;
            const rowH = Math.max(16, doc.heightOfString(desc, { width: descW }) + 6);
            if (el.altRowColor && i % 2 === 1) {
              doc.save();
              doc.rect(x, ry, w, rowH).fill('#f9fafb');
              doc.restore();
            }
            if (el.showBorders !== false) {
              doc.lineWidth(0.5).strokeColor('#e5e7eb');
              doc.rect(x, ry, w, rowH).stroke();
            }
            let ccx = x;
            doc.fillColor(color).font(theme.body).fontSize(9);
            for (const c of colList) {
              let val = '';
              if (c.key === 'qty')         val = row.qty != null ? String(row.qty) : (row.quantity != null ? String(row.quantity) : '');
              else if (c.key === 'description') val = desc;
              else if (c.key === 'unitPrice')   val = row.unitPrice != null ? fmtMoneyZ(row.unitPrice) : '';
              else if (c.key === 'amount')      val = fmtMoneyZ(row.amount || 0);
              doc.text(val, ccx + 4, ry + 3, { width: c.width - 8, align: c.align });
              ccx += c.width;
            }
            ry += rowH;
          });
          drawn = ry - (y + padTop);
        }

        doc.fillColor('#000000');
        return padTop + drawn + padBot;
      };

      // ───── render zone(s) at given x/y/width — return new y ─────
      const renderZone = (zoneId, x, y, w) => {
        const list = zones[zoneId] || [];
        let yy = y;
        for (const el of list) {
          const h = renderElement(el, x, yy, w);
          yy += h;
        }
        return yy;
      };

      // ───── lay out the document top to bottom ─────
      let y = MARGIN_TOP;

      // Header row — left/right columns share the same starting y, advance to max
      const leftEnd  = renderZone('header-left',  MARGIN_X,                          y, COL_W);
      const rightEnd = renderZone('header-right', MARGIN_X + COL_W + COL_GAP,        y, COL_W);
      y = Math.max(leftEnd, rightEnd) + 12;

      // Bill-to / ship-to row
      const billEnd = renderZone('bill-to', MARGIN_X,                       y, COL_W);
      const shipEnd = renderZone('ship-to', MARGIN_X + COL_W + COL_GAP,     y, COL_W);
      y = Math.max(billEnd, shipEnd) + 12;

      // Line items — full width
      y = renderZone('line-items', MARGIN_X, y, CONTENT_W) + 8;

      // Totals — right-aligned column
      const TOTAL_W = 240;
      y = renderZone('totals', MARGIN_X + CONTENT_W - TOTAL_W, y, TOTAL_W) + 8;

      // Footer — full width
      renderZone('footer', MARGIN_X, y, CONTENT_W);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generatePdfWithConfig(data, lineItems, cfg, docType) {
  // ─── New zone-based templates (QuickBooks-style designer) ───
  // Templates created in the rebuilt PdfTemplateBuilder are saved with
  // `layoutMode: "zones"`. They are rendered by a separate top-to-bottom
  // zone renderer. Legacy free-form templates fall through to the
  // original absolute-coordinate code path below.
  if (cfg && cfg.layoutMode === 'zones' && cfg.zones) {
    return generateZonePdf(data, lineItems, cfg, docType);
  }

  // ============ TEMPORARY DEBUG LOGGING ============
  console.log('============ PDF GENERATION DEBUG START ============');
  console.log('FULL CONFIG:', JSON.stringify(cfg, null, 2));
  console.log('CONFIG KEYS:', Object.keys(cfg));
  console.log('COMPANY INFO:', JSON.stringify({
    readingFrom: cfg.companyInfo ? 'cfg.companyInfo' : cfg.companyHeader ? 'cfg.companyHeader' : 'NEITHER',
    name: cfg.companyInfo?.name || cfg.companyHeader?.companyName || 'FALLBACK',
    x: cfg.companyInfo?.x ?? cfg.companyHeader?.x ?? 'NOT SET',
    y: cfg.companyInfo?.y ?? cfg.companyHeader?.y ?? 'NOT SET',
    width: cfg.companyInfo?.width ?? cfg.companyHeader?.width ?? 'NOT SET',
    height: cfg.companyInfo?.height ?? cfg.companyHeader?.height ?? 'NOT SET',
  }));
  console.log('LOGO:', JSON.stringify({
    x: cfg.logo?.x ?? 'NOT SET', y: cfg.logo?.y ?? 'NOT SET',
    width: cfg.logo?.width ?? 'NOT SET', height: cfg.logo?.height ?? 'NOT SET',
  }));
  console.log('TITLE:', JSON.stringify({
    fromTitle: { x: cfg.title?.x, y: cfg.title?.y, width: cfg.title?.width, fontSize: cfg.title?.fontSize, align: cfg.title?.align },
    fromDocTitle: { x: cfg.documentTitle?.x, y: cfg.documentTitle?.y, fontSize: cfg.documentTitle?.fontSize },
  }));
  console.log('DATE BOX:', JSON.stringify(cfg.dateBox));
  console.log('BILL TO:', JSON.stringify(cfg.billTo));
  console.log('PROJECT BOX:', JSON.stringify(cfg.projectBox));
  console.log('PO NUMBER:', JSON.stringify(cfg.poNumber));
  console.log('LINE ITEMS:', JSON.stringify(cfg.lineItems));
  console.log('FOOTER:', JSON.stringify(cfg.footer));
  console.log('============ PDF GENERATION DEBUG END ============');
  // ============ END DEBUG LOGGING ============

  const logoPath = path.resolve(__dirname, 'assets', 'logo.png');
  const hasLogo = fs.existsSync(logoPath);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: cfg.pageSize || 'LETTER',
      margins: {
        top: cfg.margins?.top ?? 40,
        bottom: cfg.margins?.bottom ?? 40,
        left: cfg.margins?.left ?? 50,
        right: cfg.margins?.right ?? 50
      }
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const U = s => (s || '').toUpperCase();
    const fmtMoney = v => '$' + (Number(v) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    // Template builder canvas is 612×792 (same as PDF Letter), so no scaling needed
    const pageW = 612;
    const pageH = cfg.pageSize === 'LEGAL' ? 1008 : 792;
    const stroke = 0.75;
    const bodyFont = cfg.fonts?.body || 'Helvetica';
    const boldFont = cfg.fonts?.bold || 'Helvetica-Bold';
    const textColor = cfg.colors?.text || '#000000';

    // ═══════════════════════════════════════════════════════════════
    // All positions come from cfg (template config) — absolute coords
    // ═══════════════════════════════════════════════════════════════

    // --- COMPANY INFO — use cfg.companyInfo.x, y, width ---
    if (cfg.companyInfo?.show !== false) {
      const ciX = cfg.companyInfo?.x ?? 50;
      const ciY = cfg.companyInfo?.y ?? 40;
      const ciW = cfg.companyInfo?.width ?? 220;
      doc.font(boldFont).fontSize(cfg.companyInfo?.fontSize || 11).fillColor(textColor);
      doc.text(cfg.companyInfo?.name || 'First Class Glass & Mirror, Inc.', ciX, ciY, { width: ciW });
      doc.font(bodyFont).fontSize(cfg.companyInfo?.linesFontSize || 9);
      doc.text(cfg.companyInfo?.line1 || '1513 Industrial Drive', ciX, ciY + 14, { width: ciW });
      doc.text(cfg.companyInfo?.line2 || 'Itasca, IL. 60143', ciX, ciY + 25, { width: ciW });
      doc.text(cfg.companyInfo?.phone || '630-250-9777', ciX, ciY + 36, { width: ciW });
      doc.text(cfg.companyInfo?.fax || '630-250-9727', ciX, ciY + 47, { width: ciW });
    }

    // --- LOGO — use cfg.logo.x, y, width, height ---
    if (cfg.logo?.show !== false && hasLogo) {
      doc.image(logoPath, cfg.logo?.x ?? 260, cfg.logo?.y ?? 40, {
        width: cfg.logo?.width ?? 72,
        height: cfg.logo?.height ?? 72
      });
    }

    // --- TITLE — use cfg.title.x, y, width ---
    if (cfg.title?.show !== false) {
      const ttX = cfg.title?.x ?? 400;
      const ttY = cfg.title?.y ?? 40;
      const ttW = cfg.title?.width ?? 162;
      doc.font(boldFont).fontSize(cfg.title?.fontSize || 22).fillColor(textColor);
      const titleText = docType === 'invoice' ? 'Invoice' : 'Estimate';
      doc.text(titleText, ttX, ttY, { width: ttW, align: cfg.title?.textAlign || cfg.title?.align || 'right' });
    }

    // --- DATE BOX — use cfg.dateBox.x, y, width, height ---
    if (cfg.dateBox?.show !== false) {
      const dbX = cfg.dateBox?.x ?? 400;
      const dbY = cfg.dateBox?.y ?? 90;
      const dbW = cfg.dateBox?.width ?? 162;
      const isInvoice = docType === 'invoice';
      const issueDateStr = data.issueDate
        ? new Date(data.issueDate).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
        : new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

      if (isInvoice) {
        const dateColW = Math.floor(dbW / 2);
        const invColW = dbW - dateColW;
        const dbH = 16;
        doc.lineWidth(stroke);
        doc.rect(dbX, dbY, dateColW, dbH).stroke();
        doc.rect(dbX + dateColW, dbY, invColW, dbH).stroke();
        doc.font(boldFont).fontSize(7).fillColor(textColor);
        doc.text('DATE', dbX + 4, dbY + 4, { width: dateColW - 8, align: 'center' });
        doc.text('INVOICE #', dbX + dateColW + 4, dbY + 4, { width: invColW - 8, align: 'center' });
        doc.rect(dbX, dbY + dbH, dateColW, dbH).stroke();
        doc.rect(dbX + dateColW, dbY + dbH, invColW, dbH).stroke();
        doc.font(bodyFont).fontSize(8);
        doc.text(issueDateStr, dbX + 4, dbY + dbH + 4, { width: dateColW - 8, align: 'center' });
        doc.text(String(data.invoiceNumber || ''), dbX + dateColW + 4, dbY + dbH + 4, { width: invColW - 8, align: 'center' });
      } else {
        const dbH = 16;
        doc.lineWidth(stroke);
        doc.rect(dbX, dbY, dbW, dbH).stroke();
        doc.font(boldFont).fontSize(7).fillColor(textColor);
        doc.text('DATE', dbX + 4, dbY + 4, { width: dbW - 8, align: 'center' });
        doc.rect(dbX, dbY + dbH, dbW, dbH).stroke();
        doc.font(bodyFont).fontSize(8);
        doc.text(issueDateStr, dbX + 4, dbY + dbH + 4, { width: dbW - 8, align: 'center' });
      }
    }

    // --- BILL TO — use cfg.billTo.x, y, width, height ---
    const billToShow = cfg.billTo?.show !== false;
    const projShow = cfg.projectBox?.show !== false;
    if (billToShow || projShow) {
      // Gather bill-to data
      const custName = U(data.companyName || data.custName || '');
      const billLines = [];
      if (custName) billLines.push(custName);
      const rawAddr = (data.billingAddress || '').trim();
      const bCity = (data.billingCity || '').trim();
      const bState = (data.billingState || '').trim();
      const bZip = (data.billingZip || '').trim();
      const cityStateZip = [bCity, bState].filter(Boolean).join(', ') + (bZip ? ' ' + bZip : '');
      if (rawAddr) {
        // Split address on newlines or commas to prevent text stacking/overlap
        const addrParts = rawAddr.split(/[\n\r]+|,\s*/).map(s => s.trim()).filter(Boolean);
        const addrUpper = rawAddr.toUpperCase();
        const hasCityZipInAddr = cityStateZip && bCity && addrUpper.includes(bCity.toUpperCase()) && bZip && addrUpper.includes(bZip);
        for (const part of addrParts) billLines.push(U(part));
        if (!hasCityZipInAddr && cityStateZip) billLines.push(U(cityStateZip));
      } else if (cityStateZip) {
        billLines.push(U(cityStateZip));
      }
      if (data.custPhone) billLines.push(data.custPhone);
      if (data.custFax) billLines.push('FAX# ' + data.custFax);

      // Gather project/ship-to data
      const projLabel = docType === 'invoice'
        ? (cfg.projectBox?.invoiceLabel || 'SHIP TO')
        : (cfg.projectBox?.estimateLabel || 'PROJECT NAME/ADDRESS');
      const projLines = [];
      if (docType === 'invoice') {
        if (data.projectName) projLines.push(U(data.projectName));
        if (data.shipToAddress) projLines.push(U(data.shipToAddress));
        const shipCSZ = [data.shipToCity, data.shipToState].filter(Boolean).join(' ') + (data.shipToZip ? ' ' + data.shipToZip : '');
        if (shipCSZ.trim()) projLines.push(U(shipCSZ));
      } else {
        if (data.projectName) projLines.push(U(data.projectName));
        if (data.projectAddress) projLines.push(U(data.projectAddress));
        const projCSZ = [data.projectCity, data.projectState].filter(Boolean).join(' ') + (data.projectZip ? ' ' + data.projectZip : '');
        if (projCSZ.trim()) projLines.push(U(projCSZ));
      }

      const lineH = 12;
      const hdrH = 15;

      // Bill To — absolute position from config
      if (billToShow) {
        const btX = cfg.billTo?.x ?? 50;
        const btY = cfg.billTo?.y ?? 155;
        const btW = cfg.billTo?.width ?? 245;
        const cfgH = cfg.billTo?.height ?? 90;
        // Ensure box is tall enough for all content lines
        const contentH = hdrH + 3 + billLines.length * lineH + 4;
        const btH = Math.max(cfgH, contentH);
        doc.lineWidth(stroke);
        doc.rect(btX, btY, btW, btH).stroke();
        doc.font(boldFont).fontSize(7).fillColor(textColor);
        doc.text(cfg.billTo?.label || 'BILL TO', btX + 4, btY + 4);
        doc.moveTo(btX, btY + hdrH).lineTo(btX + btW, btY + hdrH).lineWidth(0.5).stroke();
        doc.font(bodyFont).fontSize(8);
        let bY = btY + hdrH + 3;
        for (const line of billLines) {
          doc.text(line, btX + 4, bY, { width: btW - 8, lineBreak: false, ellipsis: true });
          bY += lineH;
        }
      }

      // Project Box — absolute position from config
      if (projShow) {
        const pbX = cfg.projectBox?.x ?? 305;
        const pbY = cfg.projectBox?.y ?? 155;
        const pbW = cfg.projectBox?.width ?? 257;
        const pbH = cfg.projectBox?.height ?? 90;
        doc.lineWidth(stroke);
        doc.rect(pbX, pbY, pbW, pbH).stroke();
        doc.font(boldFont).fontSize(7).fillColor(textColor);
        doc.text(projLabel, pbX + 4, pbY + 4);
        doc.moveTo(pbX, pbY + hdrH).lineTo(pbX + pbW, pbY + hdrH).lineWidth(0.5).stroke();
        doc.font(bodyFont).fontSize(8);
        let pY = pbY + hdrH + 3;
        for (const line of projLines) { doc.text(line, pbX + 4, pY, { width: pbW - 8 }); pY += lineH; }
      }

      // --- P.O. NUMBER — absolute position from config ---
      if (cfg.poNumber?.show !== false && data.poNumber) {
        const poX = cfg.poNumber?.x ?? 400;
        const poY = cfg.poNumber?.y ?? 255;
        const poW = cfg.poNumber?.width ?? 162;
        const poH = cfg.poNumber?.height ?? 35;
        doc.lineWidth(stroke);
        doc.rect(poX, poY, poW, poH).stroke();
        doc.font(boldFont).fontSize(7).fillColor(textColor);
        doc.text(cfg.poNumber?.label || 'P.O. No.', poX + 4, poY + 4);
        doc.moveTo(poX, poY + hdrH).lineTo(poX + poW, poY + hdrH).lineWidth(0.5).stroke();
        doc.font(bodyFont).fontSize(8);
        doc.text(U(data.poNumber), poX + 4, poY + hdrH + 3, { width: poW - 8 });
      }
    }

    // --- LINE ITEMS TABLE — use cfg.lineItems.x, y, width ---
    const displayMode = cfg.lineItems?.displayMode || 'detailed';
    if (cfg.lineItems?.show !== false) {
      const liX = cfg.lineItems?.x ?? 50;
      const liY = cfg.lineItems?.y ?? 300;
      const liW = cfg.lineItems?.width ?? 512;
      const tableTop = liY;
      const colEnd = liX + liW;
      const footerH = cfg.footer?.height || 52;
      const footerGap = 8;
      const bottomLimit = pageH - (cfg.margins?.bottom ?? 40);
      const maxTableBottom = bottomLimit - footerH - footerGap;
      const bodyFontSize = cfg.lineItems?.bodyFontSize || 8;
      let rowY = tableTop;

      if (displayMode === 'bid') {
        const bidLabel = cfg.lineItems?.bidDescriptionLabel || 'Scope of Work';
        doc.font(boldFont).fontSize(cfg.lineItems?.headerFontSize || 9).fillColor(textColor);
        doc.text(bidLabel + ':', liX, tableTop);
        rowY = tableTop + 16;
        let bidDesc = lineItems.map(item => U(item.description || '')).filter(Boolean).join(', ');
        if (data.notes && data.notes.trim()) {
          bidDesc += (bidDesc ? '\n\n' : '') + U(data.notes.trim());
        }
        doc.font(bodyFont).fontSize(bodyFontSize);
        const descH = doc.heightOfString(bidDesc, { width: liW - 8 });
        doc.text(bidDesc, liX, rowY, { width: liW });
        rowY += descH + 14;
        const totalStr = fmtMoney(data.total);
        doc.font(boldFont).fontSize(cfg.footer?.totalAmountFontSize || 12).fillColor(textColor);
        doc.text('TOTAL: ' + totalStr, liX, rowY, { width: liW, align: 'right' });
        rowY += 20;
      } else if (displayMode === 'summary') {
        const tHeaderH = 18;
        const headerBg = cfg.lineItems?.headerBgColor || cfg.colors?.headerBg || '#E0E0E0';
        const headers = docType === 'invoice'
          ? (cfg.lineItems?.invoiceHeaders || { description: 'DESCRIPTION' })
          : (cfg.lineItems?.estimateHeaders || { description: 'DESCRIPTION' });

        // Build items including notes
        const summaryItems = [...lineItems];
        if (data.notes && data.notes.trim()) {
          summaryItems.push({ description: data.notes.trim() });
        }

        doc.font(bodyFont).fontSize(bodyFontSize);
        const itemHeights = summaryItems.map(item => {
          const desc = U(item.description || '');
          const descH = doc.heightOfString(desc, { width: liW - 8 });
          return Math.max(descH + 6, 16);
        });
        doc.lineWidth(stroke);
        doc.save();
        doc.rect(liX, tableTop, liW, tHeaderH).fill(headerBg);
        doc.restore();
        doc.rect(liX, tableTop, liW, tHeaderH).stroke();
        doc.font(boldFont).fontSize(cfg.lineItems?.headerFontSize || 7).fillColor(textColor);
        doc.text(headers.description || 'DESCRIPTION', liX + 4, tableTop + 5);
        rowY = tableTop + tHeaderH;
        doc.font(bodyFont).fontSize(bodyFontSize);
        for (let i = 0; i < summaryItems.length; i++) {
          const item = summaryItems[i];
          const cellH = Math.max(itemHeights[i], 14);
          doc.lineWidth(0.5);
          doc.rect(liX, rowY, liW, cellH).stroke();
          doc.text(U(item.description || ''), liX + 4, rowY + 3, { width: liW - 8 });
          rowY += cellH;
        }
      } else {
        // ── DETAILED MODE ──
        const qtyW = cfg.lineItems?.qtyColumnWidth || 50;
        const totalW = cfg.lineItems?.totalColumnWidth || 75;
        const colQty = liX;
        const colDesc = liX + qtyW;
        const colTotal = liX + liW - totalW;
        const tHeaderH = 18;

        // Build items list including notes as a final row if present
        const allItems = [...lineItems];
        if (data.notes && data.notes.trim()) {
          allItems.push({ description: data.notes.trim(), quantity: null, amount: 0, _isNote: true });
        }

        doc.font(bodyFont).fontSize(bodyFontSize);
        const itemHeights = allItems.map(item => {
          const desc = U(item.description || '');
          const descH = doc.heightOfString(desc, { width: colTotal - colDesc - 8 });
          return Math.max(descH + 6, 16);
        });
        const totalItemsH = itemHeights.reduce((s, h) => s + h, 0);
        const neededH = tHeaderH + totalItemsH;
        const availH = maxTableBottom - tableTop;

        let scale = 1;
        if (neededH > availH && totalItemsH > 0) {
          const targetItemsH = availH - tHeaderH;
          scale = Math.max(targetItemsH / totalItemsH, 0.6);
        }

        const headerBg = cfg.lineItems?.headerBgColor || cfg.colors?.headerBg || '#E0E0E0';
        doc.lineWidth(stroke);
        doc.save();
        doc.rect(colQty, tableTop, colEnd - colQty, tHeaderH).fill(headerBg);
        doc.restore();
        doc.rect(colQty, tableTop, colEnd - colQty, tHeaderH).stroke();
        doc.moveTo(colDesc, tableTop).lineTo(colDesc, tableTop + tHeaderH).stroke();
        doc.moveTo(colTotal, tableTop).lineTo(colTotal, tableTop + tHeaderH).stroke();

        const headers = docType === 'invoice'
          ? (cfg.lineItems?.invoiceHeaders || { qty: 'QUANTITY', description: 'DESCRIPTION', total: 'AMOUNT' })
          : (cfg.lineItems?.estimateHeaders || { qty: 'Qty', description: 'DESCRIPTION', total: 'TOTAL' });

        doc.font(boldFont).fontSize(cfg.lineItems?.headerFontSize || 7).fillColor(textColor);
        doc.text(headers.qty, colQty + 2, tableTop + 5, { width: colDesc - colQty - 4, align: 'center' });
        doc.text(headers.description, colDesc + 4, tableTop + 5);
        doc.text(headers.total, colTotal + 4, tableTop + 5, { width: colEnd - colTotal - 8, align: 'right' });

        rowY = tableTop + tHeaderH;
        doc.font(bodyFont).fontSize(bodyFontSize);
        for (let i = 0; i < allItems.length; i++) {
          const item = allItems[i];
          const cellH = Math.max(itemHeights[i] * scale, 14);
          const desc = U(item.description || '');

          doc.lineWidth(0.5);
          doc.rect(colQty, rowY, colDesc - colQty, cellH).stroke();
          doc.rect(colDesc, rowY, colTotal - colDesc, cellH).stroke();
          doc.rect(colTotal, rowY, colEnd - colTotal, cellH).stroke();

          if (item.quantity != null && Number(item.quantity) > 0) {
            const qtyStr = Number(item.quantity) === Math.floor(Number(item.quantity))
              ? String(Math.floor(Number(item.quantity)))
              : Number(item.quantity).toFixed(2);
            doc.text(qtyStr, colQty + 2, rowY + 3, { width: colDesc - colQty - 4, align: 'center' });
          }
          doc.text(desc, colDesc + 4, rowY + 3, { width: colTotal - colDesc - 8 });
          const amt = Number(item.amount) || 0;
          if (amt > 0) {
            doc.text(amt.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','), colTotal + 4, rowY + 3, { width: colEnd - colTotal - 8, align: 'right' });
          }
          rowY += cellH;
        }
      }

      // --- FOOTER — use cfg.footer.x, y, width, height ---
      if (cfg.footer?.show !== false) {
        const ftX = cfg.footer?.x ?? 50;
        const ftW = cfg.footer?.width ?? 512;
        // Footer y: use config position, but push down if line items extend past it
        const ftY = Math.max(cfg.footer?.y ?? 700, rowY + footerGap);
        const ftH = cfg.footer?.height || 52;
        const totalAmountW = cfg.footer?.totalAmountWidth || 100;
        const totalLabelW = cfg.footer?.totalLabelWidth || 60;
        const termsColW = ftW - totalLabelW - totalAmountW;
        const totalLabelX = ftX + termsColW;
        const totalAmountX = totalLabelX + totalLabelW;

        // Terms text: prefer template config termsText, fall back to data.terms
        const termsFontSize = cfg.footer?.termsFontSize || 8;
        const termsBold = cfg.footer?.termsBold || false;
        const termsAlign = cfg.footer?.termsAlign || 'left';
        const termsFont = termsBold ? boldFont : bodyFont;

        if (displayMode === 'bid') {
          if (cfg.footer?.showTerms !== false) {
            const termsText = (cfg.footer?.termsText || data.terms || '').toUpperCase();
            if (termsText) {
              doc.lineWidth(stroke);
              doc.rect(ftX, ftY, ftW, ftH).stroke();
              doc.font(termsFont).fontSize(termsFontSize).fillColor(textColor);
              doc.text(termsText, ftX + 4, ftY + 5, { width: ftW - 8, lineGap: 1.5, align: termsAlign });
            }
          }
        } else {
          doc.lineWidth(stroke);
          doc.rect(ftX, ftY, termsColW, ftH).stroke();
          doc.rect(totalLabelX, ftY, totalLabelW, ftH).stroke();
          doc.rect(totalAmountX, ftY, totalAmountW, ftH).stroke();

          if (cfg.footer?.showTerms !== false) {
            const termsText = (cfg.footer?.termsText || data.terms || '').toUpperCase();
            if (termsText) {
              doc.font(termsFont).fontSize(termsFontSize).fillColor(textColor);
              doc.text(termsText, ftX + 4, ftY + 5, { width: termsColW - 8, lineGap: 1.5, align: termsAlign });
            }
          }

          const totalStr = fmtMoney(data.total);
          doc.font(boldFont).fontSize(cfg.footer?.totalFontSize || 10).fillColor(textColor);
          doc.text('TOTAL', totalLabelX + 4, ftY + (ftH / 2) - 6, { width: totalLabelW - 8, align: 'center' });
          doc.fontSize(cfg.footer?.totalAmountFontSize || 11);
          doc.text(totalStr, totalAmountX + 4, ftY + (ftH / 2) - 6, { width: totalAmountW - 8, align: 'right' });
        }
      }
    }

    // --- CUSTOM TEXT BOXES ---
    if (cfg.customTextBoxes && cfg.customTextBoxes.length > 0) {
      for (const tb of cfg.customTextBoxes) {
        const tbX = tb.x || 0;
        const tbY = tb.y || 0;
        const tbW = tb.width || 200;
        const tbH = tb.height || 40;

        if (tb.backgroundColor && tb.backgroundColor !== '#ffffff' && tb.backgroundColor !== 'transparent') {
          doc.save();
          doc.rect(tbX, tbY, tbW, tbH).fill(tb.backgroundColor);
          doc.restore();
        }

        if (tb.showBorder) {
          doc.lineWidth(tb.borderWidth || 1);
          doc.rect(tbX, tbY, tbW, tbH).stroke();
          doc.lineWidth(stroke); // reset
        }

        doc.fontSize(tb.fontSize || 10)
           .font(tb.bold ? boldFont : bodyFont)
           .fillColor(tb.textColor || '#000000')
           .text(tb.text || '', tbX + 4, tbY + 4, {
             width: tbW - 8,
             align: tb.textAlign || 'left',
           });

        doc.fillColor(textColor); // reset
      }
    }

    doc.end();
  });
}

// --- Generate professional PDF matching QuickBooks format ---
async function generateEstimatePdf(estimateId, templateId = null) {
  console.log('[PDF Gen] generateEstimatePdf called — estimateId:', estimateId, 'templateId param:', templateId);
  const [[estimate]] = await db.query(`
    SELECT e.*,
           c.companyName, c.name AS custName,
           c.phone AS custPhone, c.fax AS custFax, c.email AS custEmail,
           c.billingAddress AS custBillingAddress, c.billingCity AS custBillingCity,
           c.billingState AS custBillingState, c.billingZip AS custBillingZip
    FROM estimates e LEFT JOIN customers c ON e.customerId = c.id
    WHERE e.id = ?
  `, [estimateId]);
  if (!estimate) throw new Error('Estimate not found');
  console.log('[PDF Gen] Estimate loaded — estimate.templateId stored in DB:', estimate.templateId);

  // Use explicit templateId param, fall back to estimate's stored templateId
  const effectiveTemplateId = templateId || estimate.templateId || null;
  console.log('[PDF Gen] Effective templateId:', effectiveTemplateId);

  estimate.billingAddress = estimate.billingAddress || estimate.custBillingAddress;
  estimate.billingCity = estimate.billingCity || estimate.custBillingCity;
  estimate.billingState = estimate.billingState || estimate.custBillingState;
  estimate.billingZip = estimate.billingZip || estimate.custBillingZip;

  const [lineItems] = await db.query(
    'SELECT * FROM estimate_line_items WHERE estimateId = ? ORDER BY sortOrder ASC, id ASC',
    [estimateId]
  );

  const cfg = await loadTemplateConfig(effectiveTemplateId, 'estimate');
  return generatePdfWithConfig(estimate, lineItems, cfg, 'estimate');
}

// GET /estimates - list all estimates
app.get('/estimates', authenticate, async (req, res) => {
  try {
    const { status, customerId, workOrderId, search } = req.query;
    let sql = `
      SELECT e.*, c.companyName, c.name AS custName, c.phone AS custPhone, c.email AS custEmail
      FROM estimates e
      LEFT JOIN customers c ON e.customerId = c.id
    `;
    const conditions = [];
    const params = [];

    if (status) { conditions.push('e.status = ?'); params.push(status); }
    if (customerId) { conditions.push('e.customerId = ?'); params.push(Number(customerId)); }
    if (workOrderId) { conditions.push('e.workOrderId = ?'); params.push(Number(workOrderId)); }
    if (search) {
      conditions.push('(c.companyName LIKE ? OR c.name LIKE ? OR e.projectName LIKE ? OR e.poNumber LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY e.createdAt DESC';

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching estimates:', err);
    res.status(500).json({ error: 'Failed to fetch estimates.' });
  }
});

// GET /estimates/:id - single estimate with line items
app.get('/estimates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[estimate]] = await db.query(`
      SELECT e.*,
             c.companyName, c.name AS custName,
             c.phone AS custPhone, c.fax AS custFax, c.email AS custEmail,
             c.billingAddress AS custBillingAddress, c.billingCity AS custBillingCity,
             c.billingState AS custBillingState, c.billingZip AS custBillingZip
      FROM estimates e LEFT JOIN customers c ON e.customerId = c.id
      WHERE e.id = ?
    `, [req.params.id]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found.' });

    // Effective billing: use estimate override if set, else customer's
    estimate.effectiveBillingAddress = estimate.billingAddress || estimate.custBillingAddress;
    estimate.effectiveBillingCity = estimate.billingCity || estimate.custBillingCity;
    estimate.effectiveBillingState = estimate.billingState || estimate.custBillingState;
    estimate.effectiveBillingZip = estimate.billingZip || estimate.custBillingZip;

    const [lineItems] = await db.query(
      'SELECT * FROM estimate_line_items WHERE estimateId = ? ORDER BY sortOrder ASC, id ASC',
      [req.params.id]
    );
    estimate.lineItems = lineItems;
    res.json(estimate);
  } catch (err) {
    console.error('Error fetching estimate:', err);
    res.status(500).json({ error: 'Failed to fetch estimate.' });
  }
});

// POST /estimates - create new estimate
app.post('/estimates', authenticate, async (req, res) => {
  try {
    const body = coerceBody(req);

    // Resolve customerId: use provided ID, or find/create by name
    let resolvedCustomerId = body.customerId ? Number(body.customerId) : null;
    if (!resolvedCustomerId) {
      const customerName = body.customerName || body.customerSearch;
      if (!customerName || !String(customerName).trim()) {
        return res.status(400).json({ error: 'customerId or customerName is required.' });
      }
      const cust = await findOrCreateCustomer(customerName, {
        billingAddress: body.billingAddress, billingCity: body.billingCity,
        billingState: body.billingState, billingZip: body.billingZip,
      });
      resolvedCustomerId = cust.id;
    }

    const cols = ['customerId'];
    const vals = [resolvedCustomerId];
    const fields = ['workOrderId','status','issueDate','expirationDate','poNumber','projectName',
      'projectAddress','projectCity','projectState','projectZip',
      'billingAddress','billingCity','billingState','billingZip',
      'subtotal','taxRate','taxAmount','total','notes','pdfPath','templateId'];

    for (const f of fields) {
      if (body[f] !== undefined) {
        cols.push(f);
        vals.push(body[f]);
      }
    }

    // Default terms
    cols.push('terms');
    vals.push(body.terms || DEFAULT_TERMS);

    const placeholders = cols.map(() => '?').join(',');
    const [result] = await db.query(
      `INSERT INTO estimates (${cols.join(',')}) VALUES (${placeholders})`,
      vals
    );
    const [[newEst]] = await db.query('SELECT * FROM estimates WHERE id = ?', [result.insertId]);

    // Auto-update linked work order status to "Waiting for Approval"
    if (body.workOrderId) {
      try {
        await db.query("UPDATE work_orders SET status='Waiting for Approval' WHERE id=?", [Number(body.workOrderId)]);
      } catch (woErr) {
        console.error('Failed to update WO status on estimate create:', woErr.message);
      }
    }

    res.status(201).json(newEst);
  } catch (err) {
    console.error('Error creating estimate:', err);
    res.status(500).json({ error: 'Failed to create estimate.' });
  }
});

// PUT /estimates/:id - update estimate
app.put('/estimates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const body = coerceBody(req);
    const sets = [];
    const params = [];
    const fields = ['customerId','workOrderId','status','issueDate','expirationDate','poNumber',
      'projectName','projectAddress','projectCity','projectState','projectZip',
      'billingAddress','billingCity','billingState','billingZip',
      'subtotal','taxRate','taxAmount','total','notes','terms','pdfPath','templateId'];

    for (const f of fields) {
      if (body[f] !== undefined) {
        sets.push(`${f}=?`);
        params.push(body[f]);
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });
    sets.push('updatedAt=NOW()');
    params.push(req.params.id);

    await db.query(`UPDATE estimates SET ${sets.join(',')} WHERE id=?`, params);

    // Recalculate if taxRate changed
    if (body.taxRate !== undefined) await recalcEstimateTotals(req.params.id);

    const [[updated]] = await db.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating estimate:', err);
    res.status(500).json({ error: 'Failed to update estimate.' });
  }
});

// DELETE /estimates/:id
app.delete('/estimates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    await db.query('DELETE FROM estimates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting estimate:', err);
    res.status(500).json({ error: 'Failed to delete estimate.' });
  }
});

// POST /estimates/:id/line-items - add line item
app.post('/estimates/:id/line-items', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const body = coerceBody(req);
    if (!body.description && !body.itemName) return res.status(400).json({ error: 'description or itemName is required.' });
    if (body.amount === undefined) return res.status(400).json({ error: 'amount is required.' });

    await db.query(
      'INSERT INTO estimate_line_items (estimateId, itemName, description, quantity, amount, sortOrder) VALUES (?,?,?,?,?,?)',
      [req.params.id, body.itemName || null, body.description || '', body.quantity ?? null, Number(body.amount), body.sortOrder || 0]
    );
    await recalcEstimateTotals(req.params.id);

    const [[estimate]] = await db.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    const [lineItems] = await db.query(
      'SELECT * FROM estimate_line_items WHERE estimateId = ? ORDER BY sortOrder ASC, id ASC',
      [req.params.id]
    );
    estimate.lineItems = lineItems;
    res.status(201).json(estimate);
  } catch (err) {
    console.error('Error adding line item:', err);
    res.status(500).json({ error: 'Failed to add line item.' });
  }
});

// PUT /estimates/:id/line-items/:itemId - update line item
app.put('/estimates/:id/line-items/:itemId', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const body = coerceBody(req);
    const sets = [];
    const params = [];

    if (body.itemName !== undefined) { sets.push('itemName=?'); params.push(body.itemName || null); }
    if (body.description !== undefined) { sets.push('description=?'); params.push(body.description); }
    if (body.quantity !== undefined) { sets.push('quantity=?'); params.push(body.quantity); }
    if (body.amount !== undefined) { sets.push('amount=?'); params.push(Number(body.amount)); }
    if (body.sortOrder !== undefined) { sets.push('sortOrder=?'); params.push(Number(body.sortOrder)); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });
    params.push(req.params.itemId, req.params.id);

    await db.query(`UPDATE estimate_line_items SET ${sets.join(',')} WHERE id=? AND estimateId=?`, params);
    await recalcEstimateTotals(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating line item:', err);
    res.status(500).json({ error: 'Failed to update line item.' });
  }
});

// DELETE /estimates/:id/line-items/:itemId
app.delete('/estimates/:id/line-items/:itemId', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    await db.query('DELETE FROM estimate_line_items WHERE id=? AND estimateId=?', [req.params.itemId, req.params.id]);
    await recalcEstimateTotals(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting line item:', err);
    res.status(500).json({ error: 'Failed to delete line item.' });
  }
});

// PUT /estimates/:id/line-items/reorder
app.put('/estimates/:id/line-items/reorder', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const body = coerceBody(req);
    const items = body.items || [];
    for (const item of items) {
      if (item.id && item.sortOrder !== undefined) {
        await db.query('UPDATE estimate_line_items SET sortOrder=? WHERE id=? AND estimateId=?',
          [Number(item.sortOrder), Number(item.id), req.params.id]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering line items:', err);
    res.status(500).json({ error: 'Failed to reorder line items.' });
  }
});

// PUT /estimates/:id/status - update status
app.put('/estimates/:id/status', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const body = coerceBody(req);
    const { status } = body;
    const valid = ['Draft', 'Sent', 'Accepted', 'Declined'];
    if (!valid.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });

    const sets = ['status=?', 'updatedAt=NOW()'];
    const params = [status];

    if (status === 'Sent') { sets.push('sentAt=NOW()'); }
    if (status === 'Accepted') { sets.push('acceptedAt=NOW()'); }
    if (status === 'Declined') { sets.push('declinedAt=NOW()'); }

    params.push(req.params.id);
    await db.query(`UPDATE estimates SET ${sets.join(',')} WHERE id=?`, params);

    // Sync status to linked work order (only on Accept)
    if (status === 'Accepted') {
      const [[est]] = await db.query('SELECT workOrderId FROM estimates WHERE id=?', [req.params.id]);
      if (est?.workOrderId) {
        try {
          await db.query("UPDATE work_orders SET status='Approved' WHERE id=?", [est.workOrderId]);
          console.log('[Estimate] Accepted - Updated WO #' + est.workOrderId + ' status to Approved');
        } catch (woErr) {
          console.warn('[PUT /estimates] Failed to sync WO status:', woErr.message);
        }
      }
    }

    const [[updated]] = await db.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating estimate status:', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// POST /estimates/:id/generate-pdf
app.post('/estimates/:id/generate-pdf', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    console.log('[PDF Gen] POST /estimates/' + req.params.id + '/generate-pdf — body keys:', Object.keys(b), 'templateId:', b.templateId);
    const pdfBuffer = await generateEstimatePdf(req.params.id, b.templateId || null);
    const filename = `estimate_${req.params.id}_${Date.now()}.pdf`;
    const localDir = path.resolve(__dirname, 'uploads');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    const filePath = path.join(localDir, filename);
    fs.writeFileSync(filePath, pdfBuffer);

    const pdfPath = `uploads/${filename}`;
    const tplId = b.templateId || null;
    await db.query('UPDATE estimates SET pdfPath=?, templateId=COALESCE(?,templateId), updatedAt=NOW() WHERE id=?', [pdfPath, tplId, req.params.id]);
    await uploadToS3IfConfigured(filePath, pdfPath);

    res.json({ pdfPath });
  } catch (err) {
    console.error('Error generating estimate PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

// POST /estimates/:id/send-email (placeholder)
app.post('/estimates/:id/send-email', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    // Generate PDF if not already generated
    const [[est]] = await db.query('SELECT pdfPath FROM estimates WHERE id = ?', [req.params.id]);
    if (!est) return res.status(404).json({ error: 'Estimate not found.' });

    let pdfPath = est.pdfPath;
    if (!pdfPath) {
      const pdfBuffer = await generateEstimatePdf(req.params.id);
      const filename = `estimate_${req.params.id}_${Date.now()}.pdf`;
      const localDir = path.resolve(__dirname, 'uploads');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, filename);
      fs.writeFileSync(localPath, pdfBuffer);
      pdfPath = `uploads/${filename}`;
      await db.query('UPDATE estimates SET pdfPath=?, updatedAt=NOW() WHERE id=?', [pdfPath, req.params.id]);
      await uploadToS3IfConfigured(localPath, pdfPath);
    }

    // Update status to Sent
    await db.query('UPDATE estimates SET status=?, sentAt=NOW(), updatedAt=NOW() WHERE id=?', ['Sent', req.params.id]);

    res.json({ message: 'Email sending will be configured soon. PDF has been generated.', pdfPath });
  } catch (err) {
    console.error('Error sending estimate email:', err);
    res.status(500).json({ error: 'Failed to send estimate.' });
  }
});

// ─── INVOICES ───────────────────────────────────────────────────────────────

async function getNextInvoiceNumber() {
  const [[row]] = await db.query("SELECT settingValue FROM settings WHERE settingKey = 'nextInvoiceNumber'");
  const current = Number(row?.settingValue) || 1;
  await db.query("UPDATE settings SET settingValue = ?, updatedAt = NOW() WHERE settingKey = 'nextInvoiceNumber'", [String(current + 1)]);
  return String(current);
}

async function recalcInvoiceTotals(invoiceId) {
  const [[{ s }]] = await db.query(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_line_items WHERE invoiceId = ?',
    [invoiceId]
  );
  const subtotal = Number(s) || 0;
  const [[inv]] = await db.query('SELECT taxRate, status FROM invoices WHERE id = ?', [invoiceId]);
  const taxRate = Number(inv?.taxRate) || 0;
  const taxAmount = Math.round(subtotal * taxRate) / 100;
  const total = subtotal + taxAmount;
  const [[{ paid }]] = await db.query(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoiceId = ?',
    [invoiceId]
  );
  const amountPaid = Number(paid) || 0;
  const balanceDue = Math.round((total - amountPaid) * 100) / 100;

  const sets = ['subtotal=?', 'taxAmount=?', 'total=?', 'amountPaid=?', 'balanceDue=?', 'updatedAt=NOW()'];
  const params = [subtotal, taxAmount, total, amountPaid, balanceDue];

  if (balanceDue <= 0 && amountPaid > 0 && inv?.status !== 'Draft' && inv?.status !== 'Void') {
    sets.push("status='Paid'", 'paidAt=NOW()');
  } else if (amountPaid > 0 && balanceDue > 0 && inv?.status !== 'Draft' && inv?.status !== 'Void') {
    sets.push("status='Partial'");
  }

  await db.query(`UPDATE invoices SET ${sets.join(',')} WHERE id=?`, [...params, invoiceId]);
}

// --- Generate professional Invoice PDF matching QuickBooks format ---
async function generateInvoicePdf(invoiceId, templateId = null) {
  console.log('[PDF Gen] generateInvoicePdf called — invoiceId:', invoiceId, 'templateId param:', templateId);
  const [[invoice]] = await db.query(`
    SELECT i.*,
           c.companyName, c.name AS custName,
           c.phone AS custPhone, c.fax AS custFax, c.email AS custEmail,
           c.billingAddress AS custBillingAddress, c.billingCity AS custBillingCity,
           c.billingState AS custBillingState, c.billingZip AS custBillingZip
    FROM invoices i LEFT JOIN customers c ON i.customerId = c.id
    WHERE i.id = ?
  `, [invoiceId]);
  if (!invoice) throw new Error('Invoice not found');
  console.log('[PDF Gen] Invoice loaded — invoice.templateId stored in DB:', invoice.templateId);

  // Use explicit templateId param, fall back to invoice's stored templateId
  const effectiveTemplateId = templateId || invoice.templateId || null;
  console.log('[PDF Gen] Effective templateId:', effectiveTemplateId);

  invoice.billingAddress = invoice.billingAddress || invoice.custBillingAddress;
  invoice.billingCity = invoice.billingCity || invoice.custBillingCity;
  invoice.billingState = invoice.billingState || invoice.custBillingState;
  invoice.billingZip = invoice.billingZip || invoice.custBillingZip;

  const [lineItems] = await db.query(
    'SELECT * FROM invoice_line_items WHERE invoiceId = ? ORDER BY sortOrder ASC, id ASC',
    [invoiceId]
  );

  const cfg = await loadTemplateConfig(effectiveTemplateId, 'invoice');
  return generatePdfWithConfig(invoice, lineItems, cfg, 'invoice');
}

// GET /invoices/overdue-summary (must be before :id route)
app.get('/invoices/overdue-summary', authenticate, async (req, res) => {
  try {
    const [[row]] = await db.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(balanceDue), 0) AS total FROM invoices WHERE status IN ('Sent','Overdue') AND dueDate < CURDATE() AND balanceDue > 0"
    );
    res.json({ count: row.cnt || 0, total: Number(row.total) || 0 });
  } catch (err) {
    console.error('Error fetching overdue summary:', err);
    res.status(500).json({ error: 'Failed to fetch overdue summary.' });
  }
});

// GET /invoices - list all invoices
app.get('/invoices', authenticate, async (req, res) => {
  try {
    const { status, customerId, workOrderId, search } = req.query;
    let sql = `
      SELECT i.*, c.companyName, c.name AS custName, c.billingAddress, c.phone AS custPhone, c.email AS custEmail
      FROM invoices i
      LEFT JOIN customers c ON i.customerId = c.id
    `;
    const wheres = [];
    const params = [];

    if (status && status !== 'All') {
      if (status === 'Overdue') {
        wheres.push("(i.status IN ('Sent','Overdue') AND i.dueDate < CURDATE() AND i.balanceDue > 0)");
      } else {
        wheres.push('i.status = ?');
        params.push(status);
      }
    }
    if (customerId) { wheres.push('i.customerId = ?'); params.push(customerId); }
    if (workOrderId) { wheres.push('i.workOrderId = ?'); params.push(workOrderId); }
    if (search) {
      wheres.push("(i.invoiceNumber LIKE ? OR c.companyName LIKE ? OR c.name LIKE ? OR i.projectName LIKE ? OR i.poNumber LIKE ?)");
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
    sql += ' ORDER BY i.createdAt DESC';

    const [rows] = await db.query(sql, params);
    // Auto-detect overdue
    for (const r of rows) {
      if (r.status === 'Sent' && r.dueDate && new Date(r.dueDate) < new Date() && Number(r.balanceDue) > 0) {
        r.status = 'Overdue';
      }
    }
    res.json(rows);
  } catch (err) {
    console.error('Error fetching invoices:', err);
    res.status(500).json({ error: 'Failed to fetch invoices.' });
  }
});

// GET /invoices/:id - single invoice with line items and payments
app.get('/invoices/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[invoice]] = await db.query(`
      SELECT i.*,
             c.companyName, c.name AS custName,
             c.phone AS custPhone, c.fax AS custFax, c.email AS custEmail,
             c.billingAddress AS custBillingAddress, c.billingCity AS custBillingCity,
             c.billingState AS custBillingState, c.billingZip AS custBillingZip
      FROM invoices i LEFT JOIN customers c ON i.customerId = c.id
      WHERE i.id = ?
    `, [req.params.id]);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Effective billing: use invoice override if set, else customer's
    invoice.effectiveBillingAddress = invoice.billingAddress || invoice.custBillingAddress;
    invoice.effectiveBillingCity = invoice.billingCity || invoice.custBillingCity;
    invoice.effectiveBillingState = invoice.billingState || invoice.custBillingState;
    invoice.effectiveBillingZip = invoice.billingZip || invoice.custBillingZip;

    // Auto-detect overdue
    if (invoice.status === 'Sent' && invoice.dueDate && new Date(invoice.dueDate) < new Date() && Number(invoice.balanceDue) > 0) {
      invoice.status = 'Overdue';
    }

    const [lineItems] = await db.query(
      'SELECT * FROM invoice_line_items WHERE invoiceId = ? ORDER BY sortOrder ASC, id ASC',
      [req.params.id]
    );
    const [payments] = await db.query(
      'SELECT * FROM payments WHERE invoiceId = ? ORDER BY paymentDate DESC, id DESC',
      [req.params.id]
    );
    invoice.lineItems = lineItems;
    invoice.payments = payments;
    res.json(invoice);
  } catch (err) {
    console.error('Error fetching invoice:', err);
    res.status(500).json({ error: 'Failed to fetch invoice.' });
  }
});

// POST /invoices - create invoice
app.post('/invoices', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);

    // Resolve customerId: use provided ID, or find/create by name
    let resolvedCustomerId = b.customerId ? Number(b.customerId) : null;
    if (!resolvedCustomerId) {
      const customerName = b.customerName || b.customerSearch;
      if (!customerName || !String(customerName).trim()) {
        return res.status(400).json({ error: 'customerId or customerName is required.' });
      }
      const cust = await findOrCreateCustomer(customerName, {
        billingAddress: b.billingAddress, billingCity: b.billingCity,
        billingState: b.billingState, billingZip: b.billingZip,
      });
      resolvedCustomerId = cust.id;
    }

    const invoiceNumber = await getNextInvoiceNumber();
    const issueDate = b.issueDate || new Date().toISOString().split('T')[0];
    const dueDate = b.dueDate || (() => { const d = new Date(issueDate); d.setDate(d.getDate() + 45); return d.toISOString().split('T')[0]; })();

    // Get default terms from settings if not provided
    let terms = b.terms;
    if (terms === undefined || terms === null) {
      const [[ts]] = await db.query("SELECT settingValue FROM settings WHERE settingKey = 'defaultInvoiceTerms'");
      terms = ts?.settingValue || DEFAULT_TERMS;
    }

    const [result] = await db.query(
      `INSERT INTO invoices (invoiceNumber, customerId, workOrderId, estimateId, status, issueDate, dueDate,
        poNumber, projectName, shipToAddress, shipToCity, shipToState, shipToZip,
        billingAddress, billingCity, billingState, billingZip,
        subtotal, taxRate, taxAmount, total, amountPaid, balanceDue, notes, terms, templateId)
       VALUES (?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        invoiceNumber, resolvedCustomerId, b.workOrderId || null, b.estimateId || null,
        issueDate, dueDate,
        b.poNumber || null, b.projectName || null,
        b.shipToAddress || null, b.shipToCity || null, b.shipToState || null, b.shipToZip || null,
        b.billingAddress || null, b.billingCity || null, b.billingState || null, b.billingZip || null,
        Number(b.subtotal) || 0, Number(b.taxRate) || 0, Number(b.taxAmount) || 0, Number(b.total) || 0,
        Number(b.total) || 0,
        b.notes || null, terms, b.templateId || null
      ]
    );
    const [[created]] = await db.query('SELECT * FROM invoices WHERE id = ?', [result.insertId]);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error creating invoice:', err);
    res.status(500).json({ error: 'Failed to create invoice.' });
  }
});

// PUT /invoices/:id - update invoice
app.put('/invoices/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const fields = ['customerId', 'workOrderId', 'estimateId', 'issueDate', 'dueDate', 'poNumber', 'projectName',
      'shipToAddress', 'shipToCity', 'shipToState', 'shipToZip',
      'billingAddress', 'billingCity', 'billingState', 'billingZip',
      'taxRate', 'notes', 'terms', 'templateId'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f}=?`); params.push(b[f]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updatedAt=NOW()');
    params.push(req.params.id);
    await db.query(`UPDATE invoices SET ${sets.join(',')} WHERE id=?`, params);

    if (b.taxRate !== undefined) await recalcInvoiceTotals(req.params.id);

    const [[updated]] = await db.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating invoice:', err);
    res.status(500).json({ error: 'Failed to update invoice.' });
  }
});

// DELETE /invoices/:id
app.delete('/invoices/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[inv]] = await db.query('SELECT id FROM invoices WHERE id = ?', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    await db.query('DELETE FROM invoices WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting invoice:', err);
    res.status(500).json({ error: 'Failed to delete invoice.' });
  }
});

// POST /invoices/:id/line-items
app.post('/invoices/:id/line-items', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    await db.query(
      'INSERT INTO invoice_line_items (invoiceId, itemName, description, quantity, amount, sortOrder) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, b.itemName || null, b.description || '', b.quantity != null ? b.quantity : null, Number(b.amount) || 0, Number(b.sortOrder) || 0]
    );
    await recalcInvoiceTotals(req.params.id);
    const [[invoice]] = await db.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    const [lineItems] = await db.query('SELECT * FROM invoice_line_items WHERE invoiceId = ? ORDER BY sortOrder ASC, id ASC', [req.params.id]);
    invoice.lineItems = lineItems;
    res.json(invoice);
  } catch (err) {
    console.error('Error adding invoice line item:', err);
    res.status(500).json({ error: 'Failed to add line item.' });
  }
});

// PUT /invoices/:id/line-items/:itemId
app.put('/invoices/:id/line-items/:itemId', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const sets = [];
    const params = [];
    if (b.itemName !== undefined) { sets.push('itemName=?'); params.push(b.itemName || null); }
    if (b.description !== undefined) { sets.push('description=?'); params.push(b.description); }
    if (b.quantity !== undefined) { sets.push('quantity=?'); params.push(b.quantity); }
    if (b.amount !== undefined) { sets.push('amount=?'); params.push(Number(b.amount) || 0); }
    if (b.sortOrder !== undefined) { sets.push('sortOrder=?'); params.push(Number(b.sortOrder) || 0); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.itemId, req.params.id);
    await db.query(`UPDATE invoice_line_items SET ${sets.join(',')} WHERE id=? AND invoiceId=?`, params);
    await recalcInvoiceTotals(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating invoice line item:', err);
    res.status(500).json({ error: 'Failed to update line item.' });
  }
});

// DELETE /invoices/:id/line-items/:itemId
app.delete('/invoices/:id/line-items/:itemId', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    await db.query('DELETE FROM invoice_line_items WHERE id = ? AND invoiceId = ?', [req.params.itemId, req.params.id]);
    await recalcInvoiceTotals(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting invoice line item:', err);
    res.status(500).json({ error: 'Failed to delete line item.' });
  }
});

// PUT /invoices/:id/line-items/reorder
app.put('/invoices/:id/line-items/reorder', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const { items } = coerceBody(req);
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
    for (const it of items) {
      await db.query('UPDATE invoice_line_items SET sortOrder=? WHERE id=? AND invoiceId=?',
        [Number(it.sortOrder) || 0, it.id, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering invoice line items:', err);
    res.status(500).json({ error: 'Failed to reorder line items.' });
  }
});

// PUT /invoices/:id/status
app.put('/invoices/:id/status', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const { status } = coerceBody(req);
    const valid = ['Draft', 'Sent', 'Partial', 'Paid', 'Overdue', 'Void'];
    if (!valid.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });

    const sets = ['status=?', 'updatedAt=NOW()'];
    const params = [status];
    if (status === 'Sent') sets.push('sentAt=NOW()');
    if (status === 'Paid') sets.push('paidAt=NOW()');

    params.push(req.params.id);
    await db.query(`UPDATE invoices SET ${sets.join(',')} WHERE id=?`, params);
    const [[updated]] = await db.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating invoice status:', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// POST /invoices/:id/generate-pdf
app.post('/invoices/:id/generate-pdf', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    console.log('[PDF Gen] POST /invoices/' + req.params.id + '/generate-pdf — body keys:', Object.keys(b), 'templateId:', b.templateId);
    const pdfBuffer = await generateInvoicePdf(req.params.id, b.templateId || null);
    const filename = `invoice_${req.params.id}_${Date.now()}.pdf`;
    const localDir = path.resolve(__dirname, 'uploads');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    const filePath = path.join(localDir, filename);
    fs.writeFileSync(filePath, pdfBuffer);

    const pdfPath = `uploads/${filename}`;
    const tplId = b.templateId || null;
    await db.query('UPDATE invoices SET pdfPath=?, templateId=COALESCE(?,templateId), updatedAt=NOW() WHERE id=?', [pdfPath, tplId, req.params.id]);
    await uploadToS3IfConfigured(filePath, pdfPath);
    res.json({ pdfPath });
  } catch (err) {
    console.error('Error generating invoice PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

// POST /invoices/:id/send-email (placeholder)
app.post('/invoices/:id/send-email', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[inv]] = await db.query('SELECT pdfPath FROM invoices WHERE id = ?', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    let pdfPath = inv.pdfPath;
    if (!pdfPath) {
      const pdfBuffer = await generateInvoicePdf(req.params.id);
      const filename = `invoice_${req.params.id}_${Date.now()}.pdf`;
      const localDir = path.resolve(__dirname, 'uploads');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, filename);
      fs.writeFileSync(localPath, pdfBuffer);
      pdfPath = `uploads/${filename}`;
      await db.query('UPDATE invoices SET pdfPath=?, updatedAt=NOW() WHERE id=?', [pdfPath, req.params.id]);
      await uploadToS3IfConfigured(localPath, pdfPath);
    }

    await db.query("UPDATE invoices SET status='Sent', sentAt=NOW(), updatedAt=NOW() WHERE id=?", [req.params.id]);
    res.json({ message: 'Email sending will be configured soon. PDF has been generated.', pdfPath });
  } catch (err) {
    console.error('Error sending invoice email:', err);
    res.status(500).json({ error: 'Failed to send invoice.' });
  }
});

// POST /invoices/:id/payments - record a payment
app.post('/invoices/:id/payments', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    if (!b.amount || Number(b.amount) <= 0) return res.status(400).json({ error: 'Payment amount is required and must be > 0' });

    await db.query(
      'INSERT INTO payments (invoiceId, paymentDate, amount, paymentMethod, referenceNumber, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [
        req.params.id,
        b.paymentDate || new Date().toISOString().split('T')[0],
        Number(b.amount),
        b.paymentMethod || null,
        b.referenceNumber || null,
        b.notes || null
      ]
    );
    await recalcInvoiceTotals(req.params.id);

    const [[invoice]] = await db.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    const [payments] = await db.query('SELECT * FROM payments WHERE invoiceId = ? ORDER BY paymentDate DESC, id DESC', [req.params.id]);
    invoice.payments = payments;
    res.json(invoice);
  } catch (err) {
    console.error('Error recording payment:', err);
    res.status(500).json({ error: 'Failed to record payment.' });
  }
});

// DELETE /invoices/:id/payments/:paymentId
app.delete('/invoices/:id/payments/:paymentId', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    await db.query('DELETE FROM payments WHERE id = ? AND invoiceId = ?', [req.params.paymentId, req.params.id]);
    await recalcInvoiceTotals(req.params.id);
    const [[invoice]] = await db.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    res.json(invoice);
  } catch (err) {
    console.error('Error deleting payment:', err);
    res.status(500).json({ error: 'Failed to delete payment.' });
  }
});

// POST /invoices/:id/duplicate
app.post('/invoices/:id/duplicate', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[orig]] = await db.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    if (!orig) return res.status(404).json({ error: 'Invoice not found' });

    const invoiceNumber = await getNextInvoiceNumber();
    const issueDate = new Date().toISOString().split('T')[0];
    const dueDate = (() => { const d = new Date(); d.setDate(d.getDate() + 45); return d.toISOString().split('T')[0]; })();

    const [result] = await db.query(
      `INSERT INTO invoices (invoiceNumber, customerId, workOrderId, estimateId, status, issueDate, dueDate,
        poNumber, projectName, shipToAddress, shipToCity, shipToState, shipToZip,
        taxRate, notes, terms)
       VALUES (?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNumber, orig.customerId, orig.workOrderId, orig.estimateId,
        issueDate, dueDate,
        orig.poNumber, orig.projectName, orig.shipToAddress, orig.shipToCity, orig.shipToState, orig.shipToZip,
        orig.taxRate, orig.notes, orig.terms
      ]
    );
    const newId = result.insertId;

    const [origItems] = await db.query('SELECT * FROM invoice_line_items WHERE invoiceId = ? ORDER BY sortOrder ASC', [req.params.id]);
    for (const li of origItems) {
      await db.query(
        'INSERT INTO invoice_line_items (invoiceId, sortOrder, itemName, description, quantity, amount) VALUES (?, ?, ?, ?, ?, ?)',
        [newId, li.sortOrder, li.itemName || null, li.description, li.quantity, li.amount]
      );
    }
    await recalcInvoiceTotals(newId);

    const [[created]] = await db.query('SELECT * FROM invoices WHERE id = ?', [newId]);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error duplicating invoice:', err);
    res.status(500).json({ error: 'Failed to duplicate invoice.' });
  }
});

// POST /estimates/:id/convert-to-invoice
app.post('/estimates/:id/convert-to-invoice', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[estimate]] = await db.query(`
      SELECT e.*, c.companyName, c.name AS custName
      FROM estimates e LEFT JOIN customers c ON e.customerId = c.id
      WHERE e.id = ?
    `, [req.params.id]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const invoiceNumber = await getNextInvoiceNumber();
    const issueDate = new Date().toISOString().split('T')[0];
    const dueDate = (() => { const d = new Date(); d.setDate(d.getDate() + 45); return d.toISOString().split('T')[0]; })();

    const [result] = await db.query(
      `INSERT INTO invoices (invoiceNumber, customerId, workOrderId, estimateId, status, issueDate, dueDate,
        poNumber, projectName, shipToAddress, shipToCity, shipToState, shipToZip,
        taxRate, notes, terms)
       VALUES (?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNumber, estimate.customerId, estimate.workOrderId || null, estimate.id,
        issueDate, dueDate,
        estimate.poNumber || null, estimate.projectName || null,
        estimate.projectAddress || null, estimate.projectCity || null, estimate.projectState || null, estimate.projectZip || null,
        estimate.taxRate || 0, estimate.notes || null, estimate.terms || DEFAULT_TERMS
      ]
    );
    const newId = result.insertId;

    const [estItems] = await db.query('SELECT * FROM estimate_line_items WHERE estimateId = ? ORDER BY sortOrder ASC', [req.params.id]);
    for (const li of estItems) {
      await db.query(
        'INSERT INTO invoice_line_items (invoiceId, sortOrder, itemName, description, quantity, amount) VALUES (?, ?, ?, ?, ?, ?)',
        [newId, li.sortOrder, li.itemName || null, li.description, li.quantity, li.amount]
      );
    }
    await recalcInvoiceTotals(newId);

    // Update estimate status to Accepted if Draft or Sent
    if (estimate.status === 'Draft' || estimate.status === 'Sent') {
      await db.query("UPDATE estimates SET status='Accepted', acceptedAt=NOW(), updatedAt=NOW() WHERE id=?", [req.params.id]);
    }

    // Work order status is NOT changed here — user controls WO status progression manually

    const [[created]] = await db.query('SELECT * FROM invoices WHERE id = ?', [newId]);
    console.log('[Estimate] Converted estimate #' + req.params.id + ' to invoice #' + newId);
    res.json({ invoiceId: newId, invoice: created });
  } catch (err) {
    console.error('Error converting estimate to invoice:', err);
    res.status(500).json({ error: 'Failed to convert estimate to invoice.' });
  }
});

// GET /settings
app.get('/settings', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT settingKey, settingValue FROM settings');
    const obj = {};
    for (const r of rows) obj[r.settingKey] = r.settingValue;
    res.json(obj);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

// PUT /settings
app.put('/settings', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    for (const [key, value] of Object.entries(b)) {
      await db.query(
        'INSERT INTO settings (settingKey, settingValue, updatedAt) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE settingValue=?, updatedAt=NOW()',
        [key, String(value), String(value)]
      );
    }
    const [rows] = await db.query('SELECT settingKey, settingValue FROM settings');
    const obj = {};
    for (const r of rows) obj[r.settingKey] = r.settingValue;
    res.json(obj);
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ─── LINE ITEM TEMPLATE ENDPOINTS ───────────────────────────────────────────

// GET /line-item-templates
app.get('/line-item-templates', authenticate, async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM line_item_templates WHERE isActive = 1';
    const params = [];
    if (search) {
      sql += ' AND description LIKE ?';
      params.push(`%${search}%`);
    }
    sql += ' ORDER BY category ASC, sortOrder ASC, description ASC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching line item templates:', err);
    res.status(500).json({ error: 'Failed to fetch templates.' });
  }
});

// POST /line-item-templates
app.post('/line-item-templates', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    if (!b.description || !String(b.description).trim()) {
      return res.status(400).json({ error: 'description is required' });
    }
    const [r] = await db.query(
      'INSERT INTO line_item_templates (description, defaultQuantity, defaultAmount, category) VALUES (?,?,?,?)',
      [String(b.description).trim(), b.defaultQuantity ?? 1, b.defaultAmount ?? null, b.category ? String(b.category).trim() : null]
    );
    const [[created]] = await db.query('SELECT * FROM line_item_templates WHERE id = ?', [r.insertId]);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error creating line item template:', err);
    res.status(500).json({ error: 'Failed to create template.' });
  }
});

// PUT /line-item-templates/:id
app.put('/line-item-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const sets = [], params = [];
    for (const f of ['description', 'defaultQuantity', 'defaultAmount', 'category', 'sortOrder']) {
      if (b[f] !== undefined) { sets.push(`${f}=?`); params.push(b[f]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    params.push(req.params.id);
    await db.query(`UPDATE line_item_templates SET ${sets.join(',')} WHERE id=?`, params);
    const [[updated]] = await db.query('SELECT * FROM line_item_templates WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating line item template:', err);
    res.status(500).json({ error: 'Failed to update template.' });
  }
});

// DELETE /line-item-templates/:id (soft delete)
app.delete('/line-item-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    await db.query('UPDATE line_item_templates SET isActive = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting line item template:', err);
    res.status(500).json({ error: 'Failed to delete template.' });
  }
});

// ─── PDF TEMPLATE ENDPOINTS ─────────────────────────────────────────────────

// GET /pdf-templates
app.get('/pdf-templates', authenticate, async (req, res) => {
  try {
    const { type } = req.query;
    let sql = 'SELECT * FROM pdf_templates WHERE isActive = 1';
    const params = [];
    if (type) {
      sql += " AND type IN (?, 'both')";
      params.push(type);
    }
    sql += ' ORDER BY isDefault DESC, name ASC';
    const [rows] = await db.query(sql, params);

    // If a specific type was requested, mark which template is the effective default
    // Priority: type-specific default > "both" default
    if (type) {
      const typeSpecificDefault = rows.find(r => r.isDefault === 1 && r.type === type);
      const bothDefault = rows.find(r => r.isDefault === 1 && r.type === 'both');
      const effectiveDefaultId = typeSpecificDefault?.id || bothDefault?.id || null;
      for (const r of rows) {
        r.isEffectiveDefault = r.id === effectiveDefaultId ? 1 : 0;
      }
    }

    res.json(rows);
  } catch (err) {
    console.error('Error fetching pdf templates:', err);
    res.status(500).json({ error: 'Failed to fetch PDF templates.' });
  }
});

// GET /pdf-templates/debug — diagnostic endpoint (temporarily public for diagnosis)
app.get('/pdf-templates/debug', async (req, res) => {
  try {
    const [templates] = await db.query(
      'SELECT id, name, type, isDefault, isActive, LENGTH(config) as config_length, config FROM pdf_templates'
    );
    const [recentEstimates] = await db.query(
      'SELECT id, templateId FROM estimates ORDER BY id DESC LIMIT 5'
    );
    const [recentInvoices] = await db.query(
      'SELECT id, templateId FROM invoices ORDER BY id DESC LIMIT 5'
    );
    // Also show the estimates table columns to verify templateId exists
    const [estColumns] = await db.query("SHOW COLUMNS FROM estimates LIKE '%template%'");
    res.json({ templates, recentEstimates, recentInvoices, estimateColumns: estColumns });
  } catch (err) {
    console.error('Error in pdf-templates debug:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /pdf-templates/:id
app.get('/pdf-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[tpl]] = await db.query('SELECT * FROM pdf_templates WHERE id = ? AND isActive = 1', [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'Template not found.' });
    res.json(tpl);
  } catch (err) {
    console.error('Error fetching pdf template:', err);
    res.status(500).json({ error: 'Failed to fetch PDF template.' });
  }
});

// POST /pdf-templates
app.post('/pdf-templates', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    if (!b.name?.trim()) return res.status(400).json({ error: 'name is required' });
    const configStr = typeof b.config === 'string' ? b.config : JSON.stringify(b.config || DEFAULT_TEMPLATE_CONFIG);
    console.log('[PDF Templates] Creating template — name:', b.name, 'type:', b.type, 'config length:', configStr.length);
    const [r] = await db.query(
      'INSERT INTO pdf_templates (name, type, config, isDefault) VALUES (?, ?, ?, 0)',
      [b.name.trim(), b.type || 'both', configStr]
    );
    const [[created]] = await db.query('SELECT * FROM pdf_templates WHERE id = ?', [r.insertId]);
    console.log('[PDF Templates] Created template id:', created.id);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error creating pdf template:', err);
    res.status(500).json({ error: 'Failed to create PDF template.' });
  }
});

// PUT /pdf-templates/:id
app.put('/pdf-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const sets = [], params = [];
    if (b.name !== undefined) { sets.push('name=?'); params.push(b.name); }
    if (b.type !== undefined) { sets.push('type=?'); params.push(b.type); }
    if (b.config !== undefined) {
      const configStr = typeof b.config === 'string' ? b.config : JSON.stringify(b.config);
      console.log('[PDF Templates] PUT /pdf-templates/' + req.params.id + ' — config length:', configStr.length);
      // Parse to verify it's valid JSON and log key info
      try {
        const parsed = JSON.parse(configStr);
        console.log('[PDF Templates] Config companyInfo.name:', parsed.companyInfo?.name || '(not set)');
        console.log('[PDF Templates] Config lineItems.displayMode:', parsed.lineItems?.displayMode || '(not set)');
      } catch (pe) { console.warn('[PDF Templates] Config is not valid JSON:', pe.message); }
      sets.push('config=?'); params.push(configStr);
    }
    if (b.isDefault !== undefined) {
      sets.push('isDefault=?'); params.push(b.isDefault ? 1 : 0);
      if (b.isDefault) {
        // Get this template's type to scope the default clearing
        const [[thisTpl]] = await db.query('SELECT type FROM pdf_templates WHERE id = ?', [req.params.id]);
        const tplType = thisTpl?.type || 'both';
        // Only clear defaults of the same type
        await db.query('UPDATE pdf_templates SET isDefault = 0 WHERE type = ? AND id != ?', [tplType, req.params.id]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    params.push(req.params.id);
    await db.query(`UPDATE pdf_templates SET ${sets.join(', ')} WHERE id = ?`, params);
    const [[updated]] = await db.query('SELECT * FROM pdf_templates WHERE id = ?', [req.params.id]);
    console.log('[PDF Templates] Updated template id:', req.params.id, '— stored config length:', (updated.config || '').length);
    res.json(updated);
  } catch (err) {
    console.error('Error updating pdf template:', err);
    res.status(500).json({ error: 'Failed to update PDF template.' });
  }
});

// DELETE /pdf-templates/:id (soft delete)
app.delete('/pdf-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[tpl]] = await db.query('SELECT isDefault FROM pdf_templates WHERE id = ?', [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'Template not found.' });
    if (tpl.isDefault) return res.status(400).json({ error: 'Cannot delete the default template.' });
    await db.query('UPDATE pdf_templates SET isActive = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting pdf template:', err);
    res.status(500).json({ error: 'Failed to delete PDF template.' });
  }
});

// POST /pdf-templates/:id/duplicate
app.post('/pdf-templates/:id/duplicate', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[orig]] = await db.query('SELECT * FROM pdf_templates WHERE id = ? AND isActive = 1', [req.params.id]);
    if (!orig) return res.status(404).json({ error: 'Template not found.' });
    const [r] = await db.query(
      'INSERT INTO pdf_templates (name, type, config, isDefault) VALUES (?, ?, ?, 0)',
      [orig.name + ' (Copy)', orig.type, orig.config]
    );
    const [[created]] = await db.query('SELECT * FROM pdf_templates WHERE id = ?', [r.insertId]);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error duplicating pdf template:', err);
    res.status(500).json({ error: 'Failed to duplicate PDF template.' });
  }
});

// POST /pdf-templates/preview — generate sample PDF with given config
app.post('/pdf-templates/preview', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    let config = DEFAULT_TEMPLATE_CONFIG;
    if (b.config) {
      const parsed = typeof b.config === 'string' ? JSON.parse(b.config) : b.config;
      config = deepMerge(DEFAULT_TEMPLATE_CONFIG, parsed);
    }
    const previewType = b.previewType || 'estimate';

    const sampleData = {
      companyName: 'SAMPLE CUSTOMER INC.',
      custName: 'John Smith',
      custPhone: '555-123-4567',
      custFax: '555-123-4568',
      custEmail: 'john@sample.com',
      billingAddress: '123 Main Street',
      billingCity: 'Chicago',
      billingState: 'IL',
      billingZip: '60601',
      projectName: 'OFFICE RENOVATION',
      projectAddress: '456 Oak Avenue',
      projectCity: 'Chicago',
      projectState: 'IL',
      projectZip: '60602',
      shipToAddress: '456 Oak Avenue',
      shipToCity: 'Chicago',
      shipToState: 'IL',
      shipToZip: '60602',
      poNumber: 'PO-12345',
      issueDate: new Date(),
      invoiceNumber: 'INV-1001',
      terms: 'Net 30. All prices valid for 30 days.',
      total: 2150.00,
      subtotal: 2150.00,
      taxRate: 0,
      taxAmount: 0
    };
    const sampleLineItems = [
      { quantity: 1, description: 'INITIAL SERVICE CALL', amount: 150.00 },
      { quantity: 2, description: 'TEMPERED GLASS PANEL 48" X 72"', amount: 850.00 },
      { quantity: 4, description: 'LABOR - INSTALLATION', amount: 300.00 },
    ];

    const pdfBuffer = await generatePdfWithConfig(sampleData, sampleLineItems, config, previewType);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="template-preview.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating template preview:', err);
    res.status(500).json({ error: 'Failed to generate preview.' });
  }
});

// GET /assets/logo — serve the company logo (black/white)
app.get('/assets/logo', (req, res) => {
  const logoPath = path.resolve(__dirname, 'assets', 'logo.png');
  if (fs.existsSync(logoPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(logoPath);
  } else {
    res.status(404).json({ error: 'Logo not found' });
  }
});

// GET /assets/logo-green — serve the green company logo
app.get('/assets/logo-green', (req, res) => {
  const logoPath = path.resolve(__dirname, 'assets', 'logo-green.png');
  if (fs.existsSync(logoPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(logoPath);
  } else {
    res.status(404).json({ error: 'Logo not found' });
  }
});

// ─── EMAIL SETTINGS ENDPOINTS ───────────────────────────────────────────────

// GET /email-settings
app.get('/email-settings', authenticate, async (req, res) => {
  try {
    const [[settings]] = await db.query('SELECT * FROM email_settings WHERE id = 1');
    if (settings) {
      if (settings.senderPassword) settings.senderPassword = '••••••••';
      if (settings.stripeSecretKey) settings.stripeSecretKey = '••••••••';
      if (settings.stripeWebhookSecret) settings.stripeWebhookSecret = '••••••••';
    }
    res.json(settings || {});
  } catch (err) {
    console.error('Error fetching email settings:', err);
    res.status(500).json({ error: 'Failed to fetch email settings.' });
  }
});

// PUT /email-settings
app.put('/email-settings', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    const fields = [];
    const params = [];
    if (b.smtpHost !== undefined)      { fields.push('smtpHost=?');      params.push(b.smtpHost); }
    if (b.smtpPort !== undefined)      { fields.push('smtpPort=?');      params.push(Number(b.smtpPort) || 465); }
    if (b.smtpSecure !== undefined)    { fields.push('smtpSecure=?');    params.push(b.smtpSecure ? 1 : 0); }
    if (b.senderEmail !== undefined)   { fields.push('senderEmail=?');   params.push(b.senderEmail); }
    if (b.senderPassword !== undefined && b.senderPassword !== '••••••••') {
      fields.push('senderPassword=?'); params.push(b.senderPassword);
    }
    if (b.senderName !== undefined)    { fields.push('senderName=?');    params.push(b.senderName); }
    if (b.replyTo !== undefined)       { fields.push('replyTo=?');       params.push(b.replyTo || null); }
    if (b.stripePublishableKey !== undefined) { fields.push('stripePublishableKey=?'); params.push(b.stripePublishableKey || null); }
    if (b.stripeSecretKey !== undefined && b.stripeSecretKey !== '••••••••') {
      fields.push('stripeSecretKey=?'); params.push(b.stripeSecretKey || null);
    }
    if (b.stripeWebhookSecret !== undefined && b.stripeWebhookSecret !== '••••••••') {
      fields.push('stripeWebhookSecret=?'); params.push(b.stripeWebhookSecret || null);
    }
    if (b.stripeEnabled !== undefined) { fields.push('stripeEnabled=?'); params.push(b.stripeEnabled ? 1 : 0); }
    if (b.appPublicUrl !== undefined)  { fields.push('appPublicUrl=?');  params.push(b.appPublicUrl || null); }

    if (fields.length === 0) return res.json({ message: 'No changes.' });
    await db.query(`UPDATE email_settings SET ${fields.join(', ')} WHERE id = 1`, params);
    res.json({ message: 'Email settings updated.' });
  } catch (err) {
    console.error('Error updating email settings:', err);
    res.status(500).json({ error: 'Failed to update email settings.' });
  }
});

// POST /email-settings/test
app.post('/email-settings/test', authenticate, async (req, res) => {
  try {
    const { transport, settings } = await createEmailTransport();
    await transport.sendMail({
      from: `"${settings.senderName || 'First Class Glass'}" <${settings.senderEmail}>`,
      to: settings.senderEmail,
      subject: 'Test Email from First Class Glass CRM',
      text: 'This is a test email to verify your SMTP settings are working correctly.\n\nIf you received this, your email configuration is set up properly!',
    });
    res.json({ message: 'Test email sent successfully!' });
  } catch (err) {
    console.error('Error sending test email:', err);
    res.status(500).json({ error: err.message || 'Failed to send test email.' });
  }
});

// ─── EMAIL TEMPLATE ENDPOINTS ──────────────────────────────────────────────

// GET /email-templates
app.get('/email-templates', authenticate, async (req, res) => {
  try {
    let sql = 'SELECT * FROM email_templates WHERE isActive = 1';
    const params = [];
    if (req.query.type) {
      sql += ' AND type = ?';
      params.push(req.query.type);
    }
    sql += ' ORDER BY type, isDefault DESC, name';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching email templates:', err);
    res.status(500).json({ error: 'Failed to fetch email templates.' });
  }
});

// GET /email-templates/:id
app.get('/email-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT * FROM email_templates WHERE id = ? AND isActive = 1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    res.json(row);
  } catch (err) {
    console.error('Error fetching email template:', err);
    res.status(500).json({ error: 'Failed to fetch email template.' });
  }
});

// POST /email-templates
app.post('/email-templates', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    if (!b.name || !b.type || !b.subject || !b.body) {
      return res.status(400).json({ error: 'name, type, subject, and body are required.' });
    }
    if (b.isDefault) {
      await db.query('UPDATE email_templates SET isDefault = 0 WHERE type = ? AND isActive = 1', [b.type]);
    }
    const [r] = await db.query(
      'INSERT INTO email_templates (name, type, subject, body, isDefault) VALUES (?, ?, ?, ?, ?)',
      [b.name, b.type, b.subject, b.body, b.isDefault ? 1 : 0]
    );
    const [[created]] = await db.query('SELECT * FROM email_templates WHERE id = ?', [r.insertId]);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error creating email template:', err);
    res.status(500).json({ error: 'Failed to create email template.' });
  }
});

// PUT /email-templates/:id
app.put('/email-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const fields = [];
    const params = [];
    if (b.name !== undefined)    { fields.push('name=?');    params.push(b.name); }
    if (b.type !== undefined)    { fields.push('type=?');    params.push(b.type); }
    if (b.subject !== undefined) { fields.push('subject=?'); params.push(b.subject); }
    if (b.body !== undefined)    { fields.push('body=?');    params.push(b.body); }
    if (b.isDefault !== undefined) {
      fields.push('isDefault=?'); params.push(b.isDefault ? 1 : 0);
      if (b.isDefault) {
        const type = b.type || (await db.query('SELECT type FROM email_templates WHERE id = ?', [req.params.id]))?.[0]?.[0]?.type;
        if (type) await db.query('UPDATE email_templates SET isDefault = 0 WHERE type = ? AND id != ? AND isActive = 1', [type, req.params.id]);
      }
    }
    if (fields.length === 0) return res.json({ message: 'No changes.' });
    params.push(req.params.id);
    await db.query(`UPDATE email_templates SET ${fields.join(', ')} WHERE id = ?`, params);
    const [[updated]] = await db.query('SELECT * FROM email_templates WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating email template:', err);
    res.status(500).json({ error: 'Failed to update email template.' });
  }
});

// DELETE /email-templates/:id
app.delete('/email-templates/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    await db.query('UPDATE email_templates SET isActive = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Template deleted.' });
  } catch (err) {
    console.error('Error deleting email template:', err);
    res.status(500).json({ error: 'Failed to delete email template.' });
  }
});

// ─── EMAIL SEND ENDPOINTS ──────────────────────────────────────────────────

// Helper: resolve a pdfPath to a local file buffer for attachment
async function resolvePdfAttachment(pdfPath) {
  const localPath = path.resolve(__dirname, pdfPath);
  if (fs.existsSync(localPath)) {
    return { buffer: fs.readFileSync(localPath), filename: path.basename(localPath) };
  }
  // Try S3
  if (S3_BUCKET) {
    try {
      const obj = await s3.getObject({ Bucket: S3_BUCKET, Key: pdfPath }).promise();
      return { buffer: obj.Body, filename: path.basename(pdfPath) };
    } catch (e) {
      // Try with uploads/ prefix
      const key2 = `uploads/${path.basename(pdfPath)}`;
      const obj = await s3.getObject({ Bucket: S3_BUCKET, Key: key2 }).promise();
      return { buffer: obj.Body, filename: path.basename(pdfPath) };
    }
  }
  throw new Error('PDF file not found locally or in S3');
}

// POST /email/send-estimate/:estimateId
app.post('/email/send-estimate/:estimateId', authenticate, requireNumericParam('estimateId'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const estimateId = Number(req.params.estimateId);

    // Load estimate + customer
    const [[est]] = await db.query(`
      SELECT e.*, c.companyName, c.name AS custName, c.phone AS custPhone, c.email AS custEmail
      FROM estimates e LEFT JOIN customers c ON e.customerId = c.id
      WHERE e.id = ?
    `, [estimateId]);
    if (!est) return res.status(404).json({ error: 'Estimate not found.' });

    const recipientEmail = b.recipientEmail || est.custEmail;
    if (!recipientEmail) return res.status(400).json({ error: 'Recipient email is required.' });

    // Save email to customer if requested
    if (b.saveEmail && b.recipientEmail && est.customerId) {
      await db.query('UPDATE customers SET email = ? WHERE id = ?', [b.recipientEmail, est.customerId]);
    }

    // Generate PDF if needed
    let pdfPath = est.pdfPath;
    if (!pdfPath) {
      const pdfBuffer = await generateEstimatePdf(estimateId);
      const filename = `estimate_${estimateId}_${Date.now()}.pdf`;
      const localDir = path.resolve(__dirname, 'uploads');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, filename);
      fs.writeFileSync(localPath, pdfBuffer);
      pdfPath = `uploads/${filename}`;
      await db.query('UPDATE estimates SET pdfPath=?, updatedAt=NOW() WHERE id=?', [pdfPath, estimateId]);
      await uploadToS3IfConfigured(localPath, pdfPath);
    }

    // Resolve PDF for attachment
    const attachment = await resolvePdfAttachment(pdfPath);

    // Generate public review token — delete any existing unused tokens first to prevent duplicates
    const pubToken = generatePublicToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.query(
      "DELETE FROM public_tokens WHERE estimateId = ? AND type = 'estimate_review' AND usedAt IS NULL",
      [estimateId]
    );
    await db.query(
      'INSERT INTO public_tokens (token, type, estimateId, recipientEmail, expiresAt) VALUES (?, ?, ?, ?, ?)',
      [pubToken, 'estimate_review', estimateId, recipientEmail, expiresAt]
    );
    await db.query('UPDATE estimates SET publicToken=?, tokenExpiresAt=? WHERE id=?', [pubToken, expiresAt, estimateId]);

    const appUrl = await getAppPublicUrl(req);
    const reviewUrl = appUrl ? `${appUrl}/public/estimate/${pubToken}` : '';
    console.log('[Email] Estimate review URL:', reviewUrl || '(empty — no appUrl)', '| appUrl:', appUrl || '(empty)');
    est.estimateLink = reviewUrl;

    // Get subject/body from request (already merged by frontend) or merge now
    let subject = b.subject;
    let body = b.body;
    if (!subject || !body) {
      const [[tmpl]] = b.templateId
        ? await db.query('SELECT * FROM email_templates WHERE id = ?', [b.templateId])
        : await db.query("SELECT * FROM email_templates WHERE type = 'estimate' AND isDefault = 1 AND isActive = 1 LIMIT 1");
      if (tmpl) {
        subject = subject || mergeEmailFields(tmpl.subject, est);
        body = body || mergeEmailFields(tmpl.body, est);
      } else {
        subject = subject || 'Estimate from First Class Glass & Mirror, Inc.';
        body = body || 'Please find attached the estimate.';
      }
    }

    // Build branded HTML email with green header
    const logoUrl = appUrl ? `${appUrl}/assets/logo-green` : '';
    let htmlBody = `
      <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="background:white;padding:30px 20px;text-align:center;border-bottom:3px solid #1b5e20;border-radius:12px 12px 0 0">
          ${logoUrl ? `<img src="${logoUrl}" alt="First Class Glass" style="height:100px;margin-bottom:16px" onerror="this.style.display='none'">` : ''}
          <div style="color:#1b5e20;font-size:20px;font-weight:700;letter-spacing:2px;text-transform:uppercase">ESTIMATE</div>
        </div>
        <div style="background:white;padding:30px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px">
          ${body.replace(/\n/g, '<br>')}
    `;
    if (reviewUrl) {
      htmlBody += `
          <div style="text-align:center;margin:24px 0">
            <a href="${reviewUrl}" style="display:inline-block;padding:14px 40px;background:#1b5e20;color:white;text-decoration:none;border-radius:8px;font-size:16px;font-weight:600">
              View &amp; Respond to Estimate
            </a>
          </div>
          <p style="text-align:center;font-size:12px;color:#999">Or copy this link: ${reviewUrl}</p>
      `;
    }
    htmlBody += `
        </div>
        <div style="text-align:center;padding:16px;color:#999;font-size:11px">
          First Class Glass &amp; Mirror, Inc. | 1513 Industrial Drive, Itasca, IL 60143 | 630-250-9777
        </div>
      </div>
    `;

    // Send email
    const { transport, settings } = await createEmailTransport();
    await transport.sendMail({
      from: `"${settings.senderName || 'First Class Glass'}" <${settings.senderEmail}>`,
      replyTo: settings.replyTo || settings.senderEmail,
      to: recipientEmail,
      subject,
      text: body + (reviewUrl ? `\n\nView & respond to this estimate: ${reviewUrl}` : ''),
      html: htmlBody,
      attachments: [{
        filename: attachment.filename,
        content: attachment.buffer,
        contentType: 'application/pdf',
      }],
    });

    // Log
    await db.query(
      'INSERT INTO email_log (templateId, estimateId, recipientEmail, recipientName, subject, body, attachmentPath, status, sentBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [b.templateId || null, estimateId, recipientEmail, b.recipientName || est.companyName || est.custName || null, subject, body, pdfPath, 'sent', req.user?.username || null]
    );

    // Update status
    await db.query("UPDATE estimates SET status='Sent', sentAt=NOW(), updatedAt=NOW() WHERE id=?", [estimateId]);

    res.json({ message: 'Email sent successfully!' });
  } catch (err) {
    console.error('Error sending estimate email:', err);
    // Log the failure
    try {
      const b = coerceBody(req);
      await db.query(
        'INSERT INTO email_log (estimateId, recipientEmail, subject, status, errorMessage, sentBy) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.estimateId, b.recipientEmail || '', b.subject || '', 'failed', err.message, req.user?.username || null]
      );
    } catch (logErr) { /* ignore */ }
    res.status(500).json({ error: err.message || 'Failed to send email.' });
  }
});

// POST /email/send-invoice/:invoiceId
app.post('/email/send-invoice/:invoiceId', authenticate, requireNumericParam('invoiceId'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const invoiceId = Number(req.params.invoiceId);

    const [[inv]] = await db.query(`
      SELECT i.*, c.companyName, c.name AS custName, c.phone AS custPhone, c.email AS custEmail
      FROM invoices i LEFT JOIN customers c ON i.customerId = c.id
      WHERE i.id = ?
    `, [invoiceId]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

    const recipientEmail = b.recipientEmail || inv.custEmail;
    if (!recipientEmail) return res.status(400).json({ error: 'Recipient email is required.' });

    if (b.saveEmail && b.recipientEmail && inv.customerId) {
      await db.query('UPDATE customers SET email = ? WHERE id = ?', [b.recipientEmail, inv.customerId]);
    }

    let pdfPath = inv.pdfPath;
    if (!pdfPath) {
      const pdfBuffer = await generateInvoicePdf(invoiceId);
      const filename = `invoice_${invoiceId}_${Date.now()}.pdf`;
      const localDir = path.resolve(__dirname, 'uploads');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, filename);
      fs.writeFileSync(localPath, pdfBuffer);
      pdfPath = `uploads/${filename}`;
      await db.query('UPDATE invoices SET pdfPath=?, updatedAt=NOW() WHERE id=?', [pdfPath, invoiceId]);
      await uploadToS3IfConfigured(localPath, pdfPath);
    }

    const attachment = await resolvePdfAttachment(pdfPath);

    // Generate public payment token
    const pubToken = generatePublicToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.query(
      'INSERT INTO public_tokens (token, type, invoiceId, recipientEmail, expiresAt) VALUES (?, ?, ?, ?, ?)',
      [pubToken, 'invoice_payment', invoiceId, recipientEmail, expiresAt]
    );
    await db.query('UPDATE invoices SET publicToken=?, tokenExpiresAt=? WHERE id=?', [pubToken, expiresAt, invoiceId]);

    const appUrl = await getAppPublicUrl(req);
    const paymentUrl = appUrl ? `${appUrl}/public/invoice/${pubToken}` : '';
    inv.paymentLink = paymentUrl;

    // Calculate daysOverdue for merge
    if (inv.dueDate) {
      const due = new Date(inv.dueDate);
      const now = new Date();
      const diff = Math.floor((now - due) / (1000 * 60 * 60 * 24));
      inv.daysOverdue = diff > 0 ? String(diff) : '0';
    }

    let subject = b.subject;
    let body = b.body;
    if (!subject || !body) {
      const [[tmpl]] = b.templateId
        ? await db.query('SELECT * FROM email_templates WHERE id = ?', [b.templateId])
        : await db.query("SELECT * FROM email_templates WHERE type = 'invoice' AND isDefault = 1 AND isActive = 1 LIMIT 1");
      if (tmpl) {
        subject = subject || mergeEmailFields(tmpl.subject, inv);
        body = body || mergeEmailFields(tmpl.body, inv);
      } else {
        subject = subject || `Invoice #${inv.invoiceNumber} from First Class Glass & Mirror, Inc.`;
        body = body || 'Please find attached the invoice.';
      }
    }

    // Build branded HTML email with green header
    const invoiceLogoUrl = appUrl ? `${appUrl}/assets/logo-green` : '';
    let htmlBody = `
      <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="background:white;padding:30px 20px;text-align:center;border-bottom:3px solid #1b5e20;border-radius:12px 12px 0 0">
          ${invoiceLogoUrl ? `<img src="${invoiceLogoUrl}" alt="First Class Glass" style="height:100px;margin-bottom:16px" onerror="this.style.display='none'">` : ''}
          <div style="color:#1b5e20;font-size:20px;font-weight:700;letter-spacing:2px;text-transform:uppercase">INVOICE #${escHtml(inv.invoiceNumber)}</div>
        </div>
        <div style="background:white;padding:30px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px">
          ${body.replace(/\n/g, '<br>')}
    `;
    if (paymentUrl) {
      htmlBody += `
          <div style="text-align:center;margin:24px 0">
            <a href="${paymentUrl}" style="display:inline-block;padding:14px 40px;background:#1b5e20;color:white;text-decoration:none;border-radius:8px;font-size:16px;font-weight:600">
              View Invoice
            </a>
          </div>
          <p style="text-align:center;font-size:12px;color:#999">Or copy this link: ${paymentUrl}</p>
      `;
    }
    // Close the branded email wrapper
    htmlBody += `
        </div>
        <div style="text-align:center;padding:16px;color:#999;font-size:11px">
          First Class Glass &amp; Mirror, Inc. | 1513 Industrial Drive, Itasca, IL 60143 | 630-250-9777
        </div>
      </div>
    `;

    const { transport, settings } = await createEmailTransport();
    await transport.sendMail({
      from: `"${settings.senderName || 'First Class Glass'}" <${settings.senderEmail}>`,
      replyTo: settings.replyTo || settings.senderEmail,
      to: recipientEmail,
      subject,
      text: body + (paymentUrl ? `\n\nView this invoice: ${paymentUrl}` : ''),
      html: htmlBody,
      attachments: [{
        filename: attachment.filename,
        content: attachment.buffer,
        contentType: 'application/pdf',
      }],
    });

    await db.query(
      'INSERT INTO email_log (templateId, invoiceId, recipientEmail, recipientName, subject, body, attachmentPath, status, sentBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [b.templateId || null, invoiceId, recipientEmail, b.recipientName || inv.companyName || inv.custName || null, subject, body, pdfPath, 'sent', req.user?.username || null]
    );

    await db.query("UPDATE invoices SET status='Sent', sentAt=NOW(), updatedAt=NOW() WHERE id=?", [invoiceId]);

    res.json({ message: 'Email sent successfully!' });
  } catch (err) {
    console.error('Error sending invoice email:', err);
    try {
      const b = coerceBody(req);
      await db.query(
        'INSERT INTO email_log (invoiceId, recipientEmail, subject, status, errorMessage, sentBy) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.invoiceId, b.recipientEmail || '', b.subject || '', 'failed', err.message, req.user?.username || null]
      );
    } catch (logErr) { /* ignore */ }
    res.status(500).json({ error: err.message || 'Failed to send email.' });
  }
});

// POST /email/send-reminder/:invoiceId
app.post('/email/send-reminder/:invoiceId', authenticate, requireNumericParam('invoiceId'), async (req, res) => {
  try {
    const b = coerceBody(req);
    const invoiceId = Number(req.params.invoiceId);

    const [[inv]] = await db.query(`
      SELECT i.*, c.companyName, c.name AS custName, c.phone AS custPhone, c.email AS custEmail
      FROM invoices i LEFT JOIN customers c ON i.customerId = c.id
      WHERE i.id = ?
    `, [invoiceId]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

    const recipientEmail = b.recipientEmail || inv.custEmail;
    if (!recipientEmail) return res.status(400).json({ error: 'Recipient email is required.' });

    if (b.saveEmail && b.recipientEmail && inv.customerId) {
      await db.query('UPDATE customers SET email = ? WHERE id = ?', [b.recipientEmail, inv.customerId]);
    }

    // Generate PDF if needed
    let pdfPath = inv.pdfPath;
    if (!pdfPath) {
      const pdfBuffer = await generateInvoicePdf(invoiceId);
      const filename = `invoice_${invoiceId}_${Date.now()}.pdf`;
      const localDir = path.resolve(__dirname, 'uploads');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, filename);
      fs.writeFileSync(localPath, pdfBuffer);
      pdfPath = `uploads/${filename}`;
      await db.query('UPDATE invoices SET pdfPath=?, updatedAt=NOW() WHERE id=?', [pdfPath, invoiceId]);
      await uploadToS3IfConfigured(localPath, pdfPath);
    }

    const attachment = await resolvePdfAttachment(pdfPath);

    // Calculate daysOverdue
    if (inv.dueDate) {
      const due = new Date(inv.dueDate);
      const now = new Date();
      const diff = Math.floor((now - due) / (1000 * 60 * 60 * 24));
      inv.daysOverdue = diff > 0 ? String(diff) : '0';
    }

    let subject = b.subject;
    let body = b.body;
    if (!subject || !body) {
      const [[tmpl]] = b.templateId
        ? await db.query('SELECT * FROM email_templates WHERE id = ?', [b.templateId])
        : await db.query("SELECT * FROM email_templates WHERE type = 'payment_reminder' AND isDefault = 1 AND isActive = 1 LIMIT 1");
      if (tmpl) {
        subject = subject || mergeEmailFields(tmpl.subject, inv);
        body = body || mergeEmailFields(tmpl.body, inv);
      } else {
        subject = subject || `Payment Reminder - Invoice #${inv.invoiceNumber}`;
        body = body || 'This is a reminder about your outstanding invoice.';
      }
    }

    // Build branded HTML email
    const reminderAppUrl = await getAppPublicUrl(req);
    const reminderLogoUrl = reminderAppUrl ? `${reminderAppUrl}/assets/logo-green` : '';
    const reminderHtml = `
      <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="background:white;padding:30px 20px;text-align:center;border-bottom:3px solid #1b5e20;border-radius:12px 12px 0 0">
          ${reminderLogoUrl ? `<img src="${reminderLogoUrl}" alt="First Class Glass" style="height:100px;margin-bottom:16px" onerror="this.style.display='none'">` : ''}
          <div style="color:#1b5e20;font-size:20px;font-weight:700;letter-spacing:2px;text-transform:uppercase">PAYMENT REMINDER</div>
        </div>
        <div style="background:white;padding:30px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px">
          ${body.replace(/\n/g, '<br>')}
        </div>
        <div style="text-align:center;padding:16px;color:#999;font-size:11px">
          First Class Glass &amp; Mirror, Inc. | 1513 Industrial Drive, Itasca, IL 60143 | 630-250-9777
        </div>
      </div>
    `;

    const { transport, settings } = await createEmailTransport();
    await transport.sendMail({
      from: `"${settings.senderName || 'First Class Glass'}" <${settings.senderEmail}>`,
      replyTo: settings.replyTo || settings.senderEmail,
      to: recipientEmail,
      subject,
      text: body,
      html: reminderHtml,
      attachments: [{
        filename: attachment.filename,
        content: attachment.buffer,
        contentType: 'application/pdf',
      }],
    });

    await db.query(
      'INSERT INTO email_log (templateId, invoiceId, recipientEmail, recipientName, subject, body, attachmentPath, status, sentBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [b.templateId || null, invoiceId, recipientEmail, b.recipientName || inv.companyName || inv.custName || null, subject, body, pdfPath, 'sent', req.user?.username || null]
    );

    // Don't change invoice status for reminders
    res.json({ message: 'Reminder sent successfully!' });
  } catch (err) {
    console.error('Error sending reminder email:', err);
    try {
      const b = coerceBody(req);
      await db.query(
        'INSERT INTO email_log (invoiceId, recipientEmail, subject, status, errorMessage, sentBy) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.invoiceId, b.recipientEmail || '', b.subject || '', 'failed', err.message, req.user?.username || null]
      );
    } catch (logErr) { /* ignore */ }
    res.status(500).json({ error: err.message || 'Failed to send reminder.' });
  }
});

// POST /email/preview
app.post('/email/preview', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    const { templateId, type, entityId } = b;

    let tmpl;
    if (templateId) {
      const [[t]] = await db.query('SELECT * FROM email_templates WHERE id = ? AND isActive = 1', [templateId]);
      tmpl = t;
    }
    if (!tmpl && type) {
      const [[t]] = await db.query('SELECT * FROM email_templates WHERE type = ? AND isDefault = 1 AND isActive = 1 LIMIT 1', [type]);
      tmpl = t;
    }
    if (!tmpl) return res.status(404).json({ error: 'No template found.' });

    let data = {};
    let recipientEmail = '';
    let recipientName = '';
    let attachmentName = '';

    if ((type === 'estimate' || tmpl.type === 'estimate') && entityId) {
      const [[est]] = await db.query(`
        SELECT e.*, c.companyName, c.name AS custName, c.email AS custEmail
        FROM estimates e LEFT JOIN customers c ON e.customerId = c.id WHERE e.id = ?
      `, [entityId]);
      if (est) {
        data = est;
        recipientEmail = est.custEmail || '';
        recipientName = est.companyName || est.custName || '';
        attachmentName = est.pdfPath ? path.basename(est.pdfPath) : `estimate_${entityId}.pdf`;
      }
    } else if (entityId) {
      const [[inv]] = await db.query(`
        SELECT i.*, c.companyName, c.name AS custName, c.email AS custEmail
        FROM invoices i LEFT JOIN customers c ON i.customerId = c.id WHERE i.id = ?
      `, [entityId]);
      if (inv) {
        if (inv.dueDate) {
          const diff = Math.floor((new Date() - new Date(inv.dueDate)) / (1000 * 60 * 60 * 24));
          inv.daysOverdue = diff > 0 ? String(diff) : '0';
        }
        data = inv;
        recipientEmail = inv.custEmail || '';
        recipientName = inv.companyName || inv.custName || '';
        attachmentName = inv.pdfPath ? path.basename(inv.pdfPath) : `invoice_${entityId}.pdf`;
      }
    }

    const subject = mergeEmailFields(tmpl.subject, data);
    const body = mergeEmailFields(tmpl.body, data);

    res.json({ subject, body, recipientEmail, recipientName, attachmentName, templateId: tmpl.id });
  } catch (err) {
    console.error('Error previewing email:', err);
    res.status(500).json({ error: 'Failed to generate preview.' });
  }
});

// GET /email-log
app.get('/email-log', authenticate, async (req, res) => {
  try {
    let sql = 'SELECT * FROM email_log WHERE 1=1';
    const params = [];
    if (req.query.estimateId) { sql += ' AND estimateId = ?'; params.push(Number(req.query.estimateId)); }
    if (req.query.invoiceId) { sql += ' AND invoiceId = ?'; params.push(Number(req.query.invoiceId)); }
    sql += ' ORDER BY sentAt DESC LIMIT 100';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching email log:', err);
    res.status(500).json({ error: 'Failed to fetch email log.' });
  }
});

// ─── REPORTS ENDPOINTS ──────────────────────────────────────────────────────

// GET /reports/dashboard — single call for Home page dashboard
app.get('/reports/dashboard', authenticate, async (req, res) => {
  try {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
    const prevYear = curMonth === 1 ? curYear - 1 : curYear;

    // Current month revenue (paid invoices)
    const [[cmRev]] = await db.query(
      "SELECT COALESCE(SUM(total), 0) AS rev FROM invoices WHERE status = 'Paid' AND YEAR(paidAt) = ? AND MONTH(paidAt) = ?",
      [curYear, curMonth]
    );
    const currentMonthRevenue = Number(cmRev.rev) || 0;

    // Last month revenue
    const [[lmRev]] = await db.query(
      "SELECT COALESCE(SUM(total), 0) AS rev FROM invoices WHERE status = 'Paid' AND YEAR(paidAt) = ? AND MONTH(paidAt) = ?",
      [prevYear, prevMonth]
    );
    const lastMonthRevenue = Number(lmRev.rev) || 0;

    // Revenue by month (last 6 months for sparkline)
    const [revByMonth] = await db.query(
      `SELECT DATE_FORMAT(paidAt, '%Y-%m') AS month, COALESCE(SUM(total), 0) AS revenue
       FROM invoices WHERE status = 'Paid' AND paidAt >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY month ORDER BY month`
    );
    const revenueByMonth = revByMonth.map(r => ({ month: r.month, revenue: Number(r.revenue) || 0 }));

    // Outstanding totals
    const [[outst]] = await db.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(balanceDue), 0) AS total FROM invoices WHERE balanceDue > 0 AND status NOT IN ('Void','Paid','Draft')"
    );
    const outstandingTotal = Number(outst.total) || 0;
    const unpaidCount = Number(outst.cnt) || 0;

    // Overdue
    const [[ovrd]] = await db.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(balanceDue), 0) AS total FROM invoices WHERE status IN ('Sent','Overdue') AND dueDate < CURDATE() AND balanceDue > 0"
    );
    const overdueCount = Number(ovrd.cnt) || 0;
    const overdueTotal = Number(ovrd.total) || 0;
    const hasOverdue = overdueCount > 0;

    // Overdue invoice list (max 10)
    const [overdueInvoices] = await db.query(
      `SELECT i.id, i.invoiceNumber, c.companyName AS customerName, i.total, i.balanceDue, i.dueDate
       FROM invoices i LEFT JOIN customers c ON c.id = i.customerId
       WHERE i.status IN ('Sent','Overdue') AND i.dueDate < CURDATE() AND i.balanceDue > 0
       ORDER BY i.dueDate ASC LIMIT 10`
    );

    // Estimates pipeline
    const [[estPipe]] = await db.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS val FROM estimates WHERE status = 'Sent'"
    );
    const estimatesPendingCount = Number(estPipe.cnt) || 0;
    const estimatesPendingValue = Number(estPipe.val) || 0;

    const [[estConv]] = await db.query(
      "SELECT COUNT(CASE WHEN status='Accepted' THEN 1 END) AS accepted, COUNT(CASE WHEN status='Declined' THEN 1 END) AS declined FROM estimates WHERE status IN ('Accepted','Declined')"
    );
    const accepted = Number(estConv.accepted) || 0;
    const declined = Number(estConv.declined) || 0;
    const estimatesConversionRate = (accepted + declined) > 0 ? Math.round((accepted / (accepted + declined)) * 1000) / 10 : 0;

    // Work orders
    const [[woActive]] = await db.query(
      "SELECT COUNT(*) AS cnt FROM work_orders WHERE status NOT IN ('Completed')"
    );
    const [[woWaiting]] = await db.query(
      "SELECT COUNT(*) AS cnt FROM work_orders WHERE status = 'Waiting on Parts'"
    );
    const dateCol = SCHEMA.createdAtCol || 'created_at';
    const [[woCompleted]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM work_orders WHERE status = 'Completed' AND YEAR(${dateCol}) = ? AND MONTH(${dateCol}) = ?`,
      [curYear, curMonth]
    );

    // Expiring estimates (within 7 days)
    const [expiringEstimates] = await db.query(
      `SELECT e.id, e.projectName, c.companyName AS customerName, e.total, e.expirationDate
       FROM estimates e LEFT JOIN customers c ON c.id = e.customerId
       WHERE e.status = 'Sent' AND e.expirationDate IS NOT NULL
       AND e.expirationDate BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
       ORDER BY e.expirationDate ASC`
    );

    // Monthly revenue (last 12 months for bar chart)
    const [monthlyRevenue] = await db.query(
      `SELECT DATE_FORMAT(paidAt, '%Y-%m') AS month, COALESCE(SUM(total), 0) AS revenue
       FROM invoices WHERE status = 'Paid' AND paidAt >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY month ORDER BY month`
    );
    const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthlyRevenueData = monthlyRevenue.map(r => {
      const [y, m] = r.month.split('-');
      return { month: r.month, label: monthLabels[parseInt(m, 10) - 1] + ' ' + y, revenue: Number(r.revenue) || 0 };
    });

    // Invoice status breakdown
    const [statusBreak] = await db.query(
      `SELECT
         CASE WHEN status IN ('Sent') AND dueDate < CURDATE() AND balanceDue > 0 THEN 'Overdue' ELSE status END AS displayStatus,
         COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM invoices GROUP BY displayStatus`
    );
    const invoiceStatusBreakdown = statusBreak.map(r => ({ status: r.displayStatus, count: Number(r.count), total: Number(r.total) || 0 }));

    // Recent invoices
    const [recentInvoices] = await db.query(
      `SELECT i.id, i.invoiceNumber, c.companyName AS customerName, i.total, i.balanceDue, i.status, i.issueDate, i.dueDate
       FROM invoices i LEFT JOIN customers c ON c.id = i.customerId
       ORDER BY i.updatedAt DESC LIMIT 5`
    );

    // Recent estimates
    const [recentEstimates] = await db.query(
      `SELECT e.id, e.projectName, c.companyName AS customerName, e.total, e.status, e.issueDate
       FROM estimates e LEFT JOIN customers c ON c.id = e.customerId
       ORDER BY e.updatedAt DESC LIMIT 5`
    );

    res.json({
      currentMonthRevenue, lastMonthRevenue, revenueByMonth,
      outstandingTotal, unpaidCount, hasOverdue, overdueCount, overdueTotal, overdueInvoices,
      estimatesPendingCount, estimatesPendingValue, estimatesConversionRate,
      activeWorkOrders: Number(woActive.cnt) || 0,
      waitingOnParts: Number(woWaiting.cnt) || 0,
      completedThisMonth: Number(woCompleted.cnt) || 0,
      expiringEstimates,
      monthlyRevenue: monthlyRevenueData,
      invoiceStatusBreakdown,
      recentInvoices, recentEstimates,
    });
  } catch (err) {
    console.error('Error fetching dashboard:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
});

// GET /reports/revenue — monthly revenue breakdown for date range
app.get('/reports/revenue', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let where = '1=1';
    if (from) { where += ' AND i.issueDate >= ?'; params.push(from); }
    if (to) { where += ' AND i.issueDate <= ?'; params.push(to); }

    const [rows] = await db.query(
      `SELECT DATE_FORMAT(i.issueDate, '%Y-%m') AS month,
        COUNT(*) AS totalInvoices,
        COUNT(CASE WHEN i.status IN ('Sent','Overdue') THEN 1 END) AS invoicesSent,
        COUNT(CASE WHEN i.status = 'Paid' THEN 1 END) AS invoicesPaid,
        COALESCE(SUM(CASE WHEN i.status = 'Paid' THEN i.total ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN i.status NOT IN ('Paid','Void','Draft') THEN i.balanceDue ELSE 0 END), 0) AS outstanding
       FROM invoices i WHERE ${where}
       GROUP BY DATE_FORMAT(i.issueDate, '%Y-%m')
       ORDER BY month`, params
    );

    const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const months = rows.map(r => {
      const rev = Number(r.revenue) || 0;
      const out = Number(r.outstanding) || 0;
      const [y, m] = r.month.split('-');
      return {
        month: r.month,
        label: monthLabels[parseInt(m, 10) - 1] + ' ' + y,
        totalInvoices: Number(r.totalInvoices) || 0,
        invoicesSent: Number(r.invoicesSent) || 0,
        invoicesPaid: Number(r.invoicesPaid) || 0,
        revenue: rev,
        outstanding: out,
        collectionRate: (rev + out) > 0 ? Math.round((rev / (rev + out)) * 1000) / 10 : 0,
      };
    });

    const totals = months.reduce((acc, m) => {
      acc.totalInvoices += m.totalInvoices;
      acc.invoicesSent += m.invoicesSent;
      acc.invoicesPaid += m.invoicesPaid;
      acc.revenue += m.revenue;
      acc.outstanding += m.outstanding;
      return acc;
    }, { totalInvoices: 0, invoicesSent: 0, invoicesPaid: 0, revenue: 0, outstanding: 0 });
    totals.collectionRate = (totals.revenue + totals.outstanding) > 0
      ? Math.round((totals.revenue / (totals.revenue + totals.outstanding)) * 1000) / 10 : 0;

    res.json({ months, totals });
  } catch (err) {
    console.error('Error fetching revenue report:', err);
    res.status(500).json({ error: 'Failed to fetch revenue report.' });
  }
});

// GET /reports/aging — accounts receivable aging
app.get('/reports/aging', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT i.id, i.invoiceNumber, c.companyName AS customerName,
        i.issueDate, i.dueDate, i.total, i.balanceDue,
        DATEDIFF(CURDATE(), i.dueDate) AS daysOverdue
       FROM invoices i LEFT JOIN customers c ON c.id = i.customerId
       WHERE i.balanceDue > 0 AND i.status NOT IN ('Void','Draft','Paid')
       ORDER BY i.dueDate ASC`
    );

    const buckets = [
      { label: 'Current', min: -999999, max: 0, count: 0, total: 0, invoices: [] },
      { label: '1-30 Days', min: 1, max: 30, count: 0, total: 0, invoices: [] },
      { label: '31-60 Days', min: 31, max: 60, count: 0, total: 0, invoices: [] },
      { label: '61-90 Days', min: 61, max: 90, count: 0, total: 0, invoices: [] },
      { label: '90+ Days', min: 91, max: 999999, count: 0, total: 0, invoices: [] },
    ];

    for (const inv of rows) {
      const days = Number(inv.daysOverdue) || 0;
      const bal = Number(inv.balanceDue) || 0;
      for (const b of buckets) {
        if (days >= b.min && days <= b.max) {
          b.count++;
          b.total += bal;
          b.invoices.push({
            id: inv.id, invoiceNumber: inv.invoiceNumber, customerName: inv.customerName,
            issueDate: inv.issueDate, dueDate: inv.dueDate, total: Number(inv.total) || 0, balanceDue: bal,
            daysOverdue: days
          });
          break;
        }
      }
    }

    // Clean up min/max from response
    const result = buckets.map(({ min, max, ...rest }) => rest);
    res.json({ buckets: result, totalOutstanding: rows.reduce((s, r) => s + (Number(r.balanceDue) || 0), 0) });
  } catch (err) {
    console.error('Error fetching aging report:', err);
    res.status(500).json({ error: 'Failed to fetch aging report.' });
  }
});

// GET /reports/customers — customer revenue breakdown
app.get('/reports/customers', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let invoiceDateFilter = '';
    if (from && to) {
      invoiceDateFilter = 'AND i.issueDate BETWEEN ? AND ?';
      params.push(from, to);
    } else if (from) {
      invoiceDateFilter = 'AND i.issueDate >= ?';
      params.push(from);
    } else if (to) {
      invoiceDateFilter = 'AND i.issueDate <= ?';
      params.push(to);
    }

    const [rows] = await db.query(
      `SELECT c.id, c.companyName AS customerName,
        COUNT(DISTINCT i.id) AS invoiceCount,
        COALESCE(SUM(i.total), 0) AS totalInvoiced,
        COALESCE(SUM(i.amountPaid), 0) AS totalPaid,
        COALESCE(SUM(i.balanceDue), 0) AS outstanding,
        (SELECT COUNT(*) FROM work_orders wo WHERE wo.customerId = c.id) AS workOrderCount
       FROM customers c
       LEFT JOIN invoices i ON i.customerId = c.id ${invoiceDateFilter}
       WHERE c.isActive = 1
       GROUP BY c.id
       HAVING invoiceCount > 0
       ORDER BY totalInvoiced DESC`, params
    );

    const customers = rows.map(r => ({
      id: r.id, customerName: r.customerName,
      invoiceCount: Number(r.invoiceCount) || 0,
      totalInvoiced: Number(r.totalInvoiced) || 0,
      totalPaid: Number(r.totalPaid) || 0,
      outstanding: Number(r.outstanding) || 0,
      workOrderCount: Number(r.workOrderCount) || 0,
    }));

    res.json({ customers });
  } catch (err) {
    console.error('Error fetching customer report:', err);
    res.status(500).json({ error: 'Failed to fetch customer report.' });
  }
});

// GET /reports/estimates — estimate statistics
app.get('/reports/estimates', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let where = '1=1';
    if (from) { where += ' AND e.issueDate >= ?'; params.push(from); }
    if (to) { where += ' AND e.issueDate <= ?'; params.push(to); }

    const [rows] = await db.query(
      `SELECT e.id, e.projectName, c.companyName AS customerName, e.total, e.status, e.issueDate,
        e.acceptedAt, e.declinedAt, e.sentAt
       FROM estimates e LEFT JOIN customers c ON c.id = e.customerId
       WHERE ${where}
       ORDER BY e.issueDate DESC`, params
    );

    const totalCount = rows.length;
    const totalValue = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const byStatus = {};
    for (const r of rows) {
      const st = r.status || 'Draft';
      if (!byStatus[st]) byStatus[st] = { status: st, count: 0, value: 0 };
      byStatus[st].count++;
      byStatus[st].value += Number(r.total) || 0;
    }

    const accepted = (byStatus['Accepted'] || {}).count || 0;
    const declined = (byStatus['Declined'] || {}).count || 0;
    const conversionRate = (accepted + declined) > 0 ? Math.round((accepted / (accepted + declined)) * 1000) / 10 : 0;
    const avgValue = totalCount > 0 ? Math.round(totalValue / totalCount * 100) / 100 : 0;

    res.json({
      totalCount, totalValue, avgValue, conversionRate,
      byStatus: Object.values(byStatus),
      estimates: rows.map(r => ({
        id: r.id, projectName: r.projectName, customerName: r.customerName,
        total: Number(r.total) || 0, status: r.status || 'Draft', issueDate: r.issueDate,
      })),
    });
  } catch (err) {
    console.error('Error fetching estimates report:', err);
    res.status(500).json({ error: 'Failed to fetch estimates report.' });
  }
});

// GET /reports/work-orders — work order statistics
app.get('/reports/work-orders', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let where = '1=1';
    if (from) { where += ' AND COALESCE(wo.createdAt, wo.created_at) >= ?'; params.push(from); }
    if (to) { where += ' AND COALESCE(wo.createdAt, wo.created_at) <= ?'; params.push(to); }

    const [rows] = await db.query(
      `SELECT wo.status, COUNT(*) AS cnt FROM work_orders wo WHERE ${where} GROUP BY wo.status`, params
    );

    const totalCount = rows.reduce((s, r) => s + (Number(r.cnt) || 0), 0);
    const byStatus = rows.map(r => ({ status: r.status || 'Unknown', count: Number(r.cnt) || 0 }));
    const completedCount = byStatus.find(b => b.status === 'Completed')?.count || 0;

    // Average completion days for completed work orders
    const completedParams = [...params];
    const [[avgRow]] = await db.query(
      `SELECT AVG(DATEDIFF(COALESCE(wo.updatedAt, wo.createdAt, wo.created_at), COALESCE(wo.createdAt, wo.created_at))) AS avgDays
       FROM work_orders wo WHERE wo.status = 'Completed' AND ${where}`, completedParams
    );
    const avgCompletionDays = Math.round(Number(avgRow?.avgDays) || 0);

    // PO counts
    const [[withPOsRow]] = await db.query(
      `SELECT COUNT(DISTINCT wop.workOrderId) AS cnt FROM work_order_pos wop
       JOIN work_orders wo ON wo.id = wop.workOrderId WHERE ${where}`, params
    );
    const withPOs = Number(withPOsRow?.cnt) || 0;
    const withoutPOs = totalCount - withPOs;

    res.json({ totalCount, byStatus, completedCount, avgCompletionDays, withPOs, withoutPOs });
  } catch (err) {
    console.error('Error fetching work orders report:', err);
    res.status(500).json({ error: 'Failed to fetch work orders report.' });
  }
});

// GET /reports/profit-loss — simple P&L (revenue only)
app.get('/reports/profit-loss', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let where = "i.status = 'Paid'";
    if (from) { where += ' AND i.paidAt >= ?'; params.push(from); }
    if (to) { where += ' AND i.paidAt <= ?'; params.push(to); }

    const [rows] = await db.query(
      `SELECT DATE_FORMAT(i.paidAt, '%Y-%m') AS month, COALESCE(SUM(i.total), 0) AS revenue
       FROM invoices i WHERE ${where} AND i.paidAt IS NOT NULL
       GROUP BY month ORDER BY month`, params
    );

    const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const months = rows.map(r => {
      const [y, m] = r.month.split('-');
      return { month: r.month, label: monthLabels[parseInt(m, 10) - 1] + ' ' + y, revenue: Number(r.revenue) || 0 };
    });

    const totalRevenue = months.reduce((s, m) => s + m.revenue, 0);

    res.json({
      months, totalRevenue,
      note: 'Cost tracking is not yet available. This report shows revenue only.',
    });
  } catch (err) {
    console.error('Error fetching P&L report:', err);
    res.status(500).json({ error: 'Failed to fetch P&L report.' });
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

// DEBUG: Show all distinct status values in database (temporary endpoint)
app.get('/debug/status-values', authenticate, async (req, res) => {
  try {
    const [rawStatus] = await db.execute('SELECT DISTINCT status FROM work_orders ORDER BY status');
    const [waitingRows] = await db.execute(
      `SELECT id, workOrderNumber, status, poNumber, poSupplier, poPdfPath FROM work_orders
       WHERE LOWER(status) LIKE '%waiting%' OR LOWER(status) LIKE '%parts%'
       ORDER BY id DESC LIMIT 20`
    );
    const [totalCount] = await db.execute('SELECT COUNT(*) as total FROM work_orders');

    console.log('=== DEBUG: Status Values ===');
    console.log('Total work orders:', totalCount[0]?.total);
    console.log('Distinct raw status values:', rawStatus.map(r => r.status));
    console.log('Work orders with waiting/parts in status:', waitingRows.length);
    waitingRows.forEach(r => {
      console.log(`  - WO ${r.id}: "${r.status}" (normalized: "${displayStatusOrDefault(r.status)}")`);
    });

    res.json({
      totalWorkOrders: totalCount[0]?.total || 0,
      distinctStatuses: rawStatus.map(r => r.status),
      waitingOnPartsCount: waitingRows.length,
      waitingOnPartsWorkOrders: waitingRows.map(r => ({
        id: r.id,
        workOrderNumber: r.workOrderNumber,
        rawStatus: r.status,
        normalizedStatus: displayStatusOrDefault(r.status),
        poNumber: r.poNumber || null,
        poSupplier: r.poSupplier || null,
        hasPoPdf: !!r.poPdfPath
      }))
    });
  } catch (err) {
    console.error('Debug status-values error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DEBUG: Check a specific work order by ID
app.get('/debug/work-order/:id', authenticate, async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const [[row]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [wid]);

    if (!row) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    console.log(`=== DEBUG: Work Order ${wid} ===`);
    console.log('Raw status:', row.status);
    console.log('Normalized status:', displayStatusOrDefault(row.status));
    console.log('PO Number:', row.poNumber);
    console.log('PO Supplier:', row.poSupplier);
    console.log('PO PDF Path:', row.poPdfPath);

    res.json({
      id: row.id,
      workOrderNumber: row.workOrderNumber,
      customer: row.customer,
      rawStatus: row.status,
      normalizedStatus: displayStatusOrDefault(row.status),
      poNumber: row.poNumber || null,
      poSupplier: row.poSupplier || null,
      poPdfPath: row.poPdfPath || null,
      poPickedUp: !!row.poPickedUp,
      createdAt: row.createdAt || row.created_at || null
    });
  } catch (err) {
    console.error('Debug work-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// LIST ALL
app.get('/work-orders', authenticate, async (req, res) => {
  try {
    const [raw] = await db.execute(workOrdersSelectSQL({ orderSql: 'ORDER BY w.id DESC' }));
    const rows = raw.map(r => ({ ...r, status: displayStatusOrDefault(r.status), allPoNumbersFormatted: formatPoNumberList(r.allPoNumbers) }));

    // DEBUG: Log count of "Waiting on Parts" work orders
    const waitingCount = rows.filter(r => r.status === 'Waiting on Parts').length;
    console.log(`[WORK-ORDERS-LIST] Total: ${rows.length}, Waiting on Parts: ${waitingCount}`);
    if (waitingCount > 0) {
      const waitingIds = rows.filter(r => r.status === 'Waiting on Parts').map(r => r.id);
      console.log(`[WORK-ORDERS-LIST] Waiting on Parts IDs: ${waitingIds.join(', ')}`);
    }

    res.json(rows);
  } catch (err) {
    console.error('Work-orders list error:', err);
    res.status(500).json({ error: 'Failed to fetch work orders.' });
  }
});

// Work orders filtered by canonical status (used by Ready-to-Quote / Ready-to-Invoice)
app.get('/work-orders/by-status/:status', authenticate, async (req, res) => {
  try {
    const target = canonStatus(req.params.status);
    if (!target) return res.status(400).json({ error: 'Unknown status.' });

    // Get all work orders, filter by canonical status
    const [raw] = await db.execute(workOrdersSelectSQL({ orderSql: 'ORDER BY w.id DESC' }));
    const rows = raw
      .map(r => ({ ...r, status: displayStatusOrDefault(r.status), allPoNumbersFormatted: formatPoNumberList(r.allPoNumbers) }))
      .filter(r => r.status === target);

    // For "Needs to be Invoiced", attach linked accepted estimate info
    if (target === 'Needs to be Invoiced' && rows.length > 0) {
      const woIds = rows.map(r => r.id);
      const [estimates] = await db.query(
        `SELECT e.id, e.workOrderId, e.status, e.total, e.projectName
         FROM estimates e WHERE e.workOrderId IN (${woIds.map(() => '?').join(',')})`,
        woIds
      );
      const estMap = {};
      for (const e of estimates) {
        if (!estMap[e.workOrderId]) estMap[e.workOrderId] = [];
        estMap[e.workOrderId].push(e);
      }
      for (const r of rows) {
        r.linkedEstimates = estMap[r.id] || [];
        const accepted = r.linkedEstimates.find(e => e.status === 'Accepted');
        r.acceptedEstimate = accepted || null;
      }
    }

    res.json(rows);
  } catch (err) {
    console.error('Work-orders by-status error:', err);
    res.status(500).json({ error: 'Failed to fetch work orders by status.' });
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
    row.allPoNumbersFormatted = formatPoNumberList(row.allPoNumbers);

    res.json(row);
  } catch (err) {
    console.error('Work-order get-by-id error:', err);
    res.status(500).json({ error: 'Failed to fetch work order.' });
  }
});

// EXTRACT work order fields from PDF (OCR)
// Uses extractUploader (disk-based) instead of upload (S3) so we can read the file directly
app.post('/work-orders/extract-pdf', authenticate, extractUploader.single('pdf'), async (req, res) => {
  console.log("\n" + "=".repeat(60));
  console.log("=== PDF EXTRACTION ENDPOINT HIT ===");
  console.log("=".repeat(60));
  console.log("[EXTRACT-PDF] Timestamp:", new Date().toISOString());
  console.log("[EXTRACT-PDF] req.file exists:", !!req.file);
  if (req.file) {
    console.log("[EXTRACT-PDF] File details:", JSON.stringify({
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      encoding: req.file.encoding,
      mimetype: req.file.mimetype,
      destination: req.file.destination,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    }, null, 2));
  }

  let filePath = null;

  try {
    // Step 1: Check if file was uploaded
    console.log("[EXTRACT-PDF] Step 1: Checking file upload...");
    if (!req.file) {
      console.log("[EXTRACT-PDF] FAILED: No file in request");
      return res.status(400).json({
        success: false,
        error: 'No PDF file uploaded. Use field name "pdf".'
      });
    }
    console.log("[EXTRACT-PDF] Step 1: PASSED - File received");

    const file = req.file;
    filePath = file.path;

    // Step 2: Verify file exists on disk
    console.log("[EXTRACT-PDF] Step 2: Checking file exists at:", filePath);
    const fileExists = fs.existsSync(filePath);
    console.log("[EXTRACT-PDF] File exists:", fileExists);
    if (!fileExists) {
      console.error("[EXTRACT-PDF] FAILED: File not found at path:", filePath);
      return res.status(500).json({
        success: false,
        error: 'Uploaded file not found on server'
      });
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    console.log("[EXTRACT-PDF] File stats:", {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime
    });
    console.log("[EXTRACT-PDF] Step 2: PASSED - File exists on disk");

    // Step 3: Extract text from PDF (uses OCR if needed)
    console.log("[EXTRACT-PDF] Step 3: Starting OCR extraction...");
    console.log("[EXTRACT-PDF] Calling extractTextSmart() on:", filePath);

    const text = await extractTextSmart(filePath);

    console.log("[EXTRACT-PDF] OCR Result:");
    console.log("[EXTRACT-PDF]   - Text length:", text.length, "characters");
    console.log("[EXTRACT-PDF]   - First 500 chars:", text.substring(0, 500));
    console.log("[EXTRACT-PDF] Step 3: PASSED - Text extracted");

    // Step 4: Extract work order fields from text
    console.log("[EXTRACT-PDF] Step 4: Extracting fields from text...");
    const extracted = extractWorkOrderFields(text);
    console.log("[EXTRACT-PDF] Extracted fields:", JSON.stringify(extracted, null, 2));
    console.log("[EXTRACT-PDF] Step 4: PASSED - Fields extracted");

    // Step 5: Clean up temp file
    console.log("[EXTRACT-PDF] Step 5: Cleaning up temp file...");
    try {
      fs.unlinkSync(filePath);
      console.log("[EXTRACT-PDF] Step 5: PASSED - Temp file deleted");
      filePath = null;
    } catch (e) {
      console.warn("[EXTRACT-PDF] Step 5: WARNING - Could not delete temp file:", e.message);
    }

    const responsePayload = {
      success: true,
      extracted: {
        customer: extracted.customer,
        billingAddress: extracted.billingAddress,
        poNumber: extracted.poNumber,
        workOrderNumber: extracted.workOrderNumber,
        siteLocation: extracted.siteLocation,
        siteAddress: extracted.siteAddress,
        problemDescription: extracted.problemDescription
      },
      rawText: extracted.rawText,
      textLength: text.length
    };

    console.log("=".repeat(60));
    console.log("=== PDF EXTRACTION COMPLETE - SUCCESS ===");
    console.log("[EXTRACT-PDF] Response workOrderNumber:", JSON.stringify(extracted.workOrderNumber));
    console.log("[EXTRACT-PDF] Response payload keys:", Object.keys(responsePayload.extracted));
    console.log("[EXTRACT-PDF] Full extracted:", JSON.stringify(responsePayload.extracted, null, 2));
    console.log("=".repeat(60) + "\n");

    res.json(responsePayload);

  } catch (err) {
    console.error("=".repeat(60));
    console.error("=== PDF EXTRACTION FAILED ===");
    console.error("=".repeat(60));
    console.error("[EXTRACT-PDF] Error message:", err.message);
    console.error("[EXTRACT-PDF] Error stack:", err.stack);
    console.error("[EXTRACT-PDF] Full error:", err);

    // Clean up temp file on error
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log("[EXTRACT-PDF] Cleaned up temp file after error");
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    res.status(500).json({
      success: false,
      error: 'Failed to extract PDF content: ' + err.message
    });
  }
});

// DEBUG ENDPOINT: Full raw text extraction + field detection for debugging
app.post('/api/debug-extract-pdf', authenticate, extractUploader.single('pdf'), async (req, res) => {
  console.log("\n" + "=".repeat(60));
  console.log("=== DEBUG PDF EXTRACTION ===");
  console.log("=".repeat(60));

  let filePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded. Use field name "pdf".' });
    }

    filePath = req.file.path;
    console.log("[DEBUG-PDF] File:", req.file.originalname, "Size:", req.file.size);

    // Step 1: Try digital extraction first
    let digitalText = "";
    let ocrText = "";
    let extractionMethod = "none";

    try {
      digitalText = await extractTextFromPdf(filePath);
      console.log("[DEBUG-PDF] Digital extraction: " + digitalText.length + " chars");
    } catch (err) {
      console.log("[DEBUG-PDF] Digital extraction FAILED:", err.message);
    }

    if (digitalText.length < 50) {
      console.log("[DEBUG-PDF] Digital text too short, trying OCR...");
      try {
        ocrText = await extractTextFromScannedPdf(filePath);
        console.log("[DEBUG-PDF] OCR extraction: " + ocrText.length + " chars");
      } catch (err) {
        console.log("[DEBUG-PDF] OCR extraction FAILED:", err.message);
      }
      extractionMethod = ocrText.length > digitalText.length ? "ocr" : "digital";
    } else {
      extractionMethod = "digital";
    }

    const finalText = extractionMethod === "ocr" ? ocrText : digitalText;

    // Step 2: Run field extraction
    const extracted = extractWorkOrderFields(finalText);

    // Step 3: Clean up
    try { fs.unlinkSync(filePath); filePath = null; } catch (e) {}

    // Return FULL raw text (not truncated)
    res.json({
      success: true,
      extractionMethod,
      digitalTextLength: digitalText.length,
      ocrTextLength: ocrText.length,
      finalTextLength: finalText.length,
      rawText: finalText,
      rawTextFirst2000: finalText.substring(0, 2000),
      detectedCustomer: extracted.customer,
      detectedCustomerProfile: extracted.detectedCustomerProfile,
      extractedFields: {
        customer: extracted.customer,
        billingAddress: extracted.billingAddress,
        workOrderNumber: extracted.workOrderNumber,
        poNumber: extracted.poNumber,
        siteLocation: extracted.siteLocation,
        siteAddress: extracted.siteAddress,
        problemDescription: extracted.problemDescription,
      },
      // Show character codes for first 500 chars (helps debug hidden chars)
      charCodes: finalText.substring(0, 500).split('').map((c, i) => ({
        pos: i,
        char: c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c,
        code: c.charCodeAt(0)
      }))
    });

  } catch (err) {
    console.error("[DEBUG-PDF] Error:", err.message);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// TEST ENDPOINT: Test PDF extraction on an existing file
app.get('/test-extract-pdf', authenticate, async (req, res) => {
  console.log("\n=== TEST PDF EXTRACTION ===");

  try {
    // Check if GraphicsMagick/ImageMagick are available
    const { execSync } = require('child_process');
    let gmVersion = null, imVersion = null, gsVersion = null;

    try {
      gmVersion = execSync('gm -version 2>&1').toString().split('\n')[0];
      console.log("[TEST] GraphicsMagick:", gmVersion);
    } catch (e) {
      console.log("[TEST] GraphicsMagick: NOT INSTALLED");
    }

    try {
      imVersion = execSync('convert -version 2>&1').toString().split('\n')[0];
      console.log("[TEST] ImageMagick:", imVersion);
    } catch (e) {
      console.log("[TEST] ImageMagick: NOT INSTALLED");
    }

    try {
      gsVersion = execSync('gs --version 2>&1').toString().trim();
      console.log("[TEST] Ghostscript:", gsVersion);
    } catch (e) {
      console.log("[TEST] Ghostscript: NOT INSTALLED");
    }

    // Find a PDF file to test with
    const uploadsDir = path.resolve(__dirname, 'uploads');
    let testFile = req.query.file;

    if (!testFile) {
      // Find first PDF in uploads
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
        if (files.length > 0) {
          testFile = path.join(uploadsDir, files[0]);
          console.log("[TEST] Using first PDF found:", testFile);
        }
      }
    }

    if (!testFile) {
      return res.json({
        success: false,
        error: 'No PDF file to test. Pass ?file=/path/to/file.pdf or add PDFs to uploads folder',
        dependencies: { graphicsmagick: gmVersion, imagemagick: imVersion, ghostscript: gsVersion }
      });
    }

    if (!fs.existsSync(testFile)) {
      return res.json({
        success: false,
        error: 'Test file not found: ' + testFile,
        dependencies: { graphicsmagick: gmVersion, imagemagick: imVersion, ghostscript: gsVersion }
      });
    }

    console.log("[TEST] Testing extraction on:", testFile);

    // Run extraction
    const text = await extractTextSmart(testFile);
    console.log("[TEST] Extracted", text.length, "characters");
    console.log("[TEST] First 500 chars:", text.substring(0, 500));

    const extracted = extractWorkOrderFields(text);
    console.log("[TEST] Extracted fields:", extracted);

    res.json({
      success: true,
      testFile,
      dependencies: {
        graphicsmagick: gmVersion || 'NOT INSTALLED',
        imagemagick: imVersion || 'NOT INSTALLED',
        ghostscript: gsVersion || 'NOT INSTALLED'
      },
      textLength: text.length,
      rawText: text.substring(0, 1000),
      extracted
    });

  } catch (err) {
    console.error("[TEST] Error:", err);
    res.json({
      success: false,
      error: err.message,
      stack: err.stack
    });
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
      timeWindow = null,
      customerId = null,
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

    if (customerId && Number.isFinite(Number(customerId))) {
      cols.push('customerId');
      vals.push(Number(customerId));
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

    // Auto-create customer and link to work order if no customerId was provided
    if (!customerId || !Number.isFinite(Number(customerId))) {
      try {
        const cust = await findOrCreateCustomer(customer, {
          billingAddress, phone: customerPhone, email: customerEmail,
        });
        await db.execute('UPDATE work_orders SET customerId = ? WHERE id = ?', [cust.id, r.insertId]);
      } catch (autoErr) {
        console.warn('[POST /work-orders] Auto-create customer failed:', autoErr.message);
      }
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

    // Allow the frontend to clear an existing estimate PDF without uploading
    // a replacement. Best-effort delete the underlying file.
    if (!estimatePdf && isTruthy(req.body.removeEstimatePdf)) {
      const oldPath = existing.estimatePdfPath;
      if (oldPath) {
        try { await deleteStoredFileByKey(oldPath); } catch (e) {
          console.warn('[Estimate PDF Remove] Failed to delete file:', e.message);
        }
      }
      estimatePdfPath = null;
    }

    // Track if we're setting a new PO PDF for vendor detection
    let newPoPdfFile = null;
    if (poPdf) {
      const newPath = fileKeySafe(poPdf);
      const oldPath = existing.poPdfPath;
      if (wantReplacePo || !oldPath) {
        if (oldPath && moveOldPo && !attachments.includes(oldPath)) attachments.push(oldPath);
        poPdfPath = newPath;
        newPoPdfFile = poPdf; // Save reference for PDF analysis
      } else {
        attachments.push(newPath);
      }
    }

    // ----- PO PDF Content Analysis (with OCR support) -----
    // If a new PO PDF was set, extract text and auto-detect vendor/PO number
    let detectedSupplier = null;
    let detectedPoNumber = null;
    if (newPoPdfFile && wantReplacePo) {
      console.log('[PO Upload] === PO PDF UPLOAD DETECTED ===');
      console.log('[PO Upload] Received PO PDF for work order:', wid);
      console.log('[PO Upload] File info:', {
        originalname: newPoPdfFile.originalname,
        filename: newPoPdfFile.filename,
        key: newPoPdfFile.key,
        mimetype: newPoPdfFile.mimetype,
        size: newPoPdfFile.size
      });

      try {
        // Get the file path for PDF analysis
        let pdfFilePath;
        let shouldCleanup = false;

        if (S3_BUCKET) {
          // For S3: download to temp file first
          const tmpPath = path.join(require('os').tmpdir(), `po-${Date.now()}.pdf`);
          console.log('[PO Upload] S3 mode: downloading to temp file:', tmpPath);
          const s3Obj = await s3.getObject({ Bucket: S3_BUCKET, Key: newPoPdfFile.key }).promise();
          fs.writeFileSync(tmpPath, s3Obj.Body);
          pdfFilePath = tmpPath;
          shouldCleanup = true;
        } else {
          // Local disk: use the uploaded file path directly
          pdfFilePath = path.resolve(__dirname, 'uploads', newPoPdfFile.filename);
          console.log('[PO Upload] Local mode: reading from:', pdfFilePath);
          console.log('[PO Upload] File exists:', fs.existsSync(pdfFilePath));
        }

        console.log('[PO Upload] File path:', pdfFilePath);
        console.log('[PO Upload] Starting OCR/text extraction...');

        // Run smart PDF analysis (digital extraction + OCR fallback)
        const analysis = await analyzePoPdf(pdfFilePath);
        detectedSupplier = analysis.supplier;
        detectedPoNumber = analysis.poNumber;

        console.log('[PO Upload] Extracted text:', (analysis.text || '').substring(0, 500));
        console.log('[PO Upload] Detected supplier:', detectedSupplier || '(none)');
        console.log('[PO Upload] Detected PO#:', detectedPoNumber || '(none)');

        console.log('[PO Upload] === DETECTION SUMMARY ===');
        console.log('[PO Upload] Text extracted:', analysis.textLength, 'chars');
        console.log('[PO Upload] Frontend supplier:', req.body.poSupplier || '(none)');
        console.log('[PO Upload] Frontend PO number:', req.body.poNumber || '(none)');
        console.log('[PO Upload] Existing DB supplier:', existing.poSupplier || '(none)');
        console.log('[PO Upload] Existing DB poNumber:', existing.poNumber || '(none)');
        const finalSupplierPreview = detectedSupplier || req.body.poSupplier || existing.poSupplier || '(none)';
        const finalPoPreview = detectedPoNumber || req.body.poNumber || existing.poNumber || '(none)';
        console.log('[PO Upload] FINAL supplier will be:', finalSupplierPreview);
        console.log('[PO Upload] FINAL PO# will be:', finalPoPreview);
        console.log('[PO Upload] Updating work order with supplier:', finalSupplierPreview, 'poNumber:', finalPoPreview);
        console.log('[PO Upload] =========================');

        // Clean up temp file for S3 mode
        if (shouldCleanup && fs.existsSync(pdfFilePath)) {
          try { fs.unlinkSync(pdfFilePath); } catch {}
        }
      } catch (pdfErr) {
        console.error('[PO Upload] === PO PDF ANALYSIS ERROR ===');
        console.error('[PO Upload] Error:', pdfErr.message);
        console.error('[PO Upload] Stack:', pdfErr.stack);
        console.error('[PO Upload] (Continuing without auto-detection)');
        console.error('[PO Upload] =============================');
      }
    } else if (newPoPdfFile && !wantReplacePo) {
      console.log('[PO Upload] WARNING: PO PDF uploaded but wantReplacePo is FALSE');
      console.log('[PO Upload] setAsPoPdf:', req.body.setAsPoPdf, 'replacePoPdf:', req.body.replacePoPdf);
      console.log('[PO Upload] PO PDF will be added as attachment, NOT analyzed for vendor');
    }

    const newPhotos    = images.map(fileKeySafe);
    const extraPdfKeys = (otherPdfs || []).map(fileKeySafe);
    if (newPhotos.length) {
      console.log('[Photo Upload] WO ID:', wid, '| New photos:', JSON.stringify(newPhotos));
    }
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

      poSupplier: bodyPoSupplier = existing.poSupplier,
      poPickedUp = existing.poPickedUp,

      scheduledDate: scheduledDateRaw = undefined,
      endTime = null,
      timeWindow = null
    } = body;

    // Priority: PDF content detection > frontend-supplied > existing value
    const poSupplier = detectedSupplier || bodyPoSupplier || existing.poSupplier;
    const finalPoNumber = detectedPoNumber || poNumber || existing.poNumber;

    // Log final PO fields being saved to DB
    if (detectedSupplier || detectedPoNumber || bodyPoSupplier || req.body.poNumber) {
      console.log('[PO Upload] DB SAVE - WO#', wid, '| poSupplier:', JSON.stringify(poSupplier), '| poNumber:', JSON.stringify(finalPoNumber), '| poPdfPath:', JSON.stringify(poPdfPath));
    }

    // Insert into work_order_pos table for multi-PO support
    if (newPoPdfFile && wantReplacePo && poPdfPath) {
      try {
        await db.query(
          `INSERT INTO work_order_pos (workOrderId, poNumber, poSupplier, poPdfPath)
           VALUES (?, ?, ?, ?)`,
          [wid, finalPoNumber || null, poSupplier || null, poPdfPath]
        );
        console.log('[PO Upload] Inserted new PO record into work_order_pos for WO#', wid);
      } catch (poInsertErr) {
        console.warn('[PO Upload] Failed to insert into work_order_pos:', poInsertErr.message);
      }
    }

    const cStatus = canonStatus(status) || existing.status;

    // DEBUG: Log status processing for "Waiting on Parts" investigation
    if (status !== existing.status || (status && status.toLowerCase().includes('waiting'))) {
      console.log(`[STATUS-DEBUG] WO ${wid}: incoming="${status}", canonStatus="${canonStatus(status)}", final="${cStatus}", existing="${existing.status}"`);
    }

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
      finalPoNumber || null,
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

    // customerId linking
    if (req.body.customerId !== undefined) {
      sql += `, customerId=?`;
      const cid = req.body.customerId;
      params.push(cid && Number.isFinite(Number(cid)) ? Number(cid) : null);
    } else if (customer) {
      // Auto-create customer if no customerId was explicitly provided
      try {
        const cust = await findOrCreateCustomer(customer, {
          billingAddress, phone: customerPhone, email: customerEmail,
        });
        sql += `, customerId=?`;
        params.push(cust.id);
      } catch (autoErr) {
        console.warn('[PUT /work-orders] Auto-create customer failed:', autoErr.message);
      }
    }

    sql += ` WHERE id=?`;
    params.push(wid);

    await db.execute(sql, params);

    // Sync legacy PO columns from work_order_pos if a PO was added
    if (newPoPdfFile && wantReplacePo) {
      await syncLegacyPoColumns(wid);
    }

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

// ─── WORK ORDER POs (multi-PO per work order) ──────────────────────────────

// GET /work-orders/:id/pos — list all POs for a work order
app.get('/work-orders/:id/pos', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const [rows] = await db.query(
      'SELECT * FROM work_order_pos WHERE workOrderId = ? ORDER BY createdAt ASC',
      [wid]
    );
    res.json(rows);
  } catch (err) {
    console.error('Work-order POs list error:', err);
    res.status(500).json({ error: 'Failed to fetch POs for this work order.' });
  }
});

// DELETE /work-orders/:id/pos/:poId — delete a specific PO
app.delete('/work-orders/:id/pos/:poId', authenticate, requireNumericParam('id'), requireNumericParam('poId'), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const poId = Number(req.params.poId);

    const [[row]] = await db.query(
      'SELECT * FROM work_order_pos WHERE id = ? AND workOrderId = ?',
      [poId, wid]
    );
    if (!row) return res.status(404).json({ error: 'PO not found on this work order.' });

    await db.query('DELETE FROM work_order_pos WHERE id = ?', [poId]);
    await syncLegacyPoColumns(wid);

    res.json({ ok: true });
  } catch (err) {
    console.error('Work-order PO delete error:', err);
    res.status(500).json({ error: 'Failed to delete PO.' });
  }
});

// PUT /work-orders/:id/pos/:poId/mark-picked-up — mark a specific PO as picked up
app.put('/work-orders/:id/pos/:poId/mark-picked-up', authenticate, requireNumericParam('id'), requireNumericParam('poId'), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const poId = Number(req.params.poId);

    const [[po]] = await db.query(
      'SELECT * FROM work_order_pos WHERE id = ? AND workOrderId = ?',
      [poId, wid]
    );
    if (!po) return res.status(404).json({ error: 'PO not found on this work order.' });

    await db.query('UPDATE work_order_pos SET poPickedUp = 1 WHERE id = ?', [poId]);

    // Append note to work order
    const [[wo]] = await db.query('SELECT notes FROM work_orders WHERE id = ?', [wid]);
    const who = req.user?.username || 'system';
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const line = `[${stamp}] ${who}: PO ${po.poNumber || '(no PO #)'}${po.poSupplier ? ` (${po.poSupplier})` : ''} marked PICKED UP.`;
    const newNotes = (wo?.notes || '') + (wo?.notes ? '\n\n' : '') + line;
    await db.query('UPDATE work_orders SET notes = ? WHERE id = ?', [newNotes, wid]);

    await syncLegacyPoColumns(wid);

    const [[updated]] = await db.query('SELECT * FROM work_order_pos WHERE id = ?', [poId]);
    res.json(updated);
  } catch (err) {
    console.error('Work-order PO mark-picked-up error:', err);
    res.status(500).json({ error: 'Failed to mark PO as picked up.' });
  }
});

// ─── WORK ORDER ESTIMATE PDFS (multiple uploaded estimate PDFs per WO) ─────

// GET /work-orders/:id/estimate-pdfs — list all uploaded estimate PDFs
app.get('/work-orders/:id/estimate-pdfs', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const wid = Number(req.params.id);
    const [rows] = await db.query(
      'SELECT id, workOrderId, filename, originalName, uploadedAt FROM work_order_estimate_pdfs WHERE workOrderId = ? ORDER BY uploadedAt ASC, id ASC',
      [wid]
    );
    res.json(rows);
  } catch (err) {
    console.error('Estimate PDFs list error:', err);
    res.status(500).json({ error: 'Failed to fetch estimate PDFs for this work order.' });
  }
});

// POST /work-orders/:id/estimate-pdfs — upload a new estimate PDF (adds, does not replace)
app.post(
  '/work-orders/:id/estimate-pdfs',
  authenticate,
  requireNumericParam('id'),
  withMulter(upload.any()),
  async (req, res) => {
    try {
      const wid = Number(req.params.id);

      const [[wo]] = await db.query('SELECT id FROM work_orders WHERE id = ?', [wid]);
      if (!wo) return res.status(404).json({ error: 'Work order not found.' });

      const files = Array.isArray(req.files) ? req.files : [];
      const pdfFile = files.find((f) => isPdf(f));
      if (!pdfFile) return res.status(400).json({ error: 'Please upload a PDF file.' });

      const key = fileKey(pdfFile);
      const originalName = pdfFile.originalname || '';

      const [result] = await db.query(
        'INSERT INTO work_order_estimate_pdfs (workOrderId, filename, originalName) VALUES (?, ?, ?)',
        [wid, key, originalName]
      );

      const [[row]] = await db.query(
        'SELECT id, workOrderId, filename, originalName, uploadedAt FROM work_order_estimate_pdfs WHERE id = ?',
        [result.insertId]
      );
      res.status(201).json(row);
    } catch (err) {
      console.error('Estimate PDF upload error:', err);
      res.status(500).json({ error: 'Failed to upload estimate PDF.' });
    }
  }
);

// DELETE /work-orders/:id/estimate-pdfs/:pdfId — remove one estimate PDF
app.delete(
  '/work-orders/:id/estimate-pdfs/:pdfId',
  authenticate,
  requireNumericParam('id'),
  requireNumericParam('pdfId'),
  async (req, res) => {
    try {
      const wid = Number(req.params.id);
      const pdfId = Number(req.params.pdfId);

      const [[row]] = await db.query(
        'SELECT * FROM work_order_estimate_pdfs WHERE id = ? AND workOrderId = ?',
        [pdfId, wid]
      );
      if (!row) return res.status(404).json({ error: 'Estimate PDF not found on this work order.' });

      await db.query('DELETE FROM work_order_estimate_pdfs WHERE id = ?', [pdfId]);

      if (row.filename) {
        await deleteStoredFileByKey(row.filename);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Estimate PDF delete error:', err);
      res.status(500).json({ error: 'Failed to delete estimate PDF.' });
    }
  }
);

// ─── PURCHASE ORDERS (derived from work_order_pos) ──────────────────────────

// GET /purchase-orders?supplier=Chicago%20Tempered&status=on-order|picked-up
// Now reads from work_order_pos joined with work_orders for multi-PO support
app.get('/purchase-orders', authenticate, async (req, res) => {
  try {
    const supplierQ = String(req.query.supplier || '').trim();
    const statusQ   = String(req.query.status || '').trim().toLowerCase();

    const whereParts = ['1=1'];
    const params = [];

    if (supplierQ) {
      whereParts.push(`COALESCE(p.poSupplier,'') LIKE ?`);
      params.push(`%${supplierQ}%`);
    }

    if (statusQ === 'on-order' || statusQ === 'on' || statusQ === 'open') {
      whereParts.push(`COALESCE(p.poPickedUp,0) = 0`);
    } else if (statusQ === 'picked-up' || statusQ === 'picked' || statusQ === 'closed') {
      whereParts.push(`COALESCE(p.poPickedUp,0) = 1`);
    }

    const sql = `
      SELECT p.id AS poId, p.workOrderId, p.poNumber, p.poSupplier, p.poPdfPath, p.poPickedUp, p.createdAt AS poCreatedAt,
             w.customer, w.siteLocation, w.siteAddress, w.workOrderNumber, w.status,
             poAgg.allPoNumbers
      FROM work_order_pos p
      JOIN work_orders w ON p.workOrderId = w.id
      LEFT JOIN (
        SELECT workOrderId, GROUP_CONCAT(poNumber ORDER BY createdAt ASC) AS allPoNumbers
        FROM work_order_pos
        WHERE poNumber IS NOT NULL AND poNumber <> ''
        GROUP BY workOrderId
      ) poAgg ON poAgg.workOrderId = p.workOrderId
      WHERE ${whereParts.join(' AND ')}
      ORDER BY p.poSupplier ASC, p.id DESC
    `;

    const [rows] = await db.execute(sql, params);

    const out = rows.map(r => ({
      id: r.poId,
      poId: r.poId,
      workOrderId: r.workOrderId,
      workOrderNumber: r.workOrderNumber || null,
      poNumber: r.poNumber || null,
      allPoNumbers: r.allPoNumbers || null,
      allPoNumbersFormatted: formatPoNumberList(r.allPoNumbers),
      supplier: r.poSupplier || '',
      customer: r.customer || '',
      siteLocation: r.siteLocation || '',
      siteAddress: r.siteAddress || '',
      poPdfPath: r.poPdfPath || null,
      poPickedUp: !!Number(r.poPickedUp || 0),
      poStatus: Number(r.poPickedUp || 0) ? 'Picked Up' : 'On Order',
      createdAt: r.poCreatedAt || null,
      workOrderStatus: displayStatusOrDefault(r.status),
    }));

    res.json(out);
  } catch (err) {
    console.error('Purchase-orders list error:', err);
    res.status(500).json({ error: 'Failed to fetch purchase orders.' });
  }
});

// PUT /purchase-orders/:id/mark-picked-up   (id = work_order_pos.id)
app.put('/purchase-orders/:id/mark-picked-up', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const poId = Number(req.params.id);

    // Try work_order_pos first (new multi-PO path)
    const [[po]] = await db.query('SELECT * FROM work_order_pos WHERE id = ?', [poId]);

    if (po) {
      // New path: mark specific PO record
      await db.query('UPDATE work_order_pos SET poPickedUp = 1 WHERE id = ?', [poId]);

      const wid = po.workOrderId;
      const [[wo]] = await db.query('SELECT * FROM work_orders WHERE id = ?', [wid]);

      const who = req.user?.username || 'system';
      const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
      const line = `[${stamp}] ${who}: PO ${po.poNumber || '(no PO #)'}${po.poSupplier ? ` (${po.poSupplier})` : ''} marked PICKED UP.`;
      const newNotes = (wo?.notes || '') + (wo?.notes ? '\n\n' : '') + line;
      await db.query('UPDATE work_orders SET notes = ? WHERE id = ?', [newNotes, wid]);

      await syncLegacyPoColumns(wid);

      const [[updated]] = await db.query('SELECT * FROM work_order_pos WHERE id = ?', [poId]);
      return res.json({
        id: updated.id,
        poId: updated.id,
        workOrderId: updated.workOrderId,
        workOrderNumber: wo?.workOrderNumber || null,
        poNumber: updated.poNumber || null,
        supplier: updated.poSupplier || '',
        poPickedUp: !!Number(updated.poPickedUp || 0),
        poStatus: Number(updated.poPickedUp || 0) ? 'Picked Up' : 'On Order',
        notes: newNotes,
        workOrderStatus: displayStatusOrDefault(wo?.status),
      });
    }

    // Fallback: legacy path using work_orders.id (for backwards compat)
    const [[row]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [poId]);
    if (!row) return res.status(404).json({ error: 'PO / Work order not found.' });

    const who = req.user?.username || 'system';
    const stamp = new Date().toISOString().replace('T',' ').replace('Z','');
    const poNumber = row.poNumber || '';
    const supplier = row.poSupplier || '';

    const line = `[${stamp}] ${who}: Purchase order ${poNumber || '(no PO #)'}${supplier ? ` (${supplier})` : ''} marked PICKED UP.`;
    const newNotes = (row.notes || '') + (row.notes ? '\n\n' : '') + line;

    await db.execute(
      'UPDATE work_orders SET poPickedUp = 1, notes = ? WHERE id = ?',
      [newNotes, poId]
    );

    const [[updated]] = await db.execute('SELECT * FROM work_orders WHERE id = ?', [poId]);

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

// ─── SUPPLIER PICKUPS (calendar event type) ─────────────────────────────────

// GET /supplier-pickups?date=YYYY-MM-DD  (date is optional)
app.get('/supplier-pickups', authenticate, async (req, res) => {
  try {
    const dateQ = String(req.query.date || '').trim();
    let sql = `SELECT id, supplier, scheduledDate, notes, assignedTech, createdAt
               FROM supplier_pickups`;
    const params = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateQ)) {
      sql += ` WHERE DATE(scheduledDate) = ?`;
      params.push(dateQ);
    }
    sql += ` ORDER BY scheduledDate IS NULL, scheduledDate ASC, id DESC`;
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Supplier pickups list error:', err);
    res.status(500).json({ error: 'Failed to fetch supplier pickups.' });
  }
});

// GET /supplier-pickups/suppliers — distinct supplier list (from work_order_pos.poSupplier)
app.get('/supplier-pickups/suppliers', authenticate, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT DISTINCT TRIM(poSupplier) AS supplier
      FROM work_order_pos
      WHERE poSupplier IS NOT NULL AND TRIM(poSupplier) <> ''
      ORDER BY supplier ASC
    `);
    res.json(rows.map((r) => r.supplier));
  } catch (err) {
    console.error('Supplier list error:', err);
    res.status(500).json({ error: 'Failed to fetch supplier list.' });
  }
});

// POST /supplier-pickups  { supplier, scheduledDate, notes, assignedTech }
app.post('/supplier-pickups', authenticate, async (req, res) => {
  try {
    const supplier = String(req.body?.supplier || '').trim();
    const scheduledDateRaw = String(req.body?.scheduledDate || '').trim();
    const notes = req.body?.notes != null ? String(req.body.notes) : null;
    const assignedTech = req.body?.assignedTech != null ? String(req.body.assignedTech) : null;

    if (!supplier) {
      return res.status(400).json({ error: 'supplier is required.' });
    }
    const scheduledDate = /^\d{4}-\d{2}-\d{2}$/.test(scheduledDateRaw) ? scheduledDateRaw : null;

    const [result] = await db.execute(
      `INSERT INTO supplier_pickups (supplier, scheduledDate, notes, assignedTech)
       VALUES (?, ?, ?, ?)`,
      [supplier, scheduledDate, notes, assignedTech]
    );
    const [[row]] = await db.query('SELECT * FROM supplier_pickups WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    console.error('Supplier pickup create error:', err);
    res.status(500).json({ error: 'Failed to create supplier pickup.' });
  }
});

// PUT /supplier-pickups/:id  (used for drag-and-drop reschedule; partial update)
app.put('/supplier-pickups/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const fields = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(req.body, 'supplier')) {
      fields.push('supplier = ?');
      params.push(String(req.body.supplier || '').trim());
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'scheduledDate')) {
      const raw = String(req.body.scheduledDate || '').trim();
      const v = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
      fields.push('scheduledDate = ?');
      params.push(v);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'notes')) {
      fields.push('notes = ?');
      params.push(req.body.notes != null ? String(req.body.notes) : null);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'assignedTech')) {
      fields.push('assignedTech = ?');
      params.push(req.body.assignedTech != null ? String(req.body.assignedTech) : null);
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    params.push(id);
    await db.execute(`UPDATE supplier_pickups SET ${fields.join(', ')} WHERE id = ?`, params);
    const [[row]] = await db.query('SELECT * FROM supplier_pickups WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Supplier pickup not found.' });
    res.json(row);
  } catch (err) {
    console.error('Supplier pickup update error:', err);
    res.status(500).json({ error: 'Failed to update supplier pickup.' });
  }
});

// DELETE /supplier-pickups/:id
app.delete('/supplier-pickups/:id', authenticate, requireNumericParam('id'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.execute('DELETE FROM supplier_pickups WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Supplier pickup not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Supplier pickup delete error:', err);
    res.status(500).json({ error: 'Failed to delete supplier pickup.' });
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

    const hasA = !!SCHEMA.hasAssignedTo;
    const assignedSel = hasA ? ', u.username AS assignedToName, w.assignedTo' : '';
    const assignedJoin = hasA ? 'LEFT JOIN users u ON w.assignedTo = u.id' : '';

    const [rows] = await db.execute(
      `SELECT w.id, w.workOrderNumber, w.poNumber, w.customer, w.siteLocation, w.siteAddress, w.problemDescription, w.status,
              w.scheduledDate, w.scheduledEnd${assignedSel}
         FROM work_orders w
         ${assignedJoin}
        WHERE w.scheduledDate IS NOT NULL
          AND w.scheduledDate <= ?
          AND (w.scheduledEnd IS NULL OR w.scheduledEnd >= ?)
        ORDER BY w.scheduledDate ASC`,
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
        assignedTo: r.assignedTo || null,
        assignedToName: r.assignedToName || null,
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
    out.push({ id, address, label: s?.label || null, lat: s?.lat, lng: s?.lng });
  }
  return out;
}

// ─── FALLBACK ROUTE OPTIMIZATION (when no Google API key) ───────────────────
// Uses nearest-neighbor algorithm with geocoding

function toRad(deg) {
  return deg * (Math.PI / 180);
}

// Haversine formula for distance between two lat/lng points (returns miles)
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Geocode an address using Google Geocoding API
async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY || !address) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
    const resp = await axios.get(url, { timeout: 5000 });
    const data = resp?.data;
    if (data?.status === 'OK' && data.results?.length > 0) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) {
    console.warn('[ROUTE] Geocoding failed for:', address, e?.message);
  }
  return null;
}

// Nearest-neighbor algorithm for route optimization
async function nearestNeighborOptimize(stops, startAddress) {
  console.log('[ROUTE] Using nearest-neighbor fallback optimization');

  // Try to geocode all addresses
  const stopsWithCoords = [];
  for (const stop of stops) {
    let lat = stop.lat;
    let lng = stop.lng;

    // If no coordinates, try to geocode (only if we have API key)
    if ((!lat || !lng) && GOOGLE_MAPS_API_KEY) {
      const coords = await geocodeAddress(stop.address);
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
      }
    }

    stopsWithCoords.push({ ...stop, lat, lng });
  }

  // Check how many have valid coordinates
  const withCoords = stopsWithCoords.filter(s => s.lat && s.lng);
  console.log(`[ROUTE] ${withCoords.length}/${stops.length} stops have coordinates`);

  if (withCoords.length < 2) {
    console.log('[ROUTE] Not enough geocoded stops for optimization, returning original order');
    return { orderedStops: stops, optimized: false, method: 'none' };
  }

  // Get start coordinates
  let currentLat, currentLng;
  if (startAddress && GOOGLE_MAPS_API_KEY) {
    const startCoords = await geocodeAddress(startAddress);
    if (startCoords) {
      currentLat = startCoords.lat;
      currentLng = startCoords.lng;
    }
  }

  // If no start coords, use first stop
  if (!currentLat || !currentLng) {
    const first = withCoords[0];
    currentLat = first.lat;
    currentLng = first.lng;
  }

  // Nearest-neighbor algorithm
  const remaining = [...withCoords];
  const ordered = [];
  let totalDistance = 0;

  while (remaining.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const stop = remaining[i];
      if (stop.lat && stop.lng) {
        const dist = haversineDistance(currentLat, currentLng, stop.lat, stop.lng);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }
    }

    const nearest = remaining.splice(nearestIdx, 1)[0];
    ordered.push(nearest);
    totalDistance += nearestDist;
    currentLat = nearest.lat;
    currentLng = nearest.lng;
  }

  // Add back any stops without coordinates at the end
  const withoutCoords = stopsWithCoords.filter(s => !s.lat || !s.lng);
  ordered.push(...withoutCoords);

  console.log('[ROUTE] Nearest-neighbor optimization complete');
  console.log('[ROUTE] Estimated total distance:', totalDistance.toFixed(1), 'miles (straight-line)');

  return {
    orderedStops: ordered,
    optimized: true,
    method: 'nearest-neighbor',
    estimatedDistanceMiles: totalDistance,
  };
}

async function handleBestRoute(req, res) {
  try {
    // Debug API key configuration
    console.log('[ROUTE] ==========================================');
    console.log('[ROUTE] API Key Debug:');
    console.log('[ROUTE]   - Loaded from env:', !!GOOGLE_MAPS_API_KEY);
    console.log('[ROUTE]   - Length:', GOOGLE_MAPS_API_KEY?.length);
    console.log('[ROUTE]   - Starts with:', GOOGLE_MAPS_API_KEY?.substring(0, 12) + '...');
    console.log('[ROUTE]   - Ends with:', '...' + GOOGLE_MAPS_API_KEY?.slice(-8));
    console.log('[ROUTE] ==========================================');

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
      console.warn('[ROUTE] GOOGLE_MAPS_API_KEY not set - using fallback optimization');

      // Try nearest-neighbor with any stored coordinates
      const fallbackResult = await nearestNeighborOptimize(stops, startAddress);

      if (fallbackResult.optimized) {
        const orderedStops = fallbackResult.orderedStops;
        return res.json({
          ok: true,
          optimized: true,
          method: fallbackResult.method,
          warning: 'Using nearest-neighbor fallback (no Google API key). Distance is straight-line estimate.',
          start: startAddress,
          end: endAddress,
          stops,
          orderedStops,
          orderedIds: orderedStops.map(s => s.id),
          totalDistanceMeters: fallbackResult.estimatedDistanceMiles ? Math.round(fallbackResult.estimatedDistanceMiles * 1609.34) : null,
          totalDurationSeconds: null,
          googleMapsUrl: mapsUrlForStops(startAddress, endAddress, orderedStops.map(s => s.address)),
        });
      }

      // If fallback also failed, return original order
      return res.json({
        ok: true,
        optimized: false,
        warning: 'GOOGLE_MAPS_API_KEY not set and no coordinates available. Returning stops in current order.',
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

    // Encode each address individually, NOT the entire waypoints string
    // Otherwise optimize:true becomes optimize%3Atrue and Google ignores it!
    const encodedAddresses = stops.map(s => encodeURIComponent(s.address));
    const wpParam = `optimize:true|${encodedAddresses.join('|')}`;

    console.log('[ROUTE] Calling Google Directions API...');
    console.log('[ROUTE] Origin:', startAddress);
    console.log('[ROUTE] Destination:', endAddress);
    console.log('[ROUTE] Waypoints:', stops.map(s => s.address));

    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${encodeURIComponent(startAddress)}` +
      `&destination=${encodeURIComponent(endAddress)}` +
      `&waypoints=${wpParam}` +
      `&mode=${travelMode}` +
      `&departure_time=now` +
      `&traffic_model=best_guess` +
      `&alternatives=false` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

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
      // Log detailed error for debugging
      console.error('[ROUTE] ❌ Google Directions API Error:');
      console.error('[ROUTE] Status:', data?.status);
      console.error('[ROUTE] Error Message:', data?.error_message);
      console.error('[ROUTE] Full Response:', JSON.stringify(data, null, 2));

      // Provide helpful troubleshooting info based on error
      let troubleshooting = '';
      if (data?.status === 'REQUEST_DENIED') {
        troubleshooting = 'Check: 1) Directions API enabled in Google Cloud Console, 2) API key restrictions, 3) Billing enabled';
      } else if (data?.status === 'OVER_QUERY_LIMIT') {
        troubleshooting = 'API quota exceeded. Check billing or wait and retry.';
      } else if (data?.status === 'INVALID_REQUEST') {
        troubleshooting = 'Invalid addresses or parameters in request.';
      }

      return res.json({
        ok: true,
        optimized: false,
        warning: `Google Directions returned status=${data?.status || 'UNKNOWN'}. ${data?.error_message || ''} ${troubleshooting}`,
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

    console.log('[ROUTE] Google API returned OK');
    console.log('[ROUTE] Original order:', stops.map((s, i) => `${i}: ${s.address.substring(0, 30)}...`));
    console.log('[ROUTE] Google waypoint_order:', orderIdx);

    const orderedStopsBase = orderIdx.length
      ? orderIdx.map(i => stops[i]).filter(Boolean)
      : stops;

    console.log('[ROUTE] Optimized order:', orderedStopsBase.map((s, i) => `${i}: ${s.address.substring(0, 30)}...`));

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

    const totalMiles = totalDistanceMeters ? (totalDistanceMeters / 1609.34).toFixed(1) : null;
    const totalMins = totalDurationSeconds ? Math.round(totalDurationSeconds / 60) : null;
    const totalMinsTraffic = totalDurationInTrafficSeconds ? Math.round(totalDurationInTrafficSeconds / 60) : null;
    console.log(`[ROUTE] Totals: ${totalMiles} mi, ${totalMins} min (${totalMinsTraffic} min w/ traffic)`);

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

// ─── GOOGLE API TEST ENDPOINT ────────────────────────────────────────────────
app.get('/routes/test-google-api', authenticate, async (req, res) => {
  console.log('[TEST] Testing Google Maps API configuration...');
  console.log('[TEST] API Key exists:', !!GOOGLE_MAPS_API_KEY);
  console.log('[TEST] API Key length:', GOOGLE_MAPS_API_KEY?.length);
  console.log('[TEST] API Key prefix:', GOOGLE_MAPS_API_KEY?.substring(0, 10) + '...');

  if (!GOOGLE_MAPS_API_KEY) {
    return res.json({
      success: false,
      error: 'GOOGLE_MAPS_API_KEY not set in environment',
      troubleshooting: [
        '1. Check .env file has GOOGLE_MAPS_API_KEY=your_key',
        '2. For Elastic Beanstalk: Add env var in Configuration → Software → Environment properties',
        '3. Restart the server after adding the key'
      ]
    });
  }

  // Test with a simple directions request
  const testUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=Chicago,IL&destination=Milwaukee,WI&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await axios.get(testUrl, { timeout: 10000 });
    const data = resp?.data;

    console.log('[TEST] Google Response Status:', data?.status);
    if (data?.error_message) {
      console.log('[TEST] Error Message:', data.error_message);
    }

    if (data?.status === 'OK') {
      const route = data.routes?.[0];
      const leg = route?.legs?.[0];
      return res.json({
        success: true,
        status: data.status,
        testRoute: {
          from: 'Chicago, IL',
          to: 'Milwaukee, WI',
          distance: leg?.distance?.text,
          duration: leg?.duration?.text
        },
        message: '✅ Google Directions API is working correctly!'
      });
    } else {
      // API returned an error
      let troubleshooting = [];
      let diagnosis = '';

      const errorMsg = (data?.error_message || '').toLowerCase();

      if (errorMsg.includes('referer restriction')) {
        diagnosis = 'YOUR API KEY HAS HTTP REFERRER RESTRICTIONS - This prevents server-side use!';
        troubleshooting = [
          '⚠️ THE PROBLEM: Your API key has "HTTP referrers" restriction which ONLY works in browsers.',
          '',
          'TO FIX - Go to Google Cloud Console:',
          '1. https://console.cloud.google.com/apis/credentials',
          '2. Click on your API key (the one ending in: ...' + GOOGLE_MAPS_API_KEY?.slice(-8) + ')',
          '3. Under "Application restrictions" section:',
          '   - Change FROM: "HTTP referrers (web sites)"',
          '   - Change TO: "None" (or "IP addresses" if you want to restrict by server IP)',
          '4. Click SAVE',
          '5. Wait 5 minutes for changes to propagate',
          '6. Retry the route optimization',
          '',
          'ALTERNATIVE: Create a NEW API key specifically for server use:',
          '1. Click "Create Credentials" → "API Key"',
          '2. Set "Application restrictions" to "None"',
          '3. Set "API restrictions" to "Directions API" only',
          '4. Update your .env file with the new key'
        ];
      } else if (data?.status === 'REQUEST_DENIED') {
        diagnosis = 'API request was denied - check API enablement and restrictions';
        troubleshooting = [
          '1. Go to Google Cloud Console: https://console.cloud.google.com/',
          '2. APIs & Services → Library → Search "Directions API" → ENABLE it',
          '3. APIs & Services → Credentials → Click your API key',
          '4. Under "API restrictions": Add "Directions API" or select "Don\'t restrict key"',
          '5. Under "Application restrictions": Select "None" for server use',
          '6. Billing → Make sure billing is enabled (required even for free tier)'
        ];
      } else if (data?.status === 'OVER_QUERY_LIMIT') {
        diagnosis = 'API quota exceeded';
        troubleshooting = [
          '1. Check your Google Cloud billing status',
          '2. You may have exceeded your daily quota',
          '3. Wait a few minutes and try again'
        ];
      }

      return res.json({
        success: false,
        status: data?.status,
        errorMessage: data?.error_message,
        diagnosis,
        apiKeyUsed: '...' + GOOGLE_MAPS_API_KEY?.slice(-8),
        troubleshooting
      });
    }
  } catch (e) {
    console.error('[TEST] Request failed:', e?.message);
    return res.json({
      success: false,
      error: 'Failed to connect to Google API',
      details: e?.message
    });
  }
});

// ─── ROUTE BUILDER / DAY PLANNER ────────────────────────────────────────────

// POST /route-builder/find-nearby — find unscheduled WOs near an anchor
app.post('/route-builder/find-nearby', authenticate, async (req, res) => {
  try {
    console.log('[Route Builder] ===== Find Nearby Started =====');
    const b = coerceBody(req);
    const anchorId = b.anchorWorkOrderId ? Number(b.anchorWorkOrderId) : null;
    const maxMinutes = Math.min(Number(b.maxDriveMinutes) || 60, 120);
    let anchorAddress = '';
    let anchorInfo = {};

    console.log('[Route Builder] Anchor work order ID:', anchorId);
    console.log('[Route Builder] Max drive minutes:', maxMinutes);

    // Resolve anchor address — also pull customer address fields as fallback
    if (anchorId) {
      const [[row]] = await db.execute(
        `SELECT w.id, w.workOrderNumber, w.customer, w.siteAddress, w.siteLocation, w.customerId,
                c.siteAddress AS custSiteAddress, c.siteCity AS custSiteCity,
                c.siteState AS custSiteState, c.siteZip AS custSiteZip
           FROM work_orders w
           LEFT JOIN customers c ON w.customerId = c.id
          WHERE w.id = ?`,
        [anchorId]
      );
      if (!row) return res.status(404).json({ error: 'Anchor work order not found.' });

      // Build best address: prefer WO siteAddress, then siteLocation, then customer fields
      anchorAddress = cleanAddr(row.siteAddress || row.siteLocation || '');
      if (!anchorAddress || anchorAddress.length < 5) {
        const custFull = [row.custSiteAddress, row.custSiteCity, row.custSiteState, row.custSiteZip].filter(Boolean).join(', ');
        if (custFull) anchorAddress = cleanAddr(custFull);
      }
      anchorInfo = { workOrderId: row.id, workOrderNumber: row.workOrderNumber, customer: row.customer, address: anchorAddress };
      console.log('[Route Builder] Anchor WO:', row.workOrderNumber, '| siteAddress:', row.siteAddress, '| siteLocation:', row.siteLocation);
      console.log('[Route Builder] Resolved anchor address:', anchorAddress);
    } else if (b.anchorAddress) {
      anchorAddress = cleanAddr(b.anchorAddress);
      anchorInfo = { workOrderId: null, address: anchorAddress };
      console.log('[Route Builder] Using provided anchor address:', anchorAddress);
    }

    if (!anchorAddress) {
      console.log('[Route Builder] ERROR: No valid anchor address');
      return res.status(400).json({ error: 'No valid anchor address provided.' });
    }

    // FIX: Fetch ALL work orders (not just exact status match) then filter using canonStatus()
    // The DB may store status variants like "Parts In", "NS", "needs to be scheduled", etc.
    const [allWOs] = await db.execute(
      `SELECT w.id, w.workOrderNumber, w.poNumber, w.customer, w.siteLocation, w.siteAddress,
              w.problemDescription, w.status, w.customerId,
              c.siteAddress AS custSiteAddress, c.siteCity AS custSiteCity,
              c.siteState AS custSiteState, c.siteZip AS custSiteZip
         FROM work_orders w
         LEFT JOIN customers c ON w.customerId = c.id
        ORDER BY w.id DESC`
    );

    // Filter to "Needs to be Scheduled" using canonical status normalization
    const candidates = allWOs.filter(r => {
      const canon = canonStatus(r.status);
      return canon === 'Needs to be Scheduled';
    });

    console.log('[Route Builder] Total work orders in DB:', allWOs.length);
    console.log('[Route Builder] Distinct raw statuses:', [...new Set(allWOs.map(r => r.status))].join(', '));
    console.log('[Route Builder] "Needs to be Scheduled" (after canonStatus):', candidates.length);
    if (candidates.length > 0 && candidates.length <= 5) {
      candidates.forEach(c => console.log(`[Route Builder]   WO #${c.workOrderNumber || c.id}: siteAddr="${c.siteAddress}", siteLoc="${c.siteLocation}", custAddr="${c.custSiteAddress}, ${c.custSiteCity}, ${c.custSiteState}"`));
    } else if (candidates.length > 5) {
      candidates.slice(0, 5).forEach(c => console.log(`[Route Builder]   WO #${c.workOrderNumber || c.id}: siteAddr="${c.siteAddress}", siteLoc="${c.siteLocation}", custAddr="${c.custSiteAddress}, ${c.custSiteCity}, ${c.custSiteState}"`));
      console.log(`[Route Builder]   ... and ${candidates.length - 5} more`);
    }

    // Build full address for each candidate, using customer fields as fallback
    const anchorLower = anchorAddress.toLowerCase();
    const withAddr = [];
    let skippedNoAddress = 0;
    for (const c of candidates) {
      // Try WO fields first, then build from customer address fields
      let addr = cleanAddr(c.siteAddress || c.siteLocation || '');
      if (!addr || addr.length < 5) {
        const custFull = [c.custSiteAddress, c.custSiteCity, c.custSiteState, c.custSiteZip].filter(Boolean).join(', ');
        if (custFull) addr = cleanAddr(custFull);
      }
      if (!addr || addr.length < 5) { skippedNoAddress++; continue; }
      if (addr.toLowerCase() === anchorLower) continue;
      if (anchorId && c.id === anchorId) continue;
      withAddr.push({ ...c, _addr: addr });
    }

    console.log('[Route Builder] Candidates with valid addresses:', withAddr.length);
    console.log('[Route Builder] Skipped (no address):', skippedNoAddress);

    if (withAddr.length === 0) {
      console.log('[Route Builder] No candidates with addresses — returning empty tiers');
      return res.json({
        ok: true, anchor: anchorInfo,
        tiers: { closest: [], near: [], moderate: [], further: [] },
        totalCandidates: 0, skippedNoAddress, maxDriveMinutes: maxMinutes,
      });
    }

    // Calculate drive times — try Distance Matrix first, fallback to haversine
    const results = [];
    let method = 'none';
    let distanceMatrixFailed = false;

    if (GOOGLE_MAPS_API_KEY) {
      console.log('[Route Builder] API Key exists: true, length:', GOOGLE_MAPS_API_KEY.length);
      console.log('[Route Builder] Attempting Distance Matrix API...');
      const BATCH = 25;
      for (let i = 0; i < withAddr.length; i += BATCH) {
        const batch = withAddr.slice(i, i + BATCH);
        const destinations = batch.map(c => c._addr).join('|');
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
          + `?origins=${encodeURIComponent(anchorAddress)}`
          + `&destinations=${encodeURIComponent(destinations)}`
          + `&mode=driving&units=imperial`
          + `&key=${GOOGLE_MAPS_API_KEY}`;

        console.log(`[Route Builder] Distance Matrix batch ${Math.floor(i / BATCH) + 1}: ${batch.length} destinations`);
        console.log('[Route Builder]   Origin:', anchorAddress);
        if (batch.length <= 3) {
          batch.forEach(c => console.log(`[Route Builder]   Dest: "${c._addr}"`));
        }

        try {
          const resp = await axios.get(url, { timeout: Number(ROUTE_TIMEOUT_MS) || 20000 });
          const data = resp?.data;
          console.log('[Route Builder]   API response status:', data?.status);

          if (data?.status === 'OK' && data.rows?.[0]?.elements) {
            method = 'distance_matrix';
            const elements = data.rows[0].elements;
            let okCount = 0, failCount = 0;
            for (let j = 0; j < batch.length; j++) {
              const el = elements[j];
              if (el?.status === 'OK') {
                okCount++;
                const mins = Math.round((el.duration?.value || 0) / 60);
                results.push({
                  id: batch[j].id, workOrderNumber: batch[j].workOrderNumber,
                  poNumber: batch[j].poNumber, customer: batch[j].customer,
                  siteAddress: batch[j]._addr, siteLocation: batch[j].siteLocation,
                  problemDescription: batch[j].problemDescription,
                  driveMinutes: mins,
                  driveDistanceMeters: el.distance?.value || 0,
                  driveDistanceText: el.distance?.text || '',
                  driveDurationText: el.duration?.text || '',
                });
              } else {
                failCount++;
                console.log(`[Route Builder]   Element ${j} status: ${el?.status} for "${batch[j]._addr}"`);
              }
            }
            console.log(`[Route Builder]   Batch results: ${okCount} OK, ${failCount} failed`);
          } else {
            console.warn(`[Route Builder]   API returned non-OK status: ${data?.status}, error: ${data?.error_message || 'none'}`);
            distanceMatrixFailed = true;
          }
        } catch (e) {
          console.warn(`[Route Builder]   Distance Matrix batch error: ${e?.message}`);
          distanceMatrixFailed = true;
        }
      }
    }

    // Fallback: haversine estimate if no API key OR Distance Matrix failed with no results
    if (results.length === 0) {
      console.log('[Route Builder] Distance Matrix produced 0 results — falling back to haversine estimate');
      if (GOOGLE_MAPS_API_KEY) {
        // Try geocoding + haversine with 1.4x multiplier for road distance
        const anchorCoords = await geocodeAddress(anchorAddress);
        console.log('[Route Builder] Anchor geocode:', anchorCoords ? `${anchorCoords.lat},${anchorCoords.lng}` : 'FAILED');
        if (anchorCoords) {
          method = 'haversine_estimate';
          for (const c of withAddr) {
            const coords = await geocodeAddress(c._addr);
            if (coords) {
              const straightMiles = haversineDistance(anchorCoords.lat, anchorCoords.lng, coords.lat, coords.lng);
              const estMiles = straightMiles * 1.4; // road distance ~1.4x straight-line
              const mins = Math.round((estMiles / 30) * 60);
              results.push({
                id: c.id, workOrderNumber: c.workOrderNumber, poNumber: c.poNumber,
                customer: c.customer, siteAddress: c._addr, siteLocation: c.siteLocation,
                problemDescription: c.problemDescription,
                driveMinutes: mins, driveDistanceMeters: Math.round(estMiles * 1609.34),
                driveDistanceText: estMiles.toFixed(1) + ' mi', driveDurationText: mins + ' mins',
              });
            }
          }
          console.log('[Route Builder] Haversine results:', results.length);
        }
      } else {
        console.log('[Route Builder] No API key — trying geocode fallback');
        const anchorCoords = await geocodeAddress(anchorAddress);
        if (anchorCoords) {
          method = 'haversine_estimate';
          for (const c of withAddr) {
            const coords = await geocodeAddress(c._addr);
            if (coords) {
              const straightMiles = haversineDistance(anchorCoords.lat, anchorCoords.lng, coords.lat, coords.lng);
              const estMiles = straightMiles * 1.4;
              const mins = Math.round((estMiles / 30) * 60);
              results.push({
                id: c.id, workOrderNumber: c.workOrderNumber, poNumber: c.poNumber,
                customer: c.customer, siteAddress: c._addr, siteLocation: c.siteLocation,
                problemDescription: c.problemDescription,
                driveMinutes: mins, driveDistanceMeters: Math.round(estMiles * 1609.34),
                driveDistanceText: estMiles.toFixed(1) + ' mi', driveDurationText: mins + ' mins',
              });
            }
          }
          console.log('[Route Builder] Haversine results:', results.length);
        }
      }
    }

    console.log('[Route Builder] Total results with drive times:', results.length, '| method:', method);

    // Group into tiers
    const tiers = { closest: [], near: [], moderate: [], further: [] };
    for (const r of results) {
      if (r.driveMinutes > maxMinutes) continue;
      if (r.driveMinutes < 15) tiers.closest.push(r);
      else if (r.driveMinutes < 30) tiers.near.push(r);
      else if (r.driveMinutes < 45) tiers.moderate.push(r);
      else tiers.further.push(r);
    }
    for (const key of Object.keys(tiers)) {
      tiers[key].sort((a, b) => a.driveMinutes - b.driveMinutes);
    }

    const totalInTiers = tiers.closest.length + tiers.near.length + tiers.moderate.length + tiers.further.length;
    const beyondMax = results.length - totalInTiers;
    console.log(`[Route Builder] Tiers: closest=${tiers.closest.length}, near=${tiers.near.length}, moderate=${tiers.moderate.length}, further=${tiers.further.length}`);
    if (beyondMax > 0) console.log(`[Route Builder] ${beyondMax} results beyond ${maxMinutes} min max`);
    console.log('[Route Builder] ===== Find Nearby Complete =====');

    let warning;
    if (method === 'haversine_estimate') {
      warning = 'Using estimated drive times (straight-line distance). Actual drive times may differ.';
    } else if (distanceMatrixFailed && results.length > 0) {
      warning = 'Some Distance Matrix API calls failed. Results may be incomplete.';
    }

    res.json({
      ok: true, anchor: anchorInfo, tiers,
      totalCandidates: withAddr.length, skippedNoAddress,
      maxDriveMinutes: maxMinutes, method,
      warning,
    });
  } catch (err) {
    console.error('[Route Builder] Error in find-nearby:', err);
    res.status(500).json({ error: 'Failed to find nearby work orders.' });
  }
});

// POST /route-builder/confirm-route — bulk schedule work orders
app.post('/route-builder/confirm-route', authenticate, async (req, res) => {
  try {
    const b = coerceBody(req);
    const ids = Array.isArray(b.workOrderIds) ? b.workOrderIds.map(Number).filter(n => n > 0) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'No work order IDs provided.' });

    const rawDate = String(b.scheduledDate || '').trim();
    if (!rawDate) return res.status(400).json({ error: 'scheduledDate is required.' });

    const scheduledDate = parseDateTimeFlexible(rawDate);
    if (!scheduledDate) return res.status(400).json({ error: 'Invalid scheduledDate format.' });

    const scheduledEnd = addMinutesToSql(scheduledDate, DEFAULT_WINDOW);
    const assignedTo = b.assignedTo ? Number(b.assignedTo) : null;

    const updated = [];
    const skipped = [];

    for (const id of ids) {
      const [[current]] = await db.execute('SELECT id, status FROM work_orders WHERE id = ?', [id]);
      if (!current) { skipped.push({ id, reason: 'not found' }); continue; }

      await db.execute(
        `UPDATE work_orders SET status = 'Scheduled', scheduledDate = ?, scheduledEnd = ?, assignedTo = ? WHERE id = ?`,
        [scheduledDate, scheduledEnd, assignedTo, id]
      );
      updated.push(id);
    }

    // Fetch updated rows
    let workOrders = [];
    if (updated.length > 0) {
      const placeholders = updated.map(() => '?').join(',');
      const [rows] = await db.execute(
        `SELECT id, workOrderNumber, customer, siteAddress, siteLocation, status, scheduledDate, assignedTo
         FROM work_orders WHERE id IN (${placeholders})`, updated
      );
      workOrders = rows;
    }

    res.json({ ok: true, updated: updated.length, skipped, scheduledDate, assignedTo, workOrders });
  } catch (err) {
    console.error('Error in confirm-route:', err);
    res.status(500).json({ error: 'Failed to confirm route.' });
  }
});

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

// ─── PUBLIC PAGES (NO AUTH) ──────────────────────────────────────────────────

function fmtPublicDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtPublicMoney(v) {
  return '$' + (Number(v) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function publicPageShell(title, bodyContent, headerTitle) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#333}
.green-header{background:white;padding:30px 20px;text-align:center;border-bottom:3px solid #1b5e20}
.green-header img{height:100px;margin-bottom:12px}
.green-header h2{color:#1b5e20;font-size:20px;font-weight:600}
.green-header .subtext{color:#666;font-size:14px;margin-top:4px}
.container{max-width:700px;margin:24px auto 40px;padding:0 16px}
.card{background:white;border-radius:12px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,0.1);margin-bottom:20px}
.subtitle{text-align:center;color:#666;margin-bottom:24px;font-size:15px}
.section{margin-bottom:20px}
.section-title{font-size:11px;font-weight:700;color:#1b5e20;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e8f5e9}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.detail-item .label{font-size:12px;color:#999;text-transform:uppercase}
.detail-item .value{font-size:15px;font-weight:500;margin-top:2px}
.detail-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0}
.detail-label{color:#666;font-size:14px}
.detail-value{font-weight:500;font-size:14px}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{background:#e8f5e9;padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#1b5e20;letter-spacing:0.5px}
td{padding:12px;border-bottom:1px solid #f0f0f0;font-size:14px}
th:last-child,td:last-child{text-align:right}
.total-row{text-align:right;padding:20px 0;border-top:3px solid #1b5e20;font-size:22px;font-weight:700;color:#1b5e20}
.buttons{display:flex;gap:16px;justify-content:center;margin-top:24px;flex-wrap:wrap}
.btn{padding:14px 36px;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;border:none;transition:all 0.2s;text-decoration:none;display:inline-block;text-align:center;min-width:180px}
.btn-accept{background:#1b5e20;color:white}
.btn-accept:hover{background:#2e7d32;transform:translateY(-1px);box-shadow:0 4px 12px rgba(27,94,32,0.3)}
.btn-decline{background:white;color:#c62828;border:2px solid #c62828}
.btn-decline:hover{background:#ffebee}
.btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
.status-badge{display:inline-block;padding:6px 16px;border-radius:20px;font-size:14px;font-weight:600}
.status-accepted{background:#e8f5e9;color:#1b5e20}
.status-declined{background:#ffebee;color:#c62828}
.status-sent{background:#fff8e1;color:#f57f17}
.status-paid{background:#e8f5e9;color:#1b5e20}
.status-overdue{background:#ffebee;color:#c62828}
.notes-input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-top:8px;resize:vertical;min-height:60px;font-family:inherit}
.page-footer{text-align:center;color:#999;font-size:12px;padding:20px}
.msg{text-align:center;padding:40px;font-size:16px}
.msg.success{color:#1b5e20}
.msg.error{color:#c62828}
.contact-card{text-align:center;border:2px solid #e8f5e9;border-radius:12px;padding:28px;margin-top:24px}
.contact-card .contact-title{font-size:18px;font-weight:600;color:#1b5e20;margin-bottom:8px}
.contact-card .contact-desc{color:#666;font-size:14px;margin-bottom:16px}
.contact-card .contact-phone{font-size:20px;font-weight:700;color:#1b5e20;margin-bottom:8px}
.contact-card .contact-email{color:#666;font-size:13px}
.contact-card .contact-note{color:#999;font-size:12px;margin-top:16px}
@media(max-width:600px){.buttons{flex-direction:column}.btn{width:100%}.detail-grid{grid-template-columns:1fr}.card{padding:20px}.green-header{padding:30px 16px 20px}.green-header img{height:80px}}
</style>
</head><body>
<div class="green-header">
<img src="/assets/logo-green" alt="First Class Glass & Mirror" onerror="this.style.display='none'">
<h2>First Class Glass &amp; Mirror, Inc.</h2>
<div class="subtext">1513 Industrial Drive, Itasca, IL 60143 | 630-250-9777</div>
</div>
<div class="container">
${bodyContent}
<div class="page-footer">First Class Glass &amp; Mirror, Inc. | 1513 Industrial Drive, Itasca, IL 60143 | 630-250-9777</div>
</div>
</body></html>`;
}

// GET /public/estimate/:token — view estimate + accept/decline
app.get('/public/estimate/:token', async (req, res) => {
  try {
    const [[tok]] = await db.query(
      "SELECT * FROM public_tokens WHERE token = ? AND type = 'estimate_review' AND expiresAt > NOW()",
      [req.params.token]
    );
    if (!tok) return res.status(404).send(publicPageShell('Estimate Not Found',
      '<div class="card"><div class="msg error">This estimate link has expired or is no longer valid.</div></div>'));

    const [[est]] = await db.query(`
      SELECT e.*, c.companyName, c.name AS custName
      FROM estimates e LEFT JOIN customers c ON e.customerId = c.id
      WHERE e.id = ?
    `, [tok.estimateId]);
    if (!est) return res.status(404).send(publicPageShell('Estimate Not Found',
      '<div class="card"><div class="msg error">Estimate not found.</div></div>'));

    const [lineItems] = await db.query('SELECT * FROM estimate_line_items WHERE estimateId = ? ORDER BY sortOrder ASC, id ASC', [tok.estimateId]);

    const alreadyResponded = est.status === 'Accepted' || est.status === 'Declined';
    const statusBadge = alreadyResponded
      ? `<div style="text-align:center;margin:20px 0"><span class="status-badge ${est.status === 'Accepted' ? 'status-accepted' : 'status-declined'}" style="font-size:16px;padding:10px 24px">${est.status === 'Accepted' ? '✓ Estimate Accepted' : '✗ Estimate Declined'}</span></div>`
      : '';

    const lineItemsHtml = lineItems.map(li =>
      `<tr><td>${escHtml(li.quantity)}</td><td>${escHtml(li.description)}</td><td>${fmtPublicMoney(li.amount)}</td></tr>`
    ).join('');

    const actionsHtml = alreadyResponded ? '' : `
      <div style="margin-top:24px">
        <div class="section-title">Notes (optional)</div>
        <textarea id="notes" class="notes-input" placeholder="Add any notes or comments..."></textarea>
      </div>
      <div class="buttons">
        <button class="btn btn-accept" onclick="respond('accepted')">Accept Estimate</button>
        <button class="btn btn-decline" onclick="respond('declined')">Decline Estimate</button>
      </div>
      <script>
        var _submitting = false;
        async function respond(response) {
          if (_submitting) return;
          _submitting = true;
          var notes = document.getElementById('notes').value;
          var btns = document.querySelectorAll('.btn');
          btns.forEach(function(b){b.disabled=true;b.style.opacity='0.5'});
          try {
            var res = await fetch('/public/estimate/${req.params.token}/respond', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body:JSON.stringify({response:response,notes:notes})
            });
            var data = await res.json();
            if (data.success) {
              document.querySelector('.buttons').innerHTML =
                response === 'accepted'
                  ? '<span class="status-badge status-accepted" style="font-size:18px;padding:12px 24px">✓ Estimate Accepted — Thank you!</span>'
                  : '<span class="status-badge status-declined" style="font-size:18px;padding:12px 24px">Estimate Declined</span>';
              var noteDiv = document.querySelector('.notes-input');
              if(noteDiv && noteDiv.parentNode) noteDiv.parentNode.style.display='none';
            } else { alert(data.error||'Error'); _submitting=false; btns.forEach(function(b){b.disabled=false;b.style.opacity='1'}); }
          } catch(e) { alert('Error submitting response. Please try again.'); _submitting=false; btns.forEach(function(b){b.disabled=false;b.style.opacity='1'}); }
        }
      </script>
    `;

    res.send(publicPageShell('Estimate from First Class Glass & Mirror', `
      <div class="card">
        <div class="subtitle" style="margin-top:8px">Date: ${fmtPublicDate(est.issueDate)}${est.poNumber ? ' | P.O. #' + escHtml(est.poNumber) : ''}</div>
        ${statusBadge}
        <div class="section">
          <div class="section-title">Customer</div>
          <div class="detail-grid">
            <div class="detail-item"><div class="label">Company</div><div class="value">${escHtml(est.companyName || est.custName || '')}</div></div>
            <div class="detail-item"><div class="label">Project</div><div class="value">${escHtml(est.projectName || '')}</div></div>
            <div class="detail-item" style="grid-column:1/-1"><div class="label">Location</div><div class="value">${escHtml([est.projectAddress, est.projectCity, est.projectState, est.projectZip].filter(Boolean).join(', ') || 'N/A')}</div></div>
          </div>
        </div>
        <div class="section-title">Line Items</div>
        <table>
          <thead><tr><th>Qty</th><th>Description</th><th>Amount</th></tr></thead>
          <tbody>${lineItemsHtml}</tbody>
        </table>
        ${est.taxAmount && Number(est.taxAmount) > 0 ? `<div class="detail-row"><span class="detail-label">Subtotal</span><span class="detail-value">${fmtPublicMoney(est.subtotal)}</span></div><div class="detail-row"><span class="detail-label">Tax</span><span class="detail-value">${fmtPublicMoney(est.taxAmount)}</span></div>` : ''}
        <div class="total-row">Total: ${fmtPublicMoney(est.total)}</div>
        ${actionsHtml}
      </div>
    `, 'ESTIMATE'));
  } catch (err) {
    console.error('Error rendering public estimate:', err);
    res.status(500).send(publicPageShell('Error', '<div class="card"><div class="msg error">An error occurred. Please try again later.</div></div>'));
  }
});

// POST /public/estimate/:token/respond — accept or decline
app.post('/public/estimate/:token/respond', async (req, res) => {
  try {
    const [[tok]] = await db.query(
      "SELECT * FROM public_tokens WHERE token = ? AND type = 'estimate_review' AND expiresAt > NOW()",
      [req.params.token]
    );
    if (!tok) return res.status(404).json({ error: 'Token expired or invalid.' });

    const { response, notes } = req.body || {};
    if (!response || !['accepted', 'declined'].includes(response)) {
      return res.status(400).json({ error: 'Invalid response.' });
    }

    const newStatus = response === 'accepted' ? 'Accepted' : 'Declined';

    // ═══════════════════════════════════════════════════════════════════════
    // Mark token as used IMMEDIATELY — this is the real race-condition lock
    // ═══════════════════════════════════════════════════════════════════════
    const [tokenLock] = await db.query(
      "UPDATE public_tokens SET usedAt=NOW() WHERE id=? AND usedAt IS NULL",
      [tok.id]
    );

    if (tokenLock.affectedRows === 0) {
      // Another request already claimed this token
      console.log('[Public] Token already used — duplicate request blocked');
      const [[est]] = await db.query('SELECT status FROM estimates WHERE id = ?', [tok.estimateId]);
      return res.json({ success: true, status: est?.status || newStatus, message: 'Already responded' });
    }

    // Token claimed — now update estimate status
    const [updateResult] = await db.query(
      "UPDATE estimates SET status=?, updatedAt=NOW() WHERE id=? AND status NOT IN ('Accepted','Declined')",
      [newStatus, tok.estimateId]
    );

    // Save response details on the token
    try {
      await db.query('UPDATE public_tokens SET response=?, responseNotes=?, respondedAt=NOW() WHERE id=?',
        [response, notes || null, tok.id]);
    } catch (e) { /* non-fatal */ }

    if (updateResult.affectedRows === 0) {
      // Estimate was already accepted or declined — do NOT send another email
      console.log('[Public] Estimate', tok.estimateId, 'already has final status. Skipping. (token:', req.params.token.substring(0, 8) + '...)');
      const [[est]] = await db.query('SELECT status FROM estimates WHERE id = ?', [tok.estimateId]);
      return res.json({ success: true, status: est?.status || newStatus, message: 'Already responded' });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // If we reach here, THIS request is the ONE that changed the status.
    // Only THIS request sends the notification email.
    // ═══════════════════════════════════════════════════════════════════════
    console.log('[Public] Processing estimate response:', response, 'for estimateId:', tok.estimateId, '(this request won the race)');

    // Mark ALL tokens for this estimate as used (prevents other email links from triggering)
    try {
      await db.query("UPDATE public_tokens SET usedAt=COALESCE(usedAt,NOW()), response=COALESCE(response,?) WHERE estimateId=? AND type='estimate_review'",
        [response, tok.estimateId]);
    } catch (e) { /* non-fatal */ }

    // If accepted, update work order to Approved
    try {
      if (response === 'accepted') {
        const [[est]] = await db.query('SELECT id, workOrderId, status FROM estimates WHERE id = ?', [tok.estimateId]);
        const woId = est?.workOrderId;
        console.log('[DEBUG] Estimate row:', JSON.stringify(est));
        console.log('[DEBUG] woId resolved to:', woId);
        if (woId) {
          const [woResult] = await db.query("UPDATE work_orders SET status='Approved' WHERE id=?", [woId]);
          console.log('[DEBUG] WO update affectedRows:', woResult.affectedRows);
        } else {
          console.log('[DEBUG] No workOrderId on estimate — work order NOT updated');
        }
      }
    } catch (woErr) {
      console.error('[Public Estimate] Work order update FAILED:', woErr.message, woErr.stack);
    }

    // Send exactly ONE notification email
    try {
      const [[est]] = await db.query(`
        SELECT e.*, c.companyName, c.name AS custName
        FROM estimates e LEFT JOIN customers c ON e.customerId = c.id WHERE e.id = ?
      `, [tok.estimateId]);
      const { transport, settings } = await createEmailTransport();
      const custLabel = est.companyName || est.custName || tok.recipientEmail;
      await transport.sendMail({
        from: `"CRM Notification" <${settings.senderEmail}>`,
        to: settings.senderEmail,
        subject: `Estimate ${newStatus} — ${custLabel} — ${est.projectName || 'N/A'}`,
        text: `${custLabel} has ${response} the estimate for ${est.projectName || 'N/A'}.\n\nTotal: $${Number(est.total || 0).toFixed(2)}\nDate: ${new Date().toLocaleString()}\n${notes ? 'Customer Notes: ' + notes : ''}`,
      });
      console.log('[Public] Notification email sent for estimate', tok.estimateId, '- response:', response);
    } catch (emailErr) {
      console.warn('[Public] Failed to send notification email (non-fatal):', emailErr.message);
    }

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error('[Public] Error processing estimate response:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to process response.' });
  }
});

// GET /public/invoice/:token — view invoice + pay
app.get('/public/invoice/:token', async (req, res) => {
  try {
    const [[tok]] = await db.query(
      "SELECT * FROM public_tokens WHERE token = ? AND type = 'invoice_payment' AND expiresAt > NOW()",
      [req.params.token]
    );
    if (!tok) return res.status(404).send(publicPageShell('Invoice Not Found',
      '<div class="card"><div class="msg error">This invoice link has expired or is no longer valid.</div></div>'));

    const [[inv]] = await db.query(`
      SELECT i.*, c.companyName, c.name AS custName
      FROM invoices i LEFT JOIN customers c ON i.customerId = c.id
      WHERE i.id = ?
    `, [tok.invoiceId]);
    if (!inv) return res.status(404).send(publicPageShell('Invoice Not Found',
      '<div class="card"><div class="msg error">Invoice not found.</div></div>'));

    const [lineItems] = await db.query('SELECT * FROM invoice_line_items WHERE invoiceId = ? ORDER BY sortOrder ASC, id ASC', [tok.invoiceId]);

    const isPaid = inv.status === 'Paid';
    const balanceDue = Number(inv.balanceDue ?? inv.total) || 0;
    const isOverdue = inv.dueDate && new Date(inv.dueDate) < new Date() && !isPaid;

    const paymentSuccess = req.query.payment === 'success';

    let statusHtml = '';
    if (isPaid || paymentSuccess) {
      statusHtml = `<div style="text-align:center;margin:20px 0"><span class="status-badge status-paid" style="font-size:16px;padding:10px 24px">✓ Paid${inv.paidAt ? ' on ' + fmtPublicDate(inv.paidAt) : ''} — Thank you!</span></div>`;
    } else if (isOverdue) {
      statusHtml = `<div style="text-align:center;margin:20px 0"><span class="status-badge status-overdue" style="font-size:16px;padding:10px 24px">Overdue</span></div>`;
    }

    const lineItemsHtml = lineItems.map(li =>
      `<tr><td>${escHtml(li.quantity)}</td><td>${escHtml(li.description)}</td><td>${fmtPublicMoney(li.amount)}</td></tr>`
    ).join('');

    const showContactPay = !isPaid && !paymentSuccess && balanceDue > 0;

    const payHtml = showContactPay ? `
      <div class="contact-card">
        <div class="contact-title">Ready to pay?</div>
        <div class="contact-desc">To arrange payment, please contact us:</div>
        <div class="contact-phone">630-250-9777</div>
        <div class="contact-email">jefflawson360@yahoo.com</div>
        <div class="contact-note">We accept checks, ACH bank transfers, and credit cards.<br>Online payment coming soon.</div>
      </div>
    ` : '';

    res.send(publicPageShell('Invoice from First Class Glass & Mirror', `
      <div class="card">
        <div class="subtitle" style="margin-top:8px">Date: ${fmtPublicDate(inv.issueDate)}${inv.dueDate ? ' | Due: ' + fmtPublicDate(inv.dueDate) : ''}</div>
        ${statusHtml}
        <div class="section">
          <div class="section-title">Customer</div>
          <div class="detail-grid">
            <div class="detail-item"><div class="label">Company</div><div class="value">${escHtml(inv.companyName || inv.custName || '')}</div></div>
            <div class="detail-item"><div class="label">Project</div><div class="value">${escHtml(inv.projectName || inv.shipToName || '')}</div></div>
            <div class="detail-item" style="grid-column:1/-1"><div class="label">Location</div><div class="value">${escHtml([inv.shipToAddress || inv.projectAddress, inv.shipToCity || inv.projectCity, inv.shipToState || inv.projectState, inv.shipToZip || inv.projectZip].filter(Boolean).join(', ') || 'N/A')}</div></div>
            ${inv.poNumber ? `<div class="detail-item"><div class="label">P.O. #</div><div class="value">${escHtml(inv.poNumber)}</div></div>` : ''}
          </div>
        </div>
        <div class="section-title">Line Items</div>
        <table>
          <thead><tr><th>Qty</th><th>Description</th><th>Amount</th></tr></thead>
          <tbody>${lineItemsHtml}</tbody>
        </table>
        ${inv.taxAmount && Number(inv.taxAmount) > 0 ? `<div class="detail-row"><span class="detail-label">Subtotal</span><span class="detail-value">${fmtPublicMoney(inv.subtotal)}</span></div><div class="detail-row"><span class="detail-label">Tax</span><span class="detail-value">${fmtPublicMoney(inv.taxAmount)}</span></div>` : ''}
        <div class="total-row">Total: ${fmtPublicMoney(inv.total)}</div>
        ${!isPaid && !paymentSuccess && balanceDue > 0 && balanceDue !== Number(inv.total) ? `<div style="text-align:right;font-size:16px;font-weight:600;color:#c62828;margin-top:8px">Balance Due: ${fmtPublicMoney(balanceDue)}</div>` : ''}
        ${inv.terms ? `<div class="section" style="margin-top:16px"><div class="section-title">Terms</div><p style="font-size:13px;color:#666;line-height:1.5">${escHtml(inv.terms)}</p></div>` : ''}
        ${payHtml}
      </div>
    `, `INVOICE #${escHtml(inv.invoiceNumber)}`));
  } catch (err) {
    console.error('Error rendering public invoice:', err);
    res.status(500).send(publicPageShell('Error', '<div class="card"><div class="msg error">An error occurred. Please try again later.</div></div>'));
  }
});

// POST /public/invoice/:token/pay — create Stripe Checkout Session with card or ACH
app.post('/public/invoice/:token/pay', async (req, res) => {
  try {
    const [[tok]] = await db.query(
      "SELECT * FROM public_tokens WHERE token = ? AND type = 'invoice_payment' AND expiresAt > NOW()",
      [req.params.token]
    );
    if (!tok) return res.status(404).json({ error: 'This payment link has expired or is no longer valid.' });

    const [[inv]] = await db.query(`
      SELECT i.*, c.companyName, c.name AS custName
      FROM invoices i LEFT JOIN customers c ON i.customerId = c.id WHERE i.id = ?
    `, [tok.invoiceId]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

    if (inv.status === 'Paid') return res.json({ url: `/public/invoice/${req.params.token}?payment=success` });

    const paymentMethod = req.body?.paymentMethod || 'card';
    const stripe = await getStripeInstance();
    const balanceDue = Number(inv.balanceDue ?? inv.total) || 0;
    const appUrl = await getAppPublicUrl(req);

    // Calculate processing fee
    let processingFee;
    let paymentMethodTypes;
    if (paymentMethod === 'ach') {
      processingFee = Math.round(Math.min(balanceDue * 0.008, 5.00) * 100) / 100;
      paymentMethodTypes = ['us_bank_account'];
    } else {
      processingFee = Math.round((balanceDue * 0.029 + 0.30) * 100) / 100;
      paymentMethodTypes = ['card'];
    }
    const totalCharge = Math.round((balanceDue + processingFee) * 100) / 100;

    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Invoice #${inv.invoiceNumber} — First Class Glass & Mirror`,
            description: inv.projectName || inv.shipToName || 'Services rendered',
          },
          unit_amount: Math.round(balanceDue * 100),
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Processing Fee',
            description: paymentMethod === 'ach' ? 'ACH processing fee (0.8%, max $5)' : 'Card processing fee (2.9% + $0.30)',
          },
          unit_amount: Math.round(processingFee * 100),
        },
        quantity: 1,
      },
    ];

    const sessionParams = {
      payment_method_types: paymentMethodTypes,
      line_items: lineItems,
      mode: 'payment',
      success_url: `${appUrl}/public/invoice/${req.params.token}?payment=success`,
      cancel_url: `${appUrl}/public/invoice/${req.params.token}`,
      customer_email: tok.recipientEmail || undefined,
      metadata: {
        invoiceId: String(inv.id),
        invoiceNumber: inv.invoiceNumber || '',
        token: req.params.token,
        paymentMethod,
        processingFee: String(processingFee),
        invoiceAmount: String(balanceDue),
      },
    };

    // ACH requires additional options
    if (paymentMethod === 'ach') {
      sessionParams.payment_method_options = {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] },
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Record pending payment
    await db.query(
      'INSERT INTO payments (invoiceId, amount, paymentMethod, stripeSessionId, status, customerEmail) VALUES (?, ?, ?, ?, ?, ?)',
      [inv.id, totalCharge, paymentMethod, session.id, 'pending', tok.recipientEmail || null]
    );

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating Stripe session:', err);
    res.status(500).json({ error: 'Failed to start payment: ' + err.message });
  }
});

// ─── STRIPE WEBHOOK HANDLER ────────────────────────────────────────────────
async function handleStripeWebhook(req, res) {
  let event;
  try {
    const stripe = await getStripeInstance();
    const sig = req.headers['stripe-signature'];
    const webhookSecret = STRIPE_WEBHOOK_SECRET || (await (async () => {
      try {
        const [[s]] = await db.query('SELECT stripeWebhookSecret FROM email_settings WHERE id = 1');
        return s?.stripeWebhookSecret || '';
      } catch (e) { return ''; }
    })());

    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // No webhook secret configured, parse raw body
      event = JSON.parse(req.body.toString());
      console.warn('[Stripe] No webhook secret configured — skipping signature verification');
    }
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook verification failed.' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const invoiceId = session.metadata?.invoiceId;
      if (!invoiceId) {
        console.warn('[Stripe] checkout.session.completed without invoiceId in metadata');
        return res.json({ received: true });
      }

      const amountPaid = (session.amount_total || 0) / 100;
      const paymentIntent = session.payment_intent || null;
      const paidVia = session.metadata?.paymentMethod || 'card';

      // Update invoice — paidAmount is the invoice amount (without fee)
      const invoiceAmount = Number(session.metadata?.invoiceAmount || amountPaid);
      await db.query(
        "UPDATE invoices SET status='Paid', paidAt=NOW(), paidAmount=?, stripePaymentIntentId=?, paymentMethod=?, updatedAt=NOW() WHERE id=?",
        [invoiceAmount, paymentIntent, paidVia, invoiceId]
      );

      // Update balanceDue based on the invoice amount (not including processing fee)
      await db.query('UPDATE invoices SET balanceDue = GREATEST(0, COALESCE(total,0) - ?) WHERE id = ?', [invoiceAmount, invoiceId]);

      // Update payment record
      await db.query(
        "UPDATE payments SET status='completed', stripePaymentIntentId=?, paidAt=NOW() WHERE stripeSessionId=?",
        [paymentIntent, session.id]
      );

      // Mark token as used
      if (session.metadata?.token) {
        await db.query('UPDATE public_tokens SET usedAt=NOW() WHERE token=?', [session.metadata.token]);
      }

      // Send notification email
      try {
        const [[inv]] = await db.query(`
          SELECT i.*, c.companyName, c.name AS custName
          FROM invoices i LEFT JOIN customers c ON i.customerId = c.id WHERE i.id = ?
        `, [invoiceId]);
        const { transport, settings } = await createEmailTransport();
        const custLabel = inv?.companyName || inv?.custName || 'Unknown';
        await transport.sendMail({
          from: `"CRM Notification" <${settings.senderEmail}>`,
          to: settings.senderEmail,
          subject: `Payment Received — Invoice #${inv?.invoiceNumber || invoiceId} — ${fmtPublicMoney(amountPaid)}`,
          text: `Payment of ${fmtPublicMoney(amountPaid)} received from ${custLabel} for Invoice #${inv?.invoiceNumber || invoiceId}.\n\nProject: ${inv?.projectName || 'N/A'}\nDate: ${new Date().toLocaleString()}`,
        });
      } catch (emailErr) {
        console.warn('[Stripe] Failed to send payment notification:', emailErr.message);
      }

      console.log(`[Stripe] Payment completed: Invoice #${invoiceId}, $${amountPaid}`);
    }
  } catch (err) {
    console.error('[Stripe] Error processing webhook event:', err);
  }

  res.json({ received: true });
}

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

// ─── AUTO-DECLINE STALE WORK ORDERS ──────────────────────────────────────────
// Move work orders that have been "Waiting for Approval" for 60+ days to "Declined".
const autoDeclineStaleWorkOrders = async () => {
  try {
    const [result] = await db.query(`
      UPDATE work_orders
      SET status = 'Declined', updatedAt = NOW()
      WHERE status = 'Waiting for Approval'
      AND updatedAt <= DATE_SUB(NOW(), INTERVAL 60 DAY)
    `);
    if (result.affectedRows > 0) {
      console.log(`[AutoDecline] Moved ${result.affectedRows} stale work orders to Declined`);
    }
  } catch (err) {
    console.error('[AutoDecline] Failed:', err.message);
  }
};
autoDeclineStaleWorkOrders();
setInterval(autoDeclineStaleWorkOrders, 24 * 60 * 60 * 1000);

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server listening on 0.0.0.0:${PORT}`));

// ===============================
// END Part 6/6
// ===============================
