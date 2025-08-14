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

  // Helpers for the print template
  const safe = (s) =>
    (s ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Try to split a multi-line billing address into Name / Address / City, State
  const parseBilling = () => {
    const lines = (billingAddress || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const name = customer || lines[0] || "";
    const address = lines[1] || (lines.length === 1 ? lines[0] : "");
    const cityState = lines[2] || "";
    return { name, address, cityState };
  };

  // Site address: we usually get a single-line street, so put that under ADDRESS
  const parseSite = () => {
    if (!siteLocation) return { name: "", address: "", cityState: "" };
    // Try to split "street, city state" into address + city/state
    const parts = siteLocation.split(",");
    const address = parts[0]?.trim() || siteLocation;
    const cityState = parts.slice(1).join(", ").trim();
    return { name: customer || "", address, cityState };
  };

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

  // -------- PRINT: render a template that matches your "Agreement" form
  const handlePrint = () => {
    const b = parseBilling();
    const s = parseSite();
    const formattedSched = scheduledDate
      ? moment(scheduledDate).format("MM/DD/YYYY")
      : "";
    const printedAt = moment().format("MM/DD/YYYY HH:mm");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Agreement ${safe(poNumber || id)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; }
    .page { width: 100%; }

    /* Header */
    .hdr { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom: 10px; }
    .hdr-left { display:flex; gap:12px; align-items:flex-start; }
    .logo {
      width: 58px; height: 58px;
      background:#000; color:#fff; display:flex; align-items:center; justify-content:center;
      font-weight:bold; font-size:10px; border:1px solid #000;
    }
    .company h1 { margin:0 0 4px 0; font-size:18px; font-weight:700; }
    .company .addr { font-size:11px; line-height:1.3; }
    .agr-box { text-align:right; }
    .agr-box .title { font-size:18px; font-weight:700; text-decoration:underline; }
    .agr-box .no { font-size:12px; margin-top:6px; }
    .agr-box .no .lbl { font-weight:700; }

    /* Big bordered table */
    .frame { width:100%; border:2px solid #000; border-collapse:collapse; }

    .row { display:flex; width:100%; }
    .cell { border-bottom:1px solid #000; border-right:1px solid #000; padding:6px 8px; }
    .cell:last-child { border-right:none; }

    .row.head .cell { font-size:12px; font-weight:700; }
    .row.head .left { width:50%; }
    .row.head .right { width:50%; display:flex; justify-content:space-between; }
    .row.head .right .label { font-weight:700; }
    .row.head .right .date { min-width:160px; text-align:right; }

    .row.fields { font-size:12px; }
    .col { width:50%; }
    .grid { display:grid; grid-template-columns:120px 1fr; }
    .flabel { font-weight:700; border-right:1px solid #000; padding-right:8px; }
    .fvalue { padding-left:8px; }

    .desc-title { border-top:1px solid #000; font-weight:700; text-align:center; padding:4px 0; }
    .desc-box { min-height:380px; padding:10px; }

    /* Footer authorization */
    .auth-title { text-align:center; font-weight:700; margin-top:12px; }
    .auth-text { font-size:11px; text-align:center; margin:6px 14px; }
    .sign-row { display:flex; gap:20px; margin-top:26px; }
    .sign-col { flex:1; }
    .line { border-bottom:1px solid #000; height:22px; }
    .small { font-size:11px; margin-top:4px; }

    .note { font-size:10px; margin-top:16px; border-top:1px solid #000; padding-top:6px; }

    /* Tiny print metadata bottom-right (optional) */
    .meta-print { position: fixed; right: 0.5in; bottom: 0.5in; font-size: 9px; color:#333; }
  </style>
</head>
<body>
  <div class="page">
    <div class="hdr">
      <div class="hdr-left">
        <div class="logo">FCG</div>
        <div class="company">
          <h1>First Class Glass & Mirror, INC.</h1>
          <div class="addr">
            1513 Industrial Dr<br/>
            Itasca, Illinois 60143<br/>
            630-250-9777 &nbsp;&nbsp; FCG@FirstClassGlassMirror.com
          </div>
        </div>
      </div>
      <div class="agr-box">
        <div class="title">Agreement</div>
        <div class="no"><span class="lbl">No.</span> ${safe(poNumber || id)}</div>
      </div>
    </div>

    <div class="frame">
      <!-- Head row -->
      <div class="row head">
        <div class="cell left">AGREEMENT SUBMITTED TO:</div>
        <div class="cell right">
          <span class="label">WORK TO BE PERFORMED AT:</span>
          <span class="date">Date: ${safe(formattedSched)}</span>
        </div>
      </div>

      <!-- Info rows (two columns, same labels) -->
      <div class="row fields">
        <div class="cell col">
          <div class="grid">
            <div class="flabel">NAME:</div>
            <div class="fvalue">${safe(b.name)}</div>
            <div class="flabel">ADDRESS</div>
            <div class="fvalue">${safe(b.address)}</div>
            <div class="flabel">CITY, STATE</div>
            <div class="fvalue">${safe(b.cityState)}</div>
            <div class="flabel">Phone No.</div>
            <div class="fvalue"></div>
            <div class="flabel">Email:</div>
            <div class="fvalue"></div>
          </div>
        </div>
        <div class="cell col">
          <div class="grid">
            <div class="flabel">NAME:</div>
            <div class="fvalue">${safe(s.name)}</div>
            <div class="flabel">ADDRESS</div>
            <div class="fvalue">${safe(s.address)}</div>
            <div class="flabel">CITY, STATE</div>
            <div class="fvalue">${safe(s.cityState)}</div>
            <div class="flabel">Phone No.</div>
            <div class="fvalue"></div>
            <div class="flabel">Email:</div>
            <div class="fvalue"></div>
          </div>
        </div>
      </div>

      <!-- Description title -->
      <div class="row">
        <div class="cell desc-title" style="width:100%;">Description</div>
      </div>

      <!-- Description big box -->
      <div class="row">
        <div class="cell desc-box" style="width:100%;">
          ${safe(problemDescription)}
        </div>
      </div>
    </div>

    <div class="auth-title">AUTHORIZATION TO PAY</div>
    <div class="auth-text">
      I ACKNOWLEDGE RECEIPT OF GOODS AND SERVICES REQUESTED AND THAT ALL SERVICES WERE PERFORMED
      IN A PROFESSIONAL MANNER TO MY COMPLETE SATISFACTION. I UNDERSTAND THAT I AM PERSONALLY RESPONSIBLE
      FOR PAYMENT.
    </div>

    <div class="sign-row">
      <div class="sign-col">
        <div class="line"></div>
        <div class="small">Customer Signature:</div>
      </div>
      <div class="sign-col">
        <div class="line"></div>
        <div class="small">Date:</div>
      </div>
    </div>

    <div class="note">
      NOTE: A $25 SERVICE CHARGE WILL BE ASSESSED FOR ANY CHECKS RETURNED.
      PAST DUE ACCOUNTS ARE SUBJECT TO 5% PER MONTH FINANCE CHARGE.
    </div>

    <div class="meta-print">Printed: ${safe(printedAt)}</div>
  </div>

  <script>
    window.onload = function () {
      setTimeout(function () { window.print(); window.close(); }, 150);
    };
  </script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=900,height=1100");
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
