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

// ✅ Context lets the custom Day view (defined at module scope) access
// parent state like the tech list and the assign-tech handler.
const CalendarTechContext = createContext({
  techs: [],
  onAssignTech: () => {},
  techSavedId: null,
});

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
  }, [events, date]);

  const handleDropOnDay = (dayDate, e) => {
    e.preventDefault();
    const item = typeof dragFromOutsideItem === "function" ? dragFromOutsideItem() : null;
    if (!item || typeof onDropFromOutside !== "function") return;

    // Default drop time for Week stacked view: 8:00 AM
    const startTime = moment(dayDate).startOf("day").add(8, "hours").toDate();
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
                {list.length ? (
                  list.map((ev) => {
                    if (ev.kind === "pickup") {
                      return (
                        <button
                          key={ev.id}
                          type="button"
                          className="week-event-card"
                          onClick={() => onSelectEvent && onSelectEvent(ev)}
                          title={`Pickup — ${ev.supplier}`}
                          style={{
                            background: "rgba(234,88,12,0.12)",
                            borderLeft: "4px solid #ea580c",
                          }}
                        >
                          <div className="title" style={{ ...clamp2, color: "#ea580c" }}>
                            📦 Pickup — {ev.supplier}
                          </div>
                          {ev.assignedTech ? (
                            <div className="meta" style={{ ...clamp1 }}>
                              Tech: {ev.assignedTech}
                            </div>
                          ) : null}
                        </button>
                      );
                    }
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

  const { techs, onAssignTech, techSavedId } = useContext(CalendarTechContext);

  const day = moment(date).startOf("day");

  const list = useMemo(() => {
    const items = events.filter((ev) => {
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
    const startTime = day.clone().add(8, "hours").toDate();
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
          {list.length ? (
            list.map((ev) => {
              if (ev.kind === "pickup") {
                return (
                  <div
                    key={ev.id}
                    className="week-event-card week-event-card-day"
                    style={{
                      background: "rgba(234,88,12,0.12)",
                      borderLeft: "4px solid #ea580c",
                    }}
                  >
                    <div
                      className="week-event-card-body"
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectEvent && onSelectEvent(ev)}
                      title={`Pickup — ${ev.supplier}`}
                    >
                      <div className="title" style={{ ...clamp2, color: "#ea580c" }}>
                        📦 Pickup — {ev.supplier}
                      </div>
                      {ev.assignedTech ? (
                        <div className="meta" style={{ ...clamp1 }}>
                          Tech: {ev.assignedTech}
                        </div>
                      ) : null}
                      {ev.notes ? (
                        <div className="meta" style={{ ...clamp2 }}>
                          {ev.notes}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }
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
            })
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

  const groups = useMemo(() => {
    const start = moment(date).startOf("day");
    const end = moment(date).add(AGENDA_DAYS, "days").endOf("day");

    const filtered = events.filter((ev) => {
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
                  if (ev.kind === "pickup") {
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        className="week-event-card"
                        onClick={() => onSelectEvent && onSelectEvent(ev)}
                        title={`Pickup — ${ev.supplier}`}
                        style={{
                          background: "rgba(234,88,12,0.12)",
                          borderLeft: "4px solid #ea580c",
                        }}
                      >
                        <div className="title" style={{ ...clamp2, color: "#ea580c" }}>
                          📦 Pickup — {ev.supplier}
                        </div>
                        {ev.assignedTech ? (
                          <div className="meta" style={{ ...clamp1 }}>
                            Tech: {ev.assignedTech}
                          </div>
                        ) : null}
                      </button>
                    );
                  }
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

  // Supplier pickups (a separate calendar event type rendered in orange)
  const [supplierPickups, setSupplierPickups] = useState([]);
  const [pickupSuppliers, setPickupSuppliers] = useState([]);
  const [pickupModalOpen, setPickupModalOpen] = useState(false);
  const [pickupForm, setPickupForm] = useState({
    supplier: "",
    notes: "",
    assignedTech: "",
  });
  const [pickupSaving, setPickupSaving] = useState(false);

  // Pickup detail modal (opened when clicking an orange pickup event on the calendar)
  const [pickupDetailOpen, setPickupDetailOpen] = useState(false);
  const [pickupDetail, setPickupDetail] = useState(null);

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

  const refreshLists = useCallback(async () => {
    try {
      const [allRes, unRes, pickupsRes, supRes] = await Promise.all([
        api.get("/work-orders"),
        api.get("/work-orders/unscheduled"),
        api.get("/supplier-pickups").catch(() => ({ data: [] })),
        api.get("/supplier-pickups/suppliers").catch(() => ({ data: [] })),
      ]);
      setAllOrders(Array.isArray(allRes.data) ? allRes.data : []);
      setUnscheduledOrders(Array.isArray(unRes.data) ? unRes.data : []);
      setSupplierPickups(Array.isArray(pickupsRes.data) ? pickupsRes.data : []);
      setPickupSuppliers(Array.isArray(supRes.data) ? supRes.data : []);
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
      let list = [];
      try {
        const dayRes = await api.get("/calendar/day", { params: { date: dateStr } });
        if (Array.isArray(dayRes.data)) list = dayRes.data;
      } catch {
        // ignore -> fallback
      }

      if (!list.length) {
        const { data } = await api.get("/calendar/events", {
          params: { start: startExact, end: endExact },
        });
        list = Array.isArray(data) ? data : [];
      }

      // Build lookup from allOrders (from /work-orders endpoint, which always
      // includes assignedTo + assignedToName). This is the authoritative source.
      const allOrdersById = {};
      allOrders.forEach((wo) => { allOrdersById[wo.id] = wo; });

      const normalized = list
        .map((ev) => {
          const s = fromDbString(ev.start) || fromDbString(ev.scheduledDate);
          const e =
            fromDbString(ev.end) ||
            fromDbString(ev.scheduledEnd) ||
            (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : null);

          // Cross-reference with allOrders for assignedTo data
          const full = allOrdersById[ev.id];

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
          };
        })
        .filter((o) => o.scheduledDate && isSameDay(o.scheduledDate, day));

      normalized.sort((a, b) => {
        const sa = a.scheduledDate ? +a.scheduledDate : 0;
        const sb = b.scheduledDate ? +b.scheduledDate : 0;
        return sa - sb;
      });

      // Diagnostic: verify assignedTo data is reaching the modal
      console.log('[Calendar Modal] Work orders for day:', JSON.stringify(normalized.map(wo => ({
        id: wo.id,
        customer: wo.customer,
        assignedTo: wo.assignedTo,
        assignedToName: wo.assignedToName,
        fromAllOrders: allOrdersById[wo.id] ? {
          assignedTo: allOrdersById[wo.id].assignedTo,
          assignedToName: allOrdersById[wo.id].assignedToName,
        } : 'NOT_FOUND_IN_ALL_ORDERS',
      }))));

      setDayOrders(normalized);
      setDayForModal(day.toDate());
      setDayModalTitle(`Work Orders for ${day.format("LL")}`);
      setDayModalOpen(true);
    } catch (e) {
      console.error("⚠️ Error loading day:", e);
      alert("Failed to load that day.");
    }
  }

  /* ===== Tech assignment handler ===== */
  async function handleAssignTech(orderId, techIdStr) {
    const techId = techIdStr ? Number(techIdStr) : null;
    const techObj = techs.find((t) => t.id === techId);
    const techName = techObj?.username || "";
    try {
      const form = new FormData();
      form.append("assignedTo", techId != null ? String(techId) : "");
      await api.put(`/work-orders/${orderId}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // Update local state immediately
      setDayOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, assignedTo: techId, assignedToName: techName } : o
        )
      );
      // Flash success indicator
      setTechSavedId(orderId);
      setTimeout(() => setTechSavedId(null), 1200);
      // Refresh background data
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error assigning tech:", e);
      alert("Failed to assign tech.");
    }
  }

  /* ===== Inline edit-time helpers ===== */
  function startInlineEdit(order) {
    const s = fromDbString(order.scheduledDate);
    const e = fromDbString(order.scheduledEnd) ||
      (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : new Date());
    setInlineEditId(order.id);
    setInlineStartTime(s ? fmtTime(s) : "08:00");
    setInlineEndTime(e ? fmtTime(e) : "10:00");
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

    setSchedulePayload(item.id, {
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
    if (event?.kind === "pickup") {
      setPickupDetail({
        id: event.pickupId,
        supplier: event.supplier,
        assignedTech: event.assignedTech || "",
        notes: event.notes || "",
        scheduledDate: event.start,
      });
      setPickupDetailOpen(true);
      return;
    }
    const full = allOrders.find((o) => Number(o.id) === Number(event.id)) || event;
    openEditModal(full);
  }

  async function deletePickupFromDetail() {
    if (!pickupDetail?.id) return;
    if (!window.confirm(`Delete pickup for ${pickupDetail.supplier}?`)) return;
    try {
      await api.delete(`/supplier-pickups/${pickupDetail.id}`);
      // Remove from state immediately
      setSupplierPickups((prev) => prev.filter((p) => p.id !== pickupDetail.id));
      setPickupDetailOpen(false);
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error deleting pickup:", e);
      alert("Failed to delete pickup.");
    }
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
    // Cross-reference with /work-orders so each event carries the
    // authoritative assignedTo / assignedToName (the /calendar/events
    // payload doesn't always include it).
    const allOrdersById = {};
    allOrders.forEach((wo) => {
      allOrdersById[wo.id] = wo;
    });

    const woEvents = events.map((o) => {
      const start = fromDbString(o.start) || new Date();
      const end = fromDbString(o.end) || moment(start).add(DEFAULT_WINDOW_MIN, "minutes").toDate();

      const idLabel = displayWOThenPO(o);
      const title = o.customer ? `${o.customer} — ${idLabel}` : idLabel;
      const full = allOrdersById[o.id];

      return {
        ...o,
        title,
        start,
        end,
        allDay: false,
        kind: "wo",
        assignedTo: full?.assignedTo ?? o.meta?.assignedTo ?? o.assignedTo ?? null,
        assignedToName:
          full?.assignedToName ?? o.meta?.assignedToName ?? o.assignedToName ?? "",
      };
    });

    const pickupEvents = supplierPickups
      .filter((p) => !!p.scheduledDate)
      .map((p) => {
        const start = moment(p.scheduledDate).startOf("day").add(8, "hours").toDate();
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
  }, [events, allOrders, supplierPickups]);

  // Context value for the custom Day view's tech dropdown.
  // Built fresh each render so the handler always closes over current state.
  const techContextValue = { techs, onAssignTech: handleAssignTech, techSavedId };

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

  /* ===== Supplier Pickup modal + drag ===== */
  function openPickupModal() {
    setPickupForm({ supplier: "", notes: "", assignedTech: "" });
    setPickupModalOpen(true);
  }

  function closePickupModal() {
    if (pickupSaving) return;
    setPickupModalOpen(false);
  }

  async function savePickup() {
    const supplier = (pickupForm.supplier || "").trim();
    if (!supplier) {
      alert("Please choose a supplier.");
      return;
    }
    setPickupSaving(true);
    try {
      // Default scheduledDate to today so it lands on the calendar immediately.
      const scheduledDate =
        (pickupForm.scheduledDate && pickupForm.scheduledDate.trim()) ||
        new Date().toISOString().split("T")[0];

      const { data: newPickup } = await api.post("/supplier-pickups", {
        supplier,
        scheduledDate,
        notes: pickupForm.notes || null,
        assignedTech: pickupForm.assignedTech || null,
      });

      // Optimistically add to state so the orange card shows up without waiting for refresh.
      if (newPickup && newPickup.id != null) {
        setSupplierPickups((prev) => [...prev, newPickup]);
      }

      setPickupModalOpen(false);
      // Background refresh to sync with server truth (handles assignedTech normalization etc.)
      await Promise.all([fetchCalendarForVisibleRange(), refreshLists()]);
    } catch (e) {
      console.error("⚠️ Error creating pickup:", e);
      alert("Failed to create supplier pickup.");
    } finally {
      setPickupSaving(false);
    }
  }

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
      return {
        style: {
          background: "#ea580c",
          border: "1px solid #c2410c",
          color: "#fff",
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
            </h4>

            <div className="d-flex align-items-center" style={{ gap: 8, flexWrap: "wrap" }}>
              <div className="input-group" style={{ maxWidth: 620 }}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Search customer, site location, site address, WO #, or PO # (includes scheduled)"
                  value={unscheduledSearch}
                  onChange={(e) => setUnscheduledSearch(e.target.value)}
                />
                {unscheduledSearch ? (
                  <button className="btn btn-outline-secondary" onClick={clearUnscheduledSearch}>
                    Clear
                  </button>
                ) : null}
              </div>

              <button
                className="btn btn-primary"
                onClick={openPickupModal}
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
                const e2 =
                  fromDbString(order.scheduledEnd) ||
                  (s ? moment(s).add(DEFAULT_WINDOW_MIN, "minutes").toDate() : null);
                if (s) {
                  currentWhen = `${moment(s).format("MMM D, YYYY h:mm A")}${
                    e2 ? ` – ${moment(e2).format("h:mm A")}` : ""
                  }`;
                }
              }

              return (
                <div
                  key={order.id}
                  className="unscheduled-item"
                  draggable
                  onDragStart={(e) => beginGlobalDrag(order, e)}
                  onDragEnd={endGlobalDrag}
                  title={`${customerLabel} — ${idLabel}`}
                >
                  <div className="d-flex align-items-center justify-content-between" style={{ gap: 8 }}>
                    <div className="fw-bold" style={clamp1}>
                      {customerLabel} — {idLabel}
                    </div>
                    {isScheduled && <span className="badge text-bg-secondary">Scheduled</span>}
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

                  <div
                    className="unscheduled-actions"
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                  >
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
            min={moment().startOf("day").add(6, "hours").toDate()}
            max={moment().startOf("day").add(21, "hours").toDate()}
            selectable
            draggableAccessor={() => true}
            dragFromOutsideItem={() => dragItemRef.current}
            onDropFromOutside={handleDropFromOutside}
            onEventDrop={handleEventDrop}
            onEventResize={handleEventResize}
            onSelectEvent={onSelectEvent}
            onDoubleClickEvent={(e) => navigateToView(e.id)}
            onSelectSlot={onSelectSlot}
            onShowMore={onShowMore}
            views={{
              month: true,
              week: StackedWeekView,
              day: StackedDayView,
              agenda: CardAgendaView,
            }}
            view={view}
            onView={(v) => setView(v)}
            date={currentDate}
            onNavigate={(d) => setCurrentDate(d)}
            components={{
              event: CustomEvent,
            }}
            eventPropGetter={eventPropGetter}
            className={`rbc-enhanced ${view === "week" ? "rbc-week-pretty" : ""}`}
            style={{
              height: "auto",
              minHeight: view === "week" ? "86vh" : "78vh",
            }}
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

                  return (
                    <div
                      key={o.id}
                      className="dm-card"
                      style={{ borderLeftColor: borderColor }}
                    >
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
                            <select
                              className="dm-tech-select"
                              value={techId}
                              onChange={(ev) => handleAssignTech(o.id, ev.target.value)}
                              style={{
                                WebkitAppearance: 'auto',
                                MozAppearance: 'auto',
                                appearance: 'auto',
                                backgroundColor: '#2c2c2e',
                                color: '#f5f5f7',
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                                borderRadius: '8px',
                                padding: '6px 12px',
                                fontSize: '13px',
                                cursor: 'pointer',
                                outline: 'none',
                                minWidth: '120px',
                                backgroundImage: 'none',
                              }}
                            >
                              <option value="">Unassigned</option>
                              {techs.map((t) => (
                                <option key={t.id} value={String(t.id)}>
                                  {t.username}
                                </option>
                              ))}
                            </select>
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
      {pickupModalOpen && (
        <div className="modal-overlay" onClick={closePickupModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>📦 New Supplier Pickup</h3>
              <button
                className="modal-close"
                onClick={closePickupModal}
                aria-label="Close"
                type="button"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="mb-3">
                <label className="form-label small">Supplier *</label>
                <select
                  className="form-select"
                  value={pickupForm.supplier}
                  onChange={(e) =>
                    setPickupForm((f) => ({ ...f, supplier: e.target.value }))
                  }
                >
                  <option value="">— Select supplier —</option>
                  {pickupSuppliers.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-3">
                <label className="form-label small">Assign Tech</label>
                <select
                  className="form-select"
                  value={pickupForm.assignedTech}
                  onChange={(e) =>
                    setPickupForm((f) => ({ ...f, assignedTech: e.target.value }))
                  }
                >
                  <option value="">— Unassigned —</option>
                  {techs.map((t) => (
                    <option key={t.id} value={t.username}>
                      {t.username}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-3">
                <label className="form-label small">Notes</label>
                <textarea
                  className="form-control"
                  rows={3}
                  value={pickupForm.notes}
                  onChange={(e) =>
                    setPickupForm((f) => ({ ...f, notes: e.target.value }))
                  }
                  placeholder="Optional notes…"
                />
              </div>

              <div className="d-flex justify-content-end">
                <button
                  className="btn btn-outline-secondary me-2"
                  onClick={closePickupModal}
                  disabled={pickupSaving}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={savePickup}
                  disabled={pickupSaving}
                  type="button"
                >
                  {pickupSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Supplier Pickup detail modal ---------- */}
      {pickupDetailOpen && pickupDetail && (
        <div className="modal-overlay" onClick={() => setPickupDetailOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>📦 Supplier Pickup</h3>
              <button
                className="modal-close"
                onClick={() => setPickupDetailOpen(false)}
                aria-label="Close"
                type="button"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="mb-2">
                <strong>Supplier:</strong> {pickupDetail.supplier}
              </div>
              <div className="mb-2">
                <strong>Tech:</strong>{" "}
                {pickupDetail.assignedTech || <span className="text-muted">Unassigned</span>}
              </div>
              {pickupDetail.scheduledDate ? (
                <div className="mb-2">
                  <strong>Date:</strong>{" "}
                  {moment(pickupDetail.scheduledDate).format("MMM D, YYYY")}
                </div>
              ) : null}
              {pickupDetail.notes ? (
                <div className="mb-2">
                  <strong>Notes:</strong>
                  <div style={{ whiteSpace: "pre-wrap" }}>{pickupDetail.notes}</div>
                </div>
              ) : null}

              <div className="d-flex justify-content-end mt-3">
                <button
                  className="btn btn-outline-danger me-2"
                  onClick={deletePickupFromDetail}
                  type="button"
                >
                  Delete
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setPickupDetailOpen(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
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
