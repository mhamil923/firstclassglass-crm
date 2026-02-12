// File: src/Home.js
import React, { useEffect, useState, useCallback, useMemo } from "react";
import api from "./api";
import moment from "moment";
import Table from "react-bootstrap/Table";
import { useNavigate, useLocation } from "react-router-dom";
import { useTheme } from "./contexts/ThemeContext";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";
import "./Home.css";

const REFRESH_MS = 60_000;

const fmtMoney = (v) => {
  const n = Number(v) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const fmtMoneyShort = (v) => {
  const n = Number(v) || 0;
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
};

const fmtDate = (d) => {
  if (!d) return "\u2014";
  try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return d; }
};

const PIE_COLORS = {
  Draft: "#8e8e93",
  Sent: "#0071e3",
  Partial: "#ff9f0a",
  Paid: "#34c759",
  Overdue: "#ff3b30",
  Void: "#636366",
};
const PIE_COLORS_DARK = { ...PIE_COLORS, Sent: "#0a84ff" };

export default function Home() {
  const [orders, setOrders] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dash, setDash] = useState(null);
  const [dashLoading, setDashLoading] = useState(true);

  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  /* ========================= Utilities ========================= */
  const norm = (v) => (v ?? "").toString().trim();

  const parseAsLocal = (dt) => {
    if (!dt) return null;
    const s = String(dt);
    const hasZone = /[zZ]|[+\-]\d\d:?\d\d$/.test(s);
    return hasZone ? moment(s).local() : moment(s);
  };

  const goViewOrder = useCallback(
    (id, extraState = {}) => {
      navigate(`/view-work-order/${id}`, {
        state: { from: location.pathname, ...extraState },
      });
    },
    [navigate, location.pathname]
  );

  const fetchOrders = useCallback(async (opts = { silent: false }) => {
    if (!opts?.silent) setIsRefreshing(true);
    try {
      const response = await api.get("/work-orders", { params: { t: Date.now() } });
      setOrders(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      console.error("Error fetching work orders:", error);
      setOrders([]);
    } finally {
      if (!opts?.silent) setIsRefreshing(false);
    }
  }, []);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await api.get("/reports/dashboard");
      setDash(res.data || null);
    } catch (err) {
      console.error("Error fetching dashboard:", err);
    } finally {
      setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    fetchDashboard();

    const onFocus = () => { fetchOrders({ silent: true }); fetchDashboard(); };
    const onVisibility = () => {
      if (document.visibilityState === "visible") { fetchOrders({ silent: true }); fetchDashboard(); }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = setInterval(() => { fetchOrders({ silent: true }); fetchDashboard(); }, REFRESH_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [fetchOrders, fetchDashboard]);

  /* ========================= Agenda / Upcoming ========================= */
  const todayStr = moment().format("YYYY-MM-DD");

  const agendaOrders = useMemo(() => {
    return orders.filter((o) => {
      if (!o.scheduledDate) return false;
      const m = parseAsLocal(o.scheduledDate);
      return m?.isValid() && m.format("YYYY-MM-DD") === todayStr;
    });
  }, [orders, todayStr]);

  const upcomingOrders = useMemo(() => {
    return orders.filter((o) => {
      if (!o.scheduledDate) return false;
      const m = parseAsLocal(o.scheduledDate);
      return m?.isValid() && m.isAfter(moment(), "day");
    });
  }, [orders]);

  const waitingForApprovalOrders = useMemo(() => {
    return orders.filter((o) => o.status === "Waiting for Approval");
  }, [orders]);

  const fmtDateTime = (dt) => {
    const m = parseAsLocal(dt);
    return m && m.isValid() ? m.format("YYYY-MM-DD HH:mm") : "";
  };

  const woCell = (o) => o?.workOrderNumber || "\u2014";

  /* ========================= Notes ========================= */
  const parseNotesField = (notesLike) => {
    if (!notesLike) return [];
    if (Array.isArray(notesLike)) return notesLike;
    if (typeof notesLike === "string") {
      try {
        const arr = JSON.parse(notesLike);
        if (Array.isArray(arr)) return arr;
      } catch {
        return notesLike.split(/\r?\n\r?\n|\r?\n/g).map((s) => s.trim()).filter(Boolean).map((line) => ({ text: line }));
      }
      return [];
    }
    if (typeof notesLike === "object") {
      if (Array.isArray(notesLike.items)) return notesLike.items;
      if (Array.isArray(notesLike.list)) return notesLike.list;
      if (Array.isArray(notesLike.notes)) return notesLike.notes;
    }
    return [];
  };

  const extractNoteMoment = (note, order) => {
    let raw = note?.createdAt ?? note?.created_at ?? note?.date ?? note?.timestamp ?? note?.time ?? null;
    if (raw == null && typeof note?.text === "string") {
      const t = note.text;
      const isoMatch = t.match(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?\b/) || t.match(/\b\d{4}-\d{2}-\d{2}\b/);
      const usMatch = t.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:[ T]\d{1,2}:\d{2}(?:\s?[AP]M)?)?\b/i);
      raw = (isoMatch && isoMatch[0]) || (usMatch && usMatch[0]) || null;
    }
    if (raw == null) raw = order?.lastNoteAt || order?.updatedAt || order?.createdAt || null;
    if (raw == null) return null;
    if (typeof raw === "number") { if (raw < 10_000_000_000) raw = raw * 1000; return moment(raw); }
    if (typeof raw === "string") {
      if (moment(raw, moment.ISO_8601, true).isValid()) return moment(raw);
      const tryFmt = moment(raw, ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD", "M/D/YYYY h:mm A", "M/D/YYYY"], true);
      return tryFmt.isValid() ? tryFmt : moment(raw);
    }
    return null;
  };

  const getAllNotesForOrder = (order) => {
    const all = [];
    for (const c of [order?.notes, order?.internalNotes, order?.comments, order?.noteLog, order?.activity?.notes, order?.latestNotes]) {
      const arr = parseNotesField(c);
      if (arr?.length) all.push(...arr);
    }
    return all;
  };

  const DISMISSED_KEY = "dismissedNotes:v1";
  const readDismissedSet = () => { try { const raw = localStorage.getItem(DISMISSED_KEY); const arr = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(arr) ? arr : []); } catch { return new Set(); } };
  const writeDismissedSet = (set) => { try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(set))); } catch {} };
  const makeNoteKey = (orderId, createdISO, text) => `${orderId}:${createdISO}:${(text || "").slice(0, 64)}`;

  const weeklyNotes = useMemo(() => {
    const dismissed = readDismissedSet();
    const cutoff = moment().subtract(7, "days");
    const out = [];
    for (const o of orders) {
      const rawNotes = getAllNotesForOrder(o);
      if (!rawNotes.length) continue;
      for (const n of rawNotes) {
        const created = extractNoteMoment(n, o);
        if (!created || !created.isValid() || !created.isSameOrAfter(cutoff)) continue;
        const createdISO = created.toISOString();
        const text = n?.text || n?.note || n?.message || String(n || "");
        const by = n?.by || n?.user || n?.author || "";
        const key = makeNoteKey(o.id, createdISO, text);
        if (dismissed.has(key)) continue;
        out.push({ key, orderId: o.id, workOrderNumber: o.workOrderNumber || null, customer: o.customer || "\u2014", siteLocation: norm(o.siteLocation) || norm(o.siteName) || norm(o.siteLocationName) || "\u2014", text, by, createdAt: createdISO });
      }
    }
    out.sort((a, b) => moment(b.createdAt).valueOf() - moment(a.createdAt).valueOf());
    return out;
  }, [orders]);

  const onClickNote = (note) => { const dismissed = readDismissedSet(); dismissed.add(note.key); writeDismissedSet(dismissed); goViewOrder(note.orderId, { highlightLatestNote: true }); };
  const clearAllWeeklyNotes = () => { const dismissed = readDismissedSet(); for (const n of weeklyNotes) dismissed.add(n.key); writeDismissedSet(dismissed); fetchOrders({ silent: true }); };

  /* ========================= Dashboard helpers ========================= */
  const revChange = useMemo(() => {
    if (!dash) return { pct: 0, dir: "flat" };
    const cur = dash.currentMonthRevenue || 0;
    const prev = dash.lastMonthRevenue || 0;
    if (prev === 0) return cur > 0 ? { pct: 100, dir: "up" } : { pct: 0, dir: "flat" };
    const pct = Math.round(((cur - prev) / prev) * 1000) / 10;
    return { pct: Math.abs(pct), dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
  }, [dash]);

  const pieData = useMemo(() => {
    if (!dash?.invoiceStatusBreakdown) return [];
    return dash.invoiceStatusBreakdown.filter(s => s.count > 0);
  }, [dash]);

  const statusPillStyle = (s) => {
    const sl = (s || "").toLowerCase();
    if (sl === "sent") return { background: "rgba(0,113,227,0.1)", color: isDark ? "#0a84ff" : "#0071e3" };
    if (sl === "partial") return { background: "rgba(255,159,10,0.12)", color: "#ff9f0a" };
    if (sl === "paid") return { background: "rgba(52,199,89,0.12)", color: "#34c759" };
    if (sl === "overdue") return { background: "rgba(255,59,48,0.12)", color: "#ff3b30" };
    if (sl === "void") return { background: "rgba(142,142,147,0.12)", color: "#636366" };
    if (sl === "accepted") return { background: "rgba(52,199,89,0.12)", color: "#34c759" };
    if (sl === "declined") return { background: "rgba(255,59,48,0.12)", color: "#ff3b30" };
    return { background: "rgba(142,142,147,0.12)", color: "#8e8e93" };
  };

  /* ========================= UI Helpers ========================= */
  const CardHeader = ({ title, right, subtitle }) => (
    <div className="home-card-header">
      <div style={{ minWidth: 0 }}>
        <div className="home-card-title">{title}</div>
        {subtitle ? <div className="home-card-subtitle">{subtitle}</div> : null}
      </div>
      {right ? <div className="home-card-right">{right}</div> : null}
    </div>
  );

  const barColor = isDark ? "#0a84ff" : "#0071e3";
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const textColor = isDark ? "#f5f5f7" : "#1d1d1f";
  const secondaryColor = isDark ? "#aeaeb2" : "#6e6e73";

  const chartTooltipStyle = {
    backgroundColor: isDark ? "#1c1c1e" : "#ffffff",
    border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}`,
    borderRadius: 12,
    color: textColor,
    fontSize: 13,
  };

  return (
    <div className="home-page">
      <div className="home-shell">
        <div className="home-topbar">
          <div style={{ minWidth: 0 }}>
            <h2 className="home-title">Dashboard</h2>
            <div className="home-subtitle">Business overview, financials, and today's work orders.</div>
          </div>
          <div className="home-topbar-actions">
            <button className="btn btn-outline-secondary" onClick={() => navigate("/reports")}>
              Reports
            </button>
            <button className="btn btn-outline-secondary" onClick={() => navigate("/calendar")}>
              Calendar
            </button>
            <button className="btn btn-primary" onClick={() => { fetchOrders(); fetchDashboard(); }} disabled={isRefreshing}>
              {isRefreshing ? "Refreshing\u2026" : "Refresh"}
            </button>
          </div>
        </div>

        {/* ===================== Financial KPI Row ===================== */}
        {!dashLoading && dash && (
          <div className="dash-kpi-row">
            <div className="dash-kpi-card" style={{ borderLeftColor: isDark ? "#0a84ff" : "#0071e3" }}
                 onClick={() => navigate("/reports")} role="button" tabIndex={0}>
              <div className="dash-kpi-label">Revenue This Month</div>
              <div className="dash-kpi-value">{fmtMoney(dash.currentMonthRevenue)}</div>
              <div className="dash-kpi-bottom">
                {revChange.dir !== "flat" && (
                  <span className={`dash-kpi-trend ${revChange.dir === "up" ? "dash-trend-up" : "dash-trend-down"}`}>
                    {revChange.dir === "up" ? "\u2191" : "\u2193"} {revChange.pct}%
                  </span>
                )}
                <span className="dash-kpi-hint">vs last month</span>
                {dash.revenueByMonth?.length > 1 && (
                  <div className="dash-sparkline">
                    <ResponsiveContainer width="100%" height={36}>
                      <LineChart data={dash.revenueByMonth}>
                        <Line type="monotone" dataKey="revenue" stroke={barColor} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>

            <div className={`dash-kpi-card${dash.hasOverdue ? " dash-kpi-alert" : ""}`}
                 style={{ borderLeftColor: dash.hasOverdue ? "#ff3b30" : "#ff9f0a" }}
                 onClick={() => navigate("/invoices")} role="button" tabIndex={0}>
              <div className="dash-kpi-label">Outstanding</div>
              <div className="dash-kpi-value">{fmtMoney(dash.outstandingTotal)}</div>
              <div className="dash-kpi-bottom">
                <span className="dash-kpi-hint">{dash.unpaidCount} unpaid invoice{dash.unpaidCount !== 1 ? "s" : ""}</span>
                {dash.hasOverdue && <span className="dash-kpi-trend dash-trend-down">{dash.overdueCount} overdue</span>}
              </div>
            </div>

            <div className="dash-kpi-card" style={{ borderLeftColor: "#34c759" }}
                 onClick={() => navigate("/estimates")} role="button" tabIndex={0}>
              <div className="dash-kpi-label">Estimates Pipeline</div>
              <div className="dash-kpi-value">{dash.estimatesPendingCount}</div>
              <div className="dash-kpi-bottom">
                <span className="dash-kpi-hint">{fmtMoney(dash.estimatesPendingValue)} pending</span>
                <span className="dash-kpi-trend dash-trend-up">{dash.estimatesConversionRate}% conversion</span>
              </div>
            </div>

            <div className="dash-kpi-card" style={{ borderLeftColor: "#ff9500" }}
                 onClick={() => navigate("/work-orders")} role="button" tabIndex={0}>
              <div className="dash-kpi-label">Work Orders</div>
              <div className="dash-kpi-value">{dash.activeWorkOrders}</div>
              <div className="dash-kpi-bottom">
                <span className="dash-kpi-hint">{dash.waitingOnParts} waiting on parts</span>
                <span className="dash-kpi-hint">{dash.completedThisMonth} completed this month</span>
              </div>
            </div>
          </div>
        )}

        {/* ===================== Alert Banners ===================== */}
        {dash?.overdueCount > 0 && (
          <div className="dash-alert dash-alert-red" onClick={() => navigate("/invoices?status=Overdue")} role="button" tabIndex={0}>
            <strong>{dash.overdueCount} overdue invoice{dash.overdueCount !== 1 ? "s" : ""}</strong> totaling {fmtMoney(dash.overdueTotal)}
          </div>
        )}
        {dash?.expiringEstimates?.length > 0 && (
          <div className="dash-alert dash-alert-orange" onClick={() => navigate("/estimates")} role="button" tabIndex={0}>
            <strong>{dash.expiringEstimates.length} estimate{dash.expiringEstimates.length !== 1 ? "s" : ""}</strong> expiring within 7 days
          </div>
        )}

        {/* ===================== Charts Row ===================== */}
        {!dashLoading && dash && (
          <div className="dash-charts-row">
            <div className="home-card">
              <CardHeader title="Monthly Revenue" subtitle="Last 12 months" />
              <div className="dash-chart-body">
                {dash.monthlyRevenue?.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={dash.monthlyRevenue} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                      <XAxis dataKey="label" tick={{ fill: secondaryColor, fontSize: 11 }} axisLine={{ stroke: gridColor }} tickLine={false} />
                      <YAxis tick={{ fill: secondaryColor, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtMoneyShort} />
                      <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={chartTooltipStyle} labelStyle={{ color: textColor, fontWeight: 600 }} />
                      <Bar dataKey="revenue" fill={barColor} radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="home-empty">No revenue data yet.</div>
                )}
              </div>
            </div>

            <div className="home-card">
              <CardHeader title="Invoice Status" subtitle="All invoices" />
              <div className="dash-chart-body">
                {pieData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={pieData} dataKey="total" nameKey="status" cx="50%" cy="50%"
                           innerRadius={60} outerRadius={100} paddingAngle={2} label={({ status, count }) => `${status} (${count})`}
                           labelLine={{ stroke: secondaryColor }} >
                        {pieData.map((entry) => (
                          <Cell key={entry.status} fill={(isDark ? PIE_COLORS_DARK : PIE_COLORS)[entry.status] || "#8e8e93"} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={chartTooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="home-empty">No invoice data yet.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===================== Recent Activity ===================== */}
        {!dashLoading && dash && (
          <div className="dash-recent-row">
            <div className="home-card">
              <CardHeader title="Recent Invoices" right={
                <button className="btn btn-ghost" onClick={() => navigate("/invoices")} style={{ fontSize: 12 }}>View All</button>
              } />
              {dash.recentInvoices?.length > 0 ? (
                <table className="dash-recent-table">
                  <thead>
                    <tr><th>Invoice #</th><th>Customer</th><th>Status</th><th style={{ textAlign: "right" }}>Total</th></tr>
                  </thead>
                  <tbody>
                    {dash.recentInvoices.map((inv) => (
                      <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
                        <td style={{ fontWeight: 600 }}>{inv.invoiceNumber || "\u2014"}</td>
                        <td>{inv.customerName || "\u2014"}</td>
                        <td>
                          <span className="dash-status-pill" style={statusPillStyle(inv.status)}>{inv.status || "Draft"}</span>
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(inv.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="home-empty">No invoices yet.</div>
              )}
            </div>

            <div className="home-card">
              <CardHeader title="Recent Estimates" right={
                <button className="btn btn-ghost" onClick={() => navigate("/estimates")} style={{ fontSize: 12 }}>View All</button>
              } />
              {dash.recentEstimates?.length > 0 ? (
                <table className="dash-recent-table">
                  <thead>
                    <tr><th>Project</th><th>Customer</th><th>Status</th><th style={{ textAlign: "right" }}>Total</th></tr>
                  </thead>
                  <tbody>
                    {dash.recentEstimates.map((est) => (
                      <tr key={est.id} onClick={() => navigate(`/estimates/${est.id}`)}>
                        <td>{est.projectName || "\u2014"}</td>
                        <td>{est.customerName || "\u2014"}</td>
                        <td>
                          <span className="dash-status-pill" style={statusPillStyle(est.status)}>{est.status || "Draft"}</span>
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(est.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="home-empty">No estimates yet.</div>
              )}
            </div>
          </div>
        )}

        {/* ===================== Operational KPI tiles ===================== */}
        <div className="home-kpis">
          <div className="kpi-tile" onClick={() => navigate("/calendar")} role="button" tabIndex={0}>
            <div className="kpi-label">Today</div>
            <div className="kpi-value">{agendaOrders.length}</div>
            <div className="kpi-hint">scheduled</div>
          </div>
          <div className="kpi-tile">
            <div className="kpi-label">Upcoming</div>
            <div className="kpi-value">{upcomingOrders.length}</div>
            <div className="kpi-hint">future dates</div>
          </div>
          <div className="kpi-tile">
            <div className="kpi-label">Waiting Approval</div>
            <div className="kpi-value">{waitingForApprovalOrders.length}</div>
            <div className="kpi-hint">needs action</div>
          </div>
          <div className="kpi-tile">
            <div className="kpi-label">New Notes</div>
            <div className="kpi-value">{weeklyNotes.length}</div>
            <div className="kpi-hint">last 7 days</div>
          </div>
        </div>

        {/* ===================== Main grid (existing content) ===================== */}
        <div className="home-grid">
          {/* LEFT: Notes */}
          <div className="home-card">
            <CardHeader
              title="Notes (This Week)"
              subtitle="Click a note to open the work order (it will be marked read)."
              right={weeklyNotes.length > 0 ? (
                <button className="btn btn-ghost" onClick={clearAllWeeklyNotes} style={{ fontSize: 12 }}>Mark All Read</button>
              ) : null}
            />
            <div className="notes-body">
              {weeklyNotes.length > 0 ? (
                <div className="notes-list">
                  {weeklyNotes.map((n) => (
                    <div key={n.key} className="note-row" onClick={() => onClickNote(n)} title="Open work order">
                      <div className="note-row-top">
                        <div className="note-row-left">
                          <span className="note-pill">WO: {n.workOrderNumber || n.orderId}</span>
                          <span className="note-dot">&bull;</span>
                          <span className="note-muted">{n.customer}</span>
                          <span className="note-dot">&bull;</span>
                          <span className="note-muted">{n.siteLocation}</span>
                        </div>
                        <div className="note-row-right">
                          {moment(n.createdAt).fromNow()}
                          {n.by ? ` \u2022 ${n.by}` : ""}
                        </div>
                      </div>
                      <div className="note-row-text">{n.text}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="home-empty">No new notes from the past 7 days.</div>
              )}
            </div>
          </div>

          {/* RIGHT: Today Agenda */}
          <div className="home-card">
            <CardHeader title="Agenda for Today" subtitle={todayStr} />
            {agendaOrders.length > 0 ? (
              <Table bordered={false} hover responsive className="home-table home-table-agenda mb-0">
                <thead><tr><th>WO #</th><th>Customer</th><th>Site</th><th className="hide-md">Problem</th><th>Time</th></tr></thead>
                <tbody>
                  {agendaOrders.map((o) => (
                    <tr key={o.id} onClick={() => goViewOrder(o.id)} title="Click to view">
                      <td className="mono">{woCell(o)}</td>
                      <td>{o.customer || "\u2014"}</td>
                      <td>{o.siteLocation || "\u2014"}</td>
                      <td className="hide-md"><div className="problem-scroll" title={o.problemDescription || ""}>{o.problemDescription || "\u2014"}</div></td>
                      <td className="mono">{fmtDateTime(o.scheduledDate) || "\u2014"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <div className="home-empty">No work orders scheduled for today.</div>
            )}
          </div>

          {/* FULL WIDTH: Upcoming */}
          <div className="home-card home-card-span">
            <CardHeader title="Upcoming Work Orders" subtitle="Scheduled after today" />
            {upcomingOrders.length > 0 ? (
              <Table bordered={false} hover responsive className="home-table mb-0">
                <thead><tr><th>WO #</th><th>Customer</th><th>Site</th><th className="hide-sm">Problem</th><th>Scheduled</th></tr></thead>
                <tbody>
                  {upcomingOrders.map((o) => (
                    <tr key={o.id} onClick={() => goViewOrder(o.id)} title="Click to view">
                      <td className="mono">{woCell(o)}</td>
                      <td>{o.customer || "\u2014"}</td>
                      <td>{o.siteLocation || "\u2014"}</td>
                      <td className="hide-sm">{o.problemDescription || "\u2014"}</td>
                      <td className="mono">{fmtDateTime(o.scheduledDate) || "\u2014"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <div className="home-empty">No upcoming work orders.</div>
            )}
          </div>

          {/* FULL WIDTH: Waiting Approval */}
          <div className="home-card home-card-span">
            <CardHeader title="Work Orders Waiting for Approval" subtitle="Status = Waiting for Approval" />
            {waitingForApprovalOrders.length > 0 ? (
              <Table bordered={false} hover responsive className="home-table mb-0">
                <thead><tr><th>WO #</th><th>Customer</th><th>Site</th><th className="hide-sm">Problem</th><th>Status</th></tr></thead>
                <tbody>
                  {waitingForApprovalOrders.map((o) => (
                    <tr key={o.id} onClick={() => goViewOrder(o.id)} title="Click to view">
                      <td className="mono">{woCell(o)}</td>
                      <td>{o.customer || "\u2014"}</td>
                      <td>{o.siteLocation || "\u2014"}</td>
                      <td className="hide-sm">{o.problemDescription || "\u2014"}</td>
                      <td>{o.status || "\u2014"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <div className="home-empty">No work orders waiting for approval.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
