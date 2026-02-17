// File: src/CreateInvoice.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import api from "./api";
import "./CreateInvoice.css";

function fmtMoney(val) {
  const n = Number(val) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function todayISO() {
  const d = new Date();
  return d.toISOString().split("T")[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr || new Date());
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export default function CreateInvoice() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isEdit = !!id;

  const [invoice, setInvoice] = useState({
    customerId: null,
    customerSearch: "",
    invoiceNumber: "",
    projectName: "",
    poNumber: "",
    shipToAddress: "",
    shipToCity: "",
    shipToState: "",
    shipToZip: "",
    billingAddress: "",
    billingCity: "",
    billingState: "",
    billingZip: "",
    issueDate: todayISO(),
    dueDate: addDays(todayISO(), 45),
    notes: "",
    terms: "",
    taxRate: 0,
    workOrderId: null,
    estimateId: null,
  });

  const [lineItems, setLineItems] = useState([]);
  const nextTempId = useRef(1);

  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerDropdownRef = useRef(null);
  const needsCustomerResolve = useRef(false);

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  // Load customers + default terms
  useEffect(() => {
    api.get("/customers").then((res) => {
      setCustomers(Array.isArray(res.data) ? res.data : []);
    }).catch((err) => console.error("Error loading customers:", err));

    if (!isEdit) {
      api.get("/settings").then((res) => {
        if (res.data?.defaultInvoiceTerms) {
          setInvoice((prev) => ({ ...prev, terms: prev.terms || res.data.defaultInvoiceTerms }));
        }
      }).catch(() => {});
    }
  }, [isEdit]);

  // Auto-resolve customer when pre-filled from WO without customerId
  useEffect(() => {
    if (!needsCustomerResolve.current) return;
    if (customers.length === 0) return;
    if (invoice.customerId) return;
    const search = (invoice.customerSearch || "").toLowerCase().trim();
    if (!search) return;
    const match = customers.find(
      (c) => (c.companyName || c.name || "").toLowerCase() === search
    );
    if (match) {
      needsCustomerResolve.current = false;
      setSelectedCustomer(match);
      setInvoice((prev) => ({
        ...prev,
        customerId: match.id,
        customerSearch: match.companyName || match.name || "",
        billingAddress: match.billingAddress || "",
        billingCity: match.billingCity || "",
        billingState: match.billingState || "",
        billingZip: match.billingZip || "",
      }));
    }
  }, [customers, invoice.customerSearch, invoice.customerId]);

  // Load existing invoice if editing
  const loadInvoice = useCallback(async () => {
    if (!isEdit) return;
    setLoading(true);
    try {
      const res = await api.get(`/invoices/${id}`);
      const inv = res.data;
      setInvoice({
        customerId: inv.customerId,
        customerSearch: inv.companyName || inv.custName || "",
        invoiceNumber: inv.invoiceNumber || "",
        projectName: inv.projectName || "",
        poNumber: inv.poNumber || "",
        shipToAddress: inv.shipToAddress || "",
        shipToCity: inv.shipToCity || "",
        shipToState: inv.shipToState || "",
        shipToZip: inv.shipToZip || "",
        billingAddress: inv.billingAddress || inv.custBillingAddress || "",
        billingCity: inv.billingCity || inv.custBillingCity || "",
        billingState: inv.billingState || inv.custBillingState || "",
        billingZip: inv.billingZip || inv.custBillingZip || "",
        issueDate: inv.issueDate ? inv.issueDate.split("T")[0] : todayISO(),
        dueDate: inv.dueDate ? inv.dueDate.split("T")[0] : addDays(todayISO(), 45),
        notes: inv.notes || "",
        terms: inv.terms || "",
        taxRate: Number(inv.taxRate) || 0,
        workOrderId: inv.workOrderId || null,
        estimateId: inv.estimateId || null,
      });
      setSelectedCustomer({
        id: inv.customerId,
        companyName: inv.companyName || inv.custName,
        billingAddress: inv.billingAddress,
        billingCity: inv.billingCity,
        billingState: inv.billingState,
        billingZip: inv.billingZip,
        phone: inv.custPhone,
        email: inv.custEmail,
      });
      if (inv.lineItems && inv.lineItems.length > 0) {
        setLineItems(
          inv.lineItems.map((li) => ({
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
      console.error("Error loading invoice:", err);
    } finally {
      setLoading(false);
    }
  }, [id, isEdit]);

  useEffect(() => { loadInvoice(); }, [loadInvoice]);

  // Pre-fill from estimate, work order, or customer
  useEffect(() => {
    const estId = searchParams.get("estimateId");
    const woId = searchParams.get("workOrderId");
    const custId = searchParams.get("customerId");

    if (estId && !isEdit) {
      api.get(`/estimates/${estId}`).then((res) => {
        const e = res.data;
        setInvoice((prev) => ({
          ...prev,
          estimateId: e.id,
          customerId: e.customerId,
          customerSearch: e.companyName || e.custName || "",
          projectName: e.projectName || "",
          poNumber: e.poNumber || "",
          shipToAddress: e.projectAddress || "",
          shipToCity: e.projectCity || "",
          shipToState: e.projectState || "",
          shipToZip: e.projectZip || "",
          billingAddress: e.effectiveBillingAddress || e.billingAddress || "",
          billingCity: e.effectiveBillingCity || e.billingCity || "",
          billingState: e.effectiveBillingState || e.billingState || "",
          billingZip: e.effectiveBillingZip || e.billingZip || "",
          taxRate: Number(e.taxRate) || 0,
          notes: e.notes || "",
          terms: e.terms || prev.terms,
          workOrderId: e.workOrderId || null,
        }));
        if (e.customerId) {
          api.get(`/customers/${e.customerId}`).then((cRes) => {
            setSelectedCustomer(cRes.data);
          }).catch(() => {});
        }
        if (e.lineItems && e.lineItems.length > 0) {
          setLineItems(
            e.lineItems.map((li) => ({
              tempId: nextTempId.current++,
              description: li.description || "",
              quantity: li.quantity != null ? String(li.quantity) : "",
              amount: li.amount != null ? String(li.amount) : "",
              sortOrder: li.sortOrder || 0,
            }))
          );
        }
      }).catch((err) => console.error("Error loading estimate:", err));
    } else if (woId && !isEdit) {
      api.get(`/work-orders/${woId}`).then((res) => {
        const wo = res.data;
        setInvoice((prev) => ({
          ...prev,
          workOrderId: wo.id,
          customerId: wo.customerId || prev.customerId,
          customerSearch: wo.customer || prev.customerSearch,
          projectName: wo.siteLocation || prev.projectName,
          shipToAddress: wo.siteAddress || prev.shipToAddress,
          poNumber: wo.workOrderNumber || prev.poNumber,
        }));
        if (wo.customerId) {
          api.get(`/customers/${wo.customerId}`).then((cRes) => {
            setSelectedCustomer(cRes.data);
            setInvoice((prev) => ({
              ...prev,
              customerId: cRes.data.id,
              customerSearch: cRes.data.companyName || cRes.data.name || "",
              billingAddress: cRes.data.billingAddress || "",
              billingCity: cRes.data.billingCity || "",
              billingState: cRes.data.billingState || "",
              billingZip: cRes.data.billingZip || "",
            }));
          }).catch(() => {});
        } else if (wo.customer) {
          needsCustomerResolve.current = true;
        }
      }).catch((err) => console.error("Error loading work order:", err));
    } else if (custId && !isEdit) {
      api.get(`/customers/${custId}`).then((cRes) => {
        const c = cRes.data;
        setSelectedCustomer(c);
        setInvoice((prev) => ({
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

  // Customer autocomplete
  const filteredCustomers = useMemo(() => {
    const q = (invoice.customerSearch || "").toLowerCase().trim();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        (c.companyName || c.name || "").toLowerCase().includes(q) ||
        (c.contactName || "").toLowerCase().includes(q)
    );
  }, [customers, invoice.customerSearch]);

  const selectCustomer = (c) => {
    setSelectedCustomer(c);
    setInvoice((prev) => ({
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

  // Line items management
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

  // Computed totals
  const subtotal = useMemo(() => {
    return lineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
  }, [lineItems]);

  const taxAmount = useMemo(() => {
    return Math.round(subtotal * (Number(invoice.taxRate) || 0)) / 100;
  }, [subtotal, invoice.taxRate]);

  const total = subtotal + taxAmount;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setInvoice((prev) => {
      const next = { ...prev, [name]: value };
      if (name === "issueDate" && value) {
        next.dueDate = addDays(value, 45);
      }
      return next;
    });
  };

  const handleCustomerSearchChange = (e) => {
    setInvoice((prev) => ({
      ...prev,
      customerSearch: e.target.value,
      customerId: null,
    }));
    setSelectedCustomer(null);
    setShowCustomerDropdown(true);
  };

  // Save
  const handleSave = async (andGeneratePdf = false) => {
    if (!invoice.customerId && !invoice.customerSearch.trim()) {
      alert("Please enter a customer name.");
      return null;
    }

    setSaving(true);
    try {
      const payload = {
        customerId: invoice.customerId || undefined,
        customerName: !invoice.customerId ? invoice.customerSearch.trim() : undefined,
        workOrderId: invoice.workOrderId || null,
        estimateId: invoice.estimateId || null,
        projectName: invoice.projectName,
        poNumber: invoice.poNumber,
        shipToAddress: invoice.shipToAddress,
        shipToCity: invoice.shipToCity,
        shipToState: invoice.shipToState,
        shipToZip: invoice.shipToZip,
        billingAddress: invoice.billingAddress || null,
        billingCity: invoice.billingCity || null,
        billingState: invoice.billingState || null,
        billingZip: invoice.billingZip || null,
        issueDate: invoice.issueDate || todayISO(),
        dueDate: invoice.dueDate || addDays(invoice.issueDate || todayISO(), 45),
        notes: invoice.notes,
        terms: invoice.terms,
        taxRate: Number(invoice.taxRate) || 0,
        subtotal,
        taxAmount,
        total,
      };

      let invoiceId;
      if (isEdit) {
        await api.put(`/invoices/${id}`, payload);
        invoiceId = Number(id);
      } else {
        const res = await api.post("/invoices", payload);
        invoiceId = res.data.id;
      }

      // Sync line items
      if (isEdit) {
        const currentRes = await api.get(`/invoices/${invoiceId}`);
        const serverItems = currentRes.data.lineItems || [];
        const clientIds = lineItems.filter((li) => li.id).map((li) => li.id);

        for (const si of serverItems) {
          if (!clientIds.includes(si.id)) {
            await api.delete(`/invoices/${invoiceId}/line-items/${si.id}`);
          }
        }
      }

      for (let i = 0; i < lineItems.length; i++) {
        const li = lineItems[i];
        const itemPayload = {
          description: li.description,
          quantity: li.quantity !== "" ? Number(li.quantity) : null,
          amount: Number(li.amount) || 0,
          sortOrder: i,
        };

        if (li.id) {
          await api.put(`/invoices/${invoiceId}/line-items/${li.id}`, itemPayload);
        } else {
          await api.post(`/invoices/${invoiceId}/line-items`, itemPayload);
        }
      }

      if (andGeneratePdf) {
        setGeneratingPdf(true);
        try {
          await api.post(`/invoices/${invoiceId}/generate-pdf`);
        } catch (pdfErr) {
          console.error("PDF generation error:", pdfErr);
          alert("Invoice saved but PDF generation failed.");
        }
        setGeneratingPdf(false);
      }

      navigate(`/invoices/${invoiceId}`);
      return invoiceId;
    } catch (err) {
      console.error("Error saving invoice:", err);
      alert("Failed to save invoice. Please try again.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this invoice? This cannot be undone.")) return;
    try {
      await api.delete(`/invoices/${id}`);
      navigate("/invoices");
    } catch (err) {
      console.error("Error deleting invoice:", err);
      alert(err?.response?.data?.error || "Failed to delete invoice.");
    }
  };

  if (loading) {
    return (
      <div className="ci-page">
        <div className="ci-container">
          <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)" }}>
            Loading invoice...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ci-page">
      <div className="ci-container">
        {/* Top bar */}
        <div className="ci-topbar">
          <Link to="/invoices" className="ci-back">&larr; Invoices</Link>
          <h2 className="ci-title">
            {isEdit ? "Edit Invoice" : "Create Invoice"}
            {invoice.invoiceNumber && <span className="ci-title-number"> #{invoice.invoiceNumber}</span>}
          </h2>
          <div className="ci-actions">
            {isEdit && (
              <button className="ci-btn ci-btn-danger" onClick={handleDelete}>
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Customer Section */}
        <div className="ci-card">
          <div className="ci-card-header">Customer</div>
          <div className="ci-card-body">
            <div className="ci-grid ci-grid-2">
              <div className="ci-field" ref={customerDropdownRef} style={{ position: "relative" }}>
                <div className="ci-label">Customer Name *</div>
                <input
                  type="text"
                  value={invoice.customerSearch}
                  onChange={handleCustomerSearchChange}
                  onFocus={() => setShowCustomerDropdown(true)}
                  className="ci-input"
                  placeholder="Search customer..."
                  autoComplete="off"
                />
                {showCustomerDropdown && (invoice.customerSearch || "").trim().length > 0 && (
                  <div className="ci-customer-dropdown">
                    {filteredCustomers.map((c) => (
                      <div
                        key={c.id}
                        className="ci-customer-option"
                        onMouseDown={() => selectCustomer(c)}
                      >
                        <div className="ci-customer-option-name">{c.companyName || c.name}</div>
                        {c.contactName && (
                          <div className="ci-customer-option-sub">{c.contactName}</div>
                        )}
                      </div>
                    ))}
                    {filteredCustomers.length === 0 && (
                      <div className="ci-customer-option muted">No match found — "{invoice.customerSearch}" will be created as a new customer</div>
                    )}
                  </div>
                )}
              </div>

              <div className="ci-field">
                  <div className="ci-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>Billing Address</span>
                    {selectedCustomer && (
                    <button
                      type="button"
                      style={{ background: "none", border: "none", color: "var(--accent-blue)", fontSize: 12, fontWeight: 500, cursor: "pointer", padding: 0 }}
                      onClick={() => setInvoice((prev) => ({
                        ...prev,
                        billingAddress: selectedCustomer.billingAddress || "",
                        billingCity: selectedCustomer.billingCity || "",
                        billingState: selectedCustomer.billingState || "",
                        billingZip: selectedCustomer.billingZip || "",
                      }))}
                    >
                      Reset to Customer Default
                    </button>
                    )}
                  </div>
                  <input
                    name="billingAddress"
                    value={invoice.billingAddress}
                    onChange={handleChange}
                    className="ci-input"
                    placeholder="Billing street address"
                  />
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, marginTop: 8 }}>
                    <input
                      name="billingCity"
                      value={invoice.billingCity}
                      onChange={handleChange}
                      className="ci-input"
                      placeholder="City"
                    />
                    <input
                      name="billingState"
                      value={invoice.billingState}
                      onChange={handleChange}
                      className="ci-input"
                      placeholder="ST"
                    />
                    <input
                      name="billingZip"
                      value={invoice.billingZip}
                      onChange={handleChange}
                      className="ci-input"
                      placeholder="ZIP"
                    />
                  </div>
                </div>
            </div>
          </div>
        </div>

        {/* Invoice Details */}
        <div className="ci-card">
          <div className="ci-card-header">Invoice Details</div>
          <div className="ci-card-body">
            <div className="ci-grid ci-grid-3">
              <div className="ci-field">
                <div className="ci-label">Issue Date</div>
                <input
                  name="issueDate"
                  type="date"
                  value={invoice.issueDate}
                  onChange={handleChange}
                  className="ci-input"
                />
              </div>
              <div className="ci-field">
                <div className="ci-label">Due Date</div>
                <input
                  name="dueDate"
                  type="date"
                  value={invoice.dueDate}
                  onChange={handleChange}
                  className="ci-input"
                />
              </div>
              <div className="ci-field">
                <div className="ci-label">P.O. No.</div>
                <input
                  name="poNumber"
                  value={invoice.poNumber}
                  onChange={handleChange}
                  className="ci-input"
                  placeholder="Customer's PO/WO reference"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Ship To */}
        <div className="ci-card">
          <div className="ci-card-header">Ship To</div>
          <div className="ci-card-body">
            <div className="ci-grid ci-grid-2">
              <div className="ci-field ci-field-full">
                <div className="ci-label">Ship To Name</div>
                <input
                  name="projectName"
                  value={invoice.projectName}
                  onChange={handleChange}
                  className="ci-input"
                  placeholder='e.g., "ADVANCE AUTO #106923"'
                />
              </div>
            </div>
            <div style={{ marginTop: 18 }}>
              <div className="ci-field">
                <div className="ci-label">Ship To Address</div>
                <input
                  name="shipToAddress"
                  value={invoice.shipToAddress}
                  onChange={handleChange}
                  className="ci-input"
                  placeholder="Full address, e.g. 1739 E Golf Rd, Schaumburg, IL 60159"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div className="ci-card">
          <div className="ci-card-header">Line Items</div>
          <div className="ci-card-body">
            {lineItems.length > 0 && (
              <div className="ci-li-header">
                <span>Qty</span>
                <span>Description</span>
                <span style={{ textAlign: "right" }}>Amount ($)</span>
                <span></span>
                <span></span>
                <span></span>
              </div>
            )}

            {lineItems.map((li, idx) => (
              <div className="ci-li-row" key={li.tempId}>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={li.quantity}
                  onChange={(e) => updateLineItem(li.tempId, "quantity", e.target.value)}
                  className="ci-li-input"
                  placeholder="Qty"
                />
                <input
                  type="text"
                  value={li.description}
                  onChange={(e) => updateLineItem(li.tempId, "description", e.target.value)}
                  className="ci-li-input"
                  placeholder="Description"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={li.amount}
                  onChange={(e) => updateLineItem(li.tempId, "amount", e.target.value)}
                  className="ci-li-input"
                  placeholder="0.00"
                  style={{ textAlign: "right" }}
                />
                <button type="button" className="ci-li-btn" onClick={() => moveLineItem(idx, -1)} disabled={idx === 0} title="Move up">&#x25B2;</button>
                <button type="button" className="ci-li-btn" onClick={() => moveLineItem(idx, 1)} disabled={idx === lineItems.length - 1} title="Move down">&#x25BC;</button>
                <button type="button" className="ci-li-btn danger" onClick={() => removeLineItem(li.tempId)} title="Remove">&times;</button>
              </div>
            ))}

            <button type="button" className="ci-add-line" onClick={addLineItem}>
              + Add Line Item
            </button>

            <div className="ci-totals">
              <div className="ci-totals-row">
                <span className="ci-totals-label">Subtotal</span>
                <span className="ci-totals-value">{fmtMoney(subtotal)}</span>
              </div>
              <div className="ci-totals-row">
                <span className="ci-totals-label">Tax Rate (%)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  name="taxRate"
                  value={invoice.taxRate}
                  onChange={handleChange}
                  className="ci-totals-input"
                />
              </div>
              <div className="ci-totals-row">
                <span className="ci-totals-label">Tax</span>
                <span className="ci-totals-value">{fmtMoney(taxAmount)}</span>
              </div>
              <div className="ci-totals-row grand">
                <span className="ci-totals-label">Total</span>
                <span className="ci-totals-value">{fmtMoney(total)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Notes & Terms */}
        <div className="ci-card">
          <div className="ci-card-header">Notes & Terms</div>
          <div className="ci-card-body">
            <div className="ci-grid ci-grid-2">
              <div className="ci-field">
                <div className="ci-label">Notes</div>
                <textarea
                  name="notes"
                  value={invoice.notes}
                  onChange={handleChange}
                  className="ci-textarea"
                  placeholder="Additional notes..."
                  rows={3}
                />
              </div>
              <div className="ci-field">
                <div className="ci-label">Payment Terms</div>
                <textarea
                  name="terms"
                  value={invoice.terms}
                  onChange={handleChange}
                  className="ci-textarea"
                  rows={3}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="ci-footer">
          <button className="ci-btn ci-btn-secondary" onClick={() => navigate("/invoices")}>
            Cancel
          </button>
          <button
            className="ci-btn ci-btn-secondary"
            onClick={() => handleSave(false)}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save as Draft"}
          </button>
          <button
            className="ci-btn ci-btn-primary"
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
