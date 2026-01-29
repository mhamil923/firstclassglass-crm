// File: src/Home.js
import React, { useEffect, useState, useCallback, useMemo } from "react";
import api from "./api";
import moment from "moment";
import Table from "react-bootstrap/Table";
import { useNavigate } from "react-router-dom";
import "./Home.css";

const REFRESH_MS = 60_000; // auto-refresh orders every 60s

export default function Home() {
  const [orders, setOrders] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const navigate = useNavigate();

  /* =========================
     Utilities
  ========================= */
  const norm = (v) => (v ?? "").toString().trim();

  // Parse as local unless string already has a zone (Z or +hh:mm)
  const parseAsLocal = (dt) => {
    if (!dt) return null;
    const s = String(dt);
    const hasZone = /[zZ]|[+\-]\d\d:?\d\d$/.test(s);
    return hasZone ? moment(s).local() : moment(s);
  };

  // Cache-busted fetch so recent changes always appear
  const fetchOrders = useCallback(async (opts = { silent: false }) => {
    if (!opts?.silent) setIsRefreshing(true);
    try {
      const response = await api.get("/work-orders", { params: { t: Date.now() } });
      const data = Array.isArray(response.data) ? response.data : [];
      setOrders(data);
    } catch (error) {
      console.error("Error fetching work orders:", error);
      setOrders([]);
    } finally {
      if (!opts?.silent) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();

    // refresh when tab regains focus OR becomes visible
    const onFocus = () => fetchOrders({ silent: true });
    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchOrders({ silent: true });
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // gentle polling to keep notes fresh while user idles on dashboard
    const interval = setInterval(() => fetchOrders({ silent: true }), REFRESH_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [fetchOrders]);

  /* =========================
     Agenda / Upcoming blocks
  ========================= */
  const todayStr = moment().format("YYYY-MM-DD");

  const agendaOrders = useMemo(() => {
    return orders.filter((o) => {
      if (!o.scheduledDate) return false;
      const m = parseAsLocal(o.scheduledDate);
      if (!m?.isValid()) return false;
      return m.format("YYYY-MM-DD") === todayStr;
    });
  }, [orders, todayStr]);

  const upcomingOrders = useMemo(() => {
    return orders.filter((o) => {
      if (!o.scheduledDate) return false;
      const m = parseAsLocal(o.scheduledDate);
      if (!m?.isValid()) return false;
      return m.isAfter(moment(), "day");
    });
  }, [orders]);

  const waitingForApprovalOrders = useMemo(() => {
    return orders.filter((o) => o.status === "Waiting for Approval");
  }, [orders]);

  const fmtDateTime = (dt) => {
    const m = parseAsLocal(dt);
    return m && m.isValid() ? m.format("YYYY-MM-DD HH:mm") : "";
  };

  const woCell = (o) => o?.workOrderNumber || "—";

  /* =========================
     Notes (robust extraction)
  ========================= */

  const parseNotesField = (notesLike) => {
    if (!notesLike) return [];
    if (Array.isArray(notesLike)) return notesLike;

    if (typeof notesLike === "string") {
      try {
        const arr = JSON.parse(notesLike);
        if (Array.isArray(arr)) return arr;
      } catch {
        const lines = notesLike
          .split(/\r?\n\r?\n|\r?\n/g)
          .map((s) => s.trim())
          .filter(Boolean);
        return lines.map((line) => ({ text: line }));
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
    let raw =
      note?.createdAt ??
      note?.created_at ??
      note?.date ??
      note?.timestamp ??
      note?.time ??
      null;

    if (raw == null && typeof note?.text === "string") {
      const t = note.text;
      const isoMatch =
        t.match(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?\b/) ||
        t.match(/\b\d{4}-\d{2}-\d{2}\b/);
      const usMatch =
        t.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:[ T]\d{1,2}:\d{2}(?:\s?[AP]M)?)?\b/i);
      raw = (isoMatch && isoMatch[0]) || (usMatch && usMatch[0]) || null;
    }

    if (raw == null) {
      raw = order?.lastNoteAt || order?.updatedAt || order?.createdAt || null;
    }

    if (raw == null) return null;

    if (typeof raw === "number") {
      if (raw < 10_000_000_000) raw = raw * 1000;
      return moment(raw);
    }

    if (typeof raw === "string") {
      if (moment(raw, moment.ISO_8601, true).isValid()) return moment(raw);
      const tryFmt = moment(
        raw,
        ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD", "M/D/YYYY h:mm A", "M/D/YYYY"],
        true
      );
      return tryFmt.isValid() ? tryFmt : moment(raw);
    }

    return null;
  };

  const getAllNotesForOrder = (order) => {
    const candidates = [
      order?.notes,
      order?.internalNotes,
      order?.comments,
      order?.noteLog,
      order?.activity?.notes,
      order?.latestNotes,
    ];
    const all = [];
    for (const c of candidates) {
      const arr = parseNotesField(c);
      if (arr?.length) all.push(...arr);
    }
    return all;
  };

  const DISMISSED_KEY = "dismissedNotes:v1";
  const readDismissedSet = () => {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  };
  const writeDismissedSet = (set) => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(set)));
    } catch {}
  };

  const makeNoteKey = (orderId, createdISO, text) =>
    `${orderId}:${createdISO}:${(text || "").slice(0, 64)}`;

  const weeklyNotes = useMemo(() => {
    const dismissed = readDismissedSet();
    const cutoff = moment().subtract(7, "days");
    const out = [];

    for (const o of orders) {
      const rawNotes = getAllNotesForOrder(o);
      if (!rawNotes.length) continue;

      for (const n of rawNotes) {
        const created = extractNoteMoment(n, o);
        if (!created || !created.isValid()) continue;
        if (!created.isSameOrAfter(cutoff)) continue;

        const createdISO = created.toISOString();
        const text = n?.text || n?.note || n?.message || String(n || "");
        const by = n?.by || n?.user || n?.author || "";
        const key = makeNoteKey(o.id, createdISO, text);
        if (dismissed.has(key)) continue;

        out.push({
          key,
          orderId: o.id,
          workOrderNumber: o.workOrderNumber || null,
          customer: o.customer || "—",
          siteLocation:
            norm(o.siteLocation) ||
            norm(o.siteName) ||
            norm(o.siteLocationName) ||
            "—",
          text,
          by,
          createdAt: createdISO,
        });
      }
    }

    out.sort((a, b) => moment(b.createdAt).valueOf() - moment(a.createdAt).valueOf());
    return out;
  }, [orders]);

  const onClickNote = (note) => {
    const dismissed = readDismissedSet();
    dismissed.add(note.key);
    writeDismissedSet(dismissed);

    navigate(`/view-work-order/${note.orderId}`, {
      state: { highlightLatestNote: true },
    });
  };

  const clearAllWeeklyNotes = () => {
    const dismissed = readDismissedSet();
    for (const n of weeklyNotes) dismissed.add(n.key);
    writeDismissedSet(dismissed);
    fetchOrders({ silent: true });
  };

  /* =========================
     UI helpers
  ========================= */
  const CardHeader = ({ title, right, subtitle }) => (
    <div className="home-card-header">
      <div style={{ minWidth: 0 }}>
        <div className="home-card-title">{title}</div>
        {subtitle ? <div className="home-card-subtitle">{subtitle}</div> : null}
      </div>
      {right ? <div className="home-card-right">{right}</div> : null}
    </div>
  );

  /* =========================
     Render
  ========================= */
  return (
    <div className="home-page">
      <div className="home-shell">
        <div className="home-topbar">
          <div style={{ minWidth: 0 }}>
            <h2 className="home-title">Dashboard</h2>
            <div className="home-subtitle">
              Quick overview of notes + today’s work orders.
            </div>
          </div>

          <div className="home-topbar-actions">
            <button
              className="btn btn-outline-secondary"
              onClick={() => navigate("/calendar")}
              title="Open Calendar"
            >
              Calendar
            </button>

            <button
              className="btn btn-primary"
              onClick={() => fetchOrders()}
              disabled={isRefreshing}
              title="Refresh"
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {/* ===== KPI tiles ===== */}
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

        {/* ===== Two-column layout on desktop ===== */}
        <div className="home-grid">
          {/* LEFT: Notes */}
          <div className="home-card">
            <CardHeader
              title="Notes (This Week)"
              subtitle="Click a note to open the work order (it will be marked read)."
              right={
                weeklyNotes.length > 0 ? (
                  <button className="btn btn-ghost" onClick={clearAllWeeklyNotes} style={{ fontSize: 12 }}>
                    Mark All Read
                  </button>
                ) : null
              }
            />

            {weeklyNotes.length > 0 ? (
              <div className="notes-list">
                {weeklyNotes.map((n) => (
                  <div
                    key={n.key}
                    className="note-row"
                    onClick={() => onClickNote(n)}
                    title="Open work order"
                  >
                    <div className="note-row-top">
                      <div className="note-row-left">
                        <span className="note-pill">WO: {n.workOrderNumber || n.orderId}</span>
                        <span className="note-dot">•</span>
                        <span className="note-muted">{n.customer}</span>
                        <span className="note-dot">•</span>
                        <span className="note-muted">{n.siteLocation}</span>
                      </div>
                      <div className="note-row-right">
                        {moment(n.createdAt).fromNow()}
                        {n.by ? ` • ${n.by}` : ""}
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

          {/* RIGHT: Today Agenda */}
          <div className="home-card">
            <CardHeader title={`Agenda for Today`} subtitle={todayStr} />

            {agendaOrders.length > 0 ? (
              <Table bordered={false} hover responsive className="home-table mb-0">
                <thead>
                  <tr>
                    <th>WO #</th>
                    <th>Customer</th>
                    <th>Site</th>
                    <th className="hide-md">Problem</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {agendaOrders.map((o) => (
                    <tr key={o.id} onClick={() => navigate(`/view-work-order/${o.id}`)} title="Click to view">
                      <td className="mono">{woCell(o)}</td>
                      <td>{o.customer || "—"}</td>
                      <td>{o.siteLocation || "—"}</td>
                      <td className="hide-md">{o.problemDescription || "—"}</td>
                      <td className="mono">{fmtDateTime(o.scheduledDate) || "—"}</td>
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
                <thead>
                  <tr>
                    <th>WO #</th>
                    <th>Customer</th>
                    <th>Site</th>
                    <th className="hide-sm">Problem</th>
                    <th>Scheduled</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingOrders.map((o) => (
                    <tr key={o.id} onClick={() => navigate(`/view-work-order/${o.id}`)} title="Click to view">
                      <td className="mono">{woCell(o)}</td>
                      <td>{o.customer || "—"}</td>
                      <td>{o.siteLocation || "—"}</td>
                      <td className="hide-sm">{o.problemDescription || "—"}</td>
                      <td className="mono">{fmtDateTime(o.scheduledDate) || "—"}</td>
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
                <thead>
                  <tr>
                    <th>WO #</th>
                    <th>Customer</th>
                    <th>Site</th>
                    <th className="hide-sm">Problem</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {waitingForApprovalOrders.map((o) => (
                    <tr key={o.id} onClick={() => navigate(`/view-work-order/${o.id}`)} title="Click to view">
                      <td className="mono">{woCell(o)}</td>
                      <td>{o.customer || "—"}</td>
                      <td>{o.siteLocation || "—"}</td>
                      <td className="hide-sm">{o.problemDescription || "—"}</td>
                      <td>{o.status || "—"}</td>
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
