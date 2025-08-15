// File: src/AddWorkOrder.js
import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./AddWorkOrder.css";

/** Decode role from the JWT stored in localStorage (dispatcher/admin/tech) */
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

/** Load a script tag exactly once */
function ensureScript(id, src) {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id);
    if (existing) {
      if (existing.getAttribute("data-loaded") === "true") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", (e) => reject(e));
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
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);
  });
}

/** Ensure Google Maps JS + Places lib + gmpx web components are available */
async function ensureMapsAndGmpx() {
  const key = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("⚠️ REACT_APP_GOOGLE_MAPS_API_KEY missing; Places autocomplete disabled.");
    return false;
  }

  // 1) Google Maps JS (with Places)
  if (!(window.google && window.google.maps && window.google.maps.places)) {
    await ensureScript(
      "gmaps-js",
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
        key
      )}&libraries=places&v=weekly&loading=async`
    );
  }

  // 2) Extended Component Library (registers <gmpx-place-autocomplete/>)
  if (!customElements.get("gmpx-place-autocomplete")) {
    await ensureScript(
      "gmpx-lib",
      "https://unpkg.com/@googlemaps/extended-component-library@latest/dist/extended-component-library.js"
    );
  }
  return true;
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
    assignedTo: "", // user id (string)
  });

  // files
  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  // lists
  const [customers, setCustomers] = useState([]);
  const [assignees, setAssignees] = useState([]); // techs + allowed extras (Jeff, tech1)

  // ui
  const [submitting, setSubmitting] = useState(false);

  // refs for Places
  const siteInputRef = useRef(null);
  const gmpxRef = useRef(null);

  // ---------- load reference data + Google Places Element once
  useEffect(() => {
    // Load customers
    api
      .get("/customers")
      .then((r) => setCustomers(r.data || []))
      .catch((e) => console.error("Error loading customers:", e));

    // Load assignable users (techs + Jeff, tech1; Mark excluded by backend)
    api
      .get("/users", { params: { assignees: 1 } })
      .then((r) => setAssignees(r.data || []))
      .catch((e) => console.error("Error loading assignees:", e));

    // Ensure maps + gmpx are present and then bind autocomplete
    (async () => {
      const ok = await ensureMapsAndGmpx();
      if (!ok) return;

      // If the element is in the DOM, wire its event
      const el = gmpxRef.current;
      if (!el || !siteInputRef.current) return;

      // Listen for place selection
      const onPlace = (ev) => {
        const place = ev?.detail?.place || {};
        // New Places format uses camelCase keys; keep legacy fallbacks
        const formatted =
          place.formattedAddress ||
          place.formatted_address ||
          place.displayName?.text ||
          siteInputRef.current.value ||
          "";

        setWorkOrder((prev) => ({
          ...prev,
          siteLocation: formatted,
        }));
      };

      el.addEventListener("gmpx-placechange", onPlace);

      // Clean up on unmount
      return () => el.removeEventListener("gmpx-placechange", onPlace);
    })();
  }, []);

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

        {/* Site Location (Google Places Web Component) */}
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
            {/* The suggestions UI is provided by this web component */}
            <gmpx-place-autocomplete
              ref={gmpxRef}
              for="siteLocationInput"
              // optional: restrict to US/CA; remove if you want global
              country-codes="US,CA"
              // positioning of the dropdown (end = bottom of the input)
              suggestions-overlay-position="end"
              // show only addresses (not businesses). If you want both, remove this.
              type="address"
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
