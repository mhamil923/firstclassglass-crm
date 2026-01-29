// File: src/HistoryReport.js
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api from "./api";
import "./HistoryReport.css"; // keep existing styles

// ----------------- helpers -----------------
const norm = (v) => (v ?? "").toString().trim();
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

const toLower = (v) => (v ?? "").toString().toLowerCase();

// Prefer siteAddress fields if present; fallback to common alternates
const getSiteAddress = (o) =>
  norm(
    o?.siteAddress ||
      o?.serviceAddress ||
      o?.address ||
      o?.meta?.siteAddress ||
      o?.meta?.serviceAddress ||
      o?.meta?.address
  );

// ---- Search history (today-only) ----------
const MAX_HISTORY = 8;
const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `historyReport.searches.${y}-${m}-${day}`;
};

function summarizeQuery(q) {
  const v = norm(q);
  return v || "—";
}
function canonicalKeyFromQuery(q) {
  return norm(q).toLowerCase();
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
function addToHistory(query) {
  if (!norm(query)) return loadHistory();
  const now = Date.now();
  const key = canonicalKeyFromQuery(query);
  const curr = loadHistory();
  const filtered = curr.filter((it) => it.key !== key);
  const next = [{ key, when: now, query }, ...filtered].slice(0, MAX_HISTORY);
  saveHistory(next);
  return next;
}

// ----------------- component -----------------
export default function HistoryReport() {
  const navigate = useNavigate();
  const location = useLocation();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  // history state
  const [history, setHistory] = useState([]);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  // Core search: pull all work orders and filter on the client
  const performSearch = async (searchText) => {
    const q = norm(searchText).toLowerCase();
    setLoading(true);
    try {
      const { data } = await api.get("/work-orders");
      const all = Array.isArray(data) ? data : [];

      const filtered = q
        ? all.filter((o) => {
            const customer = toLower(o.customer);
            const wo = toLower(o.workOrderNumber);
            const po = toLower(o.poNumber);
            const site = toLower(o.siteLocation);
            const siteAddr = toLower(getSiteAddress(o));
            const status = toLower(o.status);
            const assigned = toLower(o.assignedToName);

            return (
              customer.includes(q) ||
              wo.includes(q) ||
              po.includes(q) ||
              site.includes(q) ||
              siteAddr.includes(q) ||
              status.includes(q) ||
              assigned.includes(q)
            );
          })
        : all;

      setResults(filtered);
      setHistory(addToHistory(searchText));
    } catch (err) {
      console.error("Search failed:", err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    await performSearch(query);
  };

  const runFromHistory = async (h) => {
    setQuery(h.query);
    await performSearch(h.query);
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

  // ✅ Center everything in the table (headers + cells)
  const thCenter = { textAlign: "center", verticalAlign: "middle" };
  const tdCenter = { textAlign: "center", verticalAlign: "middle" };

  // ✅ Site cell stack (Site then Site Address)
  const siteCellWrap = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center", // center within the cell
    justifyContent: "center",
    gap: 2,
    minWidth: 0,
  };

  const sitePrimary = {
    fontWeight: 600,
    lineHeight: 1.2,
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 520,
  };

  const siteSecondary = {
    fontSize: 12,
    color: "rgba(0,0,0,0.65)",
    lineHeight: 1.2,
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 520,
  };

  // ✅ When opening a WO, send "from" so ViewWorkOrder Back button can return here
  const openWorkOrder = (id) => {
    const from = location.pathname + (location.search || "");
    navigate(`/view-work-order/${id}`, {
      state: {
        from,
        fromLabel: "History",
      },
    });
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(260px, 1fr) 140px",
            gap: 12,
            alignItems: "center",
          }}
        >
          <input
            className="form-control"
            placeholder="Search by Customer, WO #, PO #, Site Location, or Site Address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: "100%" }}>
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
              type="button"
            >
              Clear all
            </button>
          </div>

          <div className="d-flex flex-wrap" style={{ gap: 8 }}>
            {history.map((h) => {
              const label = summarizeQuery(h.query);
              return (
                <div key={h.key} className="recent-chip" title={label} style={chipStyle}>
                  <button
                    className="btn btn-sm btn-link p-0 text-reset"
                    style={{
                      textDecoration: "none",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    onClick={() => runFromHistory(h)}
                    type="button"
                  >
                    {label}
                  </button>
                  <button
                    className="btn-close"
                    aria-label="Remove"
                    title="Remove"
                    onClick={() => removeHistoryItem(h.key)}
                    style={{ filter: "grayscale(1)" }}
                    type="button"
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
                  <th style={thCenter}>WO #</th>
                  <th style={thCenter}>PO #</th>
                  <th style={thCenter}>Customer</th>
                  <th style={thCenter}>Site</th>
                  <th style={thCenter}>Status</th>
                  <th style={thCenter}>Assigned To</th>
                  <th style={thCenter}>Scheduled</th>
                </tr>
              </thead>

              <tbody>
                {results.map((o) => {
                  const siteLoc = norm(o.siteLocation) || "—";
                  const siteAddr = getSiteAddress(o);

                  return (
                    <tr
                      key={o.id}
                      onClick={() => openWorkOrder(o.id)}
                      title="Click to view"
                      style={{ cursor: "pointer" }}
                    >
                      <td style={tdCenter}>{o.workOrderNumber || "—"}</td>
                      <td style={tdCenter}>{displayPO(o.workOrderNumber, o.poNumber) || "—"}</td>
                      <td style={tdCenter}>{o.customer || "—"}</td>

                      {/* ✅ Site + Site Address stacked */}
                      <td style={tdCenter}>
                        <div style={siteCellWrap}>
                          <div style={sitePrimary} title={siteLoc}>
                            {siteLoc}
                          </div>
                          {siteAddr ? (
                            <div style={siteSecondary} title={siteAddr}>
                              {siteAddr}
                            </div>
                          ) : null}
                        </div>
                      </td>

                      <td style={tdCenter}>{o.status || "—"}</td>
                      <td style={tdCenter}>{o.assignedToName || "—"}</td>
                      <td style={tdCenter}>
                        {o.scheduledDate ? o.scheduledDate.substring(0, 16) : "—"}
                      </td>
                    </tr>
                  );
                })}
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
