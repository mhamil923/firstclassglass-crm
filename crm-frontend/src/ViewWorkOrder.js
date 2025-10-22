// File: src/ViewWorkOrder.js
import React, { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "./api";
import moment from "moment";
import API_BASE_URL from "./config";
import "./ViewWorkOrder.css";

// Keep this in sync with AddWorkOrder.js and WorkOrders.js
const STATUS_OPTIONS = [
  "New",
  "Scheduled",
  "Needs to be Quoted",
  "Waiting for Approval",
  "Approved",
  "Waiting on Parts",
  "Needs to be Scheduled",
  "Needs to be Invoiced",
  "Completed",
];

/* ---------- helpers to clean up legacy data (PO# == WO#) ---------- */
const norm = (v) => (v ?? "").toString().trim();
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayWO = (wo) => norm(wo) || "—";
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

/* ---------- Inline PO# Editor ---------- */
function PONumberEditor({ orderId, initialPo, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [po, setPo] = useState(initialPo || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setPo(initialPo || ""); }, [initialPo]);

  const save = async () => {
    setSaving(true);
    try {
      const next = po.trim() || null; // Persist blank as NULL
      await api.put(`/work-orders/${orderId}`, { poNumber: next });
      onSaved?.(next);
      setEditing(false);
    } catch (e) {
      console.error("Failed to save PO #", e);
      alert(e?.response?.data?.error || "Failed to save PO #");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>{initialPo ? initialPo : <em>None</em>}</div>
        <button className="btn btn-primary" onClick={() => setEditing(true)}>
          {initialPo ? "Update PO #" : "Add PO #"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <input
        type="text"
        value={po}
        onChange={(e) => setPo(e.target.value)}
        className="form-input"
        placeholder="Enter PO # (optional)"
        style={{ height: 36, borderRadius: 8, border: "1px solid #cbd5e1", padding: "0 10px" }}
      />
      <button className="btn btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button className="btn btn-ghost" disabled={saving} onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  );
}
/* --------------------------------------- */

export default function ViewWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);
  const [newNote, setNewNote] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  // PDF UI state
  const [busyReplace, setBusyReplace] = useState(false);
  const [keepOldInAttachments, setKeepOldInAttachments] = useState(true);

  // Upload states
  const [busyPoUpload, setBusyPoUpload] = useState(false);
  const [busyEstimateUpload, setBusyEstimateUpload] = useState(false);

  // Status state
  const [statusSaving, setStatusSaving] = useState(false);
  const [localStatus, setLocalStatus] = useState("");

  const fetchWorkOrder = async () => {
    try {
      const response = await api.get(`/work-orders/${id}`);
      setWorkOrder(response.data || null);
      setLocalStatus(response.data?.status || "");
    } catch (error) {
      console.error("⚠️ Error fetching work order:", error);
    }
  };

  useEffect(() => {
    fetchWorkOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Parse existing notes safely
  const originalNotes = useMemo(() => {
    try {
      const raw = workOrder?.notes;
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }, [workOrder]);

  // Newest first for display
  const displayNotes = useMemo(
    () =>
      originalNotes
        .map((n, idx) => ({ ...n, __origIndex: idx }))
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)),
    [originalNotes]
  );

  if (!workOrder) {
    return (
      <div className="view-container">
        <p className="loading-text">Loading work order details…</p>
      </div>
    );
  }

  const {
    workOrderNumber,
    poNumber,
    customer,
    siteLocation,   // LOCATION NAME (e.g., "Panda Express")
    siteAddress,    // STREET ADDRESS
    billingAddress,
    problemDescription,
    status,
    scheduledDate,
    pdfPath,
    photoPath,
    customerPhone,
    customerEmail,
  } = workOrder;

  // Clean PO for display (blank if it was just the WO#)
  const cleanedPo = displayPO(workOrderNumber, poNumber);

  // File URLs (S3/local safe)
  const pdfUrl = pdfPath
    ? `${API_BASE_URL}/files?key=${encodeURIComponent(pdfPath)}#page=1&view=FitH`
    : null;

  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const isPdfKey = (key) => /\.pdf(\?|$)/i.test(key);
  const pdfAttachments = attachments.filter(isPdfKey);
  const attachmentImages = attachments.filter((p) => !isPdfKey(p));

  // ---------- simple filename categorization ----------
  const signoffPdfs = pdfAttachments.filter((f) =>
    /signoff|sign_off|signature/i.test(f)
  );
  const estimatePdfs = pdfAttachments.filter((f) =>
    /estimate|quote/i.test(f)
  );
  const poPdfs = pdfAttachments.filter((f) =>
    /(^|[^a-z])po([^a-z]|$)|purchase[_-]?order/i.test(f)
  );

  const urlFor = (relPath) => `${API_BASE_URL}/files?key=${encodeURIComponent(relPath)}`;

  // ---------- PRINT helpers (restored template) ----------
  const LOGO_URL = `${window.location.origin}/fcg-logo.png`;
  const safe = (x) =>
    (x ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const handlePrint = () => {
    const siteDisplayName = (siteLocation || customer || "").trim();
    const siteAddr = (siteAddress || "").trim();
    const agreementNo = cleanedPo || id;

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Agreement ${safe(agreementNo)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, "Segoe UI", Roboto, sans-serif; color: #000; -webkit-print-color-adjust: exact; }
    .sheet { width: 100%; max-width: 8.5in; margin: 0 auto; page-break-inside: avoid; }
    .hdr { display: grid; grid-template-columns: 120px 1fr 220px; align-items: center; column-gap: 12px; }
    .logo { width: 100%; height: auto; }
    .company h1 { margin: 0; font-size: 18px; font-weight: 700; }
    .company .addr { margin-top: 2px; font-size: 10px; line-height: 1.2; }
    .agree { text-align: right; }
    .agree .title { font-size: 18px; font-weight: 700; text-transform: uppercase; border-bottom: 2px solid #000; display: inline-block; padding-bottom: 2px; }
    .agree .no { margin-top: 6px; font-size: 12px; }
    .spacer-8 { height: 8px; }
    table { border-collapse: collapse; width: 100%; }
    .two-col th, .two-col td { border: 1px solid #000; font-size: 11px; padding: 6px 8px; vertical-align: middle; }
    .two-col th { background: #fff; font-weight: 700; text-transform: uppercase; }
    .label { width: 18%; }
    .desc-title { border: 1px solid #000; border-bottom: none; padding: 6px 8px; font-size: 11px; font-weight: 700; text-align: center; }
    .desc-box { border: 1px solid #000; height: 6.0in; padding: 10px; white-space: pre-wrap; font-size: 12px; overflow: hidden; }
    .auth-title { text-align: center; font-size: 12px; font-weight: 700; margin-top: 6px; }
    .auth-note { font-size: 8.5px; text-align: center; margin-top: 4px; }
    .sign-row { display: grid; grid-template-columns: 1fr 160px; gap: 16px; margin-top: 10px; align-items: end; }
    .sign-line { border-bottom: 1px solid #000; height: 16px; }
    .sign-label { font-size: 10px; margin-top: 2px; }
    .fine { font-size: 8px; color: #000; margin-top: 6px; text-align: left; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="hdr">
      <img class="logo" src="${safe(LOGO_URL)}" alt="First Class Glass logo" />
      <div class="company">
        <h1>First Class Glass &amp; Mirror, INC.</h1>
        <div class="addr">
          1513 Industrial Dr, Itasca, Illinois 60143 • 630-250-9777<br/>
          FCG@FirstClassGlassMirror.com
        </div>
      </div>
      <div class="agree">
        <div class="title">Agreement</div>
        <div class="no">No. ${safe(agreementNo)}</div>
      </div>
    </div>

    <div class="spacer-8"></div>

    <table class="two-col">
      <tr>
        <th colspan="2">Agreement Submitted To:</th>
        <th colspan="2">Work To Be Performed At:</th>
      </tr>
      <tr>
        <th class="label">Name</th>
        <td>${safe(customer || "")}</td>
        <th class="label">Name</th>
        <td>${safe(siteDisplayName)}</td>
      </tr>
      <tr>
        <th class="label">Address</th>
        <td><pre style="margin:0;white-space:pre-wrap">${safe(billingAddress || "")}</pre></td>
        <th class="label">Address</th>
        <td><pre style="margin:0;white-space:pre-wrap">${safe(siteAddr)}</pre></td>
      </tr>
      <tr>
        <th class="label">Phone</th>
        <td>${safe(customerPhone || "")}</td>
        <th class="label">Phone</th>
        <td></td>
      </tr>
    </table>

    <div class="desc-title">Problem Description: ${safe(problemDescription || "")}</div>
    <div class="desc-box"></div>

    <div class="auth-title">AUTHORIZATION TO PAY</div>
    <div class="auth-note">
      I ACKNOWLEDGE RECEIPT OF GOODS AND SERVICES REQUESTED AND THAT ALL SERVICES WERE PERFORMED IN A PROFESSIONAL MANNER TO MY COMPLETE SATISFACTION. I UNDERSTAND THAT I AM PERSONALLY RESPONSIBLE FOR PAYMENT.
    </div>

    <div class="sign-row">
      <div>
        <div class="sign-line"></div>
        <div class="sign-label">Customer Signature:</div>
      </div>
      <div>
        <div class="sign-line"></div>
        <div class="sign-label">Date:</div>
      </div>
    </div>

    <div class="fine">
      NOTE: A $25 SERVICE CHARGE WILL BE ASSESSED FOR ANY CHECKS RETURNED. PAST DUE ACCOUNTS ARE SUBJECT TO 5% PER MONTH FINANCE CHARGE.
    </div>
  </div>
  <script>
    window.onload = function() { setTimeout(function(){ window.print(); window.close(); }, 150); };
  </script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=1000,height=1200");
    if (!w) { alert("Popup blocked. Please allow popups to print."); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  /* ---------- Upload handlers (attachments) ---------- */
  // Replace the main "Signed Work Order" PDF (pdfPath)
  const handleReplacePdfUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf") {
      alert("Please choose a PDF file.");
      e.target.value = "";
      return;
    }
    setBusyReplace(true);
    try {
      const form = new FormData();
      form.append("pdfFile", file);
      form.append("replacePdf", "1");
      if (keepOldInAttachments) {
        form.append("keepOldPdfInAttachments", "1");
        form.append("keepOldInAttachments", "1");
      }
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
      alert("PDF replaced successfully.");
    } catch (error) {
      console.error("⚠️ Error replacing PDF:", error);
      alert(error?.response?.data?.error || "Failed to replace PDF.");
    } finally {
      setBusyReplace(false);
      e.target.value = "";
    }
  };

  // Upload PO Order PDF(s) → attachments (filename match drives category)
  const handleUploadPoPdf = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (!files.every((f) => f.type === "application/pdf")) {
      alert("Please choose PDF file(s).");
      e.target.value = "";
      return;
    }
    setBusyPoUpload(true);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("pdfFile", f));
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading PO PDF:", error);
      alert(error?.response?.data?.error || "Failed to upload PO PDF.");
    } finally {
      setBusyPoUpload(false);
      e.target.value = "";
    }
  };

  // Upload Estimate PDF(s) → attachments (filename match drives category)
  const handleUploadEstimatePdf = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (!files.every((f) => f.type === "application/pdf")) {
      alert("Please choose PDF file(s).");
      e.target.value = "";
      return;
    }
    setBusyEstimateUpload(true);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("pdfFile", f));
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading Estimate PDF:", error);
      alert(error?.response?.data?.error || "Failed to upload Estimate PDF.");
    } finally {
      setBusyEstimateUpload(false);
      e.target.value = "";
    }
  };

  const handleDeleteAttachment = async (relPath) => {
    if (!window.confirm("Delete this attachment?")) return;
    try {
      await api.delete(`/work-orders/${id}/attachment`, { data: { photoPath: relPath } });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error deleting attachment:", error);
      alert(error?.response?.data?.error || "Failed to delete attachment.");
    }
  };

  /* ---------- Status ---------- */
  const handleStatusChange = async (e) => {
    const newStatus = e.target.value;
    setLocalStatus(newStatus);
    setStatusSaving(true);
    try {
      try {
        await api.put(`/work-orders/${id}/status`, { status: newStatus });
      } catch {
        const form = new FormData();
        form.append("status", newStatus);
        await api.put(`/work-orders/${id}/edit`, form, { headers: { "Content-Type": "multipart/form-data" } });
      }
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error updating status:", error);
      alert("Failed to update status.");
    } finally {
      setStatusSaving(false);
    }
  };

  /* ---------- Notes ---------- */
  const handleAddNote = async () => {
    if (!newNote.trim()) return;
    try {
      await api.post(`/work-orders/${id}/notes`, { text: newNote });
      setNewNote("");
      setShowNoteInput(false);
      fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error adding note:", error);
      alert("Failed to add note.");
    }
  };

  const handleDeleteNote = async (origIndex) => {
    if (!window.confirm("Delete this note?")) return;
    try {
      await api.delete(`/work-orders/${id}/notes/${origIndex}`);
      fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error deleting note:", error);
      alert("Failed to delete note.");
    }
  };

  return (
    <div className="view-container">
      <div className="view-card">
        <div className="view-header-row">
          <h2 className="view-title">Work Order Details</h2>
          <div className="view-actions">
            <button className="btn btn-outline" onClick={handlePrint}>🖨️ Print Work Order</button>
            <button className="back-btn" onClick={() => navigate("/work-orders")}>← Back to List</button>
          </div>
        </div>

        {/* BASIC INFO — restored structure/classes */}
        <ul className="detail-list">
          <li className="detail-item">
            <span className="detail-label">Work Order #:</span>
            <span className="detail-value">{displayWO(workOrderNumber)}</span>
          </li>

          <li className="detail-item">
            <span className="detail-label">PO #:</span>
            <span className="detail-value">
              <PONumberEditor
                orderId={workOrder.id}
                initialPo={cleanedPo}
                onSaved={(newPo) => setWorkOrder((prev) => ({ ...prev, poNumber: newPo || null }))}
              />
            </span>
          </li>

          <li className="detail-item">
            <span className="detail-label">Status:</span>
            <span className="detail-value">
              <select value={localStatus} onChange={handleStatusChange} disabled={statusSaving} style={{ padding: 6 }}>
                <option value="" disabled>Select status…</option>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              {statusSaving && <small style={{ marginLeft: 8 }}>Saving…</small>}
            </span>
          </li>

          <li className="detail-item">
            <span className="detail-label">Customer:</span>
            <span className="detail-value">{customer || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Customer Phone:</span>
            <span className="detail-value">{customerPhone || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Customer Email:</span>
            <span className="detail-value">{customerEmail || "—"}</span>
          </li>

          <li className="detail-item">
            <span className="detail-label">Site Location:</span>
            <span className="detail-value">{siteLocation || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Site Address:</span>
            <span className="detail-value pre-wrap">{siteAddress || "—"}</span>
          </li>

          <li className="detail-item">
            <span className="detail-label">Billing Address:</span>
            <span className="detail-value pre-wrap">{billingAddress || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Problem Description:</span>
            <span className="detail-value pre-wrap">{problemDescription || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Scheduled Date:</span>
            <span className="detail-value">
              {scheduledDate ? moment(scheduledDate).format("YYYY-MM-DD HH:mm") : "Not Scheduled"}
            </span>
          </li>
        </ul>

        {/* Signed Work Order PDF (main pdfPath) */}
        <div className="section-card">
          <h3 className="section-header">Sign-Off Sheet PDF(s)</h3>

          {pdfUrl ? (
            <>
              <iframe src={pdfUrl} className="pdf-frame" title="Work Order PDF" />
              <div className="mt-2" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <a className="btn btn-light" href={pdfUrl} target="_blank" rel="noreferrer">Open PDF in new tab</a>

                <label className="btn">
                  {busyReplace ? "Replacing…" : "Replace Signed PDF"}
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={handleReplacePdfUpload}
                    style={{ display: "none" }}
                    disabled={busyReplace}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={keepOldInAttachments}
                    onChange={(e) => setKeepOldInAttachments(e.target.checked)}
                  />
                  Move existing signed PDF to attachments
                </label>
              </div>
            </>
          ) : (
            <div>
              <p className="empty-text">No PDF attached.</p>
              <label className="btn">
                {busyReplace ? "Uploading…" : "Upload Signed PDF"}
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={handleReplacePdfUpload}
                  style={{ display: "none" }}
                  disabled={busyReplace}
                />
              </label>
            </div>
          )}

          {/* Additional sign-off PDFs that live in attachments (matched by filename) */}
          {signoffPdfs.length ? (
            <div className="attachments">
              {signoffPdfs.map((relPath, i) => {
                const url = urlFor(relPath);
                const fileName = relPath.split("/").pop() || `signoff-${i + 1}.pdf`;
                return (
                  <div key={`${relPath}-${i}`} className="attachment-item" style={{ position: "relative", display: "inline-block", margin: 6 }}>
                    <a href={`${url}#page=1&view=FitH`} className="attachment-chip" target="__blank" rel="noopener noreferrer" title={`Open Sign-Off PDF: ${fileName}`}>
                      📄 {fileName}
                    </a>
                    <button
                      type="button"
                      title="Delete Sign-Off PDF"
                      aria-label="Delete Sign-Off PDF"
                      onClick={() => handleDeleteAttachment(relPath)}
                      style={{
                        position: "absolute", top: -6, right: -6, width: 20, height: 20,
                        borderRadius: "50%", border: "none", background: "#e33", color: "#fff",
                        fontWeight: 700, lineHeight: "18px", cursor: "pointer", zIndex: 5,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* ESTIMATE PDFs (filename contains "estimate" or "quote") */}
        <div className="section-card">
          <h3 className="section-header">Estimate PDF(s)</h3>

          {estimatePdfs.length ? (
            <div className="attachments">
              {estimatePdfs.map((relPath, i) => {
                const url = urlFor(relPath);
                const fileName = relPath.split("/").pop() || `estimate-${i + 1}.pdf`;
                return (
                  <div key={`${relPath}-${i}`} className="attachment-item" style={{ position: "relative", display: "inline-block", margin: 6 }}>
                    <a href={`${url}#page=1&view=FitH`} className="attachment-chip" target="__blank" rel="noopener noreferrer" title={`Open Estimate PDF: ${fileName}`}>
                      📄 {fileName}
                    </a>
                    <button
                      type="button"
                      title="Delete Estimate PDF"
                      aria-label="Delete Estimate PDF"
                      onClick={() => handleDeleteAttachment(relPath)}
                      style={{
                        position: "absolute", top: -6, right: -6, width: 20, height: 20,
                        borderRadius: "50%", border: "none", background: "#e33", color: "#fff",
                        fontWeight: 700, lineHeight: "18px", cursor: "pointer", zIndex: 5,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No estimate PDFs attached.</p>
          )}

          {/* ✅ Upload button for Estimate PDFs */}
          <div className="attachment-upload">
            <label className="btn">
              {busyEstimateUpload ? "Uploading…" : "Upload Estimate PDF(s)"}
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={handleUploadEstimatePdf}
                style={{ display: "none" }}
                disabled={busyEstimateUpload}
              />
            </label>
            <div className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Tip: name files with <code>estimate</code> or <code>quote</code> so they show here.
            </div>
          </div>
        </div>

        {/* PO PDFs (filename contains "po" or "purchaseorder") */}
        <div className="section-card">
          <h3 className="section-header">PO Order PDF(s)</h3>

          {poPdfs.length ? (
            <div className="attachments">
              {poPdfs.map((relPath, i) => {
                const url = urlFor(relPath);
                const fileName = relPath.split("/").pop() || `po-${i + 1}.pdf`;
                return (
                  <div key={`${relPath}-${i}`} className="attachment-item" style={{ position: "relative", display: "inline-block", margin: 6 }}>
                    <a href={`${url}#page=1&view=FitH`} className="attachment-chip" target="__blank" rel="noopener noreferrer" title={`Open PO PDF: ${fileName}`}>
                      📄 {fileName}
                    </a>
                    <button
                      type="button"
                      title="Delete PO PDF"
                      aria-label="Delete PO PDF"
                      onClick={() => handleDeleteAttachment(relPath)}
                      style={{
                        position: "absolute", top: -6, right: -6, width: 20, height: 20,
                        borderRadius: "50%", border: "none", background: "#e33", color: "#fff",
                        fontWeight: 700, lineHeight: "18px", cursor: "pointer", zIndex: 5,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No PO PDFs attached.</p>
          )}

          <div className="attachment-upload">
            <label className="btn">
              {busyPoUpload ? "Uploading…" : "Upload PO PDF(s)"}
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={handleUploadPoPdf}
                style={{ display: "none" }}
                disabled={busyPoUpload}
              />
            </label>
            <div className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Tip: name files with <code>po</code> or <code>purchaseorder</code> so they show here.
            </div>
          </div>
        </div>

        {/* Image Attachments (non-PDF) */}
        <div className="section-card">
          <h3 className="section-header">Image Attachments</h3>

          {attachmentImages.length ? (
            <div className="attachments">
              {attachmentImages.map((relPath, i) => {
                const url = urlFor(relPath);
                const fileName = relPath.split("/").pop() || `image-${i + 1}.jpg`;
                return (
                  <div key={`${relPath}-${i}`} className="attachment-item" style={{ position: "relative", display: "inline-block", margin: 6 }}>
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      <img src={url} alt={fileName} className="attachment-img" />
                    </a>
                    <button
                      type="button"
                      title="Delete attachment"
                      aria-label="Delete attachment"
                      onClick={() => handleDeleteAttachment(relPath)}
                      style={{
                        position: "absolute", top: -6, right: -6, width: 20, height: 20,
                        borderRadius: "50%", border: "none", background: "#e33", color: "#fff",
                        fontWeight: 700, lineHeight: "18px", cursor: "pointer", zIndex: 5,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No images attached.</p>
          )}
        </div>

        {/* Notes */}
        <div className="section-card">
          <h3 className="section-header">Notes</h3>

          <button className="toggle-note-btn" onClick={() => setShowNoteInput((v) => !v)}>
            {showNoteInput ? "Cancel" : "Add Note"}
          </button>

          {showNoteInput && (
            <div className="add-note">
              <textarea
                className="note-input"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Write your note here..."
                rows={3}
              />
              <button className="toggle-note-btn" onClick={handleAddNote}>Submit Note</button>
            </div>
          )}

          {displayNotes.length > 0 ? (
            <ul className="notes-list">
              {displayNotes.map((n, idx) => (
                <li key={`${n.createdAt || "na"}-${idx}`} className="note-item">
                  <div className="note-header">
                    <small className="note-timestamp">
                      {moment(n.createdAt).format("YYYY-MM-DD HH:mm")}
                      {n.by ? ` — ${n.by}` : ""}
                    </small>
                    <button
                      type="button"
                      className="note-delete-btn"
                      title="Delete note"
                      onClick={() => handleDeleteNote(n.__origIndex)}
                    >
                      ✕
                    </button>
                  </div>
                  <p className="note-text">{n.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-text">No notes added.</p>
          )}
        </div>
      </div>
    </div>
  );
}
