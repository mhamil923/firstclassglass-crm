// =========================
// PART 1 / 3  (top of file)
// =========================
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
function fromDbString(val) {
  if (val == null) return null;
  if (val instanceof Date) return val;
  if (moment.isMoment(val)) return val.toDate();
  if (typeof val === "number" && Number.isFinite(val)) return new Date(val);

  const s = String(val);
  if (!s.trim()) return null;

  // Accept ISO, "YYYY-MM-DD", or "YYYY-MM-DD HH:mm:ss"
  if (moment(s, moment.ISO_8601, true).isValid()) return moment(s).toDate();

  const m =
    s.trim().length <= 10
      ? moment(s, "YYYY-MM-DD").startOf("day")
      : moment(s.replace("T", " "), "YYYY-MM-DD HH:mm:ss");

  return m.isValid() ? m.toDate() : null;
}

const fmtDate = (d) => moment(d).format("YYYY-MM-DD");
const fmtTime = (d) => moment(d).format("HH:mm");
const diffMinutes = (a, b) => Math.max(0, Math.round((+b - +a) / 60000));
const isSameDay = (a, b) => moment(a).isSame(b, "day");

const norm = (v) => (v ?? "").toString().trim().toLowerCase();

/** Safely get a nested value by trying multiple paths */
function pickFirst(obj, paths = []) {
  for (const path of paths) {
    const parts = path.split(".");
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null) {
      const s = String(cur).trim();
      if (s) return s;
    }
  }
  return "";
}

/** Robust Work Order / PO label resolver (handles meta + alternate server keys) */
const getWorkOrderNumber = (obj) =>
  pickFirst(obj, [
    "workOrderNumber",
    "work_order_number",
    "workOrderNo",
    "workOrderNO",
    "woNumber",
    "wo_number",
    "meta.workOrderNumber",
    "meta.work_order_number",
    "meta.workOrderNo",
    "meta.woNumber",
  ]);

const getPoNumber = (obj) =>
  pickFirst(obj, ["poNumber", "po_number", "poNo", "meta.poNumber", "meta.po_number", "meta.poNo"]);

const getSiteLocation = (obj) =>
  pickFirst(obj, [
    "siteLocation",
    "site_location",
    "siteName",
    "site_name",
    "location",
    "meta.siteLocation",
    "meta.site_location",
    "meta.siteName",
    "meta.location",
  ]);

// ✅ site address resolver (used for search + display)
const getSiteAddress = (obj) =>
  pickFirst(obj, [
    "siteAddress",
    "site_address",
    "serviceAddress",
    "service_address",
    "address",
    "meta.siteAddress",
    "meta.site_address",
    "meta.serviceAddress",
    "meta.address",
  ]);

/** Prefer Work Order #, else PO #, else N/A — and return a labeled string */
const displayWOThenPO = (obj) => {
  const wo = getWorkOrderNumber(obj);
  const po = getPoNumber(obj);
  if (wo) return `WO #${wo}`;
  if (po) return `PO #${po}`;
  return "N/A";
};

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
  const problem = event.problemDescription || event.meta?.problemDescription;

  const siteLocation = event.siteLocation ?? event.meta?.siteLocation ?? getSiteLocation(event);
  const siteAddress =
    event.siteAddress ?? event.meta?.siteAddress ?? event.serviceAddress ?? event.address ?? "";

  const popover = (
    <Popover id={`popover-${event.id}`}>
      <Popover.Header as="h3">
        {event.customer ? `${event.customer}` : `Work Order`} — {idLabel}
      </Popover.Header>
      <Popover.Body>
        {siteLocation ? (
          <div>
            <strong>Site Location:</strong> {siteLocation}
          </div>
        ) : null}
        {siteAddress ? (
          <div>
            <strong>Site Address:</strong> {siteAddress}
          </div>
        ) : null}
        {problem ? (
          <div style={{ marginTop: 6 }}>
            <strong>Problem:</strong>
            <div style={clamp4}>{problem}</div>
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

/* ============================================================
   ✅ Custom Toolbar
   - Fixes Week button position/order (Month, Week, Day, Agenda)
============================================================ */
function WeekToolbar(props) {
  const { label, onNavigate, onView, view } = props;

  return (
    <div className="rbc-toolbar">
      <span className="rbc-btn-group">
        <button type="button" onClick={() => onNavigate("TODAY")}>
          Today
        </button>
        <button type="button" onClick={() => onNavigate("PREV")}>
          Back
        </button>
        <button type="button" onClick={() => onNavigate("NEXT")}>
          Next
        </button>
      </span>

      <span className="rbc-toolbar-label">{label}</span>

      <span className="rbc-btn-group">
        <button
          type="button"
          className={view === "month" ? "rbc-active" : ""}
          onClick={() => onView("month")}
        >
          Month
        </button>
        <button
          type="button"
          className={view === "week" ? "rbc-active" : ""}
          onClick={() => onView("week")}
        >
          Week
        </button>
        <button
          type="button"
          className={view === "day" ? "rbc-active" : ""}
          onClick={() => onView("day")}
        >
          Day
        </button>
        <button
          type="button"
          className={view === "agenda" ? "rbc-active" : ""}
          onClick={() => onView("agenda")}
        >
          Agenda
        </button>
      </span>
    </div>
  );
}

/* ============================================================
   ✅ Week View (custom view for RBC)
   - Fixes the crash/blank page by implementing required view statics:
     range(), navigate(), title()
   - Each day has its own scroll area to see ALL work orders
============================================================ */
function StackedWeekView(props) {
  const {
    date,
    events = [],
    onSelectEvent,
    onDoubleClickEvent,
    dragFromOutsideItem,
    onDropFromOutside,
  } = props;

  const start = moment(date).startOf("week");
  const days = Array.from({ length: 7 }).map((_, i) => start.clone().add(i, "day").toDate());

  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const d of days) map.set(fmtDate(d), []);

    for (const ev of events) {
      const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate) || null;
      if (!s) continue;
      const key = fmtDate(s);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    }

    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => {
        const sa = fromDbString(a.start) || fromDbString(a.scheduledDate) || new Date(0);
        const sb = fromDbString(b.start) || fromDbString(b.scheduledDate) || new Date(0);
        return +sa - +sb;
      });
      map.set(k, arr);
    }

    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, fmtDate(date)]);

  const handleDropOnDay = (dayDate, e) => {
    e.preventDefault();
    const item = typeof dragFromOutsideItem === "function" ? dragFromOutsideItem() : null;
    if (!item || typeof onDropFromOutside !== "function") return;

    // Default drop time for Week stacked view: 8:00 AM
    const startTime = moment(dayDate).startOf("day").add(8, "hours").toDate();
    onDropFromOutside({ start: startTime });
  };

  return (
    <div className="stacked-week">
      <div className="stacked-week-grid">
        {days.map((d) => {
          const key = fmtDate(d);
          const list = eventsByDay.get(key) || [];

          return (
            <div
              key={key}
              className="stacked-day"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDropOnDay(d, e)}
            >
              <div className="stacked-day-header" title="Click day in Month view for full list modal">
                <div>
                  <div className="dow">{moment(d).format("ddd")}</div>
                  <div className="date">{moment(d).format("MMM D")}</div>
                </div>
                <div className="cw-day-count">{list.length}</div>
              </div>

              <div className="stacked-day-body">
                {list.length ? (
                  list.map((ev) => {
                    const idLabel = displayWOThenPO(ev);
                    const title = ev.customer ? `${ev.customer} — ${idLabel}` : idLabel;

                    const siteLoc = ev.siteLocation ?? ev.meta?.siteLocation ?? getSiteLocation(ev);
                    const siteAddr =
                      ev.siteAddress ?? ev.meta?.siteAddress ?? ev.serviceAddress ?? ev.address ?? "";

                    const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
                    const e2 = fromDbString(ev.end) || fromDbString(ev.scheduledEnd);
                    const timeLabel =
                      s && e2
                        ? `${moment(s).format("h:mm A")} – ${moment(e2).format("h:mm A")}`
                        : s
                        ? moment(s).format("h:mm A")
                        : "";

                    return (
                      <button
                        key={ev.id}
                        type="button"
                        className="week-event-card"
                        onClick={() => onSelectEvent && onSelectEvent(ev)}
                        onDoubleClick={() => onDoubleClickEvent && onDoubleClickEvent(ev)}
                        title={title}
                      >
                        <div className="title" style={clamp1}>
                          {title}
                        </div>
                        {timeLabel ? (
                          <div className="meta" style={clamp1}>
                            {timeLabel}
                          </div>
                        ) : null}
                        {siteLoc ? (
                          <div className="meta" style={clamp1}>
                            {siteLoc}
                          </div>
                        ) : null}
                        {siteAddr ? (
                          <div className="meta" style={clamp1}>
                            {siteAddr}
                          </div>
                        ) : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="empty-text">No work orders</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ✅ REQUIRED by react-big-calendar for custom views
 * Without these, clicking "Week" can crash/blank-screen.
 */
StackedWeekView.range = (date) => {
  const start = moment(date).startOf("week").toDate();
  const end = moment(date).endOf("week").toDate();
  return { start, end };
};

StackedWeekView.navigate = (date, action) => {
  switch (action) {
    case "PREV":
      return moment(date).subtract(1, "week").toDate();
    case "NEXT":
      return moment(date).add(1, "week").toDate();
    default:
      return date;
  }
};

StackedWeekView.title = (date, { localizer: loc }) => {
  const start = moment(date).startOf("week").toDate();
  const end = moment(date).endOf("week").toDate();
  return loc.format({ start, end }, "dayRangeHeaderFormat");
};
// =========================
// PART 2 / 3  (component logic)
// =========================
// File: src/CalendarPage.js
// Paste this starting at: `export default function WorkOrderCalendar() {`
// and ending right before the `return (` render block.

export default function WorkOrderCalendar() {
  // Full work order list (for search in the Unscheduled bar)
  const [allOrders, setAllOrders] = useState([]);
  // Scheduled events for the visible range
  const [events, setEvents] = useState([]);
  // Unscheduled strip data
  const [unscheduledOrders, setUnscheduledOrders] = useState([]);
  const [unscheduledSearch, setUnscheduledSearch] = useState("");

  // Calendar view/range
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

  // Status modal
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState(null);
  const [statusChoice, setStatusChoice] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);

  /* ========= initial fetches ========= */
  useEffect(() => {
    refreshLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refresh calendar events whenever the visible range changes
  useEffect(() => {
    fetchCalendarForVisibleRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentDate]);

  const refreshLists = useCallback(async () => {
    try {
      const [allRes, unRes] = await Promise.all([
        api.get("/work-orders"),
        api.get("/work-orders/unscheduled"),
      ]);
      setAllOrders(Array.isArray(allRes.data) ? allRes.data : []);
      setUnscheduledOrders(Array.isArray(unRes.data) ? unRes.data : []);
    } catch (e) {
      console.error("⚠️ Error loading lists:", e);
    }
  }, []);

  /* ========= /calendar/events ========= */
  function visibleRangeFor(viewName, anchorDate) {
    const m = moment(anchorDate);
    switch (viewName) {
      case "day": {
        const start = m.clone().startOf("day");
        const end = m.clone().endOf("day");
        return { start: start.format("YYYY-MM-DD"), end: end.format("YYYY-MM-DD") };
      }
      case "week": {
        const start = m.clone().startOf("week");
        const end = m.clone().endOf("week");
        return { start: start.format("YYYY-MM-DD"), end: end.format("YYYY-MM-DD") };
      }
      case "agenda":
      case "month":
      default: {
        const start = m.clone().startOf("month").startOf("week");
        const end = m.clone().endOf("month").endOf("week");
        return { start: start.format("YYYY-MM-DD"), end: end.format("YYYY-MM-DD") };
      }
    }
  }

  const fetchCalendarForVisibleRange = useCallback(async () => {
    try {
      const { start, end } = visibleRangeFor(view, currentDate);
      const { data } = await api.get("/calendar/events", { params: { start, end } });
      const list = Array.isArray(data) ? data : [];

      const mapped = list.map((ev) => {
        const startD = fromDbString(ev.start) || fromDbString(ev.scheduledDate) || new Date();
        const endD =
          fromDbString(ev.end) ||
          fromDbString(ev.scheduledEnd) ||
          moment(startD).add(DEFAULT_WINDOW_MIN, "minutes").toDate();

        return {
          ...ev,
          // normalize times
          start: startD,
          end: endD,

          // normalize common fields
          customer: ev.meta?.customer ?? ev.customer,
          siteLocation: ev.meta?.siteLocation ?? ev.siteLocation ?? getSiteLocation(ev),
          siteAddress: ev.meta?.siteAddress ?? ev.siteAddress ?? getSiteAddress(ev),
          problemDescription: ev.meta?.problemDescription ?? ev.problemDescription,

          // normalize identifiers so WO # stops showing N/A
          workOrderNumber: getWorkOrderNumber(ev),
          poNumber: getPoNumber(ev),
        };
      });

      setEvents(mapped);
    } catch (e) {
      console.error("⚠️ Error fetching calendar:", e);
    }
  }, [view, currentDate]);

  /* ===== schedule helpers (MULTER route requires multipart/form-data) ===== */
  async function setSchedulePayload(orderId, { date, time, endTime, status }) {
    const form = new FormData();
    const startStr = `${date} ${time}`;
    form.append("scheduledDate", startStr);
    if (endTime) form.append("endTime", endTime);
    form.append("status", status || "Scheduled");

    await api.put(`/work-orders/${orderId}/edit`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  }

  function minutesWindowForOrder(orderLike) {
    const start = fromDbString(orderLike.scheduledDate || orderLike.start);
    const end = fromDbString(orderLike.scheduledEnd || orderLike.end);
    if (start && end) return Math.max(15, diffMinutes(start, end));
    return DEFAULT_WINDOW_MIN;
  }

  /* ===== edit modal wiring ===== */
  function openEditModal(order, fallbackDate) {
    const start = fromDbString(order?.scheduledDate || order?.start) || fallbackDate || new Date();
    const end =
      fromDbString(order?.scheduledEnd || order?.end) ||
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
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error saving schedule:", e);
      alert("Failed to save schedule.");
    }
  }

  async function unschedule(orderId) {
    if (!window.confirm("Remove this work order from the calendar?")) return;
    try {
      const form = new FormData();
      form.append("scheduledDate", "");
      form.append("status", "Needs to be Scheduled");

      await api.put(`/work-orders/${orderId}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setEditModalOpen(false);
      if (dayForModal) await openDayModal(dayForModal);
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error unscheduling:", e);
      alert("Failed to unschedule.");
    }
  }

  /* ===== Day modal helpers — STRICT to the clicked day ===== */
  async function openDayModal(dateLike) {
    const day = moment(dateLike).startOf("day");
    const dateStr = day.format("YYYY-MM-DD");
    const startExact = `${dateStr} 00:00:00`;
    const endExact = `${dateStr} 23:59:59`;

    try {
      // 1) Prefer dedicated endpoint if available
      let list = [];
      try {
        const dayRes = await api.get("/calendar/day", { params: { date: dateStr } });
        if (Array.isArray(dayRes.data)) list = dayRes.data;
      } catch {
        // ignore -> fallback
      }

      // 2) Fallback to bounded range
      if (!list.length) {
        const { data } = await api.get("/calendar/events", {
          params: { start: startExact, end: endExact },
        });
        list = Array.isArray(data) ? data : [];
      }

      // 3) SAFEGUARD: filter to exact day client-side + normalize identifiers
      const normalized = list
        .map((ev) => {
          const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
          const e =
            fromDbString(ev.end) ||
            fromDbString(ev.scheduledEnd) ||
            (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : null);

          return {
            id: ev.id,
            customer: ev.meta?.customer ?? ev.customer,
            siteLocation: ev.meta?.siteLocation ?? ev.siteLocation ?? getSiteLocation(ev),
            siteAddress: ev.meta?.siteAddress ?? ev.siteAddress ?? getSiteAddress(ev),
            workOrderNumber: getWorkOrderNumber(ev),
            poNumber: getPoNumber(ev),
            problemDescription: ev.meta?.problemDescription ?? ev.problemDescription,
            scheduledDate: s,
            scheduledEnd: e,
            serviceAddress: ev.serviceAddress,
            address: ev.address,
            status: ev.status ?? ev.meta?.status,
          };
        })
        .filter((o) => o.scheduledDate && isSameDay(o.scheduledDate, day));

      normalized.sort((a, b) => {
        const sa = a.scheduledDate ? +a.scheduledDate : 0;
        const sb = b.scheduledDate ? +b.scheduledDate : 0;
        return sa - sb;
      });

      setDayOrders(normalized);
      setDayForModal(day.toDate());
      setDayModalTitle(`Work Orders for ${day.format("LL")}`);
      setDayModalOpen(true);
    } catch (e) {
      console.error("⚠️ Error loading day:", e);
      alert("Failed to load that day.");
    }
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
      .then(async () => {
        if (dayForModal) await openDayModal(dayForModal);
        await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
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
      .then(async () => {
        if (dayForModal) await openDayModal(dayForModal);
        await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
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
      .then(async () => {
        endGlobalDrag();
        if (dayForModal) await openDayModal(dayForModal);
        await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
      })
      .catch((e) => console.error("⚠️ Error scheduling work order:", e));
  }

  function onSelectEvent(event) {
    const full = allOrders.find((o) => Number(o.id) === Number(event.id)) || event;
    openEditModal(full);
  }

  function onSelectSlot(slotInfo) {
    openDayModal(slotInfo.start);
  }

  function onShowMore(_eventsInCell, date) {
    openDayModal(date);
  }

  function navigateToView(id) {
    window.location.href = `/view-work-order/${id}`;
  }

  /* ===== Build RBC events from server events ===== */
  const rbcEvents = useMemo(() => {
    return events.map((o) => {
      const start = fromDbString(o.start) || new Date();
      const end = fromDbString(o.end) || moment(start).add(DEFAULT_WINDOW_MIN, "minutes").toDate();

      const idLabel = displayWOThenPO(o);
      const title = o.customer ? `${o.customer} — ${idLabel}` : idLabel;

      return {
        ...o,
        title,
        start,
        end,
        allDay: false,
      };
    });
  }, [events]);

  /* ===== Unscheduled bar search (includes Site Address) ===== */
  const listForStrip = useMemo(() => {
    const q = norm(unscheduledSearch);
    if (!q) return unscheduledOrders;

    const tokens = q.split(/\s+/).filter(Boolean);
    const pool = allOrders;

    return pool.filter((o) => {
      const hayCustomer = norm(o.customer);
      const hayPO = norm(getPoNumber(o));
      const hayWO = norm(getWorkOrderNumber(o));
      const haySiteLoc = norm(getSiteLocation(o));
      const haySiteAddr = norm(getSiteAddress(o));

      return tokens.every(
        (t) =>
          hayCustomer.includes(t) ||
          hayPO.includes(t) ||
          hayWO.includes(t) ||
          haySiteLoc.includes(t) ||
          haySiteAddr.includes(t)
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
      try {
        await api.put(`/work-orders/${statusTarget.id}/status`, { status: statusChoice });
      } catch {
        const fd = new FormData();
        fd.append("status", statusChoice);
        await api.put(`/work-orders/${statusTarget.id}/edit`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      setStatusModalOpen(false);
      if (dayForModal) await openDayModal(dayForModal);
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
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
// =========================
// PART 3 / 3  (render block)
// =========================
// File: src/CalendarPage.js
// Paste this starting at: `return (`
// and replace your entire current return JSX through the end of the component.

  return (
    <div className="calendar-page" onDragEnd={endGlobalDrag}>
      <div className="container-fluid p-0">
        <h2 className="calendar-title">Work Order Calendar</h2>

        {/* Search & Unscheduled strip */}
        <div className="unscheduled-container">
          <div
            className="d-flex align-items-center justify-content-between flex-wrap"
            style={{ gap: 12 }}
          >
            <h4 className="mb-0">
              {unscheduledSearch
                ? "Search Results (All Work Orders)"
                : "Unscheduled Work Orders"}
            </h4>

            <div className="input-group" style={{ maxWidth: 620 }}>
              <input
                type="text"
                className="form-control"
                placeholder="Search customer, site location, site address, WO #, or PO # (includes scheduled)"
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

          <div className="text-muted mt-2" style={{ fontSize: 12 }}>
            {unscheduledSearch ? (
              <>
                Showing {listForStrip.length} match
                {listForStrip.length === 1 ? "" : "es"} across {allOrders.length} total
                work order{allOrders.length === 1 ? "" : "s"} (drag any item to
                schedule/reschedule).
              </>
            ) : (
              <>Showing {listForStrip.length} item(s) (from /work-orders/unscheduled)</>
            )}
          </div>

          <div className="unscheduled-list">
            {listForStrip.map((order) => {
              const idLabel = displayWOThenPO(order);
              const customerLabel = order.customer ? order.customer : "Work Order";
              const siteLoc = getSiteLocation(order) || "";
              const siteAddr = getSiteAddress(order) || "";
              const isScheduled = !!order.scheduledDate;

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
                  <div
                    className="d-flex align-items-center justify-content-between"
                    style={{ gap: 8 }}
                  >
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

                  {isScheduled && currentWhen ? (
                    <div className="mt-1">
                      <small className="text-muted">Current: {currentWhen}</small>
                    </div>
                  ) : null}

                  <div className="unscheduled-actions">
                    <button
                      className="btn btn-xs btn-outline-light me-1"
                      onClick={() => openEditModal(order, currentDate)}
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
            {!listForStrip.length && <div className="empty-text">No matches.</div>}
          </div>
        </div>

        {/* Calendar */}
        <div className="calendar-container">
          <DnDCalendar
            localizer={localizer}
            events={rbcEvents}
            startAccessor="start"
            endAccessor="end"
            step={15}
            timeslots={4}
            min={moment().startOf("day").add(6, "hours").toDate()}
            max={moment().startOf("day").add(21, "hours").toDate()}
            selectable

            draggableAccessor={() => true}
            dragFromOutsideItem={() => dragItem}
            onDropFromOutside={handleDropFromOutside}

            onEventDrop={handleEventDrop}
            onEventResize={handleEventResize}

            onSelectEvent={onSelectEvent}
            onDoubleClickEvent={(e) => navigateToView(e.id)}
            onSelectSlot={onSelectSlot}
            onShowMore={onShowMore}

            /* ✅ FIX: keep Week from crashing + keep toolbar placement correct
               - Use RBC view system (views prop) so toolbar renders all view buttons correctly
               - Use our custom stacked week view for "week"
               - DO NOT replace the toolbar with a custom one (that’s what was moving buttons around)
            */
            views={{
              month: true,
              week: StackedWeekView,
              day: true,
              agenda: true,
            }}

            /* ✅ FIX: onView MUST accept and set the view string, nothing else */
            view={view}
            onView={(v) => setView(v)}

            /* ✅ FIX: onNavigate should accept date */
            date={currentDate}
            onNavigate={(d) => setCurrentDate(d)}

            /* event rendering */
            components={{
              event: CustomEvent,
            }}

            /* ✅ Month should show the full month again:
               - remove the forced short height that made it look like a partial month
               - let RBC size itself, but still keep a comfortable minimum height
            */
            style={{ height: "auto", minHeight: "78vh" }}

            /* ✅ keep multi-events visible */
            showAllEvents

            /* only meaningful in timed Day view */
            resizable={view === "day"}

            /* keep it simple */
            popup={false}
          />
        </div>
      </div>

      {/* ---------- Day list modal ---------- */}
      {dayModalOpen && (
        <div className="modal-overlay" onClick={() => setDayModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{dayModalTitle}</h3>
              <button
                className="modal-close"
                onClick={() => setDayModalOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              {dayOrders.length ? (
                <div className="modal-list">
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th style={{ width: 120 }}>Time</th>
                        <th>Work Order</th>
                        <th style={{ width: 380 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayOrders.map((o) => {
                        const s = fromDbString(o.scheduledDate);
                        const e = fromDbString(o.scheduledEnd);
                        const label =
                          s && e
                            ? `${moment(s).format("hh:mm A")} – ${moment(e).format("hh:mm A")}`
                            : s
                            ? `${moment(s).format("hh:mm A")} – ${moment(s)
                                .add(DEFAULT_WINDOW_MIN, "minutes")
                                .format("hh:mm A")}`
                            : "—";

                        const idLabel = displayWOThenPO(o);
                        const siteLoc = getSiteLocation(o) || o.siteLocation || "";
                        const siteAddr = getSiteAddress(o) || "";

                        return (
                          <tr key={o.id}>
                            <td>{label}</td>
                            <td style={{ minWidth: 0 }}>
                              <div className="fw-bold" style={clamp1}>
                                {o.customer ? `${o.customer}` : `Work Order`} — {idLabel}
                              </div>
                              {siteLoc ? (
                                <div className="text-muted" style={clamp1}>
                                  Site Location: {siteLoc}
                                </div>
                              ) : null}
                              {siteAddr ? (
                                <div className="text-muted" style={clamp2}>
                                  Site Address: {siteAddr}
                                </div>
                              ) : null}
                            </td>
                            <td>
                              <div
                                className="d-flex align-items-center flex-wrap"
                                style={{ gap: 8 }}
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
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty-text mb-0">No work orders scheduled on this day.</p>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setDayModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Quick Edit modal ---------- */}
      {editModalOpen && (
        <div className="modal-overlay" onClick={() => setEditModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Schedule</h3>
              <button
                className="modal-close"
                onClick={() => setEditModalOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              {editOrder && (
                <>
                  <div className="mb-2" style={{ minWidth: 0 }}>
                    <div className="fw-bold" style={clamp1}>
                      {editOrder.customer ? `${editOrder.customer}` : `Work Order`} —{" "}
                      {displayWOThenPO(editOrder)}
                    </div>
                    {editOrder.problemDescription ? (
                      <div className="text-muted" style={clamp2}>
                        {editOrder.problemDescription}
                      </div>
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
        </div>
      )}

      {/* ---------- Status Picker modal ---------- */}
      {statusModalOpen && (
        <div className="modal-overlay" onClick={cancelStatusChange}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Change Status</h3>
              <button
                className="modal-close"
                onClick={cancelStatusChange}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              {statusTarget ? (
                <>
                  <div className="mb-2" style={{ minWidth: 0 }}>
                    <div className="fw-bold" style={clamp1}>
                      {statusTarget.customer ? statusTarget.customer : "Work Order"} —{" "}
                      {displayWOThenPO(statusTarget)}
                    </div>
                    <div className="text-muted">
                      Current: <strong>{statusTarget.status || "—"}</strong>
                    </div>
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
        </div>
      )}
    </div>
  );
}
