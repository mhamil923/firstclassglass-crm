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

  // auth / role (controls assignment column)
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
  const [selectedFilter, setSelectedFilter] = useState("All"); // 'All' | 'Today' | one of STATUS_LIST
  const [techUsers, setTechUsers] = useState([]);

  useEffect(() => {
    fetchWorkOrders();

    // Dispatcher/Admin can assign; fetch assignable users (techs + extras)
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

  // Recompute filtered list anytime the source or filter changes
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
      rows = workOrders.filter((o) => o.status === selectedFilter);
    }

    setFilteredOrders(rows);
  }, [workOrders, selectedFilter]);

  // Live counts for the chip bar
  const chipCounts = useMemo(() => {
    const counts = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]));
    let today = 0;
    const todayStr = moment().format("YYYY-MM-DD");
    for (const o of workOrders) {
      if (o.status && counts[o.status] !== undefined) counts[o.status]++;
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

  // optimistic status update for a row
  const handleStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = e.target.value;

    // optimistic update
    const prev = workOrders;
    const next = prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o));
    setWorkOrders(next);

    try {
      await api.put(`/work-orders/${id}`, { status: newStatus });
    } catch (err) {
      console.error("Error updating status:", err);
      // rollback
      setWorkOrders(prev);
      alert(err?.response?.data?.error || "Failed to update status.");
    }
  };

  const assignToTech = (orderId, techId, e) => {
    e.stopPropagation();
    api
      .put(`/work-orders/${orderId}/assign`, { assignedTo: techId })
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

      {/* Status chip bar w/ counts */}
      <div className="section-card">
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
    </div>
  );
}
