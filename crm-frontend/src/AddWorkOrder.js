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

// —— script helpers
function ensureScript(id, src) {
  return new Promise((resolve, reject) => {
    const prev = document.getElementById(id);
    if (prev) {
      if (prev.getAttribute("data-loaded") === "true") return resolve();
      prev.addEventListener("load", () => resolve());
      prev.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = src;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      s.setAttribute("data-loaded", "true");
      resolve();
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function loadMapsAndPlaces() {
  const key = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("REACT_APP_GOOGLE_MAPS_API_KEY missing");
    return false;
  }
  // Load Maps JS (+ Places)
  if (!(window.google && window.google.maps && window.google.maps.places)) {
    await ensureScript(
      "gmaps-js",
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
        key
      )}&libraries=places&v=weekly&loading=async`
    );
  }
  return true;
}

async function loadGmpxIfNeeded() {
  if (!customElements.get("gmpx-place-autocomplete")) {
    await ensureScript(
      "gmpx-lib",
      "https://unpkg.com/@googlemaps/extended-component-library@latest/dist/extended-component-library.js"
    );
  }
}

export default function AddWorkOrder() {
  const navigate = useNavigate();
  const role = decodeRoleFromJWT();

  const [workOrder, setWorkOrder] = useState({
    customer: "",
    poNumber: "",
    siteLocation: "",
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "",
  });

  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const siteInputRef = useRef(null);
  const acRef = useRef(null);
  const gmpxRef = useRef(null);

  // load data
  useEffect(() => {
    api.get("/customers").then(r => setCustomers(r.data || [])).catch(console.error);
    api.get("/users", { params: { assignees: 1 } })
      .then(r => setAssignees(r.data || []))
      .catch(console.error);
  }, []);

  // wire autocomplete (prefer legacy → fallback to gmpx)
  useEffect(() => {
    let cleanup = () => {};

    (async () => {
      const ok = await loadMapsAndPlaces();
      if (!ok || !siteInputRef.current) return;

      // 1) Try legacy Autocomplete first (this is what worked for you before)
      const LegacyAuto = window.google?.maps?.places?.Autocomplete;
      if (LegacyAuto) {
        const ac = new LegacyAuto(siteInputRef.current, {
          // 'geocode' gives broader address predictions than 'address'
          types: ["geocode"],
          fields: ["formatted_address", "name", "address_components", "geometry"],
        });

        // If you want to restrict to US/CA, uncomment:
        // ac.setComponentRestrictions({ country: ["us", "ca"] });

        const listener = ac.addListener("place_changed", () => {
          const place = ac.getPlace() || {};
          const formatted =
            place.formatted_address ||
            place.name ||
            siteInputRef.current.value ||
            "";
          setWorkOrder(prev => ({ ...prev, siteLocation: formatted }));
        });

        acRef.current = ac;
        cleanup = () => listener.remove();
        return;
      }

      // 2) Fallback to the gmpx web component if legacy isn’t available
      await loadGmpxIfNeeded();
      const el = document.getElementById("gmpx-autocomplete-hook");
      if (!el) return;

      const onPlace = (ev) => {
        const p = ev?.detail?.place || {};
        const formatted =
          p.formattedAddress ||
          p.formatted_address ||
          p.displayName?.text ||
          siteInputRef.current.value ||
          "";
        setWorkOrder(prev => ({ ...prev, siteLocation: formatted }));
      };
      el.addEventListener("gmpx-placechange", onPlace);

      cleanup = () => el.removeEventListener("gmpx-placechange", onPlace);
    })();

    return () => cleanup();
  }, []);

  // helpers
  const extractCustomerFromBilling = (addr) => {
    if (!addr) return "";
    const first = addr.split("\n").map(s => s.trim()).filter(Boolean)[0];
    return first || "";
    };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setWorkOrder(prev => {
      const upd = { ...prev, [name]: value };

      if (name === "customer") {
        const found = customers.find(c => c.name === value);
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
    form.append("poNumber", workOrder.poNumber || "");
    form.append("siteLocation", workOrder.siteLocation || "");
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);
    form.append("status", workOrder.status || "Needs to be Scheduled");
    if (workOrder.assignedTo) form.append("assignedTo", workOrder.assignedTo);
    if (pdfFile) form.append("pdfFile", pdfFile);
    if (photoFile) form.append("photoFile", photoFile);

    try {
      setSubmitting(true);
      await api.post("/work-orders", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      navigate("/work-orders");
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || "Failed to save — check server logs";
      console.error("Add work order error:", err);
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
          <label>Customer Name</label>
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

        {/* Assign to Tech (hide for tech users) */}
        {role !== "tech" && (
          <div className="form-group">
            <label>Assign To</label>
            <select
              name="assignedTo"
              value={workOrder.assignedTo}
              onChange={handleChange}
              className="form-select-custom"
            >
              <option value="">— Unassigned —</option>
              {assignees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* PO Number */}
        <div className="form-group">
          <label>PO Number</label>
          <input
            name="poNumber"
            value={workOrder.poNumber}
            onChange={handleChange}
            className="form-control-custom"
            placeholder="Optional"
            autoComplete="off"
          />
        </div>

        {/* Site Location (Prefer legacy Places; fallback gmpx) */}
        <div className="form-group">
          <label>Site Location</label>
          <div style={{ position: "relative" }}>
            <input
              id="siteLocationInput"
              name="siteLocation"
              ref={siteInputRef}
              value={workOrder.siteLocation}
              onChange={handleChange}
              placeholder="Start typing address…"
              className="form-control-custom"
              autoComplete="off"
            />
            {/* Fallback element; harmless if legacy Autocomplete is in use */}
            <gmpx-place-autocomplete
              id="gmpx-autocomplete-hook"
              for="siteLocationInput"
              country-codes="US,CA"
              suggestions-overlay-position="end"
              type="address"
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            />
          </div>
        </div>

        {/* Billing Address */}
        <div className="form-group">
          <label>Billing Address</label>
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
          <label>Problem Description</label>
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
          <label>Status</label>
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
          <label>Upload PDF</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handlePdfChange}
            className="form-file-custom"
          />
        </div>

        {/* Photo Upload (optional, single) */}
        <div className="form-group">
          <label>Upload Photo</label>
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
