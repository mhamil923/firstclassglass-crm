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
  return (data.text || "").toLowerCase();
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

    return (text || "").toLowerCase();
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
 * Detect supplier from extracted PDF text
 * Searches for vendor names, addresses, phone numbers, and unique identifiers
 */
function detectSupplierFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // Chicago Tempered - check name and known identifiers
  if (
    t.includes("chicago tempered") ||
    t.includes("chicagotempered") ||
    t.includes("chicago temp") ||
    /\bctg\b/.test(t) ||
    (t.includes("chicago") && t.includes("tempered glass")) ||
    (t.includes("chicago") && t.includes("glass") && t.includes("temper"))
  ) {
    return "Chicago Tempered";
  }

  // CRL / C.R. Laurence - check various name formats
  if (
    t.includes("c.r. laurence") ||
    t.includes("cr laurence") ||
    t.includes("c r laurence") ||
    t.includes("crlaurence") ||
    t.includes("c.r.laurence") ||
    /\bcrl\b/.test(t) ||
    t.includes("crl.com")
  ) {
    return "CRL";
  }

  // Oldcastle - check name variations
  if (
    t.includes("oldcastle") ||
    t.includes("old castle") ||
    t.includes("oldcastle buildingenvelope") ||
    t.includes("obe glass") ||
    t.includes("oldcastle be")
  ) {
    return "Oldcastle";
  }

  // Casco - check name
  if (
    t.includes("casco") ||
    t.includes("casco industries") ||
    t.includes("casco glass")
  ) {
    return "Casco";
  }

  return null;
}

/**
 * Detect PO number from PDF text (generic fallback)
 * Used by analyzePoPdf for supplier PO detection
 */
function detectPoNumberFromText(text) {
  if (!text) return null;

  const patterns = [
    /vendor\s*po\s*[#:\-]?\s*\n?\s*([a-z0-9][a-z0-9\-]{2,})/i,
    /client\s*po\s*[#:\-]?\s*\n?\s*([a-z0-9][a-z0-9\-]{2,})/i,
    /po\s*#\s*:?\s*([a-z0-9][a-z0-9-]{1,})/i,
    /p\.o\.?\s*(?:#|no\.?|number)?\s*:?\s*\n?\s*([a-z0-9][a-z0-9-]{2,})/i,
    /purchase\s+order\s*[#:]*\s*([a-z0-9][a-z0-9-]{2,})/i,
    /\bpo\s+([0-9]{3,})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const poNum = match[1].trim();
      if (poNum.length >= 3 && /[0-9]/.test(poNum)) {
        return poNum;
      }
    }
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
    names: ["CLM MIDWEST", "CLM", "CLMMIDWEST", "CLM SERVICES"],
    displayName: "CLM Midwest",
    billingAddress: "2655 N Erie St, River Grove, IL 60171",
    patterns: {
      workOrderNumber: /VENDOR PO #\s*\n?\s*(\d+-?\d*)/i,  // 450089-01
      poNumber: /Client PO #\s*(\d+)/i,  // 340315111
      siteLocation: /SERVICE LOCATION\s*\n([\s\S]*?)(?:\n\d|\nPhone|\nSERVICE)/i,
      siteAddress: /SERVICE LOCATION[\s\S]*?\n.*?\n([\d].*?(?:IL|WI|IN|OH|MI)\s*\d{5})/i,
      problemDescription: /SERVICE DESCRIPTION\s*\n?([\s\S]*?)(?:\nBILLING|STORE STAMP|NTE|$)/i
    }
  },

  FIRST_TIME_FIXED: {
    names: ["1ST TIME FIXED", "1st Time Fixed", "1STTIMEFIXED", "FIRST TIME FIXED"],
    displayName: "1st Time Fixed",
    billingAddress: "334 Kevyn Ln, Bensenville, IL 60106",
    patterns: {
      workOrderNumber: /W\.?O\.?\s*NUMBER:?\s*(\d+)/i,  // 338678150
      siteLocation: /CUSTOMER\s*\/?\s*LOCATION:?\s*([\s\S]*?)(?:\n\d|VENDOR|W\.?O\.?\s*NUMBER)/i,
      siteAddress: /CUSTOMER\s*\/?\s*LOCATION:?[\s\S]*?\n\s*([\d].*?(?:IL|WI|IN|OH|MI)\s*\d{0,5})/i,
      problemDescription: /WORK DESCRIPTION:?\s*"?([\s\S]*?)"?(?:\nSTORE MANAGER|STORE STAMP|$)/i
    }
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
  console.log("=== PO PDF ANALYSIS START ===");
  console.log(`File: ${filePath}`);

  const text = await extractTextSmart(filePath);

  console.log(`[ANALYSIS] Raw text (first 500 chars):`);
  console.log(text.substring(0, 500) || "(empty)");
  console.log("---");

  const supplier = detectSupplierFromText(text);
  const poNumber = detectPoNumberFromText(text);

  console.log(`[ANALYSIS] Detected supplier: ${supplier || "(none)"}`);
  console.log(`[ANALYSIS] Detected PO number: ${poNumber || "(none)"}`);
  console.log("=== PO PDF ANALYSIS END ===");

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
  detectSupplierFromText,
  detectPoNumberFromText,
  extractWorkOrderFields,
  analyzePoPdf,
};
