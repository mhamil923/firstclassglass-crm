// File: src/HistoryReport.js
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./HistoryReport.css"; // styles

// helpers (match WorkOrders.js behavior)
const norm = (v) => (v ?? "").toString().trim();
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

// ---- Search history (today-only) -------------------------------------------
const MAX_HISTORY = 8;
const todayKey = () => {
  // store per local day (yyyy-mm-dd)
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
  // used to de-dupe identical searches
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
  } catch {
    // ignore storage errors
  }
}

function addToHistory(f) {
  // Don't save completely empty searches
  if (
    !norm(f.customer) &&
    !norm(f.workOrderNumber) &&
    !norm(f.poNumber) &&
    !norm(f.siteLocation)
  ) {
    return loadHistory();
  }
  const now = Date.now();
  const key = canonicalKey(f);
  const curr = loadHistory();
  // remove any existing identical entry
  const filtered = curr.filter((it) => it.key !== key);
  const next = [{ key, when: now, filters: f }, ...filtered].slice(0, MAX_HISTORY);
  saveHistory(next);
  return next;
}

// ---------------------------------------------------------------------------

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
      // add to history (today-only)
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
    // trigger a search using those filters
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
      // bump this item to the front
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
        <button type="submit" className="search-btn" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {/* Recent search history (today) */}
      {hasAnyHistory && (
        <div className="recent-searches">
          <div className="recent-header">
            <span className="recent-title">Recent Searches (today)</span>
            <button
              className="recent-clear-btn"
              onClick={clearHistory}
              title="Clear all"
            >
              Clear all
            </button>
          </div>

          <div className="recent-strip">
            {history.map((h) => (
              <div key={h.key} className="recent-chip" title={summarizeFilters(h.filters)}>
                <button
                  className="recent-chip-main"
                  onClick={() => runFromHistory(h)}
                >
                  {summarizeFilters(h.filters)}
                </button>
                <button
                  className="recent-chip-x"
                  aria-label="Remove"
                  title="Remove"
                  onClick={() => removeHistoryItem(h.key)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {results.length > 0 ? (
        <>
          <div className="results-meta">{prettyResultsCount}</div>
          <div className="results-table">
            <table>
              <thead>
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
        <p className="empty-text">
          {loading ? "Searching…" : "No matching work orders."}
        </p>
      )}
    </div>
  );
}
