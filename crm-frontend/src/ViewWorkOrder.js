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

/* ---------- helpers ---------- */
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
      const next = po.trim() || null;
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

/* ---------- Main Component ---------- */
export default function ViewWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [workOrder, setWorkOrder] = useState(null);
  const [newNote, setNewNote] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  const [busyReplace, setBusyReplace] = useState(false);
  const [keepOldInAttachments, setKeepOldInAttachments] = useState(true);
  const [busyPoUpload, setBusyPoUpload] = useState(false);
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

  useEffect(() => { fetchWorkOrder(); }, [id]);

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
    siteLocation,
    siteAddress,
    billingAddress,
    problemDescription,
    scheduledDate,
    pdfPath,
    photoPath,
    customerPhone,
    customerEmail,
  } = workOrder;

  const cleanedPo = displayPO(workOrderNumber, poNumber);
  const pdfUrl = pdfPath ? `${API_BASE_URL}/files?key=${encodeURIComponent(pdfPath)}#page=1&view=FitH` : null;
  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const isPdfKey = (key) => /\.pdf(\?|$)/i.test(key);
  const pdfAttachments = attachments.filter(isPdfKey);
  const attachmentImages = attachments.filter((p) => !isPdfKey(p));

  // categorize by filename
  const signoffPdfs = pdfAttachments.filter((f) =>
    /signoff|sign_off|signature/i.test(f)
  );
  const estimatePdfs = pdfAttachments.filter((f) =>
    /estimate|quote/i.test(f)
  );
  const poPdfs = pdfAttachments.filter((f) =>
    /po|purchaseorder/i.test(f)
  );

  const urlFor = (relPath) => `${API_BASE_URL}/files?key=${encodeURIComponent(relPath)}`;

  /* ---------- Upload handlers ---------- */
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
      await api.put(`/work-orders/${id}/status`, { status: newStatus });
      await fetchWorkOrder();
    } catch {
      const form = new FormData();
      form.append("status", newStatus);
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
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
    } catch {
      alert("Failed to add note.");
    }
  };

  const handleDeleteNote = async (origIndex) => {
    if (!window.confirm("Delete this note?")) return;
    try {
      await api.delete(`/work-orders/${id}/notes/${origIndex}`);
      fetchWorkOrder();
    } catch {
      alert("Failed to delete note.");
    }
  };

  return (
    <div className="view-container">
      <div className="view-card">
        <div className="view-header-row">
          <h2 className="view-title">Work Order Details</h2>
          <div className="view-actions">
            <button className="btn btn-outline" onClick={() => window.print()}>🖨️ Print</button>
            <button className="back-btn" onClick={() => navigate("/work-orders")}>← Back</button>
          </div>
        </div>

        {/* BASIC INFO */}
        <ul className="detail-list">
          <li><strong>Work Order #:</strong> {displayWO(workOrderNumber)}</li>
          <li><strong>PO #:</strong>
            <PONumberEditor
              orderId={workOrder.id}
              initialPo={cleanedPo}
              onSaved={(newPo) => setWorkOrder((prev) => ({ ...prev, poNumber: newPo || null }))}
            />
          </li>
          <li><strong>Status:</strong>
            <select value={localStatus} onChange={handleStatusChange} disabled={statusSaving}>
              <option value="" disabled>Select status…</option>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </li>
          <li><strong>Customer:</strong> {customer || "—"}</li>
          <li><strong>Site:</strong> {siteLocation || "—"} | {siteAddress || "—"}</li>
          <li><strong>Problem:</strong> {problemDescription || "—"}</li>
        </ul>

        {/* SIGN-OFF SHEETS */}
        <div className="section-card">
          <h3 className="section-header">Sign-Off Sheet PDF(s)</h3>
          {pdfUrl && (
            <iframe src={pdfUrl} className="pdf-frame" title="Main Sign-Off PDF" />
          )}
          {signoffPdfs.length ? (
            signoffPdfs.map((relPath, i) => {
              const url = urlFor(relPath);
              const name = relPath.split("/").pop();
              return (
                <div key={relPath} className="pdf-block">
                  <iframe src={`${url}#page=1&view=FitH`} className="pdf-frame" title={name} />
                  <div>
                    <a href={url} target="_blank" rel="noreferrer">Open {name}</a>
                    <button onClick={() => handleDeleteAttachment(relPath)}>Delete</button>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="empty-text">No signed sheets yet.</p>
          )}
        </div>

        {/* ESTIMATE PDFs */}
        <div className="section-card">
          <h3 className="section-header">Estimate PDF(s)</h3>
          {estimatePdfs.length ? (
            estimatePdfs.map((relPath) => {
              const url = urlFor(relPath);
              const name = relPath.split("/").pop();
              return (
                <div key={relPath} className="pdf-block">
                  <iframe src={`${url}#page=1&view=FitH`} className="pdf-frame" title={name} />
                  <div>
                    <a href={url} target="_blank" rel="noreferrer">Open {name}</a>
                    <button onClick={() => handleDeleteAttachment(relPath)}>Delete</button>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="empty-text">No estimate PDFs attached.</p>
          )}
        </div>

        {/* PO PDFs */}
        <div className="section-card">
          <h3 className="section-header">PO Order PDF(s)</h3>
          {poPdfs.length ? (
            poPdfs.map((relPath) => {
              const url = urlFor(relPath);
              const name = relPath.split("/").pop();
              return (
                <div key={relPath} className="pdf-block">
                  <iframe src={`${url}#page=1&view=FitH`} className="pdf-frame" title={name} />
                  <div>
                    <a href={url} target="_blank" rel="noreferrer">Open {name}</a>
                    <button onClick={() => handleDeleteAttachment(relPath)}>Delete</button>
                  </div>
                </div>
              );
            })
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
          </div>
        </div>

        {/* IMAGE ATTACHMENTS */}
        <div className="section-card">
          <h3 className="section-header">Image Attachments</h3>
          {attachmentImages.length ? (
            attachmentImages.map((relPath) => {
              const url = urlFor(relPath);
              return (
                <div key={relPath} className="img-item">
                  <img src={url} alt="attachment" className="attachment-img" />
                  <button onClick={() => handleDeleteAttachment(relPath)}>Delete</button>
                </div>
              );
            })
          ) : (
            <p className="empty-text">No images attached.</p>
          )}
        </div>

        {/* NOTES */}
        <div className="section-card">
          <h3 className="section-header">Notes</h3>
          <button className="toggle-note-btn" onClick={() => setShowNoteInput((v) => !v)}>
            {showNoteInput ? "Cancel" : "Add Note"}
          </button>
          {showNoteInput && (
            <div className="add-note">
              <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} />
              <button onClick={handleAddNote}>Submit Note</button>
            </div>
          )}
          {displayNotes.length ? (
            displayNotes.map((n) => (
              <div key={n.createdAt} className="note-item">
                <div className="note-header">
                  <small>{moment(n.createdAt).format("YYYY-MM-DD HH:mm")}</small>
                  <button onClick={() => handleDeleteNote(n.__origIndex)}>✕</button>
                </div>
                <p>{n.text}</p>
              </div>
            ))
          ) : (
            <p className="empty-text">No notes yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
