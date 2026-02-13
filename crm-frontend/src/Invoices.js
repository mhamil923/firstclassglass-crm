// File: src/Invoices.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api from "./api";
import "./Invoices.css";

const STATUS_OPTIONS = ["All", "Draft", "Sent", "Partial", "Paid", "Overdue", "Void"];

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
  const debounceRef = useRef(null);

  // Ready to Invoice state
  const [rtiOrders, setRtiOrders] = useState([]);
  const [rtiOpen, setRtiOpen] = useState(true);

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

        {/* ─── Ready to Invoice Section ─── */}
        {rtiOrders.length > 0 && (
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
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th style={{ textAlign: "right" }}>Balance Due</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 && !loading && (
                  <tr>
                    <td colSpan={8}>
                      <div className="inv-empty">
                        {search || statusFilter !== "All"
                          ? "No invoices match your filters."
                          : "No invoices yet. Create your first invoice to get started."}
                      </div>
                    </td>
                  </tr>
                )}
                {invoices.map((inv) => (
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
                    <td data-label="Total" style={{ textAlign: "right" }}>
                      <span className="inv-total">{fmtMoney(inv.total)}</span>
                    </td>
                    <td data-label="Balance Due" style={{ textAlign: "right" }}>
                      <span className={`inv-balance${Number(inv.balanceDue) > 0 ? " inv-balance-due" : ""}`}>
                        {fmtMoney(inv.balanceDue)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {loading && (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              Loading...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
