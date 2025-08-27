// File: src/WorkOrders.js

import React, { useEffect, useMemo, useState } from "react";
import api from "./api";
import { Link, useNavigate } from "react-router-dom";
import moment from "moment";
import { jwtDecode } from "jwt-decode";
import "./WorkOrders.css";

const ALL_STATUSES = [
  "Needs to be Scheduled",
  "Scheduled",
  "Waiting for Approval",
  "Waiting on Parts",
  // Legacy status some rows may still have:
  "Parts In",
  "Completed",
];

export default function WorkOrders() {
  const navigate = useNavigate();

  const token = localStorage.getItem("jwt");
  let userRole = null;
  let userId = null;

  if (token) {
    try {
      const decoded = jwtDecode(token);
      userRole = decoded.role || null; // 'dispatcher', 'admin', or 'tech'
      userId = decoded.id || null;
    } catch {
      console.warn("Invalid JWT");
    }
  }

  const [workOrders, setWorkOrders] = useState([]);
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [techUsers, setTechUsers] = useState([]);
  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;

  // Fetch list
  const fetchWorkOrders = async () => {
    try {
      const res = await api.get("/work-orders");
      setWorkOrders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching work orders:", err);
    }
  };

  // Initial load + tech list for assigners
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

  // Derived: apply filter on each data or filter change
  const filteredOrders = useMemo(() => {
    if (selectedStatus === "All") return workOrders;
    if (selectedStatus === "Today") {
      const today = moment().format("YYYY-MM-DD");
      return workOrders.filter(
        (o) =>
          o.scheduledDate &&
          moment(o.scheduledDate).format("YYYY-MM-DD") === today
      );
    }
    return workOrders.filter((o) => o.status === selectedStatus);
  }, [workOrders, selectedStatus]);

  const handleFilter = (e) => {
    setSelectedStatus(e.target.value);
  };

  // Optimistic status update with rollback + RBAC-aware UI
  const handleStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = e.target.value;

    // optimistic update
    const prev = workOrders;
    const next = prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o));
    setWorkOrders(next);

    try {
      await api.put(`/work-orders/${id}`, { status: newStatus });
      // Optionally re-fetch to be 100% up-to-date from DB:
      // await fetchWorkOrders();
    } catch (err) {
      console.error("Error updating status:", err);
      // rollback
      setWorkOrders(prev);
      const message =
        err?.response?.data?.error ||
        (err?.response?.status === 403
          ? "You’re not allowed to change the status for this work order."
          : "Failed to update status.");
      alert(message);
    }
  };

  const assignToTech = async (orderId, techId, e) => {
    e.stopPropagation();
    try {
      await api.put(`/work-orders/${orderId}/assign`, { assignedTo: techId });
      fetchWorkOrders();
    } catch (err) {
      console.error("Error assigning tech:", err);
      alert(
        err?.response?.data?.error || "Failed to assign work order to technician."
      );
    }
  };

  const handleLocationClick = (e, loc) => {
    e.stopPropagation();
    const url = `https://www.google.com/maps/embed/v1/place?key=${googleMapsApiKey}&q=${encodeURIComponent(
      loc
    )}`;
    window.open(url, "_blank", "width=800,height=600");
  };

  const canChangeStatus = (order) =>
    userRole !== "tech" || (userId && order.assignedTo === userId);

  return (
    <div className="home-container">
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
        <div className="filter-row">
          <label className="filter-label">Filter by Status:</label>
          <select
            className="form-select"
            value={selectedStatus}
            onChange={handleFilter}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="All">All Work Orders</option>
            <option value="Today">Today</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <table className="styled-table">
          <thead>
            <tr>
              <th>WO/PO #</th>
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
              const statusDisabled = !canChangeStatus(order);

              return (
                <tr
                  key={order.id}
                  onClick={() => navigate(`/view-work-order/${order.id}`)}
                >
                  <td>{order.poNumber || "N/A"}</td>
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
                      value={order.status || ""}
                      disabled={statusDisabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => handleStatusChange(e, order.id)}
                    >
                      {ALL_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    {statusDisabled && (
                      <div className="muted tiny-hint">
                        Only the assigned tech or dispatcher/admin can change.
                      </div>
                    )}
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
                  <div className="empty-state">No work orders to display.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
