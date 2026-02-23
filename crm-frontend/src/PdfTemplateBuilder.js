import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";
import "./PdfTemplateBuilder.css";

const DEFAULT_CONFIG = {
  pageSize: "LETTER",
  margins: { top: 40, bottom: 40, left: 50, right: 50 },
  companyInfo: {
    show: true,
    name: "First Class Glass & Mirror, Inc.",
    line1: "1513 Industrial Drive",
    line2: "Itasca, IL. 60143",
    phone: "630-250-9777",
    fax: "630-250-9727",
    fontSize: 11,
    linesFontSize: 9,
  },
  logo: { show: true, x: 250, y: 40, width: 60, height: 60 },
  title: { show: true, fontSize: 22, align: "right" },
  dateBox: { show: true, width: 130, position: "right" },
  billTo: { show: true, label: "BILL TO", widthPercent: 48 },
  projectBox: {
    show: true,
    estimateLabel: "PROJECT NAME/ADDRESS",
    invoiceLabel: "SHIP TO",
  },
  poNumber: { show: true, label: "P.O. No." },
  lineItems: {
    show: true,
    headerBgColor: "#E0E0E0",
    headerFontSize: 7,
    bodyFontSize: 8,
    qtyColumnWidth: 50,
    totalColumnWidth: 75,
    estimateHeaders: { qty: "Qty", description: "DESCRIPTION", total: "TOTAL" },
    invoiceHeaders: {
      qty: "QUANTITY",
      description: "DESCRIPTION",
      total: "AMOUNT",
    },
  },
  footer: {
    show: true,
    showTerms: true,
    height: 46,
    totalLabelWidth: 60,
    totalAmountWidth: 100,
    totalFontSize: 10,
    totalAmountFontSize: 11,
  },
  fonts: { body: "Helvetica", bold: "Helvetica-Bold" },
  colors: { text: "#000000", headerBg: "#E0E0E0", lineStroke: "#000000" },
  layout: {
    headerLeft: "companyInfo",
    headerCenter: "logo",
    headerRight: "title",
    infoLeft: "billTo",
    infoRight: "projectBox",
  },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const HEADER_BLOCKS = ["companyInfo", "logo", "title"];
const INFO_BLOCKS = ["billTo", "projectBox"];

const SECTION_MAP = {
  companyInfo: "companyInfo",
  logo: "logo",
  title: "title",
  billTo: "billTo",
  projectBox: "projectBox",
  dateBox: "dateBox",
  poNumber: "poNumber",
  lineItems: "lineItems",
  footer: "footer",
};

const BLOCK_LABELS = {
  companyInfo: "Company Info",
  logo: "Logo",
  title: "Document Title",
  billTo: "Bill To",
  projectBox: "Project / Ship To",
};

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
    companyInfo: true,
    logo: false,
    title: false,
    dateBox: false,
    billTo: false,
    projectBox: false,
    poNumber: false,
    lineItems: false,
    footer: false,
    colors: false,
  });
  const [previewType, setPreviewType] = useState("estimate");
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [draggingBlock, setDraggingBlock] = useState(null);
  const [dragOverZone, setDragOverZone] = useState(null);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const savedConfigRef = useRef(null);
  const sectionRefs = useRef({});

  const logoUrl = `${API_BASE_URL}/assets/logo`;

  useEffect(() => {
    if (!isNew) {
      api
        .get(`/pdf-templates/${id}`)
        .then((res) => {
          const tpl = res.data;
          setName(tpl.name);
          setType(tpl.type);
          const parsed =
            typeof tpl.config === "string"
              ? JSON.parse(tpl.config)
              : tpl.config || {};
          const merged = deepMerge(DEFAULT_CONFIG, parsed);
          setConfig(merged);
          savedConfigRef.current = JSON.stringify(merged);
          setLoading(false);
        })
        .catch((err) => {
          console.error("Error loading template:", err);
          setLoading(false);
        });
    } else {
      savedConfigRef.current = JSON.stringify(DEFAULT_CONFIG);
    }
  }, [id, isNew]);

  const updateConfig = useCallback((section, key, value) => {
    setConfig((prev) => {
      const next = { ...prev };
      if (key === null) {
        next[section] = value;
      } else {
        next[section] = { ...prev[section], [key]: value };
      }
      return next;
    });
    setDirty(true);
  }, []);

  const updateNestedConfig = useCallback((section, subsection, key, value) => {
    setConfig((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [subsection]: { ...prev[section]?.[subsection], [key]: value },
      },
    }));
    setDirty(true);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const res = await api.post("/pdf-templates", {
          name,
          type,
          config: JSON.stringify(config),
        });
        setDirty(false);
        navigate(`/pdf-templates/${res.data.id}`, { replace: true });
      } else {
        await api.put(`/pdf-templates/${id}`, {
          name,
          type,
          config: JSON.stringify(config),
        });
        setDirty(false);
        savedConfigRef.current = JSON.stringify(config);
      }
    } catch (err) {
      alert(err.response?.data?.error || "Failed to save template.");
    } finally {
      setSaving(false);
    }
  };

  const handlePreviewPdf = async () => {
    try {
      const token = localStorage.getItem("jwt");
      const res = await fetch(`${API_BASE_URL}/pdf-templates/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ config: JSON.stringify(config), previewType }),
      });
      if (!res.ok) throw new Error("Preview failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } catch (err) {
      alert("Failed to generate preview PDF.");
      console.error(err);
    }
  };

  const toggleSection = (key) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Click block in preview → select it and scroll to its properties
  const handleBlockClick = (blockId) => {
    setSelectedBlock(blockId);
    const sectionId = SECTION_MAP[blockId];
    if (sectionId) {
      setOpenSections((prev) => ({ ...prev, [sectionId]: true }));
      setTimeout(() => {
        sectionRefs.current[sectionId]?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  };

  // ─── Drag and Drop ───
  const handleDragStart = (e, blockId, zoneType) => {
    e.dataTransfer.setData("blockId", blockId);
    e.dataTransfer.setData("zoneType", zoneType);
    setDraggingBlock(blockId);
  };

  const handleDragEnd = () => {
    setDraggingBlock(null);
    setDragOverZone(null);
  };

  const handleDragOver = (e, zone) => {
    e.preventDefault();
    setDragOverZone(zone);
  };

  const handleDragLeave = () => {
    setDragOverZone(null);
  };

  const handleDrop = (e, targetZone) => {
    e.preventDefault();
    const blockId = e.dataTransfer.getData("blockId");
    const srcZoneType = e.dataTransfer.getData("zoneType");
    setDragOverZone(null);
    setDraggingBlock(null);

    if (!blockId) return;

    // Determine if this is a header swap or info swap
    if (srcZoneType === "header" && targetZone.startsWith("header")) {
      // Find what's currently in the target zone and swap
      setConfig((prev) => {
        const layout = { ...prev.layout };
        const slots = ["headerLeft", "headerCenter", "headerRight"];
        const srcSlot = slots.find((s) => layout[s] === blockId);
        const targetSlot = targetZone === "header-left" ? "headerLeft" : targetZone === "header-center" ? "headerCenter" : "headerRight";
        if (srcSlot && srcSlot !== targetSlot) {
          const temp = layout[targetSlot];
          layout[targetSlot] = layout[srcSlot];
          layout[srcSlot] = temp;
        }
        return { ...prev, layout };
      });
      setDirty(true);
    } else if (srcZoneType === "info" && targetZone.startsWith("info")) {
      setConfig((prev) => {
        const layout = { ...prev.layout };
        const slots = ["infoLeft", "infoRight"];
        const srcSlot = slots.find((s) => layout[s] === blockId);
        const targetSlot = targetZone === "info-left" ? "infoLeft" : "infoRight";
        if (srcSlot && srcSlot !== targetSlot) {
          const temp = layout[targetSlot];
          layout[targetSlot] = layout[srcSlot];
          layout[srcSlot] = temp;
        }
        return { ...prev, layout };
      });
      setDirty(true);
    }
  };

  // ─── Components ───
  const Toggle = ({ checked, onChange }) => (
    <label className="ptb-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ptb-toggle-slider" />
    </label>
  );

  const Section = ({ id: sId, title, children, showToggle, toggleSection: tSection }) => (
    <div
      className={`ptb-section${selectedBlock && SECTION_MAP[selectedBlock] === sId ? " ptb-section-selected" : ""}`}
      ref={(el) => { sectionRefs.current[sId] = el; }}
    >
      <div className="ptb-section-header" onClick={() => toggleSection(sId)}>
        <span className="ptb-section-title">
          <span className={`ptb-section-chevron ${openSections[sId] ? "open" : ""}`}>&#9654;</span>
          {title}
        </span>
        {showToggle && (
          <Toggle
            checked={config[tSection]?.show !== false}
            onChange={(v) => { updateConfig(tSection, "show", v); }}
          />
        )}
      </div>
      {openSections[sId] && <div className="ptb-section-body">{children}</div>}
    </div>
  );

  const estHeaders = config.lineItems?.estimateHeaders || {};
  const invHeaders = config.lineItems?.invoiceHeaders || {};
  const layout = config.layout || DEFAULT_CONFIG.layout;

  // ─── Preview Block Renderers ───
  const renderHeaderBlock = (blockId) => {
    if (blockId === "companyInfo") {
      return (
        <div className={config.companyInfo?.show === false ? "ptb-pv-hidden" : ""} style={{ lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700, fontSize: config.companyInfo?.fontSize || 11, color: config.colors?.text || "#000" }}>
            {config.companyInfo?.name || "Company Name"}
          </div>
          <div style={{ fontSize: config.companyInfo?.linesFontSize || 9, color: config.colors?.text || "#000" }}>
            {config.companyInfo?.line1 || ""}
          </div>
          <div style={{ fontSize: config.companyInfo?.linesFontSize || 9, color: config.colors?.text || "#000" }}>
            {config.companyInfo?.line2 || ""}
          </div>
          <div style={{ fontSize: config.companyInfo?.linesFontSize || 9, color: config.colors?.text || "#000" }}>
            {config.companyInfo?.phone || ""}
          </div>
          <div style={{ fontSize: config.companyInfo?.linesFontSize || 9, color: config.colors?.text || "#000" }}>
            {config.companyInfo?.fax || ""}
          </div>
        </div>
      );
    }
    if (blockId === "logo") {
      if (config.logo?.show === false) return <div className="ptb-pv-hidden" style={{ width: 40, height: 40 }} />;
      return (
        <div style={{ width: config.logo?.width || 60, height: config.logo?.height || 60 }}>
          {logoLoaded ? (
            <img
              src={logoUrl}
              alt="Logo"
              style={{ width: config.logo?.width || 60, height: config.logo?.height || 60, objectFit: "contain" }}
            />
          ) : (
            <div
              className="ptb-pv-logo-placeholder"
              style={{ width: config.logo?.width || 60, height: config.logo?.height || 60 }}
            >
              LOGO
            </div>
          )}
        </div>
      );
    }
    if (blockId === "title") {
      return (
        <div
          className={config.title?.show === false ? "ptb-pv-hidden" : ""}
          style={{
            fontSize: config.title?.fontSize || 22,
            fontWeight: 700,
            textAlign: config.title?.align || "right",
            color: config.colors?.text || "#000",
            minWidth: 80,
          }}
        >
          {previewType === "invoice" ? "Invoice" : "Estimate"}
        </div>
      );
    }
    return null;
  };

  const renderInfoBlock = (blockId) => {
    if (blockId === "billTo") {
      if (config.billTo?.show === false) return null;
      return (
        <div className="ptb-pv-box" style={{ flex: config.billTo?.widthPercent || 48, borderColor: config.colors?.lineStroke || "#000" }}>
          <div className="ptb-pv-box-header" style={{ borderColor: config.colors?.lineStroke || "#000", color: config.colors?.text || "#000" }}>
            {config.billTo?.label || "BILL TO"}
          </div>
          <div className="ptb-pv-box-body" style={{ color: config.colors?.text || "#000" }}>
            SAMPLE CUSTOMER INC.<br />123 MAIN STREET<br />CHICAGO, IL 60601<br />555-123-4567
          </div>
        </div>
      );
    }
    if (blockId === "projectBox") {
      if (config.projectBox?.show === false) return null;
      return (
        <div className="ptb-pv-box" style={{ flex: 100 - (config.billTo?.widthPercent || 48), borderColor: config.colors?.lineStroke || "#000" }}>
          <div className="ptb-pv-box-header" style={{ borderColor: config.colors?.lineStroke || "#000", color: config.colors?.text || "#000" }}>
            {previewType === "invoice"
              ? config.projectBox?.invoiceLabel || "SHIP TO"
              : config.projectBox?.estimateLabel || "PROJECT NAME/ADDRESS"}
          </div>
          <div className="ptb-pv-box-body" style={{ color: config.colors?.text || "#000" }}>
            OFFICE RENOVATION<br />456 OAK AVENUE<br />CHICAGO IL 60602
          </div>
        </div>
      );
    }
    return null;
  };

  // Preload logo
  useEffect(() => {
    const img = new Image();
    img.onload = () => setLogoLoaded(true);
    img.onerror = () => setLogoLoaded(false);
    img.src = logoUrl;
  }, [logoUrl]);

  if (loading) return <div className="ptb-page"><div style={{ padding: 40, color: "var(--text-tertiary)" }}>Loading...</div></div>;

  return (
    <div className="ptb-page">
      {/* Top Bar */}
      <div className="ptb-topbar">
        <div className="ptb-topbar-left">
          <button className="ptb-back-btn" onClick={() => navigate("/pdf-templates")}>
            &larr; Templates
          </button>
          <input
            className="ptb-name-input"
            value={name}
            onChange={(e) => { setName(e.target.value); setDirty(true); }}
            placeholder="Template name"
          />
          <select
            className="ptb-type-select"
            value={type}
            onChange={(e) => { setType(e.target.value); setDirty(true); }}
          >
            <option value="both">Both</option>
            <option value="estimate">Estimate Only</option>
            <option value="invoice">Invoice Only</option>
          </select>
        </div>
        <div className="ptb-topbar-right">
          <select
            className="ptb-type-select"
            value={previewType}
            onChange={(e) => setPreviewType(e.target.value)}
          >
            <option value="estimate">Preview as Estimate</option>
            <option value="invoice">Preview as Invoice</option>
          </select>
          <button className="ptb-preview-pdf-btn" onClick={handlePreviewPdf}>
            Preview Actual PDF
          </button>
          <button className="ptb-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
            {dirty && !saving && <span className="ptb-unsaved-dot" />}
          </button>
        </div>
      </div>

      {/* Main Body */}
      <div className="ptb-body">
        {/* Settings Panel */}
        <div className="ptb-settings">
          {/* Company Info */}
          <Section id="companyInfo" title="Company Info" showToggle toggleSection="companyInfo">
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
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Name Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="6" max="20" value={config.companyInfo?.fontSize || 11} onChange={(e) => updateConfig("companyInfo", "fontSize", Number(e.target.value))} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Lines Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="6" max="16" value={config.companyInfo?.linesFontSize || 9} onChange={(e) => updateConfig("companyInfo", "linesFontSize", Number(e.target.value))} />
              </div>
            </div>
          </Section>

          {/* Logo */}
          <Section id="logo" title="Logo" showToggle toggleSection="logo">
            <div className="ptb-field-row">
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Width</label>
                <input className="ptb-input ptb-input-sm" type="number" min="20" max="200" value={config.logo?.width || 60} onChange={(e) => updateConfig("logo", "width", Number(e.target.value))} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Height</label>
                <input className="ptb-input ptb-input-sm" type="number" min="20" max="200" value={config.logo?.height || 60} onChange={(e) => updateConfig("logo", "height", Number(e.target.value))} />
              </div>
            </div>
          </Section>

          {/* Title */}
          <Section id="title" title="Document Title" showToggle toggleSection="title">
            <div className="ptb-field-row">
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="10" max="40" value={config.title?.fontSize || 22} onChange={(e) => updateConfig("title", "fontSize", Number(e.target.value))} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Alignment</label>
                <select className="ptb-input" value={config.title?.align || "right"} onChange={(e) => updateConfig("title", "align", e.target.value)}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
            </div>
          </Section>

          {/* Date Box */}
          <Section id="dateBox" title="Date Box" showToggle toggleSection="dateBox">
            <div className="ptb-field">
              <label className="ptb-label">Box Width (pt)</label>
              <input className="ptb-input ptb-input-sm" type="number" min="80" max="200" value={config.dateBox?.width || 130} onChange={(e) => updateConfig("dateBox", "width", Number(e.target.value))} />
            </div>
          </Section>

          {/* Bill To */}
          <Section id="billTo" title="Bill To" showToggle toggleSection="billTo">
            <div className="ptb-field">
              <label className="ptb-label">Header Label</label>
              <input className="ptb-input" value={config.billTo?.label || "BILL TO"} onChange={(e) => updateConfig("billTo", "label", e.target.value)} />
            </div>
            <div className="ptb-field">
              <label className="ptb-label">Width %</label>
              <input className="ptb-input ptb-input-sm" type="number" min="20" max="80" value={config.billTo?.widthPercent || 48} onChange={(e) => updateConfig("billTo", "widthPercent", Number(e.target.value))} />
            </div>
          </Section>

          {/* Project / Ship To */}
          <Section id="projectBox" title="Project / Ship To" showToggle toggleSection="projectBox">
            <div className="ptb-field">
              <label className="ptb-label">Estimate Label</label>
              <input className="ptb-input" value={config.projectBox?.estimateLabel || "PROJECT NAME/ADDRESS"} onChange={(e) => updateConfig("projectBox", "estimateLabel", e.target.value)} />
            </div>
            <div className="ptb-field">
              <label className="ptb-label">Invoice Label</label>
              <input className="ptb-input" value={config.projectBox?.invoiceLabel || "SHIP TO"} onChange={(e) => updateConfig("projectBox", "invoiceLabel", e.target.value)} />
            </div>
          </Section>

          {/* PO Number */}
          <Section id="poNumber" title="PO Number" showToggle toggleSection="poNumber">
            <div className="ptb-field">
              <label className="ptb-label">Label</label>
              <input className="ptb-input" value={config.poNumber?.label || "P.O. No."} onChange={(e) => updateConfig("poNumber", "label", e.target.value)} />
            </div>
          </Section>

          {/* Line Items */}
          <Section id="lineItems" title="Line Items Table" showToggle toggleSection="lineItems">
            <div className="ptb-field-row">
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Header Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="5" max="14" value={config.lineItems?.headerFontSize || 7} onChange={(e) => updateConfig("lineItems", "headerFontSize", Number(e.target.value))} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Body Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="5" max="14" value={config.lineItems?.bodyFontSize || 8} onChange={(e) => updateConfig("lineItems", "bodyFontSize", Number(e.target.value))} />
              </div>
            </div>
            <div className="ptb-field-row">
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Qty Column (pt)</label>
                <input className="ptb-input ptb-input-sm" type="number" min="30" max="100" value={config.lineItems?.qtyColumnWidth || 50} onChange={(e) => updateConfig("lineItems", "qtyColumnWidth", Number(e.target.value))} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Total Column (pt)</label>
                <input className="ptb-input ptb-input-sm" type="number" min="50" max="150" value={config.lineItems?.totalColumnWidth || 75} onChange={(e) => updateConfig("lineItems", "totalColumnWidth", Number(e.target.value))} />
              </div>
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
          </Section>

          {/* Footer */}
          <Section id="footer" title="Footer" showToggle toggleSection="footer">
            <div className="ptb-field-row">
              <label className="ptb-label">Show Terms Box</label>
              <Toggle
                checked={config.footer?.showTerms !== false}
                onChange={(v) => updateConfig("footer", "showTerms", v)}
              />
            </div>
            <div className="ptb-field-row">
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Total Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="6" max="18" value={config.footer?.totalFontSize || 10} onChange={(e) => updateConfig("footer", "totalFontSize", Number(e.target.value))} />
              </div>
              <div className="ptb-field" style={{ flex: 1 }}>
                <label className="ptb-label">Amount Font Size</label>
                <input className="ptb-input ptb-input-sm" type="number" min="6" max="18" value={config.footer?.totalAmountFontSize || 11} onChange={(e) => updateConfig("footer", "totalAmountFontSize", Number(e.target.value))} />
              </div>
            </div>
          </Section>

          {/* Colors */}
          <Section id="colors" title="Colors">
            <div className="ptb-field-row">
              <label className="ptb-label">Text Color</label>
              <input className="ptb-input-color" type="color" value={config.colors?.text || "#000000"} onChange={(e) => updateConfig("colors", "text", e.target.value)} />
            </div>
            <div className="ptb-field-row">
              <label className="ptb-label">Header Background</label>
              <input className="ptb-input-color" type="color" value={config.colors?.headerBg || "#E0E0E0"} onChange={(e) => updateConfig("colors", "headerBg", e.target.value)} />
            </div>
            <div className="ptb-field-row">
              <label className="ptb-label">Line Stroke</label>
              <input className="ptb-input-color" type="color" value={config.colors?.lineStroke || "#000000"} onChange={(e) => updateConfig("colors", "lineStroke", e.target.value)} />
            </div>
          </Section>
        </div>

        {/* Live Preview */}
        <div className="ptb-preview" onClick={() => setSelectedBlock(null)}>
          <div className="ptb-preview-page" style={{ color: config.colors?.text || "#000" }}>

            {/* Header Row — 3 drop zones */}
            <div className="ptb-pv-header">
              {["header-left", "header-center", "header-right"].map((zone) => {
                const slotKey = zone === "header-left" ? "headerLeft" : zone === "header-center" ? "headerCenter" : "headerRight";
                const blockId = layout[slotKey];
                return (
                  <div
                    key={zone}
                    className={`ptb-drop-zone${dragOverZone === zone ? " ptb-drop-zone-over" : ""}${zone === "header-center" ? " ptb-drop-zone-center" : ""}`}
                    onDragOver={(e) => handleDragOver(e, zone)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, zone)}
                  >
                    {blockId && (
                      <div
                        className={`ptb-block${selectedBlock === blockId ? " ptb-block-selected" : ""}${draggingBlock === blockId ? " ptb-block-dragging" : ""}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, blockId, "header")}
                        onDragEnd={handleDragEnd}
                        onClick={(e) => { e.stopPropagation(); handleBlockClick(blockId); }}
                        title={`Drag to reorder: ${BLOCK_LABELS[blockId] || blockId}`}
                      >
                        {renderHeaderBlock(blockId)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Date Box */}
            {config.dateBox?.show !== false && (
              <div
                className={`ptb-block ptb-pv-datebox${selectedBlock === "dateBox" ? " ptb-block-selected" : ""}`}
                onClick={(e) => { e.stopPropagation(); handleBlockClick("dateBox"); }}
              >
                <div className="ptb-pv-datebox-inner" style={{ borderColor: config.colors?.lineStroke || "#000" }}>
                  <div className="ptb-pv-datebox-cell ptb-pv-datebox-label" style={{ borderColor: config.colors?.lineStroke || "#000", color: config.colors?.text || "#000" }}>DATE</div>
                  <div className="ptb-pv-datebox-cell ptb-pv-datebox-value" style={{ color: config.colors?.text || "#000" }}>
                    {new Date().toLocaleDateString("en-US")}
                  </div>
                </div>
                {previewType === "invoice" && (
                  <div className="ptb-pv-datebox-inner" style={{ marginLeft: -1, borderColor: config.colors?.lineStroke || "#000" }}>
                    <div className="ptb-pv-datebox-cell ptb-pv-datebox-label" style={{ borderColor: config.colors?.lineStroke || "#000", color: config.colors?.text || "#000" }}>INVOICE #</div>
                    <div className="ptb-pv-datebox-cell ptb-pv-datebox-value" style={{ color: config.colors?.text || "#000" }}>INV-1001</div>
                  </div>
                )}
              </div>
            )}

            {/* Info Row — 2 drop zones */}
            <div className="ptb-pv-boxes">
              {["info-left", "info-right"].map((zone) => {
                const slotKey = zone === "info-left" ? "infoLeft" : "infoRight";
                const blockId = layout[slotKey];
                return (
                  <div
                    key={zone}
                    className={`ptb-drop-zone ptb-drop-zone-info${dragOverZone === zone ? " ptb-drop-zone-over" : ""}`}
                    style={{ flex: blockId === "billTo" ? (config.billTo?.widthPercent || 48) : (100 - (config.billTo?.widthPercent || 48)) }}
                    onDragOver={(e) => handleDragOver(e, zone)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, zone)}
                  >
                    {blockId && (
                      <div
                        className={`ptb-block ptb-block-info${selectedBlock === blockId ? " ptb-block-selected" : ""}${draggingBlock === blockId ? " ptb-block-dragging" : ""}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, blockId, "info")}
                        onDragEnd={handleDragEnd}
                        onClick={(e) => { e.stopPropagation(); handleBlockClick(blockId); }}
                        title={`Drag to swap: ${BLOCK_LABELS[blockId] || blockId}`}
                      >
                        {renderInfoBlock(blockId)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* PO Number */}
            {config.poNumber?.show !== false && (
              <div
                className={`ptb-block ptb-pv-po${selectedBlock === "poNumber" ? " ptb-block-selected" : ""}`}
                onClick={(e) => { e.stopPropagation(); handleBlockClick("poNumber"); }}
              >
                <div className="ptb-pv-po-box" style={{ borderColor: config.colors?.lineStroke || "#000" }}>
                  <div className="ptb-pv-box-header" style={{ fontSize: 7, borderColor: config.colors?.lineStroke || "#000", color: config.colors?.text || "#000" }}>
                    {config.poNumber?.label || "P.O. No."}
                  </div>
                  <div className="ptb-pv-box-body" style={{ padding: "3px 4px", minHeight: "auto", fontSize: 8, color: config.colors?.text || "#000" }}>
                    PO-12345
                  </div>
                </div>
              </div>
            )}

            {/* Line Items Table */}
            {config.lineItems?.show !== false && (
              <div
                className={`ptb-block${selectedBlock === "lineItems" ? " ptb-block-selected" : ""}`}
                onClick={(e) => { e.stopPropagation(); handleBlockClick("lineItems"); }}
              >
                <table className="ptb-pv-table" style={{ borderColor: config.colors?.lineStroke || "#000" }}>
                  <thead>
                    <tr>
                      <th style={{
                        background: config.lineItems?.headerBgColor || "#E0E0E0",
                        fontSize: config.lineItems?.headerFontSize || 7,
                        width: config.lineItems?.qtyColumnWidth || 50,
                        textAlign: "center",
                        borderColor: config.colors?.lineStroke || "#000",
                        color: config.colors?.text || "#000",
                      }}>
                        {previewType === "invoice" ? invHeaders.qty || "QUANTITY" : estHeaders.qty || "Qty"}
                      </th>
                      <th style={{
                        background: config.lineItems?.headerBgColor || "#E0E0E0",
                        fontSize: config.lineItems?.headerFontSize || 7,
                        borderColor: config.colors?.lineStroke || "#000",
                        color: config.colors?.text || "#000",
                      }}>
                        {previewType === "invoice" ? invHeaders.description || "DESCRIPTION" : estHeaders.description || "DESCRIPTION"}
                      </th>
                      <th style={{
                        background: config.lineItems?.headerBgColor || "#E0E0E0",
                        fontSize: config.lineItems?.headerFontSize || 7,
                        width: config.lineItems?.totalColumnWidth || 75,
                        textAlign: "right",
                        borderColor: config.colors?.lineStroke || "#000",
                        color: config.colors?.text || "#000",
                      }}>
                        {previewType === "invoice" ? invHeaders.total || "AMOUNT" : estHeaders.total || "TOTAL"}
                      </th>
                    </tr>
                  </thead>
                  <tbody style={{ fontSize: config.lineItems?.bodyFontSize || 8 }}>
                    <tr><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>1</td><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>INITIAL SERVICE CALL</td><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>150.00</td></tr>
                    <tr><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>2</td><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>TEMPERED GLASS PANEL 48&quot; X 72&quot;</td><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>850.00</td></tr>
                    <tr><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>4</td><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>LABOR - INSTALLATION</td><td style={{ borderColor: config.colors?.lineStroke || "#000" }}>300.00</td></tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* Footer */}
            {config.footer?.show !== false && (
              <div
                className={`ptb-block ptb-pv-footer${selectedBlock === "footer" ? " ptb-block-selected" : ""}`}
                onClick={(e) => { e.stopPropagation(); handleBlockClick("footer"); }}
              >
                {config.footer?.showTerms !== false && (
                  <div className="ptb-pv-terms" style={{ borderColor: config.colors?.lineStroke || "#000", color: config.colors?.text || "#000" }}>
                    NET 30. ALL PRICES VALID FOR 30 DAYS.
                  </div>
                )}
                <div className="ptb-pv-total-label" style={{
                  fontSize: config.footer?.totalFontSize || 10,
                  minWidth: config.footer?.totalLabelWidth || 60,
                  borderColor: config.colors?.lineStroke || "#000",
                  color: config.colors?.text || "#000",
                }}>
                  TOTAL
                </div>
                <div className="ptb-pv-total-amount" style={{
                  fontSize: config.footer?.totalAmountFontSize || 11,
                  minWidth: config.footer?.totalAmountWidth || 100,
                  borderColor: config.colors?.lineStroke || "#000",
                  color: config.colors?.text || "#000",
                }}>
                  $2,150.00
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
