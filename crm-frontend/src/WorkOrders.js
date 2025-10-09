// File: src/WorkOrders.js
import React, { useEffect, useMemo, useState } from "react";
import api from "./api";
import { Link, useNavigate } from "react-router-dom";
import moment from "moment";
import { jwtDecode } from "jwt-decode";
import "./WorkOrders.css";

/**
 * Updated status list (order = how chips render L→R):
 * New → Needs to be Quoted → Needs to be Scheduled → Scheduled → Waiting for Approval → Waiting on Parts → Parts In → Needs to be Invoiced → Completed
 */
const STATUS_LIST = [
  "New",
  "Needs to be Quoted",
  "Needs to be Scheduled",
  "Scheduled",
  "Waiting for Approval",
  "Waiting on Parts",
  "Parts In",
  "Needs to be Invoiced", // moved before Completed
  "Completed",
];

const PARTS_WAITING = "Waiting on Parts";
const PARTS_IN = "Parts In";

// ---------- helpers ----------
const norm = (v) => (v ?? "").toString().trim();

const statusKey = (s) =>
  norm(s)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normStatus = statusKey;

// Canonical map for status normalization -> display label
const CANON = new Map(STATUS_LIST.map((label) => [statusKey(label), label]));

// Variants/typos -> canonical
const STATUS_SYNONYMS = new Map([
  ["new", "New"],
  ["needs to be quoted", "Needs to be Quoted"],
  ["need to be quoted", "Needs to be Quoted"],
  ["needs quote", "Needs to be Quoted"],
  ["needs a quote", "Needs to be Quoted"],
  ["quote needed", "Needs to be Quoted"],
  ["needs quoting", "Needs to be Quoted"],
  ["needs-to-be-quoted", "Needs to be Quoted"],
  ["needs_to_be_quoted", "Needs to be Quoted"],
  ["needs to be schedule", "Needs to be Scheduled"],
  ["need to be scheduled", "Needs to be Scheduled"],
  ["waiting on part", "Waiting on Parts"],
  ["waiting on parts", "Waiting on Parts"],
  ["waiting-on-parts", "Waiting on Parts"],
  ["waiting_on_parts", "Waiting on Parts"],
  ["waitingonparts", "Waiting on Parts"],
  ["part in", "Parts In"],
  ["parts in", "Parts In"],
  ["parts  in", "Parts In"],
  ["parts-in", "Parts In"],
  ["parts_in", "Parts In"],
  ["partsin", "Parts In"],
  ["part s in", "Parts In"],
  ["needs to be invoiced", "Needs to be Invoiced"],
  ["need to be invoiced", "Needs to be Invoiced"],
  ["needs invoiced", "Needs to be Invoiced"],
  ["needs-invoiced", "Needs to be Invoiced"],
  ["needs_invoiced", "Needs to be Invoiced"],
]);

const toCanonicalStatus = (s) =>
  CANON.get(statusKey(s)) || STATUS_SYNONYMS.get(statusKey(s)) || norm(s);

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

const parseNotes = (notes) => {
  if (!notes) return [];
  if (Array.isArray(notes)) return notes;
  try {
    const arr = JSON.parse(notes);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};
const latestNoteOf = (order) => {
  const arr = parseNotes(order?.notes);
  return arr.length ? arr[arr.length - 1] : null;
};

export default function WorkOrders() {
  const navigate = useNavigate();

  const token = localStorage.getItem("jwt");
  let userRole = null;
  if (token) {
    try {
      userRole = jwtDecode(token).role;
    } catch {
      console.warn("Invalid JWT");
    }
  }

  const [workOrders, setWorkOrders] = useState([]);
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState("All");
  const [techUsers, setTechUsers] = useState([]);
  const [isPartsModalOpen, setIsPartsModalOpen] = useState(false);
  const [poSearch, setPoSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isUpdatingParts, setIsUpdatingParts] = useState(false);
  const [flashMsg, setFlashMsg] = useState("");

  useEffect(() => {
    fetchWorkOrders();
    if (userRole !== "tech") {
      api
        .get("/users", { params: { assignees: 1 }, headers: authHeaders() })
        .then((r) => setTechUsers(r.data || []))
        .catch((err) => console.error("Error fetching assignable users:", err));
    }
  }, []);

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

  useEffect(() => {
    const todayStr = moment().format("YYYY-MM-DD");
    let rows = workOrders;
    if (selectedFilter === "Today") {
      rows = workOrders.filter(
        (o) =>
          o.scheduledDate &&
          moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      );
    } else if (selectedFilter !== "All") {
      const f = normStatus(selectedFilter);
      rows = workOrders.filter((o) => normStatus(o.status) === f);
    }
    setFilteredOrders(rows);
  }, [workOrders, selectedFilter]);

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
    return { All: workOrders.length, Today: today, ...buckets };
  }, [workOrders]);

  const setFilter = (v) => setSelectedFilter(v);

  const handleStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = toCanonicalStatus(e.target.value);
    const prev = workOrders;
    const next = prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o));
    setWorkOrders(next);
    try {
      await api.put(`/work-orders/${id}`, { status: newStatus }, { headers: authHeaders() });
      await fetchWorkOrders();
    } catch (err) {
      console.error("Error updating status:", err);
      setWorkOrders(prev);
      alert(
        err?.response?.data?.error ||
          (err?.response?.status === 401
            ? "Missing or invalid token."
            : "Failed to update status.")
      );
    }
  };

  const assignToTech = (orderId, techId, e) => {
    e.stopPropagation();
    api
      .put(
        `/work-orders/${orderId}/assign`,
        { assignedTo: techId },
        { headers: authHeaders() }
      )
      .then(fetchWorkOrders)
      .catch((err) => console.error("Error assigning tech:", err));
  };

  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  const handleLocationClick = (e, loc) => {
    e.stopPropagation();
    const url = `https://www.google.com/maps/embed/v1/place?key=${googleMapsApiKey}&q=${encodeURIComponent(
      loc
    )}`;
    window.open(url, "_blank", "width=800,height=600");
  };

  const openPartsModal = () => {
    if (normStatus(selectedFilter) !== normStatus(PARTS_WAITING)) {
      setSelectedFilter(PARTS_WAITING);
    }
    const src = workOrders.filter(
      (o) => normStatus(o.status) === normStatus(PARTS_WAITING)
    );
    setSelectedIds(new Set(src.map((o) => o.id)));
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

  const setAll = (checked, visibleRows) =>
    setSelectedIds(checked ? new Set(visibleRows.map((o) => o.id)) : new Set());

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
      return wo.includes(q) || po.includes(q) || cust.includes(q) || site.includes(q);
    });
  }, [filteredOrders, poSearch]);

  const markSelectedAsPartsIn = async () => {
    if (!selectedIds.size) return;
    setIsUpdatingParts(true);
    const ids = Array.from(selectedIds);
    const prev = workOrders;
    const next = prev.map((o) =>
      ids.includes(o.id) ? { ...o, status: PARTS_IN } : o
    );
    setWorkOrders(next);
    try {
      await api.put(
        "/work-orders/bulk-status",
        { ids, status: PARTS_IN },
        { headers: authHeaders() }
      );
      await fetchWorkOrders();
      setSelectedFilter(PARTS_IN);
      closePartsModal();
      const count = ids.length;
      setFlashMsg(`Moved ${count} work order${count === 1 ? "" : "s"} to “${PARTS_IN}”.`);
      setTimeout(() => setFlashMsg(""), 3000);
    } catch (err) {
      console.error("Bulk update failed:", err);
      setWorkOrders(prev);
      alert(
        err?.response?.data?.error ||
          (err?.response?.status === 401
            ? "Missing or invalid token."
            : "Failed to mark selected as Parts In.")
      );
    } finally {
      setIsUpdatingParts(false);
    }
  };

  return (
    <div className="home-container">
      {flashMsg && <div className="flash-banner">{flashMsg}</div>}

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
          <div className="chips-row" role="tablist" aria-label="Work order filters">
            {[
              { key: "All", label: "All", count: chipCounts.All },
              { key: "Today", label: "Today", count: chipCounts.Today },
              ...STATUS_LIST.map((s) => ({ key: s, label: s, count: chipCounts[s] })),
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
            filteredOrders.some((o) => normStatus(o.status) === normStatus(PARTS_WAITING)) && (
              <button type="button" className="btn btn-parts" onClick={openPartsModal}>
                Mark Parts In
              </button>
            )}
        </div>

        <table className="styled-table">
          <thead>
            <tr>
              <th>WO / PO</th>
              <th>Customer</th>
              <th>Billing Address</th>
              <th>Site Location</th>
              <th>Problem Description</th>
              <th>Status</th>
              {userRole !== "tech" && <th>Assigned To</th>}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map((order) => {
              const note = latestNoteOf(order);
              const noteTime = note?.createdAt ? moment(note.createdAt).fromNow() : null;

              return (
                <tr
                  key={order.id}
                  onClick={() => navigate(`/view-work-order/${order.id}`)}
                >
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div>
                        <strong>WO:</strong> {order.workOrderNumber || "—"}
                      </div>
                      {displayPO(order.workOrderNumber, order.poNumber) && (
                        <div>
                          <strong>PO:</strong> {displayPO(order.workOrderNumber, order.poNumber)}
                        </div>
                      )}
                    </div>
                  </td>

                  <td>{order.customer || "N/A"}</td>
                  <td title={order.billingAddress}>{order.billingAddress}</td>
                  <td>
                    <span
                      className="link-text"
                      onClick={(e) => handleLocationClick(e, order.siteLocation)}
                    >
                      {order.siteLocation}
                    </span>
                  </td>

                  <td title={order.problemDescription}>
                    <div style={clampStyle(4)}>{order.problemDescription}</div>
                    {note && (
                      <div
                        className="latest-note"
                        title={`${note.text}${noteTime ? ` • ${noteTime}` : ""}`}
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
                        <span role="img" aria-label="note">📝</span> {note.text}
                        {noteTime ? ` • ${noteTime}` : ""}
                      </div>
                    )}
                  </td>

                  <td>
                    <select
                      className="form-select"
                      value={toCanonicalStatus(order.status)}
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
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => assignToTech(order.id, e.target.value, e)}
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

                  <td>
                    <Link
                      to={`/edit-work-order/${order.id}`}
                      className="btn btn-warning btn-sm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              );
            })}

            {filteredOrders.length === 0 && (
              <tr>
                <td colSpan={userRole !== "tech" ? 8 : 7}>
                  <div className="empty-state">No work orders for this filter.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
