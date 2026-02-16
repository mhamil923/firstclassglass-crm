// File: src/CreateEstimate.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import api from "./api";
import "./CreateEstimate.css";

const DEFAULT_TERMS =
  "ALL PAYMENTS MUST BE MADE 45 DAYS AFTER INVOICE DATE OR A 15% LATE FEE WILL BE APPLIED";

function fmtMoney(val) {
  const n = Number(val) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function todayISO() {
  const d = new Date();
  return d.toISOString().split("T")[0];
}

export default function CreateEstimate() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isEdit = !!id;

  // Estimate state
  const [estimate, setEstimate] = useState({
    customerId: null,
    customerSearch: "",
    projectName: "",
    poNumber: "",
    projectAddress: "",
    projectCity: "",
    projectState: "",
    projectZip: "",
    billingAddress: "",
    billingCity: "",
    billingState: "",
    billingZip: "",
    issueDate: todayISO(),
    expirationDate: "",
    notes: "",
    terms: DEFAULT_TERMS,
    taxRate: 0,
    workOrderId: null,
  });

  // Line items: array of { tempId, description, quantity, amount }
  const [lineItems, setLineItems] = useState([]);
  const nextTempId = useRef(1);

  // Customer data
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerDropdownRef = useRef(null);

  // UI state
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  // --- Load customers ---
  useEffect(() => {
    api.get("/customers").then((res) => {
      setCustomers(Array.isArray(res.data) ? res.data : []);
    }).catch((err) => console.error("Error loading customers:", err));
  }, []);

  // --- Load existing estimate if editing ---
  const loadEstimate = useCallback(async () => {
    if (!isEdit) return;
    setLoading(true);
    try {
      const res = await api.get(`/estimates/${id}`);
      const e = res.data;
      setEstimate({
        customerId: e.customerId,
        customerSearch: e.companyName || e.custName || "",
        projectName: e.projectName || "",
        poNumber: e.poNumber || "",
        projectAddress: e.projectAddress || "",
        projectCity: e.projectCity || "",
        projectState: e.projectState || "",
        projectZip: e.projectZip || "",
        billingAddress: e.billingAddress || e.custBillingAddress || "",
        billingCity: e.billingCity || e.custBillingCity || "",
        billingState: e.billingState || e.custBillingState || "",
        billingZip: e.billingZip || e.custBillingZip || "",
        issueDate: e.issueDate ? e.issueDate.split("T")[0] : todayISO(),
        expirationDate: e.expirationDate ? e.expirationDate.split("T")[0] : "",
        notes: e.notes || "",
        terms: e.terms || DEFAULT_TERMS,
        taxRate: Number(e.taxRate) || 0,
        workOrderId: e.workOrderId || null,
      });
      setSelectedCustomer({
        id: e.customerId,
        companyName: e.companyName || e.custName,
        billingAddress: e.billingAddress,
        billingCity: e.billingCity,
        billingState: e.billingState,
        billingZip: e.billingZip,
        phone: e.custPhone,
        email: e.custEmail,
      });
      if (e.lineItems && e.lineItems.length > 0) {
        setLineItems(
          e.lineItems.map((li) => ({
            id: li.id,
            tempId: nextTempId.current++,
            description: li.description || "",
            quantity: li.quantity != null ? String(li.quantity) : "",
            amount: li.amount != null ? String(li.amount) : "",
            sortOrder: li.sortOrder || 0,
          }))
        );
      }
    } catch (err) {
      console.error("Error loading estimate:", err);
    } finally {
      setLoading(false);
    }
  }, [id, isEdit]);

  useEffect(() => { loadEstimate(); }, [loadEstimate]);

  // --- Pre-fill from work order ---
  useEffect(() => {
    const woId = searchParams.get("workOrderId");
    const custId = searchParams.get("customerId");
    if (woId && !isEdit) {
      api.get(`/work-orders/${woId}`).then((res) => {
        const wo = res.data;
        setEstimate((prev) => ({
          ...prev,
          workOrderId: wo.id,
          customerId: wo.customerId || prev.customerId,
          customerSearch: wo.customer || prev.customerSearch,
          projectName: wo.siteLocation || prev.projectName,
          projectAddress: wo.siteAddress || prev.projectAddress,
          poNumber: wo.workOrderNumber || prev.poNumber,
        }));
        if (wo.customerId) {
          api.get(`/customers/${wo.customerId}`).then((cRes) => {
            setSelectedCustomer(cRes.data);
            setEstimate((prev) => ({
              ...prev,
              customerId: cRes.data.id,
              customerSearch: cRes.data.companyName || cRes.data.name || "",
              billingAddress: cRes.data.billingAddress || "",
              billingCity: cRes.data.billingCity || "",
              billingState: cRes.data.billingState || "",
              billingZip: cRes.data.billingZip || "",
            }));
          }).catch(() => {});
        }
      }).catch((err) => console.error("Error loading work order:", err));
    } else if (custId && !isEdit) {
      api.get(`/customers/${custId}`).then((cRes) => {
        const c = cRes.data;
        setSelectedCustomer(c);
        setEstimate((prev) => ({
          ...prev,
          customerId: c.id,
          customerSearch: c.companyName || c.name || "",
          billingAddress: c.billingAddress || "",
          billingCity: c.billingCity || "",
          billingState: c.billingState || "",
          billingZip: c.billingZip || "",
        }));
      }).catch(() => {});
    }
  }, [searchParams, isEdit]);

  // --- Customer autocomplete ---
  const filteredCustomers = useMemo(() => {
    const q = (estimate.customerSearch || "").toLowerCase().trim();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        (c.companyName || c.name || "").toLowerCase().includes(q) ||
        (c.contactName || "").toLowerCase().includes(q)
    );
  }, [customers, estimate.customerSearch]);

  const selectCustomer = (c) => {
    setSelectedCustomer(c);
    setEstimate((prev) => ({
      ...prev,
      customerId: c.id,
      customerSearch: c.companyName || c.name || "",
      billingAddress: c.billingAddress || "",
      billingCity: c.billingCity || "",
      billingState: c.billingState || "",
      billingZip: c.billingZip || "",
    }));
    setShowCustomerDropdown(false);
  };

  useEffect(() => {
    const handler = (e) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(e.target)) {
        setShowCustomerDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // --- Line items management ---
  const addLineItem = () => {
    setLineItems((prev) => [
      ...prev,
      { tempId: nextTempId.current++, description: "", quantity: "", amount: "", sortOrder: prev.length },
    ]);
  };

  const updateLineItem = (tempId, field, value) => {
    setLineItems((prev) =>
      prev.map((li) => (li.tempId === tempId ? { ...li, [field]: value } : li))
    );
  };

  const removeLineItem = (tempId) => {
    setLineItems((prev) => prev.filter((li) => li.tempId !== tempId));
  };

  const moveLineItem = (index, direction) => {
    setLineItems((prev) => {
      const arr = [...prev];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= arr.length) return prev;
      [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
      return arr;
    });
  };

  // --- Computed totals ---
  const subtotal = useMemo(() => {
    return lineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
  }, [lineItems]);

  const taxAmount = useMemo(() => {
    return Math.round(subtotal * (Number(estimate.taxRate) || 0)) / 100;
  }, [subtotal, estimate.taxRate]);

  const total = subtotal + taxAmount;

  // --- Handle form field changes ---
  const handleChange = (e) => {
    const { name, value } = e.target;
    setEstimate((prev) => ({ ...prev, [name]: value }));
  };

  const handleCustomerSearchChange = (e) => {
    setEstimate((prev) => ({
      ...prev,
      customerSearch: e.target.value,
      customerId: null,
    }));
    setSelectedCustomer(null);
    setShowCustomerDropdown(true);
  };

  // --- Save ---
  const handleSave = async (andGeneratePdf = false) => {
    if (!estimate.customerId) {
      alert("Please select a customer.");
      return null;
    }

    setSaving(true);
    try {
      const payload = {
        customerId: estimate.customerId,
        workOrderId: estimate.workOrderId || null,
        projectName: estimate.projectName,
        poNumber: estimate.poNumber,
        projectAddress: estimate.projectAddress,
        projectCity: estimate.projectCity,
        projectState: estimate.projectState,
        projectZip: estimate.projectZip,
        billingAddress: estimate.billingAddress || null,
        billingCity: estimate.billingCity || null,
        billingState: estimate.billingState || null,
        billingZip: estimate.billingZip || null,
        issueDate: estimate.issueDate || todayISO(),
        expirationDate: estimate.expirationDate || null,
        notes: estimate.notes,
        terms: estimate.terms,
        taxRate: Number(estimate.taxRate) || 0,
        subtotal,
        taxAmount,
        total,
      };

      let estimateId;
      if (isEdit) {
        await api.put(`/estimates/${id}`, payload);
        estimateId = Number(id);
      } else {
        const res = await api.post("/estimates", payload);
        estimateId = res.data.id;
      }

      // Sync line items: delete removed, update existing, create new
      if (isEdit) {
        // Get current server-side items
        const currentRes = await api.get(`/estimates/${estimateId}`);
        const serverItems = currentRes.data.lineItems || [];
        const clientIds = lineItems.filter((li) => li.id).map((li) => li.id);

        // Delete items no longer present
        for (const si of serverItems) {
          if (!clientIds.includes(si.id)) {
            await api.delete(`/estimates/${estimateId}/line-items/${si.id}`);
          }
        }
      }

      // Create/update all items
      for (let i = 0; i < lineItems.length; i++) {
        const li = lineItems[i];
        const itemPayload = {
          description: li.description,
          quantity: li.quantity !== "" ? Number(li.quantity) : null,
          amount: Number(li.amount) || 0,
          sortOrder: i,
        };

        if (li.id) {
          await api.put(`/estimates/${estimateId}/line-items/${li.id}`, itemPayload);
        } else {
          await api.post(`/estimates/${estimateId}/line-items`, itemPayload);
        }
      }

      if (andGeneratePdf) {
        setGeneratingPdf(true);
        try {
          await api.post(`/estimates/${estimateId}/generate-pdf`);
        } catch (pdfErr) {
          console.error("PDF generation error:", pdfErr);
          alert("Estimate saved but PDF generation failed.");
        }
        setGeneratingPdf(false);
      }

      navigate(`/estimates/${estimateId}`);
      return estimateId;
    } catch (err) {
      console.error("Error saving estimate:", err);
      alert("Failed to save estimate. Please try again.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  // --- Delete ---
  const handleDelete = async () => {
    if (!window.confirm("Delete this estimate? This cannot be undone.")) return;
    try {
      await api.delete(`/estimates/${id}`);
      navigate("/estimates");
    } catch (err) {
      console.error("Error deleting estimate:", err);
      alert("Failed to delete estimate.");
    }
  };

  if (loading) {
    return (
      <div className="ce-page">
        <div className="ce-container">
          <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)" }}>
            Loading estimate...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ce-page">
      <div className="ce-container">
        {/* Top bar */}
        <div className="ce-topbar">
          <Link to="/estimates" className="ce-back">&larr; Estimates</Link>
          <h2 className="ce-title">{isEdit ? "Edit Estimate" : "Create Estimate"}</h2>
          <div className="ce-actions">
            {isEdit && (
              <button className="ce-btn ce-btn-danger" onClick={handleDelete}>
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Customer Section */}
        <div className="ce-card">
          <div className="ce-card-header">Customer</div>
          <div className="ce-card-body">
            <div className="ce-grid ce-grid-2">
              <div className="ce-field" ref={customerDropdownRef} style={{ position: "relative" }}>
                <div className="ce-label">Customer Name *</div>
                <input
                  type="text"
                  value={estimate.customerSearch}
                  onChange={handleCustomerSearchChange}
                  onFocus={() => setShowCustomerDropdown(true)}
                  className="ce-input"
                  placeholder="Search customer..."
                  autoComplete="off"
                />
                {showCustomerDropdown && (estimate.customerSearch || "").trim().length > 0 && (
                  <div className="ce-customer-dropdown">
                    {filteredCustomers.map((c) => (
                      <div
                        key={c.id}
                        className="ce-customer-option"
                        onMouseDown={() => selectCustomer(c)}
                      >
                        <div className="ce-customer-option-name">{c.companyName || c.name}</div>
                        {c.contactName && (
                          <div className="ce-customer-option-sub">{c.contactName}</div>
                        )}
                      </div>
                    ))}
                    {filteredCustomers.length === 0 && (
                      <div className="ce-customer-option muted">No matching customers</div>
                    )}
                  </div>
                )}
              </div>

              {selectedCustomer && (
                <div className="ce-field">
                  <div className="ce-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>Billing Address</span>
                    <button
                      type="button"
                      style={{ background: "none", border: "none", color: "var(--accent-blue)", fontSize: 12, fontWeight: 500, cursor: "pointer", padding: 0 }}
                      onClick={() => setEstimate((prev) => ({
                        ...prev,
                        billingAddress: selectedCustomer.billingAddress || "",
                        billingCity: selectedCustomer.billingCity || "",
                        billingState: selectedCustomer.billingState || "",
                        billingZip: selectedCustomer.billingZip || "",
                      }))}
                    >
                      Reset to Customer Default
                    </button>
                  </div>
                  <input
                    name="billingAddress"
                    value={estimate.billingAddress}
                    onChange={handleChange}
                    className="ce-input"
                    placeholder="Billing street address"
                  />
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, marginTop: 8 }}>
                    <input
                      name="billingCity"
                      value={estimate.billingCity}
                      onChange={handleChange}
                      className="ce-input"
                      placeholder="City"
                    />
                    <input
                      name="billingState"
                      value={estimate.billingState}
                      onChange={handleChange}
                      className="ce-input"
                      placeholder="ST"
                    />
                    <input
                      name="billingZip"
                      value={estimate.billingZip}
                      onChange={handleChange}
                      className="ce-input"
                      placeholder="ZIP"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Project Section */}
        <div className="ce-card">
          <div className="ce-card-header">Project Details</div>
          <div className="ce-card-body">
            <div className="ce-grid ce-grid-2">
              <div className="ce-field">
                <div className="ce-label">Project Name</div>
                <input
                  name="projectName"
                  value={estimate.projectName}
                  onChange={handleChange}
                  className="ce-input"
                  placeholder="e.g., JCPENNEY #2928"
                />
              </div>
              <div className="ce-field">
                <div className="ce-label">P.O. No.</div>
                <input
                  name="poNumber"
                  value={estimate.poNumber}
                  onChange={handleChange}
                  className="ce-input"
                  placeholder="Customer's PO/WO reference"
                />
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <div className="ce-field">
                <div className="ce-label">Project Address</div>
                <input
                  name="projectAddress"
                  value={estimate.projectAddress}
                  onChange={handleChange}
                  className="ce-input"
                  placeholder="Full address, e.g. 1113 N Harvard Ave, Arlington Heights, IL 60004"
                />
              </div>
            </div>

            <div className="ce-grid ce-grid-2" style={{ marginTop: 18 }}>
              <div className="ce-field">
                <div className="ce-label">Issue Date</div>
                <input
                  name="issueDate"
                  type="date"
                  value={estimate.issueDate}
                  onChange={handleChange}
                  className="ce-input"
                />
              </div>
              <div className="ce-field">
                <div className="ce-label">Expiration Date (Optional)</div>
                <input
                  name="expirationDate"
                  type="date"
                  value={estimate.expirationDate}
                  onChange={handleChange}
                  className="ce-input"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Line Items Section */}
        <div className="ce-card">
          <div className="ce-card-header">Line Items</div>
          <div className="ce-card-body">
            {lineItems.length > 0 && (
              <div className="ce-li-header">
                <span>Qty</span>
                <span>Description</span>
                <span style={{ textAlign: "right" }}>Amount ($)</span>
                <span></span>
                <span></span>
                <span></span>
              </div>
            )}

            {lineItems.map((li, idx) => (
              <div className="ce-li-row" key={li.tempId}>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={li.quantity}
                  onChange={(e) => updateLineItem(li.tempId, "quantity", e.target.value)}
                  className="ce-li-input"
                  placeholder="Qty"
                />
                <input
                  type="text"
                  value={li.description}
                  onChange={(e) => updateLineItem(li.tempId, "description", e.target.value)}
                  className="ce-li-input"
                  placeholder="Description"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={li.amount}
                  onChange={(e) => updateLineItem(li.tempId, "amount", e.target.value)}
                  className="ce-li-input"
                  placeholder="0.00"
                  style={{ textAlign: "right" }}
                />
                <button
                  type="button"
                  className="ce-li-btn"
                  onClick={() => moveLineItem(idx, -1)}
                  disabled={idx === 0}
                  title="Move up"
                >
                  &#x25B2;
                </button>
                <button
                  type="button"
                  className="ce-li-btn"
                  onClick={() => moveLineItem(idx, 1)}
                  disabled={idx === lineItems.length - 1}
                  title="Move down"
                >
                  &#x25BC;
                </button>
                <button
                  type="button"
                  className="ce-li-btn danger"
                  onClick={() => removeLineItem(li.tempId)}
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            ))}

            <button type="button" className="ce-add-line" onClick={addLineItem}>
              + Add Line Item
            </button>

            {/* Totals */}
            <div className="ce-totals">
              <div className="ce-totals-row">
                <span className="ce-totals-label">Subtotal</span>
                <span className="ce-totals-value">{fmtMoney(subtotal)}</span>
              </div>
              <div className="ce-totals-row">
                <span className="ce-totals-label">Tax Rate (%)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  name="taxRate"
                  value={estimate.taxRate}
                  onChange={handleChange}
                  className="ce-totals-input"
                />
              </div>
              <div className="ce-totals-row">
                <span className="ce-totals-label">Tax</span>
                <span className="ce-totals-value">{fmtMoney(taxAmount)}</span>
              </div>
              <div className="ce-totals-row grand">
                <span className="ce-totals-label">Total</span>
                <span className="ce-totals-value">{fmtMoney(total)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Notes & Terms */}
        <div className="ce-card">
          <div className="ce-card-header">Notes & Terms</div>
          <div className="ce-card-body">
            <div className="ce-grid ce-grid-2">
              <div className="ce-field">
                <div className="ce-label">Notes</div>
                <textarea
                  name="notes"
                  value={estimate.notes}
                  onChange={handleChange}
                  className="ce-textarea"
                  placeholder="Additional notes..."
                  rows={3}
                />
              </div>
              <div className="ce-field">
                <div className="ce-label">Payment Terms</div>
                <textarea
                  name="terms"
                  value={estimate.terms}
                  onChange={handleChange}
                  className="ce-textarea"
                  rows={3}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="ce-footer">
          <button
            className="ce-btn ce-btn-secondary"
            onClick={() => navigate("/estimates")}
          >
            Cancel
          </button>
          <button
            className="ce-btn ce-btn-secondary"
            onClick={() => handleSave(false)}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save as Draft"}
          </button>
          <button
            className="ce-btn ce-btn-primary"
            onClick={() => handleSave(true)}
            disabled={saving || generatingPdf}
          >
            {generatingPdf ? "Generating PDF..." : saving ? "Saving..." : "Save & Generate PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
