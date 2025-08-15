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

  // Notes array
  let notesArray = [];
  if (notes) {
    try {
      notesArray = typeof notes === "string" ? JSON.parse(notes) : notes;
    } catch {
      notesArray = [];
    }
  }

  // File URLs (S3/local safe)
  const pdfUrl = pdfPath ? `${API_BASE_URL}/files?key=${encodeURIComponent(pdfPath)}` : null;
  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // ---------- PRINT helpers ----------
  const LOGO_URL = `${window.location.origin}/fcg-logo.png`; // place file at /public/fcg-logo.png

  // Parse a "name + address" out of siteLocation
  function parseSite(loc) {
    const result = { name: customer || "", address: "" };
    if (!loc) return result;

    const s = String(loc).trim();

    if (s.includes(" - ")) {
      const [namePart, ...rest] = s.split(" - ");
      result.name = namePart.trim() || result.name;
      result.address = rest.join(" - ").trim();
      return result;
    }

    const parts = s.split(",").map((x) => x.trim());
    if (parts.length >= 2 && !/\d/.test(parts[0]) && /\d/.test(parts[1])) {
      result.name = parts[0] || result.name;
      result.address = parts.slice(1).join(", ");
      return result;
    }

    result.address = s;
    return result;
  }

  const site = parseSite(siteLocation);

  const safe = (x) =>
    (x ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const handlePrint = () => {
    // Single-page Letter, no right-side Date column
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Agreement ${safe(poNumber || id)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    html, body { height: auto; }
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

    /* Two main blocks only: Agreement Submitted To (left) and Work To Be Performed At (right) */
    .two-col { width: 100%; border-collapse: collapse; }
    .two-col th, .two-col td { border: 1px solid #000; font-size: 11px; padding: 6px 8px; vertical-align: middle; }
    .two-col th { background: #fff; font-weight: 700; text-transform: uppercase; }
    .two-col .label { width: 18%; }

    .desc-title { border: 1px solid #000; border-bottom: none; padding: 6px 8px; font-size: 11px; font-weight: 700; text-align: center; }
    /* Height tuned so the whole thing fits one Letter page with 0.5in margins */
    .desc-box { border: 1px solid #000; height: 5.5in; padding: 10px; white-space: pre-wrap; font-size: 12px; overflow: hidden; }

    .auth-title { text-align: center; font-size: 12px; font-weight: 700; margin-top: 8px; }
    .auth-note { font-size: 9px; text-align: center; margin-top: 6px; }
    .sign-row { display: grid; grid-template-columns: 1fr 160px; gap: 20px; margin-top: 12px; align-items: end; }
    .sign-line { border-bottom: 1px solid #000; height: 18px; }
    .sign-label { font-size: 10px; margin-top: 2px; }
    .fine { font-size: 8px; color: #000; margin-top: 8px; text-align: left; }
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
        <div class="no">No. ${safe(poNumber || id)}</div>
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
        <td>${safe(${JSON.stringify(parseSite(siteLocation).name || customer || "")})}</td>
      </tr>

      <tr>
        <th class="label">Address</th>
        <td><pre style="margin:0;white-space:pre-wrap">${safe(billingAddress || "")}</pre></td>
        <th class="label">Address</th>
        <td><pre style="margin:0;white-space:pre-wrap">${safe(${JSON.stringify(parseSite(siteLocation).address || "")})}</pre></td>
      </tr>
    </table>

    <div class="desc-title">Description</div>
    <div class="desc-box">${safe(problemDescription || "")}</div>

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
    if (!w) {
      alert("Popup blocked. Please allow popups to print.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  // ---------- notes & attachments ----------
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

  const handleAttachmentChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
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

        <ul className="detail-list">
          <li className="detail-item"><span className="detail-label">WO/PO #:</span><span className="detail-value">{poNumber || id || "—"}</span></li>
          <li className="detail-item"><span className="detail-label">Customer:</span><span className="detail-value">{customer}</span></li>
          <li className="detail-item"><span className="detail-label">Site Location:</span><span className="detail-value">{siteLocation}</span></li>
          <li className="detail-item"><span className="detail-label">Billing Address:</span><span className="detail-value pre-wrap">{billingAddress}</span></li>
          <li className="detail-item"><span className="detail-label">Problem Description:</span><span className="detail-value pre-wrap">{problemDescription}</span></li>
          <li className="detail-item"><span className="detail-label">Status:</span><span className="detail-value">{status}</span></li>
          <li className="detail-item">
            <span className="detail-label">Scheduled Date:</span>
            <span className="detail-value">
              {scheduledDate ? moment(scheduledDate).format("YYYY-MM-DD HH:mm") : "Not Scheduled"}
            </span>
          </li>
        </ul>

        {pdfUrl && (
          <div className="view-card section-card">
            <h3 className="section-header">Work Order PDF</h3>
            <iframe src={pdfUrl} className="pdf-frame" title="Work Order PDF" />
            <div className="mt-2">
              <a className="btn btn-light" href={pdfUrl} target="_blank" rel="noreferrer">Open PDF in new tab</a>
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
