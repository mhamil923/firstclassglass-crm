// File: src/AddWorkOrder.js

import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";                   // your axios wrapper
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
  });
  const [pdfFile, setPdfFile] = useState(null);
  const [customers, setCustomers] = useState([]);

  const siteInputRef = useRef(null);
  const autocompleteRef = useRef(null);

  // load customers + Google Maps script
  useEffect(() => {
    api.get("/customers")
      .then(r => setCustomers(r.data))
      .catch(e => console.error("Error loading customers:", e));

    // dynamically load Places API
    const existing = document.getElementById("gmaps-script");
    if (!existing) {
      const script = document.createElement("script");
      script.id = "gmaps-script";
      script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.REACT_APP_GOOGLE_MAPS_API_KEY}&libraries=places`;
      script.async = true;
      script.onload = initAutocomplete;
      document.body.appendChild(script);
    } else {
      initAutocomplete();
    }
  }, []);

  // initialize the autocomplete on our input
  function initAutocomplete() {
    if (window.google && siteInputRef.current) {
      autocompleteRef.current = new window.google.maps.places.Autocomplete(
        siteInputRef.current,
        { types: ["address"] }
      );
      autocompleteRef.current.setFields(["formatted_address"]);
      autocompleteRef.current.addListener("place_changed", () => {
        const place = autocompleteRef.current.getPlace();
        const addr = place.formatted_address || "";
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
        if (found) upd.billingAddress = found.billingAddress;
      }
      if (name === "billingAddress") {
        const first = extractCustomerFromBilling(value);
        if (!prev.customer || prev.customer === extractCustomerFromBilling(prev.billingAddress)) {
          upd.customer = first;
        }
      }
      return upd;
    });
  };

  const handleFileChange = e => setPdfFile(e.target.files[0]);

  const handleSubmit = async e => {
    e.preventDefault();
    const form = new FormData();
    form.append("customer", workOrder.customer);
    form.append("poNumber", workOrder.poNumber);
    form.append("siteLocation", workOrder.siteLocation);
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);
    form.append("status", workOrder.status);
    if (pdfFile) form.append("pdfFile", pdfFile);

    try {
      await api.post("/work-orders", form, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      navigate("/work-orders");
    } catch (err) {
      console.error("⚠️ Error adding work order:", err);
      alert("Failed to save — check console");
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

        {/* Site Location w/ real Google Autocomplete */}
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
            onChange={handleFileChange}
            className="form-file-custom"
          />
        </div>

        {/* Submit */}
        <button type="submit" className="submit-btn">
          Add Work Order
        </button>
      </form>
    </div>
  );
}
