// PdfTemplateBuilder.js
//
// QuickBooks-style zone-based PDF template designer.
// Three-panel layout: element library | document canvas | properties.
//
// Configs created by this editor are stored with `layoutMode: "zones"`
// in the existing pdf_templates table. The backend (server.js) detects
// the new format and renders the document zone-by-zone. Old templates
// (free-form positioning) continue to load through the legacy code path
// in `LegacyTemplateRedirect` below — when one is opened, the user is
// taken to the previous editor route, so existing templates remain
// fully editable and renderable.

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";
import "./PdfTemplateBuilder.css";

/* ──────────────────────────────────────────────────────────────────
   CONSTANTS
   ────────────────────────────────────────────────────────────────── */

const PAGE_W = 612;   // letter, in pt — matches backend PDFKit
const PAGE_H = 792;
const CANVAS_SCALE = 0.82; // visual scale for the on-screen preview

const ZONES = [
  { id: "header-left",  label: "Header — Left",  row: 0, col: 0 },
  { id: "header-right", label: "Header — Right", row: 0, col: 1 },
  { id: "bill-to",      label: "Bill To",        row: 1, col: 0 },
  { id: "ship-to",      label: "Ship To",        row: 1, col: 1 },
  { id: "line-items",   label: "Line Items",     row: 2, col: "full" },
  { id: "totals",       label: "Totals",         row: 3, col: "right" },
  { id: "footer",       label: "Footer",         row: 4, col: "full" },
];

const FONT_THEMES = {
  modern:  { label: "Modern (Arial)",        body: "Arial, Helvetica, sans-serif", pdfBody: "Helvetica", pdfBold: "Helvetica-Bold" },
  classic: { label: "Classic (Times)",       body: "'Times New Roman', Times, serif", pdfBody: "Times-Roman", pdfBold: "Times-Bold" },
  clean:   { label: "Clean (Helvetica)",     body: "Helvetica, Arial, sans-serif", pdfBody: "Helvetica", pdfBold: "Helvetica-Bold" },
};

const COLOR_SCHEMES = {
  default: { label: "Default", primary: "#000000", secondary: "#ffffff", tableHeader: "#e5e7eb", titleColor: "#000000" },
  blue:    { label: "Blue",    primary: "#1a56db", secondary: "#ffffff", tableHeader: "#e8f0fe", titleColor: "#1a56db" },
  green:   { label: "Green",   primary: "#166534", secondary: "#ffffff", tableHeader: "#dcfce7", titleColor: "#166534" },
  gray:    { label: "Gray",    primary: "#374151", secondary: "#ffffff", tableHeader: "#f3f4f6", titleColor: "#374151" },
  navy:    { label: "Navy",    primary: "#1e3a5f", secondary: "#ffffff", tableHeader: "#dbeafe", titleColor: "#1e3a5f" },
  custom:  { label: "Custom",  primary: "#000000", secondary: "#ffffff", tableHeader: "#e5e7eb", titleColor: "#000000" },
};

// Element catalog — chips shown in the left panel.
// `defaultZone` controls where a freshly-dragged item snaps when the
// user does not drop directly into a specific zone.
const ELEMENT_CATALOG = [
  {
    section: "Company Info",
    key: "company",
    items: [
      { type: "data", dataKey: "companyName",    label: "Company Name",    defaultZone: "header-left", defaults: { fontSize: 14, bold: true } },
      { type: "data", dataKey: "companyAddress", label: "Company Address", defaultZone: "header-left", defaults: { fontSize: 9 } },
      { type: "data", dataKey: "companyPhoneFax",label: "Phone / Fax",     defaultZone: "header-left", defaults: { fontSize: 9 } },
      { type: "data", dataKey: "companyEmail",   label: "Email",           defaultZone: "header-left", defaults: { fontSize: 9 } },
      { type: "logo", label: "Company Logo",     defaultZone: "header-left", defaults: { width: 90, height: 90 } },
      { type: "text", label: "Tagline / Custom Text", defaultZone: "header-left", defaults: { text: "Your tagline here", fontSize: 10, italic: true } },
    ],
  },
  {
    section: "Document Header",
    key: "header",
    items: [
      { type: "data", dataKey: "documentTitle",  label: "Document Title (Estimate / Invoice)", defaultZone: "header-right", defaults: { fontSize: 24, bold: true, align: "right" } },
      { type: "data", dataKey: "documentNumber", label: "Document Number", defaultZone: "header-right", defaults: { fontSize: 10, align: "right", showLabel: true, label: "No." } },
      { type: "data", dataKey: "date",           label: "Date",            defaultZone: "header-right", defaults: { fontSize: 10, align: "right", showLabel: true, label: "Date" } },
      { type: "data", dataKey: "dueDate",        label: "Due Date",        defaultZone: "header-right", defaults: { fontSize: 10, align: "right", showLabel: true, label: "Due" } },
      { type: "data", dataKey: "poNumber",       label: "PO Number",       defaultZone: "header-right", defaults: { fontSize: 10, align: "right", showLabel: true, label: "P.O." } },
    ],
  },
  {
    section: "Bill To / Ship To",
    key: "billto",
    items: [
      { type: "data", dataKey: "billToBlock", label: "Bill To Block", defaultZone: "bill-to", defaults: { fontSize: 10, showLabel: true, label: "BILL TO" } },
      { type: "data", dataKey: "shipToBlock", label: "Ship To / Project Block", defaultZone: "ship-to", defaults: { fontSize: 10, showLabel: true, label: "SHIP TO" } },
    ],
  },
  {
    section: "Line Items Table",
    key: "table",
    items: [
      { type: "table", tableStyle: "full",  label: "Full Line Items Table",     defaultZone: "line-items",
        defaults: { columns: { qty: true, description: true, unitPrice: false, amount: true }, columnLabels: { qty: "QTY", description: "DESCRIPTION", unitPrice: "UNIT PRICE", amount: "AMOUNT" }, showBorders: true, altRowColor: false, headerBgColor: "#e5e7eb" } },
      { type: "table", tableStyle: "desc",  label: "Description Only",          defaultZone: "line-items",
        defaults: { columns: { qty: false, description: true, unitPrice: false, amount: false }, columnLabels: { description: "DESCRIPTION" }, showBorders: true, altRowColor: false, headerBgColor: "#e5e7eb" } },
      { type: "table", tableStyle: "unit",  label: "Table with Unit Price",     defaultZone: "line-items",
        defaults: { columns: { qty: true, description: true, unitPrice: true, amount: true }, columnLabels: { qty: "QTY", description: "DESCRIPTION", unitPrice: "UNIT PRICE", amount: "AMOUNT" }, showBorders: true, altRowColor: true, headerBgColor: "#e5e7eb" } },
    ],
  },
  {
    section: "Totals",
    key: "totals",
    items: [
      { type: "totals", totalsKind: "subtotal",  label: "Subtotal",       defaultZone: "totals", defaults: { fontSize: 10 } },
      { type: "totals", totalsKind: "tax",       label: "Tax Line",       defaultZone: "totals", defaults: { fontSize: 10 } },
      { type: "totals", totalsKind: "total",     label: "Total",          defaultZone: "totals", defaults: { fontSize: 12, bold: true } },
      { type: "totals", totalsKind: "balance",   label: "Balance Due",    defaultZone: "totals", defaults: { fontSize: 12, bold: true } },
      { type: "totals", totalsKind: "block",     label: "Full Totals Block", defaultZone: "totals", defaults: { fontSize: 11 } },
    ],
  },
  {
    section: "Footer",
    key: "footer",
    items: [
      { type: "data", dataKey: "paymentTerms", label: "Payment Terms",   defaultZone: "footer", defaults: { fontSize: 9, showLabel: true, label: "Terms" } },
      { type: "data", dataKey: "notes",        label: "Notes / Message", defaultZone: "footer", defaults: { fontSize: 9 } },
      { type: "text", label: "Thank You Message", defaultZone: "footer", defaults: { text: "Thank you for your business!", fontSize: 11, italic: true, align: "center" } },
      { type: "signature", label: "Signature Line", defaultZone: "footer", defaults: { signatureLabel: "Authorized Signature" } },
      { type: "text", label: "Custom Text Block", defaultZone: "footer", defaults: { text: "Custom text", fontSize: 10 } },
      { type: "divider", label: "Horizontal Divider Line", defaultZone: "footer", defaults: { thickness: 1, color: "#000000" } },
    ],
  },
  {
    section: "Design Elements",
    key: "design",
    items: [
      { type: "image",    label: "Logo / Image Upload", defaultZone: "header-left", defaults: { width: 100, height: 60 } },
      { type: "colorBar", label: "Color Bar / Header Band", defaultZone: "header-left", defaults: { thickness: 8, color: "#1a56db" } },
      { type: "borderBox",label: "Border Box",            defaultZone: "footer",      defaults: { borderColor: "#000000", borderWidth: 1, height: 60 } },
      { type: "spacer",   label: "Spacer",                defaultZone: "footer",      defaults: { height: 12 } },
    ],
  },
];

// Sample data the in-editor canvas previews against.
const SAMPLE_DATA = {
  companyName: "First Class Glass & Mirror, Inc.",
  companyAddress: "1513 Industrial Drive\nItasca, IL 60143",
  companyPhoneFax: "Phone: 630-250-9777\nFax: 630-250-9727",
  companyEmail: "office@firstclassglass.com",
  documentTitle: "ESTIMATE",
  documentNumber: "EST-1042",
  date: "4/8/2026",
  dueDate: "5/8/2026",
  poNumber: "PO-12345",
  billToBlock: "SAMPLE CUSTOMER INC.\n123 Main Street\nChicago, IL 60601",
  shipToBlock: "OFFICE RENOVATION\n456 Oak Avenue\nChicago, IL 60602",
  paymentTerms: "Net 30. All prices valid for 30 days.",
  notes: "Please review and sign to approve.",
};

const SAMPLE_LINE_ITEMS = [
  { qty: 1, description: "Initial service call",          unitPrice: 150,  amount: 150 },
  { qty: 2, description: "Tempered glass panel 48\" × 72\"", unitPrice: 425, amount: 850 },
  { qty: 4, description: "Labor — installation",          unitPrice: 75,   amount: 300 },
];

const SAMPLE_TOTALS = { subtotal: 1300, tax: 0, total: 1300, balance: 1300 };

/* ──────────────────────────────────────────────────────────────────
   STATE HELPERS
   ────────────────────────────────────────────────────────────────── */

let _idCounter = 0;
const newId = () => `el_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

function makeElementFromCatalog(item) {
  const base = {
    id: newId(),
    type: item.type,
    label: item.label,
    fontFamily: "inherit",
    fontSize: 10,
    bold: false,
    italic: false,
    underline: false,
    color: "#000000",
    align: "left",
    paddingTop: 4,
    paddingBottom: 4,
  };
  if (item.type === "data") base.dataKey = item.dataKey;
  if (item.type === "table") base.tableStyle = item.tableStyle;
  if (item.type === "totals") base.totalsKind = item.totalsKind;
  return { ...base, ...(item.defaults || {}) };
}

function emptyZones() {
  const z = {};
  for (const zone of ZONES) z[zone.id] = [];
  return z;
}

function isZoneFormat(cfg) {
  return !!(cfg && cfg.layoutMode === "zones" && cfg.zones);
}

function makeBlankConfig() {
  return {
    layoutMode: "zones",
    colorScheme: "default",
    customColors: { primary: "#000000", secondary: "#ffffff" },
    fontTheme: "modern",
    zones: emptyZones(),
  };
}

/* ──────────────────────────────────────────────────────────────────
   LEGACY TEMPLATE REDIRECT
   ────────────────────────────────────────────────────────────────── */
//
// When the user opens an existing template that was saved with the
// old free-form positioning editor, we don't try to migrate it — that
// would lose layout fidelity. Instead we offer the user a clear path:
// open it in the legacy editor (route preserved) or start fresh.

function LegacyTemplateNotice({ id, name, onStartFresh }) {
  return (
    <div className="ptb-legacy-notice">
      <h2>This template uses the classic editor</h2>
      <p>
        <strong>{name || "This template"}</strong> was created with the
        original free-form PDF editor. To preserve its layout exactly, it
        opens in the classic editor.
      </p>
      <p>You can also start a brand-new template using the new designer.</p>
      <div className="ptb-legacy-actions">
        <Link to={`/pdf-templates/legacy/${id}`} className="ptb-btn ptb-btn-primary">
          Open in classic editor
        </Link>
        <button className="ptb-btn" onClick={onStartFresh}>
          Start a new zone-based template
        </button>
        <Link to="/pdf-templates" className="ptb-btn">Back to templates</Link>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   ELEMENT RENDERERS (preview on the canvas)
   ────────────────────────────────────────────────────────────────── */

function elementInlineStyle(el) {
  return {
    fontFamily: el.fontFamily && el.fontFamily !== "inherit" ? el.fontFamily : undefined,
    fontSize: (el.fontSize || 10) * CANVAS_SCALE * 1.15,
    fontWeight: el.bold ? 700 : 400,
    fontStyle: el.italic ? "italic" : "normal",
    textDecoration: el.underline ? "underline" : "none",
    color: el.color || "#000000",
    textAlign: el.align || "left",
    paddingTop: (el.paddingTop ?? 4) * CANVAS_SCALE,
    paddingBottom: (el.paddingBottom ?? 4) * CANVAS_SCALE,
  };
}

function dataValueFor(el) {
  if (el.dataKey === "documentTitle") return SAMPLE_DATA.documentTitle;
  return SAMPLE_DATA[el.dataKey] || `[${el.dataKey}]`;
}

function ElementPreview({ el, scheme }) {
  if (el.type === "data") {
    const v = dataValueFor(el);
    return (
      <div style={elementInlineStyle(el)}>
        {el.showLabel && el.label ? (
          <div style={{ fontSize: "0.75em", textTransform: "uppercase", opacity: 0.7 }}>{el.label}</div>
        ) : null}
        <div style={{ whiteSpace: "pre-wrap" }}>{v}</div>
      </div>
    );
  }

  if (el.type === "text") {
    return (
      <div style={{ ...elementInlineStyle(el), whiteSpace: "pre-wrap" }}>
        {el.text || "Custom text"}
      </div>
    );
  }

  if (el.type === "logo" || el.type === "image") {
    const url = el.imageUrl || `${API_BASE_URL}/assets/logo`;
    return (
      <div style={{ textAlign: el.align || "left", paddingTop: (el.paddingTop ?? 4) * CANVAS_SCALE, paddingBottom: (el.paddingBottom ?? 4) * CANVAS_SCALE }}>
        <img
          src={url}
          alt="logo"
          style={{
            width: (el.width || 90) * CANVAS_SCALE,
            height: (el.height || 90) * CANVAS_SCALE,
            objectFit: "contain",
            display: "inline-block",
          }}
          onError={(e) => { e.currentTarget.style.opacity = 0.3; }}
        />
      </div>
    );
  }

  if (el.type === "table") {
    const cols = el.columns || { qty: true, description: true, amount: true };
    const labels = el.columnLabels || {};
    const headerBg = el.headerBgColor || scheme.tableHeader;
    return (
      <table className="ptb-table-preview" style={{ width: "100%", borderCollapse: "collapse", fontSize: (el.fontSize || 9) * CANVAS_SCALE * 1.15 }}>
        <thead>
          <tr style={{ backgroundColor: headerBg }}>
            {cols.qty &&         <th style={thStyle(el)}>{labels.qty || "QTY"}</th>}
            {cols.description && <th style={{ ...thStyle(el), textAlign: "left" }}>{labels.description || "DESCRIPTION"}</th>}
            {cols.unitPrice &&   <th style={{ ...thStyle(el), textAlign: "right" }}>{labels.unitPrice || "UNIT PRICE"}</th>}
            {cols.amount &&      <th style={{ ...thStyle(el), textAlign: "right" }}>{labels.amount || "AMOUNT"}</th>}
          </tr>
        </thead>
        <tbody>
          {SAMPLE_LINE_ITEMS.map((row, i) => (
            <tr key={i} style={el.altRowColor && i % 2 === 1 ? { backgroundColor: "#f9fafb" } : undefined}>
              {cols.qty &&         <td style={tdStyle(el, "center")}>{row.qty}</td>}
              {cols.description && <td style={tdStyle(el, "left")}>{row.description}</td>}
              {cols.unitPrice &&   <td style={tdStyle(el, "right")}>${row.unitPrice.toFixed(2)}</td>}
              {cols.amount &&      <td style={tdStyle(el, "right")}>${row.amount.toFixed(2)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (el.type === "totals") {
    const lines = [];
    if (el.totalsKind === "subtotal" || el.totalsKind === "block") lines.push(["Subtotal", SAMPLE_TOTALS.subtotal]);
    if (el.totalsKind === "tax"      || el.totalsKind === "block") lines.push(["Tax",       SAMPLE_TOTALS.tax]);
    if (el.totalsKind === "total"    || el.totalsKind === "block") lines.push(["Total",     SAMPLE_TOTALS.total]);
    if (el.totalsKind === "balance") lines.push(["Balance Due", SAMPLE_TOTALS.balance]);
    return (
      <div style={{ ...elementInlineStyle(el), minWidth: 180 * CANVAS_SCALE }}>
        {lines.map(([k, v], i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <span>{k}</span>
            <span>${Number(v).toFixed(2)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (el.type === "divider") {
    return <hr style={{ border: 0, borderTop: `${(el.thickness || 1) * CANVAS_SCALE}px solid ${el.color || "#000"}`, margin: `${(el.paddingTop ?? 4) * CANVAS_SCALE}px 0 ${(el.paddingBottom ?? 4) * CANVAS_SCALE}px` }} />;
  }

  if (el.type === "colorBar") {
    return <div style={{ width: "100%", height: (el.thickness || 8) * CANVAS_SCALE, backgroundColor: el.color || "#1a56db" }} />;
  }

  if (el.type === "borderBox") {
    return (
      <div style={{
        height: (el.height || 60) * CANVAS_SCALE,
        border: `${el.borderWidth || 1}px solid ${el.borderColor || "#000"}`,
      }} />
    );
  }

  if (el.type === "spacer") {
    return <div style={{ height: (el.height || 12) * CANVAS_SCALE }} />;
  }

  if (el.type === "signature") {
    return (
      <div style={{ paddingTop: 18 * CANVAS_SCALE, fontSize: (el.fontSize || 9) * CANVAS_SCALE * 1.15 }}>
        <div style={{ borderTop: "1px solid #000", width: "60%", marginBottom: 4 }} />
        <div>{el.signatureLabel || "Authorized Signature"}</div>
      </div>
    );
  }

  return <div style={{ color: "#999", fontSize: 10 }}>[{el.type}]</div>;
}

const thStyle = (el) => ({
  padding: `${4 * CANVAS_SCALE}px ${6 * CANVAS_SCALE}px`,
  border: "1px solid #d1d5db",
  fontWeight: 700,
  fontSize: "0.85em",
  textAlign: "center",
});
const tdStyle = (el, align) => ({
  padding: `${3 * CANVAS_SCALE}px ${6 * CANVAS_SCALE}px`,
  border: "1px solid #e5e7eb",
  textAlign: align,
});

/* ──────────────────────────────────────────────────────────────────
   ZONE / CANVAS COMPONENTS
   ────────────────────────────────────────────────────────────────── */

function ZoneBox({ zone, elements, scheme, selectedId, onSelect, onDropElement, onMoveElement, onDeleteElement }) {
  const [over, setOver] = useState(false);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!over) setOver(true);
  };
  const handleDragLeave = () => setOver(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (payload.kind === "catalog") {
      onDropElement(zone.id, makeElementFromCatalog(payload.item));
    } else if (payload.kind === "move") {
      onMoveElement(payload.elementId, payload.fromZone, zone.id);
    }
  };

  return (
    <div
      className={`ptb-zone ${over ? "is-over" : ""}`}
      data-zone={zone.id}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="ptb-zone-label">{zone.label}</div>
      {elements.length === 0 ? (
        <div className="ptb-zone-empty">Drop elements here</div>
      ) : (
        elements.map((el) => (
          <div
            key={el.id}
            className={`ptb-element ${selectedId === el.id ? "is-selected" : ""}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                "application/json",
                JSON.stringify({ kind: "move", elementId: el.id, fromZone: zone.id })
              );
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(el.id, zone.id);
            }}
          >
            <ElementPreview el={el} scheme={scheme} />
            {selectedId === el.id && (
              <button
                type="button"
                className="ptb-element-trash"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteElement(el.id, zone.id);
                }}
                title="Delete element"
              >
                ×
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function Canvas({ zones, scheme, selectedId, onSelect, onDropElement, onMoveElement, onDeleteElement }) {
  const grouped = useMemo(() => {
    return {
      headerLeft:  zones["header-left"]  || [],
      headerRight: zones["header-right"] || [],
      billTo:      zones["bill-to"]      || [],
      shipTo:      zones["ship-to"]      || [],
      lineItems:   zones["line-items"]   || [],
      totals:      zones["totals"]       || [],
      footer:      zones["footer"]       || [],
    };
  }, [zones]);

  const zoneFor = (id) => ZONES.find((z) => z.id === id);

  return (
    <div
      className="ptb-canvas"
      style={{
        width: PAGE_W * CANVAS_SCALE,
        minHeight: PAGE_H * CANVAS_SCALE,
      }}
      onClick={() => onSelect(null, null)}
    >
      <div className="ptb-canvas-row ptb-canvas-row-2">
        <ZoneBox zone={zoneFor("header-left")}  elements={grouped.headerLeft}  scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
        <ZoneBox zone={zoneFor("header-right")} elements={grouped.headerRight} scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
      </div>
      <div className="ptb-canvas-row ptb-canvas-row-2">
        <ZoneBox zone={zoneFor("bill-to")} elements={grouped.billTo} scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
        <ZoneBox zone={zoneFor("ship-to")} elements={grouped.shipTo} scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
      </div>
      <div className="ptb-canvas-row ptb-canvas-row-1">
        <ZoneBox zone={zoneFor("line-items")} elements={grouped.lineItems} scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
      </div>
      <div className="ptb-canvas-row ptb-canvas-row-right">
        <div style={{ flex: 1 }} />
        <ZoneBox zone={zoneFor("totals")} elements={grouped.totals} scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
      </div>
      <div className="ptb-canvas-row ptb-canvas-row-1">
        <ZoneBox zone={zoneFor("footer")} elements={grouped.footer} scheme={scheme} selectedId={selectedId} onSelect={onSelect} onDropElement={onDropElement} onMoveElement={onMoveElement} onDeleteElement={onDeleteElement} />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   LEFT PANEL — element library
   ────────────────────────────────────────────────────────────────── */

function LeftPanel() {
  const [openSections, setOpenSections] = useState(() => {
    const o = {};
    ELEMENT_CATALOG.forEach((s, i) => { o[s.key] = i < 3; });
    return o;
  });

  return (
    <aside className="ptb-left">
      <h3 className="ptb-panel-title">Elements</h3>
      {ELEMENT_CATALOG.map((section) => (
        <div key={section.key} className="ptb-cat">
          <button
            type="button"
            className="ptb-cat-header"
            onClick={() => setOpenSections((s) => ({ ...s, [section.key]: !s[section.key] }))}
          >
            <span>{section.section}</span>
            <span className="ptb-cat-chev">{openSections[section.key] ? "▾" : "▸"}</span>
          </button>
          {openSections[section.key] && (
            <div className="ptb-cat-items">
              {section.items.map((item, idx) => (
                <div
                  key={idx}
                  className="ptb-chip"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      "application/json",
                      JSON.stringify({ kind: "catalog", item })
                    );
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title="Drag onto the document"
                >
                  {item.label}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────────────
   RIGHT PANEL — properties
   ────────────────────────────────────────────────────────────────── */

function PropRow({ label, children }) {
  return (
    <div className="ptb-prop-row">
      <div className="ptb-prop-label">{label}</div>
      <div className="ptb-prop-control">{children}</div>
    </div>
  );
}

function RightPanel({ selected, onUpdate, onDelete }) {
  if (!selected) {
    return (
      <aside className="ptb-right">
        <h3 className="ptb-panel-title">Properties</h3>
        <p className="ptb-empty-help">Select an element on the canvas to edit its properties.</p>
      </aside>
    );
  }

  const el = selected.element;
  const set = (patch) => onUpdate(selected.zoneId, el.id, patch);

  return (
    <aside className="ptb-right">
      <h3 className="ptb-panel-title">{el.label || el.type}</h3>

      {/* TEXT-LIKE editors */}
      {(el.type === "text" || el.type === "data" || el.type === "totals" || el.type === "signature") && (
        <>
          {el.type === "text" && (
            <PropRow label="Content">
              <textarea
                value={el.text || ""}
                onChange={(e) => set({ text: e.target.value })}
                rows={3}
              />
            </PropRow>
          )}
          {el.type === "signature" && (
            <PropRow label="Label">
              <input value={el.signatureLabel || ""} onChange={(e) => set({ signatureLabel: e.target.value })} />
            </PropRow>
          )}
          <PropRow label="Font">
            <select value={el.fontFamily || "inherit"} onChange={(e) => set({ fontFamily: e.target.value })}>
              <option value="inherit">Theme default</option>
              <option value="Arial, Helvetica, sans-serif">Arial</option>
              <option value="Helvetica, Arial, sans-serif">Helvetica</option>
              <option value="'Times New Roman', Times, serif">Times New Roman</option>
              <option value="Georgia, serif">Georgia</option>
            </select>
          </PropRow>
          <PropRow label="Size">
            <div className="ptb-inline">
              <input type="range" min="8" max="24" value={el.fontSize || 10} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
              <input type="number" min="8" max="48" value={el.fontSize || 10} onChange={(e) => set({ fontSize: Number(e.target.value) })} className="ptb-num" />
            </div>
          </PropRow>
          <PropRow label="Style">
            <div className="ptb-inline">
              <button type="button" className={`ptb-tog ${el.bold ? "is-on" : ""}`} onClick={() => set({ bold: !el.bold })}><b>B</b></button>
              <button type="button" className={`ptb-tog ${el.italic ? "is-on" : ""}`} onClick={() => set({ italic: !el.italic })}><i>I</i></button>
              <button type="button" className={`ptb-tog ${el.underline ? "is-on" : ""}`} onClick={() => set({ underline: !el.underline })}><u>U</u></button>
            </div>
          </PropRow>
          <PropRow label="Color">
            <input type="color" value={el.color || "#000000"} onChange={(e) => set({ color: e.target.value })} />
          </PropRow>
          <PropRow label="Align">
            <div className="ptb-inline">
              {["left", "center", "right"].map((a) => (
                <button
                  type="button"
                  key={a}
                  className={`ptb-tog ${el.align === a ? "is-on" : ""}`}
                  onClick={() => set({ align: a })}
                >
                  {a[0].toUpperCase()}
                </button>
              ))}
            </div>
          </PropRow>
          {el.type === "data" && (
            <>
              <PropRow label="Show label">
                <input type="checkbox" checked={!!el.showLabel} onChange={(e) => set({ showLabel: e.target.checked })} />
              </PropRow>
              {el.showLabel && (
                <PropRow label="Label">
                  <input value={el.label || ""} onChange={(e) => set({ label: e.target.value })} />
                </PropRow>
              )}
            </>
          )}
        </>
      )}

      {/* IMAGE / LOGO */}
      {(el.type === "image" || el.type === "logo") && (
        <>
          <PropRow label="Image URL">
            <input value={el.imageUrl || ""} placeholder="(uses company logo)" onChange={(e) => set({ imageUrl: e.target.value })} />
          </PropRow>
          <PropRow label="Width (pt)">
            <input type="number" min="10" max="500" value={el.width || 90} onChange={(e) => set({ width: Number(e.target.value) })} />
          </PropRow>
          <PropRow label="Height (pt)">
            <input type="number" min="10" max="500" value={el.height || 90} onChange={(e) => set({ height: Number(e.target.value) })} />
          </PropRow>
          <PropRow label="Align">
            <div className="ptb-inline">
              {["left", "center", "right"].map((a) => (
                <button type="button" key={a} className={`ptb-tog ${el.align === a ? "is-on" : ""}`} onClick={() => set({ align: a })}>
                  {a[0].toUpperCase()}
                </button>
              ))}
            </div>
          </PropRow>
        </>
      )}

      {/* TABLE */}
      {el.type === "table" && (
        <>
          <div className="ptb-prop-section">Columns</div>
          {["qty", "description", "unitPrice", "amount"].map((c) => (
            <PropRow key={c} label={c === "unitPrice" ? "Unit Price" : c[0].toUpperCase() + c.slice(1)}>
              <div className="ptb-inline">
                <input
                  type="checkbox"
                  checked={!!(el.columns && el.columns[c])}
                  onChange={(e) => set({ columns: { ...(el.columns || {}), [c]: e.target.checked } })}
                />
                <input
                  className="ptb-grow"
                  placeholder="Header"
                  value={(el.columnLabels && el.columnLabels[c]) || ""}
                  onChange={(e) => set({ columnLabels: { ...(el.columnLabels || {}), [c]: e.target.value } })}
                />
              </div>
            </PropRow>
          ))}
          <PropRow label="Show borders">
            <input type="checkbox" checked={el.showBorders !== false} onChange={(e) => set({ showBorders: e.target.checked })} />
          </PropRow>
          <PropRow label="Header bg">
            <input type="color" value={el.headerBgColor || "#e5e7eb"} onChange={(e) => set({ headerBgColor: e.target.value })} />
          </PropRow>
          <PropRow label="Alt rows">
            <input type="checkbox" checked={!!el.altRowColor} onChange={(e) => set({ altRowColor: e.target.checked })} />
          </PropRow>
        </>
      )}

      {/* DIVIDER / COLOR BAR */}
      {(el.type === "divider" || el.type === "colorBar") && (
        <>
          <PropRow label="Color">
            <input type="color" value={el.color || "#000000"} onChange={(e) => set({ color: e.target.value })} />
          </PropRow>
          <PropRow label="Thickness">
            <input type="number" min="1" max="40" value={el.thickness || (el.type === "divider" ? 1 : 8)} onChange={(e) => set({ thickness: Number(e.target.value) })} />
          </PropRow>
        </>
      )}

      {/* BORDER BOX */}
      {el.type === "borderBox" && (
        <>
          <PropRow label="Border color">
            <input type="color" value={el.borderColor || "#000000"} onChange={(e) => set({ borderColor: e.target.value })} />
          </PropRow>
          <PropRow label="Border width">
            <input type="number" min="1" max="10" value={el.borderWidth || 1} onChange={(e) => set({ borderWidth: Number(e.target.value) })} />
          </PropRow>
          <PropRow label="Height">
            <input type="number" min="10" max="600" value={el.height || 60} onChange={(e) => set({ height: Number(e.target.value) })} />
          </PropRow>
        </>
      )}

      {/* SPACER */}
      {el.type === "spacer" && (
        <PropRow label="Height">
          <input type="number" min="2" max="200" value={el.height || 12} onChange={(e) => set({ height: Number(e.target.value) })} />
        </PropRow>
      )}

      <div className="ptb-prop-section">Spacing</div>
      <PropRow label="Pad top">
        <input type="number" min="0" max="40" value={el.paddingTop ?? 4} onChange={(e) => set({ paddingTop: Number(e.target.value) })} />
      </PropRow>
      <PropRow label="Pad bottom">
        <input type="number" min="0" max="40" value={el.paddingBottom ?? 4} onChange={(e) => set({ paddingBottom: Number(e.target.value) })} />
      </PropRow>

      <button type="button" className="ptb-btn ptb-btn-danger ptb-btn-block" onClick={() => onDelete(selected.zoneId, el.id)}>
        Delete element
      </button>
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────────────
   MAIN COMPONENT
   ────────────────────────────────────────────────────────────────── */

export default function PdfTemplateBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";

  const [name, setName] = useState("New Template");
  const [type, setType] = useState("both");
  const [config, setConfig] = useState(makeBlankConfig);
  const [loading, setLoading] = useState(!isNew);
  const [legacyTemplate, setLegacyTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [previewType, setPreviewType] = useState("estimate");
  const [selected, setSelected] = useState(null); // { zoneId, element }

  // Load existing template
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    api.get(`/pdf-templates/${id}`)
      .then((res) => {
        if (!alive) return;
        const tpl = res.data;
        setName(tpl.name || "Untitled");
        setType(tpl.type || "both");
        const parsed = typeof tpl.config === "string" ? JSON.parse(tpl.config) : (tpl.config || {});
        if (isZoneFormat(parsed)) {
          // Ensure all zones exist
          const zones = { ...emptyZones(), ...(parsed.zones || {}) };
          setConfig({
            ...makeBlankConfig(),
            ...parsed,
            zones,
          });
        } else {
          // Legacy free-form template — show notice screen
          setLegacyTemplate({ id: tpl.id, name: tpl.name });
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load template", err);
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [id, isNew]);

  const scheme = COLOR_SCHEMES[config.colorScheme] || COLOR_SCHEMES.default;
  const fontTheme = FONT_THEMES[config.fontTheme] || FONT_THEMES.modern;

  // ───────────────────── element editing actions ─────────────────────

  const dropElement = useCallback((zoneId, element) => {
    setConfig((c) => ({
      ...c,
      zones: { ...c.zones, [zoneId]: [...(c.zones[zoneId] || []), element] },
    }));
    setSelected({ zoneId, element });
  }, []);

  const moveElement = useCallback((elementId, fromZone, toZone) => {
    if (fromZone === toZone) return;
    setConfig((c) => {
      const fromList = (c.zones[fromZone] || []).slice();
      const idx = fromList.findIndex((e) => e.id === elementId);
      if (idx < 0) return c;
      const [el] = fromList.splice(idx, 1);
      const toList = [...(c.zones[toZone] || []), el];
      return { ...c, zones: { ...c.zones, [fromZone]: fromList, [toZone]: toList } };
    });
    setSelected((sel) => (sel && sel.element.id === elementId ? { ...sel, zoneId: toZone } : sel));
  }, []);

  const updateElement = useCallback((zoneId, elementId, patch) => {
    setConfig((c) => {
      const list = (c.zones[zoneId] || []).map((e) =>
        e.id === elementId ? { ...e, ...patch, columns: patch.columns ? patch.columns : e.columns, columnLabels: patch.columnLabels ? patch.columnLabels : e.columnLabels } : e
      );
      return { ...c, zones: { ...c.zones, [zoneId]: list } };
    });
    setSelected((sel) => (sel && sel.element.id === elementId
      ? { ...sel, element: { ...sel.element, ...patch } }
      : sel));
  }, []);

  const deleteElement = useCallback((zoneId, elementId) => {
    setConfig((c) => ({
      ...c,
      zones: { ...c.zones, [zoneId]: (c.zones[zoneId] || []).filter((e) => e.id !== elementId) },
    }));
    setSelected((sel) => (sel && sel.element.id === elementId ? null : sel));
  }, []);

  const selectElement = useCallback((elementId, zoneId) => {
    if (!elementId) { setSelected(null); return; }
    const el = (config.zones[zoneId] || []).find((e) => e.id === elementId);
    if (el) setSelected({ zoneId, element: el });
  }, [config.zones]);

  // Re-sync selected element snapshot when config changes from elsewhere.
  useEffect(() => {
    if (!selected) return;
    const list = config.zones[selected.zoneId] || [];
    const fresh = list.find((e) => e.id === selected.element.id);
    if (fresh && fresh !== selected.element) {
      setSelected((s) => (s ? { ...s, element: fresh } : s));
    }
  }, [config, selected]);

  // ───────────────────── save / preview ─────────────────────

  const buildPayload = () => ({
    name,
    type,
    config: JSON.stringify(config),
  });

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const res = await api.post("/pdf-templates", buildPayload());
        const newId = res.data?.id;
        if (newId) navigate(`/pdf-templates/${newId}`, { replace: true });
      } else {
        await api.put(`/pdf-templates/${id}`, buildPayload());
      }
    } catch (e) {
      console.error("Save failed", e);
      alert("Save failed: " + (e.response?.data?.error || e.message));
    } finally {
      setSaving(false);
    }
  };

  const previewPdf = async () => {
    try {
      const res = await api.post(
        "/pdf-templates/preview",
        { config, previewType },
        { responseType: "blob" }
      );
      const url = URL.createObjectURL(res.data);
      window.open(url, "_blank");
    } catch (e) {
      console.error("Preview failed", e);
      alert("Preview failed: " + (e.response?.data?.error || e.message));
    }
  };

  // ───────────────────── render ─────────────────────

  if (loading) return <div className="ptb-loading">Loading template…</div>;

  if (legacyTemplate) {
    return (
      <div className="ptb-root">
        <LegacyTemplateNotice
          id={legacyTemplate.id}
          name={legacyTemplate.name}
          onStartFresh={() => navigate("/pdf-templates/new")}
        />
      </div>
    );
  }

  return (
    <div className="ptb-root" style={{ fontFamily: fontTheme.body }}>
      {/* TOP TOOLBAR */}
      <div className="ptb-toolbar">
        <Link to="/pdf-templates" className="ptb-back">← Templates</Link>
        <input
          className="ptb-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Template name"
        />
        <label className="ptb-tb-field">
          For
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="estimate">Estimate</option>
            <option value="invoice">Invoice</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label className="ptb-tb-field">
          Color scheme
          <select value={config.colorScheme} onChange={(e) => setConfig((c) => ({ ...c, colorScheme: e.target.value }))}>
            {Object.entries(COLOR_SCHEMES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </label>
        {config.colorScheme === "custom" && (
          <>
            <label className="ptb-tb-field">
              Primary
              <input type="color" value={config.customColors?.primary || "#000000"} onChange={(e) => setConfig((c) => ({ ...c, customColors: { ...(c.customColors || {}), primary: e.target.value } }))} />
            </label>
            <label className="ptb-tb-field">
              Secondary
              <input type="color" value={config.customColors?.secondary || "#ffffff"} onChange={(e) => setConfig((c) => ({ ...c, customColors: { ...(c.customColors || {}), secondary: e.target.value } }))} />
            </label>
          </>
        )}
        <label className="ptb-tb-field">
          Font
          <select value={config.fontTheme} onChange={(e) => setConfig((c) => ({ ...c, fontTheme: e.target.value }))}>
            {Object.entries(FONT_THEMES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </label>
        <label className="ptb-tb-field">
          Preview as
          <select value={previewType} onChange={(e) => setPreviewType(e.target.value)}>
            <option value="estimate">Estimate</option>
            <option value="invoice">Invoice</option>
          </select>
        </label>
        <div className="ptb-toolbar-spacer" />
        <button type="button" className="ptb-btn" onClick={previewPdf}>Preview PDF</button>
        <button type="button" className="ptb-btn ptb-btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* THREE-PANEL BODY */}
      <div className="ptb-body">
        <LeftPanel />
        <main className="ptb-center">
          <Canvas
            zones={config.zones}
            scheme={scheme}
            selectedId={selected?.element.id}
            onSelect={selectElement}
            onDropElement={dropElement}
            onMoveElement={moveElement}
            onDeleteElement={deleteElement}
          />
        </main>
        <RightPanel
          selected={selected}
          onUpdate={updateElement}
          onDelete={deleteElement}
        />
      </div>
    </div>
  );
}
