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
    siteLocation: "",           // stays in state, but input is UNcontrolled
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
  const [techs, setTechs] = useState([]);

  // ui
  const [submitting, setSubmitting] = useState(false);

  // google places (new Element API)
  const pacRef = useRef(null);         // <gmpx-place-autocomplete>
  const siteInputRef = useRef(null);   // the <input slot="input">

  // ---------- load reference data + Places scripts once
  useEffect(() => {
    // customers + techs (dispatchers/admins see techs in dropdown)
    Promise.all([
      api.get("/customers"),
      api.get("/users", { params: { assignees: "1" } }), // techs + allowed extras
    ])
      .then(([c, u]) => {
        setCustomers(c.data || []);
        setTechs(u.data || []);
      })
      .catch((e) => console.error("Error loading customers/users:", e));

    // Google Places Element (modern)
    const key = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
    if (!key) {
      console.warn("Google Maps API key missing; Places autocomplete disabled.");
      return;
    }

    const ensureScript = ({ id, src, type }) =>
      new Promise((resolve, reject) => {
        const existing = document.getElementById(id);
        if (existing) return resolve();
        const s = document.createElement("script");
        s.id = id;
        s.src = src;
        if (type) s.type = type;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.body.appendChild(s);
      });

    // JS API (with places) + Extended Component Library (web components)
    const jsApi = ensureScript({
      id: "gmaps-js",
      src: `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async`,
    });
    const elementsLib = ensureScript({
      id: "gmpx-lib",
      src: "https://unpkg.com/@googlemaps/extended-component-library@latest",
      type: "module",
    });

    Promise.all([jsApi, elementsLib])
      .then(initAutocompleteElement)
      .catch((err) => console.error("Google Maps load error:", err));

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize the <gmpx-place-autocomplete> element
  function initAutocompleteElement() {
    const pacEl = pacRef.current;
    const inputEl = siteInputRef.current;
    if (!pacEl || !inputEl) return;

    // Keep the <input> free-typing and sync to React state as the user types
    const onInput = (e) => {
      const val = e.target.value;
      setWorkOrder((prev) => ({ ...prev, siteLocation: val }));
    };
    inputEl.addEventListener("input", onInput);

    // When a place is selected, prefer "Name - formattedAddress"
    const onPlace = () => {
      try {
        const place = pacEl.value; // new Element API
        if (!place) return;
        const name =
          place.displayName?.text ||
          place.displayName ||
          place.name ||
          ""; // try new fields first
        const addr =
          place.formattedAddress ||
          place.formatted_address ||
          inputEl.value ||
          "";
        const combined = name && addr && addr.indexOf(name) !== 0 ? `${name} - ${addr}` : addr;
        // set input visually (uncontrolled) + update state
        inputEl.value = combined;
        setWorkOrder((prev) => ({ ...prev, siteLocation: combined }));
      } catch (err) {
        console.warn("placechange parse error:", err);
      }
    };
    pacEl.addEventListener("gmpx-placechange", onPlace);

    // seed input if we already have a siteLocation (e.g., user typed then navigated back)
    if (workOrder.siteLocation) inputEl.value = workOrder.siteLocation;

    // cleanup
    return () => {
      inputEl.removeEventListener("input", onInput);
      pacEl.removeEventListener("gmpx-placechange", onPlace);
    };
  }

  // if state changes (e.g., user picked a customer with stored address), reflect in the input once
  useEffect(() => {
    if (siteInputRef.current && siteInputRef.current.value !== workOrder.siteLocation) {
      // only update the DOM input if our state changed because of *non-typing* reasons
      // (typing already updates both)
      const el = siteInputRef.current;
      const active = document.activeElement === el;
      if (!active) el.value = workOrder.siteLocation || "";
    }
  }, [workOrder.siteLocation]);

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

    // Read current text directly from the DOM input (source of truth)
    const siteLoc = siteInputRef.current?.value?.trim() || workOrder.siteLocation || "";

    const form = new FormData();
    form.append("customer", workOrder.customer);
    form.append("poNumber", workOrder.poNumber || "");
    form.append("siteLocation", siteLoc);
    form.append("billingAddress", workOrder.billingAddress);
    form.append("problemDescription", workOrder.problemDescription);
    form.append("status", workOrder.status || "Needs to be Scheduled");

    if (workOrder.assignedTo) form.append("assignedTo", workOrder.assignedTo);

    // IMPORTANT: field names must match server.js (pdfFile / photoFile)
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

        {/* Site Location (NEW: Place Autocomplete Element with an uncontrolled input) */}
        <div className="form-group">
          <label>Site Location</label>
          <gmpx-place-autocomplete ref={pacRef} style={{ display: "block" }}>
            <input
              slot="input"
              ref={siteInputRef}
              className="form-control-custom"
              placeholder="Start typing address…"
              autoComplete="off"
            />
          </gmpx-place-autocomplete>
          <small className="muted">
            Start typing, then choose a suggestion. You can also type a free-form address.
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

        {/* Photo Upload (optional, single) */}
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
