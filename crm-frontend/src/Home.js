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
  const navigate = useNavigate();

  // ---- helpers ----
  const parseNotes = (notes) => {
    if (!notes) return [];
    if (Array.isArray(notes)) return notes;
    if (typeof notes === "string") {
      try {
        const arr = JSON.parse(notes);
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    }
    // object or unknown
    return [];
  };

  const norm = (v) => (v ?? "").toString().trim();

  // local “read/dismissed” tracking for note notifications
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
  const makeNoteKey = (orderId, createdAt) => `${orderId}:${createdAt}`;

  const fetchOrders = useCallback(() => {
    // add a cache-buster param to avoid any intermediate caching
    api
      .get("/work-orders", { params: { t: Date.now() } })
      .then((response) => {
        const data = Array.isArray(response.data) ? response.data : [];
        setOrders(data);
      })
      .catch((error) => {
        console.error("Error fetching work orders:", error);
        setOrders([]);
      });
  }, []);

  useEffect(() => {
    fetchOrders();

    // refresh when tab regains focus OR becomes visible
    const onFocus = () => fetchOrders();
    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchOrders();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // gentle polling to keep notes fresh while user idles on dashboard
    const interval = setInterval(fetchOrders, REFRESH_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [fetchOrders]);

  // Parse as local unless string already has a zone
  const parseAsLocal = (dt) => {
    if (!dt) return null;
    const s = String(dt);
    const hasZone = /[zZ]|[+\-]\d\d:?\d\d$/.test(s);
    return hasZone ? moment(s).local() : moment(s);
  };

  const todayStr = moment().format("YYYY-MM-DD");

  const agendaOrders = orders.filter((o) => {
    if (!o.scheduledDate) return false;
    const m = parseAsLocal(o.scheduledDate);
    if (!m?.isValid()) return false;
    return m.format("YYYY-MM-DD") === todayStr;
  });

  const upcomingOrders = orders.filter((o) => {
    if (!o.scheduledDate) return false;
    const m = parseAsLocal(o.scheduledDate);
    if (!m?.isValid()) return false;
    return m.isAfter(moment(), "day");
  });

  const waitingForApprovalOrders = orders.filter(
    (o) => o.status === "Waiting for Approval"
  );

  const fmtDateTime = (dt) => {
    const m = parseAsLocal(dt);
    return m && m.isValid() ? m.format("YYYY-MM-DD HH:mm") : "";
  };

  const woCell = (o) => o?.workOrderNumber || "—";

  // ---- robust note timestamp extraction
  const getNoteCreated = (n) => {
    // support multiple shapes: createdAt | created_at | date | timestamp
    let raw =
      n?.createdAt ??
      n?.created_at ??
      n?.date ??
      n?.timestamp ??
      null;

    if (raw == null) return null;

    // if numeric, assume ms (if too small, treat as seconds)
    if (typeof raw === "number") {
      if (raw < 10_000_000_000) {
        // seconds -> ms
        raw = raw * 1000;
      }
      return moment(raw);
    }

    // string: accept ISO / “YYYY-MM-DD HH:mm:ss”
    if (typeof raw === "string") {
      // if strict ISO works, use it
      if (moment(raw, moment.ISO_8601, true).isValid()) return moment(raw);
      // else try common server format
      const m = moment(raw, ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD"], true);
      return m.isValid() ? m : moment(raw); // final best effort
    }

    return null;
  };

  // ===== Notes (This Week) =====
  // Build a flat list of notes (with order context) created within last 7 days (inclusive)
  const weeklyNotes = useMemo(() => {
    const dismissed = readDismissedSet();
    const oneWeekAgo = moment().subtract(7, "days");
    const out = [];

    for (const o of orders) {
      const list = parseNotes(o.notes);
      if (!list.length) continue;

      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const created = getNoteCreated(n);
        if (!created || !created.isValid()) continue;

        // include notes that are on/after the 7-day cutoff
        if (!created.isSameOrAfter(oneWeekAgo)) continue;

        const createdKey =
          typeof n?.createdAt === "string" || typeof n?.createdAt === "number"
            ? n.createdAt
            : created.toISOString();

        const key = makeNoteKey(o.id, createdKey);
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
          text: n?.text || n?.note || n?.message || "",
          by: n?.by || n?.user || n?.author || "",
          createdAt: created.toISOString(),
        });
      }
    }

    // Newest first
    out.sort((a, b) => moment(b.createdAt).valueOf() - moment(a.createdAt).valueOf());
    return out;
  }, [orders]);

  const onClickNote = (note) => {
    // Mark this specific note as dismissed so it disappears next render
    const dismissed = readDismissedSet();
    dismissed.add(note.key);
    writeDismissedSet(dismissed);

    // Navigate to the WO and ask detail page to focus/highlight latest note
    navigate(`/view-work-order/${note.orderId}`, {
      state: { highlightLatestNote: true },
    });
  };

  const clearAllWeeklyNotes = () => {
    const dismissed = readDismissedSet();
    for (const n of weeklyNotes) dismissed.add(n.key);
    writeDismissedSet(dismissed);
    // Force a rerender by touching state; simplest is refetch
    fetchOrders();
  };

  return (
    <div className="home-container">
      <h2 className="home-title">Welcome to the CRM Dashboard</h2>

      {/* ===== Notes (This Week) Notification Area ===== */}
      <div className="section-card" style={{ marginBottom: 16 }}>
        <div
          className="section-title"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
        >
          <span>Notes (This Week)</span>
          {weeklyNotes.length > 0 ? (
            <button
              className="btn btn-ghost"
              onClick={clearAllWeeklyNotes}
              style={{ fontSize: 12 }}
              title="Hide all notes from this list"
            >
              Mark All Read
            </button>
          ) : null}
        </div>

        {weeklyNotes.length > 0 ? (
          <div className="notes-list">
            {weeklyNotes.map((n) => (
              <div
                key={n.key}
                className="note-item"
                onClick={() => onClickNote(n)}
                title="Open work order"
                style={{
                  padding: "10px 12px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  marginBottom: 8,
                  cursor: "pointer",
                  background: "#f8fafc",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <strong style={{ color: "#0f172a" }}>
                    WO: {n.workOrderNumber || n.orderId}
                  </strong>
                  <span style={{ color: "#64748b" }}>• {n.customer}</span>
                  <span style={{ color: "#94a3b8" }}>• {n.siteLocation}</span>
                  <span style={{ marginLeft: "auto", color: "#64748b", fontSize: 12 }}>
                    {moment(n.createdAt).fromNow()} {n.by ? `• ${n.by}` : ""}
                  </span>
                </div>
                <div
                  style={{
                    color: "#334155",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "normal",
                  }}
                >
                  {n.text}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-text">No new notes from the past 7 days.</p>
        )}
      </div>

      {/* ===== Agenda for Today ===== */}
      <div className="section-card">
        <h3 className="section-title">Agenda for Today&nbsp;({todayStr})</h3>
        {agendaOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>Work Order #</th>
                <th>Customer</th>
                <th>Site Location</th>
                <th>Problem Description</th>
                <th>Scheduled Time</th>
              </tr>
            </thead>
            <tbody>
              {agendaOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/view-work-order/${o.id}`)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{woCell(o)}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>{fmtDateTime(o.scheduledDate)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-text">No work orders scheduled for today.</p>
        )}
      </div>

      {/* ===== Upcoming Work Orders ===== */}
      <div className="section-card">
        <h3 className="section-title">Upcoming Work Orders</h3>
        {upcomingOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>Work Order #</th>
                <th>Customer</th>
                <th>Site Location</th>
                <th>Problem Description</th>
                <th>Scheduled Date</th>
              </tr>
            </thead>
            <tbody>
              {upcomingOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/view-work-order/${o.id}`)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{woCell(o)}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>{fmtDateTime(o.scheduledDate)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-text">No upcoming work orders.</p>
        )}
      </div>

      {/* ===== Work Orders Waiting for Approval ===== */}
      <div className="section-card">
        <h3 className="section-title">Work Orders Waiting for Approval</h3>
        {waitingForApprovalOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>Work Order #</th>
                <th>Customer</th>
                <th>Site Location</th>
                <th>Problem Description</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {waitingForApprovalOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/view-work-order/${o.id}`)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{woCell(o)}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>{o.status}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-text">No work orders waiting for approval.</p>
        )}
      </div>
    </div>
  );
}
