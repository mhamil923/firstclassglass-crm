// File: src/ViewWorkOrder.js

import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "./api";
import moment from "moment";
import API_BASE_URL from "./config";
import "./ViewWorkOrder.css";

export default function ViewWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);
  const [newNote, setNewNote] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  // Fetch work order details
  const fetchWorkOrder = async () => {
    try {
      const response = await api.get(`/work-orders/${id}`);
      setWorkOrder(response.data);
    } catch (error) {
      console.error("⚠️ Error fetching work order:", error);
    }
  };

  useEffect(() => {
    fetchWorkOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!workOrder) {
    return (
      <div className="view-container">
        <p className="loading-text">Loading work order details…</p>
      </div>
    );
  }

  const {
    poNumber,
    customer,
    siteLocation,
    billingAddress,
    problemDescription,
    status,
    scheduledDate,
    pdfPath,
    photoPath,
    notes,
  } = workOrder;

  // Parse existing notes
  let notesArray = [];
  if (notes) {
    try {
      notesArray = typeof notes === "string" ? JSON.parse(notes) : notes;
    } catch {
      notesArray = [];
    }
  }

  // Build safe URLs for files (works with S3 + local)
  const pdfUrl = pdfPath
    ? `${API_BASE_URL}/files?key=${encodeURIComponent(pdfPath)}`
    : null;

  // Handle new note submission
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

  // Upload attachments immediately on selection
  const handleAttachmentChange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    // Your server's edit route expects fields named pdfFile/photoFile,
    // not a generic "attachments". Here we only support photo append here.
    const formData = new FormData();
    files.forEach((file) => formData.append("photoFile", file));

    try {
      await api.put(`/work-orders/${id}/edit`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading attachments:", error);
      alert("Failed to upload attachments.");
    }
  };

  // Existing attachments (image keys joined by comma)
  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);

  // -------- PRINT: open a new window with a clean template and print it
  const handlePrint = () => {
    const formattedDate = scheduledDate
      ? moment(scheduledDate).format("YYYY-MM-DD HH:mm")
      : "Not Scheduled";

    const now = moment().format("YYYY-MM-DD HH:mm");

    const safe = (s) =>
      (s ?? "")
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Work Order #${safe(poNumber || id)}</title>
  <style>
    @page { size: A4; margin: 0.6in; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
    .wo-wrap { max-width: 800px; margin: 0 auto; }
    .wo-header { display:flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .brand { font-size: 20px; font-weight: 700; letter-spacing: 0.4px; }
    .meta { font-size: 12px; color: #555; text-align: right; }
    .title { font-size: 22px; font-weight: 700; margin: 8px 0 16px; }
    .grid { width: 100%; border-collapse: separate; border-spacing: 0; }
    .grid th { text-align: left; width: 200px; vertical-align: top; color:#333; font-weight:600; padding: 10px 12px; border: 1px solid #ddd; background:#f8f9fa; }
    .grid td { padding: 10px 12px; border: 1px solid #ddd; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .muted { color:#666; }
    .footer { margin-top: 22px; font-size: 12px; color:#666; display:flex; justify-content: space-between; }
    .sign-row { margin-top: 30px; display:flex; gap: 24px; }
    .sign-col { flex: 1; }
    .line { border-bottom: 1px solid #999; height: 24px; margin-bottom: 6px; }
    .label { font-size: 12px; color:#555; }
  </style>
</head>
<body>
  <div class="wo-wrap">
    <div class="wo-header">
      <div class="brand">First Class Glass — Work Order</div>
      <div class="meta">
        Printed: <span class="mono">${safe(now)}</span><br/>
        WO/PO: <span class="mono">${safe(poNumber || id)}</span>
      </div>
    </div>

    <div class="title">Work Order Details</div>

    <table class="grid">
      <tr><th>WO/PO #</th><td class="mono">${safe(poNumber || id)}</td></tr>
      <tr><th>Customer</th><td>${safe(customer)}</td></tr>
      <tr><th>Site Location</th><td>${safe(siteLocation)}</td></tr>
      <tr><th>Billing Address</th><td><pre style="margin:0;white-space:pre-wrap">${safe(billingAddress)}</pre></td></tr>
      <tr><th>Problem Description</th><td><pre style="margin:0;white-space:pre-wrap">${safe(problemDescription)}</pre></td></tr>
      <tr><th>Status</th><td>${safe(status)}</td></tr>
      <tr><th>Scheduled Date</th><td class="mono">${safe(formattedDate)}</td></tr>
    </table>

    <div class="sign-row">
      <div class="sign-col">
        <div class="line"></div>
        <div class="label">Technician Signature</div>
      </div>
      <div class="sign-col">
        <div class="line"></div>
        <div class="label">Customer Signature</div>
      </div>
    </div>

    <div class="footer">
      <div class="muted">Thank you for your business.</div>
      <div class="muted">Page 1 of 1</div>
    </div>
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() {
        window.print();
        window.close();
      }, 150);
    };
  </script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) {
      alert("Popup blocked. Please allow popups to print.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <div className="view-container">
      <div className="view-card">
        <div className="view-header-row">
          <h2 className="view-title">Work Order Details</h2>
          <div className="view-actions">
            <button className="btn btn-outline" onClick={handlePrint}>
              🖨️ Print Work Order
            </button>
            <button className="back-btn" onClick={() => navigate("/work-orders")}>
              ← Back to List
            </button>
          </div>
        </div>

        <ul className="detail-list">
          <li className="detail-item">
            <span className="detail-label">WO/PO #:</span>
            <span className="detail-value">{poNumber || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Customer:</span>
            <span className="detail-value">{customer}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Site Location:</span>
            <span className="detail-value">{siteLocation}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Billing Address:</span>
            <span className="detail-value pre-wrap">{billingAddress}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Problem Description:</span>
            <span className="detail-value pre-wrap">{problemDescription}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Status:</span>
            <span className="detail-value">{status}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Scheduled Date:</span>
            <span className="detail-value">
              {scheduledDate
                ? moment(scheduledDate).format("YYYY-MM-DD HH:mm")
                : "Not Scheduled"}
            </span>
          </li>
        </ul>

        {pdfUrl && (
          <div className="view-card section-card">
            <h3 className="section-header">Work Order PDF</h3>
            <iframe
              src={pdfUrl}
              className="pdf-frame"
              title="Work Order PDF"
            />
            <div className="mt-2">
              <a className="btn btn-light" href={pdfUrl} target="_blank" rel="noreferrer">
                Open PDF in new tab
              </a>
            </div>
          </div>
        )}

        <div className="section-card">
          <h3 className="section-header">Attachments</h3>
          <div className="attachments">
            {attachments.map((relPath, i) => {
              const url = `${API_BASE_URL}/files?key=${encodeURIComponent(relPath)}`;
              return (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                  <img src={url} alt={`attachment-${i}`} className="attachment-img" />
                </a>
              );
            })}
          </div>
          <div className="attachment-upload">
            <input type="file" multiple onChange={handleAttachmentChange} />
          </div>
        </div>

        <div className="section-card">
          <h3 className="section-header">Notes</h3>

          {/* Toggle note form */}
          <button
            className="toggle-note-btn"
            onClick={() => setShowNoteInput((v) => !v)}
          >
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
              <button className="toggle-note-btn" onClick={handleAddNote}>
                Submit Note
              </button>
            </div>
          )}

          {notesArray.length > 0 ? (
            <ul className="notes-list">
              {notesArray.map((n, idx) => (
                <li key={idx} className="note-item">
                  <small className="note-timestamp">
                    {moment(n.createdAt).format("YYYY-MM-DD HH:mm")}
                    {n.by ? ` — ${n.by}` : ""}
                  </small>
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
