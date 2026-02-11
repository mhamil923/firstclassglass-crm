// File: src/Invoices.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api from "./api";
import "./Invoices.css";

const STATUS_OPTIONS = ["All", "Draft", "Sent", "Partial", "Paid", "Overdue", "Void"];

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
