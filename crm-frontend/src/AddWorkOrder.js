// File: src/AddWorkOrder.js
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
    const statusToSend = willBeScheduled ? "Scheduled" : (workOrder.status || "Needs to be Scheduled");
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
        err?.response?.data?.error ||
        err?.message ||
        "Failed to save — check server logs";
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
            {/* ===== Identity / Contact ===== */}
            <div className="awo-section">
              <div className="awo-section-title">Customer</div>

              <div className="awo-grid awo-grid-2">
                <div className="awo-field">
                  <label className="awo-label">Customer Name <span className="awo-req">*</span></label>
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
                  <label className="awo-label">Billing Address <span className="awo-req">*</span></label>
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
                  <label className="awo-label">Problem Description <span className="awo-req">*</span></label>
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
                    If you set a Scheduled Date &amp; Time, status will be saved as <strong>Scheduled</strong>.
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
                    Default window: <strong>{DEFAULT_WINDOW_MIN} minutes</strong> (adjust later in Calendar).
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
                  <input type="file" accept="application/pdf" onChange={handlePdfChange} className="awo-file" />
                  <div className="awo-help">Sign-off sheet / work order packet.</div>
                </div>

                <div className="awo-field">
                  <label className="awo-label">Estimate PDF</label>
                  <input type="file" accept="application/pdf" onChange={handleEstimateChange} className="awo-file" />
                  <div className="awo-help">Shows under <strong>Estimates</strong> on the Work Order.</div>
                </div>

                <div className="awo-field">
                  <label className="awo-label">Photo</label>
                  <input type="file" accept="image/*" onChange={handlePhotoChange} className="awo-file" />
                  <div className="awo-help">Optional site photo / reference.</div>
                </div>
              </div>
            </div>

            <div className="awo-footer">
              <button type="button" className="btn btn-outline-secondary" onClick={() => navigate(fromPath)}>
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
