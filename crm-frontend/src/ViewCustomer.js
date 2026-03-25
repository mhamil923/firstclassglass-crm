// File: src/ViewCustomer.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
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

  // Merge state
  const [showMerge, setShowMerge] = useState(false);
  const [mergeSearch, setMergeSearch] = useState("");
  const [mergeCustomers, setMergeCustomers] = useState([]);
  const [mergeTarget, setMergeTarget] = useState(null);
  const [mergePreview, setMergePreview] = useState(null);
  const [merging, setMerging] = useState(false);
  const [mergeDropdownOpen, setMergeDropdownOpen] = useState(false);
  const [mergeKeep, setMergeKeep] = useState("current"); // "current" or "duplicate"
  const mergeDropdownRef = useRef(null);
  const mergeInputRef = useRef(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });

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

  // Close merge dropdown on outside click (accounts for portal)
  useEffect(() => {
    const handler = (e) => {
      const inInput = mergeDropdownRef.current && mergeDropdownRef.current.contains(e.target);
      const inPortal = e.target.closest && e.target.closest(".vc-merge-dropdown-portal");
      if (!inInput && !inPortal) {
        setMergeDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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
    const linkedCount = workOrders.length + estimates.length + invoices.length;
    const msg = linkedCount > 0
      ? `This customer has ${workOrders.length} work orders, ${estimates.length} estimates, and ${invoices.length} invoices linked. Deactivate anyway? They will be hidden from the customer list.`
      : "Deactivate this customer? They will be hidden from the customer list.";
    if (!window.confirm(msg)) return;
    try {
      await api.delete(`/customers/${id}`);
      navigate("/customers");
    } catch (err) {
      console.error("Error deactivating customer:", err);
      alert("Failed to deactivate customer.");
    }
  };

  /* ---------- merge ---------- */
  const openMerge = async () => {
    setShowMerge(true);
    setMergeSearch("");
    setMergeTarget(null);
    setMergePreview(null);
    setMergeKeep("current");
    try {
      const res = await api.get("/customers");
      const all = (Array.isArray(res.data) ? res.data : []).filter((c) => c.id !== Number(id));
      setMergeCustomers(all);
    } catch (err) {
      console.error("Error loading customers for merge:", err);
    }
  };

  const selectMergeTarget = async (c) => {
    setMergeTarget(c);
    setMergeSearch(c.companyName || c.name || "");
    setMergeDropdownOpen(false);
    try {
      const res = await api.get(`/customers/${c.id}/merge-preview`);
      // merge-preview now returns { customer, workOrders, estimates, invoices }
      setMergePreview(res.data);
      // Update mergeTarget with full customer data from preview
      if (res.data.customer) setMergeTarget(res.data.customer);
    } catch {
      setMergePreview({ workOrders: "?", estimates: "?", invoices: "?" });
    }
  };

  const executeMerge = async () => {
    if (!mergeTarget) return;
    // Determine keep vs delete based on user choice
    const keepCurrent = mergeKeep === "current";
    const keepId = keepCurrent ? id : mergeTarget.id;
    const sourceId = keepCurrent ? mergeTarget.id : Number(id);
    const keepName = keepCurrent ? (customer.companyName || customer.name) : (mergeTarget.companyName || mergeTarget.name);
    const deleteName = keepCurrent ? (mergeTarget.companyName || mergeTarget.name) : (customer.companyName || customer.name);

    if (!window.confirm(
      `MERGE "${deleteName}" into "${keepName}"?\n\nAll work orders, estimates, and invoices from "${deleteName}" will be moved to "${keepName}".\n\n"${deleteName}" will be permanently deleted.\n\nThis cannot be undone.`
    )) return;

    setMerging(true);
    try {
      const res = await api.post(`/customers/${keepId}/merge`, { sourceId });
      const u = res.data.updated || {};
      alert(`Merge complete! Updated ${u.workOrders || 0} work orders, ${u.estimates || 0} estimates, ${u.invoices || 0} invoices.`);
      setShowMerge(false);
      setMergeTarget(null);
      if (keepCurrent) {
        // Refresh current customer page
        fetchCustomer();
        fetchWorkOrders();
        fetchEstimates();
        fetchInvoices();
      } else {
        // Navigate to the kept customer's page
        navigate(`/customers/${mergeTarget.id}`);
      }
    } catch (err) {
      console.error("Merge error:", err);
      alert("Failed to merge customers. " + (err.response?.data?.error || ""));
    } finally {
      setMerging(false);
    }
  };

  const filteredMergeCustomers = mergeCustomers.filter((c) => {
    const q = (mergeSearch || "").toLowerCase().trim();
    if (!q) return true;
    return (c.companyName || c.name || "").toLowerCase().includes(q) ||
           (c.contactName || "").toLowerCase().includes(q);
  }).slice(0, 15);

  /* ---------- helpers ---------- */
  const displayVal = (v) => v || "\u2014";
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
    if (!d) return "\u2014";
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
                {!isNew && (
                  <button className="vc-btn vc-btn-secondary" onClick={openMerge}>
                    Merge Duplicate
                  </button>
                )}
                <button className="vc-btn vc-btn-danger" onClick={handleDeactivate}>
                  Deactivate
                </button>
              </>
            )}
          </div>
        </div>

        {/* Merge Panel */}
        {showMerge && !isNew && (
          <div className="vc-card" style={{ borderColor: "var(--accent-orange)", borderWidth: 2 }}>
            <div className="vc-card-header" style={{ background: "rgba(255,149,0,0.08)", color: "var(--accent-orange)" }}>
              Merge Duplicate Customer
            </div>
            <div className="vc-card-body">
              <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: "0 0 16px 0" }}>
                Search for the duplicate customer to merge <strong>into</strong> "{customer.companyName || customer.name}".
                All their work orders, estimates, and invoices will be moved here, and the duplicate will be deleted.
              </p>

              <div ref={mergeDropdownRef} style={{ position: "relative", maxWidth: 500 }}>
                <div className="vc-label">Search Customer to Merge</div>
                <input
                  ref={mergeInputRef}
                  type="text"
                  className="vc-input"
                  placeholder="Type customer name..."
                  value={mergeSearch}
                  onChange={(e) => {
                    setMergeSearch(e.target.value);
                    setMergeTarget(null);
                    setMergePreview(null);
                    setMergeDropdownOpen(true);
                  }}
                  onFocus={() => {
                    setMergeDropdownOpen(true);
                    if (mergeInputRef.current) {
                      const rect = mergeInputRef.current.getBoundingClientRect();
                      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 420) });
                    }
                  }}
                  onKeyDown={() => {
                    if (mergeInputRef.current) {
                      const rect = mergeInputRef.current.getBoundingClientRect();
                      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 420) });
                    }
                  }}
                  autoComplete="off"
                />
                {mergeDropdownOpen && mergeSearch.trim().length > 0 && ReactDOM.createPortal(
                  <div className="vc-merge-dropdown-portal" style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}>
                    {filteredMergeCustomers.map((c) => {
                      const addr = [c.billingAddress, c.billingCity, c.billingState, c.billingZip].filter(Boolean).join(", ");
                      return (
                        <div key={c.id} className="vc-merge-option" onMouseDown={() => selectMergeTarget(c)}>
                          <div className="vc-merge-opt-name">{c.companyName || c.name}</div>
                          {addr && <div className="vc-merge-opt-addr">{addr}</div>}
                          <div className="vc-merge-opt-contact">
                            {c.phone && <span>{c.phone}</span>}
                            {c.email && <span>{c.email}</span>}
                            {c.contactName && <span>{c.contactName}</span>}
                          </div>
                        </div>
                      );
                    })}
                    {filteredMergeCustomers.length === 0 && (
                      <div className="vc-merge-option" style={{ color: "var(--text-tertiary)", cursor: "default" }}>No customers found</div>
                    )}
                  </div>,
                  document.body
                )}
              </div>

              {mergeTarget && mergePreview && (() => {
                const isEmpty = (v) => !v || !String(v).trim() || String(v).trim() === "\u2014" || String(v).trim() === "-";
                const fields = [
                  { key: "companyName", label: "Company Name" },
                  { key: "contactName", label: "Contact Name" },
                  { key: "phone", label: "Phone" },
                  { key: "email", label: "Email" },
                  { key: "fax", label: "Fax" },
                  { key: "billingAddress", label: "Billing Address" },
                  { key: "billingCity", label: "City" },
                  { key: "billingState", label: "State" },
                  { key: "billingZip", label: "Zip" },
                ];
                const src = mergeTarget;
                const tgt = customer;
                const currentPreview = { customer: tgt, workOrders: workOrders.length, estimates: estimates.length, invoices: invoices.length };
                const keepCustomer = mergeKeep === "current" ? tgt : src;
                const deleteCustomer = mergeKeep === "current" ? src : tgt;
                return (
                  <div className="vc-merge-preview">
                    <div className="vc-merge-preview-title">
                      Choose Which Customer to Keep
                    </div>

                    <div className="vc-merge-compare">
                      {/* Current customer */}
                      <label className={`vc-merge-compare-card${mergeKeep === "current" ? " vc-merge-selected" : ""}`}>
                        <div className="vc-merge-compare-radio">
                          <input type="radio" name="mergeKeep" value="current" checked={mergeKeep === "current"} onChange={() => setMergeKeep("current")} />
                          <span className="vc-merge-radio-label">Keep This Customer</span>
                        </div>
                        <div className="vc-merge-compare-name">{tgt.companyName || tgt.name || "—"}</div>
                        <div className="vc-merge-compare-details">
                          {tgt.contactName && <div>{tgt.contactName}</div>}
                          {tgt.phone && <div>{tgt.phone}</div>}
                          {tgt.email && <div>{tgt.email}</div>}
                          {tgt.billingAddress && <div>{[tgt.billingAddress, tgt.billingCity, tgt.billingState, tgt.billingZip].filter(Boolean).join(", ")}</div>}
                        </div>
                        <div className="vc-merge-compare-counts">
                          <span>{currentPreview.workOrders} work orders</span>
                          <span>{currentPreview.estimates} estimates</span>
                          <span>{currentPreview.invoices} invoices</span>
                        </div>
                      </label>

                      {/* Duplicate customer */}
                      <label className={`vc-merge-compare-card${mergeKeep === "duplicate" ? " vc-merge-selected" : ""}`}>
                        <div className="vc-merge-compare-radio">
                          <input type="radio" name="mergeKeep" value="duplicate" checked={mergeKeep === "duplicate"} onChange={() => setMergeKeep("duplicate")} />
                          <span className="vc-merge-radio-label">Keep This Customer</span>
                        </div>
                        <div className="vc-merge-compare-name">{src.companyName || src.name || "—"}</div>
                        <div className="vc-merge-compare-details">
                          {src.contactName && <div>{src.contactName}</div>}
                          {src.phone && <div>{src.phone}</div>}
                          {src.email && <div>{src.email}</div>}
                          {src.billingAddress && <div>{[src.billingAddress, src.billingCity, src.billingState, src.billingZip].filter(Boolean).join(", ")}</div>}
                        </div>
                        <div className="vc-merge-compare-counts">
                          <span>{mergePreview.workOrders} work orders</span>
                          <span>{mergePreview.estimates} estimates</span>
                          <span>{mergePreview.invoices} invoices</span>
                        </div>
                      </label>
                    </div>

                    <div className="vc-merge-summary-box">
                      <strong>Result:</strong> Keep "{keepCustomer.companyName || keepCustomer.name}" — all records from
                      "{deleteCustomer.companyName || deleteCustomer.name}" will be moved over. Empty fields on the kept customer
                      will be filled from the deleted one. "{deleteCustomer.companyName || deleteCustomer.name}" will be permanently deleted.
                    </div>

                    <div className="vc-merge-actions">
                      <button className="vc-btn vc-btn-secondary" onClick={() => { setShowMerge(false); setMergeTarget(null); setMergePreview(null); }}>
                        Cancel
                      </button>
                      <button className="vc-btn vc-btn-danger" onClick={executeMerge} disabled={merging}
                        style={{ background: "var(--accent-red)", color: "#fff", borderColor: "var(--accent-red)" }}>
                        {merging ? "Merging..." : "Confirm Merge"}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

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
                Estimates ({estimates.length})
              </button>
              <button
                className={`vc-tab${activeTab === "invoices" ? " active" : ""}`}
                onClick={() => setActiveTab("invoices")}
              >
                Invoices ({invoices.length})
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
                          <td>{wo.siteLocation || wo.siteAddress || "\u2014"}</td>
                          <td>
                            <span className="vc-status-pill" style={statusColor(wo.status)}>
                              {wo.status || "\u2014"}
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
                          <td>{est.projectName || "\u2014"}</td>
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
                          <td style={{ fontWeight: 600 }}>{inv.invoiceNumber || "\u2014"}</td>
                          <td>{formatDate(inv.issueDate || inv.createdAt)}</td>
                          <td>{inv.projectName || "\u2014"}</td>
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
