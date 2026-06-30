// File: src/WorkOrders.js
import React, { useEffect, useMemo, useState } from "react";
import api from "./api";
import { Link, useNavigate } from "react-router-dom";
import moment from "moment";
import { jwtDecode } from "jwt-decode";
import "./WorkOrders.css";

/**
 * STATUS LIST (display & dropdown order; "Parts In" removed)
 * Chip bar normally renders: Today + STATUS_LIST in this exact order.
 */
const STATUS_LIST = [
  "New",
  "Scheduled",
  "Needs to be Quoted",
  "Waiting for Approval",
  "Declined",
  "Approved",
  "Waiting on Parts",
  "Needs to be Scheduled",
  "Needs to be Invoiced",
  "Invoiced Waiting for Payment",
  "Completed",
];

// ---------- helpers ----------
const norm = (v) => (v ?? "").toString().trim();
const statusKey = (s) =>
  norm(s).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const normStatus = statusKey;

// Canonical status map (only statuses we keep)
const CANON = new Map(STATUS_LIST.map((label) => [statusKey(label), label]));

// Map variants/legacy values -> canonical
const STATUS_SYNONYMS = new Map([
  ["new", "New"],

  ["needs quote", "Needs to be Quoted"],
  ["needs to be quoted", "Needs to be Quoted"],

  ["need to be scheduled", "Needs to be Scheduled"],
  ["needs to be schedule", "Needs to be Scheduled"],

  ["waiting for approval", "Waiting for Approval"],
  ["waiting-on-approval", "Waiting for Approval"],
  ["waiting_on_approval", "Waiting for Approval"],
  ["waiting on approval", "Waiting for Approval"],

  ["approved", "Approved"],

  ["declined", "Declined"],

  ["waiting on parts", "Waiting on Parts"],
  ["waiting-on-parts", "Waiting on Parts"],
  ["waiting_on_parts", "Waiting on Parts"],
  ["waitingonparts", "Waiting on Parts"],

  ["needs to be invoiced", "Needs to be Invoiced"],
  ["needs invoiced", "Needs to be Invoiced"],

  ["invoiced waiting for payment", "Invoiced Waiting for Payment"],
  ["invoiced-waiting-for-payment", "Invoiced Waiting for Payment"],
  ["invoiced_waiting_for_payment", "Invoiced Waiting for Payment"],
  ["invoiced waiting payment", "Invoiced Waiting for Payment"],
  ["waiting for payment", "Invoiced Waiting for Payment"],
  ["waiting on payment", "Invoiced Waiting for Payment"],
  ["awaiting payment", "Invoiced Waiting for Payment"],

  // Legacy: map any "Parts In" variants to "Needs to be Scheduled"
  ["part in", "Needs to be Scheduled"],
  ["parts in", "Needs to be Scheduled"],
  ["parts  in", "Needs to be Scheduled"],
  ["parts-in", "Needs to be Scheduled"],
  ["parts_in", "Needs to be Scheduled"],
  ["partsin", "Needs to be Scheduled"],
  ["part s in", "Needs to be Scheduled"],
]);

const toCanonicalStatus = (s) =>
  CANON.get(statusKey(s)) || STATUS_SYNONYMS.get(statusKey(s)) || norm(s);

// Per-status accent colors (used for chips/badges that need to stand out).
// Statuses not in this map fall back to default chip styling.
const STATUS_COLOR = {
  "Invoiced Waiting for Payment": "#f59e0b",
};

// Hide legacy PO values that equal WO
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

const authHeaders = () => {
  const token = localStorage.getItem("jwt");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const clampStyle = (lines) => ({
  display: "-webkit-box",
  WebkitLineClamp: lines,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "normal",
});

/* -------------------------------------------------------------------------- */
/* Notes helpers — tolerant of server TEXT format like:
   "[2025-11-05 19:06:12.555] Mark: test note from curl"
   and also supports JSON-array notes if present.                             */
/* -------------------------------------------------------------------------- */
function parseLatestNote(notes) {
  if (!notes) return null;

  // If array (newer UIs), get last
  if (Array.isArray(notes) && notes.length) {
    const last = notes[notes.length - 1];
    return {
      text: String(last?.text ?? "").trim(),
      createdAt: last?.createdAt || last?.time || null,
      author: last?.author || last?.user || null,
    };
  }

  // If JSON stringified array
  const s = String(notes);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.length) {
      const last = arr[arr.length - 1];
      return {
        text: String(last?.text ?? "").trim(),
        createdAt: last?.createdAt || last?.time || null,
        author: last?.author || last?.user || null,
      };
    }
  } catch {
    // Plain text fallback
  }

  // Plain text (server appends new lines). Find the last bracketed entry.
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const lastBracket =
    [...lines].reverse().find((l) => /^\[[^\]]+\]\s*/.test(l)) ||
    lines[lines.length - 1];

  const m = lastBracket.match(/^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/);
  if (m) {
    return { createdAt: m[1], author: m[2], text: m[3] };
  }
  return { text: lastBracket, createdAt: null, author: null };
}

export default function WorkOrders() {
  const navigate = useNavigate();

  // role + username from token
  const token = localStorage.getItem("jwt");
  let userRole = null;
  let username = null;
  if (token) {
    try {
      const decoded = jwtDecode(token);
      userRole = decoded.role;
      username = decoded.username || decoded.user || null;
    } catch {
      console.warn("Invalid JWT");
    }
  }

  // 🔒 Special restriction for user "jeffsr"
  const isJeffSr = username && username.toLowerCase() === "jeffsr";

  // For jeffsr, only show these status tabs; everyone else gets the full list.
  const visibleStatusList = isJeffSr
    ? ["Scheduled", "Needs to be Scheduled", "Needs to be Quoted", "Needs to be Invoiced", "Invoiced Waiting for Payment"]
    : STATUS_LIST;

  // state
  const [workOrders, setWorkOrders] = useState([]);
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState("Today"); // default to Today
  const [techUsers, setTechUsers] = useState([]);

  // UX
  const [flashMsg, setFlashMsg] = useState("");

  // Follow-Up tab state
  const [followup, setFollowup] = useState([]);
  const [followupLoading, setFollowupLoading] = useState(false);
  // Log Call modal: { wo } when open, null when closed
  const [callModalWO, setCallModalWO] = useState(null);
  const [callHistory, setCallHistory] = useState([]);
  const [callOutcome, setCallOutcome] = useState("Left Voicemail");
  const [callNotes, setCallNotes] = useState("");
  const [callSaving, setCallSaving] = useState(false);

  const CALL_OUTCOMES = [
    "Left Voicemail",
    "Spoke - Considering",
    "Spoke - Approved",
    "Spoke - Declined",
    "No Answer",
    "Wrong Number",
    "Other",
  ];

  const fetchFollowup = async () => {
    setFollowupLoading(true);
    try {
      const res = await api.get("/work-orders/followup", { headers: authHeaders() });
      setFollowup(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching follow-up list:", err);
      setFollowup([]);
    } finally {
      setFollowupLoading(false);
    }
  };

  // NOTE: return the promise so `await fetchWorkOrders()` actually waits.
  const fetchWorkOrders = async () => {
    try {
      const res = await api.get("/work-orders", { headers: authHeaders() });
      const data = Array.isArray(res.data) ? res.data : [];
      const canon = data.map((o) => ({
        ...o,
        status: toCanonicalStatus(o.status),
      }));
      setWorkOrders(canon);
      return canon;
    } catch (err) {
      console.error("Error fetching work orders:", err);
      return [];
    }
  };

  // load data
  useEffect(() => {
    fetchWorkOrders();
    // Fetch the Follow-Up list on mount so its tab badge shows the correct count
    // immediately (it comes from a separate filtered endpoint, not the generic
    // work-orders list, so the count can't be derived client-side like the others).
    fetchFollowup();
    if (userRole !== "tech") {
      api
        .get("/users", { params: { assignees: 1 }, headers: authHeaders() })
        .then((r) => setTechUsers(Array.isArray(r.data) ? r.data : []))
        .catch((err) => console.error("Error fetching assignable users:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the follow-up list whenever its tab becomes active
  useEffect(() => {
    if (selectedFilter === "Follow-Up") fetchFollowup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilter]);

  const isPastDue = (o) =>
    toCanonicalStatus(o.status) === "Scheduled" &&
    o.scheduledDate &&
    moment(o.scheduledDate).isBefore(moment().startOf("day"));

  // filtering
  useEffect(() => {
    const todayStr = moment().format("YYYY-MM-DD");

    let rows = workOrders;
    if (selectedFilter === "Today") {
      rows = workOrders.filter(
        (o) =>
          o.scheduledDate &&
          moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      );
    } else if (selectedFilter === "Past Due") {
      rows = workOrders.filter(isPastDue);
    } else {
      const f = normStatus(selectedFilter);
      rows = workOrders.filter((o) => normStatus(o.status) === f);
    }

    setFilteredOrders(rows);
  }, [workOrders, selectedFilter]);

  // counts
  const chipCounts = useMemo(() => {
    const buckets = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]));
    let today = 0;
    let pastDue = 0;
    const todayStr = moment().format("YYYY-MM-DD");
    for (const o of workOrders) {
      const label = toCanonicalStatus(o.status);
      if (label in buckets) buckets[label] += 1;
      if (
        o.scheduledDate &&
        moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      ) {
        today++;
      }
      if (isPastDue(o)) pastDue++;
    }
    return {
      Today: today,
      "Past Due": pastDue,
      ...buckets,
    };
  }, [workOrders]);

  const setFilter = (value) => setSelectedFilter(value);

  /* ------------------------------------------------------------------------ */
  /* FOLLOW-UP: Log Call modal                                                */
  /* ------------------------------------------------------------------------ */
  const openCallModal = async (wo) => {
    setCallModalWO(wo);
    setCallOutcome("Left Voicemail");
    setCallNotes("");
    setCallHistory([]);
    try {
      const res = await api.get(`/work-orders/${wo.id}/followup-calls`, { headers: authHeaders() });
      setCallHistory(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching call history:", err);
    }
  };

  const closeCallModal = () => {
    setCallModalWO(null);
    setCallHistory([]);
    setCallNotes("");
  };

  const saveCall = async () => {
    if (!callModalWO || !callOutcome) return;
    setCallSaving(true);
    try {
      await api.post(
        `/work-orders/${callModalWO.id}/followup-calls`,
        { outcome: callOutcome, notes: callNotes },
        { headers: authHeaders() }
      );
      await fetchFollowup(); // refresh row last-call info
      closeCallModal();
    } catch (err) {
      console.error("Error logging call:", err);
      alert(err?.response?.data?.error || "Failed to log call.");
    } finally {
      setCallSaving(false);
    }
  };

  // Quick shortcut from the modal: set WO status, then refresh the list
  const setWoStatusFromModal = async (id, newStatus) => {
    try {
      await api.put(`/work-orders/${id}/status`, { status: newStatus }, { headers: authHeaders() });
      await fetchFollowup();
      await fetchWorkOrders();
      closeCallModal();
      if (newStatus === "Approved") {
        // Estimate-approval flow lives on the WO detail page — jump there
        navigate(`/view-work-order/${id}`, { state: { from: "/work-orders" } });
      }
    } catch (err) {
      console.error("Error updating status from modal:", err);
      alert(err?.response?.data?.error || "Failed to update status.");
    }
  };

  // Days-waiting badge color: green <7, amber 7-14, red >14
  const daysBadgeColor = (d) => {
    if (d == null) return "#6b7280";
    if (d > 14) return "#dc2626";
    if (d >= 7) return "#f59e0b";
    return "#22c55e";
  };

  /* ------------------------------------------------------------------------ */
  /* SINGLE-ROW STATUS CHANGE  (PUT /work-orders/:id/status)                  */
  /* ------------------------------------------------------------------------ */
  const handleStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = toCanonicalStatus(e.target.value);

    const prev = workOrders;
    const next = prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o));
    setWorkOrders(next);

    try {
      await api.put(
        `/work-orders/${id}/status`,
        { status: newStatus },
        { headers: authHeaders() }
      );
      await fetchWorkOrders();
    } catch (err) {
      console.error("Error updating status:", err);
      setWorkOrders(prev);
      const msg =
        err?.response?.data?.error ||
        (err?.response?.status === 401
          ? "Missing or invalid token."
          : "Failed to update status.");
      alert(msg);
    }
  };

  // Set primary tech via the multi-tech endpoint (replaces full tech list).
  // The endpoint also writes work_orders.assignedTo so older code paths keep working.
  const assignToTech = async (orderId, techId, e) => {
    e.stopPropagation();
    try {
      const userIds = techId ? [Number(techId)] : [];
      await setRowTechs(orderId, userIds);
    } catch (err) {
      console.error("Error assigning tech:", err);
      alert(err?.response?.data?.error || "Failed to assign technician.");
    }
  };

  // Replace the full tech list for one row. Optimistic local update + refetch.
  const setRowTechs = async (orderId, userIds) => {
    const ids = Array.from(new Set((userIds || []).map(Number).filter(Boolean)));
    const names = ids
      .map((id) => techUsers.find((t) => Number(t.id) === id)?.username || "")
      .filter(Boolean);
    setWorkOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? {
              ...o,
              assignedTo: ids[0] ?? null,
              assignedToName: names[0] ?? "",
              techIds: ids,
              techNames: names,
            }
          : o
      )
    );
    try {
      await api.put(
        `/work-orders/${orderId}/techs`,
        { userIds: ids },
        { headers: { "Content-Type": "application/json", ...authHeaders() } }
      );
      await fetchWorkOrders();
    } catch (err) {
      console.error("Error setting techs:", err);
      alert(err?.response?.data?.error || "Failed to update techs.");
      await fetchWorkOrders();
    }
  };

  // maps
  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  const openAddressInMaps = (e, addr, fallbackLabel) => {
    e.stopPropagation();
    const query = addr || fallbackLabel || "";
    if (!query) return;
    const url = `https://www.google.com/maps/embed/v1/place?key=${googleMapsApiKey}&q=${encodeURIComponent(
      query
    )}`;
    window.open(url, "_blank", "width=900,height=650");
  };

  return (
    <div className="work-orders-page">
      <div className="work-orders-container">
      {flashMsg ? <div className="flash-banner">{flashMsg}</div> : null}

      <div className="work-orders-header">
        <div>
          <h2 className="work-orders-title">Work Orders</h2>
          <div className="work-orders-subtitle">
            Filter by <span className="pill subtle">Today</span> or by status tabs.
          </div>
        </div>

        <div className="work-orders-actions">
          <Link
            to="/add-work-order"
            className="btn-primary-apple"
            onClick={(e) => e.stopPropagation()}
          >
            + Add New Work Order
          </Link>
        </div>
      </div>

      <div className="section-card">
        <div className="chips-toolbar">
          <div className="chips-row" role="tablist" aria-label="Work order filters">
            {[
              { key: "Today", label: "Today", count: chipCounts.Today },
              ...visibleStatusList.map((s) => ({
                key: s,
                label: s,
                count: chipCounts[s],
              })),
            ].map(({ key, label, count }) => {
              const active = selectedFilter === key;
              const accent = STATUS_COLOR[key];
              const accentStyle = accent
                ? {
                    background: active ? accent : "transparent",
                    border: `2px solid ${accent}`,
                    color: active ? "#fff" : accent,
                    borderRadius: 20,
                    padding: "4px 14px",
                    cursor: "pointer",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }
                : undefined;
              return (
                <button
                  key={key}
                  type="button"
                  className={accent ? "" : `chip ${active ? "active" : ""}`}
                  style={accentStyle}
                  onClick={() => setFilter(key)}
                >
                  <span className="chip-label">{label}</span>
                  <span
                    className={accent ? "" : "chip-count"}
                    style={
                      accent
                        ? {
                            background: active ? "#fff" : accent,
                            color: active ? accent : "#fff",
                            borderRadius: 10,
                            padding: "1px 8px",
                            fontSize: 12,
                            fontWeight: 700,
                          }
                        : undefined
                    }
                  >
                    {count ?? 0}
                  </span>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setFilter("Past Due")}
              style={{
                background: selectedFilter === "Past Due" ? "#dc2626" : "transparent",
                border: "2px solid #dc2626",
                color: selectedFilter === "Past Due" ? "#fff" : "#dc2626",
                borderRadius: 20,
                padding: "4px 14px",
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Past Due
              <span
                style={{
                  background: selectedFilter === "Past Due" ? "#fff" : "#dc2626",
                  color: selectedFilter === "Past Due" ? "#dc2626" : "#fff",
                  borderRadius: 10,
                  padding: "1px 8px",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {chipCounts["Past Due"] ?? 0}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setFilter("Follow-Up")}
              style={{
                background: selectedFilter === "Follow-Up" ? "#7c3aed" : "transparent",
                border: "2px solid #7c3aed",
                color: selectedFilter === "Follow-Up" ? "#fff" : "#7c3aed",
                borderRadius: 20,
                padding: "4px 14px",
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Follow-Up
              <span
                style={{
                  background: selectedFilter === "Follow-Up" ? "#fff" : "#7c3aed",
                  color: selectedFilter === "Follow-Up" ? "#7c3aed" : "#fff",
                  borderRadius: 10,
                  padding: "1px 8px",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {followup.length}
              </span>
            </button>
          </div>

          {/* ✅ Removed: “Mark Parts In” button + modal feature */}
        </div>

        {selectedFilter === "Follow-Up" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
            {followupLoading && (
              <div className="empty-state">Loading follow-up list…</div>
            )}
            {!followupLoading && followup.length === 0 && (
              <div className="empty-state">
                No direct-customer work orders are waiting for approval. 🎉
              </div>
            )}
            {!followupLoading && followup.map((wo) => {
              const phone = wo.phone;
              const days = wo.daysSinceSent;
              const badgeBg = daysBadgeColor(days);
              const lastTxt = wo.callCount > 0
                ? `${wo.lastOutcome || "Logged"}${wo.lastCalledAt ? ` • ${moment(wo.lastCalledAt).fromNow()}` : ""}`
                : "Never contacted";
              return (
                <div
                  key={wo.id}
                  style={{
                    border: "1px solid var(--border-color, #e5e7eb)",
                    borderRadius: 12,
                    padding: 16,
                    display: "flex",
                    gap: 16,
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    background: "var(--bg-card, #fff)",
                  }}
                >
                  <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
                        {wo.customer || "N/A"}
                      </span>
                      <span
                        style={{
                          background: badgeBg,
                          color: "#fff",
                          borderRadius: 999,
                          padding: "2px 10px",
                          fontSize: 12,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        }}
                        title={wo.estimateSentAt ? `Estimate sent ${moment(wo.estimateSentAt).format("MMM D, YYYY")}` : "No estimate-sent date"}
                      >
                        {days == null ? "—" : `${days} day${days === 1 ? "" : "s"} waiting`}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
                      {wo.siteLocation || "—"}
                      {wo.siteAddress ? ` • ${wo.siteAddress}` : ""}
                    </div>
                    {wo.problemDescription ? (
                      <div style={{ ...clampStyle(2), fontSize: 13, color: "var(--text-primary)", marginTop: 6 }}>
                        {wo.problemDescription}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      {phone ? (
                        <a
                          href={`tel:${phone}`}
                          style={{ fontSize: 16, fontWeight: 700, color: "#2563eb", textDecoration: "none" }}
                        >
                          📞 {phone}
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>No phone on file</span>
                      )}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                      Last follow-up: {lastTxt}
                      {wo.callCount > 0 ? ` (${wo.callCount} attempt${wo.callCount === 1 ? "" : "s"})` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn-primary-apple"
                      onClick={() => openCallModal(wo)}
                    >
                      Log Call
                    </button>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => navigate(`/view-work-order/${wo.id}`, { state: { from: "/work-orders" } })}
                    >
                      Open
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {selectedFilter !== "Follow-Up" && (
        <div className="table-wrap">
          <table className="wo-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>WO / PO</th>
                <th style={{ width: 170 }}>Customer</th>
                <th style={{ width: 220 }}>Site Location</th>
                <th>Site Address</th>
                <th style={{ width: 360 }}>Problem Description</th>
                <th style={{ width: 190 }}>Status</th>
                {userRole !== "tech" && <th style={{ width: 190 }}>Assigned To</th>}
              </tr>
            </thead>

            <tbody>
              {filteredOrders.map((order) => {
                const latest = parseLatestNote(order?.notes);
                const noteTime = latest?.createdAt
                  ? moment(latest.createdAt).fromNow()
                  : null;

                // ---- Robust location/address logic ----
                const rawLocField = norm(order.siteLocation); // may be a name (new) OR an address (legacy)
                const explicitName = norm(order.siteName) || norm(order.siteLocationName);
                let siteLocationName = explicitName;

                let siteAddress =
                  norm(order.siteAddress) ||
                  norm(order.serviceAddress) ||
                  norm(order.address);

                if (!siteAddress && rawLocField) {
                  siteAddress = rawLocField;
                } else if (!siteLocationName && rawLocField) {
                  siteLocationName = rawLocField;
                }

                const cleanedPO = order.allPoNumbersFormatted || displayPO(order.workOrderNumber, order.poNumber);

                return (
                  <tr
                    key={order.id}
                    className="wo-row"
                    onClick={() =>
                      navigate(`/view-work-order/${order.id}`, {
                        state: { from: "/work-orders" },
                      })
                    }
                  >
                    <td>
                      <div className="wo-idcell">
                        <div className="wo-idline">
                          <span className="badge">WO</span>
                          <span className="mono">{order.workOrderNumber || "—"}</span>
                        </div>
                        {cleanedPO ? (
                          <div className="wo-idline subtle">
                            <span className="badge badge-subtle">PO</span>
                            <span className="mono">{cleanedPO}</span>
                          </div>
                        ) : null}
                      </div>
                    </td>

                    <td className="cell-strong">{order.customer || "N/A"}</td>

                    <td title={siteLocationName || "—"}>
                      <div style={clampStyle(2)}>{siteLocationName || "—"}</div>
                    </td>

                    <td title={siteAddress || "N/A"}>
                      {siteAddress ? (
                        <button
                          type="button"
                          className="linklike"
                          onClick={(e) => openAddressInMaps(e, siteAddress, siteLocationName)}
                        >
                          {siteAddress}
                        </button>
                      ) : (
                        "N/A"
                      )}
                    </td>

                    <td title={order.problemDescription || ""}>
                      <div style={clampStyle(4)}>{order.problemDescription || "—"}</div>

                      {latest?.text ? (
                        <div
                          className="latest-note"
                          title={`${latest.text}${noteTime ? ` • ${noteTime}` : ""}`}
                        >
                          <span aria-hidden="true">📝</span>{" "}
                          {latest.text}
                          {noteTime ? ` • ${noteTime}` : ""}
                        </div>
                      ) : null}
                    </td>

                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                        <select
                          className="control select"
                          value={toCanonicalStatus(order.status)}
                          onChange={(e) => handleStatusChange(e, order.id)}
                        >
                          {STATUS_LIST.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        {isPastDue(order) && (
                          <span
                            style={{
                              background: "#dc2626",
                              color: "#fff",
                              fontSize: 10,
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: 10,
                              marginLeft: 6,
                              whiteSpace: "nowrap",
                            }}
                          >
                            PAST DUE
                          </span>
                        )}
                      </div>
                    </td>

                    {userRole !== "tech" && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 4,
                            minWidth: 180,
                          }}
                        >
                          {techUsers.map((t) => {
                            const tid = Number(t.id);
                            const current = Array.isArray(order.techIds)
                              ? order.techIds
                              : order.assignedTo
                              ? [Number(order.assignedTo)]
                              : [];
                            const isSelected = current.some((x) => Number(x) === tid);
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const next = isSelected
                                    ? current.filter((x) => Number(x) !== tid)
                                    : [...current, tid];
                                  setRowTechs(order.id, next);
                                }}
                                style={{
                                  padding: "4px 8px",
                                  borderRadius: 16,
                                  fontSize: 11,
                                  fontWeight: 500,
                                  border: isSelected ? "2px solid #3b82f6" : "2px solid #4b5563",
                                  background: isSelected ? "#1d4ed8" : "#374151",
                                  color: isSelected ? "#fff" : "#9ca3af",
                                  cursor: "pointer",
                                  textAlign: "center",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {isSelected ? "✓ " : ""}
                                {t.username}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}

              {filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={userRole !== "tech" ? 7 : 6}>
                    <div className="empty-state">No work orders for this filter.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
      </div>

      {/* ───── Log Call modal ───── */}
      {callModalWO && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closeCallModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-card, #fff)",
              borderRadius: 12,
              maxWidth: 560,
              width: "100%",
              maxHeight: "88vh",
              overflowY: "auto",
              padding: 24,
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
              Log Call — {callModalWO.customer}
            </h3>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
              {callModalWO.siteLocation || ""}
              {callModalWO.phone ? (
                <>
                  {" • "}
                  <a href={`tel:${callModalWO.phone}`} style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}>
                    {callModalWO.phone}
                  </a>
                </>
              ) : null}
            </div>

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>
              Outcome
            </label>
            <select
              className="control select"
              value={callOutcome}
              onChange={(e) => setCallOutcome(e.target.value)}
              style={{ width: "100%", marginBottom: 12 }}
            >
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>
              Notes
            </label>
            <textarea
              value={callNotes}
              onChange={(e) => setCallNotes(e.target.value)}
              rows={3}
              placeholder="What was said, next steps, callback time…"
              style={{
                width: "100%",
                borderRadius: 8,
                border: "1px solid var(--border-color, #d1d5db)",
                padding: 8,
                fontSize: 14,
                resize: "vertical",
                marginBottom: 8,
              }}
            />

            {/* Quick status shortcuts (offered, not automatic) */}
            {callOutcome === "Spoke - Approved" && (
              <button
                type="button"
                onClick={() => setWoStatusFromModal(callModalWO.id, "Approved")}
                style={{ background: "#22c55e", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 600, cursor: "pointer", marginBottom: 12 }}
              >
                Set WO status → Approved (opens estimate approval)
              </button>
            )}
            {callOutcome === "Spoke - Declined" && (
              <button
                type="button"
                onClick={() => setWoStatusFromModal(callModalWO.id, "Declined")}
                style={{ background: "#6b7280", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 600, cursor: "pointer", marginBottom: 12 }}
              >
                Set WO status → Declined
              </button>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginBottom: 18 }}>
              <button type="button" className="chip" onClick={closeCallModal} disabled={callSaving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary-apple"
                onClick={saveCall}
                disabled={callSaving || !callOutcome}
              >
                {callSaving ? "Saving…" : "Save Call"}
              </button>
            </div>

            <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: "var(--text-primary)" }}>
                Call history ({callHistory.length})
              </div>
              {callHistory.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>No prior attempts logged.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {callHistory.map((c) => (
                    <div key={c.id} style={{ fontSize: 13, borderLeft: "3px solid #7c3aed", paddingLeft: 10 }}>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                        {c.outcome}
                        <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
                          {" — "}{c.calledBy || "Unknown"}{" • "}{c.calledAt ? moment(c.calledAt).format("MMM D, YYYY h:mm A") : ""}
                        </span>
                      </div>
                      {c.notes ? <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>{c.notes}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
