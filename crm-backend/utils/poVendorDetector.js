const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const pdfParse = require("pdf-parse");

// Lazy-load Tesseract (it's heavy)
let Tesseract = null;

/**
 * Initialize Tesseract on first use
 */
async function initTesseract() {
  if (!Tesseract) {
    Tesseract = require("tesseract.js");
    console.log("[OCR] Tesseract.js loaded");
  }
}

/**
 * Extract text from a digital PDF (with embedded text)
 */
async function extractTextFromPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text || "";
}

/**
 * Convert PDF first page to PNG using GraphicsMagick/Ghostscript
 * Returns the path to the generated image, or null if failed
 */
function convertPdfToImage(pdfPath) {
  const tmpDir = os.tmpdir();
  const outputPath = path.join(tmpDir, `ocr-${Date.now()}.png`);

  try {
    // Try GraphicsMagick first (gm convert)
    // -density 200 = 200 DPI for good OCR quality
    // [0] = first page only
    const gmCmd = `gm convert -density 200 "${pdfPath}[0]" -resize 1700x2200 "${outputPath}"`;
    console.log("[OCR] Running:", gmCmd);
    execSync(gmCmd, { stdio: 'pipe', timeout: 30000 });

    if (fs.existsSync(outputPath)) {
      console.log("[OCR] PDF converted to image:", outputPath);
      return outputPath;
    }
  } catch (gmErr) {
    console.log("[OCR] GraphicsMagick failed, trying ImageMagick...");

    try {
      // Fall back to ImageMagick (convert)
      const imCmd = `convert -density 200 "${pdfPath}[0]" -resize 1700x2200 "${outputPath}"`;
      console.log("[OCR] Running:", imCmd);
      execSync(imCmd, { stdio: 'pipe', timeout: 30000 });

      if (fs.existsSync(outputPath)) {
        console.log("[OCR] PDF converted to image:", outputPath);
        return outputPath;
      }
    } catch (imErr) {
      console.error("[OCR] Both GraphicsMagick and ImageMagick failed");
      console.error("[OCR] GM error:", gmErr.message);
      console.error("[OCR] IM error:", imErr.message);
    }
  }

  return null;
}

/**
 * Extract text from a scanned PDF using OCR
 * Converts first page to image, then runs Tesseract OCR
 */
async function extractTextFromScannedPdf(filePath) {
  await initTesseract();

  console.log(`[OCR] Starting OCR extraction for: ${path.basename(filePath)}`);

  try {
    // Convert PDF to image
    const imagePath = convertPdfToImage(filePath);

    if (!imagePath) {
      console.warn("[OCR] Could not convert PDF to image");
      return "";
    }

    // Run Tesseract OCR on the image
    console.log("[OCR] Running Tesseract OCR...");
    const { data: { text } } = await Tesseract.recognize(imagePath, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && m.progress > 0 && m.progress < 1) {
          // Only log at 25%, 50%, 75%
          const pct = Math.round(m.progress * 100);
          if (pct === 25 || pct === 50 || pct === 75) {
            console.log(`[OCR] Progress: ${pct}%`);
          }
        }
      }
    });

    console.log(`[OCR] Extraction complete. Text length: ${text ? text.length : 0}`);

    // Clean up temp image file
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    return text || "";
  } catch (err) {
    console.error("[OCR] Error during extraction:", err.message);
    return "";
  }
}

/**
 * Smart text extraction - tries digital first, falls back to OCR for scanned PDFs
 */
async function extractTextSmart(filePath) {
  console.log(`[PDF] Attempting text extraction from: ${path.basename(filePath)}`);

  // First try digital PDF extraction (fast)
  let text = "";
  try {
    text = await extractTextFromPdf(filePath);
    console.log(`[PDF] Digital extraction got ${text.length} chars`);
  } catch (err) {
    console.warn(`[PDF] Digital extraction failed: ${err.message}`);
  }

  // If we got minimal text, it's probably a scanned PDF - try OCR
  const MIN_TEXT_LENGTH = 50;
  if (text.length < MIN_TEXT_LENGTH) {
    console.log(`[PDF] Text too short (${text.length} chars), trying OCR...`);
    try {
      const ocrText = await extractTextFromScannedPdf(filePath);
      if (ocrText.length > text.length) {
        console.log(`[PDF] OCR extracted ${ocrText.length} chars (using OCR result)`);
        text = ocrText;
      } else {
        console.log(`[PDF] OCR got ${ocrText.length} chars (keeping digital result)`);
      }
    } catch (err) {
      console.error(`[PDF] OCR extraction failed: ${err.message}`);
    }
  } else {
    console.log(`[PDF] Using digital extraction result (${text.length} chars)`);
  }

  return text;
}

/**
 * Layout-based supplier detection for FCG Purchase Order PDFs.
 * These are OUR PO PDFs with a consistent layout: "Vendor\n<VENDOR NAME>\n<ADDRESS>..."
 * Handles all pdf-parse output formats:
 *   "Vendor\nOLDCASTLE"   (newline separated)
 *   "Vendor OLDCASTLE"    (same line)
 *   "Vendor\n\nOLDCASTLE" (double newline)
 *   "Vendor  OLDCASTLE"   (extra spaces)
 *   "vendor\noldcastle"   (all lowercase)
 */
function detectSupplierFromPOLayout(text) {
  if (!text) return null;

  console.log('[PO Layout] Attempting layout-based vendor detection...');

  // Try next-line pattern first (most common for our POs)
  //   "Vendor\nOLDCASTLE" or "Vendor:\nOLDCASTLE" or "Vendor\n\nOLDCASTLE"
  let vendorMatch = text.match(/vendor[:\s]*\n\s*([^\n]+)/i);
  if (vendorMatch) {
    console.log('[PO Layout] Matched next-line pattern');
  }

  // Try same-line pattern: "Vendor OLDCASTLE" or "Vendor: OLDCASTLE"
  if (!vendorMatch) {
    vendorMatch = text.match(/vendor[:\s]+([^\n]{2,})/i);
    if (vendorMatch) {
      console.log('[PO Layout] Matched same-line pattern');
    }
  }

  if (vendorMatch) {
    const vendorLine = vendorMatch[1].trim().toLowerCase();
    console.log('[PO Layout] Captured vendor text:', JSON.stringify(vendorMatch[1].trim()));

    if (vendorLine.includes('chicago') && vendorLine.includes('temper'))  return 'Chicago Tempered';
    if (vendorLine.includes('oldcastle') || vendorLine.includes('old castle')) return 'Oldcastle';
    if (vendorLine.includes('laurence') || vendorLine.includes('crl') || vendorLine.includes('c.r.')) return 'CRL';
    if (vendorLine.includes('casco'))                                     return 'Casco';

    // Vendor field found but name not recognized — return it cleaned up
    console.log('[PO Layout] Unknown vendor name:', vendorMatch[1].trim());
    const raw = vendorMatch[1].trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  console.log('[PO Layout] No vendor field found in text');
  return null;
}

/**
 * Layout-based PO number detection for FCG Purchase Order PDFs.
 * Our POs have "P.O. No.\n<NUMBER>" or "P.O. No. 484" format.
 * Single unified regex handles both same-line and next-line with \n? (optional newline).
 */
function detectPoNumberFromPOLayout(text) {
  if (!text) return null;

  console.log('[PO Layout] Attempting layout-based PO# detection...');

  const patterns = [
    /p\.?\s*o\.?\s*no\.?\s*:?\s*\n?\s*(\d+)/i,          // "P.O. No.\n484" or "P.O. No. 484"
    /p\.?\s*o\.?\s*#\s*:?\s*\n?\s*(\d+)/i,              // "P.O. #\n484" or "P.O. # 484"
    /p\.?\s*o\.?\s*number\s*:?\s*\n?\s*(\d+)/i,          // "P.O. Number\n484" or "P.O. Number 484"
    /purchase\s*order\s*(?:#|no\.?)?\s*:?\s*\n?\s*(\d+)/i, // "Purchase Order\n484" or "Purchase Order 484"
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      console.log('[PO Layout] Found PO#:', match[1], 'via pattern:', pattern.toString());
      return match[1];
    }
  }

  console.log('[PO Layout] No PO# found via layout detection');
  return null;
}

/**
 * Keyword-based supplier detection (fallback).
 * Searches the entire text for vendor name keywords with OCR-tolerant patterns.
 */
function detectSupplierFromText(text) {
  if (!text) return null;

  // Normalize: lowercase, collapse multiple spaces
  const t = text.toLowerCase().replace(/\s+/g, ' ');

  console.log('[PO Vendor] Fallback: keyword-based vendor scan...');
  console.log('[PO Vendor] Normalized text (first 600 chars):', t.substring(0, 600));

  // Each vendor has multiple regex patterns to handle OCR variations
  const vendors = {
    'Chicago Tempered': [
      /chicago\s*tempered/i,
      /chicago\s*temp(?:ered)?/i,
      /chicag[o0]\s*tempered/i,       // OCR: o→0
      /\bctg\b/i,
      /chicago.*tempered\s*glass/i,
    ],
    'Oldcastle': [
      /[o0]ld\s*castle/i,             // OCR: o→0, optional space
      /[o0]ldcastle/i,                // No space variant
      /[o0]ld\s*cast[l1]e/i,          // OCR: l→1
      /building\s*envelope/i,          // Just the product line name
      /\bobe\b/i,                      // Abbreviation
      /[o0]be\s*glass/i,              // OCR: o→0
      /[o0]ldcastle\s*b/i,            // Partial "Oldcastle B..."
      /[o0][il1]dcastle/i,            // OCR: l→i or l→1
    ],
    'CRL': [
      /c\.?\s*r\.?\s*laurence/i,       // c.r. laurence, cr laurence, c r laurence
      /c\.?\s*r\.?\s*[l1]aurence/i,   // OCR: l→1
      /\bcrl\b/i,                      // Abbreviation
      /crl\.com/i,                     // Website
      /laurence\s*co/i,               // "Laurence Co" partial
      /\blaurence\b/i,                // Just "laurence" (unique enough)
    ],
    'Casco': [
      /casco/i,                        // Base name
      /casc[o0]\s*industries/i,        // OCR: o→0
      /casc[o0]\s*glass/i,            // OCR: o→0
    ],
  };

  for (const [vendor, patterns] of Object.entries(vendors)) {
    for (const pattern of patterns) {
      if (pattern.test(t)) {
        console.log('[PO Vendor] MATCHED vendor:', vendor, 'with pattern:', pattern.toString());
        return vendor;
      }
    }
  }

  console.log('[PO Vendor] WARNING: No vendor matched by keywords!');
  console.log('[PO Vendor] Full OCR text for debugging:', t.substring(0, 1500));
  return null;
}

/**
 * Detect PO number from PDF text
 * Used by analyzePoPdf for FCG purchase order number detection.
 * These are First Class Glass's OWN POs, so the PO # is our number.
 */
function detectPoNumberFromText(text) {
  if (!text) return null;

  console.log('[PO Number] Scanning for PO number...');

  const patterns = [
    // Labeled patterns (most reliable - look for explicit PO labels)
    { re: /po\s*#\s*:?\s*([a-z0-9][a-z0-9\-]{1,})/i,                         label: 'PO #' },
    { re: /po\s*number\s*:?\s*([a-z0-9][a-z0-9\-]{2,})/i,                    label: 'PO Number' },
    { re: /p\.?\s*o\.?\s*#\s*:?\s*([a-z0-9][a-z0-9\-]{1,})/i,               label: 'P.O. #' },
    { re: /p\.?\s*o\.?\s*(?:no\.?|number)\s*:?\s*\n?\s*([a-z0-9][a-z0-9\-]{2,})/i, label: 'P.O. No/Number' },
    { re: /purchase\s*order\s*(?:#|no\.?|number)?\s*:?\s*([a-z0-9][a-z0-9\-]{2,})/i, label: 'Purchase Order' },
    { re: /vendor\s*po\s*[#:\-]?\s*\n?\s*([a-z0-9][a-z0-9\-]{2,})/i,        label: 'Vendor PO' },
    { re: /client\s*po\s*[#:\-]?\s*\n?\s*([a-z0-9][a-z0-9\-]{2,})/i,        label: 'Client PO' },
    // Number on next line after PO label
    { re: /\bpo\s*#?\s*:?\s*\n\s*([0-9][a-z0-9\-]{2,})/i,                   label: 'PO (next line)' },
    // Bare "PO" followed by a number
    { re: /\bpo\s+([0-9]{3,})\b/i,                                            label: 'PO + digits' },
  ];

  for (const { re, label } of patterns) {
    const match = text.match(re);
    if (match && match[1]) {
      const poNum = match[1].trim();
      if (poNum.length >= 2 && /[0-9]/.test(poNum)) {
        console.log('[PO Number] MATCHED PO#:', poNum, 'via pattern:', label);
        return poNum;
      }
    }
  }

  console.log('[PO Number] WARNING: No PO number found');
  // Debug: show area around "po" in text
  const poIdx = text.toLowerCase().indexOf('po');
  if (poIdx >= 0) {
    console.log('[PO Number] Text around "po":', JSON.stringify(text.substring(Math.max(0, poIdx - 20), poIdx + 60)));
  }
  return null;
}

// ============================================================
// CUSTOMER PROFILES - Customer-specific extraction patterns
// ============================================================

/**
 * Title-case a string: "sweetgreen restaurant #122" → "Sweetgreen Restaurant #122"
 */
function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Clear Vision dedicated extraction (OCR text is always lowercase)
 *
 * PDF layout:
 *   #R77544
 *   ...
 *   SERVICE LOCATION
 *   #122 Sweetgreen Restaurant #122
 *   1471 N. Milwaukee Ave Wicker Park
 *   Chicago IL  60622
 *   ...
 *   SERVICE INSTRUCTIONS
 *   The door near the restrooms is not closing properly. ...
 */
function extractClearVisionFields(text) {
  const result = {
    workOrderNumber: null,
    siteLocation: null,
    siteAddress: null,
    problemDescription: null,
  };

  // Work Order # — #R77544 or R77544 → "R77544"
  const woMatch = text.match(/#?(r\d{4,6})/i);
  if (woMatch) {
    result.workOrderNumber = woMatch[1].toUpperCase();
  }

  // Site Location — first non-empty line after "service location"
  // Raw:  "#122 sweetgreen restaurant #122"
  // Want: "Sweetgreen Restaurant #122"
  const locMatch = text.match(/service location\s*\n+\s*([^\n]+)/i);
  if (locMatch) {
    let loc = locMatch[1].trim();
    // Strip leading "#NNN " prefix (duplicate store number)
    loc = loc.replace(/^#\d+\s+/, '');
    result.siteLocation = toTitleCase(loc);
  }

  // Site Address — two lines below the site-name line
  //   Line 1: "1471 n. milwaukee ave wicker park"
  //   Line 2: "chicago il  60622"
  //   Want:   "1471 N. Milwaukee Ave Wicker Park, Chicago, IL 60622"
  const addrMatch = text.match(
    /service location\s*\n+[^\n]+\n+\s*(\d+[^\n]+)\n+\s*([^\n]*\d{5}[^\n]*)/i
  );
  if (addrMatch) {
    const street = toTitleCase(addrMatch[1].trim());

    // Normalise city / state / ZIP: "chicago il  60622" → "Chicago, IL 60622"
    let cityLine = addrMatch[2].trim().replace(/\s+/g, ' ');
    const csz = cityLine.match(/^(.+?)\s+([a-z]{2})\s+(\d{5}(?:-\d{4})?)(.*)$/i);
    if (csz) {
      const city  = toTitleCase(csz[1]);
      const state = csz[2].toUpperCase();
      const zip   = csz[3];
      const rest  = csz[4] ? csz[4].trim() : '';
      cityLine = `${city}, ${state} ${zip}${rest ? ' ' + rest : ''}`;
    } else {
      cityLine = toTitleCase(cityLine);
    }

    result.siteAddress = `${street}, ${cityLine}`;
  }

  // Problem Description — ONLY the SERVICE INSTRUCTIONS content
  // Stop BEFORE any work-order numbers, "work order" labels, dates, or blank lines
  const descMatch = text.match(
    /service instructions\s*\n+([\s\S]*?)(?=#?r\d{4,6}|\bwork order\b|\bdate\s*:|\n\s*\n|$)/i
  );
  if (descMatch) {
    let desc = descMatch[1].trim();
    // Safety: strip any stray WO numbers or date lines that slipped through
    desc = desc.replace(/#?r\d{4,6}/gi, '');
    desc = desc.replace(/work\s*order[^.\n]*/gi, '');
    desc = desc.replace(/date:\s*\d{4}-\d{2}-\d{2}/gi, '');
    desc = desc.replace(/\s+/g, ' ').trim();
    // Sentence-case: capitalise first char + first char after ". "
    if (desc) {
      desc = desc.charAt(0).toUpperCase() + desc.slice(1);
      desc = desc.replace(/\.\s+([a-z])/g, (_, c) => '. ' + c.toUpperCase());
    }
    result.problemDescription = desc || null;
  }

  return result;
}

/**
 * True Source dedicated extraction (OCR text is always lowercase)
 *
 * PDF layout (typical):
 *   WO #: WO-03237351
 *   ...
 *   Site Name & Number:
 *   at&t #atr001998
 *   ...
 *   Site Address:
 *   9800 76th St, Pleasant Prairie, WI 53158
 *   ...
 *   Problem Reported:
 *   lock/unlock door *262-220-1545 zachary* wo check in/out phone #: ...
 *   ... (all details including IVR codes, store hours, etc.)
 */
function extractTrueSourceFields(text) {
  console.log('[TRUE SOURCE EXTRACTION] Raw PDF text (first 2000 chars):', text.substring(0, 2000));
  console.log('[TRUE SOURCE EXTRACTION] Text length:', text.length);

  const result = {
    workOrderNumber: null,
    skipPoNumber: true,   // True Source: never auto-fill PO #
    siteLocation: null,
    siteAddress: null,
    problemDescription: null,
  };

  // Work Order # — "wo #: wo-03237351" or "wo-03237351" or standalone 8-digit
  const woMatch = text.match(/wo[#:\s-]*wo-?(\d{7,8})/i)
    || text.match(/work\s*order[#:\s-]*(\d{7,8})/i)
    || text.match(/\bwo-(\d{7,8})\b/i);
  if (woMatch) {
    result.workOrderNumber = woMatch[1];
    console.log('[TRUE SOURCE] WO# matched:', result.workOrderNumber);
  } else {
    // Fallback: standalone 0-prefixed 8-digit number
    const standaloneMatch = text.match(/\b(0\d{7})\b/);
    if (standaloneMatch) {
      result.workOrderNumber = standaloneMatch[1];
      console.log('[TRUE SOURCE] WO# fallback matched:', result.workOrderNumber);
    } else {
      console.log('[TRUE SOURCE] WARNING: No WO# found');
    }
  }

  // Site Location (Name) — line(s) after "site name" header
  // Raw OCR:  "at&t #atr001998" or "{site} at&t #atr001998"
  // Want:     "AT&T #atr001998"  (uppercase store name, keep #identifier as-is)
  const locMatch = text.match(/site\s*name\s*(?:&|and)?\s*(?:number)?[:\s]*\n+\s*([^\n]+)/i);
  let rawLoc = locMatch ? locMatch[1].trim() : null;

  if (!rawLoc) {
    // Fallback: look for store name patterns like "at&t #xxx"
    const storeMatch = text.match(/\b([a-z][a-z&'.]+\s*#[a-z0-9]+)\b/i);
    if (storeMatch) rawLoc = storeMatch[1].trim();
  }

  if (rawLoc) {
    console.log('[TRUE SOURCE] Raw site location:', rawLoc);
    // Strip any "{site}" or similar prefix
    rawLoc = rawLoc.replace(/^\{?\s*site\s*\}?\s*/i, '');
    // Split into store name and #identifier
    const locParts = rawLoc.match(/^(.+?)\s*(#[a-z0-9]+)$/i);
    if (locParts) {
      const storeName = locParts[1].trim().toUpperCase();
      const storeId = locParts[2];  // keep #identifier as-is
      result.siteLocation = `${storeName} ${storeId}`;
    } else {
      // No #identifier found, just uppercase the whole thing
      result.siteLocation = rawLoc.toUpperCase();
    }
    console.log('[TRUE SOURCE] Final site location:', result.siteLocation);
  } else {
    console.log('[TRUE SOURCE] WARNING: No site location found');
  }

  // Site Address — try multiple patterns, most specific first
  // OCR text is always lowercase. Address may be on one line or split across lines.
  // NOTE: [: \t]* used instead of [:\s]* to avoid eating newlines before \n
  let rawAddr = null;

  // Pattern 1a: "site address" header, address on NEXT line(s) until next section
  if (!rawAddr) {
    const m = text.match(
      /site\s*address[: \t]*\n+[ \t]*([\s\S]*?)(?=\n[ \t]*(?:site\s*contact|contact\s*name|contact\s*phone|customer\b|phone\b|problem|scope|description|priority|trade|nte\b|service\s*type|dispatch|wo\s|work\s*order)|\n[ \t]*\n)/i
    );
    if (m) {
      rawAddr = m[1].trim();
      console.log('[TRUE SOURCE] Address Pattern 1a (site address + next lines):', rawAddr);
    }
  }

  // Pattern 1b: "site address" header, address on SAME line (inline)
  if (!rawAddr) {
    const m = text.match(/site\s*address[: \t]+(\d+[^\n]+)/i);
    if (m) {
      rawAddr = m[1].trim();
      console.log('[TRUE SOURCE] Address Pattern 1b (site address inline):', rawAddr);
    }
  }

  // Pattern 2a: broader "address" header, address on NEXT line(s)
  if (!rawAddr) {
    const m = text.match(
      /(?:service\s*)?address[: \t]*\n+[ \t]*([\s\S]*?)(?=\n[ \t]*(?:contact|phone|problem|scope|description|priority|trade|nte\b|dispatch|wo\s|work\s*order)|\n[ \t]*\n)/i
    );
    if (m) {
      rawAddr = m[1].trim();
      console.log('[TRUE SOURCE] Address Pattern 2a (address + next lines):', rawAddr);
    }
  }

  // Pattern 2b: broader "address" header, address on SAME line (inline)
  if (!rawAddr) {
    const m = text.match(/(?:service\s*)?address[: \t]+(\d+[^\n]+)/i);
    if (m) {
      rawAddr = m[1].trim();
      console.log('[TRUE SOURCE] Address Pattern 2b (address inline):', rawAddr);
    }
  }

  // Pattern 3: Street line (single line, no newline crossing) + city/state/zip on next line
  // e.g. "9800 76th st\npleasant prairie, wi 53158"
  // Use [^\n] instead of [\w\s] to avoid crossing line boundaries
  if (!rawAddr) {
    const m = text.match(
      /(\d+[^\n]+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\.?)[ \t]*[,\n]+[ \t]*([a-z][a-z \t.]+,?[ \t]*[a-z]{2}[ \t]+\d{5}(?:-\d{4})?)/i
    );
    if (m) {
      rawAddr = `${m[1].trim()}, ${m[2].trim()}`;
      console.log('[TRUE SOURCE] Address Pattern 3 (street line + city/state/zip):', rawAddr);
    }
  }

  // Pattern 4: Street number on one line, city/state/zip on next — no street type suffix
  // e.g. "9800 76th\npleasant prairie, wi 53158"
  if (!rawAddr) {
    const m = text.match(
      /(\d+[ \t]+[^\n]{3,30})\n+[ \t]*([a-z][a-z \t.]+,?[ \t]*[a-z]{2}[ \t]+\d{5}(?:-\d{4})?)/i
    );
    if (m) {
      rawAddr = `${m[1].trim()}, ${m[2].trim()}`;
      console.log('[TRUE SOURCE] Address Pattern 4 (street number + city line):', rawAddr);
    }
  }

  // Pattern 5: Full address on one line anywhere — "9800 76th st, pleasant prairie, wi 53158"
  if (!rawAddr) {
    const m = text.match(
      /(\d+[^\n,]+,[ \t]*[a-z][a-z \t.]+,?[ \t]*[a-z]{2}[ \t]+\d{5}(?:-\d{4})?)/i
    );
    if (m) {
      rawAddr = m[1].trim();
      console.log('[TRUE SOURCE] Address Pattern 5 (full address one line):', rawAddr);
    }
  }

  console.log('[TRUE SOURCE] Raw address before formatting:', rawAddr || '(none)');

  if (rawAddr) {
    // Collapse multi-line into single line
    let addr = rawAddr.replace(/\n+/g, ', ').replace(/[ \t]+/g, ' ').replace(/,\s*,/g, ',').trim();

    // Try to parse into street, city, state, zip
    const parts = addr.match(/^(.+?),\s*(.+?),?\s+([a-z]{2})\s+(\d{5}(?:-\d{4})?)(.*)$/i);
    if (parts) {
      const street = toTitleCase(parts[1].trim());
      const city = toTitleCase(parts[2].trim());
      const state = parts[3].toUpperCase();
      const zip = parts[4];
      const rest = parts[5] ? parts[5].trim() : '';
      addr = `${street}, ${city}, ${state} ${zip}`;
      if (rest && rest.toLowerCase().includes('usa')) {
        addr += `, ${rest}`;
      } else {
        addr += ', USA';
      }
    } else {
      // Couldn't parse structure — title-case and append USA
      addr = toTitleCase(addr);
      if (!addr.toLowerCase().includes('usa')) {
        addr += ', USA';
      }
    }

    result.siteAddress = addr;
    console.log('[TRUE SOURCE] Final formatted address:', result.siteAddress);
  } else {
    console.log('[TRUE SOURCE] WARNING: No address pattern matched in entire text');
  }

  // Problem Description — include ALL details after "problem reported" / "scope of work"
  // True Source techs need: contact info, phone numbers, IVR codes, store hours, everything
  const descMatch = text.match(
    /(?:problem\s*reported|scope\s*of\s*work|work\s*description|description|notes|instructions)[:\s]*\n+([\s\S]*?)(?=\n\s*(?:attachments|documents|files|action\s*required|work\s*plan|vendor\s*info|billing|payment|dispatch|technician\s*notes)\b|\s*$)/i
  );
  if (descMatch) {
    let desc = descMatch[1].trim();
    // Collapse whitespace but keep it readable
    desc = desc.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    // Remove trailing page numbers
    desc = desc.replace(/\s*page\s*\d+\s*(?:of\s*\d+)?\s*$/gi, '').trim();
    result.problemDescription = desc || null;
  }

  // If no description found, try a broader capture for contact/IVR patterns
  if (!result.problemDescription) {
    const broadMatch = text.match(
      /((?:lock\/unlock|check\s*in\/out|phone\s*#|ivr\s*code|service\s*type)[\s\S]+?)(?=\n\s*(?:attachments|documents|vendor|billing|payment|dispatch)\b|\s*$)/i
    );
    if (broadMatch) {
      let desc = broadMatch[1].trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      result.problemDescription = desc || null;
    }
  }

  console.log('[TRUE SOURCE] Problem description:', result.problemDescription ? result.problemDescription.substring(0, 150) + '...' : '(not found)');
  console.log('[TRUE SOURCE EXTRACTION] Final result:', JSON.stringify({
    workOrderNumber: result.workOrderNumber,
    siteLocation: result.siteLocation,
    siteAddress: result.siteAddress,
    problemDescription: result.problemDescription ? result.problemDescription.substring(0, 80) + '...' : null,
  }, null, 2));

  return result;
}

/**
 * CLM dedicated extraction (OCR text is always lowercase)
 *
 * PDF layout (typical):
 *   SERVICE LOCATION
 *   CVS #07142I01
 *   16760 W 167th St
 *   Lockport, IL 60441
 *   ...
 *   SERVICE DESCRIPTION
 *   front store / door - automatic / sliding doors / cracked/broken glass / ...
 */
function extractCLMFields(text) {
  console.log('[CLM EXTRACTION] Raw PDF text (first 2000 chars):', text.substring(0, 2000));
  console.log('[CLM EXTRACTION] Text length:', text.length);

  const result = {
    workOrderNumber: null,
    skipPoNumber: true,   // CLM: never auto-fill PO #
    siteLocation: null,
    siteAddress: null,
    problemDescription: null,
  };

  // Work Order # — CLM uses "VENDOR PO #" as the work order number
  // e.g. "vendor po #\n450089-01" or "vendor po # 450089-01"
  // OCR text is always lowercase
  // Debug: show text around "vendor" to see exact format
  const vendorIdx = text.indexOf('vendor');
  if (vendorIdx >= 0) {
    console.log('[CLM] Text around "vendor" keyword:', JSON.stringify(text.substring(Math.max(0, vendorIdx - 10), vendorIdx + 100)));
  } else {
    console.log('[CLM] WARNING: "vendor" not found in text at all');
  }

  // Try multiple patterns from most specific to broadest
  // Pattern A: "vendor po #" with number on same/next line (handles multiple newlines, optional #, dashes)
  const woPatternA = /vendor\s*po\s*#?\s*[:\s]*?(\d+[\-–—]?\d*)/i;
  const woMatchA = text.match(woPatternA);
  console.log('[CLM] WO# Pattern A result:', woMatchA ? woMatchA[1] : 'no match');

  // Pattern B: "vendor po" then within 20 chars find a multi-digit number
  const woPatternB = /vendor\s*po[\s#:]*(\d{4,}[\-–—]?\d*)/i;
  const woMatchB = text.match(woPatternB);
  console.log('[CLM] WO# Pattern B result:', woMatchB ? woMatchB[1] : 'no match');

  // Pattern C: Look for the number on lines near "vendor po" (handle label on one line, number on next)
  let woMatchC = null;
  if (vendorIdx >= 0) {
    // Grab 150 chars after "vendor" and look for any digit sequence
    const afterVendor = text.substring(vendorIdx, vendorIdx + 150);
    const cMatch = afterVendor.match(/(?:vendor\s*po[^\n]*\n\s*)(\d{4,}[\-–—]?\d*)/i);
    if (cMatch) woMatchC = cMatch;
    console.log('[CLM] WO# Pattern C (after vendor, next line):', woMatchC ? woMatchC[1] : 'no match');
  }

  // Pattern D: Last resort — find any "NNN-NN" pattern (6+ digits, dash, 2+ digits) in first 500 chars
  // CLM WO numbers look like "450089-01"
  let woMatchD = null;
  const topText = text.substring(0, 500);
  const dMatch = topText.match(/\b(\d{5,}[\-–—]\d{1,3})\b/);
  if (dMatch) woMatchD = dMatch;
  console.log('[CLM] WO# Pattern D (digit-dash-digit in top 500):', woMatchD ? woMatchD[1] : 'no match');

  // Use first match found
  if (woMatchA) {
    result.workOrderNumber = woMatchA[1].trim();
    console.log('[CLM] WO# matched (pattern A):', result.workOrderNumber);
  } else if (woMatchB) {
    result.workOrderNumber = woMatchB[1].trim();
    console.log('[CLM] WO# matched (pattern B):', result.workOrderNumber);
  } else if (woMatchC) {
    result.workOrderNumber = woMatchC[1].trim();
    console.log('[CLM] WO# matched (pattern C):', result.workOrderNumber);
  } else if (woMatchD) {
    result.workOrderNumber = woMatchD[1].trim();
    console.log('[CLM] WO# matched (pattern D - fallback digit-dash):', result.workOrderNumber);
  } else {
    console.log('[CLM] WARNING: No VENDOR PO # found after trying all 4 patterns');
    console.log('[CLM] First 500 chars of text:', JSON.stringify(text.substring(0, 500)));
  }

  // Site Location (Name) — line after "service location" header
  // Raw OCR:  "cvs #07142i01"
  // Want:     "CVS #07142I01" (uppercase store name, keep #identifier)
  const locMatch = text.match(/service\s*location[: \t]*\n+[ \t]*([^\n]+)/i);
  let rawLoc = locMatch ? locMatch[1].trim() : null;

  if (!rawLoc) {
    // Fallback: look for store patterns like "cvs #xxx", "walgreens #xxx"
    const storeMatch = text.match(/\b([a-z][a-z&'.]+\s*#[a-z0-9]+)\b/i);
    if (storeMatch) rawLoc = storeMatch[1].trim();
  }

  if (rawLoc) {
    console.log('[CLM] Raw site location:', rawLoc);
    // Strip any "{site}" prefix
    rawLoc = rawLoc.replace(/^\{?\s*site\s*\}?\s*/i, '');
    // Split into store name and #identifier, uppercase the store name
    const locParts = rawLoc.match(/^(.+?)\s*(#[a-z0-9]+)$/i);
    if (locParts) {
      const storeName = locParts[1].trim().toUpperCase();
      const storeId = locParts[2].toUpperCase();
      result.siteLocation = `${storeName} ${storeId}`;
    } else {
      result.siteLocation = rawLoc.toUpperCase();
    }
    console.log('[CLM] Final site location:', result.siteLocation);
  } else {
    console.log('[CLM] WARNING: No site location found');
  }

  // Site Address — line(s) after site location name, before next section
  // May be: "16760 w 167th st\nlockport, il 60441"
  // or:     "16760 w 167th st, lockport, il 60441"
  let rawAddr = null;

  // Pattern 1: After "service location" header, skip the name line, grab address line(s)
  const addrAfterLoc = text.match(
    /service\s*location[: \t]*\n+[^\n]+\n+[ \t]*([\s\S]*?)(?=\n[ \t]*(?:phone|service\s*description|service\s*type|contact|billing|nte\b|store\s*stamp|dispatch|\n[ \t]*\n))/i
  );
  if (addrAfterLoc) {
    rawAddr = addrAfterLoc[1].trim();
    console.log('[CLM] Address Pattern 1 (after service location name):', rawAddr);
  }

  // Pattern 2: "address" or "site address" header
  if (!rawAddr) {
    const addrHeader = text.match(
      /(?:site\s*)?address[: \t]*\n+[ \t]*([\s\S]*?)(?=\n[ \t]*(?:contact|phone|problem|service\s*description|billing|nte\b|dispatch|\n[ \t]*\n))/i
    );
    if (addrHeader) {
      rawAddr = addrHeader[1].trim();
      console.log('[CLM] Address Pattern 2 (address header):', rawAddr);
    }
  }

  // Pattern 3: Street line + city/state/zip on next line (structural)
  if (!rawAddr) {
    const streetMatch = text.match(
      /(\d+[^\n]+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|hwy)\.?)[ \t]*[,\n]+[ \t]*([a-z][a-z \t.]+,?[ \t]*[a-z]{2}[ \t]+\d{5}(?:-\d{4})?)/i
    );
    if (streetMatch) {
      rawAddr = `${streetMatch[1].trim()}, ${streetMatch[2].trim()}`;
      console.log('[CLM] Address Pattern 3 (street + city):', rawAddr);
    }
  }

  // Pattern 4: Full address on one line
  if (!rawAddr) {
    const oneLine = text.match(
      /(\d+[^\n,]+,[ \t]*[a-z][a-z \t.]+,?[ \t]*[a-z]{2}[ \t]+\d{5}(?:-\d{4})?)/i
    );
    if (oneLine) {
      rawAddr = oneLine[1].trim();
      console.log('[CLM] Address Pattern 4 (one line):', rawAddr);
    }
  }

  console.log('[CLM] Raw address before formatting:', rawAddr || '(none)');

  if (rawAddr) {
    let addr = rawAddr.replace(/\n+/g, ', ').replace(/[ \t]+/g, ' ').replace(/,\s*,/g, ',').trim();

    // Parse into street, city, state, zip and title-case
    const parts = addr.match(/^(.+?),\s*(.+?),?\s+([a-z]{2})\s+(\d{5}(?:-\d{4})?)(.*)$/i);
    if (parts) {
      const street = toTitleCase(parts[1].trim());
      const city = toTitleCase(parts[2].trim());
      const state = parts[3].toUpperCase();
      const zip = parts[4];
      addr = `${street}, ${city}, ${state} ${zip}`;
      if (!(parts[5] || '').toLowerCase().includes('usa')) {
        addr += ', USA';
      }
    } else {
      addr = toTitleCase(addr);
      if (!addr.toLowerCase().includes('usa')) {
        addr += ', USA';
      }
    }

    result.siteAddress = addr;
    console.log('[CLM] Final formatted address:', result.siteAddress);
  } else {
    console.log('[CLM] WARNING: No address pattern matched');
  }

  // Problem Description — everything after "service description" header
  // CLM format: "front store / door - automatic / sliding doors / cracked/broken glass / ..."
  // Include ALL details — category, subcategory, problem, emergency status, full description
  const descMatch = text.match(
    /service\s*description[: \t]*\n+([\s\S]*?)(?=\n[ \t]*(?:billing|store\s*stamp|nte\b|vendor|payment|dispatch|technician|attachments|documents|\n[ \t]*\n)|\s*$)/i
  );
  if (descMatch) {
    let desc = descMatch[1].trim();
    desc = desc.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    desc = desc.replace(/\s*page\s*\d+\s*(?:of\s*\d+)?\s*$/gi, '').trim();
    result.problemDescription = desc || null;
  }

  // Fallback: try broader description headers
  if (!result.problemDescription) {
    const fallback = text.match(
      /(?:problem|issue|description|scope|notes|instructions)[: \t]*\n+([\s\S]*?)(?=\n[ \t]*(?:billing|contact|phone|attachments|documents|\n[ \t]*\n)|\s*$)/i
    );
    if (fallback) {
      let desc = fallback[1].trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      result.problemDescription = desc || null;
    }
  }

  console.log('[CLM] Problem description:', result.problemDescription ? result.problemDescription.substring(0, 150) + '...' : '(not found)');
  console.log('[CLM EXTRACTION] Final result:', JSON.stringify({
    workOrderNumber: result.workOrderNumber,
    siteLocation: result.siteLocation,
    siteAddress: result.siteAddress,
    problemDescription: result.problemDescription ? result.problemDescription.substring(0, 80) + '...' : null,
  }, null, 2));

  return result;
}

/**
 * 1st Time Fixed dedicated extraction (OCR text is always lowercase)
 *
 * PDF layout (typical):
 *   CUSTOMER / LOCATION:
 *   LITTLE CAESARS 01724
 *   6233 Hohman Ave
 *   Hammond, IN 46324
 *   ...
 *   W.O. NUMBER: 336317184
 *   ...
 *   WORK DESCRIPTION:
 *   "CUSTOMER AREA / DOOR REPAIR / ENTRY DOOR / DOOR CLOSER / DOOR CLOSER BROKEN ..."
 */
function extractFirstTimeFixedFields(text) {
  console.log('[1TF] Detected 1st Time Fixed work order');
  console.log('[1TF] Raw PDF text (first 2000 chars):', text.substring(0, 2000));
  console.log('[1TF] Text length:', text.length);

  const result = {
    workOrderNumber: null,
    skipPoNumber: true,   // 1TF: don't auto-fill PO #
    siteLocation: null,
    siteAddress: null,
    problemDescription: null,
  };

  // ── Work Order # ──
  // Handles: "w.o. number: 336317184", "w.o. number 336317184", "wo number: 336317184",
  //          "w.o.number:336317184", "w.o. #: 336317184", label and number on separate lines
  const woMatch = text.match(/w\.?o\.?\s*(?:#|number)[:\s]*(\d+)/i)
    || text.match(/w\.?o\.?\s*(?:#|number)[: \t]*\n[ \t]*(\d+)/i);
  if (woMatch) {
    result.workOrderNumber = woMatch[1].trim();
    console.log('[1TF] WO# matched:', result.workOrderNumber);
  } else {
    console.log('[1TF] WARNING: No WO# found');
    // Debug: look for "w.o" or "wo" anywhere
    const woIdx = text.search(/w\.?o\.?\s/i);
    if (woIdx >= 0) {
      console.log('[1TF] Text around "w.o":', JSON.stringify(text.substring(woIdx, woIdx + 80)));
    }
  }

  // ── Site Location + Site Address ──
  // 1TF PDFs have two formats:
  //   A) Same line:  "customer / location: little caesars 01724"
  //   B) Next line:  "customer / location:\nlittle caesars 01724"
  // Address lines follow immediately after the store name.
  //
  // We extract the store name and address in one block, then split them.

  // First, find the customer/location section and grab everything after it
  // until the next known section header
  const custBlock = text.match(
    /customer\s*\/?\s*location[: \t]*([\s\S]*?)(?=\n[ \t]*(?:phone|fax|email|vendor\b|w\.?o\.?\s|work\s*desc|store\s*manager|special|billing|nte\b|\n[ \t]*\n))/i
  );

  console.log('[1TF] customer/location block match:', custBlock ? JSON.stringify(custBlock[1].substring(0, 200)) : 'NO MATCH');

  if (custBlock) {
    // Split the block into non-empty lines
    const lines = custBlock[1].split('\n').map(l => l.trim()).filter(l => l.length > 0);
    console.log('[1TF] customer/location block lines:', JSON.stringify(lines));

    // Line 0 = store name (may be on same line as label, or first line after it)
    // Lines 1+ = address lines
    if (lines.length >= 1) {
      // ── Site Location: first line is the store name ──
      let loc = lines[0];
      // Strip trailing store number codes (just digits at end, like "01724")
      loc = loc.replace(/\s+\d{4,}$/, '');
      result.siteLocation = loc.toUpperCase().trim();
      console.log('[1TF] Site Location:', result.siteLocation);

      // ── Site Address: remaining lines that look like an address ──
      // Skip lines that are just the store name / don't start with a digit
      const addrLines = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Stop if we hit something that's not address-like
        if (/^(?:phone|fax|email|vendor|w\.?o\.?|work\s*desc|store|special|billing)/i.test(line)) break;
        addrLines.push(line);
      }
      console.log('[1TF] Address lines:', JSON.stringify(addrLines));

      if (addrLines.length > 0) {
        let rawAddr = addrLines.join(', ');
        // Avoid picking up the 1TF billing address as site address
        if (rawAddr.toLowerCase().includes('bensenville') || rawAddr.toLowerCase().includes('kevyn')) {
          console.log('[1TF] WARNING: Address looks like billing address, skipping:', rawAddr);
        } else {
          // Clean up and format
          let addr = rawAddr.replace(/[ \t]+/g, ' ').replace(/,\s*,/g, ',').trim();

          const parts = addr.match(/^(.+?),\s*(.+?),?\s+([a-z]{2})\s+(\d{5}(?:-\d{4})?)(.*)$/i);
          if (parts) {
            const street = toTitleCase(parts[1].trim());
            const city = toTitleCase(parts[2].trim());
            const state = parts[3].toUpperCase();
            const zip = parts[4];
            addr = `${street}, ${city}, ${state} ${zip}`;
          } else {
            addr = toTitleCase(addr);
          }

          result.siteAddress = addr;
          console.log('[1TF] Final formatted address:', result.siteAddress);
        }
      }
    }
  } else {
    console.log('[1TF] WARNING: No customer/location section found');
    // Debug: show where "customer" appears
    const custIdx = text.indexOf('customer');
    if (custIdx >= 0) {
      console.log('[1TF] Text around "customer":', JSON.stringify(text.substring(custIdx, custIdx + 120)));
    }
  }

  // ── Problem Description ──
  // MUST use "work description" specifically (not just "description" which matches invoice boilerplate)
  // The text is usually in quotes: work description: "CUSTOMER AREA / DOOR REPAIR / ..."
  // Or without quotes: work description:\nCUSTOMER AREA / DOOR REPAIR / ...

  // Pattern A: Text in quotes after "work description"
  let descFound = false;
  const descQuoted = text.match(
    /work\s*description[: \t]*\n?[ \t]*"([^"]+)"/i
  );
  if (descQuoted) {
    let desc = descQuoted[1].trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    result.problemDescription = desc.toUpperCase();
    descFound = true;
    console.log('[1TF] Problem description (quoted):', result.problemDescription.substring(0, 150));
  }

  // Pattern B: Text after "work description" until a stop-marker (no quotes)
  if (!descFound) {
    const descUnquoted = text.match(
      /work\s*description[: \t]*\n?[ \t]*([\s\S]*?)(?=\n[ \t]*(?:special\s*instruction|store\s*manager|store\s*stamp|vendor\b|submit\s*all|before\s*and\s*after|invoice|billing|nte\b|\n[ \t]*\n))/i
    );
    if (descUnquoted) {
      let desc = descUnquoted[1].trim();
      // Strip leading/trailing quotes that may be partial
      desc = desc.replace(/^"/, '').replace(/"$/, '').trim();
      desc = desc.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (desc) {
        result.problemDescription = desc.toUpperCase();
        descFound = true;
        console.log('[1TF] Problem description (unquoted):', result.problemDescription.substring(0, 150));
      }
    }
  }

  if (!descFound) {
    console.log('[1TF] WARNING: No work description found');
    // Debug
    const descIdx = text.indexOf('work description');
    if (descIdx >= 0) {
      console.log('[1TF] Text around "work description":', JSON.stringify(text.substring(descIdx, descIdx + 200)));
    }
  }

  console.log('[1TF] Full extracted data:', JSON.stringify({
    workOrderNumber: result.workOrderNumber,
    siteLocation: result.siteLocation,
    siteAddress: result.siteAddress,
    problemDescription: result.problemDescription ? result.problemDescription.substring(0, 80) + '...' : null,
  }, null, 2));

  return result;
}

const CUSTOMER_PROFILES = {
  CLEAR_VISION: {
    names: ["CLEAR VISION", "CLEARVISION", "CLEAR VISION FACILITIES"],
    displayName: "Clear Vision",
    billingAddress: "1525 Rancho Conejo Blvd. STE #207, Newbury Park, CA 91320",
    customExtract: extractClearVisionFields,
  },

  TRUE_SOURCE: {
    names: ["TRUESOURCE", "TRUE SOURCE", "TRUESOURCE.COM"],
    displayName: "True Source",
    billingAddress: "263 Jenckes Hill Rd, Lincoln, RI 02865",
    customExtract: extractTrueSourceFields,
  },

  CLM_MIDWEST: {
    names: ["CLM MIDWEST", "CLM", "CLMMIDWEST", "CLM SERVICES", "C.L.M"],
    displayName: "CLM",
    billingAddress: "2655 Erie St. River Grove, IL 60171",
    customExtract: extractCLMFields,
  },

  FIRST_TIME_FIXED: {
    names: ["1ST TIME FIXED", "1st Time Fixed", "1STTIMEFIXED", "FIRST TIME FIXED"],
    displayName: "1st Time Fixed",
    billingAddress: "334 Kevyn Ln, Bensenville, IL 60106",
    customExtract: extractFirstTimeFixedFields,
  },

  KFM: {
    names: ["KFM", "KFM247", "KFM 247"],
    displayName: "KFM",
    billingAddress: "15947 Frederick Road, Woodbine, MD 21797",
    patterns: {
      workOrderNumber: /Work Order Number #?(\d+)/i,  // 1073774
      siteLocation: /Location\s+([\s\S]*?)(?:\nMall|\nLocation Phone|\nAddress)/i,
      siteAddress: /Address\s+([\s\S]*?)(?:\nRT-|IVR|Location Phone|$)/i,
      problemDescription: /Description from Client\s*([\s\S]*?)(?:Service Requested|Location|Trade|$)/i
    }
  }
};

/**
 * Clean extracted text - removes noise and normalizes whitespace
 */
function cleanExtractedText(text, maxLength = 500) {
  if (!text) return null;

  let cleaned = text
    // Normalize whitespace
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    // Remove excessive line breaks (3+ becomes 2)
    .replace(/\n{3,}/g, '\n\n')
    // Trim each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Remove trailing labels that got accidentally captured
    .replace(/\n?(PHONE|FAX|EMAIL|CONTACT|BILLING|VENDOR|NTE|Priority|Site Contact|Action Required|Work Plan).*$/i, '')
    // Remove leading/trailing whitespace
    .trim();

  // Limit length
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength).trim();
    // Try to end at a word boundary
    const lastSpace = cleaned.lastIndexOf(' ');
    if (lastSpace > maxLength - 50) {
      cleaned = cleaned.substring(0, lastSpace) + '...';
    }
  }

  return cleaned || null;
}

/**
 * Detect which customer profile matches the PDF text
 * Returns the profile key (e.g., "CLEAR_VISION") or null
 */
function detectCustomerProfile(text) {
  if (!text) return null;
  const upperText = text.toUpperCase();

  for (const [profileKey, profile] of Object.entries(CUSTOMER_PROFILES)) {
    for (const name of profile.names) {
      if (upperText.includes(name.toUpperCase())) {
        console.log(`[WO Extract] Detected customer: ${profile.displayName} (matched "${name}")`);
        return profileKey;
      }
    }
  }

  console.log("[WO Extract] No known customer detected, using generic extraction");
  return null;
}

/**
 * Extract field using customer-specific pattern
 */
function extractWithPattern(text, pattern) {
  if (!text || !pattern) return null;

  const match = text.match(pattern);
  if (match && match[1]) {
    return cleanExtractedText(match[1]);
  }
  return null;
}

/**
 * Generic fallback extraction for unknown customers
 */
function extractGenericWorkOrderFields(text) {
  const result = {
    workOrderNumber: null,
    poNumber: null,
    siteLocation: null,
    siteAddress: null,
    problemDescription: null
  };

  // Work order number patterns
  const woPatterns = [
    /WO\s*#?:?\s*([A-Z0-9\-]+)/i,
    /Work\s*Order\s*(?:#|Number)?:?\s*([A-Z0-9\-]+)/i,
    /Service\s*Order\s*#?:?\s*([A-Z0-9\-]+)/i,
    /Job\s*#?:?\s*([A-Z0-9\-]+)/i
  ];
  for (const pattern of woPatterns) {
    const match = text.match(pattern);
    if (match && match[1] && /\d/.test(match[1])) {
      result.workOrderNumber = match[1].trim();
      break;
    }
  }

  // PO number
  result.poNumber = detectPoNumberFromText(text);

  // Site location patterns
  const locPatterns = [
    /(?:Ship\s*To|Service\s*Location|Site|Location)\s*:?\s*\n?\s*([A-Za-z][^\n]{3,50})/i,
    /Store\s*(?:#|Name)?:?\s*([^\n]{3,50})/i
  ];
  for (const pattern of locPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const loc = cleanExtractedText(match[1], 100);
      if (loc && !/^\d+\s+\w+\s+(st|ave|rd|dr|blvd)/i.test(loc)) {
        result.siteLocation = loc;
        break;
      }
    }
  }

  // Address patterns
  const addrPatterns = [
    /(?:Site\s*)?Address:?\s*([\d].*?(?:IL|WI|IN|OH|MI|AZ|CA|TX|FL|NY|PA|NJ)\s*\d{5})/i,
    /(\d+\s+[A-Za-z0-9\s\.]+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Ln|Way|Ct)[.,]?\s*[A-Za-z\s]+,?\s*[A-Z]{2}\s*\d{5})/i
  ];
  for (const pattern of addrPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.siteAddress = cleanExtractedText(match[1], 150);
      break;
    }
  }

  // Problem description patterns
  const descPatterns = [
    /(?:Problem|Issue|Description|Service\s*Instructions|Work\s*Description)\s*:?\s*\n?\s*([\s\S]{10,300}?)(?:\n\n|BILLING|CONTACT|$)/i
  ];
  for (const pattern of descPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.problemDescription = cleanExtractedText(match[1], 500);
      break;
    }
  }

  return result;
}

/**
 * Extract all work order fields from OCR text
 * Uses customer-specific extraction rules when a known customer is detected
 * Returns structured object with all detected fields
 */
function extractWorkOrderFields(text) {
  console.log("=== WORK ORDER FIELD EXTRACTION START ===");
  console.log(`[WO Extract] Input text length: ${text ? text.length : 0} chars`);

  if (!text || text.length < 10) {
    console.log("[WO Extract] Text too short, returning empty result");
    return {
      customer: null,
      billingAddress: null,
      workOrderNumber: null,
      poNumber: null,
      siteLocation: null,
      siteAddress: null,
      problemDescription: null,
      detectedCustomerProfile: false,
      rawText: text || ""
    };
  }

  // Step 1: Detect which customer this PDF is from
  const profileKey = detectCustomerProfile(text);

  let result = {
    customer: null,
    billingAddress: null,
    workOrderNumber: null,
    poNumber: null,
    siteLocation: null,
    siteAddress: null,
    problemDescription: null,
    detectedCustomerProfile: false,
    rawText: text.substring(0, 1000)
  };

  if (profileKey) {
    // Step 2: Use customer-specific patterns
    const profile = CUSTOMER_PROFILES[profileKey];
    result.customer = profile.displayName;
    result.billingAddress = profile.billingAddress;
    result.detectedCustomerProfile = true;

    console.log(`[WO Extract] Using ${profile.displayName} extraction`);

    if (profile.customExtract) {
      // Use dedicated extraction function for this customer
      console.log(`[WO Extract] Using custom extraction function for ${profile.displayName}`);
      const custom = profile.customExtract(text);
      console.log(`[WO Extract] customExtract returned:`, JSON.stringify({
        workOrderNumber: custom.workOrderNumber,
        poNumber: custom.poNumber,
        skipPoNumber: custom.skipPoNumber,
        siteLocation: custom.siteLocation,
        siteAddress: custom.siteAddress ? custom.siteAddress.substring(0, 50) : null,
        problemDescription: custom.problemDescription ? custom.problemDescription.substring(0, 50) + '...' : null,
      }));
      if (custom.workOrderNumber) result.workOrderNumber = custom.workOrderNumber;
      if (custom.poNumber) result.poNumber = custom.poNumber;
      if (custom.skipPoNumber) result.skipPoNumber = true; // suppress generic PO fallback
      if (custom.siteLocation) result.siteLocation = custom.siteLocation;
      if (custom.siteAddress) result.siteAddress = custom.siteAddress;
      if (custom.problemDescription) result.problemDescription = custom.problemDescription;
    } else if (profile.patterns) {
      // Extract each field using customer's specific pattern
      if (profile.patterns.workOrderNumber) {
        result.workOrderNumber = extractWithPattern(text, profile.patterns.workOrderNumber);
      }
      if (profile.patterns.poNumber) {
        result.poNumber = extractWithPattern(text, profile.patterns.poNumber);
      }
      if (profile.patterns.siteLocation) {
        result.siteLocation = extractWithPattern(text, profile.patterns.siteLocation);
      }
      if (profile.patterns.siteAddress) {
        result.siteAddress = extractWithPattern(text, profile.patterns.siteAddress);
      }
      if (profile.patterns.problemDescription) {
        result.problemDescription = extractWithPattern(text, profile.patterns.problemDescription);
      }
    }

    // If no PO found with customer pattern, try generic (unless explicitly skipped)
    if (!result.poNumber && !result.skipPoNumber) {
      result.poNumber = detectPoNumberFromText(text);
    }

    // Uppercase work order numbers (OCR text is lowercase, e.g. "r77544" → "R77544")
    if (result.workOrderNumber) {
      result.workOrderNumber = result.workOrderNumber.toUpperCase();
    }

  } else {
    // Step 3: Fall back to generic extraction
    const genericResult = extractGenericWorkOrderFields(text);
    result = { ...result, ...genericResult };
  }

  console.log("=== EXTRACTION RESULTS ===");
  console.log(`  Customer: ${result.customer || "(not found)"}`);
  console.log(`  Billing Address: ${result.billingAddress || "(not found)"}`);
  console.log(`  Work Order #: ${result.workOrderNumber || "(not found)"}`);
  console.log(`  PO Number: ${result.poNumber || "(not found)"}`);
  console.log(`  Site Location: ${result.siteLocation || "(not found)"}`);
  console.log(`  Site Address: ${result.siteAddress || "(not found)"}`);
  console.log(`  Problem: ${result.problemDescription ? result.problemDescription.substring(0, 100) + "..." : "(not found)"}`);
  console.log(`  Used Profile: ${result.detectedCustomerProfile ? "Yes" : "No (generic)"}`);
  console.log("=== WORK ORDER FIELD EXTRACTION END ===");

  // Clean up internal flags before returning
  delete result.skipPoNumber;

  return result;
}

/**
 * Main extraction function - extracts text and detects vendor/PO
 * Returns { text, supplier, poNumber, textLength }
 */
async function analyzePoPdf(filePath) {
  console.log('[PO DETECT] ===== Starting PO PDF Analysis =====');
  console.log('[PO DETECT] File:', filePath);

  const text = await extractTextSmart(filePath);

  console.log('[PO DETECT] Raw extracted text (first 1000 chars):', text.substring(0, 1000));
  console.log('[PO DETECT] Text length:', text.length);

  // Debug: show what the layout regexes will see
  console.log('[PO DETECT] Layout regex attempt 1 (next-line):', text.match(/vendor[:\s]*\n\s*([^\n]+)/i));
  console.log('[PO DETECT] Layout regex attempt 2 (same-line):', text.match(/vendor[:\s]+([^\n]{2,})/i));
  console.log('[PO DETECT] Keyword search - contains "oldcastle":', text.toLowerCase().includes('oldcastle'));
  console.log('[PO DETECT] Keyword search - contains "chicago":', text.toLowerCase().includes('chicago'));
  console.log('[PO DETECT] Keyword search - contains "casco":', text.toLowerCase().includes('casco'));
  console.log('[PO DETECT] Keyword search - contains "laurence":', text.toLowerCase().includes('laurence'));

  // Step 1: Try layout-based detection FIRST (most reliable for FCG POs)
  let supplier = detectSupplierFromPOLayout(text);
  let poNumber = detectPoNumberFromPOLayout(text);

  // Step 2: Fall back to keyword-based detection if layout didn't find them
  if (!supplier) {
    console.log('[PO DETECT] Layout failed for supplier, trying keyword fallback...');
    supplier = detectSupplierFromText(text);
  }
  if (!poNumber) {
    console.log('[PO DETECT] Layout failed for PO#, trying keyword fallback...');
    poNumber = detectPoNumberFromText(text);
  }

  console.log('[PO DETECT] Final detected supplier:', supplier || '(none)');
  console.log('[PO DETECT] Final detected PO#:', poNumber || '(none)');
  console.log('[PO DETECT] ===== End PO PDF Analysis =====');

  return {
    text,
    supplier,
    poNumber,
    textLength: text.length
  };
}

module.exports = {
  extractTextFromPdf,
  extractTextFromScannedPdf,
  extractTextSmart,
  detectSupplierFromPOLayout,
  detectPoNumberFromPOLayout,
  detectSupplierFromText,
  detectPoNumberFromText,
  extractWorkOrderFields,
  analyzePoPdf,
};
