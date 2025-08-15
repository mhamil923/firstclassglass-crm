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

  // Upload attachments immediately on selection (append photos)
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

  // -------- PRINT: single-page template; description box contains problem description
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
        .replace(/>/g, "&gt;")
        .replace(/\r?\n/g, "<br/>");

    const logoUrl = `${window.location.origin}/fcg-logo.png`; // put your logo at /public/fcg-logo.png

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Work Order #${safe(poNumber || id)}</title>
  <style>
    @page { size: A4; margin: 0.5in; }
    html, body { height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
    .wrap { max-width: 800px; margin: 0 auto; }
    .header { display:flex; align-items:center; justify-content: space-between; }
    .brand { display:flex; align-items:center; gap: 12px; }
    .brand img { height: 42px; width:auto; }
    .brand-title { font-size: 18px; font-weight: 700; letter-spacing: .3px; }
    .meta { text-align:right; font-size: 12px; color:#444; }
    .title { margin: 10px 0 14px; font-size: 20px; font-weight: 700; letter-spacing:.2px; }

    .row { display:flex; gap: 14px; }
    .col { flex: 1; }
    .box { border: 1px solid #cfd6e0; border-radius: 6px; padding: 10px 12px; }
    .box h3 { margin: 0 0 6px; font-size: 13px; color:#333; text-transform: uppercase; letter-spacing:.5px; }
    .kv { margin: 0 0 3px; font-size: 13px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }

    .grid { width:100%; border-collapse: separate; border-spacing:0; margin-top:12px; }
    .grid th { width: 190px; text-align:left; vertical-align: top; color:#333; padding: 8px 10px; border:1px solid #cfd6e0; background:#f5f7fb; font-size: 13px; }
    .grid td { padding: 8px 10px; border:1px solid #cfd6e0; font-size: 13px; }

    .desc { margin-top: 12px; }
    .desc h3 { margin: 0 0 6px; font-size: 13px; color:#333; text-transform: uppercase; letter-spacing:.5px; }
    .desc-box { border: 1px solid #cfd6e0; border-radius: 6px; padding: 12px; min-height: 160px; /* description lives inside this box */ }
    .desc-box p { margin: 0; line-height: 1.45; }

    .sign-row { display:flex; gap: 20px; margin-top: 16px; }
    .sign { flex:1; }
    .sign .line { height: 26px; border-bottom:1px solid #999; margin-bottom: 6px; }
    .sign .label { font-size: 12px; color:#555; }

    .footer { display:flex; justify-content: space-between; margin-top: 10px; font-size: 12px; color:#666; }

    /* keep it to one page */
    .wrap { page-break-inside: avoid; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="brand">
        <img src="${logoUrl}" alt="Logo"/>
        <div class="brand-title">First Class Glass — Work Order</div>
      </div>
      <div class="meta">
        Printed: <span class="mono">${safe(now)}</span><br/>
        WO/PO: <span class="mono">${safe(poNumber || id)}</span>
      </div>
    </div>

    <div class="title">Work Order Details</div>

    <table class="grid">
      <tr><th>WO/PO #</th><td class="mono">${safe(poNumber || id)}</td></tr>
      <tr><th>Status</th><td>${safe(status)}</td></tr>
      <tr><th>Scheduled Date</th><td class="mono">${safe(formattedDate)}</td></tr>
    </table>

    <div class="row" style="margin-top:12px">
      <div class="col">
        <div class="box">
          <h3>Agreement Submitted To</h3>
          <div class="kv"><strong>Name:</strong> ${safe(customer)}</div>
          <div class="kv"><strong>Billing Address:</strong><br/><span class="mono">${safe(billingAddress)}</span></div>
        </div>
      </div>
      <div class="col">
        <div class="box">
          <h3>Work To Be Performed At</h3>
          <div class="kv"><strong>Location:</strong> ${safe(siteLocation)}</div>
        </div>
      </div>
    </div>

    <div class="desc">
      <h3>Description</h3>
      <div class="desc-box">
        <p>${safe(problemDescription)}</p>
      </div>
    </div>

    <div class="sign-row">
      <div class="sign">
        <div class="line"></div>
        <div class="label">Technician Signature</div>
      </div>
      <div class="sign">
        <div class="line"></div>
        <div class="label">Customer Signature</div>
      </div>
    </div>

    <div class="footer">
      <div>Thank you for your business.</div>
      <div>Page 1 of 1</div>
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
