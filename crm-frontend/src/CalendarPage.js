// File: src/CalendarPage.js

import React, { useEffect, useMemo, useState } from "react";
import api from "./api";
import { Calendar, momentLocalizer } from "react-big-calendar";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import moment from "moment";
import { OverlayTrigger, Popover } from "react-bootstrap";

import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import "bootstrap/dist/css/bootstrap.min.css";
import "./Calendar.css";

const localizer = momentLocalizer(moment);
const DnDCalendar = withDragAndDrop(Calendar);

// Small popover for event hover
function CustomEvent({ event }) {
  const pop = (
    <Popover id={`po-${event.id}`}>
      <Popover.Header as="h3">PO#: {event.poNumber || event.id}</Popover.Header>
      <Popover.Body>
        <div><strong>Site:</strong> {event.siteLocation || "—"}</div>
        <div><strong>Problem:</strong> {event.problemDescription || "—"}</div>
      </Popover.Body>
    </Popover>
  );
  return (
    <OverlayTrigger trigger={["hover", "focus"]} placement="top" overlay={pop}>
      <span className="rbc-event-title">{event.title}</span>
    </OverlayTrigger>
  );
}

export default function WorkOrderCalendar() {
  const [allOrders, setAllOrders] = useState([]);
  const [dragItem, setDragItem] = useState(null);
  const [view, setView] = useState("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showModal, setShowModal] = useState(false);
  const [selectedDayOrders, setSelectedDayOrders] = useState([]);
  const [modalTitle, setModalTitle] = useState("");

  useEffect(() => {
    fetchWorkOrders();
  }, []);

  async function fetchWorkOrders() {
    try {
      const { data } = await api.get("/work-orders");
      setAllOrders(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("⚠️ Error fetching work orders:", err);
    }
  }

  // Split into scheduled/unscheduled
  const { scheduledEvents, unscheduledOrders } = useMemo(() => {
    const scheduled = [];
    const unscheduled = [];
    for (const o of allOrders) {
      if (o.scheduledDate) {
        const start = moment(o.scheduledDate).toDate();
        const end = moment(o.scheduledDate).add(1, "hour").toDate(); // give events a duration
        scheduled.push({
          id: o.id,
          title: o.poNumber || `WO ${o.id}`,
          poNumber: o.poNumber,
          siteLocation: o.siteLocation,
          problemDescription: o.problemDescription,
          start,
          end,
          raw: o,
        });
      } else {
        unscheduled.push(o);
      }
    }
    return { scheduledEvents: scheduled, unscheduledOrders: unscheduled };
  }, [allOrders]);

  // --- Helpers ---------------------------------------------------------------

  // Persist a date move/schedule to backend (multipart but no files)
  async function saveSchedule(id, when, nextStatus = "Scheduled") {
    const scheduledDate = moment(when).format("YYYY-MM-DD HH:mm:ss");
    const form = new FormData();
    form.append("scheduledDate", scheduledDate);
    form.append("status", nextStatus);

    await api.put(`/work-orders/${id}/edit`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });

    // Optimistic local update
    setAllOrders(prev =>
      prev.map(o =>
        o.id === id ? { ...o, scheduledDate, status: nextStatus } : o
      )
    );
  }

  // RBC internal event drag
  async function handleEventDrop({ event, start /*, end, allDay */ }) {
    try {
      await saveSchedule(event.id, start, "Scheduled");
    } catch (e) {
      console.error("⚠️ Error updating work order date:", e);
      // fallback: reload from server so UI doesn't get out of sync
      fetchWorkOrders();
    }
  }

  // External drag-from-unscheduled into calendar
  async function handleDropFromOutside({ start /*, end, allDay */ }) {
    if (!dragItem) return;
    try {
      await saveSchedule(dragItem.id, start, "Scheduled");
    } catch (e) {
      console.error("⚠️ Error scheduling work order:", e);
      fetchWorkOrders();
    } finally {
      setDragItem(null);
    }
  }

  function navigateToView(id) {
    window.location.href = `/view-work-order/${id}`;
  }

  function handleDayClick({ start }) {
    const day = moment(start).format("YYYY-MM-DD");
    const list = allOrders.filter(
      o => o.scheduledDate && moment(o.scheduledDate).format("YYYY-MM-DD") === day
    );
    setSelectedDayOrders(list);
    setModalTitle(`Work Orders for ${moment(start).format("LL")}`);
    setShowModal(true);
  }

  // --- Render ----------------------------------------------------------------
  return (
    <>
      <div className="calendar-page">
        <div className="container-fluid p-0">
          <h2 className="calendar-title">Work Order Calendar</h2>

          {/* Unscheduled list (draggable into calendar) */}
          <div className="unscheduled-container">
            <h4>Unscheduled Work Orders</h4>
            <div className="unscheduled-list">
              {unscheduledOrders.map((order) => (
                <div
                  key={order.id}
                  className="unscheduled-item"
                  draggable
                  onDragStart={(e) => {
                    // Needed for some browsers (Safari) to allow drop
                    try { e.dataTransfer.setData("text/plain", String(order.id)); } catch {}
                    setDragItem(order);
                  }}
                  onDragEnd={() => setDragItem(null)}
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
              events={scheduledEvents}
              startAccessor="start"
              endAccessor="end"
              style={{ height: "calc(100vh - 220px)" }}
              components={{ event: CustomEvent }}
              draggableAccessor={() => true}
              resizable={false}
              onEventDrop={handleEventDrop}
              dragFromOutsideItem={() => dragItem || null}
              onDropFromOutside={handleDropFromOutside}
              onSelectEvent={(event) => navigateToView(event.id)}
              onDoubleClickEvent={(event) => navigateToView(event.id)}
              onSelectSlot={handleDayClick}
              selectable
              views={["month", "week", "day", "agenda"]}
              view={view}
              onView={setView}
              date={currentDate}
              onNavigate={setCurrentDate}
              popup
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
                      {(o.poNumber || `WO ${o.id}`)} — {o.customer} — {o.problemDescription}
                    </li>
                  ))
                ) : (
                  <p className="empty-text">No work orders scheduled on this day.</p>
                )}
              </ul>
              <button className="btn btn-secondary mt-3" onClick={() => setShowModal(false)}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
