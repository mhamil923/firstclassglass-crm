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

// Only show these techs in ViewWorkOrder tech dropdown
const ALLOWED_TECH_USERNAMES = new Set(["Jeff", "jeffsr", "Adin"]);

// Supplier options (keep in sync with PurchaseOrders.js)
const SUPPLIER_OPTIONS = ["Chicago Tempered", "CRL", "Oldcastle", "Casco", "Other"];

/* ---------- auth header (match WorkOrders.js) ---------- */
const authHeaders = () => {
  const token = localStorage.getItem("jwt");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

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
    file.type === "" ||
    file.type === "application/octet-stream");

/* ---------- Small helpers ---------- */
const isPdfKey = (key) => /\.pdf(\?|$)/i.test(key);
const urlFor = (relPath) => `${API_BASE_URL}/files?key=${encodeURIComponent(relPath)}`;
const pdfThumbUrl = (relPath) => `${urlFor(relPath)}#page=1&view=FitH`;

const fileNameFromKey = (key) => (key || "").split("/").pop() || key || "";
const isImageKey = (key) => !!key && !isPdfKey(key) && /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(key);

// Weak heuristic only (your filenames are random, so this won’t catch everything)
const isLikelyDrawNoteByName = (key) => {
  const name = fileNameFromKey(key).toLowerCase();
  return name.includes("drawing") || name.includes("draw") || name.includes("sketch") || name.includes("note");
};

// Try to infer supplier from PO filename
const inferSupplierFromFilename = (name) => {
  if (!name) return "";
  const n = name.toLowerCase();
  if (n.includes("chicago") && n.includes("temper")) return "Chicago Tempered";
  if (n.includes("crl") || n.includes("c.r. laurence") || n.includes("c r laurence")) return "CRL";
  if (n.includes("oldcastle")) return "Oldcastle";
  if (n.includes("casco")) return "Casco";
  return "";
};

// Try to infer PO number from filename
// e.g. "PO_473_from_First_Class_Glass__Mirror_Inc._11168.pdf" -> "473"
const inferPoNumberFromFilename = (name) => {
  if (!name) return null;
  const base = name.replace(/\.[^/.]+$/, ""); // strip extension
  let m = base.match(/po[_\-\s]*(\d{2,})/i);
  if (m && m[1]) return m[1];
  m = base.match(/(\d{3,})/);
  if (m && m[1]) return m[1];
  return null;
};

// localStorage category override (per work order)
const drawNoteStoreKey = (workOrderId) => `wo:${workOrderId}:drawNoteKeys`;
function loadDrawNoteOverrides(workOrderId) {
  try {
    const raw = localStorage.getItem(drawNoteStoreKey(workOrderId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}
function saveDrawNoteOverrides(workOrderId, set) {
  try {
    localStorage.setItem(drawNoteStoreKey(workOrderId), JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

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
      const next = po.trim() || null;
      const form = new FormData();
      if (next === null) form.append("poNumber", "");
      else form.append("poNumber", next);

      await api.put(`/work-orders/${orderId}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
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
      <div className="po-inline">
        <div className="po-value">{initialPo ? initialPo : <em>None</em>}</div>
        <button className="btn btn-primary" onClick={() => setEditing(true)}>
          {initialPo ? "Update PO #" : "Add PO #"}
        </button>
      </div>
    );
  }

  return (
    <div className="po-inline">
      <input
        type="text"
        value={po}
        onChange={(e) => setPo(e.target.value)}
        className="control input"
        placeholder="Enter PO # (optional)"
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

/* ---------- Lightbox modal ---------- */
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
      const res = await fetch(src, { credentials: "omit" });
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
    <div className="lightbox-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-card" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-topbar">
          <strong className="lightbox-title">{title || "Preview"}</strong>
          <div className="lightbox-actions">
            {kind === "image" && (
              <button className="btn btn-light" onClick={handleDownload} disabled={downloading}>
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
          <div className="lightbox-body">
            <img className="lightbox-img" src={src} alt={title || "preview"} />
          </div>
        ) : (
          <iframe title={title || "preview"} src={src} className="lightbox-iframe" />
        )}
      </div>
    </div>
  );
}

/* ---------- Tile component (image or pdf) ---------- */
function FileTile({ kind, href, fileName, onDelete, onExpand, extraAction }) {
  const isPdf = kind === "pdf";
  return (
    <div className="tile">
      <div className="tile-media">
        {isPdf ? (
          <iframe title={fileName} src={href} className="tile-iframe" />
        ) : (
          <img src={href} alt={fileName} className="tile-img" />
        )}
      </div>

      <div className="tile-name">
        <a href={href} target="__blank" rel="noopener noreferrer" title={fileName} className="link">
          {fileName}
        </a>
      </div>

      {extraAction ? <div className="tile-extra">{extraAction}</div> : null}

      <div className="tile-actions">
        <button className="btn btn-light" onClick={onExpand} style={{ flex: 1 }}>
          Expand
        </button>
        {onDelete && (
          <button className="btn btn-danger" onClick={onDelete} title="Delete" style={{ flex: "0 0 auto" }}>
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
  if (Array.isArray(raw)) {
    const entries = raw.map((n, i) => ({
      text: String(n?.text ?? "").trim(),
      createdAt: n?.createdAt || n?.time || null,
      by: n?.by || n?.author || n?.user || null,
      __order: i,
    }));
    return { entries, originalOrder: entries.map((e) => e.__order) };
  }
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
      /* fall through */
    }
  }

  const s = String(raw);
  const lines = s.split(/\r?\n/);
  const entries = [];
  let current = null;
  const startRe = /^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(startRe);
    if (m) {
      if (current) entries.push({ ...current });
      current = {
        createdAt: m[1],
        by: m[2].trim(),
        text: m[3] ? m[3] : "",
        __order: entries.length,
      };
      continue;
    }
    if (/^\s*$/.test(line)) {
      if (current) {
        entries.push({ ...current });
        current = null;
      }
      continue;
    }
    if (current) current.text = (current.text ? current.text + "\n" : "") + line;
  }
  if (current) entries.push({ ...current });

  return { entries, originalOrder: entries.map((e) => e.__order) };
}

function formatNotesText(entriesInOrder) {
  return entriesInOrder
    .map((n) => {
      const ts = n.createdAt || moment().format("YYYY-MM-DD HH:mm:ss.SSS");
      const by = n.by || "system";
      const txt = (n.text || "").toString();
      return `[${ts}] ${by}: ${txt}`;
    })
    .join("\n\n");
}

/* ---------- Simple “stacked field” wrapper ---------- */
function Field({ label, children, hint }) {
  return (
    <div className="wo-field">
      <div className="wo-label">{label}</div>
      <div className="wo-control">
        {children}
        {hint ? <div className="wo-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

export default function ViewWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);

  // Tech dropdown: use numeric assignedTo like WorkOrders.js
  const [techUsers, setTechUsers] = useState([]);
  const [techSaving, setTechSaving] = useState(false);
  const [localAssignedTo, setLocalAssignedTo] = useState(""); // "" or numeric string

  const [newNote, setNewNote] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  const [busyReplace, setBusyReplace] = useState(false);
  const [keepOldInAttachments, setKeepOldInAttachments] = useState(true);
  const [busyPoUpload, setBusyPoUpload] = useState(false);
  const [busyEstimateUpload, setBusyEstimateUpload] = useState(false);
  const [busyImageUpload, setBusyImageUpload] = useState(false);

  const [statusSaving, setStatusSaving] = useState(false);
  const [localStatus, setLocalStatus] = useState("");

  // PO supplier tracked locally for dropdown + inference
  const [poSupplier, setPoSupplier] = useState("");

  // Draw-note overrides
  const [drawNoteOverrides, setDrawNoteOverrides] = useState(new Set());

  const [lightbox, setLightbox] = useState({ open: false, kind: "pdf", src: "", title: "" });
  const openLightbox = (kind, src, title) => setLightbox({ open: true, kind, src, title });
  const closeLightbox = () => setLightbox((l) => ({ ...l, open: false }));

  // ✅ Inline edit mode (stacked fields)
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [edit, setEdit] = useState({
    workOrderNumber: "",
    poNumber: "",
    customer: "",
    customerPhone: "",
    customerEmail: "",
    siteName: "",
    siteAddress: "",
    siteLocation: "",
    billingAddress: "",
    problemDescription: "",
    status: "",
    assignedTo: "",
    scheduledDate: "",
    poSupplier: "",
    poPickedUp: false,
  });

  const patchEdit = (patch) => setEdit((e) => ({ ...e, ...patch }));

  // For safer date/time control in edit mode
  const scheduledDateInput = useMemo(() => {
    if (!edit?.scheduledDate) return "";
    try {
      const dt = new Date(edit.scheduledDate);
      const pad = (n) => String(n).padStart(2, "0");
      const yyyy = dt.getFullYear();
      const mm = pad(dt.getMonth() + 1);
      const dd = pad(dt.getDate());
      const hh = pad(dt.getHours());
      const mi = pad(dt.getMinutes());
      return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
    } catch {
      return "";
    }
  }, [edit?.scheduledDate]);

  const enterEditMode = () => {
    if (!workOrder) return;
    setEdit({
      workOrderNumber: workOrder.workOrderNumber || "",
      poNumber: displayPO(workOrder.workOrderNumber, workOrder.poNumber) || "",
      customer: workOrder.customer || "",
      customerPhone: workOrder.customerPhone || "",
      customerEmail: workOrder.customerEmail || "",
      siteName: workOrder.siteName || "",
      siteAddress: workOrder.siteAddress || "",
      siteLocation: workOrder.siteLocation || "",
      billingAddress: workOrder.billingAddress || "",
      problemDescription: workOrder.problemDescription || "",
      status: workOrder.status || "Needs to be Scheduled",
      assignedTo:
        workOrder.assignedTo === null || workOrder.assignedTo === undefined ? "" : String(workOrder.assignedTo),
      scheduledDate: workOrder.scheduledDate || "",
      poSupplier: workOrder.poSupplier || poSupplier || "",
      poPickedUp: !!workOrder.poPickedUp,
    });
    setEditMode(true);
  };

  const cancelEditMode = () => {
    setEditMode(false);
    if (workOrder) {
      setLocalStatus(workOrder.status || "");
      const assignedToVal = workOrder.assignedTo ?? "";
      setLocalAssignedTo(assignedToVal === null || assignedToVal === undefined ? "" : String(assignedToVal));
      setPoSupplier(workOrder.poSupplier || "");
    }
  };

  const fetchTechUsers = async () => {
    try {
      const res = await api.get("/users", {
        params: { assignees: 1 },
        headers: authHeaders(),
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      const filtered = rows.filter((u) => ALLOWED_TECH_USERNAMES.has(String(u.username || "")));
      setTechUsers(filtered);
    } catch (e) {
      console.error("Error fetching assignable tech users:", e);
      setTechUsers([]);
    }
  };

  const fetchWorkOrder = async () => {
    try {
      const response = await api.get(`/work-orders/${id}`, {
        headers: authHeaders(),
      });
      const data = response.data || null;
      setWorkOrder(data);

      setLocalStatus(data?.status || "");

      // IMPORTANT: assignedTo is numeric ID in your backend
      const assignedToVal = data?.assignedTo ?? "";
      setLocalAssignedTo(assignedToVal === null || assignedToVal === undefined ? "" : String(assignedToVal));

      // Load draw-note overrides for this WO
      setDrawNoteOverrides(loadDrawNoteOverrides(id));

      // Initialize PO supplier from backend value
      setPoSupplier(data?.poSupplier || "");
    } catch (error) {
      console.error("⚠️ Error fetching work order:", error);
    }
  };

  useEffect(() => {
    fetchWorkOrder();
    fetchTechUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const { entries: parsedNotes } = useMemo(() => {
    const raw = workOrder?.notes ?? null;
    return parseNotesArrayOrText(raw);
  }, [workOrder]);

  const displayNotes = useMemo(() => {
    const withSortKey = parsedNotes.map((n, i) => ({
      ...n,
      __idx: i,
      __t: n.createdAt ? Date.parse(n.createdAt) || 0 : 0,
    }));
    return withSortKey.sort((a, b) => b.__t - a.__t);
  }, [parsedNotes]);

// ✅ Most recent notes for the top "Details" section
const recentNotes = useMemo(() => {
  // show the latest 3 notes (change 3 -> 5 if you want more)
  return (displayNotes || []).slice(0, 3);
}, [displayNotes]);

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
    poSupplier: woPoSupplier,
    poPickedUp,
    id: woId,
  } = workOrder;

  const cleanedPo = displayPO(workOrderNumber, poNumber);
  const cleanedWo = displayWO(workOrderNumber);

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

  const allImageAttachments = attachments.filter(isImageKey);

  // Determine draw notes using overrides first, then weak filename heuristic
  const isDrawNote = (key) => drawNoteOverrides.has(key) || isLikelyDrawNoteByName(key);
  const drawNoteImages = allImageAttachments.filter((k) => isDrawNote(k));
  const photoImages = allImageAttachments.filter((k) => !isDrawNote(k));

  const toggleDrawNote = (key) => {
    setDrawNoteOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveDrawNoteOverrides(id, next);
      return next;
    });
  };

  // ✅ Date Created (robust field fallbacks)
  const createdRaw =
    workOrder?.createdAt ??
    workOrder?.created_at ??
    workOrder?.dateCreated ??
    workOrder?.createdDate ??
    workOrder?.createdOn ??
    null;

  const createdDisplay =
    createdRaw && moment(createdRaw).isValid() ? moment(createdRaw).format("YYYY-MM-DD HH:mm") : "—";

  const LOGO_URL = `${window.location.origin}/fcg-logo.png`;
  const safe = (x) =>
    (x ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const buildIdBlock = (agreementNo) => {
    return `
      <div class="idbox">
        <div><b>PO #:</b> ${safe(agreementNo || "")}</div>
        <div><b>WO #:</b> ${safe(cleanedWo)}</div>
        <div><b>Date:</b> ____/____/____</div>
      </div>
    `;
  };

  /* ---------------- PRINT: Work Order ---------------- */
  const handlePrint = () => {
    const siteDisplayName = (siteLocation || customer || "").trim();
    const siteAddr = (siteAddress || "").trim();
    const agreementNo = cleanedPo || id;

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Work Order ${safe(agreementNo)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, "Segoe UI", Roboto, sans-serif; color: #000; -webkit-print-color-adjust: exact; }
    .sheet { width: 100%; max-width: 8.5in; margin: 0 auto; page-break-inside: avoid; }
    .hdr { display: grid; grid-template-columns: 120px 1fr 260px; align-items: start; column-gap: 12px; }
    .logo { width: 100%; height: auto; }
    .company h1 { margin: 0; font-size: 18px; font-weight: 700; }
    .company .addr { margin-top: 2px; font-size: 10px; line-height: 1.2; }
    .idbox { border: 2px solid #000; padding: 10px; font-size: 12px; line-height: 1.35; }
    .idbox div { margin: 2px 0; }
    .title { margin-top: 8px; font-size: 18px; font-weight: 700; text-transform: uppercase; border-bottom: 2px solid #000; display: inline-block; padding-bottom: 2px; }
    .spacer-8 { height: 8px; }
    table { border-collapse: collapse; width: 100%; }
    .two-col th, .two-col td { border: 1px solid #000; font-size: 11px; padding: 6px 8px; vertical-align: middle; }
    .two-col th { background: #fff; font-weight: 700; text-transform: uppercase; }
    .label { width: 18%; }
    .desc-title { border: 1px solid #000; border-bottom: none; padding: 6px 8px; font-size: 11px; font-weight: 700; text-align: left; }
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
        <div class="title">Work Order</div>
      </div>
      ${buildIdBlock(agreementNo)}
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

  /* ---------------- PRINT: To Quote ---------------- */
  const handlePrintToQuote = () => {
    const siteDisplayName = (siteLocation || customer || "").trim();
    const siteAddr = (siteAddress || "").trim();
    const agreementNo = cleanedPo || id;

    const notesText = (displayNotes || [])
      .slice()
      .reverse()
      .map((n) => {
        const ts = n.createdAt ? moment(n.createdAt).format("YYYY-MM-DD HH:mm") : "";
        const by = n.by ? ` — ${n.by}` : "";
        return `${ts}${by}\n${n.text || ""}`.trim();
      })
      .filter(Boolean)
      .join("\n\n--------------------------------\n\n");

    const photos = photoImages || [];
    const draws = drawNoteImages || [];

    const photoPages = photos
      .map((k, idx) => {
        const src = urlFor(k);
        const name = fileNameFromKey(k);
        return `
          <div class="page">
            <div class="page-hdr">
              <div><b>Work Order:</b> ${safe(cleanedWo)} &nbsp;&nbsp; <b>PO #:</b> ${safe(agreementNo)}</div>
              <div class="small">${safe(name || `photo-${idx + 1}`)}</div>
            </div>
            <div class="imgwrap">
              <img src="${safe(src)}" alt="${safe(name)}" />
            </div>
          </div>
        `;
      })
      .join("");

    const drawPages = draws
      .map((k, idx) => {
        const src = urlFor(k);
        const name = fileNameFromKey(k);
        return `
          <div class="page">
            <div class="page-hdr">
              <div><b>Draw Note</b> — <b>WO #:</b> ${safe(cleanedWo)} &nbsp;&nbsp; <b>PO #:</b> ${safe(agreementNo)}</div>
              <div class="small">${safe(name || `draw-${idx + 1}`)}</div>
            </div>
            <div class="imgwrap">
              <img src="${safe(src)}" alt="${safe(name)}" />
            </div>
          </div>
        `;
      })
      .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Print To Quote ${safe(agreementNo)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, "Segoe UI", Roboto, sans-serif; color: #000; -webkit-print-color-adjust: exact; }
    .sheet { width: 100%; max-width: 8.5in; margin: 0 auto; }
    .cover { page-break-after: always; }
    .hdr { display: grid; grid-template-columns: 120px 1fr 260px; align-items: start; column-gap: 12px; }
    .logo { width: 100%; height: auto; }
    .company h1 { margin: 0; font-size: 18px; font-weight: 700; }
    .company .addr { margin-top: 2px; font-size: 10px; line-height: 1.2; }
    .idbox { border: 2px solid #000; padding: 10px; font-size: 12px; line-height: 1.35; }
    .idbox div { margin: 2px 0; }
    .title { margin-top: 8px; font-size: 18px; font-weight: 700; text-transform: uppercase; border-bottom: 2px solid #000; display: inline-block; padding-bottom: 2px; }
    .spacer-8 { height: 8px; }

    table { border-collapse: collapse; width: 100%; }
    .two-col th, .two-col td { border: 1px solid #000; font-size: 11px; padding: 6px 8px; vertical-align: middle; }
    .two-col th { background: #fff; font-weight: 700; text-transform: uppercase; }
    .label { width: 18%; }

    .section-title { margin: 12px 0 6px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .box { border: 1px solid #000; padding: 10px; white-space: pre-wrap; font-size: 11.5px; }
    .box.notes { min-height: 2.0in; }
    .box.problem { min-height: 1.2in; }

    .page { page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    .page-hdr { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 8px; border-bottom: 2px solid #000; padding-bottom: 6px; }
    .page-hdr .small { font-size: 10px; color: #222; max-width: 60%; text-align: right; word-break: break-all; }
    .imgwrap { width: 100%; height: calc(11in - 1in - 40px); display: flex; align-items: center; justify-content: center; }
    .imgwrap img { max-width: 100%; max-height: 100%; object-fit: contain; }

    .fine { font-size: 8px; margin-top: 10px; }
  </style>
</head>
<body>

  <div class="sheet cover">
    <div class="hdr">
      <img class="logo" src="${safe(LOGO_URL)}" alt="First Class Glass logo" />
      <div class="company">
        <h1>First Class Glass &amp; Mirror, INC.</h1>
        <div class="addr">
          1513 Industrial Dr, Itasca, Illinois 60143 • 630-250-9777<br/>
          FCG@FirstClassGlassMirror.com
        </div>
        <div class="title">Print To Quote</div>
      </div>
      ${buildIdBlock(agreementNo)}
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

    <div class="section-title">Problem Description</div>
    <div class="box problem">${safe(problemDescription || "")}</div>

    <div class="section-title">Notes</div>
    <div class="box notes">${safe(notesText || "No notes.")}</div>

    <div class="fine">
      This packet prints: Cover + Notes + Draw Notes (1/page) + Photos (1/page).
    </div>
  </div>

  ${drawPages}
  ${photoPages}

  <script>
    window.onload = function() {
      setTimeout(function(){ window.print(); window.close(); }, 700);
    };
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

  /* ---------------- EDIT SAVE ---------------- */
  const handleSaveEdits = async () => {
    if (editSaving) return;
    setEditSaving(true);

    try {
      const form = new FormData();

      // Core fields
      form.append("workOrderNumber", (edit.workOrderNumber || "").trim());
      form.append("poNumber", (edit.poNumber || "").trim()); // backend will store it; legacy hide handled in UI
      form.append("customer", (edit.customer || "").trim());
      form.append("customerPhone", (edit.customerPhone || "").trim());
      form.append("customerEmail", (edit.customerEmail || "").trim());

      // Location set (legacy + explicit)
      form.append("siteName", (edit.siteName || "").trim());
      form.append("siteAddress", (edit.siteAddress || "").trim());
      form.append("siteLocation", (edit.siteLocation || "").trim());

      // Billing
      form.append("billingAddress", (edit.billingAddress || "").trim());

      // Problem
      form.append("problemDescription", (edit.problemDescription || "").trim());

      // Status / Assign / Schedule
      form.append("status", edit.status || "Needs to be Scheduled");
      form.append("assignedTo", edit.assignedTo || "");
      form.append("scheduledDate", edit.scheduledDate || "");

      // Purchase order fields
      form.append("poSupplier", edit.poSupplier || "");
      form.append("poPickedUp", edit.poPickedUp ? "1" : "0");

      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
      });

      setEditMode(false);
      await fetchWorkOrder();
    } catch (err) {
      console.error("⚠️ Error saving edits:", err?.response || err);
      alert(err?.response?.data?.error || "Error saving changes. See console.");
    } finally {
      setEditSaving(false);
    }
  };

  /* ---------------- DELETE (robust multi-strategy) ---------------- */
  const handleDeleteWorkOrder = async () => {
    if (deleting) return;
    if (!window.confirm("Delete this work order? This cannot be undone.")) return;

    setDeleting(true);

    const showErr = (err, label) => {
      const status = err?.response?.status;
      const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || "Unknown error";
      console.error(`❌ ${label} failed`, { status, msg, err });
      return { status, msg };
    };

    try {
      await api.delete(`/work-orders/${id}`, { headers: authHeaders() });
      navigate("/work-orders");
      return;
    } catch (e1) {
      showErr(e1, "DELETE /work-orders/:id");
    }

    try {
      await api.post(`/work-orders/${id}?_method=DELETE`, null, { headers: authHeaders() });
      navigate("/work-orders");
      return;
    } catch (e2) {
      showErr(e2, "POST /work-orders/:id?_method=DELETE");
    }

    try {
      await api.post(`/work-orders/${id}/delete`, null, { headers: authHeaders() });
      navigate("/work-orders");
      return;
    } catch (e3) {
      showErr(e3, "POST /work-orders/:id/delete");
    }

    try {
      await api.delete(`/work-orders`, {
        data: { id, purgeFiles: true },
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      navigate("/work-orders");
      return;
    } catch (e4) {
      const { status, msg } = showErr(e4, "DELETE /work-orders { id }");
      alert(`Failed to delete (status ${status ?? "?"}). ${msg}. See console for details.`);
    } finally {
      setDeleting(false);
    }
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
      form.append("pdf", file);
      form.append("replacePdf", "1");
      if (keepOldInAttachments) {
        form.append("keepOldPdfInAttachments", "1");
        form.append("keepOldInAttachments", "1");
      }
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
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
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
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

      // ✅ ensure this becomes the canonical PO PDF (not "just another attachment")
      form.append("setAsPoPdf", "1");

      const fileName = file.name || "";
      const currentSupplier = poSupplier || woPoSupplier || "";
      const inferredSupplier = inferSupplierFromFilename(fileName);
      const inferredPoNum = inferPoNumberFromFilename(fileName);

      // ✅ Auto-set supplier if empty
      if (!currentSupplier && inferredSupplier) {
        form.append("poSupplier", inferredSupplier);
      }

      // ✅ Auto-set PO# only if currently blank
      if (!cleanedPo && inferredPoNum) {
        form.append("poNumber", inferredPoNum);
      }

      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
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

  const handleUploadImageAttachment = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const bad = files.find((file) => {
      const isImage = file.type?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(file.name || "");
      return !isImage;
    });

    if (bad) {
      alert("Please choose only image files (jpg, png, etc.).");
      e.target.value = "";
      return;
    }

    setBusyImageUpload(true);
    try {
      const form = new FormData();
      files.forEach((file) => form.append("photoFile", file));

      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
      });

      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading images:", error);
      alert(error?.response?.data?.error || "Failed to upload images.");
    } finally {
      setBusyImageUpload(false);
      e.target.value = "";
    }
  };

  const handleDeleteAttachment = async (relPath) => {
    if (!relPath) return;
    const confirm = window.confirm("Delete this attachment permanently?");
    if (!confirm) return;

    try {
      await api.delete(`/work-orders/${id}/attachments`, {
        headers: { "Content-Type": "application/json", ...authHeaders() },
        data: { key: relPath },
      });

      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error deleting attachment:", error);
      alert(error?.response?.data?.error || "Failed to delete attachment.");
    }
  };

  /* ---------- Status (view-mode dropdown) ---------- */
  const handleStatusChange = async (e) => {
    const newStatus = e.target.value;
    setLocalStatus(newStatus);
    setStatusSaving(true);
    try {
      try {
        await api.put(`/work-orders/${id}/status`, { status: newStatus }, { headers: authHeaders() });
      } catch {
        const form = new FormData();
        form.append("status", newStatus);
        await api.put(`/work-orders/${id}/edit`, form, {
          headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
        });
      }
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error updating status:", error);
      alert(error?.response?.data?.error || "Failed to update status.");
    } finally {
      setStatusSaving(false);
    }
  };

  /* ---------- Assigned Tech (MATCH WorkOrders.js) ---------- */
  const handleAssignedTechChange = async (e) => {
    const nextTechId = e.target.value; // "" or numeric string
    const prev = localAssignedTo;

    setLocalAssignedTo(nextTechId);
    setTechSaving(true);

    try {
      try {
        await api.put(
          `/work-orders/${id}/assign`,
          { assignedTo: nextTechId || null },
          { headers: { "Content-Type": "application/json", ...authHeaders() } }
        );
      } catch {
        const form = new FormData();
        form.append("assignedTo", nextTechId || "");
        await api.put(`/work-orders/${id}/edit`, form, {
          headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
        });
      }
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error updating assigned tech:", error);
      setLocalAssignedTo(prev);
      alert(error?.response?.data?.error || "Failed to assign technician.");
    } finally {
      setTechSaving(false);
    }
  };

  /* ---------- PO Supplier change (view-mode dropdown) ---------- */
  const handlePoSupplierChange = async (e) => {
    const next = e.target.value;
    const prev = poSupplier || woPoSupplier || "";
    setPoSupplier(next);

    try {
      const form = new FormData();
      form.append("poSupplier", next || "");
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error updating PO supplier:", error);
      setPoSupplier(prev);
      alert(error?.response?.data?.error || "Failed to update PO supplier.");
    }
  };

  /* ---------- PO Picked Up toggle ---------- */
  const handlePoPickedUpToggle = async (checked) => {
    try {
      const form = new FormData();
      form.append("poPickedUp", checked ? "1" : "0");
      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error updating PO picked up:", error);
      alert(error?.response?.data?.error || "Failed to update PO picked up.");
    }
  };

  /* ---------- Notes (add + delete) ---------- */
  const handleAddNote = async () => {
    const text = newNote.trim();
    if (!text) return;

    try {
      await api.put(
        `/work-orders/${id}/notes`,
        { notes: text, append: true },
        { headers: { "Content-Type": "application/json", ...authHeaders() } }
      );
    } catch (err1) {
      try {
        await api.put(
          `/work-orders/${id}/notes`,
          { text, append: true },
          { headers: { "Content-Type": "application/json", ...authHeaders() } }
        );
      } catch (err2) {
        console.error("Add note failed:", err1, err2);
        const msg =
          err2?.response?.data?.error ||
          err1?.response?.data?.error ||
          err2?.message ||
          err1?.message ||
          "Failed to add note.";
        alert(msg);
        return;
      }
    }

    setNewNote("");
    setShowNoteInput(false);
    await fetchWorkOrder();
  };

  const handleDeleteNote = async (displayIdx) => {
    if (!window.confirm("Delete this note?")) return;

    try {
      const byOldest = [...parsedNotes].sort(
        (a, b) => (a.createdAt ? Date.parse(a.createdAt) : 0) - (b.createdAt ? Date.parse(b.createdAt) : 0)
      );
      const target = displayNotes[displayIdx];
      if (!target) return;

      const kept = byOldest.filter(
        (e) => !(e.createdAt === target.createdAt && e.text === target.text && (e.by || "") === (target.by || ""))
      );

      const newBody = kept.length ? formatNotesText(kept) : "";
      const form = new FormData();
      form.append("notes", newBody);

      await api.put(`/work-orders/${id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
      });

      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error deleting note:", error);
      alert(error?.response?.data?.error || "Failed to delete note.");
    }
  };

  /* ---------- Download Many (downloads ALL, no stuck page) ---------- */
  const downloadMany = async (keys) => {
    if (!keys || !keys.length) return;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const href = urlFor(key);
      const fileName = fileNameFromKey(key) || `file-${i + 1}`;

      try {
        const res = await fetch(href, { credentials: "omit" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();

        URL.revokeObjectURL(objectUrl);

        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.error("Download failed for:", key, err);
      }
    }
  };

  /* ======================= RENDER ======================= */
  return (
    <div className="view-container">
      <Lightbox
        open={lightbox.open}
        onClose={closeLightbox}
        kind={lightbox.kind}
        src={lightbox.src}
        title={lightbox.title}
      />

      <div className="view-card">
        <div className="view-header-row">
          <div className="view-header-left">
            <h2 className="view-title">Work Order Details</h2>
            <div className="view-subtitle">
              <span className="pill">WO: {cleanedWo}</span>
              {cleanedPo ? <span className="pill">PO: {cleanedPo}</span> : null}
              <span className="pill subtle">Created: {createdDisplay}</span>
            </div>
          </div>

          <div className="view-actions">
            <button className="btn btn-outline" onClick={handlePrint}>
              Print Work Order
            </button>

            <button className="btn btn-primary" onClick={handlePrintToQuote}>
              Print to Quote
            </button>

            {!editMode ? (
              <>
                <button className="btn btn-light" onClick={enterEditMode}>
                  Edit
                </button>
                <button className="btn btn-danger" onClick={handleDeleteWorkOrder} disabled={deleting}>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-primary" onClick={handleSaveEdits} disabled={editSaving}>
                  {editSaving ? "Saving…" : "Save"}
                </button>
                <button className="btn btn-ghost" onClick={cancelEditMode} disabled={editSaving}>
                  Cancel
                </button>
              </>
            )}

            <button className="btn back-btn" onClick={() => navigate("/work-orders")}>
              Back to List
            </button>
          </div>
        </div>

        {/* ======================= BASIC INFO (STACKED FIELDS) ======================= */}
        <div className="wo-stack">
          <div className="wo-stack-head">

            <div className="wo-stack-meta">
<div className="section-card">
  <h3 className="section-header">Details</h3>

  {recentNotes.length ? (
    <ul className="notes-list" style={{ marginTop: 0 }}>
      {recentNotes.map((n, idx) => (
        <li key={`${n.createdAt || "na"}-${idx}`} className="note-item">
          <div className="note-header">
            <small className="note-timestamp">
              {n.createdAt ? moment(n.createdAt).format("YYYY-MM-DD HH:mm") : "—"}
              {n.by ? ` — ${n.by}` : ""}
            </small>
          </div>
          <p className="note-text" style={{ marginBottom: 0 }}>
            {n.text}
          </p>
        </li>
      ))}
    </ul>
  ) : (
    <p className="empty-text" style={{ margin: 0 }}>
      No notes yet.
    </p>
  )}
</div>
      
        <div className="meta-row">
                <span className="meta-label">Status</span>
                {editMode ? (
                  <select
                    className="control select"
                    value={edit.status}
                    onChange={(e) => patchEdit({ status: e.target.value })}
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
                ) : (
                  <div className="meta-inline">
                    <select className="control select" value={localStatus} onChange={handleStatusChange} disabled={statusSaving}>
                      <option value="" disabled>
                        Select status…
                      </option>
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                    {statusSaving ? <span className="tiny">Saving…</span> : null}
                  </div>
                )}
              </div>

              <div className="meta-row">
                <span className="meta-label">Assigned Tech</span>
                {editMode ? (
                  <select
                    className="control select"
                    value={edit.assignedTo}
                    onChange={(e) => patchEdit({ assignedTo: e.target.value })}
                  >
                    <option value="">Unassigned</option>
                    {techUsers.map((t) => (
                      <option key={t.id} value={String(t.id)}>
                        {t.username}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="meta-inline">
                    <select
                      className="control select"
                      value={localAssignedTo}
                      onChange={handleAssignedTechChange}
                      disabled={techSaving}
                    >
                      <option value="">Unassigned</option>
                      {techUsers.map((t) => (
                        <option key={t.id} value={String(t.id)}>
                          {t.username}
                        </option>
                      ))}
                    </select>
                    {techSaving ? <span className="tiny">Saving…</span> : null}
                  </div>
                )}
              </div>
            </div>
          </div>

          <Field label="Work Order #">
            {editMode ? (
              <input
                type="text"
                className="control input"
                value={edit.workOrderNumber}
                onChange={(e) => patchEdit({ workOrderNumber: e.target.value })}
              />
            ) : (
              <div className="value">{displayWO(workOrderNumber)}</div>
            )}
          </Field>

          <Field label="PO #">
            {editMode ? (
              <input
                type="text"
                className="control input"
                value={edit.poNumber}
                onChange={(e) => patchEdit({ poNumber: e.target.value })}
                placeholder="(optional)"
              />
            ) : (
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
            )}
          </Field>

          <Field label="Customer">
            {editMode ? (
              <input className="control input" value={edit.customer} onChange={(e) => patchEdit({ customer: e.target.value })} />
            ) : (
              <div className="value">{customer || "—"}</div>
            )}
          </Field>

          <div className="wo-2col">
            <Field label="Customer Phone">
              {editMode ? (
                <input
                  type="tel"
                  className="control input"
                  value={edit.customerPhone}
                  onChange={(e) => patchEdit({ customerPhone: e.target.value })}
                />
              ) : (
                <div className="value">{customerPhone || "—"}</div>
              )}
            </Field>

            <Field label="Customer Email">
              {editMode ? (
                <input
                  type="email"
                  className="control input"
                  value={edit.customerEmail}
                  onChange={(e) => patchEdit({ customerEmail: e.target.value })}
                />
              ) : (
                <div className="value">{customerEmail || "—"}</div>
              )}
            </Field>
          </div>

          <Field label="Site Name">
            {editMode ? (
              <input className="control input" value={edit.siteName} onChange={(e) => patchEdit({ siteName: e.target.value })} />
            ) : (
              <div className="value">{workOrder?.siteName || "—"}</div>
            )}
          </Field>

          <Field label="Site Address">
            {editMode ? (
              <textarea
                className="control textarea"
                rows={3}
                value={edit.siteAddress}
                onChange={(e) => patchEdit({ siteAddress: e.target.value })}
              />
            ) : (
              <div className="value pre-wrap">{siteAddress || "—"}</div>
            )}
          </Field>

          <Field label="Site Location (Legacy)">
            {editMode ? (
              <textarea
                className="control textarea"
                rows={3}
                value={edit.siteLocation}
                onChange={(e) => patchEdit({ siteLocation: e.target.value })}
              />
            ) : (
              <div className="value pre-wrap">{siteLocation || "—"}</div>
            )}
          </Field>

          <Field label="Billing Address">
            {editMode ? (
              <textarea
                className="control textarea"
                rows={4}
                value={edit.billingAddress}
                onChange={(e) => patchEdit({ billingAddress: e.target.value })}
              />
            ) : (
              <div className="value pre-wrap">{billingAddress || "—"}</div>
            )}
          </Field>

          <Field label="Problem Description">
            {editMode ? (
              <textarea
                className="control textarea"
                rows={5}
                value={edit.problemDescription}
                onChange={(e) => patchEdit({ problemDescription: e.target.value })}
              />
            ) : (
              <div className="value pre-wrap">{problemDescription || "—"}</div>
            )}
          </Field>

          <Field label="Scheduled Date">
            {editMode ? (
              <input
                type="datetime-local"
                className="control input"
                value={scheduledDateInput || ""}
                onChange={(e) => patchEdit({ scheduledDate: e.target.value })}
              />
            ) : (
              <div className="value">{scheduledDate ? moment(scheduledDate).format("YYYY-MM-DD HH:mm") : "Not Scheduled"}</div>
            )}
          </Field>
        </div>

        {/* ======================= Signed Work Order PDF ======================= */}
        <div className="section-card">
          <h3 className="section-header">Sign-Off Sheet PDF</h3>

          {signedHref ? (
            <div className="attachments-grid">
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
              <label className="btn btn-light">
                {busyReplace ? "Uploading…" : "Upload Signed PDF"}
                <input type="file" accept="application/pdf" onChange={handleReplacePdfUpload} style={{ display: "none" }} disabled={busyReplace} />
              </label>
            </div>
          )}

          {signedHref && (
            <div className="row-actions">
              <a className="btn btn-outline" href={signedHref} target="_blank" rel="noreferrer">
                Open in new tab
              </a>
              <label className="btn btn-light">
                {busyReplace ? "Replacing…" : "Replace Signed PDF"}
                <input type="file" accept="application/pdf" onChange={handleReplacePdfUpload} style={{ display: "none" }} disabled={busyReplace} />
              </label>
              <label className="checkline">
                <input type="checkbox" checked={keepOldInAttachments} onChange={(e) => setKeepOldInAttachments(e.target.checked)} />
                Move existing signed PDF to attachments
              </label>
            </div>
          )}
        </div>

        {/* ======================= ESTIMATE PDF ======================= */}
        <div className="section-card">
          <h3 className="section-header">Estimate PDF</h3>

          {estimateHref ? (
            <div className="attachments-grid">
              <FileTile
                kind="pdf"
                href={estimateHref}
                fileName={(estimatePdfPath || "").split("/").pop() || "estimate.pdf"}
                onExpand={() => openLightbox("pdf", estimateHref, "Estimate PDF")}
              />
            </div>
          ) : (
            <p className="empty-text">No estimate PDF attached.</p>
          )}

          <div className="row-actions">
            <label className="btn btn-light">
              {busyEstimateUpload ? "Uploading…" : estimateHref ? "Replace Estimate PDF" : "Upload Estimate PDF"}
              <input type="file" accept="application/pdf" onChange={handleUploadOrReplaceEstimatePdf} style={{ display: "none" }} disabled={busyEstimateUpload} />
            </label>
          </div>
        </div>

        {/* ======================= PO PDF ======================= */}
        <div className="section-card">
          <h3 className="section-header">PO Order PDF</h3>

          <div className="po-meta">
            <div className="po-meta-left">
              <label className="inline-label">
                Supplier
                {editMode ? (
                  <select
                    className="control select"
                    value={edit.poSupplier || ""}
                    onChange={(e) => patchEdit({ poSupplier: e.target.value })}
                  >
                    <option value="">Select supplier…</option>
                    {SUPPLIER_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select className="control select" value={poSupplier || ""} onChange={handlePoSupplierChange}>
                    <option value="">Select supplier…</option>
                    {SUPPLIER_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </label>

              <label className="checkline">
                <input
                  type="checkbox"
                  checked={editMode ? !!edit.poPickedUp : !!poPickedUp}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    if (editMode) patchEdit({ poPickedUp: checked });
                    else handlePoPickedUpToggle(checked);
                  }}
                />
                PO picked up
              </label>
            </div>

            <div className="po-meta-hint">Supplier + picked-up are used on the Purchase Orders tab.</div>
          </div>

          {poHref ? (
            <div className="attachments-grid">
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

          <div className="row-actions">
            <label className="btn btn-light">
              {busyPoUpload ? "Uploading…" : poHref ? "Replace PO PDF" : "Upload PO PDF"}
              <input type="file" accept="application/pdf" onChange={handleUploadOrReplacePoPdf} style={{ display: "none" }} disabled={busyPoUpload} />
            </label>
          </div>
        </div>

        {/* ======================= Other PDFs ======================= */}
        <div className="section-card">
          <h3 className="section-header">Other PDF Attachments</h3>

          {otherPdfAttachments.length ? (
            <div className="attachments-grid">
              {otherPdfAttachments.map((relPath, i) => {
                const href = pdfThumbUrl(relPath);
                const fileName = relPath.split("/").pop() || `attachment-${i + 1}.pdf`;
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

        {/* ======================= Photos ======================= */}
        <div className="section-card">
          <div className="section-row">
            <h3 className="section-header" style={{ margin: 0 }}>
              Image Attachments
            </h3>

            <div className="section-actions">
              <button className="btn btn-outline" onClick={() => downloadMany(photoImages)} disabled={!photoImages.length}>
                Download All Photos
              </button>

              <label className="btn btn-light">
                {busyImageUpload ? "Uploading…" : "Upload Photos"}
                <input type="file" accept="image/*" multiple onChange={handleUploadImageAttachment} style={{ display: "none" }} disabled={busyImageUpload} />
              </label>
            </div>
          </div>

          {photoImages.length ? (
            <div className="attachments-grid">
              {photoImages.map((relPath, i) => {
                const href = urlFor(relPath);
                const fileName = relPath.split("/").pop() || `image-${i + 1}.jpg`;
                return (
                  <FileTile
                    key={`${relPath}-${i}`}
                    kind="image"
                    href={href}
                    fileName={fileName}
                    onExpand={() => openLightbox("image", href, fileName)}
                    onDelete={() => handleDeleteAttachment(relPath)}
                    extraAction={
                      <button className="btn btn-ghost w-full" type="button" onClick={() => toggleDrawNote(relPath)}>
                        Move to Draw Notes
                      </button>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No images attached.</p>
          )}
        </div>

        {/* ======================= Draw Notes ======================= */}
        <div className="section-card">
          <div className="section-row">
            <h3 className="section-header" style={{ margin: 0 }}>
              Draw Notes
            </h3>

            <button className="btn btn-outline" onClick={() => downloadMany(drawNoteImages)} disabled={!drawNoteImages.length}>
              Download All Draw Notes
            </button>
          </div>

          {drawNoteImages.length ? (
            <div className="attachments-grid">
              {drawNoteImages.map((relPath, i) => {
                const href = urlFor(relPath);
                const fileName = relPath.split("/").pop() || `draw-note-${i + 1}.jpg`;
                return (
                  <FileTile
                    key={`${relPath}-${i}`}
                    kind="image"
                    href={href}
                    fileName={fileName}
                    onExpand={() => openLightbox("image", href, fileName)}
                    onDelete={() => handleDeleteAttachment(relPath)}
                    extraAction={
                      <button className="btn btn-ghost w-full" type="button" onClick={() => toggleDrawNote(relPath)}>
                        Move to Photos
                      </button>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No draw notes attached.</p>
          )}
        </div>

        {/* ======================= Notes ======================= */}
        <div className="section-card">
          <h3 className="section-header">Notes</h3>

          <button className="btn btn-light" onClick={() => setShowNoteInput((v) => !v)}>
            {showNoteInput ? "Cancel" : "Add Note"}
          </button>

          {showNoteInput && (
            <div className="add-note">
              <textarea
                className="control textarea"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Write your note here..."
                rows={4}
              />
              <button className="btn btn-primary" onClick={handleAddNote}>
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
                      {n.createdAt ? moment(n.createdAt).format("YYYY-MM-DD HH:mm") : "—"}
                      {n.by ? ` — ${n.by}` : ""}
                    </small>
                    <button type="button" className="note-delete-btn" title="Delete note" onClick={() => handleDeleteNote(idx)}>
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
