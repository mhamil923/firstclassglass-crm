// File: src/Home.js
import React, { useEffect, useState, useCallback } from "react";
import api from "./api";
import moment from "moment";
import Table from "react-bootstrap/Table";
import { useNavigate } from "react-router-dom";
import "./Home.css";

export default function Home() {
  const [orders, setOrders] = useState([]);
  const navigate = useNavigate();

  const fetchOrders = useCallback(() => {
    api
      .get("/work-orders")
      .then((response) => {
        const data = Array.isArray(response.data) ? response.data : [];
        setOrders(data);
      })
      .catch((error) => {
        console.error("Error fetching work orders:", error);
        setOrders([]);
      });
  }, []);

  useEffect(() => {
    fetchOrders();
    const onFocus = () => fetchOrders();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchOrders]);

  const handleClick = (orderId) => {
    navigate(`/view-work-order/${orderId}`);
  };

  // Parse as local unless string already has a zone
  const parseAsLocal = (dt) => {
    if (!dt) return null;
    const s = String(dt);
    const hasZone = /[zZ]|[+\-]\d\d:?\d\d$/.test(s);
    return hasZone ? moment(s).local() : moment(s);
  };

  const todayStr = moment().format("YYYY-MM-DD");

  const agendaOrders = orders.filter((o) => {
    if (!o.scheduledDate) return false;
    const m = parseAsLocal(o.scheduledDate);
    if (!m.isValid()) return false;
    return m.format("YYYY-MM-DD") === todayStr;
  });

  const upcomingOrders = orders.filter((o) => {
    if (!o.scheduledDate) return false;
    const m = parseAsLocal(o.scheduledDate);
    if (!m.isValid()) return false;
    return m.isAfter(moment(), "day");
  });

  const waitingForApprovalOrders = orders.filter(
    (o) => o.status === "Waiting for Approval"
  );

  const fmtDateTime = (dt) => {
    const m = parseAsLocal(dt);
    return m && m.isValid() ? m.format("YYYY-MM-DD HH:mm") : "";
  };

  const woCell = (o) => o?.workOrderNumber || "—";

  return (
    <div className="home-container">
      <h2 className="home-title">Welcome to the CRM Dashboard</h2>

      {/* Agenda for Today */}
      <div className="section-card">
        <h3 className="section-title">Agenda for Today&nbsp;({todayStr})</h3>
        {agendaOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>Work Order #</th>
                <th>Customer</th>
                <th>Site Location</th>
                <th>Problem Description</th>
                <th>Scheduled Time</th>
              </tr>
            </thead>
            <tbody>
              {agendaOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => handleClick(o.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{woCell(o)}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>{fmtDateTime(o.scheduledDate)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-text">No work orders scheduled for today.</p>
        )}
      </div>

      {/* Upcoming Work Orders */}
      <div className="section-card">
        <h3 className="section-title">Upcoming Work Orders</h3>
        {upcomingOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>Work Order #</th>
                <th>Customer</th>
                <th>Site Location</th>
                <th>Problem Description</th>
                <th>Scheduled Date</th>
              </tr>
            </thead>
            <tbody>
              {upcomingOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => handleClick(o.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{woCell(o)}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>{fmtDateTime(o.scheduledDate)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-text">No upcoming work orders.</p>
        )}
      </div>

      {/* Work Orders Waiting for Approval */}
      <div className="section-card">
        <h3 className="section-title">Work Orders Waiting for Approval</h3>
        {waitingForApprovalOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>Work Order #</th>
                <th>Customer</th>
                <th>Site Location</th>
                <th>Problem Description</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {waitingForApprovalOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => handleClick(o.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{woCell(o)}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>{o.status}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty-text">No work orders waiting for approval.</p>
        )}
      </div>
    </div>
  );
}
