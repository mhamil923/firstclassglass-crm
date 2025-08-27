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
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [techUsers, setTechUsers] = useState([]);
  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    fetchWorkOrders();

    // Anyone who is NOT a tech should be able to assign (dispatcher/admin)
    if (userRole !== "tech") {
      // IMPORTANT: use assignees=1 to get techs + allow-list (e.g., Jeff, tech1)
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
      .then((res) => setWorkOrders(Array.isArray(res.data) ? res.data : []))
      .catch((err) => console.error("Error fetching work orders:", err));
  };

  // Counts for each status + Today + All
  const { statusCounts, todayCount, totalCount } = useMemo(() => {
    const counts = {};
    let today = 0;
    const todayStr = moment().format("YYYY-MM-DD");

    for (const o of workOrders) {
      if (o?.status) counts[o.status] = (counts[o.status] || 0) + 1;
      if (
        o?.scheduledDate &&
        moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      ) {
        today++;
      }
    }

    return {
      statusCounts: counts,
      todayCount: today,
      totalCount: workOrders.length,
    };
  }, [workOrders]);

  // Filtered list based on selected chip
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

  const applyFilter = (value) => setSelectedStatus(value);

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

  return (
    <div className="home-container">
      <div className="header-row">
        <h2 className="text-primary">Work Orders Dashboard</h2>

        {/* web CRM keeps the Add button visible (field app restriction was separate) */}
        <Link
          to="/add-work-order"
          className="btn btn-primary"
          onClick={(e) => e.stopPropagation()}
        >
          + Add New Work Order
        </Link>
      </div>

      {/* Status chips / counters */}
      <div className="section-card">
        <div className="status-bar">
          {/* All */}
          <button
            className={`status-pill ${
              selectedStatus === "All" ? "active" : ""
            }`}
            onClick={() => applyFilter("All")}
          >
            <span className="label">All</span>
            <span className="count">{totalCount}</span>
          </button>

          {/* Today */}
          <button
            className={`status-pill ${
              selectedStatus === "Today" ? "active" : ""
            }`}
            onClick={() => applyFilter("Today")}
          >
            <span className="label">Today</span>
            <span className="count">{todayCount}</span>
          </button>

          {/* Each status (now includes BOTH "Needs to be Scheduled" AND "Parts In") */}
          {STATUS_LIST.map((label) => (
            <button
              key={label}
              className={`status-pill ${
                selectedStatus === label ? "active" : ""
              }`}
              onClick={() => applyFilter(label)}
              title={label}
            >
              <span className="label">{label}</span>
              <span className="count">{statusCounts[label] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="section-card">
        {filteredOrders.length === 0 ? (
          <div className="empty-text">No work orders to display.</div>
        ) : (
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
                      onClick={(e) =>
                        handleLocationClick(e, order.siteLocation)
                      }
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
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
