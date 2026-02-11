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
    return "—";
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
            <Link to="/customers/new" className="btn-primary-apple">
              + Add Customer
            </Link>
          </div>
        </div>

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
                      <span className="company-name">{c.companyName || c.name || "—"}</span>
                    </td>
                    <td data-label="Contact">{c.contactName || "—"}</td>
                    <td data-label="Phone">{c.phone || "—"}</td>
                    <td data-label="Email">{c.email || "—"}</td>
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
