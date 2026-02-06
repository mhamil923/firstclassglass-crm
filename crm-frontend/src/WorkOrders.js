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
  "Approved",
  "Waiting on Parts",
  "Needs to be Scheduled",
  "Needs to be Invoiced",
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

  ["waiting on parts", "Waiting on Parts"],
  ["waiting-on-parts", "Waiting on Parts"],
  ["waiting_on_parts", "Waiting on Parts"],
  ["waitingonparts", "Waiting on Parts"],

  ["needs to be invoiced", "Needs to be Invoiced"],
  ["needs invoiced", "Needs to be Invoiced"],

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
    ? ["Needs to be Quoted", "Needs to be Invoiced"]
    : STATUS_LIST;

  // state
  const [workOrders, setWorkOrders] = useState([]);
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState("Today"); // default to Today
  const [techUsers, setTechUsers] = useState([]);

  // UX
  const [flashMsg, setFlashMsg] = useState("");

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
    if (userRole !== "tech") {
      api
        .get("/users", { params: { assignees: 1 }, headers: authHeaders() })
        .then((r) => setTechUsers(Array.isArray(r.data) ? r.data : []))
        .catch((err) => console.error("Error fetching assignable users:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    }
    return {
      Today: today,
      ...buckets,
    };
  }, [workOrders]);

  const setFilter = (value) => setSelectedFilter(value);

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

  // assign — try `/assign`, fallback to `/edit` (multipart) if needed
  const assignToTech = async (orderId, techId, e) => {
    e.stopPropagation();
    try {
      await api.put(
        `/work-orders/${orderId}/assign`,
        { assignedTo: techId || null },
        { headers: { "Content-Type": "application/json", ...authHeaders() } }
      );
      await fetchWorkOrders();
    } catch (err) {
      try {
        const form = new FormData();
        form.append("assignedTo", techId || "");
        await api.put(`/work-orders/${orderId}/edit`, form, {
          headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
        });
        await fetchWorkOrders();
      } catch (err2) {
        console.error("Error assigning tech:", err2);
        alert(err2?.response?.data?.error || "Failed to assign technician.");
      }
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
              return (
                <button
                  key={key}
                  type="button"
                  className={`chip ${active ? "active" : ""}`}
                  onClick={() => setFilter(key)}
                >
                  <span className="chip-label">{label}</span>
                  <span className="chip-count">{count ?? 0}</span>
                </button>
              );
            })}
          </div>

          {/* ✅ Removed: “Mark Parts In” button + modal feature */}
        </div>

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

                const cleanedPO = displayPO(order.workOrderNumber, order.poNumber);

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
                    </td>

                    {userRole !== "tech" && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          className="control select"
                          value={order.assignedTo ?? ""}
                          onChange={(e) => assignToTech(order.id, e.target.value, e)}
                        >
                          <option value="">Unassigned</option>
                          {techUsers.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.username}
                            </option>
                          ))}
                        </select>
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
      </div>
      </div>
    </div>
  );
}
