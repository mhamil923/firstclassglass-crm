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
  const role = decodeRoleFromJWT();

  // ---- form state
  const [workOrder, setWorkOrder] = useState({
    customer: "",
    workOrderNumber: "",
    poNumber: "", // ← NEW optional field
    siteLocation: "",
    billingAddress: "",
    problemDescription: "",
    status: "Needs to be Scheduled",
    assignedTo: "",
    customerPhone: "",
    customerEmail: "",
  });

  const [pdfFile, setPdfFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [techs, setTechs] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const siteInputRef = useRef(null);
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

  // ---------- Google Maps Autocomplete
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
    if (!siteInputRef.current) return;

    try {
      const ac = new window.google.maps.places.Autocomplete(siteInputRef.current, {
        types: ["address"],
        fields: ["formatted_address", "name", "geometry"],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const addr = place?.formatted_address || place?.name || siteInputRef.current.value;
        setWorkOrder((prev) => ({ ...prev, siteLocation: addr }));
      });
      autocompleteRef.current = ac;
    } catch (e) {
      console.error("Failed to init Places Autocomplete:", e);
    }
  }

  const handleSiteFocus = () => {
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
    form.append("workOrderNumber", workOrder.workOrderNumber || "");
    form.append("poNumber", workOrder.poNumber || ""); // ← NEW
    form.append("siteLocation", workOrder.siteLocation || "");
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);
    form.append("status", workOrder.status || "Needs to be Scheduled");
    form.append("customerPhone", workOrder.customerPhone || "");
    form.append("customerEmail", workOrder.customerEmail || "");
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

        {/* Site Location */}
        <div className="form-group">
          <label className="form-label">Site Location</label>
          <input
            name="siteLocation"
            ref={siteInputRef}
            value={workOrder.siteLocation}
            onChange={handleChange}
            onFocus={handleSiteFocus}
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
            <option>Needs to be Scheduled</option>
            <option>Scheduled</option>
            <option>Waiting for Approval</option>
            <option>Waiting on Parts</option>
            <option>Parts In</option>
            <option>Completed</option>
          </select>
        </div>

        {/* Uploads */}
        <div className="form-group">
          <label className="form-label">Upload PDF</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handlePdfChange}
            className="form-file-custom"
          />
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
