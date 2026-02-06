// email_ingest_worker.js
// Watches an inbox, extracts vendor WOs safely, and POSTs to your CRM only when rules pass.

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import AWS from 'aws-sdk';
import mime from 'mime-types';

// ── ENV ──────────────────────────────────────────────────────────────────────
const {
  // IMAP (Yahoo example)
  IMAP_HOST = 'imap.mail.yahoo.com',
  IMAP_PORT = '993',
  IMAP_SECURE = 'true',
  IMAP_USER,
  IMAP_PASS,

  // CRM API (your EB API)
  CRM_BASE = 'http://FCGG.us-east-2.elasticbeanstalk.com',
  CRM_TOKEN, // supply a JWT with admin/dispatcher role (or turn on /auth/login here)

  // S3 for temporary uploads (optional; if omitted, we upload files directly to CRM)
  S3_BUCKET,
  AWS_REGION = 'us-east-2',

  // Behavior flags
  POLL_EVERY_SEC = '45',
  DRY_RUN = 'false', // true = never create WOs, just log what it would do
  CONFIDENCE_MIN = '0.75', // threshold (0..1)
} = process.env;

const confidenceMin = Math.max(0, Math.min(1, Number(CONFIDENCE_MIN) || 0.75));
const dryRun = String(DRY_RUN).toLowerCase() === 'true';

if (!IMAP_USER || !IMAP_PASS) {
  console.error('✖ Missing IMAP_USER/IMAP_PASS in env');
  process.exit(1);
}
if (!CRM_TOKEN) {
  console.error('✖ Missing CRM_TOKEN (JWT) in env');
  process.exit(1);
}
if (S3_BUCKET) AWS.config.update({ region: AWS_REGION });
const s3 = new AWS.S3();

// ── UTILS ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (v) => (v ?? '').toString().trim();
const lc = (s) => norm(s).toLowerCase();
const isEmailFrom = (addr, suffixes=[]) => suffixes.some(s => lc(addr).endsWith(lc(s)));

const VENDOR_ALLOWLIST = [
  '@truesource.com',
  '@clearvisionfm.com',
  '@officetrax.com', // CLM
  '@kfm247.com',
  '@1sttimefixed.com',
  '@yahoo.com',
];

function pickFirst(...vals) {
  for (const v of vals) { const s = norm(v); if (s) return s; }
  return '';
}

function parseValueAfter(label, body) {
  // Simple "Label: value" line finder
  const rx = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im');
  const m = rx.exec(body || '');
  return m ? norm(m[1]) : '';
}

function parseAddressBlock(body) {
  // Try common multi-line address block patterns
  // Returns single-line string to store as siteAddress
  const lines = (body || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // crude: find 2 consecutive lines with a street-looking line then city/state/zip
  for (let i=0; i<lines.length-1; i++) {
    const a = lines[i];
    const b = lines[i+1];
    if (/\d{1,5}\s+.+(St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ct|Court)/i.test(a) &&
        /(,?\s*[A-Z]{2}\s*\d{5}(-\d{4})?$)/.test(b)) {
      return `${a}, ${b}`;
    }
  }
  return '';
}

function scoreFields(obj) {
  // simple confidence: count of strong fields present / total
  const strong = ['customer','siteAddress','problemDescription'];
  const idFields = ['workOrderNumber','poNumber'];
  let have = 0, total = strong.length + 1; // +1 for id presence
  strong.forEach(k => { if (norm(obj[k])) have++; });
  if (norm(obj.workOrderNumber) || norm(obj.poNumber)) have++;
  return have / total;
}

function isLikelyPOPdfName(name='') {
  const s = name.toLowerCase();
  return s.includes('po') || s.includes('purchase') || s.startsWith('vendorpo');
}

// ── VENDOR PARSERS ───────────────────────────────────────────────────────────
async function parseTrueSourceEmail(body) {
  const workOrderNumber = parseValueAfter('Work Order', body) || parseValueAfter('WO', body) || '';
  const customer = parseValueAfter('Customer Name', body);
  const siteAddress = parseAddressBlock(body) || parseValueAfter('Site Address', body);
  const siteLocation = parseValueAfter('Site Name', body) || parseValueAfter('Site Store Number', body);
  const problemDescription = parseValueAfter('Description of Work', body) || parseValueAfter('Service Description', body);
  const nte = parseValueAfter('NTE', body).replace(/USD|\$/g,'').trim();

  return {
    vendor: 'TrueSource',
    workOrderNumber, customer, siteAddress, siteLocation,
    problemDescription: problemDescription || '',
    poNumber: '', nte,
  };
}

async function parseClearVisionEmail(body) {
  const workOrderNumber = parseValueAfter('Work Order Number', body).replace(/^#/, '');
  const customer = pickFirst(parseValueAfter('Service Location', body).split('-')[0]);
  const siteAddress = parseAddressBlock(body);
  const problemDescription = pickFirst(
    parseValueAfter('Additional Details', body),
    parseValueAfter('Problem', body)
  );
  const poNumber = parseValueAfter('PO', body);
  const nte = parseValueAfter('NTE', body).replace(/USD|\$/g,'').trim();

  return {
    vendor: 'ClearVision',
    workOrderNumber, customer,
    siteAddress, siteLocation: '', problemDescription,
    poNumber, nte,
  };
}

// PDF parsers (CLM/KFM/1stTimeFix): extract text then regex the blocks
function extractFromPdfText(txt) {
  const get = (labelArr) => {
    for (const label of labelArr) {
      const v = parseValueAfter(label, txt);
      if (v) return v;
    }
    return '';
  };

  const workOrderNumber = get(['Work Order #','Work Order Number','WO #']).replace(/^#/, '');
  const poNumber = get(['Client PO #','PO #','PO Number']);
  const customer = get(['Client Name','Customer','Client']);
  const siteAddress = parseAddressBlock(txt) || get(['Service Location','Site Address','Address']);
  const problemDescription = get(['Service Description','Description','Scope of Work','Problem']);
  const nte = get(['NTE','NTE Amount']).replace(/USD|\$/g,'').trim();

  return { workOrderNumber, poNumber, customer, siteAddress, siteLocation: '', problemDescription, nte };
}

async function parsePdf(buffer) {
  try {
    const { text } = await pdfParse(buffer);
    if (text && text.trim().length > 50) return extractFromPdfText(text);
  } catch {}
  // if we reach here it’s likely scanned → Textract if configured
  if (!S3_BUCKET) return {};
  try {
    const Key = `ingest/tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
    await s3.putObject({ Bucket: S3_BUCKET, Key, Body: buffer, ContentType: 'application/pdf' }).promise();
    const textract = new AWS.Textract();
    const s3Obj = { S3Object: { Bucket: S3_BUCKET, Name: Key } };
    const { Blocks } = await textract.analyzeDocument({ Document: s3Obj, FeatureTypes: ['TABLES','FORMS'] }).promise();
    const text = (Blocks || []).filter(b => b.BlockType === 'LINE').map(b => b.Text).join('\n');
    await s3.deleteObject({ Bucket: S3_BUCKET, Key }).promise().catch(()=>{});
    return extractFromPdfText(text || '');
  } catch (e) {
    console.warn('Textract failed:', e.message);
    return {};
  }
}

// ── CRM I/O ──────────────────────────────────────────────────────────────────
async function searchExisting({ workOrderNumber, poNumber }) {
  try {
    const { data } = await axios.get(`${CRM_BASE}/work-orders/search`, {
      headers: { Authorization: `Bearer ${CRM_TOKEN}` },
      params: {
        workOrderNumber: workOrderNumber || '',
        poNumber: poNumber || '',
      },
      timeout: 15000
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('Search existing failed:', e.message);
    return [];
  }
}

async function createWorkOrder(payload, files = []) {
  const form = new FormData();
  Object.entries(payload).forEach(([k,v]) => form.append(k, v ?? ''));

  // Route PO-like PDFs to poPdf; others to generic attachments
  for (const f of files) {
    if (f.kind === 'po' || isLikelyPOPdfName(f.filename)) {
      form.append('poPdf', new Blob([f.buffer]), f.filename || 'po.pdf');
    } else {
      // generic image/pdf attachments land in photoPath
      form.append('photo', new Blob([f.buffer]), f.filename || 'att.bin');
    }
  }

  const res = await axios.post(`${CRM_BASE}/work-orders`, form, {
    headers: {
      Authorization: `Bearer ${CRM_TOKEN}`,
      ...(form.getHeaders ? form.getHeaders() : {}),
    },
    maxBodyLength: Infinity,
    timeout: 60000
  });
  return res.data;
}

// ── MAIN INGEST ──────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const parsed = await simpleParser(msg.source);
  const fromAddr = parsed.from?.value?.[0]?.address || '';
  if (!isEmailFrom(fromAddr, VENDOR_ALLOWLIST)) {
    console.log('• Skip non-allowlisted sender:', fromAddr);
    return;
  }

  const vendor =
    isEmailFrom(fromAddr, ['@truesource.com']) ? 'TrueSource' :
    isEmailFrom(fromAddr, ['@clearvisionfm.com']) ? 'ClearVision' :
    isEmailFrom(fromAddr, ['@officetrax.com']) ? 'CLM' :
    isEmailFrom(fromAddr, ['@kfm247.com']) ? 'KFM' :
    isEmailFrom(fromAddr, ['@1sttimefixed.com']) ? 'FirstTimeFix' :
    'Unknown';

  // Parse…
  let fields = {};
  const body = `${parsed.subject || ''}\n\n${parsed.text || ''}`;

  if (vendor === 'TrueSource') fields = await parseTrueSourceEmail(body);
  else if (vendor === 'ClearVision') fields = await parseClearVisionEmail(body);
  else {
    // look for a PO/WO PDF first
    const atts = parsed.attachments || [];
    const pdf = atts.find(a => (a.contentType === 'application/pdf') || (a.filename||'').toLowerCase().endsWith('.pdf'));
    if (pdf) {
      fields = await parsePdf(pdf.content);
      // tag file kind if name smells like PO
      pdf.kind = isLikelyPOPdfName(pdf.filename) ? 'po' : 'other';
      fields._pdfAttachment = pdf; // pass through
    } else {
      // last resort: try body
      fields = extractFromPdfText(body);
    }
  }

  // Normalize + assemble payload
  const workOrderNumber = norm(fields.workOrderNumber);
  const poNumber = norm(fields.poNumber);
  const customer = norm(fields.customer) || (vendor === 'TrueSource' ? 'TrueSource' : (vendor === 'ClearVision' ? 'ClearVision' : ''));
  const siteAddress = norm(fields.siteAddress);
  const siteLocation = norm(fields.siteLocation);
  const problemDescription = norm(fields.problemDescription) || norm(parsed.subject);

  const basePayload = {
    customer: customer || '(unknown customer)',
    billingAddress: '(from email)', // required by your API; you can refine later via QB sync
    problemDescription,
    siteAddress,
    siteLocation,
    workOrderNumber: workOrderNumber || null,
    poNumber: poNumber || null,
    status: 'Needs to be Scheduled',
    notes: JSON.stringify([{ text: `Auto-ingested from email ${parsed.messageId || ''} (${vendor})`, createdAt: new Date().toISOString(), by: 'ingest-bot' }]),
  };

  const score = scoreFields(basePayload);
  console.log(`· Vendor=${vendor} score=${score.toFixed(2)} WO=${workOrderNumber} PO=${poNumber}`);

  // Duplicate check
  const existing = await searchExisting({ workOrderNumber, poNumber });
  if (existing.length) {
    console.log('  → Skip (duplicate by WO/PO).');
    return;
  }

  if (score < confidenceMin) {
    console.log('  → Below confidence threshold; queued for review, not creating.');
    await queueForReview(parsed, basePayload, vendor, fields);
    return;
  }

  // Ready to create
  if (dryRun) {
    console.log('  → DRY_RUN on: would create with payload:', basePayload);
    return;
  }

  const files = [];
  if (fields._pdfAttachment) {
    files.push({
      buffer: fields._pdfAttachment.content,
      filename: fields._pdfAttachment.filename || 'doc.pdf',
      kind: fields._pdfAttachment.kind || 'other',
    });
  } else if ((parsed.attachments || []).length) {
    // add any images as attachments
    for (const a of parsed.attachments) {
      const isPdf = a.contentType === 'application/pdf' || (a.filename||'').toLowerCase().endsWith('.pdf');
      const isImg = (a.contentType||'').startsWith('image/');
      if (isPdf || isImg) {
        files.push({ buffer: a.content, filename: a.filename || `att.${mime.extension(a.contentType) || 'bin'}` });
      }
    }
  }

  try {
    const res = await createWorkOrder(basePayload, files);
    console.log('  ✓ Created Work Order:', res);
  } catch (e) {
    console.error('  ✖ Create failed:', e.response?.data || e.message);
    await queueForReview(parsed, basePayload, vendor, fields, { error: e.message });
  }
}

async function queueForReview(parsed, payload, vendor, raw, extra={}) {
  // Minimal local file log; you could push to S3 or a DB table "ingest_review"
  const rec = {
    at: new Date().toISOString(),
    vendor, from: parsed.from?.text, subject: parsed.subject,
    messageId: parsed.messageId, payload, raw, ...extra,
  };
  const dir = path.resolve(process.cwd(), 'ingest-review');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  console.log('  → queued for review:', file);
}

// ── IMAP LOOP ────────────────────────────────────────────────────────────────
async function run() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: IMAP_SECURE === 'true',
    auth: { user: IMAP_USER, pass: IMAP_PASS },
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  console.log(`📬 Ingest worker started (poll ${POLL_EVERY_SEC}s, dryRun=${dryRun}, conf>=${confidenceMin})`);

  while (true) {
    try {
      // search last hour unseen + recent
      const since = new Date(Date.now() - 1000 * 60 * 60);
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(
          { since, seen: false },
          { envelope: true, source: true, flags: true }
        )) {
          // mark seen so we don't repeat (or leave unseen and store a processed flag via UID map if you prefer)
          await handleMessage(msg);
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']).catch(()=>{});
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      console.error('Loop error:', e.message);
    }
    await sleep(Number(POLL_EVERY_SEC) * 1000);
  }
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
