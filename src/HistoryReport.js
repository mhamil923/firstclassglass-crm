// File: src/HistoryReport.js

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./HistoryReport.css";     // ← import the new styles

export default function HistoryReport() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    customer: "",
    poNumber: "",
    siteLocation: ""
  });
  const [results, setResults] = useState([]);

  const handleChange = e => {
    setFilters({ ...filters, [e.target.name]: e.target.value });
  };

  const handleSearch = async e => {
    e.preventDefault();
    try {
      const { data } = await api.get("/work-orders/search", {
        params: filters
      });
      setResults(data);
    } catch (err) {
      console.error("Search failed:", err);
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
        <button type="submit" className="search-btn">
          Search
        </button>
      </form>

      {results.length > 0 ? (
        <div className="results-table">
          <table>
            <thead>
              <tr>
                <th>PO #</th>
                <th>Customer</th>
                <th>Site</th>
                <th>Status</th>
                <th>Assigned To</th>
                <th>Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {results.map(o => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/view-work-order/${o.id}`)}
                >
                  <td>{o.poNumber}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.status}</td>
                  <td>{o.assignedToName || "—"}</td>
                  <td>{o.scheduledDate?.substring(0, 16) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-text">No matching work orders.</p>
      )}
    </div>
  );
}
