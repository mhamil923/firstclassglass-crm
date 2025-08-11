// File: src/AddWorkOrder.js

import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";                   // axios wrapper w/ JWT interceptor
import "./AddWorkOrder.css";              // your styles

export default function AddWorkOrder() {
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState({
    customer: "",
    poNumber: "",
    siteLocation: "",
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "" // user id (string)
  });

  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  const [customers, setCustomers] = useState([]);
  const [techs, setTechs] = useState([]); // users from /users
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const siteInputRef = useRef(null);
  const autocompleteRef = useRef(null);

  // Load customers + users (techs) + Google Places
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      setErr("");

      try {
        const [custRes, usersRes] = await Promise.all([
          api.get("/customers"),
          api.get("/users") // returns [{id, username}]
        ]);
        if (!cancelled) {
          setCustomers(custRes.data || []);
          setTechs(usersRes.data || []);
        }
      } catch (e) {
        console.error("Bootstrap load failed:", e);
        if (!cancelled) setErr(e?.response?.data?.error || e.message || "Failed to load data.");
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Load Google Places (optional)
      const existing = document.getElementById("gmaps-script");
      const apiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
      if (apiKey && !existing) {
        const script = document.createElement("script");
        script.id = "gmaps-script";
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
        script.async = true;
        script.onload = initAutocomplete;
        document.body.appendChild(script);
      } else {
        initAutocomplete();
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  function initAutocomplete() {
    if (window.google && siteInputRef.current && !autocompleteRef.current) {
      autocompleteRef.current = new window.google.maps.places.Autocomplete(
        siteInputRef.current,
        { types: ["address"] }
      );
      // setFields is deprecated on Places V3; we'll just read place when available
      autocompleteRef.current.addListener("place_changed", () => {
        const place = autocompleteRef.current.getPlace();
        const addr =
          place?.formatted_address ||
          siteInputRef.current?.value ||
          "";
        setWorkOrder(o => ({ ...o, siteLocation: addr }));
      });
    }
  }

  // helper to grab first line of billing for auto‐customer
  const extractCustomerFromBilling = addr => {
    if (!addr) return "";
    const [first] = addr.split("\n").map(l => l.trim()).filter(Boolean);
    return first || "";
  };

  const handleChange = e => {
    const { name, value } = e.target;
    setWorkOrder(prev => {
      const upd = { ...prev, [name]: value };
      if (name === "customer") {
        const found = customers.find(c => c.name === value);
        if (found) upd.billingAddress = found.billingAddress || "";
      }
      if (name === "billingAddress") {
        const first = extractCustomerFromBilling(value);
        // keep auto-fill behavior only if user hasn’t typed a different customer yet
        if (!prev.customer || prev.customer === extractCustomerFromBilling(prev.billingAddress)) {
          upd.customer = first;
        }
      }
      return upd;
    });
  };

  const handlePdfChange = (e) => {
    const f = e.target.files?.[0] || null;
    if (f && f.type !== "application/pdf") {
      setErr("PDF must be a .pdf file.");
      e.target.value = "";
      return;
    }
    setErr("");
    setPdfFile(f);
  };

  const handlePhotoChange = (e) => {
    const f = e.target.files?.[0] || null;
    // Optional: size/type checks
    setPhotoFile(f);
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setErr("");
    setSubmitting(true);

    try {
      // Build multipart form-data; DO NOT set Content-Type manually
      const fd = new FormData();
      fd.append("customer", workOrder.customer);
      fd.append("poNumber", workOrder.poNumber);
      fd.append("siteLocation", workOrder.siteLocation);
      fd.append("billingAddress", workOrder.billingAddress);
      fd.append("problemDescription", workOrder.problemDescription);
      fd.append("status", workOrder.status);
      if (workOrder.assignedTo) fd.append("assignedTo", String(workOrder.assignedTo));

      if (pdfFile)   fd.append("pdfFile", pdfFile);     // exact field names server expects
      if (photoFile) fd.append("photoFile", photoFile); // exact field names server expects

      await api.post("/work-orders", fd);
      navigate("/work-orders");
    } catch (error) {
      console.error("Create work order failed:", error);
      const msg = error?.response?.data?.error || error?.message || "Failed to create work order.";
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="add-workorder-container">
      <form className="add-workorder-card" onSubmit={handleSubmit}>
        <h2 className="add-workorder-title">Add Work Order</h2>

        {err ? (
          <div className="error-banner">
            {err}
          </div>
        ) : null}

        {loading ? (
          <div style={{ padding: 12 }}>Loading…</div>
        ) : (
          <>
            {/* Customer */}
            <div className="form-group">
              <label>Customer Name</label>
              <input
                name="customer"
                list="customers-list"
                value={workOrder.customer}
                onChange={handleChange}
                className="form-control-custom"
                placeholder="Start typing or pick from history…"
                required
              />
              <datalist id="customers-list">
                {customers.map(c => <option key={c.id} value={c.name} />)}
              </datalist>
            </div>

            {/* PO Number */}
            <div className="form-group">
              <label>PO Number</label>
              <input
                name="poNumber"
                value={workOrder.poNumber}
                onChange={handleChange}
                className="form-control-custom"
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
                required
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
                required
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

            {/* Assigned To (Tech) */}
            <div className="form-group">
              <label>Assigned To (Tech)</label>
              <select
                name="assignedTo"
                value={workOrder.assignedTo}
                onChange={handleChange}
                className="form-select-custom"
              >
                <option value="">— Unassigned —</option>
                {techs.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.username}
                  </option>
                ))}
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

            {/* Photo Upload */}
            <div className="form-group">
              <label>Upload Photo</label>
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoChange}
                className="form-file-custom"
              />
            </div>

            {/* Submit */}
            <button type="submit" className="submit-btn" disabled={submitting}>
              {submitting ? "Saving…" : "Add Work Order"}
            </button>
          </>
        )}
      </form>

      {/* Tiny inline styles for errors if your CSS doesn't have them */}
      <style>{`
        .error-banner {
          background: #fee;
          color: #900;
          padding: 8px;
          margin-bottom: 12px;
          border: 1px solid #f99;
          border-radius: 6px;
        }
      `}</style>
    </div>
  );
}
