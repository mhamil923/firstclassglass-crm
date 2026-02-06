const fs = require("fs");
const path = require("path");
const os = require("os");
const pdfParse = require("pdf-parse");

// Lazy-load OCR dependencies (they're heavy)
let Tesseract = null;
let pdf2pic = null;

/**
 * Initialize OCR dependencies on first use
 */
async function initOCR() {
  if (!Tesseract) {
    Tesseract = require("tesseract.js");
    console.log("[OCR] Tesseract.js loaded");
  }
  if (!pdf2pic) {
    const { fromPath } = require("pdf2pic");
    pdf2pic = fromPath;
    console.log("[OCR] pdf2pic loaded");
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
 * Extract text from a scanned PDF using OCR
 * Converts first page to image, then runs Tesseract OCR
 */
async function extractTextFromScannedPdf(filePath) {
  await initOCR();

  const tmpDir = os.tmpdir();
  const baseName = `ocr-${Date.now()}`;

  console.log(`[OCR] Starting OCR extraction for: ${path.basename(filePath)}`);

  try {
    // Convert PDF first page to PNG image
    const options = {
      density: 200,           // DPI - higher = better quality but slower
      saveFilename: baseName,
      savePath: tmpDir,
      format: "png",
      width: 1700,            // Good width for OCR
      height: 2200,           // Letter paper proportions
    };

    const convert = pdf2pic(filePath, options);
    const pageResult = await convert(1); // Convert first page only

    if (!pageResult || !pageResult.path) {
      console.warn("[OCR] PDF to image conversion failed - no output path");
      return "";
    }

    console.log(`[OCR] PDF converted to image: ${pageResult.path}`);

    // Run Tesseract OCR on the image
    console.log("[OCR] Running Tesseract OCR...");
    const { data: { text } } = await Tesseract.recognize(pageResult.path, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          // Progress updates (optional - can be noisy)
          // console.log(`[OCR] Progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });

    console.log(`[OCR] Extraction complete. Text length: ${text ? text.length : 0}`);

    // Clean up temp image file
    try {
      if (fs.existsSync(pageResult.path)) {
        fs.unlinkSync(pageResult.path);
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
    /po\s*#\s*:?\s*([a-z0-9-]{2,})/i,
    // "P.O. 12345" or "P.O.# 12345"
    /p\.o\.?\s*#?\s*:?\s*([a-z0-9-]{2,})/i,
    // "Purchase Order 12345" or "Purchase Order: 12345" or "Purchase Order #12345"
    /purchase\s+order\s*[#:]*\s*([a-z0-9-]{2,})/i,
    // "Order # 12345" or "Order #12345" or "Order Number: 12345"
    /order\s*(?:#|number|num|no\.?)\s*:?\s*([a-z0-9-]{2,})/i,
    // "PO Number: 12345"
    /po\s+(?:number|num|no\.?)\s*:?\s*([a-z0-9-]{2,})/i,
    // Just "PO 12345" (less specific, try last)
    /\bpo\s+([0-9]{3,})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const poNum = match[1].trim();
      // Filter out common false positives
      if (poNum.length >= 2 && !/^(box|the|and|for)$/i.test(poNum)) {
        return poNum;
      }
    }
  }

  return null;
}

/**
 * Main extraction function - extracts text and detects vendor/PO
 * Returns { text, supplier, poNumber, method }
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
  analyzePoPdf,
};
