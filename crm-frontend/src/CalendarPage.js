// File: src/CalendarPage.js

import React, { useEffect, useState } from "react";
import api from "./api";
import { Calendar, momentLocalizer } from "react-big-calendar";
import moment from "moment";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import { OverlayTrigger, Popover } from "react-bootstrap";

import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import "bootstrap/dist/css/bootstrap.min.css";
import "./Calendar.css";

const localizer = momentLocalizer(moment);
const DnDCalendar = withDragAndDrop(Calendar);

// Normalize a JS Date coming from rbc to a YYYY-MM-DD HH:mm:ss string at local noon
function toMiddayString(dateLike) {
  return moment(dateLike).startOf("day").add(12, "hours").format("YYYY-MM-DD HH:mm:ss");
}

// Safely build a JS Date for rbc from a DB string (treat as local, then set to noon)
function toMiddayDate(dbString) {
  // dbString like "2025-08-15 00:00:00" (no timezone). Treat as local.
  return moment(dbString, "YYYY-MM-DD HH:mm:ss").startOf("day").add(12, "hours").toDate();
}

function CustomEvent({ event }) {
  const popover = (
    <Popover id={`popover-${event.id}`}>
      <Popover.Header as="h3">
        {event.customer ? `${event.customer}` : `WO ${event.id}`}
      </Popover.Header>
      <Popover.Body>
        <div><strong>PO#:</strong> {event.poNumber || event.id}</div>
        {event.siteLocation ? <div><strong>Site:</strong> {event.siteLocation}</div> : null}
        {event.problemDescription ? <div><strong>Problem:</strong> {event.problemDescription}</div> : null}
      </Popover.Body>
    </Popover>
  );
  return (
    <OverlayTrigger trigger={["hover", "focus"]} placement="top" overlay={popover}>
      <span className="rbc-event-title">{event.title}</span>
    </OverlayTrigger>
  );
}

export default function WorkOrderCalendar() {
  const [workOrders, setWorkOrders] = useState([]);
  const [unscheduledOrders, setUnscheduledOrders] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [view, setView] = useState("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showModal, setShowModal] = useState(false);
  const [selectedDayOrders, setSelectedDayOrders] = useState([]);
  const [modalTitle, setModalTitle] = useState("");

  useEffect(fetchWorkOrders, []);

  function fetchWorkOrders() {
    api
      .get("/work-orders")
      .then((res) => {
        const scheduled = (res.data || []).filter((o) => o.scheduledDate);
        const unscheduled = (res.data || []).filter((o) => !o.scheduledDate);
        setWorkOrders(scheduled);
        setUnscheduledOrders(unscheduled);
      })
      .catch((err) => console.error("⚠️ Error fetching work orders:", err));
  }

  // Drag within calendar
  function handleEventDrop({ event, start }) {
    const formatted = toMiddayString(start);
    api
      .put(`/work-orders/${event.id}/update-date`, {
        scheduledDate: formatted,
        status: "Scheduled",
      })
      .then(() =>
        setWorkOrders((prev) =>
          prev.map((o) =>
            o.id === event.id
              ? { ...o, scheduledDate: formatted, status: "Scheduled" }
              : o
          )
        )
      )
      .catch((e) => console.error("⚠️ Error updating work order date:", e));
  }

  // Drag from "Unscheduled" list onto the calendar
  function handleDropFromOutside({ start }) {
    if (!dragItem) return;
    const formatted = toMiddayString(start);
    api
      .put(`/work-orders/${dragItem.id}/update-date`, {
        scheduledDate: formatted,
        status: "Scheduled",
      })
      .then(() => {
        fetchWorkOrders();
        setDragItem(null);
      })
      .catch((e) => console.error("⚠️ Error scheduling work order:", e));
  }

  function navigateToView(id) {
    window.location.href = `/view-work-order/${id}`;
  }

  function handleDayClick({ start }) {
    const day = moment(start).format("YYYY-MM-DD");
    const list = workOrders.filter(
      (o) => moment(o.scheduledDate, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD") === day
    );
    setSelectedDayOrders(list);
    setModalTitle(`Work Orders for ${moment(start).format("LL")}`);
    setShowModal(true);
  }

  // Build calendar events with stable midday times + richer titles
  const events = workOrders.map((o) => ({
    id: o.id,
    title: o.customer ? `${o.customer} — ${o.poNumber || `WO ${o.id}`}` : (o.poNumber || `WO ${o.id}`),
    poNumber: o.poNumber,
    customer: o.customer,
    siteLocation: o.siteLocation,
    problemDescription: o.problemDescription,
    start: toMiddayDate(o.scheduledDate),
    end: toMiddayDate(o.scheduledDate),
    allDay: false,
  }));

  return (
    <>
      <div className="calendar-page">
        <div className="container-fluid p-0">
          <h2 className="calendar-title">Work Order Calendar</h2>

          {/* Unscheduled sidebar */}
          <div className="unscheduled-container">
            <h4>Unscheduled Work Orders</h4>
            <div className="unscheduled-list">
              {unscheduledOrders.map((order) => (
                <div
                  key={order.id}
                  className="unscheduled-item"
                  draggable
                  onDragStart={() => setDragItem(order)}
                  onClick={() => navigateToView(order.id)}
                  title={order.problemDescription || ""}
                >
                  <strong>
                    {order.customer ? `${order.customer}` : `WO ${order.id}`}
                  </strong>
                  {order.poNumber ? <> — {order.poNumber}</> : null}
                  <br />
                  <small>{order.problemDescription}</small>
                </div>
              ))}
            </div>
          </div>

          {/* Calendar */}
          <div className="calendar-container">
            <DnDCalendar
              localizer={localizer}
              events={events}
              startAccessor="start"
              endAccessor="end"
              style={{ height: "calc(100vh - 200px)" }}
              components={{ event: CustomEvent }}
              draggableAccessor={() => true}
              onEventDrop={handleEventDrop}
              dragFromOutsideItem={() => dragItem}
              onDropFromOutside={handleDropFromOutside}
              onSelectEvent={(event) => navigateToView(event.id)}
              onDoubleClickEvent={(event) => navigateToView(event.id)}
              onSelectSlot={handleDayClick}
              selectable
              views={["month", "week", "day", "agenda"]}
              view={view}
              onView={(v) => setView(v)}
              date={currentDate}
              onNavigate={(d) => setCurrentDate(d)}
            />
          </div>
        </div>

        {/* Simple modal */}
        {showModal && (
          <div className="modal-overlay">
            <div className="modal-content">
              <h4>{modalTitle}</h4>
              <ul className="list-group">
                {selectedDayOrders.length > 0 ? (
                  selectedDayOrders.map((o) => (
                    <li
                      key={o.id}
                      className="list-group-item"
                      onClick={() => navigateToView(o.id)}
                      style={{ cursor: "pointer" }}
                    >
                      {o.customer ? `${o.customer}` : `WO ${o.id}`}
                      {o.poNumber ? ` — ${o.poNumber}` : ""}
                      {" — "}
                      {o.problemDescription}
                    </li>
                  ))
                ) : (
                  <p className="empty-text">No work orders scheduled on this day.</p>
                )}
              </ul>
              <button
                className="btn btn-secondary mt-3"
                onClick={() => setShowModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
