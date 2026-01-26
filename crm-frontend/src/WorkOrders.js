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
 * Added "Approved" between "Waiting for Approval" and "Waiting on Parts".
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

const PARTS_WAITING = "Waiting on Parts";
const PARTS_NEXT = "Needs to be Scheduled";

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

  // Waiting for/ on Approval variants -> keep UI wording "Waiting for Approval"
  ["waiting for approval", "Waiting for Approval"],
  ["waiting-on-approval", "Waiting for Approval"],
  ["waiting_on_approval", "Waiting for Approval"],
  ["waiting on approval", "Waiting for Approval"],

  // Approved
  ["approved", "Approved"],

  // Waiting on Parts
  ["waiting on parts", "Waiting on Parts"],
  ["waiting-on-parts", "Waiting on Parts"],
  ["waiting_on_parts", "Waiting on Parts"],
  ["waitingonparts", "Waiting on Parts"],

  ["needs to be invoiced", "Needs to be Invoiced"],
  ["needs invoiced", "Needs to be Invoiced"],

  // Legacy: map any "Parts In" variants to our new target to avoid orphans
  ["part in", PARTS_NEXT],
  ["parts in", PARTS_NEXT],
  ["parts  in", PARTS_NEXT],
  ["parts-in", PARTS_NEXT],
  ["parts_in", PARTS_NEXT],
  ["partsin", PARTS_NEXT],
  ["part s in", PARTS_NEXT],
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
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const lastBracket =
    [...lines].reverse().find((l) => /^\[[^\]]+\]\s*/.test(l)) ||
    lines[lines.length - 1];

  // Try to parse "[timestamp] author: text"
  const m = lastBracket.match(/^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/);
  if (m) {
    return { createdAt: m[1], author: m[2], text: m[3] };
  }
  // Otherwise just show the tail line as text
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

  // parts modal
  const [isPartsModalOpen, setIsPartsModalOpen] = useState(false);
  const [poSearch, setPoSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isUpdatingParts, setIsUpdatingParts] = useState(false);

  // UX
  const [flashMsg, setFlashMsg] = useState("");

  // load data
  useEffect(() => {
    fetchWorkOrders();
    if (userRole !== "tech") {
      api
        .get("/users", { params: { assignees: 1 }, headers: authHeaders() })
        .then((r) => setTechUsers(r.data || []))
        .catch((err) => console.error("Error fetching assignable users:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NOTE: return the promise so `await fetchWorkOrders()` actually waits.
  const fetchWorkOrders = async () => {
    try {
      const res = await api.get("/work-orders", { headers: authHeaders() });
      const data = Array.isArray(res.data) ? res.data : [];
      // normalize status for rendering & filtering
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

  // counts (no “All” anymore)
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
  /* SINGLE-ROW STATUS CHANGE  (FIXED ROUTE -> PUT /work-orders/:id/status)    */
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

  // assign — try `/assign`, fallback to `/edit` if backend lacks /assign endpoint
  const assignToTech = async (orderId, techId, e) => {
    e.stopPropagation();
    try {
      await api.put(
        `/work-orders/${orderId}/assign`,
        { assignedTo: techId },
        { headers: authHeaders() }
      );
      await fetchWorkOrders();
    } catch (err) {
      // fallback path using existing /edit route
      try {
        await api.put(
          `/work-orders/${orderId}/edit`,
          { assignedTo: techId },
          { headers: authHeaders() }
        );
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
    window.open(url, "_blank", "width=800,height=600");
  };

  // Bigger selects to fill the cell
  const bigSelectStyle = {
    width: "100%",
    minWidth: 140,
    padding: "10px 12px",
    fontSize: 15,
    borderRadius: 10,
  };

  // -------- Parts In modal (repurposed to move to Needs to be Scheduled) --------
  const openPartsModal = () => {
    if (normStatus(selectedFilter) !== normStatus(PARTS_WAITING)) {
      setSelectedFilter(PARTS_WAITING);
    }
    const source = workOrders.filter(
      (o) => normStatus(o.status) === normStatus(PARTS_WAITING)
    );
    setSelectedIds(new Set(source.map((o) => o.id)));
    setPoSearch("");
    setIsPartsModalOpen(true);
  };

  const closePartsModal = () => {
    setIsPartsModalOpen(false);
    setSelectedIds(new Set());
    setPoSearch("");
  };

  const toggleId = (id) => {
    const copy = new Set(selectedIds);
    if (copy.has(id)) copy.delete(id);
    else copy.add(id);
    setSelectedIds(copy);
  };

  const setAll = (checked, visibleRows) => {
    setSelectedIds(checked ? new Set(visibleRows.map((o) => o.id)) : new Set());
  };

  const visibleWaitingRows = useMemo(() => {
    const base = filteredOrders.filter(
      (o) => normStatus(o.status) === normStatus(PARTS_WAITING)
    );
    const q = poSearch.trim().toLowerCase();
    if (!q) return base;
    return base.filter((o) => {
      const wo = norm(o.workOrderNumber).toLowerCase();
      const po = displayPO(o.workOrderNumber, o.poNumber).toLowerCase();
      const cust = norm(o.customer).toLowerCase();
      const site = norm(o.siteLocation).toLowerCase();
      return (
        wo.includes(q) ||
        po.includes(q) ||
        cust.includes(q) ||
        site.includes(q)
      );
    });
  }, [filteredOrders, poSearch]);

  /* ------------------------------------------------------------------------ */
  /* BULK -> Needs to be Scheduled  (no /bulk-status: fan out to per-row)     */
  /* ------------------------------------------------------------------------ */
  const markSelectedAsPartsIn = async () => {
    if (!selectedIds.size) return;
    setIsUpdatingParts(true);

    const ids = Array.from(selectedIds);
    const prev = workOrders;

    // Local optimistic update
    const next = prev.map((o) =>
      ids.includes(o.id) ? { ...o, status: PARTS_NEXT } : o
    );
    setWorkOrders(next);

    try {
      // Fan-out to the correct endpoint for each id
      await Promise.all(
        ids.map((id) =>
          api.put(
            `/work-orders/${id}/status`,
            { status: PARTS_NEXT },
            { headers: authHeaders() }
          )
        )
      );

      setSelectedFilter(PARTS_NEXT);
      await fetchWorkOrders();
      closePartsModal();

      const count = ids.length;
      setFlashMsg(
        `Moved ${count} work order${count === 1 ? "" : "s"} to “${PARTS_NEXT}”.`
      );
      window.setTimeout(() => setFlashMsg(""), 3000);
    } catch (err) {
      console.error("Bulk update failed:", err);
      setWorkOrders(prev);
      const status = err?.response?.status;
      const msg =
        err?.response?.data?.error ||
        (status === 401
          ? "Missing or invalid token. Please sign in again."
          : status === 403
          ? "Forbidden: one or more selected items aren’t assigned to you."
          : `Failed to move selected to “${PARTS_NEXT}”.`);
      alert(msg);
    } finally {
      setIsUpdatingParts(false);
    }
  };

  return (
    <div className="home-container">
      {flashMsg ? <div className="flash-banner">{flashMsg}</div> : null}

      <div className="header-row">
        <h2 className="text-primary">Work Orders Dashboard</h2>
        <Link
          to="/add-work-order"
          className="btn btn-primary"
          onClick={(e) => e.stopPropagation()}
        >
          + Add New Work Order
        </Link>
      </div>

      <div className="section-card">
        <div className="chips-toolbar">
          <div
            className="chips-row"
            role="tablist"
            aria-label="Work order filters"
          >
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

          {normStatus(selectedFilter) === normStatus(PARTS_WAITING) &&
            filteredOrders.some(
              (o) => normStatus(o.status) === normStatus(PARTS_WAITING)
            ) && (
              <button
                type="button"
                className="btn btn-parts"
                onClick={openPartsModal}
              >
                Mark Parts In
              </button>
            )}
        </div>

        <table className="styled-table">
          <thead>
            <tr>
              <th>WO / PO</th>
              <th>Customer</th>
              <th>Site Location</th>
              <th>Site Address</th>
              <th>Problem Description</th>
              <th>Status</th>
              {userRole !== "tech" && <th>Assigned To</th>}
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
              const explicitName =
                norm(order.siteName) || norm(order.siteLocationName);
              let siteLocationName = explicitName; // prefer explicit name fields

              // Build address from explicit address-type fields
              let siteAddress =
                norm(order.siteAddress) ||
                norm(order.serviceAddress) ||
                norm(order.address);

              if (!siteAddress && rawLocField) {
                // Legacy: no explicit address, but siteLocation has something
                // -> treat siteLocation as the address, leave name blank.
                siteAddress = rawLocField;
              } else if (!siteLocationName && rawLocField) {
                // Newer: there IS an address (or not), and siteLocation is actually the "name"
                // -> show that name in Site Location.
                siteLocationName = rawLocField;
              }

              return (
                <tr
                  key={order.id}
                  onClick={() => navigate(`/view-work-order/${order.id}`)}
                >
                  <td>
                    <div
                      className="wo-po-cell"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      {order.workOrderNumber ? (
                        <div>
                          <strong>WO:</strong> {order.workOrderNumber}
                        </div>
                      ) : (
                        <div>
                          <strong>WO:</strong> —
                        </div>
                      )}
                      {displayPO(order.workOrderNumber, order.poNumber) ? (
                        <div>
                          <strong>PO:</strong>{" "}
                          {displayPO(order.workOrderNumber, order.poNumber)}
                        </div>
                      ) : null}
                    </div>
                  </td>

                  <td>{order.customer || "N/A"}</td>

                  {/* Site Location (name only) */}
                  <td title={siteLocationName || "—"}>
                    {siteLocationName || "—"}
                  </td>

                  {/* Site Address (clickable; includes legacy fallback) */}
                  <td title={siteAddress || "N/A"}>
                    {siteAddress ? (
                      <span
                        className="link-text"
                        onClick={(e) =>
                          openAddressInMaps(e, siteAddress, siteLocationName)
                        }
                      >
                        {siteAddress}
                      </span>
                    ) : (
                      "N/A"
                    )}
                  </td>

                  <td title={order.problemDescription}>
                    {/* Clamp to 4 lines */}
                    <div style={clampStyle(4)}>{order.problemDescription}</div>
                    {/* Latest note preview (2 lines) */}
                    {latest?.text && (
                      <div
                        className="latest-note"
                        title={`${latest.text}${
                          noteTime ? ` • ${noteTime}` : ""
                        }`}
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color: "#6b7280",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "normal",
                        }}
                      >
                        <span role="img" aria-label="note">
                          📝
                        </span>{" "}
                        {latest.text}
                        {noteTime ? ` • ${noteTime}` : ""}
                      </div>
                    )}
                  </td>

                  <td>
                    <select
                      className="form-select"
                      value={toCanonicalStatus(order.status)}
                      style={bigSelectStyle}
                      onClick={(e) => e.stopPropagation()}
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
                    <td>
                      <select
                        className="form-select"
                        value={order.assignedTo || ""}
                        style={bigSelectStyle}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          assignToTech(order.id, e.target.value, e)
                        }
                      >
                        <option value="">-- assign tech --</option>
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
                  <div className="empty-state">
                    No work orders for this filter.
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---------- Parts Modal (moves to Needs to be Scheduled) ---------- */}
      {isPartsModalOpen && (
        <div
          className="modal-overlay"
          onClick={closePartsModal}
          role="dialog"
          aria-modal="true"
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Mark Parts as Received</h3>
              <button
                className="modal-close"
                onClick={closePartsModal}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="modal-controls">
                <input
                  className="modal-input"
                  type="text"
                  placeholder="Search WO #, PO #, customer, or site…"
                  value={poSearch}
                  onChange={(e) => setPoSearch(e.target.value)}
                />
                <div className="modal-actions-inline">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setAll(true, visibleWaitingRows)}
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setAll(false, visibleWaitingRows)}
                  >
                    Select None
                  </button>
                </div>
              </div>

              <div className="modal-list">
                {visibleWaitingRows.length === 0 ? (
                  <div className="empty-state">
                    No POs in “{PARTS_WAITING}”.
                  </div>
                ) : (
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th style={{ width: 42 }}></th>
                        <th>WO #</th>
                        <th>PO #</th>
                        <th>Customer</th>
                        <th>Site</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleWaitingRows.map((o) => {
                        const checked = selectedIds.has(o.id);
                        return (
                          <tr key={o.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleId(o.id)}
                              />
                            </td>
                            <td>{o.workOrderNumber || "—"}</td>
                            <td>
                              {displayPO(o.workOrderNumber, o.poNumber) || "—"}
                            </td>
                            <td>{o.customer || "—"}</td>
                            <td title={o.siteLocation}>
                              {o.siteLocation || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-parts"
                disabled={isUpdatingParts || selectedIds.size === 0}
                onClick={markSelectedAsPartsIn}
              >
                {isUpdatingParts
                  ? "Updating…"
                  : `Mark Parts In (${selectedIds.size})`}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closePartsModal}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
