// File: src/CalendarPage.js

import React, { useEffect, useState } from "react";
import api from "./api";                         // ← use our axios wrapper
import { Calendar, momentLocalizer } from "react-big-calendar";
import moment from "moment";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import { OverlayTrigger, Popover } from "react-bootstrap";

import "react-big-calendar/lib/css/react-big-calendar.css";
import "bootstrap/dist/css/bootstrap.min.css";
import "./Calendar.css";

const localizer = momentLocalizer(moment);
const DnDCalendar = withDragAndDrop(Calendar);

function CustomEvent({ event }) {
  const popover = (
    <Popover id={`popover-${event.id}`}>
      <Popover.Header as="h3">
        PO#: {event.poNumber || event.id}
      </Popover.Header>
      <Popover.Body>
        <strong>Site:</strong> {event.siteLocation} <br />
        <strong>Problem:</strong> {event.problemDescription}
      </Popover.Body>
    </Popover>
  );
  return (
    <OverlayTrigger
      trigger={["hover", "focus"]}
      placement="top"
      overlay={popover}
    >
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
        const scheduled = res.data.filter((o) => o.scheduledDate);
        const unscheduled = res.data.filter((o) => !o.scheduledDate);
        setWorkOrders(scheduled);
        setUnscheduledOrders(unscheduled);
      })
      .catch((err) => console.error("⚠️ Error fetching work orders:", err));
  }

  function handleEventDrop({ event, start }) {
    const formatted = moment(start).format("YYYY-MM-DD HH:mm:ss");
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

  function handleDropFromOutside({ start }) {
    if (!dragItem) return;
    const formatted = moment(start).format("YYYY-MM-DD HH:mm:ss");
    api
      .put(`/work-orders/${dragItem.id}/update-date`, {
        scheduledDate: formatted,
        status: "Scheduled",
      })
      .then(() => {
        fetchWorkOrders();
        setDragItem(null);
      })
      .catch((e) =>
        console.error("⚠️ Error scheduling work order:", e)
      );
  }

  function navigateToView(id) {
    window.location.href = `/view-work-order/${id}`;
  }

  function handleDayClick({ start }) {
    const day = moment(start).format("YYYY-MM-DD");
    const list = workOrders.filter((o) =>
      moment(o.scheduledDate).format("YYYY-MM-DD") === day
    );
    setSelectedDayOrders(list);
    setModalTitle(`Work Orders for ${moment(start).format("LL")}`);
    setShowModal(true);
  }

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
                >
                  <strong>{order.customer}</strong>
                  <br />
                  {order.problemDescription}
                </div>
              ))}
            </div>
          </div>

          {/* Calendar */}
          <div className="calendar-container">
            <DnDCalendar
              localizer={localizer}
              events={workOrders.map((o) => ({
                id: o.id,
                title: o.poNumber || `WO ${o.id}`,
                poNumber: o.poNumber,
                siteLocation: o.siteLocation,
                problemDescription: o.problemDescription,
                start: moment(o.scheduledDate).toDate(),
                end: moment(o.scheduledDate).toDate(),
              }))}
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
                      {o.customer} — {o.problemDescription}
                    </li>
                  ))
                ) : (
                  <p className="empty-text">
                    No work orders scheduled on this day.
                  </p>
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
