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

  // Existing attachments (image keys joined by comma)
  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);

  // -------- PRINT: keep same template, but put Problem Description in the small DESCRIPTION box
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

    // Try to split a “name” vs “address” if the Site Location includes both
    function parseSite(loc) {
      const s = (loc || "").trim();
      if (!s) return { name: "", address: "" };
      // split on dash / en-dash / em-dash / colon if present
      const m = s.match(/(.+?)\s*[-–—:]\s*(.+)/);
      if (m) return { name: m[1].trim(), address: m[2].trim() };
      // split on first comma if there are digits (street number) after it
      const i = s.indexOf(",");
      if (i > 0 && /\d/.test(s.slice(i + 1))) {
        return { name: s.slice(0, i).trim(), address: s.slice(i + 1).trim() };
      }
      // if it starts with a number, assume only address
      if (/^\d/.test(s)) return { name: "", address: s };
      // otherwise treat all as name
      return { name: s, address: "" };
    }

    const site = parseSite(siteLocation);

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Work Order #${safe(poNumber || id)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
    .page { width: 100%; max-width: 8.5in; margin: 0 auto; }
    .header { display:flex; align-items:center; gap: 12px; margin-bottom: 10px; }
    .logo { width: 120px; height: auto; object-fit: contain; }
    .head-right { flex:1; text-align:right; font-size: 12px; color:#555; }
    .title { font-weight: 800; font-size: 18px; margin: 4px 0; }

    /* Top two boxes */
    .two-col { display:flex; gap: 12px; margin-top: 6px; }
    .box { flex:1; border: 2px solid #000; padding: 10px; min-height: 150px; }
    .box-title { font-weight: 800; font-size: 14px; margin-bottom: 6px; text-transform: uppercase; }
    .row { display:flex; gap:8px; margin-top:6px; align-items:flex-start; }
    .label { width: 80px; font-weight: 600; font-size: 12px; }
    .value { flex:1; font-size: 12px; white-space: pre-wrap; }

    /* Small DESCRIPTION box (Problem Description goes here) */
    .desc-small { margin-top: 12px; border: 2px solid #000; padding: 8px; }
    .desc-title { font-weight: 800; font-size: 13px; margin-bottom: 4px; }
    .desc-body { min-height: 70px; font-size: 12px; white-space: pre-wrap; }

    /* Big blank area box — intentionally empty for handwriting */
    .big-blank { margin-top: 10px; border: 2px solid #000; height: 360px; }

    /* footer signature lines if needed later (kept but not used) */
    .muted { color:#666; font-size: 11px; }

    /* keep everything on one page */
    .page { page-break-inside: avoid; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <img class="logo" src="/fcg-logo.png" alt="FCG Logo" />
      <div class="head-right">
        <div>Printed: ${safe(now)}</div>
        <div>WO/PO: ${safe(poNumber || id)}</div>
        <div>Status: ${safe(status || "")}</div>
        <div>Scheduled: ${safe(formattedDate)}</div>
      </div>
    </div>
    <div class="title">WORK ORDER</div>

    <div class="two-col">
      <div class="box">
        <div class="box-title">Agreement Submitted To:</div>
        <div class="row"><div class="label">Name</div><div class="value">${safe(customer)}</div></div>
        <div class="row"><div class="label">Address</div><div class="value"><pre style="margin:0;white-space:pre-wrap">${safe(billingAddress)}</pre></div></div>
        <div class="row"><div class="label">Phone</div><div class="value">__________________________</div></div>
      </div>
      <div class="box">
        <div class="box-title">Work To Be Performed At:</div>
        <div class="row"><div class="label">Name</div><div class="value">${safe(site.name)}</div></div>
        <div class="row"><div class="label">Address</div><div class="value">${safe(site.address || siteLocation || "")}</div></div>
        <div class="row"><div class="label">Phone</div><div class="value">__________________________</div></div>
      </div>
    </div>

    <!-- Small description box WITH problemDescription -->
    <div class="desc-small">
      <div class="desc-title">DESCRIPTION</div>
      <div class="desc-body">${safe(problemDescription)}</div>
    </div>

    <!-- Big blank box (left empty on purpose) -->
    <div class="big-blank"></div>
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

  return (
    <div className="view-container">
      <div className="view-card">
        <div className="view-header-row" style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:"12px"}}>
          <h2 className="view-title" style={{margin:0}}>Work Order Details</h2>
          <div className="view-actions" style={{display:"flex", gap:"8px"}}>
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
