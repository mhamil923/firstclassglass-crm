// File: src/HistoryReport.js
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./HistoryReport.css"; // styles

// helpers (match WorkOrders.js behavior)
const norm = (v) => (v ?? "").toString().trim();
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

export default function HistoryReport() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({
    customer: "",
    poNumber: "",
    workOrderNumber: "", // ← NEW
    siteLocation: ""
  });
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFilters({ ...filters, [e.target.name]: e.target.value });
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.get("/work-orders/search", {
        params: {
          customer: filters.customer || "",
          poNumber: filters.poNumber || "",
          siteLocation: filters.siteLocation || "",
          workOrderNumber: filters.workOrderNumber || "" // ← NEW
        }
      });
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Search failed:", err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="history-report">
      <h2 className="history-title">Work Order History</h2>

      <form onSubmit={handleSearch} className="filter-form">
        <input
          name="customer"
          className="form-control"
          placeholder="Customer"
          value={filters.customer}
          onChange={handleChange}
        />
        <input
          name="workOrderNumber"          // ← NEW
          className="form-control"
          placeholder="Work Order Number"
          value={filters.workOrderNumber}
          onChange={handleChange}
        />
        <input
          name="poNumber"
          className="form-control"
          placeholder="PO Number"
          value={filters.poNumber}
          onChange={handleChange}
        />
        <input
          name="siteLocation"
          className="form-control"
          placeholder="Site Location"
          value={filters.siteLocation}
          onChange={handleChange}
        />
        <button type="submit" className="search-btn" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {results.length > 0 ? (
        <div className="results-table">
          <table>
            <thead>
              <tr>
                <th>WO #</th>      {/* ← NEW column */}
                <th>PO #</th>
                <th>Customer</th>
                <th>Site</th>
                <th>Status</th>
                <th>Assigned To</th>
                <th>Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {results.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/view-work-order/${o.id}`)}
                  title="Click to view"
                  style={{ cursor: "pointer" }}
                >
                  <td>{o.workOrderNumber || "—"}</td>
                  <td>{displayPO(o.workOrderNumber, o.poNumber) || "—"}</td>
                  <td>{o.customer || "—"}</td>
                  <td>{o.siteLocation || "—"}</td>
                  <td>{o.status || "—"}</td>
                  <td>{o.assignedToName || "—"}</td>
                  <td>{o.scheduledDate ? o.scheduledDate.substring(0, 16) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-text">
          {loading ? "Searching…" : "No matching work orders."}
        </p>
      )}
    </div>
  );
}
