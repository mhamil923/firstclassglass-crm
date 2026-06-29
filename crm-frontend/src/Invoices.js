// File: src/Invoices.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api from "./api";
import SendEmailModal from "./SendEmailModal";
import "./Invoices.css";

const STATUS_OPTIONS = ["All", "Draft", "Sent", "Partial", "Paid", "Overdue", "Void"];
const PAYMENT_STATUS_OPTIONS = ["All", "Unpaid", "Partial", "Paid"];

function derivePaymentStatus(inv) {
  if (inv?.paymentStatus) return inv.paymentStatus;
  const total = Number(inv?.total) || 0;
  const paid = Number(inv?.amountPaid) || 0;
  if (paid >= total && total > 0) return "Paid";
  if (paid > 0) return "Partial";
  return "Unpaid";
}

function paymentStatusStyle(status) {
  if (status === "Paid") return { background: "#34c759", color: "#fff" };
  if (status === "Partial") return { background: "#f59e0b", color: "#fff" };
  return { background: "#ef4444", color: "#fff" };
}

/* ─── Chevron SVG for collapsible ─── */
function ChevronDown({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
    </svg>
  );
}

function statusClass(s) {
  if (!s) return "inv-status-draft";
  const sl = s.toLowerCase();
  if (sl === "sent") return "inv-status-sent";
  if (sl === "partial") return "inv-status-partial";
  if (sl === "paid") return "inv-status-paid";
  if (sl === "overdue") return "inv-status-overdue";
  if (sl === "void") return "inv-status-void";
  return "inv-status-draft";
}

function fmtMoney(val) {
  const n = Number(val) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDate(d) {
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
}

export default function Invoices() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "All");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState(
    searchParams.get("paymentStatus") || "All"
  );
  const debounceRef = useRef(null);

  // Ready to Invoice state
  const [rtiOrders, setRtiOrders] = useState([]);
  const [rtiOpen, setRtiOpen] = useState(true);

  // Reminder email modal
  const [reminderInvoice, setReminderInvoice] = useState(null);

  // ─── Collections tab ───
  const [view, setView] = useState("invoices"); // 'invoices' | 'collections'
  const [collections, setCollections] = useState([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [payLinkEdit, setPayLinkEdit] = useState({}); // { [invoiceId]: draftValue }
  // Review-before-send draft modal
  const [draftModal, setDraftModal] = useState(null);

  const fetchCollections = useCallback(async () => {
    setCollectionsLoading(true);
    try {
      const res = await api.get("/invoices/collections");
      setCollections(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching collections:", err);
      setCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "collections") fetchCollections();
  }, [view, fetchCollections]);

  const savePayLink = async (invoiceId) => {
    const link = payLinkEdit[invoiceId] ?? "";
    try {
      await api.put(`/invoices/${invoiceId}/paylink`, { qbPayLink: link });
      setPayLinkEdit((m) => { const n = { ...m }; delete n[invoiceId]; return n; });
      setCollections((prev) => prev.map((c) => (c.id === invoiceId ? { ...c, qbPayLink: link } : c)));
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to save pay link.");
    }
  };

  const openDraft = async (row) => {
    try {
      const res = await api.post(`/invoices/${row.id}/reminder/draft`, {});
      const d = res.data || {};
      setDraftModal({
        invoiceId: row.id,
        row,
        to: d.to || row.customerEmail || "",
        subject: d.subject || "",
        body: d.body || "",
        lateFee: d.lateFee ?? row.lateFee ?? 0,
        outstanding: d.outstanding ?? row.outstanding ?? 0,
        reminderStage: d.reminderStage || row.reminderStage,
        payLinkOnFile: !!d.payLinkOnFile,
        noPayLinkWarning: d.noPayLinkWarning || null,
        sending: false,
      });
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to draft reminder.");
    }
  };

  const sendDraft = async () => {
    if (!draftModal || draftModal.sending) return; // guard against double-click
    setDraftModal((m) => ({ ...m, sending: true }));
    try {
      await api.post(`/invoices/${draftModal.invoiceId}/reminder/send`, {
        to: draftModal.to,
        subject: draftModal.subject,
        body: draftModal.body,
      });
      setDraftModal(null);
      await fetchCollections();
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to send reminder.");
      setDraftModal((m) => (m ? { ...m, sending: false } : m));
    }
  };

  const skipReminder = async (invoiceId) => {
    try {
      await api.post(`/invoices/${invoiceId}/reminder/skip`, {});
      await fetchCollections();
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to skip.");
    }
  };

  const daysOverdueBadge = (d) => {
    if (d == null || d < 0) return { background: "#34c759", color: "#fff", label: d == null ? "—" : "Not due" };
    if (d < 45) return { background: "#f59e0b", color: "#fff", label: `${d}d` };
    return { background: "#dc2626", color: "#fff", label: `${d}d` };
  };

  const fetchReadyToInvoice = useCallback(async () => {
    try {
      const res = await api.get("/work-orders/by-status/Needs to be Invoiced");
      setRtiOrders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching ready-to-invoice WOs:", err);
    }
  }, []);

  useEffect(() => {
    fetchReadyToInvoice();
  }, [fetchReadyToInvoice]);

  const fetchInvoices = useCallback(async (q, status) => {
    setLoading(true);
    try {
      const params = {};
      if (q && q.trim()) params.search = q.trim();
      if (status && status !== "All") params.status = status;
      const res = await api.get("/invoices", { params });
      setInvoices(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching invoices:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvoices("", statusFilter);
  }, [fetchInvoices, statusFilter]);

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchInvoices(val, statusFilter), 300);
  };

  const handleStatusChange = (e) => {
    const val = e.target.value;
    setStatusFilter(val);
    fetchInvoices(search, val);
  };

  const totalOutstanding = invoices.reduce((sum, inv) => {
    if (inv.status !== "Paid" && inv.status !== "Void") return sum + (Number(inv.balanceDue) || 0);
    return sum;
  }, 0);

  return (
    <div className="inv-page">
      <div className="inv-container">
        <div className="inv-header">
          <div>
            <h2 className="inv-title">Invoices</h2>
            <div className="inv-subtitle">
              Manage invoices and track payments.
              {totalOutstanding > 0 && (
                <span className="inv-outstanding">
                  {" "}Outstanding: <strong>{fmtMoney(totalOutstanding)}</strong>
                </span>
              )}
            </div>
          </div>
          <div className="inv-actions">
            <Link to="/invoices/new" className="btn-primary-apple">
              + Create Invoice
            </Link>
          </div>
        </div>

        {/* ─── Tabs: Invoices | Collections ─── */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {[
            { key: "invoices", label: "Invoices" },
            { key: "collections", label: "Collections" },
          ].map((t) => {
            const active = view === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setView(t.key)}
                style={{
                  border: "2px solid #1b5e20",
                  background: active ? "#1b5e20" : "transparent",
                  color: active ? "#fff" : "#1b5e20",
                  borderRadius: 20,
                  padding: "5px 16px",
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {t.label}
                {t.key === "collections" && collections.length > 0 && (
                  <span style={{ background: active ? "#fff" : "#1b5e20", color: active ? "#1b5e20" : "#fff", borderRadius: 10, padding: "1px 8px", fontSize: 12, fontWeight: 700 }}>
                    {collections.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ─── Ready to Invoice Section ─── */}
        {view === "invoices" && rtiOrders.length > 0 && (
          <div className="inv-rti-section">
            <div className="inv-rti-header" onClick={() => setRtiOpen(!rtiOpen)}>
              <div className="inv-rti-header-left">
                <h3>Ready to Invoice</h3>
                <span className="inv-rti-count">{rtiOrders.length}</span>
              </div>
              <ChevronDown className={`inv-rti-chevron${rtiOpen ? " open" : ""}`} />
            </div>
            {rtiOpen && (
              <div className="inv-rti-body">
                <div className="inv-rti-grid">
                  {rtiOrders.map((wo) => {
                    const accepted = wo.acceptedEstimate;
                    const estTotal = accepted ? Number(accepted.total) || 0 : null;
                    return (
                      <div key={wo.id} className="inv-rti-card">
                        <div className="inv-rti-card-top">
                          <div className="inv-rti-card-info">
                            <p className="inv-rti-customer">{wo.customer || "—"}</p>
                            <p className="inv-rti-detail">
                              {wo.siteLocation || wo.siteAddress || "No site location"}
                            </p>
                            {wo.allPoNumbersFormatted && (
                              <p className="inv-rti-detail">PO: {wo.allPoNumbersFormatted}</p>
                            )}
                            {accepted && (
                              <span className="inv-rti-estimate-tag">
                                Accepted Estimate: ${estTotal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
                              </span>
                            )}
                          </div>
                          <Link
                            to={`/view-work-order/${wo.id}`}
                            className="inv-rti-wo-link"
                            onClick={(e) => e.stopPropagation()}
                          >
                            WO #{wo.workOrderNumber || wo.id}
                          </Link>
                        </div>
                        <div className="inv-rti-card-actions">
                          {accepted ? (
                            <Link
                              to={`/invoices/new?estimateId=${accepted.id}`}
                              className="inv-rti-create-btn"
                            >
                              + Create from Estimate
                            </Link>
                          ) : (
                            <Link
                              to={`/invoices/new?workOrderId=${wo.id}`}
                              className="inv-rti-create-btn"
                            >
                              + Create Invoice
                            </Link>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {view === "invoices" && (
        <div className="cust-section-card">
          <div className="cust-section-body">
            <div className="inv-toolbar">
              <input
                type="text"
                className="inv-search-input"
                placeholder="Search by invoice #, customer, project, P.O. number..."
                value={search}
                onChange={handleSearchChange}
              />
              <select
                className="inv-filter-select"
                value={statusFilter}
                onChange={handleStatusChange}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s === "All" ? "All Statuses" : s}</option>
                ))}
              </select>
              <select
                className="inv-filter-select"
                value={paymentStatusFilter}
                onChange={(e) => setPaymentStatusFilter(e.target.value)}
                aria-label="Payment status filter"
              >
                {PAYMENT_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s === "All" ? "All Payments" : s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Ship To</th>
                  <th>P.O. No.</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th style={{ textAlign: "right" }}>Balance Due</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const visibleInvoices =
                    paymentStatusFilter === "All"
                      ? invoices
                      : invoices.filter((i) => derivePaymentStatus(i) === paymentStatusFilter);

                  if (visibleInvoices.length === 0 && !loading) {
                    return (
                      <tr>
                        <td colSpan={10}>
                          <div className="inv-empty">
                            {search || statusFilter !== "All" || paymentStatusFilter !== "All"
                              ? "No invoices match your filters."
                              : "No invoices yet. Create your first invoice to get started."}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return visibleInvoices.map((inv) => {
                    const payStatus = derivePaymentStatus(inv);
                    const payStyle = paymentStatusStyle(payStatus);
                    return (
                      <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
                        <td data-label="Invoice #">
                          <span className="inv-number">#{inv.invoiceNumber}</span>
                        </td>
                        <td data-label="Date">{fmtDate(inv.issueDate || inv.createdAt)}</td>
                        <td data-label="Customer">
                          <span className="inv-customer-name">
                            {inv.companyName || inv.custName || "—"}
                          </span>
                        </td>
                        <td data-label="Ship To">{inv.projectName || "—"}</td>
                        <td data-label="P.O. No.">{inv.poNumber || "—"}</td>
                        <td data-label="Status">
                          <span className={`inv-status-pill ${statusClass(inv.status)}`}>
                            {inv.status || "Draft"}
                          </span>
                        </td>
                        <td data-label="Payment">
                          <span
                            style={{
                              ...payStyle,
                              padding: "3px 10px",
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: 0.3,
                              display: "inline-block",
                            }}
                          >
                            {payStatus}
                          </span>
                        </td>
                        <td data-label="Total" style={{ textAlign: "right" }}>
                          <span className="inv-total">{fmtMoney(inv.total)}</span>
                        </td>
                        <td data-label="Balance Due" style={{ textAlign: "right" }}>
                          <span className={`inv-balance${Number(inv.balanceDue) > 0 ? " inv-balance-due" : ""}`}>
                            {fmtMoney(inv.balanceDue)}
                          </span>
                        </td>
                        <td style={{ textAlign: "center", width: 50 }}>
                          {(inv.status === "Sent" || inv.status === "Overdue") && Number(inv.balanceDue) > 0 && (
                            <button
                              className="inv-remind-btn"
                              title="Send payment reminder"
                              onClick={(e) => { e.stopPropagation(); setReminderInvoice(inv); }}
                            >
                              &#9993;
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>

          {loading && (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              Loading...
            </div>
          )}
        </div>
        )}

        {/* ─── Collections / Payments Due ─── */}
        {view === "collections" && (
          <div className="cust-section-card">
            <div className="cust-section-body">
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>
                Unpaid &amp; partial invoices, most overdue first. QuickBooks Desktop is the source of truth — the CRM tracks overdue status, computes late fees, and drafts reminders for your review before sending.
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="inv-table">
                <thead>
                  <tr>
                    <th>Customer / Invoice #</th>
                    <th style={{ textAlign: "right" }}>Outstanding</th>
                    <th style={{ textAlign: "center" }}>Days Overdue</th>
                    <th style={{ textAlign: "right" }}>Late Fee</th>
                    <th>Reminder Stage</th>
                    <th>Last Reminded</th>
                    <th>Pay Link</th>
                    <th style={{ width: 230 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {collections.length === 0 && !collectionsLoading && (
                    <tr><td colSpan={8}><div className="inv-empty">No unpaid or partial invoices to collect. 🎉</div></td></tr>
                  )}
                  {collections.map((row) => {
                    const badge = daysOverdueBadge(row.daysOverdue);
                    const isPartial = Number(row.amountPaid) > 0 && Number(row.amountPaid) < Number(row.total);
                    const editing = Object.prototype.hasOwnProperty.call(payLinkEdit, row.id);
                    const lateFeeTip =
                      row.lateFee > 0
                        ? `15% applied at the 45-day due date, compounding +15% every 30 days. Outstanding ${fmtMoney(row.outstanding)} → late fee ${fmtMoney(row.lateFee)} (stage: ${row.reminderStage}).`
                        : "No late fee — not yet 45 days past the invoice date.";
                    return (
                      <tr key={row.id}>
                        <td data-label="Customer">
                          <div style={{ fontWeight: 600 }}>{row.customer}</div>
                          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>#{row.invoiceNumber}</div>
                        </td>
                        <td data-label="Outstanding" style={{ textAlign: "right" }}>
                          <div style={{ fontWeight: 700 }}>{fmtMoney(row.outstanding)}</div>
                          {isPartial && (
                            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                              Paid {fmtMoney(row.amountPaid)} of {fmtMoney(row.total)}
                            </div>
                          )}
                        </td>
                        <td data-label="Days Overdue" style={{ textAlign: "center" }}>
                          <span style={{ background: badge.background, color: badge.color, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
                            {badge.label}
                          </span>
                        </td>
                        <td data-label="Late Fee" style={{ textAlign: "right" }}>
                          <span title={lateFeeTip} style={{ color: row.lateFee > 0 ? "#dc2626" : "var(--text-tertiary)", fontWeight: row.lateFee > 0 ? 700 : 400, cursor: "help" }}>
                            {fmtMoney(row.lateFee)}
                          </span>
                        </td>
                        <td data-label="Stage">{row.reminderStage}</td>
                        <td data-label="Last Reminded" style={{ fontSize: 12 }}>
                          {row.lastReminderAt ? fmtDate(row.lastReminderAt) : <span style={{ color: "var(--text-tertiary)" }}>Never</span>}
                        </td>
                        <td data-label="Pay Link">
                          {!editing && row.qbPayLink ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <span style={{ color: "#34c759", fontWeight: 700 }}>✓ On file</span>
                              <button type="button" className="link-btn" style={{ fontSize: 11, background: "none", border: "none", color: "#1b5e20", cursor: "pointer", textDecoration: "underline" }} onClick={() => setPayLinkEdit((m) => ({ ...m, [row.id]: row.qbPayLink || "" }))}>edit</button>
                            </span>
                          ) : !editing ? (
                            <button type="button" style={{ fontSize: 12, background: "none", border: "none", color: "#1b5e20", cursor: "pointer", textDecoration: "underline" }} onClick={() => setPayLinkEdit((m) => ({ ...m, [row.id]: "" }))}>+ Add pay link</button>
                          ) : (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <input
                                type="text"
                                value={payLinkEdit[row.id]}
                                onChange={(e) => setPayLinkEdit((m) => ({ ...m, [row.id]: e.target.value }))}
                                placeholder="Paste QuickBooks pay URL"
                                style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #ccc", borderRadius: 6, width: 180 }}
                              />
                              <button type="button" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => savePayLink(row.id)}>Save</button>
                              <button type="button" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => setPayLinkEdit((m) => { const n = { ...m }; delete n[row.id]; return n; })}>✕</button>
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="btn-primary-apple" style={{ fontSize: 12, padding: "4px 10px", marginRight: 4 }} onClick={() => openDraft(row)}>Draft Reminder</button>
                          <button type="button" style={{ fontSize: 12, padding: "4px 10px", marginRight: 4, cursor: "pointer" }} onClick={() => navigate(`/invoices/${row.id}`)}>Open</button>
                          <button type="button" style={{ fontSize: 12, padding: "4px 10px", cursor: "pointer" }} onClick={() => skipReminder(row.id)}>Skip</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {collectionsLoading && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>Loading...</div>
            )}
          </div>
        )}
      </div>

      {/* Review-before-send Draft Reminder modal */}
      {draftModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => !draftModal.sending && setDraftModal(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 600, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700 }}>
              Review reminder — {draftModal.row.customer} (#{draftModal.row.invoiceNumber})
            </h3>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0 16px", fontSize: 13 }}>
              <span>Stage: <strong>{draftModal.reminderStage}</strong></span>
              <span>Outstanding: <strong>{fmtMoney(draftModal.outstanding)}</strong></span>
              <span style={{ color: draftModal.lateFee > 0 ? "#dc2626" : "inherit" }}>
                Late fee: <strong>{fmtMoney(draftModal.lateFee)}</strong>
              </span>
              <span>Pay link: <strong style={{ color: draftModal.payLinkOnFile ? "#34c759" : "#dc2626" }}>{draftModal.payLinkOnFile ? "✓ included" : "none on file"}</strong></span>
            </div>
            {draftModal.noPayLinkWarning && (
              <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 12 }}>
                {draftModal.noPayLinkWarning}
              </div>
            )}
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>To</label>
            <input type="text" value={draftModal.to} onChange={(e) => setDraftModal((m) => ({ ...m, to: e.target.value }))} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #d1d5db", marginBottom: 12 }} />
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Subject</label>
            <input type="text" value={draftModal.subject} onChange={(e) => setDraftModal((m) => ({ ...m, subject: e.target.value }))} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #d1d5db", marginBottom: 12 }} />
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Body</label>
            <textarea value={draftModal.body} onChange={(e) => setDraftModal((m) => ({ ...m, body: e.target.value }))} rows={14} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #d1d5db", resize: "vertical", fontFamily: "inherit", fontSize: 13 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => setDraftModal(null)} disabled={draftModal.sending} style={{ padding: "8px 16px", cursor: "pointer" }}>Cancel</button>
              <button type="button" className="btn-primary-apple" onClick={sendDraft} disabled={draftModal.sending || !draftModal.to || !draftModal.subject || !draftModal.body}>
                {draftModal.sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reminder Email Modal */}
      {reminderInvoice && (
        <SendEmailModal
          isOpen={true}
          onClose={() => setReminderInvoice(null)}
          type="payment_reminder"
          entityId={reminderInvoice.id}
          entityData={reminderInvoice}
          customerEmail={reminderInvoice.custEmail || ""}
          customerName={reminderInvoice.companyName || reminderInvoice.custName || ""}
          onSent={() => { setReminderInvoice(null); fetchInvoices(search, statusFilter); }}
        />
      )}
    </div>
  );
}
