// File: src/AddWorkOrder.js

import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./AddWorkOrder.css";

export default function AddWorkOrder() {
  const navigate = useNavigate();

  // ---- form state
  const [workOrder, setWorkOrder] = useState({
    customer: "",
    poNumber: "",
    siteLocation: "",
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "" // user id as string
  });

  // files
  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  // lists
  const [customers, setCustomers] = useState([]);
  const [techs, setTechs] = useState([]);

  // google places
  const siteInputRef = useRef(null);
  const autocompleteRef = useRef(null);

  // ---------- load reference data + Places script once
  useEffect(() => {
    // customers
    api.get("/customers")
      .then(r => setCustomers(r.data || []))
      .catch(e => console.error("Error loading customers:", e));

    // techs (users)
    api.get("/users")
      .then(r => setTechs(r.data || []))
      .catch(e => console.error("Error loading users:", e));

    // google places script
    const key = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
    if (!key || key === "YOUR_ACTUAL_KEY_HERE") {
      console.warn("Google Maps API key missing; Places autocomplete disabled.");
      return;
    }
    const existing = document.getElementById("gmaps-script");
    if (existing) {
      initAutocomplete();
      return;
    }
    const script = document.createElement("script");
    script.id = "gmaps-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
    script.async = true;
    script.onload = initAutocomplete;
    script.onerror = () => console.error("Failed to load Google Maps script");
    document.body.appendChild(script);
    // no cleanup needed; script stays for app lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- wire up Google Places Autocomplete on the input
  function initAutocomplete() {
    if (!window.google || !siteInputRef.current) return;

    // IMPORTANT: do NOT call setFields (removed in Places v3)
    const ac = new window.google.maps.places.Autocomplete(siteInputRef.current, {
      types: ["address"]
    });
    ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      const addr = (place && place.formatted_address) || siteInputRef.current.value || "";
      setWorkOrder(prev => ({ ...prev, siteLocation: addr }));
    });
    autocompleteRef.current = ac;
  }

  // ---------- helpers
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
    if (workOrder.assignedTo) {
      // your backend currently ignores this field in the INSERT,
      // but it won't hurt to send it. Once the API is updated, it'll be used.
      form.append("assignedTo", workOrder.assignedTo);
    }
    if (pdfFile) form.append("pdfFile", pdfFile);       // <-- MUST be pdfFile
    if (photoFile) form.append("photoFile", photoFile); // <-- MUST be photoFile

    try {
      await api.post("/work-orders", form, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      navigate("/work-orders");
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.message ||
        "Failed to save — check server logs";
      console.error("⚠️ Error adding work order:", err);
      alert(msg);
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
            {customers.map(c => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>

        {/* Assign to Tech */}
        <div className="form-group">
          <label>Assign To</label>
          <select
            name="assignedTo"
            value={workOrder.assignedTo}
            onChange={handleChange}
            className="form-select-custom"
          >
            <option value="">— Unassigned —</option>
            {techs.map(u => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        </div>

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

        {/* Site Location (Google Places) */}
        <div className="form-group">
          <label>Site Location</label>
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
          <label>Billing Address</label>
          <textarea
            name="billingAddress"
            rows={3}
            value={workOrder.billingAddress}
            onChange={handleChange}
            className="form-textarea-custom"
            placeholder="Company / Name&#10;Street&#10;City, ST ZIP"
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

        <button type="submit" className="submit-btn">
          Add Work Order
        </button>
      </form>
    </div>
  );
}
