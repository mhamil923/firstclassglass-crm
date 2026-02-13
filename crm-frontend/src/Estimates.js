// File: src/Estimates.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "./api";
import "./Estimates.css";

const STATUS_OPTIONS = ["All", "Draft", "Sent", "Accepted", "Declined"];

/* ─── Chevron SVG for collapsible ─── */
function ChevronDown({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
    </svg>
  );
}

function statusClass(s) {
  if (!s) return "est-status-draft";
  const sl = s.toLowerCase();
  if (sl === "sent") return "est-status-sent";
  if (sl === "accepted") return "est-status-accepted";
  if (sl === "declined") return "est-status-declined";
  return "est-status-draft";
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

export default function Estimates() {
  const navigate = useNavigate();
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const debounceRef = useRef(null);

  // Ready to Quote state
  const [rtqOrders, setRtqOrders] = useState([]);
  const [rtqOpen, setRtqOpen] = useState(true);

  const fetchReadyToQuote = useCallback(async () => {
    try {
      const res = await api.get("/work-orders/by-status/Needs to be Quoted");
      setRtqOrders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching ready-to-quote WOs:", err);
    }
  }, []);

  useEffect(() => {
    fetchReadyToQuote();
  }, [fetchReadyToQuote]);

  const fetchEstimates = useCallback(async (q, status) => {
    setLoading(true);
    try {
      const params = {};
      if (q && q.trim()) params.search = q.trim();
      if (status && status !== "All") params.status = status;
      const res = await api.get("/estimates", { params });
      setEstimates(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching estimates:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEstimates("", statusFilter);
  }, [fetchEstimates, statusFilter]);

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchEstimates(val, statusFilter), 300);
  };

  const handleStatusChange = (e) => {
    const val = e.target.value;
    setStatusFilter(val);
    fetchEstimates(search, val);
  };

  return (
    <div className="est-page">
      <div className="est-container">
        <div className="est-header">
          <div>
            <h2 className="est-title">Estimates</h2>
            <div className="est-subtitle">
              Create and manage customer estimates and quotes.
            </div>
          </div>
          <div className="est-actions">
            <Link to="/estimates/new" className="btn-primary-apple">
              + Create Estimate
            </Link>
          </div>
        </div>

        {/* ─── Ready to Quote Section ─── */}
        {rtqOrders.length > 0 && (
          <div className="est-rtq-section">
            <div className="est-rtq-header" onClick={() => setRtqOpen(!rtqOpen)}>
              <div className="est-rtq-header-left">
                <h3>Ready to Quote</h3>
                <span className="est-rtq-count">{rtqOrders.length}</span>
              </div>
              <ChevronDown className={`est-rtq-chevron${rtqOpen ? " open" : ""}`} />
            </div>
            {rtqOpen && (
              <div className="est-rtq-body">
                <div className="est-rtq-grid">
                  {rtqOrders.map((wo) => (
                    <div key={wo.id} className="est-rtq-card">
                      <div className="est-rtq-card-top">
                        <div className="est-rtq-card-info">
                          <p className="est-rtq-customer">{wo.customer || "—"}</p>
                          <p className="est-rtq-detail">
                            {wo.siteLocation || wo.siteAddress || "No site location"}
                          </p>
                          {wo.allPoNumbersFormatted && (
                            <p className="est-rtq-detail">PO: {wo.allPoNumbersFormatted}</p>
                          )}
                        </div>
                        <Link
                          to={`/view-work-order/${wo.id}`}
                          className="est-rtq-wo-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          WO #{wo.workOrderNumber || wo.id}
                        </Link>
                      </div>
                      <div className="est-rtq-card-actions">
                        <Link
                          to={`/estimates/new?workOrderId=${wo.id}`}
                          className="est-rtq-create-btn"
                        >
                          + Create Estimate
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="cust-section-card">
          <div className="cust-section-body">
            <div className="est-toolbar">
              <input
                type="text"
                className="est-search-input"
                placeholder="Search by customer, project, P.O. number..."
                value={search}
                onChange={handleSearchChange}
              />
              <select
                className="est-filter-select"
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
            <table className="est-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Project</th>
                  <th>P.O. No.</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {estimates.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6}>
                      <div className="est-empty">
                        {search || statusFilter !== "All"
                          ? "No estimates match your filters."
                          : "No estimates yet. Create your first estimate to get started."}
                      </div>
                    </td>
                  </tr>
                )}
                {estimates.map((e) => (
                  <tr key={e.id} onClick={() => navigate(`/estimates/${e.id}`)}>
                    <td data-label="Date">{fmtDate(e.issueDate || e.createdAt)}</td>
                    <td data-label="Customer">
                      <span className="est-customer-name">
                        {e.companyName || e.custName || "—"}
                      </span>
                    </td>
                    <td data-label="Project">{e.projectName || "—"}</td>
                    <td data-label="P.O. No.">{e.poNumber || "—"}</td>
                    <td data-label="Status">
                      <span className={`est-status-pill ${statusClass(e.status)}`}>
                        {e.status || "Draft"}
                      </span>
                    </td>
                    <td data-label="Total" style={{ textAlign: "right" }}>
                      <span className="est-total">{fmtMoney(e.total)}</span>
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
