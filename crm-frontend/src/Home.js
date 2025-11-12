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
  const fetchOrders = useCallback(() => {
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

  /* =========================
     Agenda / Upcoming blocks
  ========================= */
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
    // You can change to m.format("MMM D, YYYY h:mm A") if you prefer
  };

  const woCell = (o) => o?.workOrderNumber || "—";

  /* =========================
     Notes (robust extraction)
  ========================= */

  // 1) Accept arrays, JSON strings, and line-based blobs.
  const parseNotesField = (notesLike) => {
    if (!notesLike) return [];
    if (Array.isArray(notesLike)) return notesLike;

    if (typeof notesLike === "string") {
      // Try JSON first
      try {
        const arr = JSON.parse(notesLike);
        if (Array.isArray(arr)) return arr;
      } catch {
        // Not JSON; treat as plain text blob. Split by blank lines, then lines.
        const lines = notesLike
          .split(/\r?\n\r?\n|\r?\n/g)
          .map((s) => s.trim())
          .filter(Boolean);
        // Convert each line into a note object with best-guess fields
        return lines.map((line) => ({ text: line }));
      }
      return [];
    }

    // Unknown object; try to coerce common shapes to an array
    if (typeof notesLike === "object") {
      // Some backends store as {items:[...]} or {list:[...]}
      if (Array.isArray(notesLike.items)) return notesLike.items;
      if (Array.isArray(notesLike.list)) return notesLike.list;
      if (Array.isArray(notesLike.notes)) return notesLike.notes;
    }

    return [];
  };

  // 2) Try to get a moment() for the note creation time from many shapes
  const extractNoteMoment = (note, order) => {
    // Priority order of fields that might exist
    let raw =
      note?.createdAt ??
      note?.created_at ??
      note?.date ??
      note?.timestamp ??
      note?.time ??
      null;

    // If not provided, try to pull a date-like token from the note text:
    // - ISO-like 2025-11-12 14:03 (with optional seconds)
    // - ISO 2025-11-12T14:03:22Z
    // - US 11/12/2025 2:03 PM (time optional)
    if (raw == null && typeof note?.text === "string") {
      const t = note.text;
      const isoMatch =
        t.match(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?\b/) ||
        t.match(/\b\d{4}-\d{2}-\d{2}\b/);
      const usMatch =
        t.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:[ T]\d{1,2}:\d{2}(?:\s?[AP]M)?)?\b/i);
      raw = (isoMatch && isoMatch[0]) || (usMatch && usMatch[0]) || null;
    }

    // Fallbacks to order-level timestamps if the note lacks one
    if (raw == null) {
      raw = order?.lastNoteAt || order?.updatedAt || order?.createdAt || null;
    }

    if (raw == null) return null;

    // Numbers: assume ms (if too small, it's seconds)
    if (typeof raw === "number") {
      if (raw < 10_000_000_000) raw = raw * 1000; // seconds -> ms
      return moment(raw);
    }

    if (typeof raw === "string") {
      if (moment(raw, moment.ISO_8601, true).isValid()) return moment(raw);
      // Try common formats, then best-effort parse
      const tryFmt = moment(raw, ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD", "M/D/YYYY h:mm A", "M/D/YYYY"], true);
      return tryFmt.isValid() ? tryFmt : moment(raw);
    }

    return null;
  };

  // 3) Merge from multiple potential fields on each order
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

  // Local “read/dismissed” tracking
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

  // Use a more stable key (prevents duplicates when createdAt missing)
  const makeNoteKey = (orderId, createdISO, text) =>
    `${orderId}:${createdISO}:${(text || "").slice(0, 64)}`;

  // 4) Build "This Week" list robustly
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

        // Include notes on/after cutoff (inclusive)
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

    // newest first
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
    // Force a rerender by touching state; simplest is refetch
    fetchOrders();
  };

  /* =========================
     Render
  ========================= */
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
