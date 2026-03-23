// File: src/Customers.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "./api";
import "./Customers.css";

export default function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const debounceRef = useRef(null);

  // Duplicates
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [duplicates, setDuplicates] = useState([]);
  const [dupeLoading, setDupeLoading] = useState(false);
  const [mergingPair, setMergingPair] = useState(null);

  const fetchCustomers = useCallback(async (q) => {
    setLoading(true);
    try {
      const params = {};
      if (q && q.trim()) params.search = q.trim();
      const res = await api.get("/customers", { params });
      setCustomers(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching customers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCustomers("");
  }, [fetchCustomers]);

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchCustomers(val), 300);
  };

  const formatAddress = (c) => {
    const parts = [c.billingAddress, c.billingCity, c.billingState, c.billingZip].filter(Boolean);
    if (parts.length) return parts.join(", ");
    return "\u2014";
  };

  const findDuplicates = async () => {
    setShowDuplicates(true);
    setDupeLoading(true);
    try {
      const res = await api.get("/customers/duplicates");
      setDuplicates(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error finding duplicates:", err);
    } finally {
      setDupeLoading(false);
    }
  };

  const handleMerge = async (targetId, sourceId, targetName, sourceName) => {
    if (!window.confirm(
      `Merge "${sourceName}" into "${targetName}"?\n\nAll work orders, estimates, and invoices from "${sourceName}" will be moved to "${targetName}".\n\n"${sourceName}" will be permanently deleted.\n\nThis cannot be undone.`
    )) return;

    setMergingPair(`${targetId}-${sourceId}`);
    try {
      const res = await api.post(`/customers/${targetId}/merge`, { sourceId });
      const u = res.data.updated || {};
      alert(`Merged! Updated ${u.workOrders || 0} work orders, ${u.estimates || 0} estimates, ${u.invoices || 0} invoices.`);
      // Refresh both lists
      setDuplicates((prev) => prev.filter((p) => !(
        (p.a.id === targetId && p.b.id === sourceId) ||
        (p.a.id === sourceId && p.b.id === targetId)
      )));
      fetchCustomers(search);
    } catch (err) {
      console.error("Merge error:", err);
      alert("Failed to merge. " + (err.response?.data?.error || ""));
    } finally {
      setMergingPair(null);
    }
  };

  return (
    <div className="customers-page">
      <div className="customers-container">
        <div className="customers-header">
          <div>
            <h2 className="customers-title">Customers</h2>
            <div className="customers-subtitle">
              Manage customer records for work orders, estimates, and invoices.
            </div>
          </div>
          <div className="customers-actions">
            <button
              className="btn-secondary-apple"
              onClick={showDuplicates ? () => setShowDuplicates(false) : findDuplicates}
            >
              {showDuplicates ? "Hide Duplicates" : "Find Duplicates"}
            </button>
            <Link to="/customers/new" className="btn-primary-apple">
              + Add Customer
            </Link>
          </div>
        </div>

        {/* Duplicate Finder Panel */}
        {showDuplicates && (
          <div className="cust-section-card" style={{ marginBottom: 20, borderColor: "var(--accent-orange)", borderWidth: 2 }}>
            <div className="cust-section-header" style={{ background: "rgba(255,149,0,0.08)", color: "var(--accent-orange)" }}>
              Potential Duplicate Customers
              {!dupeLoading && <span style={{ fontWeight: 400, fontSize: 13 }}>({duplicates.length} pairs found)</span>}
            </div>
            <div className="cust-section-body" style={{ padding: 0 }}>
              {dupeLoading ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: 14 }}>
                  Scanning for duplicates...
                </div>
              ) : duplicates.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: 14 }}>
                  No duplicate customers found.
                </div>
              ) : (
                <table className="customers-table">
                  <thead>
                    <tr>
                      <th>Customer A</th>
                      <th>Customer B</th>
                      <th style={{ textAlign: "center" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicates.map((pair, idx) => {
                      const nameA = pair.a.companyName || pair.a.name || "\u2014";
                      const nameB = pair.b.companyName || pair.b.name || "\u2014";
                      const pairKey = `${pair.a.id}-${pair.b.id}`;
                      const isMerging = mergingPair === pairKey || mergingPair === `${pair.b.id}-${pair.a.id}`;
                      return (
                        <tr key={idx}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{nameA}</div>
                            {pair.a.contactName && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{pair.a.contactName}</div>}
                            {pair.a.phone && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{pair.a.phone}</div>}
                          </td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{nameB}</div>
                            {pair.b.contactName && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{pair.b.contactName}</div>}
                            {pair.b.phone && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{pair.b.phone}</div>}
                          </td>
                          <td style={{ textAlign: "center" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                              <button
                                className="btn-merge-sm"
                                disabled={isMerging}
                                onClick={() => handleMerge(pair.a.id, pair.b.id, nameA, nameB)}
                                title={`Keep "${nameA}", merge "${nameB}" into it`}
                              >
                                {isMerging ? "..." : `Keep "${nameA.length > 20 ? nameA.substring(0, 20) + "..." : nameA}"`}
                              </button>
                              <button
                                className="btn-merge-sm"
                                disabled={isMerging}
                                onClick={() => handleMerge(pair.b.id, pair.a.id, nameB, nameA)}
                                title={`Keep "${nameB}", merge "${nameA}" into it`}
                              >
                                {isMerging ? "..." : `Keep "${nameB.length > 20 ? nameB.substring(0, 20) + "..." : nameB}"`}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        <div className="cust-section-card">
          <div className="cust-section-body">
            <div className="customers-search-wrap">
              <input
                type="text"
                className="customers-search-input"
                placeholder="Search by name, contact, phone, email..."
                value={search}
                onChange={handleSearchChange}
              />
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="customers-table">
              <thead>
                <tr>
                  <th>Company Name</th>
                  <th>Contact</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Billing Address</th>
                  <th style={{ textAlign: "center" }}>Work Orders</th>
                </tr>
              </thead>
              <tbody>
                {customers.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6}>
                      <div className="customers-empty">
                        {search ? "No customers match your search." : "No customers yet. Add your first customer to get started."}
                      </div>
                    </td>
                  </tr>
                )}
                {customers.map((c) => (
                  <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                    <td data-label="Company">
                      <span className="company-name">{c.companyName || c.name || "\u2014"}</span>
                    </td>
                    <td data-label="Contact">{c.contactName || "\u2014"}</td>
                    <td data-label="Phone">{c.phone || "\u2014"}</td>
                    <td data-label="Email">{c.email || "\u2014"}</td>
                    <td data-label="Address">{formatAddress(c)}</td>
                    <td data-label="WOs" style={{ textAlign: "center" }}>
                      <span className="wo-count-badge">{c.woCount || 0}</span>
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
