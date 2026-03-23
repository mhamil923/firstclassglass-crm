import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./PdfTemplates.css";

export default function PdfTemplates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await api.get("/pdf-templates");
      setTemplates(res.data);
    } catch (err) {
      console.error("Error fetching templates:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleDuplicate = async (id) => {
    try {
      await api.post(`/pdf-templates/${id}/duplicate`);
      fetchTemplates();
    } catch (err) {
      console.error("Error duplicating template:", err);
    }
  };

  const handleSetDefault = async (id) => {
    try {
      await api.put(`/pdf-templates/${id}`, { isDefault: true });
      fetchTemplates();
    } catch (err) {
      console.error("Error setting default:", err);
    }
  };

  const handleRemoveDefault = async (id) => {
    try {
      await api.put(`/pdf-templates/${id}`, { isDefault: false });
      fetchTemplates();
    } catch (err) {
      console.error("Error removing default:", err);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete template "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/pdf-templates/${id}`);
      fetchTemplates();
    } catch (err) {
      alert(err.response?.data?.error || "Failed to delete template.");
    }
  };

  const parseConfig = (tpl) => {
    try {
      return typeof tpl.config === "string" ? JSON.parse(tpl.config) : tpl.config || {};
    } catch { return {}; }
  };

  // Determine which template is the effective default for each type
  const getDefaultInfo = () => {
    const estSpecific = templates.find(t => t.isDefault === 1 && t.type === "estimate");
    const invSpecific = templates.find(t => t.isDefault === 1 && t.type === "invoice");
    const bothDefault = templates.find(t => t.isDefault === 1 && t.type === "both");
    return {
      estimateDefaultId: estSpecific?.id || bothDefault?.id || null,
      invoiceDefaultId: invSpecific?.id || bothDefault?.id || null,
    };
  };

  const defaultInfo = templates.length > 0 ? getDefaultInfo() : { estimateDefaultId: null, invoiceDefaultId: null };

  const renderMiniPreview = (tpl) => {
    const cfg = parseConfig(tpl);
    const headerBg = cfg.lineItems?.headerBgColor || cfg.colors?.headerBg || "#E0E0E0";
    const showCompany = cfg.companyInfo?.show !== false;
    const showLogo = cfg.logo?.show !== false;
    const showTitle = cfg.title?.show !== false;
    const showBillTo = cfg.billTo?.show !== false;
    const showProject = cfg.projectBox?.show !== false;
    const showPo = cfg.poNumber?.show !== false;
    const showLineItems = cfg.lineItems?.show !== false;
    const showFooter = cfg.footer?.show !== false;

    return (
      <div className="pt-preview-page">
        <div className="pt-preview-header">
          <div className={`pt-preview-company ${!showCompany ? "pt-preview-hidden" : ""}`}>
            {cfg.companyInfo?.name || "First Class Glass"}
            <br />Address Line 1
            <br />Phone
          </div>
          {showLogo && (
            <div style={{ width: 10, height: 10, background: "#ddd", borderRadius: 1, margin: "0 4px" }} />
          )}
          <div className={`pt-preview-title ${!showTitle ? "pt-preview-hidden" : ""}`}>
            Estimate
          </div>
        </div>

        <div className="pt-preview-boxes">
          {showBillTo && (
            <div className="pt-preview-box">
              <div className="pt-preview-box-label">{cfg.billTo?.label || "BILL TO"}</div>
              <div className="pt-preview-box-content">Customer Name<br />123 Main St</div>
            </div>
          )}
          {showProject && (
            <div className="pt-preview-box">
              <div className="pt-preview-box-label">{cfg.projectBox?.estimateLabel || "PROJECT"}</div>
              <div className="pt-preview-box-content">Project Name<br />456 Oak Ave</div>
            </div>
          )}
        </div>

        {showPo && (
          <div className="pt-preview-boxes" style={{ marginBottom: 2 }}>
            <div className="pt-preview-box" style={{ maxWidth: "40%" }}>
              <div className="pt-preview-box-label">{cfg.poNumber?.label || "P.O. No."}</div>
              <div className="pt-preview-box-content">PO-12345</div>
            </div>
          </div>
        )}

        {showLineItems && (
          <div className="pt-preview-table">
            <div className="pt-preview-table-header" style={{ background: headerBg }}>
              <span className="pt-preview-table-qty">Qty</span>
              <span className="pt-preview-table-desc">Description</span>
              <span className="pt-preview-table-amt">Total</span>
            </div>
            <div className="pt-preview-table-row">
              <span className="pt-preview-table-qty">1</span>
              <span className="pt-preview-table-desc">Service Call</span>
              <span className="pt-preview-table-amt">150.00</span>
            </div>
            <div className="pt-preview-table-row">
              <span className="pt-preview-table-qty">2</span>
              <span className="pt-preview-table-desc">Glass Panel</span>
              <span className="pt-preview-table-amt">850.00</span>
            </div>
          </div>
        )}

        {showFooter && (
          <div className="pt-preview-footer">
            <div className="pt-preview-terms">Terms...</div>
            <div className="pt-preview-total">$2,150.00</div>
          </div>
        )}
      </div>
    );
  };

  const renderDefaultBadges = (tpl) => {
    const badges = [];
    if (tpl.id === defaultInfo.estimateDefaultId) {
      badges.push(<span key="est" className="pt-badge pt-badge-default-estimate">Default Estimate</span>);
    }
    if (tpl.id === defaultInfo.invoiceDefaultId) {
      badges.push(<span key="inv" className="pt-badge pt-badge-default-invoice">Default Invoice</span>);
    }
    return badges;
  };

  const renderDefaultButtons = (tpl) => {
    const buttons = [];
    const isEstDefault = tpl.id === defaultInfo.estimateDefaultId;
    const isInvDefault = tpl.id === defaultInfo.invoiceDefaultId;

    if (tpl.type === "estimate") {
      if (isEstDefault) {
        buttons.push(
          <button key="rm-est" className="pt-btn pt-btn-outline-green" onClick={() => handleRemoveDefault(tpl.id)}>
            Remove Default
          </button>
        );
      } else {
        buttons.push(
          <button key="set-est" className="pt-btn pt-btn-success" onClick={() => handleSetDefault(tpl.id)}>
            Set as Default Estimate
          </button>
        );
      }
    } else if (tpl.type === "invoice") {
      if (isInvDefault) {
        buttons.push(
          <button key="rm-inv" className="pt-btn pt-btn-outline-green" onClick={() => handleRemoveDefault(tpl.id)}>
            Remove Default
          </button>
        );
      } else {
        buttons.push(
          <button key="set-inv" className="pt-btn pt-btn-success" onClick={() => handleSetDefault(tpl.id)}>
            Set as Default Invoice
          </button>
        );
      }
    } else {
      // type === "both" — single isDefault flag acts as fallback for both types
      if (tpl.isDefault) {
        buttons.push(
          <button key="rm" className="pt-btn pt-btn-outline-green" onClick={() => handleRemoveDefault(tpl.id)}>
            Remove Default
          </button>
        );
      } else {
        buttons.push(
          <button key="set" className="pt-btn pt-btn-success" onClick={() => handleSetDefault(tpl.id)}>
            Set as Default
          </button>
        );
      }
    }
    return buttons;
  };

  if (loading) return <div className="pt-page"><div className="pt-loading">Loading templates...</div></div>;

  return (
    <div className="pt-page">
      <div className="pt-container">
        <div className="pt-header">
          <div>
            <h1 className="pt-title">PDF Templates</h1>
            <p className="pt-subtitle">Customize the layout and styling of estimate and invoice PDFs</p>
          </div>
          <button className="pt-btn pt-btn-primary" onClick={() => navigate("/pdf-templates/new")}>
            + Create Template
          </button>
        </div>

        {templates.length === 0 ? (
          <div className="pt-empty">No templates found. Create one to get started.</div>
        ) : (
          <div className="pt-grid">
            {templates.map((tpl) => (
              <div className="pt-card" key={tpl.id}>
                <div className="pt-preview">{renderMiniPreview(tpl)}</div>
                <div className="pt-card-body">
                  <h3 className="pt-card-name">{tpl.name}</h3>
                  <div className="pt-card-badges">
                    <span className="pt-badge pt-badge-type">{tpl.type}</span>
                    {renderDefaultBadges(tpl)}
                  </div>
                  <div className="pt-card-actions">
                    <button className="pt-btn" onClick={() => navigate(`/pdf-templates/${tpl.id}`)}>
                      Edit
                    </button>
                    <button className="pt-btn" onClick={() => handleDuplicate(tpl.id)}>
                      Duplicate
                    </button>
                    {renderDefaultButtons(tpl)}
                    {!tpl.isDefault && (
                      <button className="pt-btn pt-btn-danger" onClick={() => handleDelete(tpl.id, tpl.name)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
