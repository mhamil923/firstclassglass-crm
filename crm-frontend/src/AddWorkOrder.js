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
  const role = decodeRoleFromJWT(); // 'dispatcher' | 'admin' | 'tech'

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
  const [techs, setTechs] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // refs for the Place Autocomplete Element
  const placeElRef = useRef(null);

  useEffect(() => {
    // Load customers + techs
    Promise.all([
      api.get("/customers"),
      api.get("/users", { params: { assignees: 1 } }), // dispatcher list (techs + extras)
    ])
      .then(([c, u]) => {
        setCustomers(c.data || []);
        setTechs(u.data || []);
      })
      .catch((e) => console.error("Error loading customers/users:", e));

    // Load Google Maps + Extended Component Library
    const key = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
    if (!key) {
      console.warn("Google Maps key missing; Places autocomplete disabled.");
      return;
    }

    const ensureScript = (id, src) =>
      new Promise((resolve, reject) => {
        const existing = document.getElementById(id);
        if (existing) return resolve();
        const s = document.createElement("script");
        s.id = id;
        s.src = src;
        s.async = true;
        s.defer = true;
        s.onload = resolve;
        s.onerror = reject;
        document.body.appendChild(s);
      });

    const mapsUrl = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async`;
    const extUrl =
      "https://unpkg.com/@googlemaps/extended-component-library@0.6/dist/extended-component-library.js";

    Promise.all([
      ensureScript("gmaps-v3", mapsUrl),
      ensureScript("gmpx-lib", extUrl),
    ])
      .then(() => customElements.whenDefined("gmpx-place-autocomplete"))
      .then(() => {
        // Wire events once element is in the DOM
        const el = placeElRef.current;
        if (!el) return;

        // Initialize with any existing value
        el.value = workOrder.siteLocation || "";

        // On selection from suggestions
        el.addEventListener("gmpx-placechange", () => {
          const place = el.getPlace?.();
          const formatted =
            place?.formattedAddress ||
            place?.displayName ||
            el.value ||
            "";
          setWorkOrder((prev) => ({ ...prev, siteLocation: formatted }));
        });

        // Keep state in sync while typing
        el.addEventListener("input", () => {
          setWorkOrder((prev) => ({ ...prev, siteLocation: el.value }));
        });
      })
      .catch((e) => console.error("Maps/Places load failed:", e));
  }, []);

  // Keep element in sync if we programmatically change state
  useEffect(() => {
    const el = placeElRef.current;
    if (el && el.value !== workOrder.siteLocation) {
      el.value = workOrder.siteLocation || "";
    }
  }, [workOrder.siteLocation]);

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

        {/* Site Location (Place Autocomplete Element) */}
        <div className="form-group">
          <label>Site Location</label>
          {/* The custom element renders an <input> with Places suggestions */}
          <gmpx-place-autocomplete
            ref={placeElRef}
            placeholder="Start typing address…"
            style={{
              display: "block",
              width: "100%",
              height: "40px",
              border: "1px solid #ced4da",
              borderRadius: "6px",
              padding: "0 10px",
              background: "#fff",
            }}
          ></gmpx-place-autocomplete>
          <small className="help-text">
            Start typing and choose a suggestion to auto-fill the full address.
          </small>
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
            onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
            className="form-file-custom"
          />
        </div>

        {/* Photo Upload */}
        <div className="form-group">
          <label>Upload Photo</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setPhotoFile(e.target.files?.[0] || null)}
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
