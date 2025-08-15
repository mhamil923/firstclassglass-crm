// File: src/AddWorkOrder.js
import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./AddWorkOrder.css";

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

export default function AddWorkOrder() {
  const navigate = useNavigate();
  const role = decodeRoleFromJWT(); // "dispatcher", "admin", "tech", etc.

  // ---- form state
  const [workOrder, setWorkOrder] = useState({
    customer: "",
    poNumber: "",
    siteLocation: "",
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "",

    // optional contact (not required)
    customerPhone: "",
    customerEmail: "",
  });

  // files
  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  // lists
  const [customers, setCustomers] = useState([]);
  const [techs, setTechs] = useState([]);

  // ui
  const [submitting, setSubmitting] = useState(false);

  // google places
  const siteInputRef = useRef(null);
  const autocompleteRef = useRef(null);

  // ---------- load reference data + Places script once
  useEffect(() => {
    // Load customers and the "assignees" list (techs + Jeff & other extras)
    Promise.all([
      api.get("/customers"),
      api.get("/users", { params: { assignees: 1 } }), // <-- ensures Jeff is included
    ])
      .then(([c, u]) => {
        setCustomers(c.data || []);
        setTechs(u.data || []);
      })
      .catch((e) => console.error("Error loading customers/users:", e));

// ---------- load Google Places robustly (v=weekly + importLibrary) ----------
useEffect(() => {
  const key = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("Google Maps API key missing; Places disabled.");
    return;
  }

  const ensurePlacesAndInit = async () => {
    // 1) load script if needed
    if (!window.google || !window.google.maps) {
      await new Promise((resolve, reject) => {
        // avoid adding duplicates
        const existing = document.querySelector('script[data-gmaps="1"]');
        if (existing) {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', reject, { once: true });
          return;
        }
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly&libraries=places&loading=async`;
        s.async = true;
        s.defer = true;
        s.dataset.gmaps = "1";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    // 2) explicitly import the Places lib (new pattern)
    if (window.google?.maps?.importLibrary) {
      await window.google.maps.importLibrary("places");
    }

    // 3) init
    initAutocomplete();
  };

  ensurePlacesAndInit().catch((e) =>
    console.error("Failed to load Google Maps:", e)
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

  // ---------- wire up Google Places Autocomplete on the input
function initAutocomplete(retry = 8) {
  const el = siteInputRef.current;
  const g = window.google;
  if (!el) return;

  if (!g?.maps?.places?.Autocomplete) {
    if (retry > 0) {
      // tiny backoff to wait for the library to hydrate
      return setTimeout(() => initAutocomplete(retry - 1), 200);
    }
    console.error("Places Autocomplete not available.");
    return;
  }

  const ac = new g.maps.places.Autocomplete(el, {
    // show addresses; you can also try ["geocode"]
    types: ["address"],
    // only ask for what we use (helps stability)
    fields: ["formatted_address", "name", "place_id"],
  });

  ac.addListener("place_changed", () => {
    const place = ac.getPlace();
    const addr =
      (place && (place.formatted_address || place.name)) ||
      el.value ||
      "";
    setWorkOrder((prev) => ({ ...prev, siteLocation: addr }));
  });

  autocompleteRef.current = ac;
}

  // ---------- helpers
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
        if (found?.billingAddress) {
          upd.billingAddress = found.billingAddress;
        }
      }

      if (name === "billingAddress") {
        const first = extractCustomerFromBilling(value);
        // only auto-fill customer if user hasn't set it explicitly
        const prevAuto = extractCustomerFromBilling(prev.billingAddress || "");
        if (!prev.customer || prev.customer === prevAuto) {
          upd.customer = first;
        }
      }

      return upd;
    });
  };

  const handlePdfChange = (e) => setPdfFile(e.target.files?.[0] || null);
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
    form.append("poNumber", workOrder.poNumber || "");
    form.append("siteLocation", workOrder.siteLocation || "");
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);
    form.append("status", workOrder.status || "Needs to be Scheduled");

    // optional
    form.append("customerPhone", workOrder.customerPhone || "");
    form.append("customerEmail", workOrder.customerEmail || "");

    // server supports assignedTo on create
    if (workOrder.assignedTo) form.append("assignedTo", workOrder.assignedTo);

    // field names must match server.js (pdfFile / photoFile)
    if (pdfFile) form.append("pdfFile", pdfFile);
    if (photoFile) form.append("photoFile", photoFile);

    try {
      setSubmitting(true);
      await api.post("/work-orders", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      navigate("/work-orders");
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

        {/* optional contact */}
        <div className="form-group">
          <label className="form-label">Customer Phone (optional)</label>
          <input
            name="customerPhone"
            value={workOrder.customerPhone}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="(###) ###-####"
            autoComplete="tel"
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
            autoComplete="email"
          />
        </div>

        {/* Assign to Tech (hide for tech users) */}
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

        {/* PO Number */}
        <div className="form-group">
          <label className="form-label">PO Number</label>
          <input
            name="poNumber"
            value={workOrder.poNumber}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="Optional"
            autoComplete="off"
          />
        </div>

        {/* Site Location (Google Places) */}
        <div className="form-group">
          <label className="form-label">Site Location</label>
          <input
            name="siteLocation"
            ref={siteInputRef}
            value={workOrder.siteLocation}
            onChange={handleChange}
            placeholder="Start typing address…"
            className="form-control-custom"
            autoComplete="off"
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
            <option>Needs to be Scheduled</option>
            <option>Scheduled</option>
            <option>Waiting for Approval</option>
            <option>Waiting on Parts</option>
            <option>Completed</option>
          </select>
        </div>

        {/* PDF Upload */}
        <div className="form-group">
          <label className="form-label">Upload PDF</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handlePdfChange}
            className="form-file-custom"
          />
        </div>

        {/* Photo Upload (optional, single) */}
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
