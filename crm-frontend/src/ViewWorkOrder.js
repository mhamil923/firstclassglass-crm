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

  // Safe file URL (works with S3 + local)
  const pdfUrl = pdfPath
    ? `${API_BASE_URL}/files?key=${encodeURIComponent(pdfPath)}`
    : null;

  // Upload attachments immediately on selection (photo append)
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

  // Add a note
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

  // -------- PRINT: one-page template; Problem Description goes in the small "DESCRIPTION" box
  const handlePrint = () => {
    const formattedDate = scheduledDate
      ? moment(scheduledDate).format("YYYY-MM-DD HH:mm")
      : "Not Scheduled";
    const now = moment().format("YYYY-MM-DD HH:mm");

    // If you placed your logo at frontend /public/fcg-logo.png it will render here
    const logoUrl = "/fcg-logo.png";

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
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
    .wrap { max-width: 8in; margin: 0 auto; }

    /* Header */
    .hdr { display:flex; align-items:center; gap:12px; border-bottom:2px solid #000; padding-bottom:8px; margin-bottom:10px; }
    .logo { width: 140px; height: auto; object-fit: contain; }
    .title { font-size: 22px; font-weight: 800; letter-spacing: 0.4px; }
    .meta { margin-left:auto; text-align:right; font-size:12px; line-height:1.2; }
    .meta b { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    /* Two-column address section */
    .cols { display:flex; gap:10px; margin-top:8px; }
    .col { flex:1; border: 1px solid #000; padding:8px; min-height: 110px; }
    .sect-h { font-weight:800; font-size:12px; border-bottom:1px solid #000; padding-bottom:4px; margin-bottom:6px; }
    .line { margin: 2px 0; }
    .pre { white-space: pre-wrap; margin: 0; }

    /* Description (small box) + big blank area */
    .desc-label { margin-top:10px; font-weight:800; font-size:12px; }
    .desc-box { border:1px solid #000; min-height: 84px; padding:8px; }
    .big-blank { border:1px solid #000; height: 360px; margin-top:10px; }

    /* Footer (optional) */
    .ftr { display:flex; justify-content:space-between; font-size:11px; color:#444; margin-top:8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <img src="${safe(logoUrl)}" class="logo" onerror="this.style.display='none'"/>
      <div class="title">WORK ORDER</div>
      <div class="meta">
        WO/PO: <b>${safe(poNumber || id)}</b><br/>
        Printed: ${safe(now)}
      </div>
    </div>

    <div class="cols">
      <div class="col">
        <div class="sect-h">AGREEMENT SUBMITTED TO</div>
        <div class="line"><strong>${safe(customer) || "&nbsp;"}</strong></div>
        <div class="line"><pre class="pre">${safe(billingAddress)}</pre></div>
      </div>
      <div class="col">
        <div class="sect-h">WORK TO BE PERFORMED AT</div>
        <div class="line"><pre class="pre">${safe(siteLocation)}</pre></div>
        <div class="line" style="margin-top:6px;font-size:12px">Scheduled: ${safe(formattedDate)}</div>
      </div>
    </div>

    <div class="desc-label">DESCRIPTION</div>
    <div class="desc-box"><pre class="pre">${safe(problemDescription)}</pre></div>

    <!-- Leave the large box BLANK on purpose -->
    <div class="big-blank"></div>
  </div>

  <script>
    window.onload = function () {
      setTimeout(function(){ window.print(); window.close(); }, 150);
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
        <div className="view-header-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h2 className="view-title" style={{ margin: 0 }}>Work Order Details</h2>
          <div className="view-actions" style={{ display: "flex", gap: 8 }}>
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
            <iframe src={pdfUrl} className="pdf-frame" title="Work Order PDF" />
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
