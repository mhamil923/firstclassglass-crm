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

/* ---------- robust PDF check ---------- */
const isPdfFile = (file) =>
  file &&
  (file.type === "application/pdf" ||
    /\.pdf$/i.test(file.name || "") ||
    file.type === "" || // some browsers
    file.type === "application/octet-stream");

/* ---------- Small helpers ---------- */
const isPdfKey = (key) => /\.pdf(\?|$)/i.test(key);
const urlFor = (relPath) =>
  `${API_BASE_URL}/files?key=${encodeURIComponent(relPath)}`;
const pdfThumbUrl = (relPath) => `${urlFor(relPath)}#page=1&view=FitH`;

/* ---------- Inline PO# Editor ---------- */
function PONumberEditor({ orderId, initialPo, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [po, setPo] = useState(initialPo || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPo(initialPo || "");
  }, [initialPo]);

  const save = async () => {
    setSaving(true);
    try {
      const next = po.trim() || null; // Persist blank as NULL
      // Prefer edit route (present in backend)
      const form = new FormData();
      if (next === null) form.append("poNumber", "");
      else form.append("poNumber", next);
      await api.put(`/work-orders/${orderId}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div>{initialPo ? initialPo : <em>None</em>}</div>
        <button className="btn btn-primary" onClick={() => setEditing(true)}>
          {initialPo ? "Update PO #" : "Add PO #"}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <input
        type="text"
        value={po}
        onChange={(e) => setPo(e.target.value)}
        className="form-input"
        placeholder="Enter PO # (optional)"
        style={{
          height: 36,
          borderRadius: 8,
          border: "1px solid #cbd5e1",
          padding: "0 10px",
        }}
      />
      <button className="btn btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button
        className="btn btn-ghost"
        disabled={saving}
        onClick={() => setEditing(false)}
      >
        Cancel
      </button>
    </div>
  );
}

/* ---------- Lightbox modal for enlarged previews ---------- */
function Lightbox({ open, onClose, kind, src, title }) {
  const [downloading, setDownloading] = useState(false);
  if (!open) return null;

  const inferredName =
    (title && /\.[a-z0-9]{2,5}$/i.test(title) && title) ||
    (src?.split("/").pop() || "").split("?")[0] ||
    "download.jpg";

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(src, { mode: "cors", credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = inferredName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error("Download failed; opening in new tab as fallback", err);
      window.open(src, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          maxWidth: "95vw",
          maxHeight: "92vh",
          width: "auto",
          height: "auto",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <strong
            style={{
              fontSize: 14,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title || "Preview"}
          </strong>
          <div style={{ display: "flex", gap: 8 }}>
            {kind === "image" && (
              <button
                className="btn btn-light"
                onClick={handleDownload}
                disabled={downloading}
              >
                {downloading ? "Preparing…" : "Download"}
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              Close
            </button>
          </div>
        </div>

        {kind === "image" ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#f8fafc",
              padding: 8,
            }}
          >
            <img
              src={src}
              alt={title || "preview"}
              style={{
                maxWidth: "92vw",
                maxHeight: "82vh",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                display: "block",
              }}
            />
          </div>
        ) : (
          <iframe
            title={title || "preview"}
            src={src}
            style={{
              width: "92vw",
              maxWidth: "1200px",
              height: "82vh",
              border: "none",
              background: "#f8fafc",
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- Tile component (image or pdf) ---------- */
function FileTile({ kind, href, fileName, onDelete, onExpand }) {
  const isPdf = kind === "pdf";
  return (
    <div
      className="attachment-item"
      style={{
        width: 160,
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid #e5e7eb",
        background: "#fff",
        position: "relative",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ width: "100%", height: 200, background: "#f8fafc" }}>
        {isPdf ? (
          <iframe
            title={fileName}
            src={href}
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        ) : (
          <img
            src={href}
            alt={fileName}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
      </div>

      <div style={{ padding: "6px 8px", fontSize: 12, wordBreak: "break-all" }}>
        <a
          href={href}
          target="__blank"
          rel="noopener noreferrer"
          title={fileName}
          className="link"
          style={{ textDecoration: "none" }}
        >
          {fileName}
        </a>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 8px 8px 8px" }}>
        <button className="btn btn-light" onClick={onExpand} style={{ flex: 1 }}>
          Expand
        </button>
        {onDelete && (
          <button
            className="btn btn-danger"
            onClick={onDelete}
            title="Delete"
            style={{ flex: "0 0 auto" }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes parsing/formatting (supports JSON-array or server TEXT log format)    */
/* -------------------------------------------------------------------------- */
function parseNotesArrayOrText(raw) {
  if (!raw) return { entries: [], originalOrder: [] };

  // JSON array?
  if (Array.isArray(raw)) {
    const entries = raw.map((n, i) => ({
      text: String(n?.text ?? "").trim(),
      createdAt: n?.createdAt || n?.time || null,
      by: n?.by || n?.author || n?.user || null,
      __order: i,
    }));
    return { entries, originalOrder: entries.map((e) => e.__order) };
  }

  // JSON string of array?
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const entries = arr.map((n, i) => ({
          text: String(n?.text ?? "").trim(),
          createdAt: n?.createdAt || n?.time || null,
          by: n?.by || n?.author || n?.user || null,
          __order: i,
        }));
        return { entries, originalOrder: entries.map((e) => e.__order) };
      }
    } catch {
      // fall through to TEXT parsing
    }
  }

  // Plain TEXT: blocks like
  // [2025-11-05 19:06:12.555] Mark: test note
  // (blank line between entries)
  const s = String(raw);
  const lines = s.split(/\r?\n/);

  const entries = [];
  let current = null;

  const startRe = /^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const m = line.match(startRe);
    if (m) {
      // push previous block if any
      if (current) entries.push({ ...current });
      current = {
        createdAt: m[1],
        by: m[2].trim(),
        text: m[3] ? m[3] : "",
        __order: entries.length, // original append order
      };
      continue;
    }

    // blank line => finalize current
    if (/^\s*$/.test(line)) {
      if (current) {
        entries.push({ ...current });
        current = null;
      }
      continue;
    }

    // continuation line for text
    if (current) {
      current.text = (current.text ? current.text + "\n" : "") + line;
    }
  }
  if (current) entries.push({ ...current });

  return { entries, originalOrder: entries.map((e) => e.__order) };
}

function formatNotesText(entriesInOrder) {
  // Render back to server's plain-text format
  return entriesInOrder
    .map((n) => {
      const ts = n.createdAt || moment().format("YYYY-MM-DD HH:mm:ss.SSS");
      const by = n.by || "system";
      const txt = (n.text || "").toString();
      const firstLine = `[${ts}] ${by}: `;
      // Keep multi-line body under it
      const body = txt.includes("\n") ? txt : txt; // already string
      return firstLine + body;
    })
    .join("\n\n");
}

/* -------------------------------------------------------------------------- */

export default function ViewWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);
  const [newNote, setNewNote] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  // Main Signed PDF UI state
  const [busyReplace, setBusyReplace] = useState(false);
  const [keepOldInAttachments, setKeepOldInAttachments] = useState(true);

  // Upload states for Estimate & PO
  const [busyPoUpload, setBusyPoUpload] = useState(false);
  const [busyEstimateUpload, setBusyEstimateUpload] = useState(false);

  // Status state
  const [statusSaving, setStatusSaving] = useState(false);
  const [localStatus, setLocalStatus] = useState("");

  // Lightbox state
  const [lightbox, setLightbox] = useState({
    open: false,
    kind: "pdf",
    src: "",
    title: "",
  });
  const openLightbox = (kind, src, title) =>
    setLightbox({ open: true, kind, src, title });
  const closeLightbox = () => setLightbox((l) => ({ ...l, open: false }));

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
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- Parse notes from server ---------- */
  const { entries: parsedNotes, originalOrder } = useMemo(() => {
    const raw = workOrder?.notes ?? null;
    return parseNotesArrayOrText(raw);
  }, [workOrder]);

  // Show newest first (createdAt desc; unknown timestamps go to bottom)
  const displayNotes = useMemo(() => {
    const withSortKey = parsedNotes.map((n, i) => ({
      ...n,
      __idx: i,
      __t: n.createdAt ? Date.parse(n.createdAt) || 0 : 0,
    }));
    return withSortKey.sort((a, b) => b.__t - a.__t);
  }, [parsedNotes]);

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
    estimatePdfPath,
    poPdfPath,
    id: woId,
  } = workOrder;

  const cleanedPo = displayPO(workOrderNumber, poNumber);

  // Canonical file URLs
  const signedHref = pdfPath ? pdfThumbUrl(pdfPath) : null;
  const estimateHref = estimatePdfPath ? pdfThumbUrl(estimatePdfPath) : null;
  const poHref = poPdfPath ? pdfThumbUrl(poPdfPath) : null;

  const attachments = (photoPath || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const otherPdfAttachments = attachments
    .filter(isPdfKey)
    .filter((p) => p !== pdfPath && p !== estimatePdfPath && p !== poPdfPath);

  const attachmentImages = attachments.filter((p) => !isPdfKey(p));

  // ---------- PRINT helpers ----------
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

    <div class="desc-title">Problem Description: ${safe(
      problemDescription || ""
    )}</div>
    <div class="desc-box"></div>

    <div class="auth-title">AUTHORIZATION TO PAY</div>
    <div class="auth-note">
      I ACKNOWLEDGE RECEIPT OF GOODS AND SERVICES REQUESTED AND THAT ALL
      SERVICES WERE PERFORMED IN A PROFESSIONAL MANNER TO MY COMPLETE
      SATISFACTION. I UNDERSTAND THAT I AM PERSONALLY RESPONSIBLE FOR PAYMENT.
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
      NOTE: A $25 SERVICE CHARGE WILL BE ASSESSED FOR ANY CHECKS RETURNED. PAST
      DUE ACCOUNTS ARE SUBJECT TO 5% PER MONTH FINANCE CHARGE.
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

  /* ---------- Upload helpers ---------- */

  const handleReplacePdfUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isPdfFile(file)) {
      alert("Please choose a PDF file.");
      e.target.value = "";
      return;
    }
    setBusyReplace(true);
    try {
      const form = new FormData();
      form.append("pdf", file); // primary work-order PDF field
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

  const handleUploadOrReplaceEstimatePdf = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isPdfFile(file)) {
      alert("Please choose a PDF file.");
      e.target.value = "";
      return;
    }
    setBusyEstimateUpload(true);
    try {
      const form = new FormData();
      form.append("estimatePdf", file);
      // Reuse /edit (backend handles estimatePdfPath when field is "estimatePdf")
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading/replacing Estimate PDF:", error);
      alert(error?.response?.data?.error || "Failed to upload Estimate PDF.");
    } finally {
      setBusyEstimateUpload(false);
      e.target.value = "";
    }
  };

  const handleUploadOrReplacePoPdf = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isPdfFile(file)) {
      alert("Please choose a PDF file.");
      e.target.value = "";
      return;
    }
    setBusyPoUpload(true);
    try {
      const form = new FormData();
      form.append("poPdf", file);
      // Reuse /edit (backend handles poPdfPath when field is "poPdf")
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading/replacing PO PDF:", error);
      alert(error?.response?.data?.error || "Failed to upload PO PDF.");
    } finally {
      setBusyPoUpload(false);
      e.target.value = "";
    }
  };

  const handleDeleteAttachment = async (relPath) => {
    if (!window.confirm("Delete this attachment?")) return;
    try {
      // Using /edit with a JSON body is not supported; your backend doesn't expose a delete-attachment route yet.
      // Optionally implement a dedicated DELETE route in backend. For now, just warn.
      alert("Deleting attachments requires a backend route. Not implemented.");
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
        await api.put(`/work-orders/${id}/edit`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error updating status:", error);
      alert("Failed to update status.");
    } finally {
      setStatusSaving(false);
    }
  };

  /* ---------- Notes (FIXED to match backend) ---------- */
  const handleAddNote = async () => {
    const text = newNote.trim();
    if (!text) return;

    try {
      // Backend expects: PUT /work-orders/:id/notes  with { notes: <string>, append: true }
      await api.put(`/work-orders/${id}/notes`, {
        notes: text,
        append: true,
      });
      setNewNote("");
      setShowNoteInput(false);
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error adding note:", error);
      alert(error?.response?.data?.error || "Failed to add note.");
    }
  };

  const handleDeleteNote = async (displayIdx) => {
    // There is no DELETE endpoint; rebuild notes without this entry and PUT the full text.
    if (!window.confirm("Delete this note?")) return;

    try {
      // Convert parsed list back to original append order (oldest -> newest)
      const byOriginal = [...parsedNotes].sort((a, b) => (a.__order ?? 0) - (b.__order ?? 0));

      // Map displayIdx (newest-first list) back to the actual entry
      const target = displayNotes[displayIdx];
      if (!target) return;

      // Remove the target from the ordered list
      const kept = byOriginal.filter((e) => !(e.createdAt === target.createdAt && e.text === target.text && (e.by || "") === (target.by || "")));

      // Format back to server TEXT
      const newBody = formatNotesText(kept);

      await api.put(`/work-orders/${id}/notes`, {
        notes: newBody,
        append: false, // overwrite with rebuilt body
      });

      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error deleting note:", error);
      alert(error?.response?.data?.error || "Failed to delete note.");
    }
  };

  return (
    <div className="view-container">
      {/* Lightbox for expanded previews */}
      <Lightbox
        open={lightbox.open}
        onClose={closeLightbox}
        kind={lightbox.kind}
        src={lightbox.src}
        title={lightbox.title}
      />

      <div className="view-card">
        <div className="view-header-row">
          <h2 className="view-title">Work Order Details</h2>
          <div className="view-actions">
            <button className="btn btn-outline" onClick={handlePrint}>
              🖨️ Print Work Order
            </button>
            <button
              className="back-btn"
              onClick={() => navigate("/work-orders")}
            >
              ← Back to List
            </button>
          </div>
        </div>

        {/* BASIC INFO */}
        <ul className="detail-list">
          <li className="detail-item">
            <span className="detail-label">Work Order #:</span>
            <span className="detail-value">{displayWO(workOrderNumber)}</span>
          </li>

          <li className="detail-item">
            <span className="detail-label">PO #:</span>
            <span className="detail-value">
              <PONumberEditor
                orderId={woId}
                initialPo={cleanedPo}
                onSaved={(newPo) =>
                  setWorkOrder((prev) => ({
                    ...prev,
                    poNumber: newPo || null,
                  }))
                }
              />
            </span>
          </li>

          <li className="detail-item">
            <span className="detail-label">Status:</span>
            <span className="detail-value">
              <select
                value={localStatus}
                onChange={handleStatusChange}
                disabled={statusSaving}
                style={{ padding: 6 }}
              >
                <option value="" disabled>
                  Select status…
                </option>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              {statusSaving && (
                <small style={{ marginLeft: 8 }}>Saving…</small>
              )}
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
            <span className="detail-value pre-wrap">
              {siteAddress || "—"}
            </span>
          </li>

          <li className="detail-item">
            <span className="detail-label">Billing Address:</span>
            <span className="detail-value pre-wrap">
              {billingAddress || "—"}
            </span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Problem Description:</span>
            <span className="detail-value pre-wrap">
              {problemDescription || "—"}
            </span>
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

        {/* Signed Work Order PDF (tile preview) */}
        <div className="section-card">
          <h3 className="section-header">Sign-Off Sheet PDF</h3>

          {signedHref ? (
            <div
              className="attachments"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              <FileTile
                kind="pdf"
                href={signedHref}
                fileName={(pdfPath || "").split("/").pop() || "signed.pdf"}
                onExpand={() => openLightbox("pdf", signedHref, "Signed PDF")}
              />
            </div>
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

          {signedHref && (
            <div
              className="mt-2"
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <a
                className="btn btn-light"
                href={signedHref}
                target="_blank"
                rel="noreferrer"
              >
                Open in new tab
              </a>
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
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <input
                  type="checkbox"
                  checked={keepOldInAttachments}
                  onChange={(e) => setKeepOldInAttachments(e.target.checked)}
                />
                Move existing signed PDF to attachments
              </label>
            </div>
          )}
        </div>

        {/* ESTIMATE PDF (tile preview) */}
        <div className="section-card">
          <h3 className="section-header">Estimate PDF</h3>

          {estimateHref ? (
            <div
              className="attachments"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              <FileTile
                kind="pdf"
                href={estimateHref}
                fileName={
                  (estimatePdfPath || "").split("/").pop() || "estimate.pdf"
                }
                onExpand={() =>
                  openLightbox("pdf", estimateHref, "Estimate PDF")
                }
              />
            </div>
          ) : (
            <p className="empty-text">No estimate PDF attached.</p>
          )}

          <div
            className="attachment-upload"
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <label className="btn">
              {busyEstimateUpload
                ? "Uploading…"
                : estimateHref
                ? "Replace Estimate PDF"
                : "Upload Estimate PDF"}
              <input
                type="file"
                accept="application/pdf"
                onChange={handleUploadOrReplaceEstimatePdf}
                style={{ display: "none" }}
                disabled={busyEstimateUpload}
              />
            </label>
          </div>
        </div>

        {/* PO PDF (tile preview) */}
        <div className="section-card">
          <h3 className="section-header">PO Order PDF</h3>

          {poHref ? (
            <div
              className="attachments"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              <FileTile
                kind="pdf"
                href={poHref}
                fileName={(poPdfPath || "").split("/").pop() || "po.pdf"}
                onExpand={() => openLightbox("pdf", poHref, "PO PDF")}
              />
            </div>
          ) : (
            <p className="empty-text">No PO PDF attached.</p>
          )}

          <div
            className="attachment-upload"
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <label className="btn">
              {busyPoUpload
                ? "Uploading…"
                : poHref
                ? "Replace PO PDF"
                : "Upload PO PDF"}
              <input
                type="file"
                accept="application/pdf"
                onChange={handleUploadOrReplacePoPdf}
                style={{ display: "none" }}
                disabled={busyPoUpload}
              />
            </label>
          </div>
        </div>

        {/* Other PDF Attachments (non-canonical) */}
        <div className="section-card">
          <h3 className="section-header">Other PDF Attachments</h3>

          {otherPdfAttachments.length ? (
            <div
              className="attachments"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              {otherPdfAttachments.map((relPath, i) => {
                const href = pdfThumbUrl(relPath);
                const fileName =
                  relPath.split("/").pop() || `attachment-${i + 1}.pdf`;
                return (
                  <FileTile
                    key={`${relPath}-${i}`}
                    kind="pdf"
                    href={href}
                    fileName={fileName}
                    onExpand={() => openLightbox("pdf", href, fileName)}
                    onDelete={() => handleDeleteAttachment(relPath)}
                  />
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No other PDFs attached.</p>
          )}
        </div>

        {/* Image Attachments (non-PDF) */}
        <div className="section-card">
          <h3 className="section-header">Image Attachments</h3>

          {attachmentImages.length ? (
            <div
              className="attachments"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              {attachmentImages.map((relPath, i) => {
                const href = urlFor(relPath);
                const fileName =
                  relPath.split("/").pop() || `image-${i + 1}.jpg`;
                return (
                  <FileTile
                    key={`${relPath}-${i}`}
                    kind="image"
                    href={href}
                    fileName={fileName}
                    onExpand={() => openLightbox("image", href, fileName)}
                    onDelete={() => handleDeleteAttachment(relPath)}
                  />
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

          {displayNotes.length > 0 ? (
            <ul className="notes-list">
              {displayNotes.map((n, idx) => (
                <li key={`${n.createdAt || "na"}-${idx}`} className="note-item">
                  <div className="note-header">
                    <small className="note-timestamp">
                      {n.createdAt
                        ? moment(n.createdAt).format("YYYY-MM-DD HH:mm")
                        : "—"}
                      {n.by ? ` — ${n.by}` : ""}
                    </small>
                    <button
                      type="button"
                      className="note-delete-btn"
                      title="Delete note"
                      onClick={() => handleDeleteNote(idx)}
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
