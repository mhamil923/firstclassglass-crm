// File: src/ViewCustomer.js
import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import api from "./api";
import "./ViewCustomer.css";

const EMPTY_CUSTOMER = {
  companyName: "",
  contactName: "",
  phone: "",
  email: "",
  fax: "",
  billingAddress: "",
  billingCity: "",
  billingState: "",
  billingZip: "",
  siteAddress: "",
  siteCity: "",
  siteState: "",
  siteZip: "",
  notes: "",
};

export default function ViewCustomer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";

  const [customer, setCustomer] = useState(EMPTY_CUSTOMER);
  const [draft, setDraft] = useState(EMPTY_CUSTOMER);
  const [editing, setEditing] = useState(isNew);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState("workorders");
  const [workOrders, setWorkOrders] = useState([]);
  const [woLoading, setWoLoading] = useState(false);
  const [estimates, setEstimates] = useState([]);
  const [estLoading, setEstLoading] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [invLoading, setInvLoading] = useState(false);

  /* ---------- fetch customer ---------- */
  const fetchCustomer = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const res = await api.get(`/customers/${id}`);
      const c = res.data || {};
      setCustomer(c);
      setDraft(c);
    } catch (err) {
      console.error("Error fetching customer:", err);
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  /* ---------- fetch work orders ---------- */
  const fetchWorkOrders = useCallback(async () => {
    if (isNew) return;
    setWoLoading(true);
    try {
      const res = await api.get(`/customers/${id}/work-orders`);
      setWorkOrders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching customer work orders:", err);
    } finally {
      setWoLoading(false);
    }
  }, [id, isNew]);

  /* ---------- fetch estimates ---------- */
  const fetchEstimates = useCallback(async () => {
    if (isNew) return;
    setEstLoading(true);
    try {
      const res = await api.get("/estimates", { params: { customerId: id } });
      setEstimates(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching customer estimates:", err);
    } finally {
      setEstLoading(false);
    }
  }, [id, isNew]);

  /* ---------- fetch invoices ---------- */
  const fetchInvoices = useCallback(async () => {
    if (isNew) return;
    setInvLoading(true);
    try {
      const res = await api.get("/invoices", { params: { customerId: id } });
      setInvoices(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching customer invoices:", err);
    } finally {
      setInvLoading(false);
    }
  }, [id, isNew]);

  useEffect(() => {
    fetchCustomer();
    fetchWorkOrders();
    fetchEstimates();
    fetchInvoices();
  }, [fetchCustomer, fetchWorkOrders, fetchEstimates, fetchInvoices]);

  /* ---------- form helpers ---------- */
  const handleChange = (e) => {
    const { name, value } = e.target;
    setDraft((prev) => ({ ...prev, [name]: value }));
  };

  const startEdit = () => {
    setDraft({ ...customer });
    setEditing(true);
  };

  const cancelEdit = () => {
    if (isNew) {
      navigate("/customers");
      return;
    }
    setDraft({ ...customer });
    setEditing(false);
  };

  /* ---------- save ---------- */
  const handleSave = async () => {
    if (!draft.companyName?.trim()) {
      alert("Company Name is required.");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const res = await api.post("/customers", draft);
        const newId = res.data?.id;
        if (newId) navigate(`/customers/${newId}`, { replace: true });
        else navigate("/customers");
      } else {
        await api.put(`/customers/${id}`, draft);
        await fetchCustomer();
        setEditing(false);
      }
    } catch (err) {
      console.error("Error saving customer:", err);
      alert("Failed to save customer. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  /* ---------- deactivate ---------- */
  const handleDeactivate = async () => {
    if (!window.confirm("Deactivate this customer? They will be hidden from the customer list."))
      return;
    try {
      await api.delete(`/customers/${id}`);
      navigate("/customers");
    } catch (err) {
      console.error("Error deactivating customer:", err);
      alert("Failed to deactivate customer.");
    }
  };

  /* ---------- helpers ---------- */
  const displayVal = (v) => v || "—";
  const fmtMoney = (v) => {
    const n = Number(v) || 0;
    return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };
  const estStatusClass = (s) => {
    if (!s) return "";
    const sl = s.toLowerCase();
    if (sl === "sent") return { background: "rgba(0,113,227,0.1)", color: "var(--accent-blue)" };
    if (sl === "accepted") return { background: "rgba(52,199,89,0.12)", color: "#34c759" };
    if (sl === "declined") return { background: "rgba(255,59,48,0.12)", color: "#ff3b30" };
    return { background: "rgba(142,142,147,0.12)", color: "#8e8e93" };
  };
  const invStatusStyle = (s) => {
    if (!s) return { background: "rgba(142,142,147,0.12)", color: "#8e8e93" };
    const sl = s.toLowerCase();
    if (sl === "sent") return { background: "rgba(0,113,227,0.1)", color: "var(--accent-blue)" };
    if (sl === "partial") return { background: "rgba(255,159,10,0.12)", color: "#ff9f0a" };
    if (sl === "paid") return { background: "rgba(52,199,89,0.12)", color: "#34c759" };
    if (sl === "overdue") return { background: "rgba(255,59,48,0.12)", color: "#ff3b30" };
    if (sl === "void") return { background: "rgba(142,142,147,0.12)", color: "#636366" };
    return { background: "rgba(142,142,147,0.12)", color: "#8e8e93" };
  };
  const statusColor = (s) => {
    if (!s) return {};
    const sl = s.toLowerCase();
    if (sl.includes("completed")) return { background: "rgba(52,199,89,0.12)", color: "#34c759" };
    if (sl.includes("scheduled")) return { background: "rgba(0,113,227,0.1)", color: "var(--accent-blue)" };
    if (sl.includes("waiting")) return { background: "rgba(255,159,10,0.12)", color: "#ff9f0a" };
    if (sl.includes("new")) return { background: "rgba(94,92,230,0.12)", color: "#5e5ce6" };
    return {};
  };

  const formatDate = (d) => {
    if (!d) return "—";
    try {
      return new Date(d).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return d;
    }
  };

  /* ---------- render ---------- */
  if (loading) return <div className="vc-loading">Loading customer...</div>;

  const title = isNew
    ? "New Customer"
    : customer.companyName || customer.name || "Customer";

  return (
    <div className="vc-page">
      <div className="vc-container">
        {/* Top bar */}
        <div className="vc-topbar">
          <Link to="/customers" className="vc-back">
            &larr; Customers
          </Link>
          <h2 className="vc-title">{title}</h2>
          <div className="vc-actions">
            {editing ? (
              <>
                <button className="vc-btn vc-btn-secondary" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
                <button className="vc-btn vc-btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : isNew ? "Create Customer" : "Save Changes"}
                </button>
              </>
            ) : (
              <>
                <button className="vc-btn vc-btn-secondary" onClick={startEdit}>
                  Edit
                </button>
                <button className="vc-btn vc-btn-danger" onClick={handleDeactivate}>
                  Deactivate
                </button>
              </>
            )}
          </div>
        </div>

        {/* Customer Information */}
        <div className="vc-card">
          <div className="vc-card-header">Customer Information</div>
          <div className="vc-card-body">
            <div className="vc-grid vc-grid-3">
              <div className="vc-field">
                <div className="vc-label">Company Name</div>
                {editing ? (
                  <input
                    name="companyName"
                    value={draft.companyName || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="Company name"
                  />
                ) : (
                  <div className="vc-value">{displayVal(customer.companyName || customer.name)}</div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">Contact Name</div>
                {editing ? (
                  <input
                    name="contactName"
                    value={draft.contactName || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="Contact name"
                  />
                ) : (
                  <div className={`vc-value${customer.contactName ? "" : " muted"}`}>
                    {displayVal(customer.contactName)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">Phone</div>
                {editing ? (
                  <input
                    name="phone"
                    value={draft.phone || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="(###) ###-####"
                  />
                ) : (
                  <div className={`vc-value${customer.phone ? "" : " muted"}`}>
                    {displayVal(customer.phone)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">Email</div>
                {editing ? (
                  <input
                    name="email"
                    type="email"
                    value={draft.email || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="name@example.com"
                  />
                ) : (
                  <div className={`vc-value${customer.email ? "" : " muted"}`}>
                    {displayVal(customer.email)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">Fax</div>
                {editing ? (
                  <input
                    name="fax"
                    value={draft.fax || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="Fax number"
                  />
                ) : (
                  <div className={`vc-value${customer.fax ? "" : " muted"}`}>
                    {displayVal(customer.fax)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Billing Address */}
        <div className="vc-card">
          <div className="vc-card-header">Billing Address</div>
          <div className="vc-card-body">
            <div className="vc-grid vc-grid-4">
              <div className="vc-field">
                <div className="vc-label">Street</div>
                {editing ? (
                  <input
                    name="billingAddress"
                    value={draft.billingAddress || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="Street address"
                  />
                ) : (
                  <div className={`vc-value${customer.billingAddress ? "" : " muted"}`}>
                    {displayVal(customer.billingAddress)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">City</div>
                {editing ? (
                  <input
                    name="billingCity"
                    value={draft.billingCity || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="City"
                  />
                ) : (
                  <div className={`vc-value${customer.billingCity ? "" : " muted"}`}>
                    {displayVal(customer.billingCity)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">State</div>
                {editing ? (
                  <input
                    name="billingState"
                    value={draft.billingState || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="ST"
                  />
                ) : (
                  <div className={`vc-value${customer.billingState ? "" : " muted"}`}>
                    {displayVal(customer.billingState)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">Zip</div>
                {editing ? (
                  <input
                    name="billingZip"
                    value={draft.billingZip || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="ZIP"
                  />
                ) : (
                  <div className={`vc-value${customer.billingZip ? "" : " muted"}`}>
                    {displayVal(customer.billingZip)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Default Site Address */}
        <div className="vc-card">
          <div className="vc-card-header">Default Site Address</div>
          <div className="vc-card-body">
            <div className="vc-grid vc-grid-4">
              <div className="vc-field">
                <div className="vc-label">Street</div>
                {editing ? (
                  <input
                    name="siteAddress"
                    value={draft.siteAddress || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="Street address"
                  />
                ) : (
                  <div className={`vc-value${customer.siteAddress ? "" : " muted"}`}>
                    {displayVal(customer.siteAddress)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">City</div>
                {editing ? (
                  <input
                    name="siteCity"
                    value={draft.siteCity || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="City"
                  />
                ) : (
                  <div className={`vc-value${customer.siteCity ? "" : " muted"}`}>
                    {displayVal(customer.siteCity)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">State</div>
                {editing ? (
                  <input
                    name="siteState"
                    value={draft.siteState || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="ST"
                  />
                ) : (
                  <div className={`vc-value${customer.siteState ? "" : " muted"}`}>
                    {displayVal(customer.siteState)}
                  </div>
                )}
              </div>

              <div className="vc-field">
                <div className="vc-label">Zip</div>
                {editing ? (
                  <input
                    name="siteZip"
                    value={draft.siteZip || ""}
                    onChange={handleChange}
                    className="vc-input"
                    placeholder="ZIP"
                  />
                ) : (
                  <div className={`vc-value${customer.siteZip ? "" : " muted"}`}>
                    {displayVal(customer.siteZip)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="vc-card">
          <div className="vc-card-header">Notes</div>
          <div className="vc-card-body">
            <div className="vc-grid">
              <div className="vc-field vc-field-full">
                {editing ? (
                  <textarea
                    name="notes"
                    value={draft.notes || ""}
                    onChange={handleChange}
                    className="vc-textarea"
                    rows={4}
                    placeholder="Internal notes about this customer..."
                  />
                ) : (
                  <div
                    className={`vc-value${customer.notes ? "" : " muted"}`}
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {displayVal(customer.notes)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Tabs — only for existing customers */}
        {!isNew && (
          <div className="vc-card">
            <div className="vc-tabs">
              <button
                className={`vc-tab${activeTab === "workorders" ? " active" : ""}`}
                onClick={() => setActiveTab("workorders")}
              >
                Work Orders ({workOrders.length})
              </button>
              <button
                className={`vc-tab${activeTab === "estimates" ? " active" : ""}`}
                onClick={() => setActiveTab("estimates")}
              >
                Estimates
              </button>
              <button
                className={`vc-tab${activeTab === "invoices" ? " active" : ""}`}
                onClick={() => setActiveTab("invoices")}
              >
                Invoices
              </button>
            </div>

            {activeTab === "workorders" && (
              <div className="vc-card-body" style={{ padding: 0 }}>
                {woLoading ? (
                  <div className="vc-loading">Loading work orders...</div>
                ) : workOrders.length === 0 ? (
                  <div className="vc-empty">No work orders linked to this customer yet.</div>
                ) : (
                  <table className="vc-wo-table">
                    <thead>
                      <tr>
                        <th>WO #</th>
                        <th>Site</th>
                        <th>Status</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workOrders.map((wo) => (
                        <tr
                          key={wo.id}
                          onClick={() => navigate(`/view-work-order/${wo.id}`)}
                        >
                          <td>{wo.workOrderNumber || wo.id}</td>
                          <td>{wo.siteLocation || wo.siteAddress || "—"}</td>
                          <td>
                            <span className="vc-status-pill" style={statusColor(wo.status)}>
                              {wo.status || "—"}
                            </span>
                          </td>
                          <td>{formatDate(wo.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {activeTab === "estimates" && (
              <div className="vc-card-body" style={{ padding: 0 }}>
                <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-color)" }}>
                  <Link
                    to={`/estimates/new?customerId=${id}`}
                    className="vc-btn vc-btn-primary"
                    style={{ fontSize: 13, padding: "6px 14px", textDecoration: "none" }}
                  >
                    + Create Estimate
                  </Link>
                </div>
                {estLoading ? (
                  <div className="vc-loading">Loading estimates...</div>
                ) : estimates.length === 0 ? (
                  <div className="vc-empty">No estimates for this customer yet.</div>
                ) : (
                  <table className="vc-wo-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Project</th>
                        <th>Status</th>
                        <th style={{ textAlign: "right" }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estimates.map((est) => (
                        <tr key={est.id} onClick={() => navigate(`/estimates/${est.id}`)}>
                          <td>{formatDate(est.issueDate || est.createdAt)}</td>
                          <td>{est.projectName || "—"}</td>
                          <td>
                            <span className="vc-status-pill" style={estStatusClass(est.status)}>
                              {est.status || "Draft"}
                            </span>
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                            {fmtMoney(est.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {activeTab === "invoices" && (
              <div className="vc-card-body" style={{ padding: 0 }}>
                <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-color)" }}>
                  <Link
                    to={`/invoices/new?customerId=${id}`}
                    className="vc-btn vc-btn-primary"
                    style={{ fontSize: 13, padding: "6px 14px", textDecoration: "none" }}
                  >
                    + Create Invoice
                  </Link>
                </div>
                {invLoading ? (
                  <div className="vc-loading">Loading invoices...</div>
                ) : invoices.length === 0 ? (
                  <div className="vc-empty">No invoices for this customer yet.</div>
                ) : (
                  <table className="vc-wo-table">
                    <thead>
                      <tr>
                        <th>Invoice #</th>
                        <th>Date</th>
                        <th>Project</th>
                        <th>Status</th>
                        <th style={{ textAlign: "right" }}>Total</th>
                        <th style={{ textAlign: "right" }}>Balance Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv) => (
                        <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
                          <td style={{ fontWeight: 600 }}>{inv.invoiceNumber || "—"}</td>
                          <td>{formatDate(inv.issueDate || inv.createdAt)}</td>
                          <td>{inv.projectName || "—"}</td>
                          <td>
                            <span className="vc-status-pill" style={invStatusStyle(inv.status)}>
                              {inv.status || "Draft"}
                            </span>
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                            {fmtMoney(inv.total)}
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: Number(inv.balanceDue) > 0 ? "#ff3b30" : undefined }}>
                            {fmtMoney(inv.balanceDue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
