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
        const data = response.data;
        setOrders(Array.isArray(data) ? data : []);
      })
      .catch((error) => {
        console.error("Error fetching work orders:", error);
        setOrders([]);
      });
  }, []);

  // initial load
  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // refresh on window focus / tab visibility + periodic poll
  useEffect(() => {
    const onFocus = () => fetchOrders();
    const onVis = () => {
      if (document.visibilityState === "visible") fetchOrders();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    const interval = setInterval(fetchOrders, 30000); // 30s
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(interval);
    };
  }, [fetchOrders]);

  const handleClick = (orderId) => {
    navigate(`/view-work-order/${orderId}`);
  };

  // Use local timezone and day granularity
  const agendaOrders = orders.filter(
    (o) =>
      o.scheduledDate &&
      moment(o.scheduledDate).local().isSame(moment(), "day")
  );

  const upcomingOrders = orders.filter(
    (o) =>
      o.scheduledDate &&
      moment(o.scheduledDate).local().isAfter(moment(), "day")
  );

  const waitingForApprovalOrders = orders.filter(
    (o) => o.status === "Waiting for Approval"
  );

  const todayStr = moment().format("YYYY-MM-DD");

  return (
    <div className="home-container">
      <h2 className="home-title">Welcome to the CRM Dashboard</h2>

      {/* Agenda for Today */}
      <div className="section-card">
        <h3 className="section-title">
          Agenda for Today&nbsp;({todayStr})
        </h3>
        {agendaOrders.length > 0 ? (
          <Table striped bordered={false} hover responsive className="styled-table">
            <thead>
              <tr>
                <th>PO #</th>
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
                  <td>{o.poNumber}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>
                    {o.scheduledDate
                      ? moment(o.scheduledDate).local().format("HH:mm")
                      : ""}
                  </td>
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
                <th>PO #</th>
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
                  <td>{o.poNumber}</td>
                  <td>{o.customer}</td>
                  <td>{o.siteLocation}</td>
                  <td>{o.problemDescription}</td>
                  <td>
                    {o.scheduledDate
                      ? moment(o.scheduledDate).local().format("YYYY-MM-DD HH:mm")
                      : ""}
                  </td>
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
                <th>PO #</th>
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
                  <td>{o.poNumber}</td>
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
