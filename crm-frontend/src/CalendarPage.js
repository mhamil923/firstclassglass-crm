// File: src/CalendarPage.js
import React, { useEffect, useMemo, useState, useCallback } from "react";
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

// Keep this in sync with server DEFAULT_WINDOW_MINUTES
const DEFAULT_WINDOW_MIN = 120;

// ---------- date helpers ----------
function fromDbString(dbString) {
  if (!dbString) return null;
  const m =
    dbString.trim().length <= 10
      ? moment(dbString, "YYYY-MM-DD").startOf("day")
      : moment(dbString.replace("T", " "), "YYYY-MM-DD HH:mm:ss");
  return m.toDate();
}
const fmtDate = (d) => moment(d).format("YYYY-MM-DD");
const fmtTime = (d) => moment(d).format("HH:mm");

// compute minutes between two JS Dates
const diffMinutes = (a, b) => Math.max(0, Math.round((+b - +a) / 60000));

// ---------- event bubble ----------
function CustomEvent({ event }) {
  const when =
    event.start && event.end
      ? `${moment(event.start).format("YYYY-MM-DD HH:mm")} – ${moment(event.end).format("HH:mm")}`
      : event.start
      ? moment(event.start).format("YYYY-MM-DD HH:mm")
      : "";

  const popover = (
    <Popover id={`popover-${event.id}`}>
      <Popover.Header as="h3">
        {event.customer ? `${event.customer}` : `WO ${event.id}`}
      </Popover.Header>
      <Popover.Body>
        <div><strong>PO#:</strong> {event.poNumber || event.id}</div>
        {event.siteLocation ? <div><strong>Site:</strong> {event.siteLocation}</div> : null}
        {event.problemDescription ? <div><strong>Problem:</strong> {event.problemDescription}</div> : null}
        {when ? <div style={{ marginTop: 6 }}><strong>When:</strong> {when}</div> : null}
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

  const [view, setView] = useState("month");
  const [currentDate, setCurrentDate] = useState(new Date());

  // Day list modal
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [dayModalTitle, setDayModalTitle] = useState("");
  const [dayOrders, setDayOrders] = useState([]); // ✅ fixed
  const [dayForModal, setDayForModal] = useState(null);

  // Quick edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editOrder, setEditOrder] = useState(null);
  const [editDate, setEditDate] = useState("");   // yyyy-mm-dd
  const [editTime, setEditTime] = useState("");   // HH:mm
  const [editEndTime, setEditEndTime] = useState(""); // HH:mm (window end)

  // Drag from Unscheduled OR Day modal → calendar
  const [dragItem, setDragItem] = useState(null);

  // Reorder within day modal
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  useEffect(() => {
    fetchWorkOrders();
  }, []);

  const fetchWorkOrders = useCallback(() => {
    api
      .get("/work-orders")
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : [];
        // Scheduled list
        setWorkOrders(list.filter((o) => o.scheduledDate));
        // Unscheduled list EXCLUDING Completed
        setUnscheduledOrders(
          list.filter((o) => !o.scheduledDate && (o.status || "").trim() !== "Completed")
        );
      })
      .catch((err) => console.error("⚠️ Error fetching work orders:", err));
  }, []);

  // ---------- schedule helpers (server expects date/time + optional endTime) ----------
  async function setSchedulePayload(orderId, payload) {
    // payload example: { date:'YYYY-MM-DD', time:'HH:mm', endTime:'HH:mm' }
    // to unschedule:   { scheduledDate: null }
    await api.put(`/work-orders/${orderId}/update-date`, payload);
  }

  // For drag/drop: preserve current duration if available
  function minutesWindowForOrder(orderLike) {
    const start = fromDbString(orderLike.scheduledDate);
    const end = fromDbString(orderLike.scheduledEnd);
    if (start && end) return Math.max(15, diffMinutes(start, end));
    return DEFAULT_WINDOW_MIN; // fallback
  }

  // ---------- edit modal wiring ----------
  function openEditModal(order, fallbackDate) {
    const start = fromDbString(order?.scheduledDate) || fallbackDate || new Date();
    const end =
      fromDbString(order?.scheduledEnd) ||
      moment(start).add(DEFAULT_WINDOW_MIN, "minutes").toDate();

    setEditOrder(order);
    setEditDate(fmtDate(start));
    setEditTime(fmtTime(start));
    setEditEndTime(fmtTime(end));
    setEditModalOpen(true);
  }

  async function saveEditModal() {
    if (!editOrder) return;

    // Guard: both start and end must be valid and end after start
    const start = moment(`${editDate} ${editTime}`, "YYYY-MM-DD HH:mm");
    const end   = moment(`${editDate} ${editEndTime}`, "YYYY-MM-DD HH:mm");
    if (!start.isValid() || !end.isValid()) {
      alert("Please enter a valid start and end time.");
      return;
    }
    if (end.isSameOrBefore(start)) {
      alert("End time must be after start time.");
      return;
    }

    try {
      await setSchedulePayload(editOrder.id, {
        date: editDate,
        time: editTime,
        endTime: editEndTime,
        status: "Scheduled",
      });
      setEditModalOpen(false);
      if (dayForModal) await openDayModal(dayForModal);
      fetchWorkOrders();
    } catch (e) {
      console.error("⚠️ Error saving schedule:", e);
      alert("Failed to save schedule.");
    }
  }

  async function unschedule(orderId) {
    if (!window.confirm("Remove this work order from the calendar?")) return;
    try {
      await setSchedulePayload(orderId, { scheduledDate: null });
      setEditModalOpen(false);
      if (dayForModal) await openDayModal(dayForModal);
      fetchWorkOrders();
    } catch (e) {
      console.error("⚠️ Error unscheduling:", e);
      alert("Failed to unschedule.");
    }
  }

  // ---------- Day modal helpers ----------
  async function openDayModal(dateLike) {
    const day = moment(dateLike).startOf("day");
    const dateStr = day.format("YYYY-MM-DD");
    try {
      const { data } = await api.get("/calendar/day", { params: { date: dateStr } });
      const list = Array.isArray(data) ? data : [];
      setDayOrders(list);
      setDayForModal(day.toDate());
      setDayModalTitle(`Work Orders for ${day.format("LL")}`);
      setDayModalOpen(true);
    } catch (e) {
      console.error("⚠️ Error loading day:", e);
      alert("Failed to load that day.");
    }
  }

  async function saveDayOrder() {
    if (!dayForModal || !dayOrders.length) return;
    const dateStr = moment(dayForModal).format("YYYY-MM-DD");
    const orderedIds = dayOrders.map((o) => o.id);
    try {
      await api.put("/calendar/day-order", { date: dateStr, orderedIds });
    } catch (e) {
      console.error("⚠️ Error saving order:", e);
    }
  }

  // HTML5 drag reorder inside day modal
  function handleDayDragStart(index, item) {
    setDragIndex(index);
    setDragItem(item); // also allow dragging out to calendar
  }
  function handleDayDragOver(e, index) {
    e.preventDefault();
    setOverIndex(index);
  }
  async function handleDayDrop(e, dropIndex) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) return;
    const next = [...dayOrders];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(dropIndex, 0, moved);
    setDayOrders(next);
    setDragIndex(null);
    setOverIndex(null);
    await saveDayOrder();
  }
  function endGlobalDrag() {
    setDragItem(null);
  }

  // ---------- rbc interactions ----------
  function handleEventDrop({ event, start, end }) {
    // Preserve window length if RBC doesn't provide end
    let minutes = end ? diffMinutes(start, end) : minutesWindowForOrder(event);
    if (!Number.isFinite(minutes) || minutes <= 0) minutes = DEFAULT_WINDOW_MIN;

    setSchedulePayload(event.id, {
      date: fmtDate(start),
      time: fmtTime(start),
      endTime: fmtTime(moment(start).add(minutes, "minutes").toDate()),
      status: "Scheduled",
    })
      .then(() => {
        fetchWorkOrders();
        if (dayForModal) openDayModal(dayForModal);
      })
      .catch((e) => console.error("⚠️ Error updating work order date:", e));
  }

  function handleEventResize({ event, start, end }) {
    // When resizing, RBC gives us the new end — use it.
    const minutes = end ? diffMinutes(start, end) : minutesWindowForOrder(event);
    setSchedulePayload(event.id, {
      date: fmtDate(start),
      time: fmtTime(start),
      endTime: fmtTime(moment(start).add(minutes, "minutes").toDate()),
      status: "Scheduled",
    })
      .then(() => {
        fetchWorkOrders();
        if (dayForModal) openDayModal(dayForModal);
      })
      .catch((e) => console.error("⚠️ Error resizing event:", e));
  }

  function handleDropFromOutside({ start }) {
    if (!dragItem) return;
    const minutes = minutesWindowForOrder(dragItem);
    setSchedulePayload(dragItem.id, {
      date: fmtDate(start),
      time: fmtTime(start),
      endTime: fmtTime(moment(start).add(minutes, "minutes").toDate()),
      status: "Scheduled",
    })
      .then(() => {
        endGlobalDrag();
        fetchWorkOrders();
        if (dayForModal) openDayModal(dayForModal);
      })
      .catch((e) => console.error("⚠️ Error scheduling work order:", e));
  }

  function onSelectEvent(event) {
    const full = workOrders.find((o) => o.id === event.id) || event;
    openEditModal(full);
  }

  function onSelectSlot(slotInfo) {
    // open day modal for clicked day
    openDayModal(slotInfo.start);
  }

  function onShowMore(events, date) {
    // Replace the default RBC popup with our modal
    openDayModal(date);
  }

  function navigateToView(id) {
    window.location.href = `/view-work-order/${id}`;
  }

  // ---------- build rbc events (honor scheduledEnd/window) ----------
  const events = useMemo(
    () =>
      workOrders.map((o) => {
        const start = fromDbString(o.scheduledDate) || new Date();
        const end =
          fromDbString(o.scheduledEnd) ||
          moment(start).add(DEFAULT_WINDOW_MIN, "minutes").toDate();
        return {
          id: o.id,
          title: o.customer
            ? `${o.customer} — ${o.poNumber || `WO ${o.id}`}`
            : o.poNumber || `WO ${o.id}`,
          poNumber: o.poNumber,
          customer: o.customer,
          siteLocation: o.siteLocation,
          problemDescription: o.problemDescription,
          scheduledDate: o.scheduledDate,
          scheduledEnd: o.scheduledEnd,
          start,
          end,
          allDay: false,
        };
      }),
    [workOrders]
  );

  return (
    <div className="calendar-page" onDragEnd={endGlobalDrag}>
      <div className="container-fluid p-0">
        <h2 className="calendar-title">Work Order Calendar</h2>

        {/* Unscheduled strip you can drag from (Completed filtered out) */}
        <div className="unscheduled-container">
          <h4>Unscheduled Work Orders</h4>
          <div className="unscheduled-list">
            {unscheduledOrders.map((order) => (
              <div
                key={order.id}
                className="unscheduled-item"
                draggable
                onDragStart={() => setDragItem(order)}
                title={order.problemDescription || ""}
              >
                <strong>
                  {order.customer ? `${order.customer}` : `WO ${order.id}`}
                </strong>
                {order.poNumber ? <> — {order.poNumber}</> : null}
                <br />
                <small className="truncate">{order.problemDescription}</small>
                <div className="unscheduled-actions">
                  <button
                    className="btn btn-xs btn-outline-light me-1"
                    onClick={() => openEditModal(order, currentDate)}
                  >
                    Schedule…
                  </button>
                  <button
                    className="btn btn-xs btn-light"
                    onClick={() => navigateToView(order.id)}
                  >
                    Open
                  </button>
                </div>
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
            step={15}
            timeslots={4}
            min={moment().startOf("day").add(6, "hours").toDate()}   // 6 AM
            max={moment().startOf("day").add(21, "hours").toDate()}  // 9 PM
            popup={false} // our own day modal instead of RBC popup
            resizable
            selectable
            components={{ event: CustomEvent }}
            draggableAccessor={() => true}
            onEventDrop={handleEventDrop}
            onEventResize={handleEventResize}
            dragFromOutsideItem={() => dragItem}
            onDropFromOutside={handleDropFromOutside}
            onSelectEvent={onSelectEvent}
            onDoubleClickEvent={(e) => navigateToView(e.id)}
            onSelectSlot={onSelectSlot}
            onShowMore={onShowMore}
            view={view}
            onView={(v) => setView(v)}
            date={currentDate}
            onNavigate={(d) => setCurrentDate(d)}
            style={{ height: "calc(100vh - 220px)" }}
          />
        </div>
      </div>

      {/* ---------- Day list modal (draggable & reorderable) ---------- */}
      {dayModalOpen && (
        <div className="modal-overlay" onClick={() => setDayModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3">{dayModalTitle}</h4>
            {dayOrders.length ? (
              <ul className="list-group">
                {dayOrders.map((o, idx) => {
                  const s = fromDbString(o.scheduledDate);
                  const e = fromDbString(o.scheduledEnd);
                  const label =
                    s && e
                      ? `${moment(s).format("hh:mm A")} – ${moment(e).format("hh:mm A")}`
                      : s
                      ? `${moment(s).format("hh:mm A")} – ${moment(s).add(DEFAULT_WINDOW_MIN, "minutes").format("hh:mm A")}`
                      : "";
                  return (
                    <li
                      key={o.id}
                      className="list-group-item d-flex justify-content-between align-items-start"
                      draggable
                      onDragStart={() => handleDayDragStart(idx, o)}
                      onDragOver={(ev) => handleDayDragOver(ev, idx)}
                      onDrop={(ev) => handleDayDrop(ev, idx)}
                      style={{
                        cursor: "grab",
                        background:
                          overIndex === idx && dragIndex !== null
                            ? "#f1f5f9"
                            : "white",
                      }}
                      title="Drag to reorder or drag out onto the calendar"
                    >
                      <div className="me-2">
                        <div className="fw-bold">
                          {o.customer ? `${o.customer}` : `WO ${o.id}`}
                          {o.poNumber ? ` — ${o.poNumber}` : ""}
                        </div>
                        <small className="text-muted">{o.problemDescription}</small>
                        <div><small>{label}</small></div>
                      </div>
                      <div className="d-flex align-items-center">
                        <button
                          className="btn btn-sm btn-primary me-2"
                          onClick={() => openEditModal(o, dayForModal)}
                        >
                          Edit Time…
                        </button>
                        <button
                          className="btn btn-sm btn-outline-secondary me-2"
                          onClick={() => navigateToView(o.id)}
                        >
                          Open
                        </button>
                        <button
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => unschedule(o.id)}
                        >
                          Unschedule
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty-text mb-0">No work orders scheduled on this day.</p>
            )}
            <div className="text-end mt-3">
              <button className="btn btn-secondary" onClick={() => setDayModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Quick Edit modal (start + end time) ---------- */}
      {editModalOpen && (
        <div className="modal-overlay" onClick={() => setEditModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3">Edit Schedule</h4>
            {editOrder && (
              <>
                <div className="mb-2">
                  <div className="fw-bold">
                    {editOrder.customer ? `${editOrder.customer}` : `WO ${editOrder.id}`}
                    {editOrder.poNumber ? ` — ${editOrder.poNumber}` : ""}
                  </div>
                  <small className="text-muted">{editOrder.problemDescription}</small>
                </div>

                <div className="row g-2">
                  <div className="col-5">
                    <label className="form-label small">Date</label>
                    <input
                      className="form-control"
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                    />
                  </div>
                  <div className="col-3">
                    <label className="form-label small">Start</label>
                    <input
                      className="form-control"
                      type="time"
                      value={editTime}
                      onChange={(e) => setEditTime(e.target.value)}
                    />
                  </div>
                  <div className="col-4">
                    <label className="form-label small">End</label>
                    <input
                      className="form-control"
                      type="time"
                      value={editEndTime}
                      onChange={(e) => setEditEndTime(e.target.value)}
                    />
                  </div>
                </div>

                <div className="d-flex justify-content-end mt-3">
                  <button className="btn btn-outline-danger me-2" onClick={() => unschedule(editOrder.id)}>
                    Unschedule
                  </button>
                  <button className="btn btn-primary" onClick={saveEditModal}>
                    Save
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
