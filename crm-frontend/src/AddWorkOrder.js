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
    assignedTo: "", // user id (string)
  });

  // files
  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);

  // lists
  const [customers, setCustomers] = useState([]);
  const [assignees, setAssignees] = useState([]); // techs + allowed extras

  // ui
  const [submitting, setSubmitting] = useState(false);

  // Google Places (legacy Autocomplete) refs
  const siteInputRef = useRef(null);
  const autocompleteRef = useRef(null);

  // ---------- load reference data + Google Places script once
  useEffect(() => {
    // Customers
    api
      .get("/customers")
      .then((r) => setCustomers(r.data || []))
      .catch((e) => console.error("Error loading customers:", e));

    // Assignees (server: techs + allowlist); still hide Mark here
    api
      .get("/users", { params: { assignees: 1 } })
      .then((r) => setAssignees((r.data || []).filter((u) => u.username !== "Mark")))
      .catch((e) => console.error("Error loading assignees:", e));

    // Google Places script
    const key =
      process.env.REACT_APP_GOOGLE_MAPS_API_KEY ||
      // optional local override for troubleshooting ONLY:
      (typeof window !== "undefined" ? window.__GMAPS_KEY__ : null);

    if (!key) {
      console.warn("Google Maps API key missing; Places autocomplete disabled.");
      return;
    }

    const existing = document.getElementById("gmaps-script");
    if (existing) {
      if (window.google?.maps?.places && siteInputRef.current) {
        initAutocomplete();
      } else {
        existing.addEventListener("load", initAutocomplete, { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.id = "gmaps-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&v=weekly&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = initAutocomplete;
    script.onerror = () => console.error("Failed to load Google Maps script");
    document.body.appendChild(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- initialize legacy Autocomplete on the plain input
  function initAutocomplete() {
    try {
      if (!window.google?.maps?.places || !siteInputRef.current) return;

      // Destroy a previous instance if any
      autocompleteRef.current = null;

      const ac = new window.google.maps.places.Autocomplete(siteInputRef.current, {
        types: ["address"],
        fields: ["name", "formatted_address"], // what we need back
      });

      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const name = place?.name || "";
        const addr = place?.formatted_address || siteInputRef.current.value || "";
        const combined =
          name && addr && !addr.includes(name) ? `${name}, ${addr}` : addr || name;

        setWorkOrder((prev) => ({ ...prev, siteLocation: combined }));
      });

      autocompleteRef.current = ac;
    } catch (err) {
      console.error("Autocomplete init failed:", err);
    }
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

        {/* Site Location (legacy Google Places Autocomplete) */}
        <div className="form-group">
          <label className="form-label">Site Location</label>
          <input
            ref={siteInputRef}
            name="siteLocation"
            value={workOrder.siteLocation}
            onChange={handleChange}
            placeholder="Start typing address…"
            className="form-control-custom"
            autoComplete="street-address"
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
            onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
            className="form-file-custom"
          />
        </div>

        {/* Photo Upload (optional, single) */}
        <div className="form-group">
          <label className="form-label">Upload Photo</label>
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
