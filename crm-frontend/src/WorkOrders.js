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
  "Parts In",
  "Completed",
];

export default function WorkOrders() {
  const navigate = useNavigate();
  const token = localStorage.getItem("jwt");
  let userRole = null;
  if (token) {
    try {
      userRole = jwtDecode(token).role; // 'dispatcher', 'admin', or 'tech'
    } catch {
      console.warn("Invalid JWT");
    }
  }

  const [workOrders, setWorkOrders] = useState([]);
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [techUsers, setTechUsers] = useState([]);
  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;

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
        const list = Array.isArray(res.data) ? res.data : [];
        setWorkOrders(list);
        setFilteredOrders(applyStatusFilter(list, selectedStatus));
      })
      .catch((err) => console.error("Error fetching work orders:", err));
  };

  const applyStatusFilter = (orders, status) => {
    if (status === "All") return orders;
    if (status === "Today") {
      const today = moment().format("YYYY-MM-DD");
      return orders.filter(
        (o) =>
          o.scheduledDate &&
          moment(o.scheduledDate).format("YYYY-MM-DD") === today
      );
    }
    return orders.filter((o) => o.status === status);
  };

  // ✅ counts for each chip (always computed consistently)
  const counts = useMemo(() => {
    const map = Object.create(null);
    ALL_STATUSES.forEach((s) => (map[s] = 0));
    let todayCount = 0;

    const today = moment().format("YYYY-MM-DD");
    for (const o of workOrders) {
      if (o?.status && map[o.status] !== undefined) {
        map[o.status] += 1;
      }
      if (
        o?.scheduledDate &&
        moment(o.scheduledDate).format("YYYY-MM-DD") === today
      ) {
        todayCount += 1;
      }
    }
    return {
      All: workOrders.length,
      Today: todayCount,
      ...map,
    };
  }, [workOrders]);

  // keep filtered list in sync when selection or data changes
  useEffect(() => {
    setFilteredOrders(applyStatusFilter(workOrders, selectedStatus));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStatus, workOrders]);

  const handleStatusChange = (e, id) => {
    e.stopPropagation();
    const newStatus = e.target.value;
    api
      .put(`/work-orders/${id}`, { status: newStatus })
      .then(fetchWorkOrders)
      .catch((err) => console.error("Error updating status:", err));
  };

  const assignToTech = (orderId, techId, e) => {
    e.stopPropagation();
    api
      .put(`/work-orders/${orderId}/assign`, { assignedTo: techId })
      .then(fetchWorkOrders)
      .catch((err) => console.error("Error assigning tech:", err));
  };

  const handleLocationClick = (e, loc) => {
    e.stopPropagation();
    const url = `https://www.google.com/maps/embed/v1/place?key=${googleMapsApiKey}&q=${encodeURIComponent(
      loc
    )}`;
    window.open(url, "_blank", "width=800,height=600");
  };

  // order shown: All, Today, then all statuses
  const CHIP_ORDER = useMemo(
    () => ["All", "Today", ...ALL_STATUSES],
    []
  );

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
        {/* ✅ Pretty, responsive status chips with counts */}
        <div className="status-chips" role="tablist" aria-label="Status Filter">
          {CHIP_ORDER.map((label) => {
            const isActive = selectedStatus === label;
            // map label to a color class (stable set)
            const colorKey =
              label === "Needs to be Scheduled"
                ? "needs"
                : label === "Scheduled"
                ? "scheduled"
                : label === "Waiting for Approval"
                ? "approval"
                : label === "Waiting on Parts"
                ? "parts"
                : label === "Parts In"
                ? "partsin"
                : label === "Completed"
                ? "done"
                : label === "Today"
                ? "today"
                : "all";
            return (
              <button
                key={label}
                type="button"
                className={`status-chip chip-${colorKey} ${
                  isActive ? "active" : ""
                }`}
                aria-pressed={isActive}
                onClick={() => setSelectedStatus(label)}
              >
                <span className="chip-label">{label}</span>
                <span className="chip-count">{counts[label] || 0}</span>
              </button>
            );
          })}
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
            {filteredOrders.map((order) => (
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
                    value={order.status}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => handleStatusChange(e, order.id)}
                  >
                    <option value="Needs to be Scheduled">
                      Needs to be Scheduled
                    </option>
                    <option value="Scheduled">Scheduled</option>
                    <option value="Waiting for Approval">
                      Waiting for Approval
                    </option>
                    <option value="Waiting on Parts">Waiting on Parts</option>
                    <option value="Parts In">Parts In</option>
                    <option value="Completed">Completed</option>
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
                <td colSpan={8} className="empty-text">
                  No work orders match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
