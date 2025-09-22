// File: src/WorkOrders.js
import React, { useEffect, useMemo, useState } from "react";
import api from "./api";
import { Link, useNavigate } from "react-router-dom";
import moment from "moment";
import { jwtDecode } from "jwt-decode";
import "./WorkOrders.css";

const STATUS_LIST = [
  "Needs to be Scheduled",
  "Scheduled",
  "Waiting for Approval",
  "Waiting on Parts",
  "Parts In",
  "Completed",
];

const PARTS_WAITING = "Waiting on Parts";
const PARTS_IN = "Parts In";

// Normalize helpers
const norm = (v) => (v ?? "").toString().trim();
const cleanStatus = (s) => norm(s);
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

export default function WorkOrders() {
  const navigate = useNavigate();

  // role
  const token = localStorage.getItem("jwt");
  let userRole = null;
  if (token) {
    try {
      userRole = jwtDecode(token).role;
    } catch {
      console.warn("Invalid JWT");
    }
  }

  // state
  const [workOrders, setWorkOrders] = useState([]);
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState("All");
  const [techUsers, setTechUsers] = useState([]);

  const [isPartsModalOpen, setIsPartsModalOpen] = useState(false);
  const [poSearch, setPoSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isUpdatingParts, setIsUpdatingParts] = useState(false);

  // UX: temporary success banner
  const [flashMsg, setFlashMsg] = useState("");

  // data load
  useEffect(() => {
    fetchWorkOrders();

    if (userRole !== "tech") {
      api
        .get("/users", { params: { assignees: 1 } })
        .then((r) => setTechUsers(r.data || []))
        .catch((err) => console.error("Error fetching assignable users:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchWorkOrders = () => {
    api
      .get("/work-orders")
      .then((res) => {
        const data = Array.isArray(res.data) ? res.data : [];
        setWorkOrders(data);
      })
      .catch((err) => console.error("Error fetching work orders:", err));
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
    } else if (selectedFilter !== "All") {
      rows = workOrders.filter((o) => cleanStatus(o.status) === selectedFilter);
    }

    setFilteredOrders(rows);
  }, [workOrders, selectedFilter]);

  // counts
  const chipCounts = useMemo(() => {
    const counts = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]));
    let today = 0;
    const todayStr = moment().format("YYYY-MM-DD");
    for (const o of workOrders) {
      const st = cleanStatus(o.status);
      if (st && counts[st] !== undefined) counts[st]++;
      if (
        o.scheduledDate &&
        moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      ) {
        today++;
      }
    }
    return {
      All: workOrders.length,
      Today: today,
      ...counts,
    };
  }, [workOrders]);

  const setFilter = (value) => setSelectedFilter(value);

  // single status change
  const handleStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = e.target.value;

    const prev = workOrders;
    const next = prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o));
    setWorkOrders(next);

    try {
      await api.put(`/work-orders/${id}`, { status: newStatus });
      // Refresh for authoritative state + counts
      fetchWorkOrders();
    } catch (err) {
      console.error("Error updating status:", err);
      setWorkOrders(prev);
      alert(err?.response?.data?.error || "Failed to update status.");
    }
  };

  // assign
  const assignToTech = (orderId, techId, e) => {
    e.stopPropagation();
    api
      .put(`/work-orders/${orderId}/assign`, { assignedTo: techId })
      .then(fetchWorkOrders)
      .catch((err) => console.error("Error assigning tech:", err));
  };

  // maps
  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  const handleLocationClick = (e, loc) => {
    e.stopPropagation();
    const url = `https://www.google.com/maps/embed/v1/place?key=${googleMapsApiKey}&q=${encodeURIComponent(
      loc
    )}`;
    window.open(url, "_blank", "width=800,height=600");
  };

  // -------- Parts In modal helpers --------
  const openPartsModal = () => {
    const preselected = new Set(filteredOrders.map((o) => o.id));
    setSelectedIds(preselected);
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
    if (selectedFilter !== PARTS_WAITING) return [];
    const q = poSearch.trim().toLowerCase();
    const rows = filteredOrders;
    if (!q) return rows;
    return rows.filter((o) => {
      const wo = norm(o.workOrderNumber).toLowerCase();
      const po = displayPO(o.workOrderNumber, o.poNumber).toLowerCase();
      const cust = norm(o.customer).toLowerCase();
      const site = norm(o.siteLocation).toLowerCase();
      return wo.includes(q) || po.includes(q) || cust.includes(q) || site.includes(q);
    });
  }, [filteredOrders, selectedFilter, poSearch]);

  // bulk update -> Parts In (single server call)
  const markSelectedAsPartsIn = async () => {
    if (!selectedIds.size) return;
    setIsUpdatingParts(true);

    const ids = Array.from(selectedIds);

    // Optimistic UI
    const prev = workOrders;
    const next = prev.map((o) =>
      ids.includes(o.id) ? { ...o, status: PARTS_IN } : o
    );
    setWorkOrders(next);

    try {
      await api.put(`/work-orders/bulk-status`, { ids, status: PARTS_IN });

      // Close modal, jump user to “Parts In”, and hard-refresh from server
      closePartsModal();
      setSelectedFilter(PARTS_IN);
      await fetchWorkOrders();

      // Flash confirmation
      setFlashMsg(`Moved ${ids.length} work order${ids.length > 1 ? "s" : ""} to “${PARTS_IN}”.`);
      window.setTimeout(() => setFlashMsg(""), 3000);
    } catch (err) {
      console.error("Bulk update failed:", err);
      const msg =
        err?.response?.data?.error ||
        (err?.response?.status === 401 ? "Invalid or expired session. Please log in again." : "Failed to mark selected as Parts In.");
      alert(msg);
      setWorkOrders(prev);
    } finally {
      setIsUpdatingParts(false);
    }
  };

  return (
    <div className="home-container">
      {/* Flash banner */}
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

      {/* Status chip bar */}
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

          {selectedFilter === PARTS_WAITING && filteredOrders.length > 0 && (
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
              <th>Billing Address</th>
              <th>Site Location</th>
              <th>Problem Description</th>
              <th>Status</th>
              {userRole !== "tech" && <th>Assigned To</th>}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map((order) => (
              <tr
                key={order.id}
                onClick={() => navigate(`/view-work-order/${order.id}`)}
              >
                <td>
                  <div
                    className="wo-po-cell"
                    style={{ display: "flex", flexDirection: "column", gap: 2 }}
                  >
                    {order.workOrderNumber ? (
                      <div><strong>WO:</strong> {order.workOrderNumber}</div>
                    ) : (
                      <div><strong>WO:</strong> —</div>
                    )}
                    {displayPO(order.workOrderNumber, order.poNumber) ? (
                      <div><strong>PO:</strong> {displayPO(order.workOrderNumber, order.poNumber)}</div>
                    ) : null}
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
                  {order.problemDescription}
                </td>
                <td>
                  <select
                    className="form-select"
                    value={cleanStatus(order.status) || ""}
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
            ))}
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

      {/* ---------- Parts In Modal ---------- */}
      {isPartsModalOpen && (
        <div className="modal-overlay" onClick={closePartsModal} role="dialog" aria-modal="true">
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Mark Parts as Received</h3>
              <button className="modal-close" onClick={closePartsModal} aria-label="Close">×</button>
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
                  <button type="button" className="btn btn-ghost" onClick={() => setAll(true, visibleWaitingRows)}>
                    Select All
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setAll(false, visibleWaitingRows)}>
                    Select None
                  </button>
                </div>
              </div>

              <div className="modal-list">
                {visibleWaitingRows.length === 0 ? (
                  <div className="empty-state">No POs in “Waiting on Parts”.</div>
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
                            <td>{displayPO(o.workOrderNumber, o.poNumber) || "—"}</td>
                            <td>{o.customer || "—"}</td>
                            <td title={o.siteLocation}>{o.siteLocation || "—"}</td>
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
                {isUpdatingParts ? "Updating…" : `Mark Parts In (${selectedIds.size})`}
              </button>
              <button type="button" className="btn btn-ghost" onClick={closePartsModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
