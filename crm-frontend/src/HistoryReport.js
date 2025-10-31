// File: src/HistoryReport.js
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./HistoryReport.css"; // keep existing styles

// ----------------- helpers -----------------
const norm = (v) => (v ?? "").toString().trim();
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

// ---- Search history (today-only) ----------
const MAX_HISTORY = 8;
const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `historyReport.searches.${y}-${m}-${day}`;
};

function summarizeFilters(f) {
  const bits = [];
  if (norm(f.customer)) bits.push(`Customer: ${norm(f.customer)}`);
  if (norm(f.workOrderNumber)) bits.push(`WO: ${norm(f.workOrderNumber)}`);
  if (norm(f.poNumber)) bits.push(`PO: ${norm(f.poNumber)}`);
  if (norm(f.siteLocation)) bits.push(`Site: ${norm(f.siteLocation)}`);
  return bits.join(" · ") || "—";
}
function canonicalKey(f) {
  return JSON.stringify({
    c: norm(f.customer).toLowerCase(),
    wo: norm(f.workOrderNumber).toLowerCase(),
    po: norm(f.poNumber).toLowerCase(),
    s: norm(f.siteLocation).toLowerCase(),
  });
}
function loadHistory() {
  try {
    const raw = localStorage.getItem(todayKey());
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveHistory(items) {
  try {
    localStorage.setItem(todayKey(), JSON.stringify(items.slice(0, MAX_HISTORY)));
  } catch {}
}
function addToHistory(f) {
  if (!norm(f.customer) && !norm(f.workOrderNumber) && !norm(f.poNumber) && !norm(f.siteLocation)) {
    return loadHistory();
  }
  const now = Date.now();
  const key = canonicalKey(f);
  const curr = loadHistory();
  const filtered = curr.filter((it) => it.key !== key);
  const next = [{ key, when: now, filters: f }, ...filtered].slice(0, MAX_HISTORY);
  saveHistory(next);
  return next;
}

// ----------------- component -----------------
export default function HistoryReport() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({
    customer: "",
    poNumber: "",
    workOrderNumber: "",
    siteLocation: "",
  });
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  // history state
  const [history, setHistory] = useState([]);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const handleChange = (e) => {
    setFilters((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.get("/work-orders/search", {
        params: {
          customer: filters.customer || "",
          poNumber: filters.poNumber || "",
          siteLocation: filters.siteLocation || "",
          workOrderNumber: filters.workOrderNumber || "",
        },
      });
      setResults(Array.isArray(data) ? data : []);
      setHistory(addToHistory(filters));
    } catch (err) {
      console.error("Search failed:", err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const runFromHistory = async (h) => {
    setFilters(h.filters);
    setLoading(true);
    try {
      const { data } = await api.get("/work-orders/search", {
        params: {
          customer: h.filters.customer || "",
          poNumber: h.filters.poNumber || "",
          siteLocation: h.filters.siteLocation || "",
          workOrderNumber: h.filters.workOrderNumber || "",
        },
      });
      setResults(Array.isArray(data) ? data : []);
      const bumped = addToHistory(h.filters);
      setHistory(bumped);
    } catch (err) {
      console.error("Search failed:", err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const removeHistoryItem = (key) => {
    const next = history.filter((h) => h.key !== key);
    setHistory(next);
    saveHistory(next);
  };

  const clearHistory = () => {
    setHistory([]);
    saveHistory([]);
  };

  const hasAnyHistory = history.length > 0;

  const prettyResultsCount = useMemo(() => {
    const n = results.length || 0;
    return `${n} match${n === 1 ? "" : "es"}`;
  }, [results.length]);

  // chip styles (minimal inline)
  const chipStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    maxWidth: 420,
    padding: "6px 12px",
    borderRadius: 999,
    background: "#f1f5f9",
    border: "1px solid #e2e8f0",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: 13,
    lineHeight: 1.25,
  };

  return (
    <div className="history-report">
      <h2 className="history-title">Work Order History</h2>

      {/* Search bar card */}
      <form
        onSubmit={handleSearch}
        className="filter-form"
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 16,
          boxShadow: "0 6px 18px rgba(0,0,0,0.06)",
          border: "1px solid #eef2f7",
        }}
      >
        {/* Full-width, evenly spaced inputs with aligned Search button */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(180px, 1fr)) 140px",
            gap: 12,
            alignItems: "center",
          }}
        >
          <input
            name="customer"
            className="form-control"
            placeholder="Customer"
            value={filters.customer}
            onChange={handleChange}
          />
          <input
            name="workOrderNumber"
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

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: "100%" }}
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {/* Recent search history (today) */}
      {hasAnyHistory && (
        <div
          className="recent-searches mt-3"
          style={{
            background: "#fff",
            borderRadius: 12,
            padding: 12,
            border: "1px solid #eef2f7",
          }}
        >
          <div className="d-flex align-items-center justify-content-between mb-2">
            <div className="text-muted" style={{ fontSize: 13, fontWeight: 600 }}>
              Recent Searches (today)
            </div>
            <button
              className="btn btn-link p-0"
              onClick={clearHistory}
              title="Clear all"
              style={{ fontSize: 13, textDecoration: "none" }}
            >
              Clear all
            </button>
          </div>

          <div className="d-flex flex-wrap" style={{ gap: 8 }}>
            {history.map((h) => {
              const label = summarizeFilters(h.filters);
              return (
                <div key={h.key} className="recent-chip" title={label} style={chipStyle}>
                  <button
                    className="btn btn-sm btn-link p-0 text-reset"
                    style={{ textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis" }}
                    onClick={() => runFromHistory(h)}
                  >
                    {label}
                  </button>
                  <button
                    className="btn-close"
                    aria-label="Remove"
                    title="Remove"
                    onClick={() => removeHistoryItem(h.key)}
                    style={{ filter: "grayscale(1)" }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 ? (
        <>
          <div className="results-meta mt-3 text-muted" style={{ fontSize: 13 }}>
            {prettyResultsCount}
          </div>
          <div
            className="results-table"
            style={{
              background: "#fff",
              borderRadius: 12,
              border: "1px solid #eef2f7",
              boxShadow: "0 6px 18px rgba(0,0,0,0.06)",
            }}
          >
            <table className="table mb-0">
              <thead className="table-light">
                <tr>
                  <th>WO #</th>
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
        </>
      ) : (
        <p className="empty-text text-muted mt-4" style={{ fontStyle: "italic" }}>
          {loading ? "Searching…" : "No matching work orders."}
        </p>
      )}
    </div>
  );
}
