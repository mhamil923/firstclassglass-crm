// File: src/CalendarPage.js
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import api from "./api";
import { Calendar, momentLocalizer } from "react-big-calendar";
import moment from "moment";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import { OverlayTrigger, Popover } from "react-bootstrap";

import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
// Note: Bootstrap is imported in index.js
import "./Calendar.css";

const localizer = momentLocalizer(moment);
const DnDCalendar = withDragAndDrop(Calendar);

/* Stable identities for react-big-calendar.
   These used to be inline literals in the JSX, so every parent render handed RBC
   a brand-new `views` / `components` / `min` / `max` / `style` object. RBC keys a
   lot of internal memoization off those props, so fresh identities defeat it and
   the whole grid reconciles on every unrelated state change. */
const RBC_MIN = moment().startOf("day").add(6, "hours").toDate();
const RBC_MAX = moment().startOf("day").add(21, "hours").toDate();
const RBC_STYLE_MONTH = { height: "auto", minHeight: "78vh" };
const RBC_STYLE_WEEK = { height: "auto", minHeight: "86vh" };
const RBC_COMPONENTS = { event: CustomEvent };
// StackedWeekView / StackedDayView / CardAgendaView are hoisted function
// declarations, so referencing them here at module-eval time is fine.
const RBC_VIEWS = {
  month: true,
  week: StackedWeekView,
  day: StackedDayView,
  agenda: CardAgendaView,
};
const alwaysDraggable = () => true;

// ✅ Context lets the custom Day view (defined at module scope) access
// parent state like the tech list and the assign-tech handler.
const CalendarTechContext = createContext({
  techs: [],
  onAssignTech: () => {},
  techSavedId: null,
  supplierPickups: [],
});

// Keep this in sync with server DEFAULT_WINDOW_MINUTES
const DEFAULT_WINDOW_MIN = 120;

// Statuses that mean the WO is done/dead and should not show up as scheduling work.
// Used to filter the Unscheduled bar + Past Due strip, and to hide schedule actions
// on these orders when they appear in search results.
const EXCLUDED_FROM_SCHEDULING = new Set([
  "Completed",
  "Declined",
  "Invoiced Waiting for Payment",
]);

// Keep this in sync with ViewWorkOrder.js and WorkOrders.js
const STATUS_OPTIONS = [
  "New",
  "Scheduled",
  "Needs to be Quoted",
  "Waiting for Approval",
  "Declined",
  "Approved",
  "Waiting on Parts",
  "Needs to be Scheduled",
  "Needs to be Invoiced",
  "Invoiced Waiting for Payment",
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

// Whole days between a past scheduled date and today (0 = due today).
const daysLate = (scheduledDate) => {
  if (!scheduledDate) return null;
  const d = fromDbString(scheduledDate);
  if (!d) return null;
  return Math.max(0, moment().startOf("day").diff(moment(d).startOf("day"), "days"));
};

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
  // Supplier pickups render as a distinct orange pill card (no popover, click → POs filtered)
  if (event?.kind === "pickup") {
    return (
      <div
        onClick={(e) => {
          e.stopPropagation();
          window.location.href = `/purchase-orders?supplier=${encodeURIComponent(event.supplier || "")}`;
        }}
        style={{
          background: "#f97316",
          borderRadius: 20,
          padding: "3px 10px",
          fontSize: 12,
          color: "#fff",
          cursor: "pointer",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
          fontWeight: 500,
        }}
        title={`Supplier Pickup — ${event.supplier}${event.assignedTech ? ` · ${event.assignedTech}` : ""}`}
      >
        📦 {event.supplier}
      </div>
    );
  }

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
      <span className="cal-chip" title={event.title}>
        {idLabel && idLabel !== "N/A" ? (
          <span className="cal-chip-id">{idLabel}</span>
        ) : null}
        <span className="cal-chip-name">{event.customer || event.title}</span>
      </span>
    </OverlayTrigger>
  );
}

/* ============================================================
   ✅ Week View (custom view for RBC)
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

  const { supplierPickups = [] } = useContext(CalendarTechContext);

  const start = moment(date).startOf("week");
  const days = Array.from({ length: 7 }).map((_, i) => start.clone().add(i, "day").toDate());

  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const d of days) map.set(fmtDate(d), []);

    for (const ev of events) {
      // Skip pickup events — rendered separately from supplierPickups state below.
      if (ev.kind === "pickup") continue;
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
  }, [events, date]);

  const handleDropOnDay = (dayDate, e) => {
    e.preventDefault();
    const item = typeof dragFromOutsideItem === "function" ? dragFromOutsideItem() : null;
    if (!item || typeof onDropFromOutside !== "function") return;

    // Default drop time for Week stacked view: 12:00 PM (noon)
    const startTime = moment(dayDate).startOf("day").add(12, "hours").toDate();
    onDropFromOutside({ start: startTime });
  };

  // Use CSS classes for theming (defined in Calendar.css)
  return (
    <div className="stacked-week">
      <div className="stacked-week-grid">
        {days.map((d) => {
          const key = fmtDate(d);
          const list = eventsByDay.get(key) || [];
          const isToday = moment(d).isSame(moment(), "day");

          return (
            <div
              key={key}
              className="stacked-day"
              style={{
                minHeight: "72vh",
                outline: isToday ? "2px solid var(--accent-blue)" : "none",
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDropOnDay(d, e)}
            >
              <div className="stacked-day-header">
                <div style={{ minWidth: 0 }}>
                  <div className="dow">{moment(d).format("ddd")}</div>
                  <div className="date">{moment(d).format("MMM D")}</div>
                </div>
                <div className="cw-day-count" title={`${list.length} work order(s)`}>
                  {list.length}
                </div>
              </div>

              <div className="stacked-day-body">
                {list.map((ev) => {
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
                      <div className="title" style={{ ...clamp2 }}>
                        {title}
                      </div>
                      {timeLabel ? (
                        <div className="meta" style={{ ...clamp1 }}>
                          {timeLabel}
                        </div>
                      ) : null}
                      {siteLoc ? (
                        <div className="meta" style={{ ...clamp1 }}>
                          {siteLoc}
                        </div>
                      ) : null}
                      {siteAddr ? (
                        <div className="meta" style={{ ...clamp2 }}>
                          {siteAddr}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
                {supplierPickups.filter(p=>(p.scheduledDate||'').split('T')[0]===key).map(p=>(
                  <div key={'sp-'+p.id}
                    onClick={() => window.location.href = `/purchase-orders?supplier=${encodeURIComponent(p.supplier)}`}
                    style={{background:'#f97316',borderRadius:20,padding:'3px 10px',marginBottom:3,fontSize:12,color:'#fff',cursor:'pointer',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',fontWeight:500}}>
                    📦 {p.supplier}
                  </div>
                ))}
                {!list.length &&
                  !supplierPickups.some(
                    (p) => (p.scheduledDate || "").split("T")[0] === key
                  ) && <div className="empty-text">No work orders</div>}
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

/* ============================================================
   ✅ Day View (custom card-based view — no time grid)
============================================================ */
function StackedDayView(props) {
  const {
    date,
    events = [],
    onSelectEvent,
    onDoubleClickEvent,
    dragFromOutsideItem,
    onDropFromOutside,
  } = props;

  const { techs, onAssignTech, techSavedId, supplierPickups = [] } = useContext(CalendarTechContext);

  const day = moment(date).startOf("day");
  const dayKey = day.format("YYYY-MM-DD");

  const list = useMemo(() => {
    const items = events.filter((ev) => {
      // Skip pickup events — rendered separately from supplierPickups state below.
      if (ev.kind === "pickup") return false;
      const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
      return s && isSameDay(s, day.toDate());
    });
    items.sort((a, b) => {
      const sa = fromDbString(a.start) || fromDbString(a.scheduledDate) || new Date(0);
      const sb = fromDbString(b.start) || fromDbString(b.scheduledDate) || new Date(0);
      return +sa - +sb;
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, date]);

  const handleDrop = (e) => {
    e.preventDefault();
    const item = typeof dragFromOutsideItem === "function" ? dragFromOutsideItem() : null;
    if (!item || typeof onDropFromOutside !== "function") return;
    // Default drop time for Day stacked view: 12:00 PM (noon)
    const startTime = day.clone().add(12, "hours").toDate();
    onDropFromOutside({ start: startTime });
  };

  const isToday = day.isSame(moment(), "day");

  return (
    <div className="stacked-week stacked-day-view-wrap">
      <div
        className="stacked-day stacked-day-single"
        style={{
          minHeight: "72vh",
          outline: isToday ? "2px solid var(--accent-blue)" : "none",
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="stacked-day-header">
          <div style={{ minWidth: 0 }}>
            <div className="dow">{day.format("dddd")}</div>
            <div className="date">{day.format("MMMM D, YYYY")}</div>
          </div>
          <div className="cw-day-count" title={`${list.length} work order(s)`}>
            {list.length}
          </div>
        </div>

        <div className="stacked-day-body">
          {list.length || supplierPickups.some((p) => (p.scheduledDate || "").split("T")[0] === dayKey) ? (
            <>
            {list.map((ev) => {
              const idLabel = displayWOThenPO(ev);
              const title = ev.customer ? `${ev.customer} — ${idLabel}` : idLabel;

              const siteLoc = ev.siteLocation ?? ev.meta?.siteLocation ?? getSiteLocation(ev);
              const siteAddr =
                ev.siteAddress ?? ev.meta?.siteAddress ?? ev.serviceAddress ?? ev.address ?? "";

              // Coerce assigned tech id to string so <select value> matches <option value>
              const techId = ev.assignedTo ? String(ev.assignedTo) : "";

              return (
                <div key={ev.id} className="week-event-card week-event-card-day">
                  <div
                    className="week-event-card-body"
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectEvent && onSelectEvent(ev)}
                    onDoubleClick={() => onDoubleClickEvent && onDoubleClickEvent(ev)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectEvent && onSelectEvent(ev);
                      }
                    }}
                    title={title}
                  >
                    <div className="title" style={{ ...clamp2 }}>
                      {title}
                    </div>
                    {siteLoc ? (
                      <div className="meta" style={{ ...clamp1 }}>
                        {siteLoc}
                      </div>
                    ) : null}
                    {siteAddr ? (
                      <div className="meta" style={{ ...clamp2 }}>
                        {siteAddr}
                      </div>
                    ) : null}
                  </div>

                  {/* Tech assignment row — same control as the day modal */}
                  <div
                    className="week-event-card-tech"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <label className="week-event-tech-label">Tech</label>
                    <select
                      className="dm-tech-select"
                      value={techId}
                      onChange={(e) => onAssignTech(ev.id, e.target.value)}
                      style={{
                        WebkitAppearance: "auto",
                        MozAppearance: "auto",
                        appearance: "auto",
                        backgroundColor: "#2c2c2e",
                        color: "#f5f5f7",
                        border: "1px solid rgba(255, 255, 255, 0.15)",
                        borderRadius: "8px",
                        padding: "6px 12px",
                        fontSize: "13px",
                        cursor: "pointer",
                        outline: "none",
                        minWidth: "120px",
                        backgroundImage: "none",
                      }}
                    >
                      <option value="">Unassigned</option>
                      {techs.map((t) => (
                        <option key={t.id} value={String(t.id)}>
                          {t.username}
                        </option>
                      ))}
                    </select>
                    {techSavedId === ev.id && (
                      <span className="dm-saved-check">✓</span>
                    )}
                  </div>
                </div>
              );
            })}
            {supplierPickups.filter(p=>(p.scheduledDate||'').split('T')[0]===dayKey).map(p=>(
              <div key={'sp-'+p.id}
                onClick={() => window.location.href = `/purchase-orders?supplier=${encodeURIComponent(p.supplier)}`}
                style={{background:'#f97316',borderRadius:20,padding:'3px 10px',marginBottom:3,fontSize:12,color:'#fff',cursor:'pointer',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',fontWeight:500}}>
                📦 {p.supplier}
              </div>
              ))}
            </>
          ) : (
            <div className="empty-text">No work orders</div>
          )}
        </div>
      </div>
    </div>
  );
}

StackedDayView.range = (date) => {
  const start = moment(date).startOf("day").toDate();
  const end = moment(date).endOf("day").toDate();
  return { start, end };
};

StackedDayView.navigate = (date, action) => {
  switch (action) {
    case "PREV":
      return moment(date).subtract(1, "day").toDate();
    case "NEXT":
      return moment(date).add(1, "day").toDate();
    default:
      return date;
  }
};

StackedDayView.title = (date) => moment(date).format("dddd, MMMM D, YYYY");

/* ============================================================
   ✅ Agenda View (custom card-based, grouped by day)
============================================================ */
const AGENDA_DAYS = 30;

function CardAgendaView(props) {
  const { date, events = [], onSelectEvent, onDoubleClickEvent } = props;

  const { supplierPickups = [] } = useContext(CalendarTechContext);

  const groups = useMemo(() => {
    const start = moment(date).startOf("day");
    const end = moment(date).add(AGENDA_DAYS, "days").endOf("day");

    const filtered = events.filter((ev) => {
      // Skip pickup events — rendered separately from supplierPickups state below.
      if (ev.kind === "pickup") return false;
      const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
      return s && moment(s).isBetween(start, end, null, "[]");
    });
    filtered.sort((a, b) => {
      const sa = fromDbString(a.start) || fromDbString(a.scheduledDate) || new Date(0);
      const sb = fromDbString(b.start) || fromDbString(b.scheduledDate) || new Date(0);
      return +sa - +sb;
    });

    const map = new Map();
    for (const ev of filtered) {
      const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
      const key = fmtDate(s);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    }
    return Array.from(map.entries());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, date]);

  return (
    <div className="agenda-cards">
      {groups.length ? (
        groups.map(([key, list]) => {
          const d = moment(key);
          const isToday = d.isSame(moment(), "day");
          return (
            <div
              key={key}
              className="agenda-day-group"
              style={{ outline: isToday ? "2px solid var(--accent-blue)" : "none" }}
            >
              <div className="agenda-day-header">
                <div style={{ minWidth: 0 }}>
                  <div className="dow">{d.format("dddd")}</div>
                  <div className="date">{d.format("MMMM D, YYYY")}</div>
                </div>
                <div className="cw-day-count" title={`${list.length} work order(s)`}>
                  {list.length}
                </div>
              </div>

              <div className="agenda-day-body">
                {list.map((ev) => {
                  const idLabel = displayWOThenPO(ev);
                  const title = ev.customer ? `${ev.customer} — ${idLabel}` : idLabel;
                  const siteLoc =
                    ev.siteLocation ?? ev.meta?.siteLocation ?? getSiteLocation(ev);
                  const siteAddr =
                    ev.siteAddress ?? ev.meta?.siteAddress ?? ev.serviceAddress ?? ev.address ?? "";

                  return (
                    <button
                      key={ev.id}
                      type="button"
                      className="week-event-card"
                      onClick={() => onSelectEvent && onSelectEvent(ev)}
                      onDoubleClick={() => onDoubleClickEvent && onDoubleClickEvent(ev)}
                      title={title}
                    >
                      <div className="title" style={{ ...clamp2 }}>
                        {title}
                      </div>
                      {siteLoc ? (
                        <div className="meta" style={{ ...clamp1 }}>
                          {siteLoc}
                        </div>
                      ) : null}
                      {siteAddr ? (
                        <div className="meta" style={{ ...clamp2 }}>
                          {siteAddr}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
                {supplierPickups.filter(p=>(p.scheduledDate||'').split('T')[0]===key).map(p=>(
                  <div key={'sp-'+p.id}
                    onClick={() => window.location.href = `/purchase-orders?supplier=${encodeURIComponent(p.supplier)}`}
                    style={{background:'#f97316',borderRadius:20,padding:'3px 10px',marginBottom:3,fontSize:12,color:'#fff',cursor:'pointer',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',fontWeight:500}}>
                    📦 {p.supplier}
                  </div>
                ))}
              </div>
            </div>
          );
        })
      ) : (
        <div className="empty-text" style={{ padding: "40px", textAlign: "center" }}>
          No work orders in this range
        </div>
      )}
    </div>
  );
}

CardAgendaView.range = (date) => {
  const start = moment(date).startOf("day").toDate();
  const end = moment(date).add(AGENDA_DAYS, "days").endOf("day").toDate();
  return { start, end };
};

CardAgendaView.navigate = (date, action) => {
  switch (action) {
    case "PREV":
      return moment(date).subtract(AGENDA_DAYS, "days").toDate();
    case "NEXT":
      return moment(date).add(AGENDA_DAYS, "days").toDate();
    default:
      return date;
  }
};

CardAgendaView.title = (date) => {
  const start = moment(date);
  const end = moment(date).add(AGENDA_DAYS, "days");
  return `${start.format("MMM D, YYYY")} – ${end.format("MMM D, YYYY")}`;
};

export default function WorkOrderCalendar() {
  // Full work order list (for search in the Unscheduled bar)
  const [allOrders, setAllOrders] = useState([]);
  // Scheduled events for the visible range
  const [events, setEvents] = useState([]);
  // Unscheduled strip data
  const [unscheduledOrders, setUnscheduledOrders] = useState([]);
  const [unscheduledSearch, setUnscheduledSearch] = useState("");

  // Lightweight toast, used to report a failed optimistic scheduling change.
  const [toast, setToast] = useState(null); // { msg, kind }
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg, kind = "info") => {
    setToast({ msg, kind });
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  // Past Due strip data
  const [pastDueOrders, setPastDueOrders] = useState([]);
  const [showPastDue, setShowPastDue] = useState(true);

  // Supplier pickups (a separate calendar event type rendered in orange)
  const [supplierPickups, setSupplierPickups] = useState([]);
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [pickupSupplier, setPickupSupplier] = useState('');
  const [pickupTech, setPickupTech] = useState('');
  const [pickupNotes, setPickupNotes] = useState('');
  const [supplierList, setSupplierList] = useState([]);

  // Calendar view/range
  const [view, setView] = useState("month");
  const [currentDate, setCurrentDate] = useState(new Date());

  // Day list modal
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [dayModalTitle, setDayModalTitle] = useState("");
  const [dayOrders, setDayOrders] = useState([]);
  const [dayForModal, setDayForModal] = useState(null);

  // Tech list for assignment dropdown
  const [techs, setTechs] = useState([]);

  // Inline edit-time state (card ID being edited)
  const [inlineEditId, setInlineEditId] = useState(null);
  const [inlineStartTime, setInlineStartTime] = useState("");
  const [inlineEndTime, setInlineEndTime] = useState("");

  // Tech assignment saving feedback
  const [techSavedId, setTechSavedId] = useState(null);

  // Quick edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editOrder, setEditOrder] = useState(null);
  const [editDate, setEditDate] = useState(""); // yyyy-mm-dd
  const [editTime, setEditTime] = useState(""); // HH:mm
  const [editEndTime, setEditEndTime] = useState(""); // HH:mm (window end)

  // Drag from Unscheduled OR Day modal → calendar
  // ✅ Use ONLY a ref (no state) so drag start/end never triggers a re-render of the
  // entire calendar tree. This was the main source of drag lag.
  const dragItemRef = useRef(null);

  // Status modal
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState(null);
  const [statusChoice, setStatusChoice] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);

  /* ============================================================
     ✅ DRAG AUTO-SCROLL (setInterval — reliable during HTML5 drag)
     RAF callbacks are throttled in some browsers while a native
     drag is in progress, which made the previous scroll lag. A
     plain setInterval keeps firing.
  ============================================================ */
  const pageRootRef = useRef(null);
  // eslint-disable-next-line no-unused-vars
  const [isDragging, setIsDragging] = useState(false);
  const scrollIntervalRef = useRef(null);

  const startAutoScroll = useCallback(() => {
    if (scrollIntervalRef.current) return;
    scrollIntervalRef.current = setInterval(() => {
      const mouseY = window._dragMouseY || 0;
      const threshold = 120;
      const maxSpeed = 25;

      if (mouseY < threshold) {
        const speed = Math.round(maxSpeed * (1 - mouseY / threshold));
        window.scrollBy(0, -speed);
      } else if (mouseY > window.innerHeight - threshold) {
        const speed = Math.round(
          maxSpeed * (1 - (window.innerHeight - mouseY) / threshold)
        );
        window.scrollBy(0, speed);
      }
    }, 16); // ~60fps
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  // Track mouse Y globally during drag
  useEffect(() => {
    const trackMouse = (e) => {
      window._dragMouseY = e.clientY;
    };
    window.addEventListener("dragover", trackMouse);
    return () => window.removeEventListener("dragover", trackMouse);
  }, []);

  // ESC cancels in-flight drag + stop scrolling
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        dragItemRef.current = null;
        setIsDragging(false);
        stopAutoScroll();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stopAutoScroll]);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => stopAutoScroll();
  }, [stopAutoScroll]);

  /* ========= initial fetches ========= */
  useEffect(() => {
    refreshLists();
    // Fetch tech list for assignment dropdowns
    api.get("/users", { params: { assignees: 1 } })
      .then((res) => {
        const list = (res.data || []).filter((u) => u.username !== "Mark");
        setTechs(list);
      })
      .catch((e) => console.error("⚠️ Error loading techs:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refresh calendar events whenever the visible range changes
  useEffect(() => {
    fetchCalendarForVisibleRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentDate]);

  // NOTE: /work-orders (the ENTIRE table — measured at 907KB / 597 rows) used to
  // be fetched here. refreshLists runs on mount AND after every drop, reschedule,
  // status change and pickup save (11 call sites), so a single drag-to-schedule
  // was paying ~1MB of download + JSON parse before the card would move.
  // The full table is only needed for the rail's global search, so it is now
  // lazy-loaded on first search instead (see ensureAllOrdersLoaded).
  const refreshLists = useCallback(async () => {
    try {
      const [unRes, pickupsRes, supRes, pastDueRes] = await Promise.all([
        api.get("/work-orders/unscheduled"),
        api.get("/supplier-pickups").catch(() => ({ data: [] })),
        api.get("/supplier-pickups/suppliers").catch(() => ({ data: [] })),
        api.get("/work-orders", { params: { pastDue: "true" } }).catch(() => ({ data: [] })),
      ]);
      setUnscheduledOrders(
        (Array.isArray(unRes.data) ? unRes.data : []).filter(
          (o) => !EXCLUDED_FROM_SCHEDULING.has(o?.status)
        )
      );
      setSupplierPickups(Array.isArray(pickupsRes.data) ? pickupsRes.data : []);
      setSupplierList(Array.isArray(supRes.data) ? supRes.data : []);
      setPastDueOrders(
        (Array.isArray(pastDueRes.data) ? pastDueRes.data : []).filter(
          (o) => !EXCLUDED_FROM_SCHEDULING.has(o?.status)
        )
      );
    } catch (e) {
      console.error("⚠️ Error loading lists:", e);
    }
  }, []);

  // The rail's search box searches ALL work orders, not just unscheduled ones,
  // so it still needs the full table — but only once the user actually searches.
  const allOrdersLoadedRef = useRef(false);
  const [allOrdersLoading, setAllOrdersLoading] = useState(false);
  const ensureAllOrdersLoaded = useCallback(async () => {
    if (allOrdersLoadedRef.current) return;
    allOrdersLoadedRef.current = true;
    setAllOrdersLoading(true);
    try {
      const { data } = await api.get("/work-orders");
      setAllOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      allOrdersLoadedRef.current = false; // let a later keystroke retry
      console.error("⚠️ Error loading work orders for search:", e);
    } finally {
      setAllOrdersLoading(false);
    }
  }, []);

  // Vertical wheel scrolls the horizontal rails — otherwise the page scrolls
  // away while the user is trying to browse the cards.
  const railWheel = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
  }, []);

  const handleReschedule = (wo) => openEditModal(wo, currentDate);

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
      case "agenda": {
        const start = m.clone().startOf("day");
        const end = m.clone().add(30, "days").endOf("day");
        return { start: start.format("YYYY-MM-DD"), end: end.format("YYYY-MM-DD") };
      }
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
          start: startD,
          end: endD,
          customer: ev.meta?.customer ?? ev.customer,
          siteLocation: ev.meta?.siteLocation ?? ev.siteLocation ?? getSiteLocation(ev),
          siteAddress: ev.meta?.siteAddress ?? ev.siteAddress ?? getSiteAddress(ev),
          problemDescription: ev.meta?.problemDescription ?? ev.problemDescription,
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
    const existing = fromDbString(order?.scheduledDate || order?.start);
    // When no existing scheduledDate, default to noon on fallback day
    let start = existing;
    if (!start) {
      const base = fallbackDate || new Date();
      start = moment(base).hour(12).minute(0).second(0).millisecond(0).toDate();
    }
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

    try {
      // Single source of truth: filter the `events` array the calendar
      // cells already render from. No separate API fetch — guarantees the
      // modal list matches what's visible on the day cell.
      const list = events;

      // Tech + sequence data now rides along on each event's meta (see
      // /calendar/events). No full-table lookup needed here any more.
      // Filter to the clicked day using date-only string comparison (defensive
      // against timezone shifts and mixed datetime formats).
      const filteredForDay = list.filter((ev) => {
        if (ev?.kind === "pickup") return false;
        const raw = ev.start || ev.scheduledDate;
        if (!raw) return false;
        const eventDateStr = (raw instanceof Date)
          ? moment(raw).format('YYYY-MM-DD')
          : String(raw).split('T')[0].split(' ')[0];
        return eventDateStr === dateStr;
      });

      console.log('[DayModal] selectedDay:', dateStr,
        'events count:', list.length,
        'matched:', filteredForDay.length);
      console.log('[DayModal] All event dates:', list.map(e => {
        const r = e.start || e.scheduledDate;
        return (r instanceof Date)
          ? moment(r).format('YYYY-MM-DD')
          : String(r || '').substring(0, 10);
      }));

      const normalized = filteredForDay.map((ev) => {
        const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
        const e =
          fromDbString(ev.end) ||
          fromDbString(ev.scheduledEnd) ||
          (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : null);

        const full = ev.meta || {};

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
          assignedTo: full?.assignedTo ?? ev.meta?.assignedTo ?? ev.assignedTo ?? null,
          assignedToName: full?.assignedToName ?? ev.meta?.assignedToName ?? ev.assignedToName ?? "",
          techIds: Array.isArray(full?.techIds) ? full.techIds.map(Number) : [],
          techNames: Array.isArray(full?.techNames) ? full.techNames : [],
          // Per-day service position. Calendar events don't carry it, so take it
          // from the full work-order record.
          serviceOrder:
            full?.serviceOrder ?? ev.meta?.serviceOrder ?? ev.serviceOrder ?? null,
        };
      });

      // Arranged service order first (1 = first job of the day); anything not yet
      // sequenced falls to the bottom by scheduled time. Same rule as the Work
      // Orders "Today" tab, so the two views never disagree.
      normalized.sort((a, b) => {
        const oa = a.serviceOrder == null ? Infinity : Number(a.serviceOrder);
        const ob = b.serviceOrder == null ? Infinity : Number(b.serviceOrder);
        if (oa !== ob) return oa - ob;
        const sa = a.scheduledDate ? +a.scheduledDate : 0;
        const sb = b.scheduledDate ? +b.scheduledDate : 0;
        return sa - sb;
      });

      console.log('[DayModal] normalized work orders:', normalized.length,
        normalized.map(wo => ({ id: wo.id, customer: wo.customer, scheduledDate: wo.scheduledDate })));

      setDayOrders(normalized);
      setDayForModal(day.toDate());
      setDayModalTitle(`Work Orders for ${day.format("LL")}`);
      setDayModalOpen(true);
    } catch (e) {
      console.error("⚠️ Error loading day:", e);
      alert("Failed to load that day.");
    }
  }

  /* ===== Day modal: drag cards to arrange the day's service order =====
     Native HTML5 drag, same mechanism the calendar already uses for dragging
     jobs onto dates, and the same one the Work Orders "Today" tab uses. The
     ref (not state) keeps the drag from re-rendering the modal mid-gesture. */
  const dmDragIdRef = useRef(null);
  const [dmDragOverId, setDmDragOverId] = useState(null);
  const [dmSavingOrder, setDmSavingOrder] = useState(false);

  const dmDragStart = (e, id) => {
    dmDragIdRef.current = id;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(id)); } catch {}
  };

  const dmDragOver = (e, id) => {
    if (dmDragIdRef.current == null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dmDragOverId !== id) setDmDragOverId(id);
  };

  const dmDragEnd = () => {
    dmDragIdRef.current = null;
    setDmDragOverId(null);
  };

  async function dmDrop(e, targetId) {
    e.preventDefault();
    e.stopPropagation();
    const srcId = dmDragIdRef.current;
    dmDragIdRef.current = null;
    setDmDragOverId(null);
    if (srcId == null || srcId === targetId) return;

    const from = dayOrders.findIndex((o) => o.id === srcId);
    const to = dayOrders.findIndex((o) => o.id === targetId);
    if (from < 0 || to < 0) return;

    const next = [...dayOrders];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // Optimistic: renumber locally so the badges update instantly
    setDayOrders(next.map((o, i) => ({ ...o, serviceOrder: i + 1 })));

    const date = moment(dayForModal || next[0]?.scheduledDate).format("YYYY-MM-DD");
    setDmSavingOrder(true);
    try {
      await api.put("/work-orders/day-order", {
        date,
        orderedIds: next.map((o) => o.id),
      });
    } catch (err) {
      console.error("⚠️ Failed to save the day order:", err);
      alert(err?.response?.data?.error || "Couldn't save the new order.");
      // Put the server's truth back
      setDayOrders(dayOrders);
    } finally {
      setDmSavingOrder(false);
    }
  }

  /* ===== Tech assignment handler ===== */
  async function handleAssignTech(orderId, techIdStr) {
    const techId = techIdStr ? Number(techIdStr) : null;
    const userIds = techId != null ? [techId] : [];
    return handleSetTechs(orderId, userIds);
  }

  // Multi-tech: replace the entire tech list for a work order.
  async function handleSetTechs(orderId, userIds) {
    const ids = Array.from(new Set((userIds || []).map(Number).filter(Boolean)));
    const names = ids
      .map((id) => techs.find((t) => Number(t.id) === id)?.username || "")
      .filter(Boolean);
    try {
      await api.put(`/work-orders/${orderId}/techs`, { userIds: ids });
      setDayOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? {
                ...o,
                assignedTo: ids[0] ?? null,
                assignedToName: names[0] ?? "",
                techIds: ids,
                techNames: names,
              }
            : o
        )
      );
      setTechSavedId(orderId);
      setTimeout(() => setTechSavedId(null), 1200);
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error assigning techs:", e);
      alert("Failed to assign techs.");
    }
  }

  /* ===== Inline edit-time helpers ===== */
  function startInlineEdit(order) {
    const s = fromDbString(order.scheduledDate);
    const e = fromDbString(order.scheduledEnd) ||
      (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : new Date());
    setInlineEditId(order.id);
    setInlineStartTime(s ? fmtTime(s) : "12:00");
    setInlineEndTime(e ? fmtTime(e) : "14:00");
  }

  function cancelInlineEdit() {
    setInlineEditId(null);
    setInlineStartTime("");
    setInlineEndTime("");
  }

  async function saveInlineEdit(orderId) {
    if (!dayForModal) return;
    const dateStr = fmtDate(dayForModal);
    if (inlineStartTime >= inlineEndTime) {
      alert("End time must be after start time.");
      return;
    }
    try {
      await setSchedulePayload(orderId, {
        date: dateStr,
        time: inlineStartTime,
        endTime: inlineEndTime,
        status: "Scheduled",
      });
      cancelInlineEdit();
      await openDayModal(dayForModal);
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error saving inline time:", e);
      alert("Failed to save time.");
    }
  }

  // ✅ DO NOT clear dragItem on random page-level drop events.
  // Only clear after:
  //  - successful scheduling (in handleDropFromOutside)
  //  - actual dragend of the draggable item
  function endGlobalDrag() {
    dragItemRef.current = null;
    setIsDragging(false);
    stopAutoScroll();
  }

  /* ===== react-big-calendar interactions ===== */
  function handleEventDrop({ event, start, end }) {
    if (event?.kind === "pickup") {
      api
        .put(`/supplier-pickups/${event.pickupId}`, { scheduledDate: fmtDate(start) })
        .then(async () => {
          await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
        })
        .catch((e) => console.error("⚠️ Error rescheduling pickup:", e));
      return;
    }
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
    const item = dragItemRef.current;
    if (!item) return;

    if (item.__kind === "pickup") {
      api
        .put(`/supplier-pickups/${item.id}`, { scheduledDate: fmtDate(start) })
        .then(async () => {
          endGlobalDrag();
          await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
        })
        .catch((e) => console.error("⚠️ Error scheduling pickup:", e));
      return;
    }

    const minutes = minutesWindowForOrder(item);
    const endDate = moment(start).add(minutes, "minutes").toDate();

    // OPTIMISTIC: move the card out of the rail and onto the grid immediately.
    // Previously the UI did nothing until the PUT *and* a full list refresh had
    // resolved, which is what made a drop feel like it hadn't registered.
    const prevUnscheduled = unscheduledOrders;
    const prevPastDue = pastDueOrders;
    const prevEvents = events;

    setUnscheduledOrders((list) => list.filter((o) => Number(o.id) !== Number(item.id)));
    setPastDueOrders((list) => list.filter((o) => Number(o.id) !== Number(item.id)));
    setEvents((list) => [
      ...list.filter((e) => Number(e.id) !== Number(item.id)),
      {
        ...item,
        id: item.id,
        start,
        end: endDate,
        meta: {
          ...(item.meta || {}),
          status: "Scheduled",
          customer: item.customer,
          siteLocation: getSiteLocation(item),
          siteAddress: getSiteAddress(item),
          problemDescription: item.problemDescription,
          assignedTo: item.assignedTo ?? null,
          assignedToName: item.assignedToName ?? "",
          techIds: item.techIds || [],
          techNames: item.techNames || [],
          serviceOrder: null,
        },
      },
    ]);
    endGlobalDrag();

    setSchedulePayload(item.id, {
      date: fmtDate(start),
      time: fmtTime(start),
      endTime: fmtTime(endDate),
      status: "Scheduled",
    })
      .then(async () => {
        if (dayForModal) await openDayModal(dayForModal);
        // Reconcile against the server (cheap now — no full-table fetch).
        await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
      })
      .catch((e) => {
        console.error("⚠️ Error scheduling work order:", e);
        // Roll the optimistic move back and tell the user.
        setUnscheduledOrders(prevUnscheduled);
        setPastDueOrders(prevPastDue);
        setEvents(prevEvents);
        showToast(
          e?.response?.data?.error || "Couldn't schedule that work order — put it back.",
          "error"
        );
      });
  }

  function onSelectEvent(event) {
    if (event?.kind === "pickup") return;
    // In month view, a single click on an event pill should open the DAY
    // modal showing all jobs for that day (not the edit modal for just one).
    if (view === "month") {
      const d = fromDbString(event.start) || fromDbString(event.scheduledDate);
      if (d) {
        openDayModal(d);
        return;
      }
    }
    // The event already carries start/end/scheduledDate, which is all
    // openEditModal reads — no full-table lookup needed.
    openEditModal(event);
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
    // /calendar/events now carries assignedTo/assignedToName (and techIds,
    // techNames, serviceOrder) in meta, so this no longer cross-references the
    // full work-orders table — which is what kept that 900KB fetch on the
    // critical path for every render of the grid.
    const woEvents = events.map((o) => {
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
        kind: "wo",
        assignedTo: o.meta?.assignedTo ?? o.assignedTo ?? null,
        assignedToName: o.meta?.assignedToName ?? o.assignedToName ?? "",
      };
    });

    const pickupEvents = supplierPickups
      .filter((p) => !!p.scheduledDate)
      .map((p) => {
        // Backend may return scheduledDate as UTC ISO ("2026-04-29T00:00:00.000Z")
        // when it's just a DATE column. Strip to "YYYY-MM-DD" and parse as LOCAL
        // so the pickup lands on the day the user picked, not the day before in
        // their timezone.
        const dateStr = String(p.scheduledDate).split("T")[0];
        const start = moment(dateStr, "YYYY-MM-DD").startOf("day").add(8, "hours").toDate();
        const end = moment(start).add(DEFAULT_WINDOW_MIN, "minutes").toDate();
        const techLabel = p.assignedTech ? ` · ${p.assignedTech}` : "";
        return {
          id: `pickup-${p.id}`,
          pickupId: p.id,
          kind: "pickup",
          supplier: p.supplier,
          assignedTech: p.assignedTech || "",
          notes: p.notes || "",
          title: `📦 Pickup — ${p.supplier}${techLabel}`,
          start,
          end,
          allDay: false,
        };
      });

    return [...woEvents, ...pickupEvents];
  }, [events, supplierPickups]);

  // Context value for the custom Day view's tech dropdown. MUST be memoized:
  // a fresh object each render makes every context consumer (i.e. every event
  // chip in the grid) re-render on any unrelated parent state change.
  const techContextValue = useMemo(
    () => ({ techs, onAssignTech: handleAssignTech, techSavedId, supplierPickups }),
    // handleAssignTech is a stable function declaration on the component
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [techs, techSavedId, supplierPickups]
  );

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

  /* ===== Supplier Pickup drag ===== */
  function beginPickupDrag(pickup, e) {
    dragItemRef.current = { ...pickup, __kind: "pickup" };
    if (typeof e?.clientY === "number") window._dragMouseY = e.clientY;
    try {
      if (e?.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.dropEffect = "move";
        e.dataTransfer.setData("text/plain", String(pickup?.id ?? ""));
      }
    } catch {
      /* ignore */
    }
    setIsDragging(true);
    startAutoScroll();
  }

  const unscheduledPickups = useMemo(
    () => supplierPickups.filter((p) => !p.scheduledDate),
    [supplierPickups]
  );

  /* RBC event styling — orange for pickups, default for work orders */
  const eventPropGetter = useCallback((event) => {
    if (event?.kind === "pickup") {
      // Hide RBC's default event chrome — the pill is rendered inside CustomEvent.
      return {
        style: {
          background: "transparent",
          border: "none",
          padding: 0,
          color: "inherit",
          boxShadow: "none",
        },
      };
    }
    return {};
  }, []);

  // ✅ FIXED: make HTML5 drag reliable across browsers (esp. Firefox)
  function beginGlobalDrag(order, e) {
    dragItemRef.current = order;

    // Prime mouse Y immediately so the auto-scroll has a starting value
    if (typeof e?.clientY === "number") window._dragMouseY = e.clientY;

    // REQUIRED for some browsers to consider it a valid drag
    try {
      if (e?.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.dropEffect = "move";
        e.dataTransfer.setData("text/plain", String(order?.id ?? ""));
      }
    } catch {
      // ignore
    }

    setIsDragging(true);
    startAutoScroll();
  }

  // PART 3 starts with: return (
  return (
    <div ref={pageRootRef} className="calendar-page">
      <div className="container-fluid p-0">
        <h2 className="calendar-title">Work Order Calendar</h2>

        {/* Search & Unscheduled strip */}
        <div className="unscheduled-container">
          <div
            className="d-flex align-items-center justify-content-between flex-wrap"
            style={{ gap: 12 }}
          >
            <h4 className="mb-0">
              {unscheduledSearch ? "Search Results (All Work Orders)" : "Unscheduled Work Orders"}
              <span className="cal-count-badge">{listForStrip.length}</span>
            </h4>

            <div className="d-flex align-items-center" style={{ gap: 8, flexWrap: "wrap" }}>
              <div className="input-group" style={{ maxWidth: 620 }}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Search customer, site location, site address, WO #, or PO # (includes scheduled)"
                  value={unscheduledSearch}
                  onFocus={ensureAllOrdersLoaded}
                  onChange={(e) => {
                    ensureAllOrdersLoaded();
                    setUnscheduledSearch(e.target.value);
                  }}
                />
                {allOrdersLoading ? (
                  <span className="input-group-text cal-search-loading">Loading…</span>
                ) : null}
                {unscheduledSearch ? (
                  <button className="btn btn-outline-secondary" onClick={clearUnscheduledSearch}>
                    Clear
                  </button>
                ) : null}
              </div>

              <button
                className="btn btn-primary"
                onClick={() => { setPickupSupplier(''); setPickupTech(''); setPickupNotes(''); setShowPickupModal(true); }}
                type="button"
                style={{ marginBottom: 12 }}
              >
                + Supplier Pickup
              </button>
            </div>
          </div>

          {unscheduledSearch && (
            <div className="text-muted mt-2" style={{ fontSize: 12 }}>
              Showing {listForStrip.length} match{listForStrip.length === 1 ? "" : "es"} across{" "}
              {allOrders.length} total work order{allOrders.length === 1 ? "" : "s"} (drag any item
              to schedule/reschedule).
            </div>
          )}

          {pastDueOrders.length > 0 && (
            <div style={{ marginBottom: 12, marginTop: 12 }}>
              <div
                onClick={() => setShowPastDue(!showPastDue)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  marginBottom: showPastDue ? 8 : 0,
                }}
                className="cal-rail-head cal-rail-head-late"
              >
                <span className="cal-rail-title">⚠ Past Due</span>
                <span className="cal-count-badge cal-count-badge-late">{pastDueOrders.length}</span>
                <span className="cal-rail-hint">
                  {showPastDue ? "▲ Hide" : "▼ Show"} — scheduled dates that passed without completion
                </span>
              </div>

              {showPastDue && (
                <div className="cal-rail cal-rail-pastdue" onWheel={railWheel}>
                  {pastDueOrders.map((wo) => {
                    const late = daysLate(wo.scheduledDate);
                    return (
                    <div key={wo.id} className="cal-card cal-card-late">
                      {late != null && (
                        <span className="cal-late-chip" title={`Was scheduled ${new Date(wo.scheduledDate).toLocaleDateString()}`}>
                          {late === 0 ? "due today" : `${late} day${late === 1 ? "" : "s"} late`}
                        </span>
                      )}
                      <div className="cal-card-title" title={`${wo.customer || "—"} — ${wo.workOrderNumber || wo.woNumber || "N/A"}`}>
                        <span className="cal-card-cust">{wo.customer || "—"}</span>
                        {(wo.workOrderNumber || wo.woNumber) ? (
                          <span className="cal-card-id">{wo.workOrderNumber || wo.woNumber}</span>
                        ) : null}
                      </div>
                      <div className="cal-card-site" title={getSiteLocation(wo) || ""}>{getSiteLocation(wo) || ""}</div>
                      <div className="cal-card-addr" title={getSiteAddress(wo) || ""}>{getSiteAddress(wo) || ""}</div>
                      {wo.problemDescription && (
                        <div className="cal-card-desc">{wo.problemDescription}</div>
                      )}
                      <div className="cal-card-actions">
                        <button className="btn btn-outline btn-xs" onClick={() => navigateToView(wo.id)}>Open</button>
                        <button className="btn btn-danger btn-xs" onClick={() => handleReschedule(wo)}>Reschedule</button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="unscheduled-list" onWheel={railWheel}>
            {listForStrip.map((order) => {
              const idLabel = displayWOThenPO(order);
              const customerLabel = order.customer ? order.customer : "Work Order";
              const siteLoc = getSiteLocation(order) || "";
              const siteAddr = getSiteAddress(order) || "";
              const isScheduled = !!order.scheduledDate;
              const isFinished = EXCLUDED_FROM_SCHEDULING.has(order?.status);

              let currentWhen = "";
              if (isScheduled) {
                const s = fromDbString(order.scheduledDate);
                const e2 =
                  fromDbString(order.scheduledEnd) ||
                  (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : null);
                if (s) {
                  currentWhen = `${moment(s).format("MMM D, YYYY h:mm A")}${
                    e2 ? ` – ${moment(e2).format("h:mm A")}` : ""
                  }`;
                }
              }

              const problem = order.problemDescription || order.problem || order.description || "";

              return (
                <div
                  key={order.id}
                  className="unscheduled-item"
                  draggable={!isFinished}
                  onDragStart={(e) => {
                    if (isFinished) {
                      e.preventDefault();
                      return;
                    }
                    beginGlobalDrag(order, e);
                  }}
                  onDragEnd={endGlobalDrag}
                  title={`${customerLabel} — ${idLabel}`}
                  style={{ opacity: isFinished ? 0.65 : 1 }}
                >
                  <div className="d-flex align-items-center justify-content-between" style={{ gap: 8 }}>
                    <div className="cal-card-title" title={`${customerLabel} — ${idLabel}`}>
                      <span className="cal-card-cust">{customerLabel}</span>
                      {idLabel && idLabel !== "N/A" ? (
                        <span className="cal-card-id">{idLabel}</span>
                      ) : null}
                    </div>
                    {isFinished ? (
                      <span
                        className="badge"
                        style={{
                          background:
                            order.status === "Completed"
                              ? "#22c55e"
                              : order.status === "Declined"
                              ? "#6b7280"
                              : "#3b82f6",
                          color: "#fff",
                        }}
                      >
                        {order.status}
                      </span>
                    ) : isScheduled ? (
                      <span className="badge text-bg-secondary">Scheduled</span>
                    ) : null}
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

                  {problem ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        marginTop: 4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        lineHeight: 1.4,
                      }}
                      title={problem}
                    >
                      {problem}
                    </div>
                  ) : null}

                  {isScheduled && currentWhen ? (
                    <div className="mt-1">
                      <small className="text-muted">Current: {currentWhen}</small>
                    </div>
                  ) : null}

                  <div
                    className="unscheduled-actions"
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                  >
                    {!isFinished && (
                      <>
                        <button
                          className="btn btn-xs btn-outline-light me-1"
                          onClick={() => openEditModal(order, currentDate)}
                          type="button"
                        >
                          {isScheduled ? "Edit/Reschedule…" : "Schedule…"}
                        </button>

                        <button
                          className="btn btn-xs btn-light me-1"
                          onClick={() => openStatusPicker(order)}
                          type="button"
                        >
                          Status…
                        </button>
                      </>
                    )}

                    <button
                      className="btn btn-xs btn-light"
                      onClick={() => navigateToView(order.id)}
                      type="button"
                    >
                      Open
                    </button>
                  </div>
                </div>
              );
            })}
            {unscheduledPickups.map((p) => (
              <div
                key={`pickup-${p.id}`}
                className="unscheduled-item"
                draggable
                onDragStart={(e) => beginPickupDrag(p, e)}
                onDragEnd={endGlobalDrag}
                title={`Pickup — ${p.supplier}`}
              >
                <div className="d-flex align-items-center justify-content-between" style={{ gap: 8 }}>
                  <div className="fw-bold" style={clamp1}>
                    📦 {p.supplier}
                  </div>
                  <span className="badge text-bg-secondary">Pickup</span>
                </div>
                {p.assignedTech ? (
                  <small className="text-muted" style={clamp1}>
                    Tech: {p.assignedTech}
                  </small>
                ) : null}
                {p.notes ? (
                  <div>
                    <small className="text-muted" style={clamp2}>
                      {p.notes}
                    </small>
                  </div>
                ) : null}
                <div
                  className="unscheduled-actions"
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                >
                  <button
                    className="btn btn-xs btn-light"
                    onClick={() => {
                      if (!window.confirm(`Delete pickup for ${p.supplier}?`)) return;
                      api
                        .delete(`/supplier-pickups/${p.id}`)
                        .then(() => Promise.all([fetchCalendarForVisibleRange(), refreshLists()]))
                        .catch((e) => console.error("⚠️ Error deleting pickup:", e));
                    }}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {!listForStrip.length && !unscheduledPickups.length && (
              <div className="empty-text">No matches.</div>
            )}
          </div>
        </div>

        {/* Calendar */}
        {toast && (
          <div className={`cal-toast cal-toast-${toast.kind}`} role="status" aria-live="polite">
            <span>{toast.msg}</span>
            <button className="cal-toast-x" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        <div
          className="calendar-container"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
        >
          <CalendarTechContext.Provider value={techContextValue}>
          <DnDCalendar
            localizer={localizer}
            events={rbcEvents}
            startAccessor="start"
            endAccessor="end"
            step={15}
            timeslots={4}
            min={RBC_MIN}
            max={RBC_MAX}
            selectable
            draggableAccessor={alwaysDraggable}
            dragFromOutsideItem={() => dragItemRef.current}
            onDropFromOutside={handleDropFromOutside}
            onEventDrop={handleEventDrop}
            onEventResize={handleEventResize}
            onSelectEvent={onSelectEvent}
            onDoubleClickEvent={(e) => navigateToView(e.id)}
            onSelectSlot={onSelectSlot}
            onShowMore={onShowMore}
            views={RBC_VIEWS}
            view={view}
            onView={(v) => setView(v)}
            date={currentDate}
            onNavigate={(d) => setCurrentDate(d)}
            components={RBC_COMPONENTS}
            eventPropGetter={eventPropGetter}
            className={`rbc-enhanced ${view === "week" ? "rbc-week-pretty" : ""}`}
            style={view === "week" ? RBC_STYLE_WEEK : RBC_STYLE_MONTH}
            showAllEvents
            resizable={false}
            popup={false}
          />
          </CalendarTechContext.Provider>
        </div>
      </div>

      {/* ---------- Day list modal (card-based) ---------- */}
      {dayModalOpen && (
        <div className="dm-overlay" onClick={() => { setDayModalOpen(false); cancelInlineEdit(); }}>
          <div className="dm-container" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="dm-header">
              <div>
                <h3 className="dm-title">{dayModalTitle}</h3>
                <p className="dm-subtitle">
                  {dayOrders.length} job{dayOrders.length !== 1 ? "s" : ""} scheduled
                  {dayOrders.length > 1 && (
                    <span className="dm-seq-hint">
                      {dmSavingOrder ? " · saving order…" : " · drag cards to set the service order"}
                    </span>
                  )}
                </p>
              </div>
              <button
                className="dm-close"
                onClick={() => { setDayModalOpen(false); cancelInlineEdit(); }}
                aria-label="Close"
                type="button"
              >
                ×
              </button>
            </div>

            {/* Cards */}
            <div className="dm-body">
              {dayOrders.length ? (
                dayOrders.map((o) => {
                  const s = fromDbString(o.scheduledDate);
                  const e2 = fromDbString(o.scheduledEnd);
                  const startM = s ? moment(s) : null;
                  const endM = e2
                    ? moment(e2)
                    : startM
                    ? moment(startM).add(DEFAULT_WINDOW_MIN, "minutes")
                    : null;

                  const isNoTime =
                    startM &&
                    startM.hours() === 0 &&
                    startM.minutes() === 0 &&
                    endM &&
                    endM.hours() <= 2 &&
                    endM.minutes() === 0;

                  const timeLabel =
                    startM && endM
                      ? `${startM.format("h:mm A")} – ${endM.format("h:mm A")}`
                      : "—";

                  const idLabel = displayWOThenPO(o);
                  const siteLoc = getSiteLocation(o) || o.siteLocation || "";
                  const siteAddr = getSiteAddress(o) || "";
                  const techName = o.assignedToName || "";
                  // Coerce to string so <select value> always matches <option value> (both strings)
                  const techId = o.assignedTo ? String(o.assignedTo) : "";

                  // Color for left border based on tech
                  const techColors = {
                    jeff: "#007AFF",
                    mikey: "#30D158",
                    adin: "#FF9F0A",
                    jeffsr: "#BF5AF2",
                  };
                  const borderColor = techName
                    ? techColors[techName.toLowerCase()] ||
                      `hsl(${[...techName].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}, 60%, 55%)`
                    : "#636366";

                  const isEditing = inlineEditId === o.id;

                  const seq = o.serviceOrder == null ? null : o.serviceOrder;

                  return (
                    <div
                      key={o.id}
                      className={`dm-card${dmDragOverId === o.id ? " dm-card-dragover" : ""}`}
                      style={{ borderLeftColor: borderColor }}
                      draggable={!isEditing}
                      onDragStart={(e) => dmDragStart(e, o.id)}
                      onDragOver={(e) => dmDragOver(e, o.id)}
                      onDrop={(e) => dmDrop(e, o.id)}
                      onDragEnd={dmDragEnd}
                    >
                      <div
                        className="dm-seq"
                        title="Drag the card to change the service order"
                      >
                        <span className="dm-seq-grip" aria-hidden="true">⋮⋮</span>
                        <span className="dm-seq-num">{seq == null ? "—" : seq}</span>
                      </div>

                      {isEditing ? (
                        /* Inline time editor */
                        <div className="dm-inline-edit">
                          <div className="dm-inline-edit-row">
                            <label className="dm-inline-label">
                              Start
                              <input
                                type="time"
                                className="dm-time-input"
                                value={inlineStartTime}
                                onChange={(ev) => setInlineStartTime(ev.target.value)}
                              />
                            </label>
                            <label className="dm-inline-label">
                              End
                              <input
                                type="time"
                                className="dm-time-input"
                                value={inlineEndTime}
                                onChange={(ev) => setInlineEndTime(ev.target.value)}
                              />
                            </label>
                          </div>
                          <div className="dm-inline-edit-actions">
                            <button
                              className="dm-btn dm-btn-save"
                              onClick={() => saveInlineEdit(o.id)}
                              type="button"
                            >
                              Save
                            </button>
                            <button
                              className="dm-btn"
                              onClick={cancelInlineEdit}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* Top row: time + tech */}
                          <div className="dm-card-top">
                            <div className={`dm-card-time ${isNoTime ? "dm-no-time" : ""}`}>
                              {isNoTime ? (
                                <>
                                  <span className="dm-dot dm-dot-amber" />
                                  {timeLabel}
                                  <span className="dm-no-time-label">(no time set)</span>
                                </>
                              ) : (
                                <>
                                  <span className="dm-dot" style={{ background: borderColor }} />
                                  {timeLabel}
                                </>
                              )}
                              {techSavedId === o.id && (
                                <span className="dm-saved-check">✓</span>
                              )}
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: 4,
                                minWidth: 200,
                              }}
                            >
                              {techs.map((t) => {
                                const tid = Number(t.id);
                                const current = Array.isArray(o.techIds) ? o.techIds : [];
                                const isSelected = current.some((x) => Number(x) === tid);
                                return (
                                  <button
                                    key={t.id}
                                    type="button"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      const next = isSelected
                                        ? current.filter((x) => Number(x) !== tid)
                                        : [...current, tid];
                                      handleSetTechs(o.id, next);
                                    }}
                                    style={{
                                      padding: "5px 8px",
                                      borderRadius: 16,
                                      fontSize: 11,
                                      fontWeight: 500,
                                      border: isSelected ? "2px solid #3b82f6" : "2px solid #4b5563",
                                      background: isSelected ? "#1d4ed8" : "#374151",
                                      color: isSelected ? "#fff" : "#9ca3af",
                                      cursor: "pointer",
                                      textAlign: "center",
                                    }}
                                  >
                                    {isSelected ? "✓ " : ""}
                                    {t.username}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Middle: WO info */}
                          <div className="dm-card-info">
                            <div className="dm-card-customer" style={clamp1}>
                              {o.customer ? o.customer : "Work Order"} — {idLabel}
                            </div>
                            {(siteLoc || siteAddr) && (
                              <div className="dm-card-address" style={clamp2}>
                                📍 {siteLoc}{siteLoc && siteAddr ? " · " : ""}{siteAddr}
                              </div>
                            )}
                          </div>

                          {/* Bottom: actions */}
                          <div className="dm-card-actions">
                            <button
                              className="dm-btn"
                              onClick={() => startInlineEdit(o)}
                              type="button"
                            >
                              Edit Time
                            </button>
                            <button
                              className="dm-btn"
                              onClick={() => navigateToView(o.id)}
                              type="button"
                            >
                              Open
                            </button>
                            <button
                              className="dm-btn dm-btn-unschedule"
                              onClick={() => unschedule(o.id)}
                              type="button"
                            >
                              Unschedule
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="empty-text mb-0">No work orders scheduled on this day.</p>
              )}

              {/* Supplier pickups for this day */}
              {dayForModal && supplierPickups
                .filter((p) => (p.scheduledDate || "").split("T")[0] === fmtDate(dayForModal))
                .map((p) => (
                  <div key={'sp-'+p.id}
                    onClick={() => window.location.href = `/purchase-orders?supplier=${encodeURIComponent(p.supplier)}`}
                    style={{
                      background:'rgba(249,115,22,0.15)',
                      border:'1px solid #f97316',
                      borderRadius:8,
                      padding:'12px 16px',
                      marginBottom:8,
                      display:'flex',
                      alignItems:'center',
                      justifyContent:'space-between',
                      cursor:'pointer'
                    }}
                  >
                    <div>
                      <div style={{color:'#f97316',fontWeight:600}}>📦 {p.supplier} — Supplier Pickup</div>
                      {p.assignedTech && <div style={{color:'#9ca3af',fontSize:13}}>Tech: {p.assignedTech}</div>}
                      {p.notes && <div style={{color:'#9ca3af',fontSize:13}}>{p.notes}</div>}
                    </div>
                    <div style={{display:'flex',alignItems:'center'}}>
                      <div style={{color:'#f97316',fontSize:12}}>View POs →</div>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm('Delete this supplier pickup?')) return;
                          try {
                            await api.delete(`/supplier-pickups/${p.id}`);
                            setSupplierPickups(prev => prev.filter(sp => sp.id !== p.id));
                          } catch(err) {
                            alert('Failed to delete: ' + (err.response?.data?.error || err.message));
                          }
                        }}
                        style={{color:'#ef4444',background:'none',border:'none',cursor:'pointer',fontSize:12,marginLeft:8}}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
            </div>

            {/* Footer */}
            <div className="dm-footer">
              <button
                className="dm-btn"
                onClick={() => { setDayModalOpen(false); cancelInlineEdit(); }}
                type="button"
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
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Schedule</h3>
              <button
                className="modal-close"
                onClick={() => setEditModalOpen(false)}
                aria-label="Close"
                type="button"
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

                  {/* ✅ UPDATED: added "View Work Order" button */}
                  <div className="d-flex justify-content-between align-items-center mt-3">
                    <button
                      className="btn btn-outline-secondary"
                      onClick={() => {
                        const id = editOrder?.id;
                        if (!id) return;
                        setEditModalOpen(false);
                        navigateToView(id);
                      }}
                      type="button"
                    >
                      View Work Order
                    </button>

                    <div className="d-flex justify-content-end">
                      <button
                        className="btn btn-outline-danger me-2"
                        onClick={() => unschedule(editOrder.id)}
                        type="button"
                      >
                        Unschedule
                      </button>
                      <button className="btn btn-primary" onClick={saveEditModal} type="button">
                        Save
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- Supplier Pickup creation modal ---------- */}
      {showPickupModal && (
        <div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.5)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <div style={{background:'#1f2937',borderRadius:12,padding:24,width:500,maxWidth:'90vw'}}>
            <h3 style={{color:'#fff',marginBottom:16}}>New Supplier Pickup</h3>
            <label style={{color:'#9ca3af',fontSize:12}}>SUPPLIER *</label>
            <select value={pickupSupplier} onChange={e=>setPickupSupplier(e.target.value)}
              style={{width:'100%',padding:8,borderRadius:6,background:'#374151',color:'#fff',border:'1px solid #4b5563',marginBottom:12,marginTop:4}}>
              <option value=''>— Select supplier —</option>
              {supplierList.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            <label style={{color:'#9ca3af',fontSize:12}}>ASSIGN TECH</label>
            <select value={pickupTech} onChange={e=>setPickupTech(e.target.value)}
              style={{width:'100%',padding:8,borderRadius:6,background:'#374151',color:'#fff',border:'1px solid #4b5563',marginBottom:12,marginTop:4}}>
              <option value=''>— Unassigned —</option>
              {['Jeff','Mikey','Adin','jeffsr'].map(t=><option key={t} value={t}>{t}</option>)}
            </select>
            <label style={{color:'#9ca3af',fontSize:12}}>NOTES</label>
            <textarea value={pickupNotes} onChange={e=>setPickupNotes(e.target.value)}
              style={{width:'100%',padding:8,borderRadius:6,background:'#374151',color:'#fff',border:'1px solid #4b5563',marginBottom:16,marginTop:4,height:80}}
              placeholder='Optional notes...' />
            <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
              <button onClick={()=>setShowPickupModal(false)}
                style={{padding:'8px 16px',borderRadius:6,background:'#374151',color:'#fff',border:'none',cursor:'pointer'}}>Cancel</button>
              <button onClick={async()=>{
                if(!pickupSupplier){alert('Please select a supplier');return;}
                const today=new Date();
                const scheduledDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
                try{
                  const {data}=await api.post('/supplier-pickups',{supplier:pickupSupplier,assignedTech:pickupTech||null,notes:pickupNotes||null,scheduledDate});
                  console.log('Pickup saved:',data);
                  setSupplierPickups(prev=>[...prev,data]);
                  setShowPickupModal(false);
                }catch(err){
                  alert('Failed: '+(err.response?.data?.error||err.message));
                }
              }} style={{padding:'8px 16px',borderRadius:6,background:'#3b82f6',color:'#fff',border:'none',cursor:'pointer'}}>Save</button>
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
                type="button"
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

                  <div className="list-group mb-3" style={{ maxHeight: 260, overflowY: "auto" }}>
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
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={confirmStatusChange}
                      disabled={statusSaving || !statusChoice}
                      type="button"
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
