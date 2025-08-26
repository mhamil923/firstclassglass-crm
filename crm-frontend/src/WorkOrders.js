import React, { useEffect, useMemo, useState } from "react";
import api from "./api";
import { Link, useNavigate } from "react-router-dom";
import moment from "moment";
import { jwtDecode } from "jwt-decode";
import "./WorkOrders.css";

/**
 * New canonical statuses for the web app.
 * We normalize legacy "Needs to be Scheduled" -> "Parts In" for display, counts, and filtering.
 */
const STATUSES = [
  "Parts In",
  "Scheduled",
  "Waiting for Approval",
  "Waiting on Parts",
  "Completed",
];

function normalizeStatus(s = "") {
  const trimmed = String(s || "").trim();
  if (/^needs to be scheduled$/i.test(trimmed)) return "Parts In";
  return trimmed;
}

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

    if (userRole !== "tech") {
      // assignees=1 returns techs plus any allow-listed usernames
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
        const rows = Array.isArray(res.data) ? res.data : [];
        // Keep raw data, but we will normalize when displaying/filtering
        setWorkOrders(rows);
      })
      .catch((err) => console.error("Error fetching work orders:", err));
  };

  // Build counts per status (using normalized values)
  const counts = useMemo(() => {
    const c = { All: workOrders.length };
    for (const s of STATUSES) c[s] = 0;
    for (const o of workOrders) {
      const ns = normalizeStatus(o.status);
      if (STATUSES.includes(ns)) c[ns] = (c[ns] || 0) + 1;
    }
    return c;
  }, [workOrders]);

  // Derive filtered list according to selected status
  const filteredOrders = useMemo(() => {
    if (selectedStatus === "All") return workOrders;
    return workOrders.filter((o) => normalizeStatus(o.status) === selectedStatus);
  }, [workOrders, selectedStatus]);

  const handleStatusChange = (e, id, original) => {
    e.stopPropagation();
    const newStatus = e.target.value;
    // Optimistic UI update
    const prev = workOrders;
    const next = prev.map((w) =>
      w.id === id ? { ...w, status: newStatus } : w
    );
    setWorkOrders(next);

    api
      .put(`/work-orders/${id}`, { status: newStatus })
      .then(fetchWorkOrders)
      .catch((err) => {
        console.error("Error updating status:", err);
        // rollback on error
        setWorkOrders(prev);
      });
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
      loc || ""
    )}`;
    window.open(url, "_blank", "width=800,height=600");
  };

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

      {/* Status buttons with counts (evenly across) */}
      <div
        className="section-card"
        style={{ paddingTop: 12, paddingBottom: 12, marginBottom: 16 }}
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "space-between",
          }}
        >
          {/* "All" button */}
          <button
            type="button"
            onClick={() => setSelectedStatus("All")}
            className={`status-btn ${selectedStatus === "All" ? "active" : ""}`}
            style={{ flex: 1, minWidth: 120 }}
          >
            <span>All</span>
            <span className="badge">{counts.All || 0}</span>
          </button>

          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSelectedStatus(s)}
              className={`status-btn ${
                selectedStatus === s ? "active" : ""
              }`}
              style={{ flex: 1, minWidth: 160 }}
            >
              <span>{s}</span>
              <span className="badge">{counts[s] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="section-card">
        <table className="styled-table">
          <thead>
            <tr>
              <th>WO/PO #</th>
              <th>Customer</th>
              <th>Billing Address</th>
              <th>Site Location</th>
              <th>Problem Description</th>
              <th>Scheduled</th>
              <th>Status</th>
              {userRole !== "tech" && <th>Assigned To</th>}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map((order) => {
              const displayStatus = normalizeStatus(order.status);
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
                    {order.scheduledDate
                      ? moment(order.scheduledDate).format("YYYY-MM-DD HH:mm")
                      : "Not Scheduled"}
                  </td>
                  <td>
                    <select
                      className="form-select"
                      value={displayStatus}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        handleStatusChange(e, order.id, order.status)
                      }
                    >
                      {STATUSES.map((s) => (
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
              );
            })}
            {filteredOrders.length === 0 && (
              <tr>
                <td colSpan={userRole !== "tech" ? 9 : 8} style={{ textAlign: "center", color: "#666" }}>
                  No work orders in this category.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
