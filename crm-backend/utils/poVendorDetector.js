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
 * Detect PO number from PDF text
 * Looks for common PO number patterns
 */
function detectPoNumberFromText(text) {
  if (!text) return null;

  // Try multiple patterns in order of specificity
  const patterns = [
    // "PO# 12345" or "PO #12345" or "PO#12345"
    /po\s*#\s*:?\s*([a-z0-9][a-z0-9-]{1,})/i,
    // "P.O. # 12345" or "P.O. No. 12345" or "P.O. NO. 12345" (with the number on next line possibly)
    /p\.o\.?\s*(?:#|no\.?|number)?\s*:?\s*\n?\s*([a-z0-9][a-z0-9-]{2,})/i,
    // "P.C. NO." - common OCR misread of "P.O. NO."
    /p\.c\.?\s*(?:#|no\.?|number)?\s*:?\s*\n?\s*([a-z0-9][a-z0-9-]{2,})/i,
    // "Purchase Order 12345" or "Purchase Order: 12345" or "Purchase Order #12345"
    /purchase\s+order\s*[#:]*\s*([a-z0-9][a-z0-9-]{2,})/i,
    // "Order # 12345" or "Order Number: 12345"
    /order\s*(?:#|number)\s*:?\s*([a-z0-9][a-z0-9-]{2,})/i,
    // "PO Number: 12345" or "PO No: 12345"
    /po\s+(?:number|no\.?)\s*:?\s*([a-z0-9][a-z0-9-]{2,})/i,
    // Just "PO 12345" (less specific, try last)
    /\bpo\s+([0-9]{3,})\b/i,
    // Standalone number after "no." on its own line (common OCR layout)
    /(?:p\.?[oc]\.?\s*)?no\.?\s*\n+\s*([0-9]{5,})/i,
    // Handle OCR noise like "2 02779415" after p.o. no.
    /p\.?o\.?\s*no\.?\s*\n+\s*\d?\s*([0-9]{5,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const poNum = match[1].trim();
      // Filter out common false positives (words, not alphanumeric codes)
      if (
        poNum.length >= 3 &&
        !/^(box|the|and|for|number|num|no)$/i.test(poNum) &&
        /[0-9]/.test(poNum) // Must contain at least one digit
      ) {
        return poNum;
      }
    }
  }

  return null;
}

/**
 * Extract customer name from text
 * Looks for: "Bill To:", "Customer:", "Client:", "Sold To:"
 */
function extractCustomer(text) {
  if (!text) return null;

  const patterns = [
    // "Bill To" on its own line, then customer on next line
    /bill\s*to\s*\n+\s*([^\n]{3,50})/i,
    // "Bill To:" followed by name (but not "Ship To")
    /bill\s*to[:\s]+(?!ship)([^\n]{3,50})/i,
    // "Customer:" or "Customer Name:"
    /customer(?:\s*name)?[:\s]+([^\n]{3,50})/i,
    // "Client:"
    /client[:\s]+([^\n]{3,50})/i,
    // "Sold To:" on its own line, then name
    /sold\s*to\s*\n+\s*([^\n]{3,50})/i,
    // "Attn:" or "Attention:"
    /att(?:n|ention)[:\s]+([^\n]{3,50})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let name = match[1].trim();
      // Clean up common noise
      name = name.replace(/^\d+\s*/, ''); // Remove leading numbers
      name = name.replace(/[|].*$/, '').trim(); // Remove everything after pipe
      // Filter out if it's "ship to" (common in multi-column layouts)
      if (/^ship\s*to$/i.test(name)) continue;
      // Filter out if it looks like an address (starts with number + street)
      if (/^\d+\s+\w+\s+(st|ave|rd|dr|blvd|ln|way|ct)/i.test(name)) continue;
      if (name.length >= 3 && name.length <= 50) {
        console.log(`[EXTRACT] Customer found via pattern: "${name}"`);
        return name;
      }
    }
  }

  // Fallback: look for common multi-column layout "bill to ship to" followed by names on next line
  // Pattern: "bill to ship to\n<customer> <site>"
  const multiColMatch = text.match(/bill\s*to\s+ship\s*to\s*\n+\s*([^\n]+)/i);
  if (multiColMatch && multiColMatch[1]) {
    // First part before common separators is likely the customer
    let line = multiColMatch[1].trim();
    // Split on common patterns like "|" or multiple spaces
    const parts = line.split(/\s{2,}|\|/).filter(Boolean);
    if (parts.length > 0) {
      let name = parts[0].trim();
      // Clean up
      name = name.replace(/^\d+\s*/, '');
      if (name.length >= 3 && name.length <= 50 && !/^\d+\s+\w+\s+(st|ave|rd)/i.test(name)) {
        console.log(`[EXTRACT] Customer from multi-column: "${name}"`);
        return name;
      }
    }
  }

  console.log("[EXTRACT] No customer found");
  return null;
}

/**
 * Extract work order number from text
 * Looks for: "WO#", "Work Order:", "Service Order:", "Job #"
 */
function extractWorkOrderNumber(text) {
  if (!text) return null;

  const patterns = [
    // "WO# 12345" or "WO #12345" or "WO-12345"
    /wo\s*[#:\-]\s*([a-z0-9][a-z0-9\-]{2,20})/i,
    // "Work Order # 12345" or "Work Order: 12345"
    /work\s*order\s*[#:\-]?\s*([a-z0-9][a-z0-9\-]{2,20})/i,
    // "Service Order # 12345"
    /service\s*order\s*[#:\-]?\s*([a-z0-9][a-z0-9\-]{2,20})/i,
    // "Job # 12345" or "Job Number: 12345"
    /job\s*(?:#|number|no\.?)\s*[:\-]?\s*([a-z0-9][a-z0-9\-]{2,20})/i,
    // "Order # 12345" (but not "Purchase Order" which is PO)
    /(?<!purchase\s)order\s*#\s*([a-z0-9][a-z0-9\-]{2,20})/i,
    // "Ticket # 12345"
    /ticket\s*[#:\-]?\s*([a-z0-9][a-z0-9\-]{2,20})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const woNum = match[1].trim();
      // Must contain at least one digit
      if (/[0-9]/.test(woNum) && woNum.length >= 3) {
        console.log(`[EXTRACT] Work Order # found: "${woNum}"`);
        return woNum;
      }
    }
  }

  console.log("[EXTRACT] No work order number found");
  return null;
}

/**
 * Extract site location name from text
 * Looks for: "Ship To:", "Service Location:", "Job Site:", "Site:", "Location:"
 */
function extractSiteLocation(text) {
  if (!text) return null;

  const patterns = [
    // "Ship To" on its own line, then location on next line
    /ship\s*to\s*\n+\s*([^\n]{3,60})/i,
    // "Ship To:" followed by name
    /ship\s*to[:\s]+([^\n]{3,60})/i,
    // "Service Location:"
    /service\s*location[:\s]+([^\n]{3,60})/i,
    // "Job Site:"
    /job\s*site[:\s]+([^\n]{3,60})/i,
    // "Site Name:"
    /site\s*name[:\s]+([^\n]{3,60})/i,
    // "Location:" (less specific)
    /(?<!service\s)location[:\s]+([^\n]{3,60})/i,
    // "Store:" or "Store #" (common for retail)
    /store\s*[#:\-]?\s*([^\n]{3,60})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let loc = match[1].trim();
      // Clean up common noise
      loc = loc.replace(/[|].*$/, '').trim(); // Remove everything after pipe
      // If it's just an address, skip it (we'll get that separately)
      if (/^\d+\s+\w+\s+(st|ave|rd|dr|blvd|ln|way|ct|street|avenue|road|drive)/i.test(loc)) continue;
      if (loc.length >= 3 && loc.length <= 60) {
        console.log(`[EXTRACT] Site location found: "${loc}"`);
        return loc;
      }
    }
  }

  // Fallback: look for multi-column layout "bill to ship to" followed by names
  const multiColMatch = text.match(/bill\s*to\s+ship\s*to\s*\n+\s*([^\n]+)/i);
  if (multiColMatch && multiColMatch[1]) {
    let line = multiColMatch[1].trim();
    // Second part after common separators is likely the site location
    const parts = line.split(/\s{2,}|\|/).filter(Boolean);
    if (parts.length > 1) {
      let loc = parts[1].trim();
      // Skip if it looks like an address
      if (!/^\d+\s+\w+\s+(st|ave|rd)/i.test(loc) && loc.length >= 3 && loc.length <= 60) {
        console.log(`[EXTRACT] Site location from multi-column: "${loc}"`);
        return loc;
      }
    }
  }

  // Also look for store patterns like "Little Caesars #01752"
  const storeMatch = text.match(/([a-z\s]+(?:store|shop|restaurant|cafe|pizza|market|retail|caesars|mcdonald|starbucks|dunkin|subway|target|walmart|walgreens|cvs)[a-z\s]*(?:#|number|no\.?)?\s*\d+)/i);
  if (storeMatch && storeMatch[1]) {
    let store = storeMatch[1].trim();
    if (store.length >= 5 && store.length <= 60) {
      console.log(`[EXTRACT] Site location from store pattern: "${store}"`);
      return store;
    }
  }

  console.log("[EXTRACT] No site location found");
  return null;
}

/**
 * Extract site address from text
 * Looks for address patterns: number + street, city, state, zip
 */
function extractSiteAddress(text) {
  if (!text) return null;

  // First try to find address after "Ship To:" section
  const shipToMatch = text.match(/ship\s*to[:\s]*\n?([^]*?)(?=\n\s*\n|bill\s*to|$)/i);
  const searchText = shipToMatch ? shipToMatch[1] : text;

  // Look for address pattern: number + street name + (optional city, state zip)
  const addressPatterns = [
    // Full address with city, state, zip
    /(\d+\s+[a-z0-9\s\.]+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|pkwy|parkway)[.,]?\s*(?:#\s*\d+|suite\s*\d+|ste\s*\d+|unit\s*\d+)?[,\s]+[a-z\s]+[,\s]+[a-z]{2}\s*\d{5}(?:-\d{4})?)/i,
    // Address with city state (no zip)
    /(\d+\s+[a-z0-9\s\.]+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place)[.,]?\s*[,\s]+[a-z\s]+[,\s]+[a-z]{2})/i,
    // Just street address
    /(\d+\s+[a-z0-9\s\.]+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|pkwy|parkway)(?:\s*#?\s*\d+)?)/i,
  ];

  for (const pattern of addressPatterns) {
    const match = searchText.match(pattern);
    if (match && match[1]) {
      let addr = match[1].trim();
      // Clean up
      addr = addr.replace(/\s+/g, ' '); // Normalize whitespace
      addr = addr.replace(/[|].*$/, '').trim();
      if (addr.length >= 10 && addr.length <= 150) {
        console.log(`[EXTRACT] Site address found: "${addr}"`);
        return addr;
      }
    }
  }

  console.log("[EXTRACT] No site address found");
  return null;
}

/**
 * Extract problem description from text
 * Looks for: "Problem:", "Description:", "Work Description:", "Scope:", "Issue:", "Service Requested:"
 */
function extractProblemDescription(text) {
  if (!text) return null;

  const patterns = [
    // "Problem:" or "Problem Description:"
    /problem(?:\s*description)?[:\s]+([^\n]{5,200})/i,
    // "Description:" (but not "Job Description" which might be something else)
    /(?<!job\s)description[:\s]+([^\n]{5,200})/i,
    // "Work Description:"
    /work\s*description[:\s]+([^\n]{5,200})/i,
    // "Scope:" or "Scope of Work:"
    /scope(?:\s*of\s*work)?[:\s]+([^\n]{5,200})/i,
    // "Issue:"
    /issue[:\s]+([^\n]{5,200})/i,
    // "Service Requested:"
    /service\s*requested[:\s]+([^\n]{5,200})/i,
    // "Work to be performed:" or "Work to be done:"
    /work\s*to\s*be\s*(?:performed|done)[:\s]+([^\n]{5,200})/i,
    // "Reason for call:" or "Reason:"
    /reason(?:\s*for\s*call)?[:\s]+([^\n]{5,200})/i,
    // "Notes:" (often contains problem info)
    /notes[:\s]+([^\n]{5,200})/i,
    // "Service Call" followed by description
    /service\s*call[:\s]+([^\n]{5,200})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let desc = match[1].trim();
      // Clean up
      desc = desc.replace(/[|].*$/, '').trim();
      if (desc.length >= 5 && desc.length <= 200) {
        console.log(`[EXTRACT] Problem description found: "${desc}"`);
        return desc;
      }
    }
  }

  // Fallback: look for common glass-related keywords as problem indicators
  const glassKeywords = [
    /(?:broken|cracked|shattered|damaged)\s+(?:glass|window|door|mirror)/i,
    /(?:glass|window|door|mirror)\s+(?:is|was|needs?|requires?)\s+(?:broken|cracked|replaced|fixed|repaired)/i,
    /replace\s+(?:glass|window|door|storefront)/i,
    /door\s*closer/i,
    /emergency\s+(?:board[- ]?up|glass|repair)/i,
  ];

  for (const pattern of glassKeywords) {
    const match = text.match(pattern);
    if (match) {
      // Get surrounding context (up to 100 chars before/after)
      const idx = text.indexOf(match[0]);
      const start = Math.max(0, idx - 50);
      const end = Math.min(text.length, idx + match[0].length + 100);
      let context = text.substring(start, end).trim();
      context = context.replace(/\s+/g, ' ');
      if (context.length >= 10) {
        console.log(`[EXTRACT] Problem from keywords: "${context}"`);
        return context;
      }
    }
  }

  console.log("[EXTRACT] No problem description found");
  return null;
}

/**
 * Extract all work order fields from OCR text
 * Returns structured object with all detected fields
 */
function extractWorkOrderFields(text) {
  console.log("=== WORK ORDER FIELD EXTRACTION START ===");
  console.log(`[EXTRACT] Input text length: ${text ? text.length : 0} chars`);

  if (!text || text.length < 10) {
    console.log("[EXTRACT] Text too short, returning empty result");
    return {
      customer: null,
      poNumber: null,
      workOrderNumber: null,
      siteLocation: null,
      siteAddress: null,
      problemDescription: null,
      rawText: text || ""
    };
  }

  const customer = extractCustomer(text);
  const poNumber = detectPoNumberFromText(text);
  const workOrderNumber = extractWorkOrderNumber(text);
  const siteLocation = extractSiteLocation(text);
  const siteAddress = extractSiteAddress(text);
  const problemDescription = extractProblemDescription(text);

  console.log("=== EXTRACTION RESULTS ===");
  console.log(`  Customer: ${customer || "(not found)"}`);
  console.log(`  PO Number: ${poNumber || "(not found)"}`);
  console.log(`  Work Order #: ${workOrderNumber || "(not found)"}`);
  console.log(`  Site Location: ${siteLocation || "(not found)"}`);
  console.log(`  Site Address: ${siteAddress || "(not found)"}`);
  console.log(`  Problem: ${problemDescription || "(not found)"}`);
  console.log("=== WORK ORDER FIELD EXTRACTION END ===");

  return {
    customer,
    poNumber,
    workOrderNumber,
    siteLocation,
    siteAddress,
    problemDescription,
    rawText: text.substring(0, 1000) // First 1000 chars for debugging
  };
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
