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

  // Upload attachments immediately on selection
  const handleAttachmentChange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

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

  // Existing attachments
  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);

  // -------- PRINT (kept same layout — only filled the small DESCRIPTION box) ----
  const handlePrint = () => {
    const formattedDate = scheduledDate
      ? moment(scheduledDate).format("YYYY-MM-DD HH:mm")
      : "Not Scheduled";

    const now = moment().format("YYYY-MM-DD HH:mm");
    const origin = window.location.origin;

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
    @page { size: A4; margin: 0.5in; }
    html, body { height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
    .sheet { max-width: 8in; margin: 0 auto; }

    /* HEADER */
    .hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
    .hdr-left { display:flex; align-items:center; gap:12px; }
    .logo { width:72px; height:72px; object-fit:contain; border:1px solid #ddd; border-radius:6px; padding:6px; }
    .logo-fallback { width:72px; height:72px; border:1px solid #ddd; border-radius:6px; display:none; align-items:center; justify-content:center; font-weight:700; font-size:20px; }
    .brand { font-size:22px; font-weight:800; letter-spacing:0.4px; }
    .meta { text-align:right; font-size:12px; color:#444; }
    .meta .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }

    /* TWO MAIN ADDRESS BOXES */
    .two-col { display:flex; gap:12px; margin-bottom:12px; }
    .box { flex:1; border:1px solid #111; border-radius:6px; padding:8px 10px; }
    .box-title { font-size:12px; font-weight:700; letter-spacing:0.4px; margin-bottom:6px; }
    .line { min-height:18px; border-bottom:1px solid #bbb; margin-bottom:8px; padding-bottom:2px; white-space:pre-wrap; }
    .lab { font-size:11px; color:#444; margin-top:-6px; margin-bottom:6px; }

    /* WO META (PO, STATUS, DATE) */
    .meta-grid { width:100%; border-collapse:separate; border-spacing:0; margin-bottom:10px; }
    .meta-grid th, .meta-grid td { border:1px solid #111; padding:6px 8px; }
    .meta-grid th { width:28%; text-align:left; background:#f2f2f2; font-weight:700; }

    /* SMALL DESCRIPTION BOX (FILLED) */
    .desc-wrap { margin-top:6px; margin-bottom:8px; }
    .desc-label { font-size:12px; font-weight:700; margin-bottom:4px; }
    .desc-box { border:1px solid #111; border-radius:6px; min-height:40px; padding:6px 8px; }
    .desc-text { white-space:pre-wrap; }

    /* BIG BLANK BOX (LEAVE EMPTY) */
    .big-label { font-size:12px; font-weight:700; margin-top:10px; margin-bottom:4px; }
    .big-box { border:1px solid #111; border-radius:6px; height:320px; } /* keep single-page */
    
    /* FOOTER */
    .footer { display:flex; justify-content:space-between; margin-top:10px; font-size:12px; color:#555; }
  </style>
</head>
<body>
  <div class="sheet">

    <div class="hdr">
      <div class="hdr-left">
        <img class="logo" src="${origin}/fcg-logo.png" alt="FCG Logo" onerror="this.style.display='none';document.getElementById('logo-fallback').style.display='flex'">
        <div id="logo-fallback" class="logo-fallback">FCG</div>
        <div class="brand">FIRST CLASS GLASS</div>
      </div>
      <div class="meta">
        Printed: <span class="mono">${safe(now)}</span><br/>
        WO/PO: <span class="mono">${safe(poNumber || id)}</span>
      </div>
    </div>

    <div class="two-col">
      <div class="box">
        <div class="box-title">AGREEMENT SUBMITTED TO</div>
        <div class="line">${safe(customer)}</div>
        <div class="lab">Name</div>
        <div class="line"><pre style="margin:0;white-space:pre-wrap">${safe(billingAddress)}</pre></div>
        <div class="lab">Billing Address</div>
      </div>
      <div class="box">
        <div class="box-title">WORK TO BE PERFORMED AT</div>
        <div class="line">${safe(siteLocation)}</div>
        <div class="lab">Site Location</div>
      </div>
    </div>

    <table class="meta-grid">
      <tr><th>Status</th><td>${safe(status)}</td></tr>
      <tr><th>Scheduled Date</th><td class="mono">${safe(formattedDate)}</td></tr>
    </table>

    <!-- SMALL DESCRIPTION BOX: now filled with Problem Description -->
    <div class="desc-wrap">
      <div class="desc-label">DESCRIPTION</div>
      <div class="desc-box"><div class="desc-text">${safe(problemDescription || "")}</div></div>
    </div>

    <!-- BIG BLANK AREA: intentionally empty -->
    <div class="big-label">WORK AREA / NOTES</div>
    <div class="big-box"></div>

    <div class="footer">
      <div>Thank you for your business.</div>
      <div>Page 1 of 1</div>
    </div>
  </div>

  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); window.close(); }, 150);
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

  // Add note
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

  return (
    <div className="view-container">
      <div className="view-card">
        <div className="view-header-row" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px'}}>
          <h2 className="view-title" style={{margin: 0}}>Work Order Details</h2>
          <div className="view-actions" style={{display: 'flex', gap: '8px'}}>
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
