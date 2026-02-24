import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";
import "./PdfTemplateBuilder.css";

const CANVAS_W = 612;
const CANVAS_H = 792;
const snap = (v) => Math.round(v / 5) * 5;

const ALL_BLOCKS = [
  "companyInfo", "logo", "title", "dateBox",
  "billTo", "projectBox", "poNumber", "lineItems", "footer",
];

const BLOCK_LABELS = {
  companyInfo: "Company Info", logo: "Logo", title: "Document Title",
  dateBox: "Date Box", billTo: "Bill To", projectBox: "Project / Ship To",
  poNumber: "P.O. Number", lineItems: "Line Items", footer: "Footer / Totals",
};

const SECTION_MAP = {
  companyInfo: "companyInfo", logo: "logo", title: "title",
  billTo: "billTo", projectBox: "projectBox", dateBox: "dateBox",
  poNumber: "poNumber", lineItems: "lineItems", footer: "footer",
};

const DEFAULT_CONFIG = {
  pageSize: "LETTER",
  margins: { top: 40, bottom: 40, left: 50, right: 50 },
  companyInfo: {
    show: true, x: 50, y: 40, width: 220, height: 80, textAlign: "left",
    name: "First Class Glass & Mirror, Inc.", line1: "1513 Industrial Drive",
    line2: "Itasca, IL. 60143", phone: "630-250-9777", fax: "630-250-9727",
    fontSize: 11, linesFontSize: 9,
  },
  logo: { show: true, x: 260, y: 40, width: 72, height: 72 },
  title: { show: true, x: 400, y: 40, width: 162, height: 40, textAlign: "right", fontSize: 22 },
  dateBox: { show: true, x: 400, y: 90, width: 162, height: 55 },
  billTo: { show: true, x: 50, y: 155, width: 245, height: 90, textAlign: "left", label: "BILL TO" },
  projectBox: {
    show: true, x: 305, y: 155, width: 257, height: 90, textAlign: "left",
    estimateLabel: "PROJECT NAME/ADDRESS", invoiceLabel: "SHIP TO",
  },
  poNumber: { show: true, x: 400, y: 255, width: 162, height: 35, label: "P.O. No." },
  lineItems: {
    show: true, x: 50, y: 300, width: 512, height: 130,
    headerBgColor: "#E0E0E0", headerFontSize: 7, bodyFontSize: 8,
    qtyColumnWidth: 50, totalColumnWidth: 75,
    estimateHeaders: { qty: "Qty", description: "DESCRIPTION", total: "TOTAL" },
    invoiceHeaders: { qty: "QUANTITY", description: "DESCRIPTION", total: "AMOUNT" },
  },
  footer: {
    show: true, x: 50, y: 700, width: 512, height: 52,
    showTerms: true, totalFontSize: 10, totalAmountFontSize: 11,
  },
  fonts: { body: "Helvetica", bold: "Helvetica-Bold" },
  colors: { text: "#000000", headerBg: "#E0E0E0", lineStroke: "#000000" },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const HANDLES = [
  { id: "tl", cursor: "nwse-resize", style: { top: -4, left: -4 } },
  { id: "tr", cursor: "nesw-resize", style: { top: -4, right: -4 } },
  { id: "bl", cursor: "nesw-resize", style: { bottom: -4, left: -4 } },
  { id: "br", cursor: "nwse-resize", style: { bottom: -4, right: -4 } },
  { id: "t", cursor: "ns-resize", style: { top: -4, left: "50%", transform: "translateX(-50%)" } },
  { id: "b", cursor: "ns-resize", style: { bottom: -4, left: "50%", transform: "translateX(-50%)" } },
  { id: "l", cursor: "ew-resize", style: { left: -4, top: "50%", transform: "translateY(-50%)" } },
  { id: "r", cursor: "ew-resize", style: { right: -4, top: "50%", transform: "translateY(-50%)" } },
];

/* ═══════════════════════════════════════════════════════════════
   STABLE SUB-COMPONENTS — defined at module scope so React never
   unmounts/remounts them on parent re-render. This prevents
   input focus loss.
   ═══════════════════════════════════════════════════════════════ */

function PtbToggle({ checked, onChange }) {
  return (
    <label className="ptb-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ptb-toggle-slider" />
    </label>
  );
}

function PtbSection({ title, isSelected, isOpen, onToggle, showToggle, showChecked, onShowChange, sRef, children }) {
  return (
    <div className={`ptb-section${isSelected ? " ptb-section-selected" : ""}`} ref={sRef}>
      <div className="ptb-section-header" onClick={onToggle}>
        <span className="ptb-section-title">
          <span className={`ptb-section-chevron ${isOpen ? "open" : ""}`}>&#9654;</span>
          {title}
        </span>
        {showToggle && <PtbToggle checked={showChecked} onChange={onShowChange} />}
      </div>
      {isOpen && <div className="ptb-section-body">{children}</div>}
    </div>
  );
}

function PtbNumInput({ value, onChange, onBlur, label }) {
  return (
    <div className="ptb-field" style={{ flex: 1 }}>
      {label && <label className="ptb-label">{label}</label>}
      <input
        className="ptb-input ptb-input-sm"
        type="text"
        inputMode="numeric"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
      />
    </div>
  );
}

function PtbAlignButtons({ onAlign, textAlign, hasTextAlign, onTextAlignChange }) {
  return (
    <div className="ptb-align-row">
      <div className="ptb-field-row" style={{ gap: 8 }}>
        <label className="ptb-label" style={{ minWidth: 48 }}>Position</label>
        <div className="ptb-align-buttons">
          <button type="button" className="ptb-align-btn" onClick={() => onAlign("left")} title="Align Left">L</button>
          <button type="button" className="ptb-align-btn" onClick={() => onAlign("center")} title="Center">C</button>
          <button type="button" className="ptb-align-btn" onClick={() => onAlign("right")} title="Align Right">R</button>
        </div>
      </div>
      {hasTextAlign && (
        <div className="ptb-field-row" style={{ gap: 8 }}>
          <label className="ptb-label" style={{ minWidth: 48 }}>Text</label>
          <div className="ptb-align-buttons">
            {["left", "center", "right"].map((a) => (
              <button
                key={a}
                type="button"
                className={`ptb-align-btn${textAlign === a ? " active" : ""}`}
                onClick={() => onTextAlignChange(a)}
                title={a.charAt(0).toUpperCase() + a.slice(1)}
              >
                {a === "left" ? "L" : a === "center" ? "C" : "R"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PtbPositionControls({ x, y, w, h, textAlign, hasTextAlign, onNumChange, onNumBlur, onAlign, onTextAlignChange }) {
  return (
    <div className="ptb-pos-controls">
      <div className="ptb-field-row">
        <PtbNumInput value={x ?? 0} onChange={(e) => onNumChange("x", e.target.value)} onBlur={() => onNumBlur("x", 0)} label="X" />
        <PtbNumInput value={y ?? 0} onChange={(e) => onNumChange("y", e.target.value)} onBlur={() => onNumBlur("y", 0)} label="Y" />
        <PtbNumInput value={w ?? 100} onChange={(e) => onNumChange("width", e.target.value)} onBlur={() => onNumBlur("width", 100)} label="W" />
        <PtbNumInput value={h ?? 50} onChange={(e) => onNumChange("height", e.target.value)} onBlur={() => onNumBlur("height", 50)} label="H" />
      </div>
      <PtbAlignButtons onAlign={onAlign} textAlign={textAlign} hasTextAlign={hasTextAlign} onTextAlignChange={onTextAlignChange} />
    </div>
  );
}

function PtbResizeHandles({ blockId, onMouseDown }) {
  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.id}
          className="ptb-resize-handle"
          style={{ ...h.style, cursor: h.cursor }}
          onMouseDown={(e) => onMouseDown(e, blockId, h.id)}
        />
      ))}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function PdfTemplateBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";

  const [name, setName] = useState("New Template");
  const [type, setType] = useState("both");
  const [config, setConfig] = useState(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [openSections, setOpenSections] = useState({
    companyInfo: true, logo: false, title: false, dateBox: false,
    billTo: false, projectBox: false, poNumber: false,
    lineItems: false, footer: false, colors: false,
  });
  const [previewType, setPreviewType] = useState("estimate");
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [logoLoaded, setLogoLoaded] = useState(false);

  const [dragging, setDragging] = useState(null);
  const dragRef = useRef({ offsetX: 0, offsetY: 0 });
  const [resizing, setResizing] = useState(null);
  const resizeRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0, origW: 0, origH: 0 });

  const canvasRef = useRef(null);
  const savedConfigRef = useRef(null);
  const sectionRefs = useRef({});

  const logoUrl = `${API_BASE_URL}/assets/logo`;

  useEffect(() => {
    if (!isNew) {
      api.get(`/pdf-templates/${id}`).then((res) => {
        const tpl = res.data;
        setName(tpl.name);
        setType(tpl.type);
        const parsed = typeof tpl.config === "string" ? JSON.parse(tpl.config) : tpl.config || {};
        const merged = deepMerge(DEFAULT_CONFIG, parsed);
        setConfig(merged);
        savedConfigRef.current = JSON.stringify(merged);
        setLoading(false);
      }).catch((err) => { console.error("Error loading template:", err); setLoading(false); });
    } else {
      savedConfigRef.current = JSON.stringify(DEFAULT_CONFIG);
    }
  }, [id, isNew]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setLogoLoaded(true);
    img.onerror = () => setLogoLoaded(false);
    img.src = logoUrl;
  }, [logoUrl]);

  const updateConfig = useCallback((section, key, value) => {
    setConfig((prev) => {
      const next = { ...prev };
      if (key === null) { next[section] = value; }
      else { next[section] = { ...prev[section], [key]: value }; }
      return next;
    });
    setDirty(true);
  }, []);

  const updateNestedConfig = useCallback((section, subsection, key, value) => {
    setConfig((prev) => ({
      ...prev,
      [section]: { ...prev[section], [subsection]: { ...prev[section]?.[subsection], [key]: value } },
    }));
    setDirty(true);
  }, []);

  const handleNumChange = useCallback((section, key, val) => {
    if (val === "" || val === undefined) {
      setConfig((prev) => ({ ...prev, [section]: { ...prev[section], [key]: "" } }));
      setDirty(true);
      return;
    }
    const n = Number(val);
    if (!isNaN(n)) {
      setConfig((prev) => ({ ...prev, [section]: { ...prev[section], [key]: n } }));
      setDirty(true);
    }
  }, []);

  const handleNumBlur = useCallback((section, key, def) => {
    setConfig((prev) => {
      const v = prev[section]?.[key];
      if (v === "" || v === undefined || v === null) {
        return { ...prev, [section]: { ...prev[section], [key]: def } };
      }
      return prev;
    });
  }, []);

  const handleBlockMouseDown = useCallback((e, blockId) => {
    if (e.button !== 0) return;
    if (e.target.closest(".ptb-resize-handle")) return;
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current?.getBoundingClientRect();
    if (!canvas) return;
    setConfig((prev) => {
      const bx = prev[blockId]?.x || 0;
      const by = prev[blockId]?.y || 0;
      dragRef.current = { offsetX: e.clientX - canvas.left - bx, offsetY: e.clientY - canvas.top - by };
      return prev;
    });
    setDragging(blockId);
    setSelectedBlock(blockId);
  }, []);

  const handleResizeMouseDown = useCallback((e, blockId, handleId) => {
    e.preventDefault();
    e.stopPropagation();
    setConfig((prev) => {
      const b = prev[blockId] || {};
      resizeRef.current = {
        startX: e.clientX, startY: e.clientY,
        origX: b.x || 0, origY: b.y || 0, origW: b.width || 100, origH: b.height || 50,
      };
      return prev;
    });
    setResizing({ blockId, handle: handleId });
    setSelectedBlock(blockId);
  }, []);

  useEffect(() => {
    if (!dragging && !resizing) return;
    const onMove = (e) => {
      if (dragging) {
        const canvas = canvasRef.current?.getBoundingClientRect();
        if (!canvas) return;
        const x = snap(Math.max(0, Math.min(CANVAS_W - 20, e.clientX - canvas.left - dragRef.current.offsetX)));
        const y = snap(Math.max(0, Math.min(CANVAS_H - 20, e.clientY - canvas.top - dragRef.current.offsetY)));
        setConfig((prev) => ({ ...prev, [dragging]: { ...prev[dragging], x, y } }));
        setDirty(true);
      }
      if (resizing) {
        const { blockId, handle } = resizing;
        const { startX, startY, origX, origY, origW, origH } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let x = origX, y = origY, w = origW, h = origH;
        if (handle.includes("r")) w = snap(Math.max(30, origW + dx));
        if (handle.includes("b")) h = snap(Math.max(20, origH + dy));
        if (handle.includes("l")) { w = snap(Math.max(30, origW - dx)); x = snap(origX + origW - w); }
        if (handle.includes("t")) { h = snap(Math.max(20, origH - dy)); y = snap(origY + origH - h); }
        setConfig((prev) => ({ ...prev, [blockId]: { ...prev[blockId], x, y, width: w, height: h } }));
        setDirty(true);
      }
    };
    const onUp = () => { setDragging(null); setResizing(null); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [dragging, resizing]);

  const alignBlock = useCallback((blockId, dir) => {
    setConfig((prev) => {
      const b = prev[blockId] || {};
      const w = b.width || 100;
      let x;
      if (dir === "left") x = 50;
      else if (dir === "center") x = snap((CANVAS_W - w) / 2);
      else x = snap(CANVAS_W - 50 - w);
      return { ...prev, [blockId]: { ...prev[blockId], x } };
    });
    setDirty(true);
  }, []);

  const handleBlockClick = useCallback((blockId) => {
    setSelectedBlock(blockId);
    const sectionId = SECTION_MAP[blockId];
    if (sectionId) {
      setOpenSections((prev) => ({ ...prev, [sectionId]: true }));
      setTimeout(() => {
        sectionRefs.current[sectionId]?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const res = await api.post("/pdf-templates", { name, type, config: JSON.stringify(config) });
        setDirty(false);
        navigate(`/pdf-templates/${res.data.id}`, { replace: true });
      } else {
        await api.put(`/pdf-templates/${id}`, { name, type, config: JSON.stringify(config) });
        setDirty(false);
        savedConfigRef.current = JSON.stringify(config);
      }
    } catch (err) { alert(err.response?.data?.error || "Failed to save template."); }
    finally { setSaving(false); }
  };

  const handlePreviewPdf = async () => {
    try {
      const token = localStorage.getItem("jwt");
      const res = await fetch(`${API_BASE_URL}/pdf-templates/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ config: JSON.stringify(config), previewType }),
      });
      if (!res.ok) throw new Error("Preview failed");
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (err) { alert("Failed to generate preview PDF."); console.error(err); }
  };

  const toggleSection = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  // Helper to build PtbSection props for a given section id
  const sectionProps = (sId, title, tSection) => ({
    title,
    isSelected: selectedBlock && SECTION_MAP[selectedBlock] === sId,
    isOpen: openSections[sId],
    onToggle: () => toggleSection(sId),
    showToggle: !!tSection,
    showChecked: tSection ? config[tSection]?.show !== false : false,
    onShowChange: tSection ? (v) => updateConfig(tSection, "show", v) : undefined,
    sRef: (el) => { sectionRefs.current[sId] = el; },
  });

  // Helper to build PtbPositionControls props for a given block id
  const posProps = (blockId) => ({
    x: config[blockId]?.x ?? 0,
    y: config[blockId]?.y ?? 0,
    w: config[blockId]?.width ?? 100,
    h: config[blockId]?.height ?? 50,
    textAlign: config[blockId]?.textAlign,
    hasTextAlign: config[blockId]?.textAlign !== undefined,
    onNumChange: (field, val) => handleNumChange(blockId, field, val),
    onNumBlur: (field, def) => handleNumBlur(blockId, field, def),
    onAlign: (dir) => alignBlock(blockId, dir),
    onTextAlignChange: (val) => updateConfig(blockId, "textAlign", val),
  });

  const estHeaders = config.lineItems?.estimateHeaders || {};
  const invHeaders = config.lineItems?.invoiceHeaders || {};
  const clr = config.colors || {};

  // ─── Preview Block Renderers ───
  const renderBlockContent = (blockId) => {
    const c = config[blockId] || {};
    const textColor = clr.text || "#000";
    const lineColor = clr.lineStroke || "#000";
    const fill = { width: "100%", height: "100%", boxSizing: "border-box" };

    switch (blockId) {
      case "companyInfo":
        return (
          <div style={{ ...fill, lineHeight: 1.5, textAlign: c.textAlign || "left", opacity: c.show === false ? 0.08 : 1, overflow: "hidden" }}>
            <div style={{ fontWeight: 700, fontSize: c.fontSize || 11, color: textColor }}>{c.name || "Company Name"}</div>
            <div style={{ fontSize: c.linesFontSize || 9, color: textColor }}>{c.line1 || ""}</div>
            <div style={{ fontSize: c.linesFontSize || 9, color: textColor }}>{c.line2 || ""}</div>
            <div style={{ fontSize: c.linesFontSize || 9, color: textColor }}>{c.phone || ""}</div>
            <div style={{ fontSize: c.linesFontSize || 9, color: textColor }}>{c.fax || ""}</div>
          </div>
        );
      case "logo":
        if (c.show === false) return <div style={{ ...fill, opacity: 0.08, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#999" }}>LOGO</div>;
        return logoLoaded ? (
          <img src={logoUrl} alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <div className="ptb-pv-logo-placeholder">LOGO</div>
        );
      case "title":
        return (
          <div style={{ ...fill, fontSize: c.fontSize || 22, fontWeight: 700, textAlign: c.textAlign || "right", color: textColor, opacity: c.show === false ? 0.08 : 1, overflow: "hidden" }}>
            {previewType === "invoice" ? "Invoice" : "Estimate"}
          </div>
        );
      case "dateBox":
        return (
          <div style={{ ...fill, display: "flex", opacity: c.show === false ? 0.08 : 1, overflow: "hidden" }}>
            <div style={{ border: `0.75px solid ${lineColor}`, flex: 1 }}>
              <div style={{ padding: "3px 8px", textAlign: "center", borderBottom: `0.75px solid ${lineColor}`, fontSize: 7, fontWeight: 700, color: textColor }}>DATE</div>
              <div style={{ padding: "3px 8px", textAlign: "center", fontSize: 8, color: textColor }}>{new Date().toLocaleDateString("en-US")}</div>
            </div>
            {previewType === "invoice" && (
              <div style={{ border: `0.75px solid ${lineColor}`, marginLeft: -1, flex: 1 }}>
                <div style={{ padding: "3px 8px", textAlign: "center", borderBottom: `0.75px solid ${lineColor}`, fontSize: 7, fontWeight: 700, color: textColor }}>INVOICE #</div>
                <div style={{ padding: "3px 8px", textAlign: "center", fontSize: 8, color: textColor }}>INV-1001</div>
              </div>
            )}
          </div>
        );
      case "billTo":
        return (
          <div style={{ ...fill, border: `0.75px solid ${lineColor}`, opacity: c.show === false ? 0.08 : 1, overflow: "hidden" }}>
            <div style={{ fontWeight: 700, fontSize: 7, padding: "3px 4px", borderBottom: `0.5px solid ${lineColor}`, color: textColor }}>{c.label || "BILL TO"}</div>
            <div style={{ padding: 4, fontSize: 8, lineHeight: 1.5, color: textColor, textAlign: c.textAlign || "left" }}>
              SAMPLE CUSTOMER INC.<br />123 MAIN STREET<br />CHICAGO, IL 60601<br />555-123-4567
            </div>
          </div>
        );
      case "projectBox": {
        const pc = config.projectBox || {};
        return (
          <div style={{ ...fill, border: `0.75px solid ${lineColor}`, opacity: pc.show === false ? 0.08 : 1, overflow: "hidden" }}>
            <div style={{ fontWeight: 700, fontSize: 7, padding: "3px 4px", borderBottom: `0.5px solid ${lineColor}`, color: textColor }}>
              {previewType === "invoice" ? pc.invoiceLabel || "SHIP TO" : pc.estimateLabel || "PROJECT NAME/ADDRESS"}
            </div>
            <div style={{ padding: 4, fontSize: 8, lineHeight: 1.5, color: textColor, textAlign: pc.textAlign || "left" }}>
              OFFICE RENOVATION<br />456 OAK AVENUE<br />CHICAGO IL 60602
            </div>
          </div>
        );
      }
      case "poNumber":
        return (
          <div style={{ ...fill, opacity: c.show === false ? 0.08 : 1, overflow: "hidden" }}>
            <div style={{ width: "100%", height: "100%", border: `0.75px solid ${lineColor}`, boxSizing: "border-box" }}>
              <div style={{ fontWeight: 700, fontSize: 7, padding: "3px 4px", borderBottom: `0.5px solid ${lineColor}`, color: textColor }}>{c.label || "P.O. No."}</div>
              <div style={{ padding: "3px 4px", fontSize: 8, color: textColor }}>PO-12345</div>
            </div>
          </div>
        );
      case "lineItems": {
        const li = config.lineItems || {};
        const eh = li.estimateHeaders || {};
        const ih = li.invoiceHeaders || {};
        const hbg = li.headerBgColor || "#E0E0E0";
        const hfs = li.headerFontSize || 7;
        const bfs = li.bodyFontSize || 8;
        const thS = { background: hbg, fontSize: hfs, color: textColor, fontWeight: 700, padding: "4px 4px", border: `0.75px solid ${lineColor}`, textAlign: "left" };
        const tdS = { fontSize: bfs, padding: "3px 4px", border: `0.5px solid ${lineColor}`, color: textColor };
        return (
          <div style={{ ...fill, opacity: li.show === false ? 0.08 : 1, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...thS, width: li.qtyColumnWidth || 50, textAlign: "center" }}>{previewType === "invoice" ? ih.qty || "QUANTITY" : eh.qty || "Qty"}</th>
                  <th style={thS}>{previewType === "invoice" ? ih.description || "DESCRIPTION" : eh.description || "DESCRIPTION"}</th>
                  <th style={{ ...thS, width: li.totalColumnWidth || 75, textAlign: "right" }}>{previewType === "invoice" ? ih.total || "AMOUNT" : eh.total || "TOTAL"}</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={{ ...tdS, textAlign: "center" }}>1</td><td style={tdS}>INITIAL SERVICE CALL</td><td style={{ ...tdS, textAlign: "right" }}>150.00</td></tr>
                <tr><td style={{ ...tdS, textAlign: "center" }}>2</td><td style={tdS}>TEMPERED GLASS PANEL 48&quot; X 72&quot;</td><td style={{ ...tdS, textAlign: "right" }}>850.00</td></tr>
                <tr><td style={{ ...tdS, textAlign: "center" }}>4</td><td style={tdS}>LABOR - INSTALLATION</td><td style={{ ...tdS, textAlign: "right" }}>300.00</td></tr>
              </tbody>
            </table>
          </div>
        );
      }
      case "footer": {
        const f = config.footer || {};
        return (
          <div style={{ ...fill, display: "flex", opacity: f.show === false ? 0.08 : 1, overflow: "hidden" }}>
            {f.showTerms !== false && (
              <div style={{ flex: 1, border: `0.75px solid ${lineColor}`, padding: 5, fontSize: 7, lineHeight: 1.5, color: textColor }}>
                NET 30. ALL PRICES VALID FOR 30 DAYS.
              </div>
            )}
            <div style={{ border: `0.75px solid ${lineColor}`, padding: 5, fontWeight: 700, fontSize: f.totalFontSize || 10, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 50, color: textColor }}>TOTAL</div>
            <div style={{ border: `0.75px solid ${lineColor}`, padding: 5, fontWeight: 700, fontSize: f.totalAmountFontSize || 11, display: "flex", alignItems: "center", justifyContent: "flex-end", minWidth: 80, color: textColor }}>$2,150.00</div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  if (loading) return <div className="ptb-page"><div style={{ padding: 40, color: "var(--text-tertiary)" }}>Loading...</div></div>;

  return (
    <div className="ptb-page">
      <div className="ptb-topbar">
        <div className="ptb-topbar-left">
          <button className="ptb-back-btn" onClick={() => navigate("/pdf-templates")}>&larr; Templates</button>
          <input className="ptb-name-input" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="Template name" />
          <select className="ptb-type-select" value={type} onChange={(e) => { setType(e.target.value); setDirty(true); }}>
            <option value="both">Both</option>
            <option value="estimate">Estimate Only</option>
            <option value="invoice">Invoice Only</option>
          </select>
        </div>
        <div className="ptb-topbar-right">
          <select className="ptb-type-select" value={previewType} onChange={(e) => setPreviewType(e.target.value)}>
            <option value="estimate">Preview as Estimate</option>
            <option value="invoice">Preview as Invoice</option>
          </select>
          <button className="ptb-preview-pdf-btn" onClick={handlePreviewPdf}>Preview Actual PDF</button>
          <button className="ptb-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
            {dirty && !saving && <span className="ptb-unsaved-dot" />}
          </button>
        </div>
      </div>

      <div className="ptb-body">
        {/* Settings Panel */}
        <div className="ptb-settings">
          {selectedBlock && (
            <div className="ptb-quick-toolbar">
              <span className="ptb-quick-label">{BLOCK_LABELS[selectedBlock]}</span>
              <div className="ptb-align-buttons">
                <button type="button" className="ptb-align-btn" onClick={() => alignBlock(selectedBlock, "left")} title="Align Left">L</button>
                <button type="button" className="ptb-align-btn" onClick={() => alignBlock(selectedBlock, "center")} title="Center H">C</button>
                <button type="button" className="ptb-align-btn" onClick={() => alignBlock(selectedBlock, "right")} title="Align Right">R</button>
              </div>
            </div>
          )}

          <PtbSection {...sectionProps("companyInfo", "Company Info", "companyInfo")}>
            <PtbPositionControls {...posProps("companyInfo")} />
            <div className="ptb-field">
              <label className="ptb-label">Company Name</label>
              <input className="ptb-input" value={config.companyInfo?.name || ""} onChange={(e) => updateConfig("companyInfo", "name", e.target.value)} />
            </div>
            <div className="ptb-field">
              <label className="ptb-label">Address Line 1</label>
              <input className="ptb-input" value={config.companyInfo?.line1 || ""} onChange={(e) => updateConfig("companyInfo", "line1", e.target.value)} />
            </div>
            <div className="ptb-field">
              <label className="ptb-label">Address Line 2</label>
              <input className="ptb-input" value={config.companyInfo?.line2 || ""} onChange={(e) => updateConfig("companyInfo", "line2", e.target.value)} />
            </div>
            <div className="ptb-field-row">
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Phone</label>
                <input className="ptb-input" value={config.companyInfo?.phone || ""} onChange={(e) => updateConfig("companyInfo", "phone", e.target.value)} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Fax</label>
                <input className="ptb-input" value={config.companyInfo?.fax || ""} onChange={(e) => updateConfig("companyInfo", "fax", e.target.value)} />
              </div>
            </div>
            <div className="ptb-field-row">
              <PtbNumInput value={config.companyInfo?.fontSize ?? 11} onChange={(e) => handleNumChange("companyInfo", "fontSize", e.target.value)} onBlur={() => handleNumBlur("companyInfo", "fontSize", 11)} label="Name Font Size" />
              <PtbNumInput value={config.companyInfo?.linesFontSize ?? 9} onChange={(e) => handleNumChange("companyInfo", "linesFontSize", e.target.value)} onBlur={() => handleNumBlur("companyInfo", "linesFontSize", 9)} label="Lines Font Size" />
            </div>
          </PtbSection>

          <PtbSection {...sectionProps("logo", "Logo", "logo")}>
            <PtbPositionControls {...posProps("logo")} />
          </PtbSection>

          <PtbSection {...sectionProps("title", "Document Title", "title")}>
            <PtbPositionControls {...posProps("title")} />
            <PtbNumInput value={config.title?.fontSize ?? 22} onChange={(e) => handleNumChange("title", "fontSize", e.target.value)} onBlur={() => handleNumBlur("title", "fontSize", 22)} label="Font Size" />
          </PtbSection>

          <PtbSection {...sectionProps("dateBox", "Date Box", "dateBox")}>
            <PtbPositionControls {...posProps("dateBox")} />
          </PtbSection>

          <PtbSection {...sectionProps("billTo", "Bill To", "billTo")}>
            <PtbPositionControls {...posProps("billTo")} />
            <div className="ptb-field">
              <label className="ptb-label">Header Label</label>
              <input className="ptb-input" value={config.billTo?.label || "BILL TO"} onChange={(e) => updateConfig("billTo", "label", e.target.value)} />
            </div>
          </PtbSection>

          <PtbSection {...sectionProps("projectBox", "Project / Ship To", "projectBox")}>
            <PtbPositionControls {...posProps("projectBox")} />
            <div className="ptb-field">
              <label className="ptb-label">Estimate Label</label>
              <input className="ptb-input" value={config.projectBox?.estimateLabel || "PROJECT NAME/ADDRESS"} onChange={(e) => updateConfig("projectBox", "estimateLabel", e.target.value)} />
            </div>
            <div className="ptb-field">
              <label className="ptb-label">Invoice Label</label>
              <input className="ptb-input" value={config.projectBox?.invoiceLabel || "SHIP TO"} onChange={(e) => updateConfig("projectBox", "invoiceLabel", e.target.value)} />
            </div>
          </PtbSection>

          <PtbSection {...sectionProps("poNumber", "PO Number", "poNumber")}>
            <PtbPositionControls {...posProps("poNumber")} />
            <div className="ptb-field">
              <label className="ptb-label">Label</label>
              <input className="ptb-input" value={config.poNumber?.label || "P.O. No."} onChange={(e) => updateConfig("poNumber", "label", e.target.value)} />
            </div>
          </PtbSection>

          <PtbSection {...sectionProps("lineItems", "Line Items Table", "lineItems")}>
            <PtbPositionControls {...posProps("lineItems")} />
            <div className="ptb-field-row">
              <PtbNumInput value={config.lineItems?.headerFontSize ?? 7} onChange={(e) => handleNumChange("lineItems", "headerFontSize", e.target.value)} onBlur={() => handleNumBlur("lineItems", "headerFontSize", 7)} label="Header Font" />
              <PtbNumInput value={config.lineItems?.bodyFontSize ?? 8} onChange={(e) => handleNumChange("lineItems", "bodyFontSize", e.target.value)} onBlur={() => handleNumBlur("lineItems", "bodyFontSize", 8)} label="Body Font" />
            </div>
            <div className="ptb-field-row">
              <PtbNumInput value={config.lineItems?.qtyColumnWidth ?? 50} onChange={(e) => handleNumChange("lineItems", "qtyColumnWidth", e.target.value)} onBlur={() => handleNumBlur("lineItems", "qtyColumnWidth", 50)} label="Qty Col (pt)" />
              <PtbNumInput value={config.lineItems?.totalColumnWidth ?? 75} onChange={(e) => handleNumChange("lineItems", "totalColumnWidth", e.target.value)} onBlur={() => handleNumBlur("lineItems", "totalColumnWidth", 75)} label="Total Col (pt)" />
            </div>
            <div className="ptb-field">
              <label className="ptb-label">Header Background</label>
              <input className="ptb-input-color" type="color" value={config.lineItems?.headerBgColor || "#E0E0E0"} onChange={(e) => updateConfig("lineItems", "headerBgColor", e.target.value)} />
            </div>
            <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "4px 0" }} />
            <label className="ptb-label" style={{ marginBottom: 4 }}>Estimate Column Headers</label>
            <div className="ptb-field-row">
              <input className="ptb-input" placeholder="Qty" value={estHeaders.qty || ""} onChange={(e) => updateNestedConfig("lineItems", "estimateHeaders", "qty", e.target.value)} style={{ flex: 1 }} />
              <input className="ptb-input" placeholder="Description" value={estHeaders.description || ""} onChange={(e) => updateNestedConfig("lineItems", "estimateHeaders", "description", e.target.value)} style={{ flex: 2 }} />
              <input className="ptb-input" placeholder="Total" value={estHeaders.total || ""} onChange={(e) => updateNestedConfig("lineItems", "estimateHeaders", "total", e.target.value)} style={{ flex: 1 }} />
            </div>
            <label className="ptb-label" style={{ marginBottom: 4 }}>Invoice Column Headers</label>
            <div className="ptb-field-row">
              <input className="ptb-input" placeholder="Qty" value={invHeaders.qty || ""} onChange={(e) => updateNestedConfig("lineItems", "invoiceHeaders", "qty", e.target.value)} style={{ flex: 1 }} />
              <input className="ptb-input" placeholder="Description" value={invHeaders.description || ""} onChange={(e) => updateNestedConfig("lineItems", "invoiceHeaders", "description", e.target.value)} style={{ flex: 2 }} />
              <input className="ptb-input" placeholder="Total" value={invHeaders.total || ""} onChange={(e) => updateNestedConfig("lineItems", "invoiceHeaders", "total", e.target.value)} style={{ flex: 1 }} />
            </div>
          </PtbSection>

          <PtbSection {...sectionProps("footer", "Footer / Totals", "footer")}>
            <PtbPositionControls {...posProps("footer")} />
            <div className="ptb-field-row">
              <label className="ptb-label">Show Terms Box</label>
              <PtbToggle checked={config.footer?.showTerms !== false} onChange={(v) => updateConfig("footer", "showTerms", v)} />
            </div>
            <div className="ptb-field-row">
              <PtbNumInput value={config.footer?.totalFontSize ?? 10} onChange={(e) => handleNumChange("footer", "totalFontSize", e.target.value)} onBlur={() => handleNumBlur("footer", "totalFontSize", 10)} label="Total Font" />
              <PtbNumInput value={config.footer?.totalAmountFontSize ?? 11} onChange={(e) => handleNumChange("footer", "totalAmountFontSize", e.target.value)} onBlur={() => handleNumBlur("footer", "totalAmountFontSize", 11)} label="Amount Font" />
            </div>
          </PtbSection>

          <PtbSection {...sectionProps("colors", "Colors", null)}>
            <div className="ptb-field-row">
              <label className="ptb-label">Text Color</label>
              <input className="ptb-input-color" type="color" value={clr.text || "#000000"} onChange={(e) => updateConfig("colors", "text", e.target.value)} />
            </div>
            <div className="ptb-field-row">
              <label className="ptb-label">Header Background</label>
              <input className="ptb-input-color" type="color" value={clr.headerBg || "#E0E0E0"} onChange={(e) => updateConfig("colors", "headerBg", e.target.value)} />
            </div>
            <div className="ptb-field-row">
              <label className="ptb-label">Line Stroke</label>
              <input className="ptb-input-color" type="color" value={clr.lineStroke || "#000000"} onChange={(e) => updateConfig("colors", "lineStroke", e.target.value)} />
            </div>
          </PtbSection>
        </div>

        {/* Live Preview Canvas */}
        <div className="ptb-preview" onClick={() => setSelectedBlock(null)}>
          <div
            className="ptb-preview-page"
            ref={canvasRef}
            style={{ padding: 0, overflow: "hidden" }}
            onClick={(e) => { if (e.target === e.currentTarget) setSelectedBlock(null); }}
          >
            {ALL_BLOCKS.map((blockId) => {
              const b = config[blockId] || {};
              return (
                <div
                  key={blockId}
                  className={`ptb-canvas-block${selectedBlock === blockId ? " ptb-canvas-block-selected" : ""}${dragging === blockId ? " ptb-canvas-block-dragging" : ""}`}
                  style={{
                    position: "absolute",
                    left: b.x || 0,
                    top: b.y || 0,
                    width: b.width || 100,
                    height: b.height || 50,
                    cursor: dragging === blockId ? "grabbing" : "grab",
                    zIndex: selectedBlock === blockId ? 10 : 1,
                    overflow: "hidden",
                  }}
                  onMouseDown={(e) => handleBlockMouseDown(e, blockId)}
                  onClick={(e) => { e.stopPropagation(); handleBlockClick(blockId); }}
                  title={BLOCK_LABELS[blockId]}
                >
                  {renderBlockContent(blockId)}
                  {selectedBlock === blockId && <PtbResizeHandles blockId={blockId} onMouseDown={handleResizeMouseDown} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
