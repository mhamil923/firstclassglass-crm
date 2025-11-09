// File: src/AddWorkOrder.js
import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
  // localDateTimeStr is from <input type="datetime-local"> e.g. "2025-11-02T08:00"
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
  return `${eh}:${em}`; // "HH:mm"
}

export default function AddWorkOrder() {
  const navigate = useNavigate();
  const role = decodeRoleFromJWT();

  // ---- form state
  const [workOrder, setWorkOrder] = useState({
    customer: "",
    workOrderNumber: "",
    poNumber: "",
    siteLocation: "", // name of the place (e.g., "Panda Express")
    siteAddress: "",  // street address (autocomplete)
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "",
    customerPhone: "",
    customerEmail: "",
    scheduledDate: "", // "YYYY-MM-DDTHH:mm" (local time)
  });

  const [pdfFile, setPdfFile] = useState(null);                 // Work Order sign-off PDF
  const [estimatePdfFile, setEstimatePdfFile] = useState(null); // Estimate PDF
  const [photoFile, setPhotoFile] = useState(null);

  const [customers, setCustomers] = useState([]);
  const [techs, setTechs] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // Autocomplete for Site Address
  const siteAddressInputRef = useRef(null);
  const autocompleteRef = useRef(null);
  const gmapsReadyRef = useRef(false);

  // ---------- load reference data
  useEffect(() => {
    api
      .get("/customers")
      .then((r) => setCustomers(r.data || []))
      .catch((e) => console.error("Error loading customers:", e));

    api
      .get("/users", { params: { assignees: 1 } })
      .then((r) => {
        const list = (r.data || []).filter((u) => u.username !== "Mark");
        setTechs(list);
      })
      .catch((e) => console.error("Error loading assignees:", e));
  }, []);

  // ---------- auto-toggle status when picking a schedule
  useEffect(() => {
    if (workOrder.scheduledDate && workOrder.status !== "Scheduled") {
      setWorkOrder((prev) => ({ ...prev, status: "Scheduled" }));
    }
  }, [workOrder.scheduledDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Google Maps Autocomplete (for Site Address only)
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
        const addr =
          place?.formatted_address ||
          place?.name ||
          siteAddressInputRef.current.value;
        setWorkOrder((prev) => ({ ...prev, siteAddress: addr })); // fill address
      });
      autocompleteRef.current = ac;
    } catch (e) {
      console.error("Failed to init Places Autocomplete:", e);
    }
  }

  const handleSiteAddressFocus = () => {
    if (!autocompleteRef.current) {
      initAutocomplete();
    }
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
        // Optional auto-fill of customer from the first line of billing address
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

  // ---------- submit
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const form = new FormData();
    form.append("customer", workOrder.customer);
    form.append("workOrderNumber", workOrder.workOrderNumber || "");
    form.append("poNumber", workOrder.poNumber || "");
    form.append("siteLocation", workOrder.siteLocation || ""); // name
    form.append("siteAddress", workOrder.siteAddress || "");   // address
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);

    // If scheduled, force status = Scheduled so it appears on the calendar feed
    const willBeScheduled = !!workOrder.scheduledDate;
    const statusToSend = willBeScheduled ? "Scheduled" : (workOrder.status || "Needs to be Scheduled");
    form.append("status", statusToSend);

    form.append("customerPhone", workOrder.customerPhone || "");
    form.append("customerEmail", workOrder.customerEmail || "");
    if (workOrder.assignedTo) form.append("assignedTo", workOrder.assignedTo);

    // Send schedule fields
    if (workOrder.scheduledDate) {
      // Server accepts "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm"
      form.append("scheduledDate", workOrder.scheduledDate);

      // Also provide an endTime (start + DEFAULT_WINDOW_MIN) so scheduledEnd is explicit
      const computedEnd = toEndTimeFromStartISO(workOrder.scheduledDate); // "HH:mm"
      if (computedEnd) form.append("endTime", computedEnd);
    }

    // Files — field names normalized by server (workorderpdf / estimatepdf)
    if (pdfFile) form.append("workOrderPdf", pdfFile);
    if (estimatePdfFile) form.append("estimatePdf", estimatePdfFile);
    if (photoFile) form.append("photoFile", photoFile);

    try {
      setSubmitting(true);
      await api.post("/work-orders", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      // If we scheduled it here, go straight to the calendar so it's visible immediately
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
    <div className="add-workorder-container">
      <form className="add-workorder-card" onSubmit={handleSubmit}>
        <h2 className="add-workorder-title">Add Work Order</h2>

        {/* Customer */}
        <div className="form-group">
          <label className="form-label">Customer Name</label>
          <input
            name="customer"
            list="customers-list"
            value={workOrder.customer}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="Customer name"
            autoComplete="off"
          />
          <datalist id="customers-list">
            {customers.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>

        {/* Optional contact info */}
        <div className="form-group">
          <label className="form-label">Customer Phone (optional)</label>
          <input
            name="customerPhone"
            value={workOrder.customerPhone}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="(###) ###-####"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Customer Email (optional)</label>
          <input
            name="customerEmail"
            type="email"
            value={workOrder.customerEmail}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="name@example.com"
          />
        </div>

        {/* Assign tech (hidden for tech role) */}
        {role !== "tech" && (
          <div className="form-group">
            <label className="form-label">Assign To</label>
            <select
              name="assignedTo"
              value={workOrder.assignedTo}
              onChange={handleChange}
              className="form-select-custom"
            >
              <option value="">— Unassigned —</option>
              {techs.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Work Order Number */}
        <div className="form-group">
          <label className="form-label">Work Order #</label>
          <input
            name="workOrderNumber"
            value={workOrder.workOrderNumber}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="Optional at creation"
          />
        </div>

        {/* PO Number */}
        <div className="form-group">
          <label className="form-label">PO # (optional)</label>
          <input
            name="poNumber"
            value={workOrder.poNumber}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="Enter PO number if available"
          />
        </div>

        {/* Site Location (Name) */}
        <div className="form-group">
          <label className="form-label">Site Location (Name)</label>
          <input
            name="siteLocation"
            value={workOrder.siteLocation}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="Business / Building / Suite name (e.g., Panda Express)"
            autoComplete="off"
          />
        </div>

        {/* Site Address (Autocomplete) */}
        <div className="form-group">
          <label className="form-label">Site Address</label>
          <input
            name="siteAddress"
            ref={siteAddressInputRef}
            value={workOrder.siteAddress}
            onChange={handleChange}
            onFocus={handleSiteAddressFocus}
            placeholder="Start typing address…"
            className="form-control-custom"
          />
        </div>

        {/* Billing Address */}
        <div className="form-group">
          <label className="form-label">Billing Address</label>
          <textarea
            name="billingAddress"
            rows={3}
            value={workOrder.billingAddress}
            onChange={handleChange}
            className="form-textarea-custom"
            placeholder={"Company / Name\nStreet\nCity, ST ZIP"}
          />
        </div>

        {/* Problem Description */}
        <div className="form-group">
          <label className="form-label">Problem Description</label>
          <textarea
            name="problemDescription"
            rows={4}
            value={workOrder.problemDescription}
            onChange={handleChange}
            className="form-textarea-custom"
            placeholder="Describe the issue…"
          />
        </div>

        {/* Status */}
        <div className="form-group">
          <label className="form-label">Status</label>
          <select
            name="status"
            value={workOrder.status}
            onChange={handleChange}
            className="form-select-custom"
          >
            {STATUS_LIST.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <small className="help-text">
            If you set a Scheduled Date &amp; Time below, status will be saved as{" "}
            <strong>Scheduled</strong> so it appears on the Calendar.
          </small>
        </div>

        {/* Scheduled Date & Time */}
        <div className="form-group">
          <label className="form-label">Scheduled Date & Time</label>
          <input
            type="datetime-local"
            name="scheduledDate"
            value={workOrder.scheduledDate}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="mm/dd/yyyy, --:-- --"
          />
          <small className="help-text">
            Calendar window defaults to {DEFAULT_WINDOW_MIN} minutes. You can adjust later from the Calendar.
          </small>
        </div>

        {/* Uploads */}
        <div className="form-group">
          <label className="form-label">Upload Work Order PDF</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handlePdfChange}
            className="form-file-custom"
          />
        </div>

        {/* Upload Estimate PDF */}
        <div className="form-group">
          <label className="form-label">Upload Estimate PDF</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handleEstimateChange}
            className="form-file-custom"
          />
          <small className="help-text">
            This will appear under <strong>Estimates</strong> on the Work Order.
          </small>
        </div>

        <div className="form-group">
          <label className="form-label">Upload Photo</label>
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            className="form-file-custom"
          />
        </div>

        <button type="submit" className="submit-btn" disabled={submitting}>
          {submitting ? "Saving..." : "Add Work Order"}
        </button>
      </form>
    </div>
  );
}
