// File: src/Reports.js
import React, { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "./contexts/ThemeContext";
import api from "./api";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import "./Reports.css";

/* ========================= Helpers ========================= */
const fmtMoney = (v) => {
  const n = Number(v) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const fmtMoneyShort = (v) => {
  const n = Number(v) || 0;
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
};

const fmtDate = (d) => {
  if (!d) return "\u2014";
  try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return d; }
};

const fmtPct = (v) => (Number(v) || 0).toFixed(1) + "%";

function exportCsv(filename, headers, rows) {
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ========================= Date presets ========================= */
function getPresetRange(preset) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const fmt = (d) => d.toISOString().split("T")[0];
  switch (preset) {
    case "thisMonth": return { from: fmt(new Date(y, m, 1)), to: fmt(now) };
    case "lastMonth": return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) };
    case "thisQuarter": {
      const qm = Math.floor(m / 3) * 3;
      return { from: fmt(new Date(y, qm, 1)), to: fmt(now) };
    }
    case "lastQuarter": {
      const qm = Math.floor(m / 3) * 3;
      return { from: fmt(new Date(y, qm - 3, 1)), to: fmt(new Date(y, qm, 0)) };
    }
    case "thisYear": return { from: fmt(new Date(y, 0, 1)), to: fmt(now) };
    case "lastYear": return { from: fmt(new Date(y - 1, 0, 1)), to: fmt(new Date(y - 1, 11, 31)) };
    case "allTime": return { from: "", to: "" };
    default: return { from: "", to: "" };
  }
}

const PRESETS = [
  { key: "thisMonth", label: "This Month" },
  { key: "lastMonth", label: "Last Month" },
  { key: "thisQuarter", label: "This Quarter" },
  { key: "lastQuarter", label: "Last Quarter" },
  { key: "thisYear", label: "This Year" },
  { key: "lastYear", label: "Last Year" },
  { key: "allTime", label: "All Time" },
];

const TABS = [
  { key: "revenue", label: "Revenue" },
  { key: "aging", label: "Aging" },
  { key: "customers", label: "Customers" },
  { key: "estimates", label: "Estimates" },
  { key: "workorders", label: "Work Orders" },
  { key: "pl", label: "P&L" },
];

/* ========================= Status pill helper ========================= */
const STATUS_COLORS = {
  draft: { bg: "rgba(142,142,147,0.12)", color: "#8e8e93" },
  sent: { bg: "rgba(0,113,227,0.1)", color: "#0071e3" },
  partial: { bg: "rgba(255,159,10,0.12)", color: "#ff9f0a" },
  paid: { bg: "rgba(52,199,89,0.12)", color: "#34c759" },
  overdue: { bg: "rgba(255,59,48,0.12)", color: "#ff3b30" },
  void: { bg: "rgba(142,142,147,0.12)", color: "#636366" },
  accepted: { bg: "rgba(52,199,89,0.12)", color: "#34c759" },
  declined: { bg: "rgba(255,59,48,0.12)", color: "#ff3b30" },
};

function statusPillStyle(s) {
  const sc = STATUS_COLORS[(s || "").toLowerCase()] || STATUS_COLORS.draft;
  return { background: sc.bg, color: sc.color };
}

/* ========================= AGING BUCKET COLORS ========================= */
const BUCKET_COLORS = ["#34c759", "#0071e3", "#ff9f0a", "#ff6723", "#ff3b30"];

/* ========================= Main component ========================= */
export default function Reports() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [activeTab, setActiveTab] = useState("revenue");
  const [activePreset, setActivePreset] = useState("thisYear");
  const [dateFrom, setDateFrom] = useState(() => getPresetRange("thisYear").from);
  const [dateTo, setDateTo] = useState(() => getPresetRange("thisYear").to);

  // Per-tab data
  const [revenue, setRevenue] = useState(null);
  const [revLoading, setRevLoading] = useState(false);
  const [aging, setAging] = useState(null);
  const [agingLoading, setAgingLoading] = useState(false);
  const [customers, setCustomers] = useState(null);
  const [custLoading, setCustLoading] = useState(false);
  const [custSort, setCustSort] = useState({ col: "totalInvoiced", dir: "desc" });
  const [estimates, setEstimates] = useState(null);
  const [estLoading, setEstLoading] = useState(false);
  const [workOrders, setWorkOrders] = useState(null);
  const [woLoading, setWoLoading] = useState(false);
  const [pl, setPl] = useState(null);
  const [plLoading, setPlLoading] = useState(false);
  const [expandedBucket, setExpandedBucket] = useState(null);

  const handlePreset = (key) => {
    setActivePreset(key);
    const r = getPresetRange(key);
    setDateFrom(r.from);
    setDateTo(r.to);
  };

  const params = useMemo(() => {
    const p = {};
    if (dateFrom) p.from = dateFrom;
    if (dateTo) p.to = dateTo;
    return p;
  }, [dateFrom, dateTo]);

  /* ---- Fetchers ---- */
  const fetchRevenue = useCallback(async () => {
    setRevLoading(true);
    try { const res = await api.get("/reports/revenue", { params }); setRevenue(res.data); }
    catch (err) { console.error(err); }
    finally { setRevLoading(false); }
  }, [params]);

  const fetchAging = useCallback(async () => {
    setAgingLoading(true);
    try { const res = await api.get("/reports/aging"); setAging(res.data); }
    catch (err) { console.error(err); }
    finally { setAgingLoading(false); }
  }, []);

  const fetchCustomers = useCallback(async () => {
    setCustLoading(true);
    try { const res = await api.get("/reports/customers", { params }); setCustomers(res.data); }
    catch (err) { console.error(err); }
    finally { setCustLoading(false); }
  }, [params]);

  const fetchEstimates = useCallback(async () => {
    setEstLoading(true);
    try { const res = await api.get("/reports/estimates", { params }); setEstimates(res.data); }
    catch (err) { console.error(err); }
    finally { setEstLoading(false); }
  }, [params]);

  const fetchWorkOrders = useCallback(async () => {
    setWoLoading(true);
    try { const res = await api.get("/reports/work-orders", { params }); setWorkOrders(res.data); }
    catch (err) { console.error(err); }
    finally { setWoLoading(false); }
  }, [params]);

  const fetchPL = useCallback(async () => {
    setPlLoading(true);
    try { const res = await api.get("/reports/profit-loss", { params }); setPl(res.data); }
    catch (err) { console.error(err); }
    finally { setPlLoading(false); }
  }, [params]);

  // Fetch data when tab changes or date changes
  useEffect(() => {
    if (activeTab === "revenue") fetchRevenue();
    else if (activeTab === "aging") fetchAging();
    else if (activeTab === "customers") fetchCustomers();
    else if (activeTab === "estimates") fetchEstimates();
    else if (activeTab === "workorders") fetchWorkOrders();
    else if (activeTab === "pl") fetchPL();
  }, [activeTab, fetchRevenue, fetchAging, fetchCustomers, fetchEstimates, fetchWorkOrders, fetchPL]);

  /* ---- Chart theme ---- */
  const barColor = isDark ? "#0a84ff" : "#0071e3";
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const textColor = isDark ? "#f5f5f7" : "#1d1d1f";
  const secondaryColor = isDark ? "#aeaeb2" : "#6e6e73";
  const chartTooltipStyle = {
    backgroundColor: isDark ? "#1c1c1e" : "#ffffff",
    border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}`,
    borderRadius: 12, color: textColor, fontSize: 13,
  };

  /* ---- Customer sort ---- */
  const sortedCustomers = useMemo(() => {
    if (!customers?.customers) return [];
    const arr = [...customers.customers];
    arr.sort((a, b) => {
      let av = a[custSort.col], bv = b[custSort.col];
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av < bv) return custSort.dir === "asc" ? -1 : 1;
      if (av > bv) return custSort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [customers, custSort]);

  const toggleCustSort = (col) => {
    setCustSort(prev => prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  };

  const sortArrow = (col) => {
    if (custSort.col !== col) return "";
    return custSort.dir === "asc" ? " \u25B2" : " \u25BC";
  };

  /* ---- Pie data for customer top 5 ---- */
  const PIE_CUST_COLORS = ["#0071e3", "#34c759", "#ff9f0a", "#ff3b30", "#636366", "#8e8e93"];
  const custPie = useMemo(() => {
    if (!sortedCustomers.length) return [];
    const top5 = sortedCustomers.slice(0, 5);
    const rest = sortedCustomers.slice(5);
    const data = top5.map(c => ({ name: c.customerName, value: c.totalInvoiced }));
    const otherTotal = rest.reduce((s, c) => s + c.totalInvoiced, 0);
    if (otherTotal > 0) data.push({ name: "Other", value: otherTotal });
    return data;
  }, [sortedCustomers]);

  /* ---- Aging bar data ---- */
  const agingBarData = useMemo(() => {
    if (!aging?.buckets) return [];
    const total = aging.totalOutstanding || 1;
    return aging.buckets.map((b, i) => ({
      label: b.label, total: b.total, count: b.count,
      pct: Math.round((b.total / total) * 100),
      fill: BUCKET_COLORS[i],
    }));
  }, [aging]);

  /* ========== Loading indicator ========== */
  const Loader = () => <div className="rpt-loading">Loading...</div>;

  return (
    <div className="rpt-page">
      <div className="rpt-container">
        {/* Top bar */}
        <div className="rpt-topbar">
          <div>
            <h2 className="rpt-title">Reports</h2>
            <div className="rpt-subtitle">Financial analytics and business performance.</div>
          </div>
          <button className="rpt-btn rpt-btn-secondary" onClick={() => navigate("/")}>
            Dashboard
          </button>
        </div>

        {/* Date Range Controls */}
        <div className="rpt-date-bar">
          <div className="rpt-presets">
            {PRESETS.map(p => (
              <button
                key={p.key}
                className={`rpt-preset-pill${activePreset === p.key ? " active" : ""}`}
                onClick={() => handlePreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="rpt-date-inputs">
            <input type="date" className="rpt-date-input" value={dateFrom}
              onChange={e => { setDateFrom(e.target.value); setActivePreset(""); }} />
            <span className="rpt-date-sep">to</span>
            <input type="date" className="rpt-date-input" value={dateTo}
              onChange={e => { setDateTo(e.target.value); setActivePreset(""); }} />
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="rpt-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`rpt-tab${activeTab === t.key ? " active" : ""}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ==================== Revenue Tab ==================== */}
        {activeTab === "revenue" && (
          <div className="rpt-tab-content">
            {revLoading ? <Loader /> : revenue ? (
              <>
                <div className="rpt-section-header">
                  <h3 className="rpt-section-title">Revenue Summary</h3>
                  <button className="rpt-btn rpt-btn-secondary rpt-btn-sm" onClick={() => {
                    if (!revenue?.months) return;
                    exportCsv("revenue-report.csv",
                      ["Month", "Total Invoices", "Invoices Sent", "Invoices Paid", "Revenue", "Outstanding", "Collection Rate"],
                      [...revenue.months.map(m => [m.label, m.totalInvoices, m.invoicesSent, m.invoicesPaid, m.revenue.toFixed(2), m.outstanding.toFixed(2), fmtPct(m.collectionRate)]),
                       ["TOTAL", revenue.totals.totalInvoices, revenue.totals.invoicesSent, revenue.totals.invoicesPaid, revenue.totals.revenue.toFixed(2), revenue.totals.outstanding.toFixed(2), fmtPct(revenue.totals.collectionRate)]]);
                  }}>Export CSV</button>
                </div>

                <div className="rpt-card">
                  <table className="rpt-table">
                    <thead>
                      <tr>
                        <th>Month</th><th className="rpt-num">Total Invoices</th><th className="rpt-num">Sent</th>
                        <th className="rpt-num">Paid</th><th className="rpt-num">Revenue</th>
                        <th className="rpt-num">Outstanding</th><th className="rpt-num">Collection %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.months.map(m => (
                        <tr key={m.month}>
                          <td>{m.label}</td><td className="rpt-num">{m.totalInvoices}</td>
                          <td className="rpt-num">{m.invoicesSent}</td><td className="rpt-num">{m.invoicesPaid}</td>
                          <td className="rpt-num rpt-mono">{fmtMoney(m.revenue)}</td>
                          <td className="rpt-num rpt-mono">{fmtMoney(m.outstanding)}</td>
                          <td className="rpt-num">{fmtPct(m.collectionRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>Total</strong></td>
                        <td className="rpt-num"><strong>{revenue.totals.totalInvoices}</strong></td>
                        <td className="rpt-num"><strong>{revenue.totals.invoicesSent}</strong></td>
                        <td className="rpt-num"><strong>{revenue.totals.invoicesPaid}</strong></td>
                        <td className="rpt-num rpt-mono"><strong>{fmtMoney(revenue.totals.revenue)}</strong></td>
                        <td className="rpt-num rpt-mono"><strong>{fmtMoney(revenue.totals.outstanding)}</strong></td>
                        <td className="rpt-num"><strong>{fmtPct(revenue.totals.collectionRate)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {revenue.months.length > 0 && (
                  <div className="rpt-card" style={{ padding: "20px 16px 16px" }}>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={revenue.months} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                        <XAxis dataKey="label" tick={{ fill: secondaryColor, fontSize: 11 }} axisLine={{ stroke: gridColor }} tickLine={false} />
                        <YAxis tick={{ fill: secondaryColor, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtMoneyShort} />
                        <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={chartTooltipStyle} labelStyle={{ color: textColor, fontWeight: 600 }} />
                        <Bar dataKey="revenue" fill={barColor} radius={[6, 6, 0, 0]} name="Revenue" />
                        <Bar dataKey="outstanding" fill={isDark ? "#ff9f0a" : "#ff9500"} radius={[6, 6, 0, 0]} name="Outstanding" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            ) : <div className="rpt-empty">No data available.</div>}
          </div>
        )}

        {/* ==================== Aging Tab ==================== */}
        {activeTab === "aging" && (
          <div className="rpt-tab-content">
            {agingLoading ? <Loader /> : aging ? (
              <>
                <div className="rpt-section-header">
                  <h3 className="rpt-section-title">Accounts Receivable Aging</h3>
                  <button className="rpt-btn rpt-btn-secondary rpt-btn-sm" onClick={() => {
                    const rows = [];
                    for (const b of aging.buckets) {
                      for (const inv of b.invoices) {
                        rows.push([b.label, inv.invoiceNumber, inv.customerName, fmtDate(inv.issueDate), fmtDate(inv.dueDate), inv.total.toFixed(2), inv.balanceDue.toFixed(2), inv.daysOverdue]);
                      }
                    }
                    exportCsv("aging-report.csv", ["Bucket", "Invoice #", "Customer", "Issue Date", "Due Date", "Total", "Balance Due", "Days Overdue"], rows);
                  }}>Export CSV</button>
                </div>

                <div className="rpt-kpi-row">
                  {aging.buckets.map((b, i) => (
                    <div
                      key={b.label}
                      className={`rpt-kpi-card${expandedBucket === i ? " rpt-kpi-active" : ""}`}
                      style={{ borderLeftColor: BUCKET_COLORS[i] }}
                      onClick={() => setExpandedBucket(expandedBucket === i ? null : i)}
                      role="button" tabIndex={0}
                    >
                      <div className="rpt-kpi-label">{b.label}</div>
                      <div className="rpt-kpi-value">{fmtMoney(b.total)}</div>
                      <div className="rpt-kpi-hint">{b.count} invoice{b.count !== 1 ? "s" : ""}</div>
                    </div>
                  ))}
                </div>

                {/* Aging bar */}
                {aging.totalOutstanding > 0 && (
                  <div className="rpt-card" style={{ padding: 20 }}>
                    <div className="rpt-aging-bar">
                      {agingBarData.map((b, i) => b.pct > 0 ? (
                        <div key={b.label} className="rpt-aging-segment" style={{ width: `${b.pct}%`, backgroundColor: b.fill }} title={`${b.label}: ${fmtMoney(b.total)} (${b.pct}%)`}>
                          {b.pct >= 8 && <span className="rpt-aging-segment-label">{b.pct}%</span>}
                        </div>
                      ) : null)}
                    </div>
                    <div className="rpt-aging-legend">
                      {agingBarData.map((b, i) => (
                        <span key={b.label} className="rpt-aging-legend-item">
                          <span className="rpt-aging-dot" style={{ backgroundColor: b.fill }} />
                          {b.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Expanded bucket table */}
                {expandedBucket !== null && aging.buckets[expandedBucket]?.invoices?.length > 0 && (
                  <div className="rpt-card">
                    <div className="rpt-card-header">{aging.buckets[expandedBucket].label} Invoices</div>
                    <table className="rpt-table">
                      <thead>
                        <tr><th>Invoice #</th><th>Customer</th><th>Issue Date</th><th>Due Date</th><th className="rpt-num">Total</th><th className="rpt-num">Balance Due</th><th className="rpt-num">Days</th></tr>
                      </thead>
                      <tbody>
                        {aging.buckets[expandedBucket].invoices.map(inv => (
                          <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)} style={{ cursor: "pointer" }}>
                            <td style={{ fontWeight: 600 }}>{inv.invoiceNumber || "\u2014"}</td>
                            <td>{inv.customerName || "\u2014"}</td>
                            <td>{fmtDate(inv.issueDate)}</td>
                            <td>{fmtDate(inv.dueDate)}</td>
                            <td className="rpt-num rpt-mono">{fmtMoney(inv.total)}</td>
                            <td className="rpt-num rpt-mono">{fmtMoney(inv.balanceDue)}</td>
                            <td className="rpt-num">{inv.daysOverdue}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="rpt-grand-total">
                  Total Outstanding: <strong>{fmtMoney(aging.totalOutstanding)}</strong>
                </div>
              </>
            ) : <div className="rpt-empty">No data available.</div>}
          </div>
        )}

        {/* ==================== Customers Tab ==================== */}
        {activeTab === "customers" && (
          <div className="rpt-tab-content">
            {custLoading ? <Loader /> : customers ? (
              <>
                <div className="rpt-section-header">
                  <h3 className="rpt-section-title">Customer Revenue</h3>
                  <button className="rpt-btn rpt-btn-secondary rpt-btn-sm" onClick={() => {
                    exportCsv("customer-revenue.csv",
                      ["Customer", "Total Invoiced", "Total Paid", "Outstanding", "# Invoices", "# Work Orders"],
                      sortedCustomers.map(c => [c.customerName, c.totalInvoiced.toFixed(2), c.totalPaid.toFixed(2), c.outstanding.toFixed(2), c.invoiceCount, c.workOrderCount]));
                  }}>Export CSV</button>
                </div>

                <div className="rpt-two-col">
                  <div className="rpt-card" style={{ flex: 1.5 }}>
                    <table className="rpt-table">
                      <thead>
                        <tr>
                          <th className="rpt-sortable" onClick={() => toggleCustSort("customerName")}>Customer{sortArrow("customerName")}</th>
                          <th className="rpt-num rpt-sortable" onClick={() => toggleCustSort("totalInvoiced")}>Total Invoiced{sortArrow("totalInvoiced")}</th>
                          <th className="rpt-num rpt-sortable" onClick={() => toggleCustSort("totalPaid")}>Total Paid{sortArrow("totalPaid")}</th>
                          <th className="rpt-num rpt-sortable" onClick={() => toggleCustSort("outstanding")}>Outstanding{sortArrow("outstanding")}</th>
                          <th className="rpt-num rpt-sortable" onClick={() => toggleCustSort("invoiceCount")}># Invoices{sortArrow("invoiceCount")}</th>
                          <th className="rpt-num rpt-sortable" onClick={() => toggleCustSort("workOrderCount")}># WOs{sortArrow("workOrderCount")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedCustomers.map((c, i) => (
                          <tr key={c.id} className={i < 10 ? "rpt-top-row" : ""} onClick={() => navigate(`/customers/${c.id}`)} style={{ cursor: "pointer" }}>
                            <td style={{ fontWeight: 600 }}>{c.customerName}</td>
                            <td className="rpt-num rpt-mono">{fmtMoney(c.totalInvoiced)}</td>
                            <td className="rpt-num rpt-mono">{fmtMoney(c.totalPaid)}</td>
                            <td className="rpt-num rpt-mono">{fmtMoney(c.outstanding)}</td>
                            <td className="rpt-num">{c.invoiceCount}</td>
                            <td className="rpt-num">{c.workOrderCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {custPie.length > 0 && (
                    <div className="rpt-card rpt-chart-side">
                      <div className="rpt-card-header">Revenue by Customer</div>
                      <div style={{ padding: "16px 8px" }}>
                        <ResponsiveContainer width="100%" height={280}>
                          <PieChart>
                            <Pie data={custPie} dataKey="value" nameKey="name" cx="50%" cy="50%"
                                 innerRadius={50} outerRadius={90} paddingAngle={2}
                                 label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                                 labelLine={{ stroke: secondaryColor }}>
                              {custPie.map((_, i) => (
                                <Cell key={i} fill={isDark && i === 0 ? "#0a84ff" : PIE_CUST_COLORS[i % PIE_CUST_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={chartTooltipStyle} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : <div className="rpt-empty">No data available.</div>}
          </div>
        )}

        {/* ==================== Estimates Tab ==================== */}
        {activeTab === "estimates" && (
          <div className="rpt-tab-content">
            {estLoading ? <Loader /> : estimates ? (
              <>
                <div className="rpt-section-header">
                  <h3 className="rpt-section-title">Estimates Report</h3>
                  <button className="rpt-btn rpt-btn-secondary rpt-btn-sm" onClick={() => {
                    exportCsv("estimates-report.csv",
                      ["Date", "Customer", "Project", "Status", "Total"],
                      (estimates.estimates || []).map(e => [fmtDate(e.issueDate), e.customerName, e.projectName, e.status, e.total.toFixed(2)]));
                  }}>Export CSV</button>
                </div>

                <div className="rpt-kpi-row rpt-kpi-4">
                  <div className="rpt-kpi-card" style={{ borderLeftColor: isDark ? "#0a84ff" : "#0071e3" }}>
                    <div className="rpt-kpi-label">Total Estimates</div>
                    <div className="rpt-kpi-value">{estimates.totalCount}</div>
                  </div>
                  <div className="rpt-kpi-card" style={{ borderLeftColor: "#34c759" }}>
                    <div className="rpt-kpi-label">Total Value</div>
                    <div className="rpt-kpi-value">{fmtMoneyShort(estimates.totalValue)}</div>
                  </div>
                  <div className="rpt-kpi-card" style={{ borderLeftColor: "#ff9f0a" }}>
                    <div className="rpt-kpi-label">Conversion Rate</div>
                    <div className="rpt-kpi-value">{fmtPct(estimates.conversionRate)}</div>
                  </div>
                  <div className="rpt-kpi-card" style={{ borderLeftColor: "#636366" }}>
                    <div className="rpt-kpi-label">Avg Value</div>
                    <div className="rpt-kpi-value">{fmtMoney(estimates.avgValue)}</div>
                  </div>
                </div>

                {/* Status breakdown */}
                {estimates.byStatus?.length > 0 && (
                  <div className="rpt-card" style={{ padding: 20 }}>
                    <div className="rpt-status-pills">
                      {estimates.byStatus.map(s => (
                        <span key={s.status} className="rpt-status-badge" style={statusPillStyle(s.status)}>
                          {s.status}: {s.count} ({fmtMoney(s.value)})
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rpt-card">
                  <table className="rpt-table">
                    <thead>
                      <tr><th>Date</th><th>Customer</th><th>Project</th><th>Status</th><th className="rpt-num">Total</th></tr>
                    </thead>
                    <tbody>
                      {(estimates.estimates || []).map(e => (
                        <tr key={e.id} onClick={() => navigate(`/estimates/${e.id}`)} style={{ cursor: "pointer" }}>
                          <td>{fmtDate(e.issueDate)}</td>
                          <td>{e.customerName || "\u2014"}</td>
                          <td>{e.projectName || "\u2014"}</td>
                          <td><span className="rpt-status-pill" style={statusPillStyle(e.status)}>{e.status}</span></td>
                          <td className="rpt-num rpt-mono">{fmtMoney(e.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <div className="rpt-empty">No data available.</div>}
          </div>
        )}

        {/* ==================== Work Orders Tab ==================== */}
        {activeTab === "workorders" && (
          <div className="rpt-tab-content">
            {woLoading ? <Loader /> : workOrders ? (
              <>
                <div className="rpt-section-header">
                  <h3 className="rpt-section-title">Work Order Summary</h3>
                  <button className="rpt-btn rpt-btn-secondary rpt-btn-sm" onClick={() => {
                    const rows = (workOrders.byStatus || []).map(s => [s.status, s.count]);
                    rows.push(["TOTAL", workOrders.totalCount]);
                    rows.push(["Completed", workOrders.completedCount]);
                    rows.push(["Avg Days to Complete", workOrders.avgCompletionDays]);
                    rows.push(["With POs", workOrders.withPOs]);
                    rows.push(["Without POs", workOrders.withoutPOs]);
                    exportCsv("work-orders-report.csv", ["Metric", "Value"], rows);
                  }}>Export CSV</button>
                </div>

                <div className="rpt-kpi-row rpt-kpi-4">
                  <div className="rpt-kpi-card" style={{ borderLeftColor: isDark ? "#0a84ff" : "#0071e3" }}>
                    <div className="rpt-kpi-label">Total</div>
                    <div className="rpt-kpi-value">{workOrders.totalCount}</div>
                  </div>
                  <div className="rpt-kpi-card" style={{ borderLeftColor: "#34c759" }}>
                    <div className="rpt-kpi-label">Completed</div>
                    <div className="rpt-kpi-value">{workOrders.completedCount}</div>
                  </div>
                  <div className="rpt-kpi-card" style={{ borderLeftColor: "#ff9f0a" }}>
                    <div className="rpt-kpi-label">Avg Days to Complete</div>
                    <div className="rpt-kpi-value">{workOrders.avgCompletionDays}</div>
                  </div>
                  <div className="rpt-kpi-card" style={{ borderLeftColor: "#636366" }}>
                    <div className="rpt-kpi-label">With POs</div>
                    <div className="rpt-kpi-value">{workOrders.withPOs}</div>
                    <div className="rpt-kpi-hint">{workOrders.withoutPOs} without</div>
                  </div>
                </div>

                {/* Status breakdown pills */}
                {workOrders.byStatus?.length > 0 && (
                  <div className="rpt-card" style={{ padding: 20 }}>
                    <div className="rpt-status-pills">
                      {workOrders.byStatus.map(s => (
                        <span key={s.status} className="rpt-status-badge" style={statusPillStyle(s.status)}>
                          {s.status}: {s.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : <div className="rpt-empty">No data available.</div>}
          </div>
        )}

        {/* ==================== P&L Tab ==================== */}
        {activeTab === "pl" && (
          <div className="rpt-tab-content">
            {plLoading ? <Loader /> : pl ? (
              <>
                <div className="rpt-section-header">
                  <h3 className="rpt-section-title">Profit & Loss</h3>
                  <button className="rpt-btn rpt-btn-secondary rpt-btn-sm" onClick={() => {
                    if (!pl?.months) return;
                    exportCsv("profit-loss.csv",
                      ["Month", "Revenue"],
                      [...pl.months.map(m => [m.label, m.revenue.toFixed(2)]),
                       ["TOTAL", pl.totalRevenue.toFixed(2)]]);
                  }}>Export CSV</button>
                </div>

                {pl.note && (
                  <div className="rpt-note-banner">{pl.note}</div>
                )}

                <div className="rpt-card">
                  <table className="rpt-table">
                    <thead>
                      <tr><th>Month</th><th className="rpt-num">Revenue</th></tr>
                    </thead>
                    <tbody>
                      {(pl.months || []).map(m => (
                        <tr key={m.month}>
                          <td>{m.label}</td>
                          <td className="rpt-num rpt-mono">{fmtMoney(m.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>Total</strong></td>
                        <td className="rpt-num rpt-mono"><strong>{fmtMoney(pl.totalRevenue)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {pl.months?.length > 0 && (
                  <div className="rpt-card" style={{ padding: "20px 16px 16px" }}>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={pl.months} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                        <XAxis dataKey="label" tick={{ fill: secondaryColor, fontSize: 11 }} axisLine={{ stroke: gridColor }} tickLine={false} />
                        <YAxis tick={{ fill: secondaryColor, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtMoneyShort} />
                        <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={chartTooltipStyle} labelStyle={{ color: textColor, fontWeight: 600 }} />
                        <Bar dataKey="revenue" fill="#34c759" radius={[6, 6, 0, 0]} name="Revenue" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            ) : <div className="rpt-empty">No data available.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
