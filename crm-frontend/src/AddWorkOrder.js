import React, { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api from "./api";
import "./AddWorkOrder.css";

// Keep this in sync with CalendarPage.js and server DEFAULT_WINDOW_MINUTES
const DEFAULT_WINDOW_MIN = 120;

// Keep this list in sync with WorkOrders.js and server.js
const STATUS_LIST = [
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

function decodeRoleFromJWT() {
  try {
    const token = localStorage.getItem("jwt");
    if (!token) return null;
    const [, payload] = token.split(".");
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return json?.role || null;
  } catch {
    return null;
  }
}

function toEndTimeFromStartISO(localDateTimeStr) {
  if (!localDateTimeStr) return "";
  const [d, t] = localDateTimeStr.split("T");
  if (!d || !t) return "";
  const [hh, mm] = t.split(":").map((v) => parseInt(v, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return "";
  const start = new Date();
  start.setHours(hh, mm, 0, 0);
  const end = new Date(start.getTime() + DEFAULT_WINDOW_MIN * 60000);
  const eh = String(end.getHours()).padStart(2, "0");
  const em = String(end.getMinutes()).padStart(2, "0");
  return `${eh}:${em}`;
}

/* =========================
   ✅ Preview chip helpers
   (ONLY used for uploads)
========================= */
function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i <= 1 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function FileChip({ file, onRemove }) {
  if (!file) return null;

  return (
    <div className="awo-chip" title={file.name}>
      <div className="awo-chip-left">
        <div className="awo-chip-name">{file.name}</div>
        <div className="awo-chip-meta">
          {file.type ? file.type : "file"}
          {file.size ? ` • ${formatBytes(file.size)}` : ""}
        </div>
      </div>

      <button
        type="button"
        className="awo-chip-x"
        onClick={onRemove}
        aria-label="Remove file"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

export default function AddWorkOrder() {
  const navigate = useNavigate();
  const location = useLocation();
  const role = decodeRoleFromJWT();

  const fromPath = useMemo(() => {
    // supports coming from anywhere (Work Orders, Calendar, History, etc.)
    return location.state?.from || "/work-orders";
  }, [location.state]);

  // ---- form state
  const [workOrder, setWorkOrder] = useState({
    customer: "",
    workOrderNumber: "",
    poNumber: "",
    siteLocation: "",
    siteAddress: "",
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "",
    customerPhone: "",
    customerEmail: "",
    scheduledDate: "",
  });

  const [pdfFile, setPdfFile] = useState(null);
  const [estimatePdfFile, setEstimatePdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  // PDF extraction state
  const [extractPdfFile, setExtractPdfFile] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null); // { type: 'success'|'warning'|'error', message, fields }

  // ✅ refs so removing the chip also clears the native <input type="file">
  const pdfInputRef = useRef(null);
  const estimateInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const extractPdfInputRef = useRef(null);

  const [customers, setCustomers] = useState([]);
  const [techs, setTechs] = useState([]);

  const [submitting, setSubmitting] = useState(false);
  const [loadingRefs, setLoadingRefs] = useState(false);

  // Autocomplete for Site Address
  const siteAddressInputRef = useRef(null);
  const autocompleteRef = useRef(null);
  const gmapsReadyRef = useRef(false);

  // ---------- load reference data
  useEffect(() => {
    let mounted = true;
    setLoadingRefs(true);

    Promise.allSettled([
      api.get("/customers"),
      api.get("/users", { params: { assignees: 1 } }),
    ])
      .then(([cRes, uRes]) => {
        if (!mounted) return;

        if (cRes.status === "fulfilled") setCustomers(cRes.value.data || []);
        else console.error("Error loading customers:", cRes.reason);

        if (uRes.status === "fulfilled") {
          const list = (uRes.value.data || []).filter((u) => u.username !== "Mark");
          setTechs(list);
        } else {
          console.error("Error loading assignees:", uRes.reason);
        }
      })
      .finally(() => {
        if (mounted) setLoadingRefs(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  // ---------- auto-toggle status when picking a schedule
  useEffect(() => {
    if (workOrder.scheduledDate && workOrder.status !== "Scheduled") {
      setWorkOrder((prev) => ({ ...prev, status: "Scheduled" }));
    }
  }, [workOrder.scheduledDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Google Maps Autocomplete (Site Address only)
  useEffect(() => {
    const key = (process.env.REACT_APP_GOOGLE_MAPS_API_KEY || "").trim();
    if (!key) {
      console.warn("Google Maps API key missing; Places autocomplete disabled.");
      return;
    }

    if (window.google?.maps?.places?.Autocomplete) {
      gmapsReadyRef.current = true;
      initAutocomplete();
      return;
    }

    if (!window.__gmapsPromise) {
      window.__gmapsPromise = new Promise((resolve, reject) => {
        window.__initGMaps = () => resolve();
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=__initGMaps`;
        script.async = true;
        script.defer = true;
        script.onerror = () => reject(new Error("Failed to load Google Maps"));
        document.body.appendChild(script);
      }).then(() => {
        delete window.__initGMaps;
      });
    }

    window.__gmapsPromise
      .then(() => {
        gmapsReadyRef.current = true;
        initAutocomplete();
      })
      .catch((err) => console.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function initAutocomplete() {
    if (!gmapsReadyRef.current || !window.google?.maps?.places?.Autocomplete) return;
    if (!siteAddressInputRef.current) return;

    try {
      const ac = new window.google.maps.places.Autocomplete(siteAddressInputRef.current, {
        types: ["address"],
        fields: ["formatted_address", "name", "geometry"],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const addr = place?.formatted_address || place?.name || siteAddressInputRef.current.value;
        setWorkOrder((prev) => ({ ...prev, siteAddress: addr }));
      });
      autocompleteRef.current = ac;
    } catch (e) {
      console.error("Failed to init Places Autocomplete:", e);
    }
  }

  const handleSiteAddressFocus = () => {
    if (!autocompleteRef.current) initAutocomplete();
  };

  const extractCustomerFromBilling = (addr) => {
    if (!addr) return "";
    const first = addr
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return first || "";
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setWorkOrder((prev) => {
      const upd = { ...prev, [name]: value };

      if (name === "customer") {
        const found = customers.find((c) => c.name === value);
        if (found?.billingAddress) upd.billingAddress = found.billingAddress;
      }

      if (name === "billingAddress") {
        const first = extractCustomerFromBilling(value);
        const prevAuto = extractCustomerFromBilling(prev.billingAddress || "");
        if (!prev.customer || prev.customer === prevAuto) {
          upd.customer = first;
        }
      }

      return upd;
    });
  };

  const handlePdfChange = (e) => setPdfFile(e.target.files?.[0] || null);
  const handleEstimateChange = (e) => setEstimatePdfFile(e.target.files?.[0] || null);
  const handlePhotoChange = (e) => setPhotoFile(e.target.files?.[0] || null);

  // ✅ chip remove handlers (clear state + input value)
  const removePdf = () => {
    setPdfFile(null);
    if (pdfInputRef.current) pdfInputRef.current.value = "";
  };
  const removeEstimate = () => {
    setEstimatePdfFile(null);
    if (estimateInputRef.current) estimateInputRef.current.value = "";
  };
  const removePhoto = () => {
    setPhotoFile(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  // ===== PDF Extraction handlers =====
  const handleExtractPdfChange = (e) => {
    const file = e.target.files?.[0] || null;
    setExtractPdfFile(file);
    setExtractResult(null); // Clear previous result

    // Auto-trigger extraction when file is selected
    if (file) {
      extractFromPdf(file);
    }
  };

  const removeExtractPdf = () => {
    setExtractPdfFile(null);
    setExtractResult(null);
    if (extractPdfInputRef.current) extractPdfInputRef.current.value = "";
  };

  const extractFromPdf = async (file) => {
    if (!file) return;

    // Validate file type
    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      setExtractResult({ type: "error", message: "Please upload a PDF file." });
      return;
    }

    console.log("[PDF Extract] Starting extraction for:", file.name);
    setExtracting(true);
    setExtractResult(null);

    const formData = new FormData();
    formData.append("pdf", file);

    try {
      console.log("[PDF Extract] Calling API: /work-orders/extract-pdf");

      // Use longer timeout for OCR (60 seconds)
      const response = await api.post("/work-orders/extract-pdf", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60000, // 60 second timeout for OCR
      });

      console.log("[PDF Extract] Response status:", response.status);
      console.log("[PDF Extract] Response data:", JSON.stringify(response.data, null, 2));

      if (response.data?.success && response.data?.extracted) {
        const ext = response.data.extracted;
        console.log("[PDF Extract] Extracted fields:", ext);

        // Build list of filled fields OUTSIDE setState to avoid closure issues
        const filledFields = [];
        const updates = {};

        if (ext.customer && ext.customer.trim()) {
          updates.customer = ext.customer.trim();
          filledFields.push("Customer");
          console.log("[PDF Extract] Found customer:", updates.customer);
        }
        if (ext.billingAddress && ext.billingAddress.trim()) {
          updates.billingAddress = ext.billingAddress.trim();
          filledFields.push("Billing Address");
          console.log("[PDF Extract] Found billingAddress:", updates.billingAddress);
        }
        if (ext.poNumber && ext.poNumber.trim()) {
          updates.poNumber = ext.poNumber.trim();
          filledFields.push("PO Number");
          console.log("[PDF Extract] Found poNumber:", updates.poNumber);
        }
        if (ext.workOrderNumber && ext.workOrderNumber.trim()) {
          updates.workOrderNumber = ext.workOrderNumber.trim();
          filledFields.push("Work Order #");
          console.log("[PDF Extract] Found workOrderNumber:", updates.workOrderNumber);
        }
        if (ext.siteLocation && ext.siteLocation.trim()) {
          updates.siteLocation = ext.siteLocation.trim();
          filledFields.push("Site Location");
          console.log("[PDF Extract] Found siteLocation:", updates.siteLocation);
        }
        if (ext.siteAddress && ext.siteAddress.trim()) {
          updates.siteAddress = ext.siteAddress.trim();
          filledFields.push("Site Address");
          console.log("[PDF Extract] Found siteAddress:", updates.siteAddress);
        }
        if (ext.problemDescription && ext.problemDescription.trim()) {
          updates.problemDescription = ext.problemDescription.trim();
          filledFields.push("Problem Description");
          console.log("[PDF Extract] Found problemDescription:", updates.problemDescription);
        }

        console.log("[PDF Extract] Total fields found:", filledFields.length, filledFields);

        // Apply updates to form state
        if (Object.keys(updates).length > 0) {
          setWorkOrder((prev) => ({ ...prev, ...updates }));
        }

        // Auto-attach the extracted PDF as the Work Order PDF
        if (file && !pdfFile) {
          setPdfFile(file);
          filledFields.push("Work Order PDF (auto-attached)");
          console.log("[PDF Extract] Auto-attached extracted PDF as Work Order PDF");
        }

        if (filledFields.length > 0) {
          setExtractResult({
            type: "success",
            message: "Extracted info from PDF. Please review and edit if needed.",
            fields: filledFields,
          });
        } else {
          setExtractResult({
            type: "warning",
            message: "Could not extract information from PDF. Please fill in manually.",
            rawText: response.data.rawText?.substring(0, 200) || "(no text)",
          });
        }
      } else {
        setExtractResult({
          type: "warning",
          message: "Could not extract information from PDF. Please fill in manually.",
        });
      }
    } catch (err) {
      console.error("[PDF Extract] Error:", err);
      console.error("[PDF Extract] Error details:", {
        message: err.message,
        code: err.code,
        response: err.response?.data,
        status: err.response?.status,
      });

      if (err.code === "ECONNABORTED") {
        setExtractResult({
          type: "error",
          message: "Extraction timed out. The PDF may be too large or complex. Please fill in manually.",
        });
      } else if (err.response?.data?.error) {
        setExtractResult({
          type: "error",
          message: `Extraction failed: ${err.response.data.error}`,
        });
      } else if (err.response?.status) {
        setExtractResult({
          type: "error",
          message: `Server error (${err.response.status}). Please try again or fill in manually.`,
        });
      } else {
        setExtractResult({
          type: "error",
          message: `Network error: ${err.message}. Please try again or fill in manually.`,
        });
      }
    } finally {
      setExtracting(false);
    }
  };

  const validate = () => {
    const missing = [];
    if (!workOrder.customer) missing.push("Customer");
    if (!workOrder.billingAddress) missing.push("Billing Address");
    if (!workOrder.problemDescription) missing.push("Problem Description");
    if (missing.length) {
      alert(`Please fill required fields: ${missing.join(", ")}`);
      return false;
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const form = new FormData();
    form.append("customer", workOrder.customer);
    form.append("workOrderNumber", workOrder.workOrderNumber || "");
    form.append("poNumber", workOrder.poNumber || "");
    form.append("siteLocation", workOrder.siteLocation || "");
    form.append("siteAddress", workOrder.siteAddress || "");
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);

    const willBeScheduled = !!workOrder.scheduledDate;
    const statusToSend = willBeScheduled
      ? "Scheduled"
      : workOrder.status || "Needs to be Scheduled";
    form.append("status", statusToSend);

    form.append("customerPhone", workOrder.customerPhone || "");
    form.append("customerEmail", workOrder.customerEmail || "");
    if (workOrder.assignedTo) form.append("assignedTo", workOrder.assignedTo);

    if (workOrder.scheduledDate) {
      form.append("scheduledDate", workOrder.scheduledDate);
      const computedEnd = toEndTimeFromStartISO(workOrder.scheduledDate);
      if (computedEnd) form.append("endTime", computedEnd);
    }

    if (pdfFile) form.append("workOrderPdf", pdfFile);
    if (estimatePdfFile) form.append("estimatePdf", estimatePdfFile);
    if (photoFile) form.append("photoFile", photoFile);

    try {
      setSubmitting(true);
      await api.post("/work-orders", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      if (willBeScheduled) navigate("/calendar");
      else navigate("/work-orders");
    } catch (err) {
      const msg =
        err?.response?.data?.error || err?.message || "Failed to save — check server logs";
      console.error("⚠️ Error adding work order:", err);
      alert(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="awo-page">
      <div className="awo-shell">
        <div className="awo-topbar">
          <div style={{ minWidth: 0 }}>
            <h2 className="awo-title">Add Work Order</h2>
            <div className="awo-subtitle">Create a new work order (PDFs/photos optional).</div>
          </div>

          <div className="awo-actions">
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={() => navigate(fromPath)}
            >
              Back
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate("/work-orders")}
            >
              Work Orders
            </button>
          </div>
        </div>

        <div className="awo-card">
          <div className="awo-card-header">
            <div>
              <div className="awo-card-title">Work Order Details</div>
              <div className="awo-card-subtitle">
                Required: Customer, Billing Address, Problem Description.
              </div>
            </div>
            {loadingRefs ? <span className="awo-pill">Loading lists…</span> : null}
          </div>

          <form className="awo-form" onSubmit={handleSubmit}>
            {/* ===== PDF Auto-Fill Section ===== */}
            <div className="awo-section awo-extract-section">
              <div className="awo-section-title">
                Quick Fill from PDF
              </div>

              <div className="awo-extract-box">
                <div className="awo-field" style={{ marginBottom: 0 }}>
                  <label className="awo-label">Upload Work Order PDF (Optional)</label>
                  <input
                    ref={extractPdfInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={handleExtractPdfChange}
                    className="awo-file"
                    disabled={extracting}
                  />
                  <div className="awo-help">
                    Upload a work order PDF to auto-fill form fields using OCR.
                    {extracting && " Extraction starts automatically..."}
                  </div>
                  {!extracting && <FileChip file={extractPdfFile} onRemove={removeExtractPdf} />}
                </div>

                {/* Extraction result messages */}
                {extractResult && (
                  <div
                    className={`awo-extract-result awo-extract-${extractResult.type}`}
                    style={{ marginTop: 12 }}
                  >
                    <div className="awo-extract-message">{extractResult.message}</div>
                    {extractResult.fields && extractResult.fields.length > 0 && (
                      <div className="awo-extract-fields">
                        <strong>Fields populated:</strong> {extractResult.fields.join(", ")}
                      </div>
                    )}
                    {extractResult.rawText && (
                      <div className="awo-extract-fields" style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>
                        <strong>OCR text preview:</strong> {extractResult.rawText}...
                      </div>
                    )}
                  </div>
                )}

                {/* Loading overlay */}
                {extracting && (
                  <div className="awo-extract-loading">
                    <div className="awo-extract-loading-content">
                      <div className="loading-spinner" style={{ width: 32, height: 32 }} />
                      <div style={{ marginTop: 8 }}>
                        Extracting information...
                        <br />
                        <small>This may take up to 30 seconds for scanned PDFs.</small>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ===== Identity / Contact ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Customer</div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">
                    Customer Name <span className="awo-req">*</span>
                  </label>
                  <input
                    name="customer"
                    list="customers-list"
                    value={workOrder.customer}
                    onChange={handleChange}
                    className="awo-input"
                    placeholder="Customer name"
                    autoComplete="off"
                  />
                  <datalist id="customers-list">
                    {customers.map((c) => (
                      <option key={c.id} value={c.name} />
                    ))}
                  </datalist>
                </div>

                {role !== "tech" ? (
                  <div className="awo-field">
                    <label className="awo-label">Assign To</label>
                    <select
                      name="assignedTo"
                      value={workOrder.assignedTo}
                      onChange={handleChange}
                      className="awo-select"
                    >
                      <option value="">— Unassigned —</option>
                      {techs.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.username}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="awo-field">
                    <label className="awo-label">Assign To</label>
                    <div className="awo-static">Tech login — assignment hidden</div>
                  </div>
                )}
              </div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">Customer Phone (optional)</label>
                  <input
                    name="customerPhone"
                    value={workOrder.customerPhone}
                    onChange={handleChange}
                    className="awo-input"
                    placeholder="(###) ###-####"
                  />
                </div>

                <div className="awo-field">
                  <label className="awo-label">Customer Email (optional)</label>
                  <input
                    name="customerEmail"
                    type="email"
                    value={workOrder.customerEmail}
                    onChange={handleChange}
                    className="awo-input"
                    placeholder="name@example.com"
                  />
                </div>
              </div>
            </div>

            {/* ===== Identifiers ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Identifiers</div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">Work Order #</label>
                  <input
                    name="workOrderNumber"
                    value={workOrder.workOrderNumber}
                    onChange={handleChange}
                    className="awo-input"
                    placeholder="Optional at creation"
                  />
                </div>

                <div className="awo-field">
                  <label className="awo-label">PO # (optional)</label>
                  <input
                    name="poNumber"
                    value={workOrder.poNumber}
                    onChange={handleChange}
                    className="awo-input"
                    placeholder="Enter PO number if available"
                  />
                </div>
              </div>
            </div>

            {/* ===== Site ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Site</div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">Site Location (Name)</label>
                  <input
                    name="siteLocation"
                    value={workOrder.siteLocation}
                    onChange={handleChange}
                    className="awo-input"
                    placeholder="Business / Building / Suite name"
                    autoComplete="off"
                  />
                </div>

                <div className="awo-field">
                  <label className="awo-label">Site Address</label>
                  <input
                    name="siteAddress"
                    ref={siteAddressInputRef}
                    value={workOrder.siteAddress}
                    onChange={handleChange}
                    onFocus={handleSiteAddressFocus}
                    placeholder="Start typing address…"
                    className="awo-input"
                  />
                </div>
              </div>
            </div>

            {/* ===== Billing + Problem ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Details</div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">
                    Billing Address <span className="awo-req">*</span>
                  </label>
                  <textarea
                    name="billingAddress"
                    rows={4}
                    value={workOrder.billingAddress}
                    onChange={handleChange}
                    className="awo-textarea"
                    placeholder={"Company / Name\nStreet\nCity, ST ZIP"}
                  />
                </div>

                <div className="awo-field">
                  <label className="awo-label">
                    Problem Description <span className="awo-req">*</span>
                  </label>
                  <textarea
                    name="problemDescription"
                    rows={4}
                    value={workOrder.problemDescription}
                    onChange={handleChange}
                    className="awo-textarea"
                    placeholder="Describe the issue…"
                  />
                </div>
              </div>
            </div>

            {/* ===== Scheduling ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Scheduling</div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">Status</label>
                  <select
                    name="status"
                    value={workOrder.status}
                    onChange={handleChange}
                    className="awo-select"
                  >
                    {STATUS_LIST.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <div className="awo-help">
                    If you set a Scheduled Date &amp; Time, status will be saved as{" "}
                    <strong>Scheduled</strong>.
                  </div>
                </div>

                <div className="awo-field">
                  <label className="awo-label">Scheduled Date &amp; Time</label>
                  <input
                    type="datetime-local"
                    name="scheduledDate"
                    value={workOrder.scheduledDate}
                    onChange={handleChange}
                    className="awo-input"
                  />
                  <div className="awo-help">
                    Default window: <strong>{DEFAULT_WINDOW_MIN} minutes</strong> (adjust later in
                    Calendar).
                  </div>
                </div>
              </div>
            </div>

            {/* ===== Uploads ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Attachments</div>

              <div className="awo-grid awo-grid-3">
                <div className="awo-field">
                  <label className="awo-label">Work Order PDF</label>
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={handlePdfChange}
                    className="awo-file"
                  />
                  <div className="awo-help">Sign-off sheet / work order packet.</div>
                  <FileChip file={pdfFile} onRemove={removePdf} />
                </div>

                <div className="awo-field">
                  <label className="awo-label">Estimate PDF</label>
                  <input
                    ref={estimateInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={handleEstimateChange}
                    className="awo-file"
                  />
                  <div className="awo-help">
                    Shows under <strong>Estimates</strong> on the Work Order.
                  </div>
                  <FileChip file={estimatePdfFile} onRemove={removeEstimate} />
                </div>

                <div className="awo-field">
                  <label className="awo-label">Photo</label>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoChange}
                    className="awo-file"
                  />
                  <div className="awo-help">Optional site photo / reference.</div>
                  <FileChip file={photoFile} onRemove={removePhoto} />
                </div>
              </div>
            </div>

            <div className="awo-footer">
              <button
                type="button"
                className="btn btn-outline-secondary"
                onClick={() => navigate(fromPath)}
              >
                Cancel
              </button>

              <button type="submit" className="btn btn-primary awo-submit" disabled={submitting}>
                {submitting ? "Saving…" : "Add Work Order"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
