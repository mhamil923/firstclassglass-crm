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

// Keep this in sync with ViewWorkOrder.js and WorkOrders.js
const STATUS_OPTIONS = [
  "New",
  "Scheduled",
  "Needs to be Quoted",
  "Waiting for Approval",
  "Approved",
  "Waiting on Parts",
  "Needs to be Scheduled",
  "Needs to be Invoiced",
  "Completed",
];

/* =========================
   Helpers
========================= */
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
const diffMinutes = (a, b) => Math.max(0, Math.round((+b - +a) / 60000));

/** Prefer Work Order #, else PO #, else N/A — and return a labeled string */
const displayWOThenPO = (obj) => {
  const wo = (obj?.workOrderNumber ?? "").toString().trim();
  const po = (obj?.poNumber ?? "").toString().trim();
  if (wo) return `WO #${wo}`;
  if (po) return `PO #${po}`;
  return "N/A";
};

const norm = (v) => (v ?? "").toString().trim().toLowerCase();

/** Multi-line clamp inline styles */
const clamp1 = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const clamp2 = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const clamp4 = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 4,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "pre-wrap",
};

/* =========================
   Status gates (existing)
========================= */
// Only these statuses are allowed to appear in the Unscheduled strip when there is no search
const ALLOWED_UNSCHEDULED_STATUSES = new Set([
  "new",
  "scheduled",
  "needs to be scheduled",
]);
const isAllowedForUnscheduled = (status) =>
  ALLOWED_UNSCHEDULED_STATUSES.has(norm(status));

/* =========================
   Event bubble (calendar)
========================= */
function CustomEvent({ event }) {
  const when =
    event.start && event.end
      ? `${moment(event.start).format("YYYY-MM-DD HH:mm")} – ${moment(event.end).format("HH:mm")}`
      : event.start
      ? moment(event.start).format("YYYY-MM-DD HH:mm")
      : "";

  const idLabel = displayWOThenPO(event);
  const hasProblem = !!event.problemDescription;

  const popover = (
    <Popover id={`popover-${event.id}`}>
      <Popover.Header as="h3">
        {event.customer ? `${event.customer}` : `Work Order`} — {idLabel}
      </Popover.Header>
      <Popover.Body>
        {event.siteLocation ? (
          <div>
            <strong>Site Location:</strong> {event.siteLocation}
          </div>
        ) : null}
        {event.siteAddress ? (
          <div>
            <strong>Site Address:</strong> {event.siteAddress}
          </div>
        ) : null}
        {hasProblem ? (
          <div style={{ marginTop: 6 }}>
            <strong>Problem:</strong>
            <div style={clamp4}>{event.problemDescription}</div>
          </div>
        ) : null}
        {when ? (
          <div style={{ marginTop: 6 }}>
            <strong>When:</strong> {when}
          </div>
        ) : null}
      </Popover.Body>
    </Popover>
  );

  return (
    <OverlayTrigger trigger={["hover", "focus"]} placement="top" overlay={popover}>
      <span className="rbc-event-title">{event.title}</span>
    </OverlayTrigger>
  );
}

/* =========================
   Main component
========================= */
export default function WorkOrderCalendar() {
  const [allOrders, setAllOrders] = useState([]);            // ⬅️ NEW: keep full list
  const [workOrders, setWorkOrders] = useState([]);          // scheduled & status=Scheduled → calendar
  const [unscheduledOrders, setUnscheduledOrders] = useState([]);
  const [unscheduledSearch, setUnscheduledSearch] = useState("");

  const [view, setView] = useState("month");
  const [currentDate, setCurrentDate] = useState(new Date());

  // Day list modal
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [dayModalTitle, setDayModalTitle] = useState("");
  const [dayOrders, setDayOrders] = useState([]);
  const [dayForModal, setDayForModal] = useState(null);

  // Quick edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editOrder, setEditOrder] = useState(null);
  const [editDate, setEditDate] = useState(""); // yyyy-mm-dd
  const [editTime, setEditTime] = useState(""); // HH:mm
  const [editEndTime, setEditEndTime] = useState(""); // HH:mm (window end)

  // Drag from Unscheduled OR Day modal → calendar
  const [dragItem, setDragItem] = useState(null);

  // Reorder within day modal
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  // Status picker inside modals/unscheduled
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState(null);
  const [statusChoice, setStatusChoice] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);

  useEffect(() => {
    fetchWorkOrders();
  }, []);

  const fetchWorkOrders = useCallback(() => {
    api
      .get("/work-orders")
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : [];

        // Keep the full list in state so search can include scheduled items
        setAllOrders(list);

        // 1) Calendar events: only things actually scheduled and with status Scheduled
        const calendarItems = list.filter(
          (o) => o.scheduledDate && norm(o.status) === "scheduled"
        );

        // 2) Unscheduled strip (default view, when search is empty)
        const unscheduled = list.filter((o) => {
          const statusOk = isAllowedForUnscheduled(o.status);
          if (!statusOk) return false;
          const s = norm(o.status);
          if (s === "needs to be scheduled") return true;
          if (!o.scheduledDate) return true;
          return false;
        });

        setWorkOrders(calendarItems);
        setUnscheduledOrders(unscheduled);
      })
      .catch((err) => console.error("⚠️ Error fetching work orders:", err));
  }, []);

  /* ===== schedule helpers ===== */
  async function setSchedulePayload(orderId, payload) {
    await api.put(`/work-orders/${orderId}/update-date`, payload);
  }

  function minutesWindowForOrder(orderLike) {
    const start = fromDbString(orderLike.scheduledDate);
    const end = fromDbString(orderLike.scheduledEnd);
    if (start && end) return Math.max(15, diffMinutes(start, end));
    return DEFAULT_WINDOW_MIN;
  }

  /* ===== edit modal wiring ===== */
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

    const start = moment(`${editDate} ${editTime}`, "YYYY-MM-DD HH:mm");
    const end = moment(`${editDate} ${editEndTime}`, "YYYY-MM-DD HH:mm");
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
      await setSchedulePayload(orderId, { scheduledDate: null, scheduledEnd: null });
      setEditModalOpen(false);
      if (dayForModal) await openDayModal(dayForModal);
      fetchWorkOrders();
    } catch (e) {
      console.error("⚠️ Error unscheduling:", e);
      alert("Failed to unschedule.");
    }
  }

  /* ===== Day modal helpers ===== */
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

  /* ===== react-big-calendar interactions ===== */
  function handleEventDrop({ event, start, end }) {
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
    const full = allOrders.find((o) => o.id === event.id) || event;
    openEditModal(full);
  }

  function onSelectSlot(slotInfo) {
    openDayModal(slotInfo.start);
  }

  function onShowMore(eventsInCell, date) {
    openDayModal(date);
  }

  function navigateToView(id) {
    window.location.href = `/view-work-order/${id}`;
  }

  /* ===== build rbc events ===== */
  const events = useMemo(() => {
    return workOrders.map((o) => {
      const start = fromDbString(o.scheduledDate) || new Date();
      const end =
        fromDbString(o.scheduledEnd) ||
        moment(start).add(DEFAULT_WINDOW_MIN, "minutes").toDate();

      const idLabel = displayWOThenPO(o);
      const title = o.customer ? `${o.customer} — ${idLabel}` : idLabel;

      return {
        id: o.id,
        title,
        poNumber: o.poNumber,
        workOrderNumber: o.workOrderNumber,
        customer: o.customer,
        siteLocation: o.siteLocation,
        siteAddress: o.siteAddress || o.serviceAddress || o.address || "",
        problemDescription: o.problemDescription,
        scheduledDate: o.scheduledDate,
        scheduledEnd: o.scheduledEnd,
        start,
        end,
        allDay: false,
      };
    });
  }, [workOrders]);

  /* ===== Search logic (enhanced) =====
     - If the search box is empty, show the classic "Unscheduled" list.
     - If there's a search query, search ACROSS ALL WORK ORDERS (scheduled & unscheduled).
       This lets you pull up scheduled work orders and drag them to reschedule. */
  const listForStrip = useMemo(() => {
    const q = norm(unscheduledSearch);
    if (!q) return unscheduledOrders;

    const tokens = q.split(/\s+/).filter(Boolean);
    const pool = allOrders; // search everything when there's a query

    return pool.filter((o) => {
      const hayCustomer = norm(o.customer);
      const hayPO = norm(o.poNumber);
      const hayWO = norm(o.workOrderNumber);
      return tokens.every(
        (t) => hayCustomer.includes(t) || hayPO.includes(t) || hayWO.includes(t)
      );
    });
  }, [unscheduledOrders, allOrders, unscheduledSearch]);

  const clearUnscheduledSearch = () => setUnscheduledSearch("");

  /* ===== Status modal actions ===== */
  function openStatusPicker(order) {
    setStatusTarget(order);
    setStatusChoice(order?.status || "");
    setStatusModalOpen(true);
  }

  async function confirmStatusChange() {
    if (!statusTarget || !statusChoice) return;
    setStatusSaving(true);
    try {
      // Try dedicated endpoint first; fallback to /edit
      try {
        await api.put(`/work-orders/${statusTarget.id}/status`, { status: statusChoice });
      } catch {
        const form = new FormData();
        form.append("status", statusChoice);
        await api.put(`/work-orders/${statusTarget.id}/edit`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      setStatusModalOpen(false);
      if (dayForModal) await openDayModal(dayForModal);
      fetchWorkOrders();
    } catch (e) {
      console.error("⚠️ Error updating status:", e);
      alert("Failed to update status.");
    } finally {
      setStatusSaving(false);
    }
  }

  function cancelStatusChange() {
    setStatusModalOpen(false);
    setStatusTarget(null);
    setStatusChoice("");
  }

  /* =========================
     Render
  ========================= */
  return (
    <div className="calendar-page" onDragEnd={endGlobalDrag}>
      <div className="container-fluid p-0">
        <h2 className="calendar-title">Work Order Calendar</h2>

        {/* Search & Unscheduled strip */}
        <div className="unscheduled-container">
          <div className="d-flex align-items-center justify-content-between">
            <h4 className="mb-2">
              {unscheduledSearch ? "Search Results (All Work Orders)" : "Unscheduled Work Orders"}
            </h4>

            <div className="input-group" style={{ maxWidth: 520 }}>
              <input
                type="text"
                className="form-control"
                placeholder="Search customer, WO #, or PO # (includes scheduled)"
                value={unscheduledSearch}
                onChange={(e) => setUnscheduledSearch(e.target.value)}
              />
              {unscheduledSearch ? (
                <button
                  className="btn btn-outline-secondary"
                  onClick={clearUnscheduledSearch}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <div className="text-muted mb-2" style={{ fontSize: 12 }}>
            {unscheduledSearch ? (
              <>
                Showing {listForStrip.length} match{listForStrip.length === 1 ? "" : "es"} across{" "}
                {allOrders.length} total work order{allOrders.length === 1 ? "" : "s"} (drag any item to reschedule).
              </>
            ) : (
              <>
                Showing {listForStrip.length} of {unscheduledOrders.length} (Statuses: New, Scheduled, Needs to be Scheduled)
              </>
            )}
          </div>

          <div className="unscheduled-list">
            {listForStrip.map((order) => {
              const idLabel = displayWOThenPO(order);
              const customerLabel = order.customer ? order.customer : "Work Order";
              const siteLoc = order.siteLocation || "";
              const siteAddr =
                order.siteAddress || order.serviceAddress || order.address || "";
              const isScheduled = !!order.scheduledDate;

              // Build a friendly current-time label if scheduled
              let currentWhen = "";
              if (isScheduled) {
                const s = fromDbString(order.scheduledDate);
                const e =
                  fromDbString(order.scheduledEnd) ||
                  (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : null);
                if (s) {
                  currentWhen = `${moment(s).format("MMM D, YYYY h:mm A")}${
                    e ? ` – ${moment(e).format("h:mm A")}` : ""
                  }`;
                }
              }

              return (
                <div
                  key={order.id}
                  className="unscheduled-item"
                  draggable
                  onDragStart={() => setDragItem(order)}
                  title={`${customerLabel} — ${idLabel}`}
                >
                  <div className="d-flex align-items-center justify-content-between" style={{ gap: 8 }}>
                    <div className="fw-bold" style={clamp1}>
                      {customerLabel} — {idLabel}
                    </div>
                    {isScheduled && (
                      <span className="badge text-bg-secondary">Scheduled</span>
                    )}
                  </div>

                  {siteLoc ? (
                    <small className="text-muted" style={clamp1}>
                      Site Location: {siteLoc}
                    </small>
                  ) : null}
                  {siteAddr ? (
                    <div>
                      <small className="text-muted" style={clamp2}>
                        Site Address: {siteAddr}
                      </small>
                    </div>
                  ) : null}

                  {isScheduled && currentWhen && (
                    <div className="mt-1">
                      <small className="text-muted">Current: {currentWhen}</small>
                    </div>
                  )}

                  <div className="unscheduled-actions">
                    <button
                      className="btn btn-xs btn-outline-light me-1"
                      onClick={() =>
                        openEditModal(
                          order,
                          currentDate // fallback date
                        )
                      }
                    >
                      {isScheduled ? "Edit/Reschedule…" : "Schedule…"}
                    </button>
                    <button
                      className="btn btn-xs btn-light me-1"
                      onClick={() => openStatusPicker(order)}
                    >
                      Status…
                    </button>
                    <button
                      className="btn btn-xs btn-light"
                      onClick={() => navigateToView(order.id)}
                    >
                      Open
                    </button>
                  </div>
                </div>
              );
            })}
            {!listForStrip.length && (
              <div className="empty-text">No matches for that search.</div>
            )}
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
            min={moment().startOf("day").add(6, "hours").toDate()} // 6 AM
            max={moment().startOf("day").add(21, "hours").toDate()} // 9 PM
            popup={false}
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

      {/* ---------- Day list modal (ACTUALLY WIDER) ---------- */}
      {dayModalOpen && (
        <div className="modal-overlay" onClick={() => setDayModalOpen(false)}>
          <div
            // Using a custom wide shell to avoid any width caps from .modal-content CSS
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 12,
              boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
              padding: 20,
              width: "min(1400px, 98vw)",
              maxHeight: "90vh",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <h4 className="mb-3">{dayModalTitle}</h4>
            {dayOrders.length ? (
              <ul className="list-group" style={{ overflowY: "auto" }}>
                {dayOrders.map((o, idx) => {
                  const s = fromDbString(o.scheduledDate);
                  const e = fromDbString(o.scheduledEnd);
                  const label =
                    s && e
                      ? `${moment(s).format("hh:mm A")} – ${moment(e).format("hh:mm A")}`
                      : s
                      ? `${moment(s).format("hh:mm A")} – ${moment(s)
                          .add(DEFAULT_WINDOW_MIN, "minutes")
                          .format("hh:mm A")}`
                      : "";
                  const idLabel = displayWOThenPO(o);
                  const siteLoc = o.siteLocation || "";
                  const siteAddr = o.siteAddress || o.serviceAddress || o.address || "";

                  return (
                    <li
                      key={o.id}
                      className="list-group-item"
                      draggable
                      onDragStart={() => handleDayDragStart(idx, o)}
                      onDragOver={(ev) => handleDayDragOver(ev, idx)}
                      onDrop={(ev) => handleDayDrop(ev, idx)}
                      style={{
                        cursor: "grab",
                        background:
                          overIndex === idx && dragIndex !== null ? "#f1f5f9" : "white",
                        display: "grid",
                        gridTemplateColumns: "1fr auto",
                        alignItems: "center",
                        gap: 16,
                      }}
                      title="Drag to reorder or onto the calendar"
                    >
                      {/* LEFT: details */}
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-bold" style={clamp1}>
                          {o.customer ? `${o.customer}` : `Work Order`} — {idLabel}
                        </div>
                        {siteLoc ? (
                          <small className="text-muted" style={clamp1}>
                            Site Location: {siteLoc}
                          </small>
                        ) : null}
                        {siteAddr ? (
                          <div>
                            <small className="text-muted" style={clamp2}>
                              Site Address: {siteAddr}
                            </small>
                          </div>
                        ) : null}
                        <div>
                          <small>{label}</small>
                        </div>
                      </div>

                      {/* RIGHT: actions */}
                      <div
                        className="d-flex align-items-center flex-wrap"
                        style={{ gap: 8, justifySelf: "end" }}
                      >
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => openEditModal(o, dayForModal)}
                        >
                          Edit Time…
                        </button>
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() => navigateToView(o.id)}
                        >
                          Open
                        </button>
                        <button
                          className="btn btn-sm btn-outline-dark"
                          onClick={() => openStatusPicker(o)}
                        >
                          Status…
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
              <button
                className="btn btn-secondary"
                onClick={() => setDayModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Quick Edit modal ---------- */}
      {editModalOpen && (
        <div className="modal-overlay" onClick={() => setEditModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3">Edit Schedule</h4>
            {editOrder && (
              <>
                <div className="mb-2" style={{ minWidth: 0 }}>
                  <div className="fw-bold" style={clamp1}>
                    {editOrder.customer ? `${editOrder.customer}` : `Work Order`} —{" "}
                    {displayWOThenPO(editOrder)}
                  </div>
                  {editOrder.problemDescription ? (
                    <small className="text-muted" style={clamp2}>
                      {editOrder.problemDescription}
                    </small>
                  ) : null}
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
                  <button
                    className="btn btn-outline-danger me-2"
                    onClick={() => unschedule(editOrder.id)}
                  >
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

      {/* ---------- Status Picker modal ---------- */}
      {statusModalOpen && (
        <div className="modal-overlay" onClick={cancelStatusChange}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3">Change Status</h4>
            {statusTarget ? (
              <>
                <div className="mb-2" style={{ minWidth: 0 }}>
                  <div className="fw-bold" style={clamp1}>
                    {statusTarget.customer ? statusTarget.customer : "Work Order"} —{" "}
                    {displayWOThenPO(statusTarget)}
                  </div>
                  <small className="text-muted">
                    Current: <strong>{statusTarget.status || "—"}</strong>
                  </small>
                </div>

                <div
                  className="list-group mb-3"
                  style={{ maxHeight: 260, overflowY: "auto" }}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`list-group-item list-group-item-action ${
                        statusChoice === s ? "active" : ""
                      }`}
                      onClick={() => setStatusChoice(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <div className="d-flex justify-content-end">
                  <button
                    className="btn btn-ghost btn-outline-secondary me-2"
                    onClick={cancelStatusChange}
                    disabled={statusSaving}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={confirmStatusChange}
                    disabled={statusSaving || !statusChoice}
                  >
                    {statusSaving ? "Saving…" : "Confirm"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
