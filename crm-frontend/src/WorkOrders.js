// File: src/WorkOrders.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import { Link, useNavigate } from "react-router-dom";
import moment from "moment";
import { jwtDecode } from "jwt-decode";
import "./WorkOrders.css";

/**
 * STATUS LIST (display & dropdown order; "Parts In" removed)
 * Chip bar normally renders: Today + STATUS_LIST in this exact order.
 */
const STATUS_LIST = [
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

/**
 * Tabs that get the DAYS WAITING column. These are the three "parked" statuses
 * where a work order sits until someone acts, so age is the signal that matters.
 * The tab is sorted longest-waiting first.
 */
const AGING_TABS = ["Waiting on Parts", "Needs to be Scheduled", "Waiting for Approval"];

// ---------- helpers ----------
const norm = (v) => (v ?? "").toString().trim();

/**
 * Whole days since the WO entered its current status.
 * Returns null when statusChangedAt is NULL — no history exists for that WO and
 * the column shows "—" rather than a number derived from a guess.
 */
const daysInStatus = (o) => {
  if (!o?.statusChangedAt) return null;
  const t = moment.utc(o.statusChangedAt);
  if (!t.isValid()) return null;
  return Math.max(0, moment().diff(t, "days"));
};
const statusKey = (s) =>
  norm(s).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const normStatus = statusKey;

// Canonical status map (only statuses we keep)
const CANON = new Map(STATUS_LIST.map((label) => [statusKey(label), label]));

// Map variants/legacy values -> canonical
const STATUS_SYNONYMS = new Map([
  ["new", "New"],

  ["needs quote", "Needs to be Quoted"],
  ["needs to be quoted", "Needs to be Quoted"],

  ["need to be scheduled", "Needs to be Scheduled"],
  ["needs to be schedule", "Needs to be Scheduled"],

  ["waiting for approval", "Waiting for Approval"],
  ["waiting-on-approval", "Waiting for Approval"],
  ["waiting_on_approval", "Waiting for Approval"],
  ["waiting on approval", "Waiting for Approval"],

  ["approved", "Approved"],

  ["declined", "Declined"],

  ["waiting on parts", "Waiting on Parts"],
  ["waiting-on-parts", "Waiting on Parts"],
  ["waiting_on_parts", "Waiting on Parts"],
  ["waitingonparts", "Waiting on Parts"],

  ["needs to be invoiced", "Needs to be Invoiced"],
  ["needs invoiced", "Needs to be Invoiced"],

  ["invoiced waiting for payment", "Invoiced Waiting for Payment"],
  ["invoiced-waiting-for-payment", "Invoiced Waiting for Payment"],
  ["invoiced_waiting_for_payment", "Invoiced Waiting for Payment"],
  ["invoiced waiting payment", "Invoiced Waiting for Payment"],
  ["waiting for payment", "Invoiced Waiting for Payment"],
  ["waiting on payment", "Invoiced Waiting for Payment"],
  ["awaiting payment", "Invoiced Waiting for Payment"],

  // Legacy: map any "Parts In" variants to "Needs to be Scheduled"
  ["part in", "Needs to be Scheduled"],
  ["parts in", "Needs to be Scheduled"],
  ["parts  in", "Needs to be Scheduled"],
  ["parts-in", "Needs to be Scheduled"],
  ["parts_in", "Needs to be Scheduled"],
  ["partsin", "Needs to be Scheduled"],
  ["part s in", "Needs to be Scheduled"],
]);

const toCanonicalStatus = (s) =>
  CANON.get(statusKey(s)) || STATUS_SYNONYMS.get(statusKey(s)) || norm(s);

// Per-status accent colors (used for chips/badges that need to stand out).
// Statuses not in this map fall back to default chip styling.
const STATUS_COLOR = {
  "Invoiced Waiting for Payment": "#f59e0b",
};

// Hide legacy PO values that equal WO
const isLegacyWoInPo = (wo, po) => !!norm(wo) && norm(wo) === norm(po);
const displayPO = (wo, po) => (isLegacyWoInPo(wo, po) ? "" : norm(po));

const authHeaders = () => {
  const token = localStorage.getItem("jwt");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const clampStyle = (lines) => ({
  display: "-webkit-box",
  WebkitLineClamp: lines,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "normal",
});

/**
 * Site name / address for a row. The siteLocation column holds a *name* on
 * newer work orders but an *address* on legacy ones, so whichever slot is
 * still empty absorbs it. Shared by the main table and the Day Review rows so
 * the two can't drift apart.
 */
const deriveSite = (order) => {
  const rawLocField = norm(order.siteLocation);
  let siteLocationName = norm(order.siteName) || norm(order.siteLocationName);
  let siteAddress =
    norm(order.siteAddress) || norm(order.serviceAddress) || norm(order.address);

  if (!siteAddress && rawLocField) siteAddress = rawLocField;
  else if (!siteLocationName && rawLocField) siteLocationName = rawLocField;

  return { siteLocationName, siteAddress };
};

/* -------------------------------------------------------------------------- */
/* Day Review helpers — Central-time calendar days.                           */
/* scheduledDate is stored as naive Central wall-clock (see the day-review     */
/* endpoint's timezone note), so a day is just its 'YYYY-MM-DD' prefix and     */
/* every comparison here is a plain string compare — no Date parsing, no       */
/* browser-timezone drift.                                                     */
/* -------------------------------------------------------------------------- */
const CHICAGO_TZ = "America/Chicago";

// Today in Central as 'YYYY-MM-DD' ("en-CA" renders ISO order).
const chicagoToday = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: CHICAGO_TZ });

// Shift a 'YYYY-MM-DD' by whole days, in UTC so a DST-shifted local midnight
// can't land back on the same date.
const addDaysToDayStr = (dayStr, delta) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ""));
  if (!m) return "";
  const u = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  u.setUTCDate(u.getUTCDate() + Number(delta));
  return u.toISOString().slice(0, 10);
};

// "Tuesday, Oct 6" — built from the parts so the label never shifts a day.
const fmtDayLabel = (dayStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ""));
  if (!m) return "—";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(
    "en-US",
    { weekday: "long", month: "short", day: "numeric" }
  );
};

// Scheduled time-of-day, e.g. "7:00 PM". Reads the stored wall clock directly.
const fmtSchedTime = (raw) => {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(String(raw || "").trim());
  if (!m) return "";
  let h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
};

// The three Day Review sections, rendered in this order: the action list first.
const REVIEW_SECTIONS = [
  {
    key: "missed",
    title: "Missed",
    blurb: "Still Scheduled after the day passed — these need rescheduling.",
    accent: "var(--accent-red)",
  },
  {
    key: "moved",
    title: "Moved Along",
    blurb: "Serviced, but the visit left downstream work.",
    accent: "var(--accent-orange)",
  },
  {
    key: "done",
    title: "Done",
    blurb: "Serviced and into the billing chain.",
    accent: "var(--accent-green)",
  },
];

// How long a rescheduled job is blocked out for, matching CalendarPage.
const RESCHEDULE_WINDOW_MIN = 120;

/* -------------------------------------------------------------------------- */
/* Created-date helpers — America/Chicago, consistent with the note-timestamp
   formatting in ViewWorkOrder (parse UTC-naive by appending Z, render via
   toLocaleString with timeZone "America/Chicago").                           */
const parseUtcNaive = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already carries a zone (Z or ±hh:mm)? use as-is. Otherwise treat as UTC.
  const iso = /(z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

const chicagoYear = (d) =>
  d.toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric" });

// Compact date: "Jul 28" for the current year, "Jul 28 '25" for prior years.
const fmtCreatedCompact = (raw) => {
  const d = parseUtcNaive(raw);
  if (!d) return "—";
  const monthDay = d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
  });
  const yr = chicagoYear(d);
  const nowYr = chicagoYear(new Date());
  return yr === nowYr ? monthDay : `${monthDay} '${yr.slice(-2)}`;
};

// Full date/time for the title/hover, e.g. "Jul 28, 2026, 10:59 AM".
const fmtCreatedFull = (raw) => {
  const d = parseUtcNaive(raw);
  if (!d) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

/* -------------------------------------------------------------------------- */
/* Notes helpers — tolerant of server TEXT format like:
   "[2025-11-05 19:06:12.555] Mark: test note from curl"
   and also supports JSON-array notes if present.                             */
/* -------------------------------------------------------------------------- */
function parseLatestNote(notes) {
  if (!notes) return null;

  // If array (newer UIs), get last
  if (Array.isArray(notes) && notes.length) {
    const last = notes[notes.length - 1];
    return {
      text: String(last?.text ?? "").trim(),
      createdAt: last?.createdAt || last?.time || null,
      author: last?.author || last?.user || null,
    };
  }

  // If JSON stringified array
  const s = String(notes);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.length) {
      const last = arr[arr.length - 1];
      return {
        text: String(last?.text ?? "").trim(),
        createdAt: last?.createdAt || last?.time || null,
        author: last?.author || last?.user || null,
      };
    }
  } catch {
    // Plain text fallback
  }

  // Plain text (server appends new lines). Find the last bracketed entry.
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const lastBracket =
    [...lines].reverse().find((l) => /^\[[^\]]+\]\s*/.test(l)) ||
    lines[lines.length - 1];

  const m = lastBracket.match(/^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/);
  if (m) {
    return { createdAt: m[1], author: m[2], text: m[3] };
  }
  return { text: lastBracket, createdAt: null, author: null };
}

export default function WorkOrders() {
  const navigate = useNavigate();

  // role + username from token
  const token = localStorage.getItem("jwt");
  let userRole = null;
  let username = null;
  if (token) {
    try {
      const decoded = jwtDecode(token);
      userRole = decoded.role;
      username = decoded.username || decoded.user || null;
    } catch {
      console.warn("Invalid JWT");
    }
  }

  // 🔒 Special restriction for user "jeffsr"
  const isJeffSr = username && username.toLowerCase() === "jeffsr";

  // For jeffsr, only show these status tabs; everyone else gets the full list.
  const visibleStatusList = isJeffSr
    ? ["Scheduled", "Needs to be Scheduled", "Needs to be Quoted", "Needs to be Invoiced", "Invoiced Waiting for Payment"]
    : STATUS_LIST;

  // state
  const [workOrders, setWorkOrders] = useState([]);
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState("Today"); // default to Today
  const [techUsers, setTechUsers] = useState([]);

  // UX
  const [flashMsg, setFlashMsg] = useState("");

  // Follow-Up tab state
  const [followup, setFollowup] = useState([]);
  const [followupLoading, setFollowupLoading] = useState(false);
  // Log Call modal: { wo } when open, null when closed
  const [callModalWO, setCallModalWO] = useState(null);
  const [callHistory, setCallHistory] = useState([]);
  const [callOutcome, setCallOutcome] = useState("Left Voicemail");
  const [callNotes, setCallNotes] = useState("");
  const [callSaving, setCallSaving] = useState(false);

  // Day Review tab state. `reviewDate` is null until the user navigates: the
  // first load lets the server choose the landing day (most recent past day
  // that actually had jobs), so an empty weekend never opens as a blank page.
  const [reviewDate, setReviewDate] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");

  // Reschedule modal (Missed rows): { wo } when open, null when closed
  const [rescheduleWO, setRescheduleWO] = useState(null);
  const [rsDate, setRsDate] = useState("");
  const [rsTime, setRsTime] = useState("");
  const [rsEndTime, setRsEndTime] = useState("");
  const [rsSaving, setRsSaving] = useState(false);

  const CALL_OUTCOMES = [
    "Left Voicemail",
    "Spoke - Considering",
    "Spoke - Approved",
    "Spoke - Declined",
    "No Answer",
    "Wrong Number",
    "Other",
  ];

  const fetchFollowup = async () => {
    setFollowupLoading(true);
    try {
      const res = await api.get("/work-orders/followup", { headers: authHeaders() });
      setFollowup(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching follow-up list:", err);
      setFollowup([]);
    } finally {
      setFollowupLoading(false);
    }
  };

  /**
   * Load one day's debrief. Buckets and counts come from the server so the
   * summary strip and the sections are computed once, in one place.
   * Passing no date asks the server for the landing day.
   */
  const fetchDayReview = async (date) => {
    setReviewLoading(true);
    setReviewError("");
    try {
      const res = await api.get("/work-orders/day-review", {
        params: date ? { date } : {},
        headers: authHeaders(),
      });
      setReview(res.data || null);
      return res.data || null;
    } catch (err) {
      console.error("Error fetching day review:", err);
      setReview(null);
      setReviewError(
        err?.response?.data?.error || "Couldn't load the day review."
      );
      return null;
    } finally {
      setReviewLoading(false);
    }
  };

  // NOTE: return the promise so `await fetchWorkOrders()` actually waits.
  const fetchWorkOrders = async () => {
    try {
      const res = await api.get("/work-orders", { headers: authHeaders() });
      const data = Array.isArray(res.data) ? res.data : [];
      const canon = data.map((o) => ({
        ...o,
        status: toCanonicalStatus(o.status),
      }));
      setWorkOrders(canon);
      return canon;
    } catch (err) {
      console.error("Error fetching work orders:", err);
      return [];
    }
  };

  // load data
  useEffect(() => {
    fetchWorkOrders();
    // Fetch the Follow-Up list on mount so its tab badge shows the correct count
    // immediately (it comes from a separate filtered endpoint, not the generic
    // work-orders list, so the count can't be derived client-side like the others).
    fetchFollowup();
    if (userRole !== "tech") {
      api
        .get("/users", { params: { assignees: 1 }, headers: authHeaders() })
        .then((r) => setTechUsers(Array.isArray(r.data) ? r.data : []))
        .catch((err) => console.error("Error fetching assignable users:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the follow-up list whenever its tab becomes active
  useEffect(() => {
    if (selectedFilter === "Follow-Up") fetchFollowup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilter]);

  // Day Review loads when its tab opens and whenever the reviewed day changes.
  useEffect(() => {
    if (selectedFilter === "Day Review") fetchDayReview(reviewDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilter, reviewDate]);

  const isPastDue = (o) =>
    toCanonicalStatus(o.status) === "Scheduled" &&
    o.scheduledDate &&
    moment(o.scheduledDate).isBefore(moment().startOf("day"));

  // filtering
  useEffect(() => {
    const todayStr = moment().format("YYYY-MM-DD");

    let rows = workOrders;
    if (selectedFilter === "Today") {
      rows = workOrders.filter(
        (o) =>
          o.scheduledDate &&
          moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      );
    } else if (selectedFilter === "Past Due") {
      rows = workOrders.filter(isPastDue);
    } else {
      const f = normStatus(selectedFilter);
      rows = workOrders.filter((o) => normStatus(o.status) === f);
    }

    // Today is the crew's run sheet, so it sorts by the arranged service order
    // (1 = first job). Unsequenced jobs (serviceOrder NULL) fall to the bottom
    // ordered by scheduled time, which is where a newly-added job belongs.
    if (selectedFilter === "Today") {
      rows = [...rows].sort((a, b) => {
        const sa = a.serviceOrder == null ? Infinity : Number(a.serviceOrder);
        const sb = b.serviceOrder == null ? Infinity : Number(b.serviceOrder);
        if (sa !== sb) return sa - sb;
        const ta = a.scheduledDate ? +moment(a.scheduledDate) : Infinity;
        const tb = b.scheduledDate ? +moment(b.scheduledDate) : Infinity;
        if (ta !== tb) return ta - tb;
        return a.id - b.id;
      });
    }

    // Staleness tabs lead with the longest-waiting work order. Unknown ages
    // (statusChangedAt NULL) sort to the bottom — they're missing data, not fresh.
    if (AGING_TABS.includes(selectedFilter)) {
      rows = [...rows].sort((a, b) => {
        const da = daysInStatus(a);
        const db_ = daysInStatus(b);
        if (da == null && db_ == null) return b.id - a.id;
        if (da == null) return 1;
        if (db_ == null) return -1;
        return db_ - da || b.id - a.id;
      });
    }

    setFilteredOrders(rows);
  }, [workOrders, selectedFilter]);

  // counts
  const chipCounts = useMemo(() => {
    const buckets = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]));
    let today = 0;
    let pastDue = 0;
    const todayStr = moment().format("YYYY-MM-DD");
    for (const o of workOrders) {
      const label = toCanonicalStatus(o.status);
      if (label in buckets) buckets[label] += 1;
      if (
        o.scheduledDate &&
        moment(o.scheduledDate).format("YYYY-MM-DD") === todayStr
      ) {
        today++;
      }
      if (isPastDue(o)) pastDue++;
    }
    return {
      Today: today,
      "Past Due": pastDue,
      ...buckets,
    };
  }, [workOrders]);

  const setFilter = (value) => setSelectedFilter(value);

  // Days Waiting column: the three parked-status tabs. Parts indicator: Waiting
  // on Parts only — it's the only tab where a PO's pickup state is the next action.
  const showAging = AGING_TABS.includes(selectedFilter);
  const showParts = selectedFilter === "Waiting on Parts";
  // Only Today is drag-arrangeable — it's the one tab that represents a single
  // day's run. Every other tab spans many days, where a per-day sequence is
  // meaningless.
  const showSequence = selectedFilter === "Today";

  /* ---------- Today: drag to arrange the day's service order ---------- */
  // Native HTML5 drag-and-drop rather than a library: CalendarPage already
  // reorders this way, react-dnd is only wired into the settings modal, and a
  // table-row reorder needs nothing fancier.
  const dragIdRef = useRef(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const onRowDragStart = (e, id) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag without payload
    try { e.dataTransfer.setData("text/plain", String(id)); } catch {}
  };

  const onRowDragOver = (e, id) => {
    if (dragIdRef.current == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverId !== id) setDragOverId(id);
  };

  const onRowDragEnd = () => {
    dragIdRef.current = null;
    setDragOverId(null);
  };

  const onRowDrop = async (e, targetId) => {
    e.preventDefault();
    const srcId = dragIdRef.current;
    dragIdRef.current = null;
    setDragOverId(null);
    if (srcId == null || srcId === targetId) return;

    const cur = filteredOrders;
    const from = cur.findIndex((o) => o.id === srcId);
    const to = cur.findIndex((o) => o.id === targetId);
    if (from < 0 || to < 0) return;

    const next = [...cur];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setFilteredOrders(next); // optimistic; the refetch below re-sorts from the server

    const date = moment().format("YYYY-MM-DD");
    setSavingOrder(true);
    try {
      await api.put(
        "/work-orders/day-order",
        { date, orderedIds: next.map((o) => o.id) },
        { headers: authHeaders() }
      );
      await fetchWorkOrders();
    } catch (err) {
      console.error("⚠️ Failed to save the day order:", err);
      alert(err?.response?.data?.error || "Couldn't save the new order — reloading.");
      await fetchWorkOrders(); // discard the optimistic order
    } finally {
      setSavingOrder(false);
    }
  };

  /**
   * Compact one-line parts state from work_order_pos, e.g.
   *   "PO 585 · Chicago Tempered · not picked up"
   *   "PO 585 · Chicago Tempered · PICKED UP ✓ — parts are in"
   * Returns null when the WO has no POs, so those rows stay unchanged.
   *
   * A picked-up PO on a WO still sitting in Waiting on Parts is the actionable
   * anomaly — the parts arrived and nobody moved the job — so it gets the red
   * attention treatment rather than the orange "still on order" state.
   */
  const partsIndicator = (order) => {
    const count = Number(order.poCount || 0);
    if (!count) return null;

    const pickedUp = Number(order.poPickedUpCount || 0);
    const label = order.firstPoNumber ? `PO ${order.firstPoNumber}` : "PO (no #)";
    const supplier = norm(order.firstPoSupplier);
    const more = count > 1 ? ` +${count - 1}` : "";
    const head = `${label}${more}${supplier ? ` · ${supplier}` : ""}`;

    if (pickedUp > 0) {
      const which = count > 1 ? `${pickedUp} of ${count} POs picked up` : "PO picked up";
      return {
        text: `${head} · PARTS IN ✓`,
        color: "var(--accent-red)",
        title: `${which}, but the work order is still Waiting on Parts — ready to schedule.`,
      };
    }

    return {
      text: `${head} · not picked up`,
      color: "var(--accent-orange)",
      title:
        count > 1
          ? `${count} purchase orders, none picked up yet.`
          : "Purchase order not picked up yet.",
    };
  };

  /* ------------------------------------------------------------------------ */
  /* FOLLOW-UP: Log Call modal                                                */
  /* ------------------------------------------------------------------------ */
  const openCallModal = async (wo) => {
    setCallModalWO(wo);
    setCallOutcome("Left Voicemail");
    setCallNotes("");
    setCallHistory([]);
    try {
      const res = await api.get(`/work-orders/${wo.id}/followup-calls`, { headers: authHeaders() });
      setCallHistory(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching call history:", err);
    }
  };

  const closeCallModal = () => {
    setCallModalWO(null);
    setCallHistory([]);
    setCallNotes("");
  };

  const saveCall = async () => {
    if (!callModalWO || !callOutcome) return;
    setCallSaving(true);
    try {
      await api.post(
        `/work-orders/${callModalWO.id}/followup-calls`,
        { outcome: callOutcome, notes: callNotes },
        { headers: authHeaders() }
      );
      await fetchFollowup(); // refresh row last-call info
      closeCallModal();
    } catch (err) {
      console.error("Error logging call:", err);
      alert(err?.response?.data?.error || "Failed to log call.");
    } finally {
      setCallSaving(false);
    }
  };

  // Quick shortcut from the modal: set WO status, then refresh the list
  const setWoStatusFromModal = async (id, newStatus) => {
    try {
      await api.put(`/work-orders/${id}/status`, { status: newStatus }, { headers: authHeaders() });
      await fetchFollowup();
      await fetchWorkOrders();
      closeCallModal();
      if (newStatus === "Approved") {
        // Estimate-approval flow lives on the WO detail page — jump there
        navigate(`/view-work-order/${id}`, { state: { from: "/work-orders" } });
      }
    } catch (err) {
      console.error("Error updating status from modal:", err);
      alert(err?.response?.data?.error || "Failed to update status.");
    }
  };

  // Days-waiting badge color: green <7, amber 7-14, red >14
  const daysBadgeColor = (d) => {
    if (d == null) return "#6b7280";
    if (d > 14) return "#dc2626";
    if (d >= 7) return "#f59e0b";
    return "#22c55e";
  };

  // Same green/orange/red thresholds as the Follow-Up badge, but using the design
  // system's accent tokens so the table tracks light/dark themes.
  const agingColorToken = (d) => {
    if (d == null) return "var(--text-secondary)";
    if (d > 14) return "var(--accent-red)";
    if (d >= 7) return "var(--accent-orange)";
    return "var(--accent-green)";
  };

  /* ------------------------------------------------------------------------ */
  /* SINGLE-ROW STATUS CHANGE  (PUT /work-orders/:id/status)                  */
  /* ------------------------------------------------------------------------ */
  const handleStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = toCanonicalStatus(e.target.value);

    const prev = workOrders;
    const next = prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o));
    setWorkOrders(next);

    try {
      await api.put(
        `/work-orders/${id}/status`,
        { status: newStatus },
        { headers: authHeaders() }
      );
      await fetchWorkOrders();
    } catch (err) {
      console.error("Error updating status:", err);
      setWorkOrders(prev);
      const msg =
        err?.response?.data?.error ||
        (err?.response?.status === 401
          ? "Missing or invalid token."
          : "Failed to update status.");
      alert(msg);
    }
  };

  // Set primary tech via the multi-tech endpoint (replaces full tech list).
  // The endpoint also writes work_orders.assignedTo so older code paths keep working.
  const assignToTech = async (orderId, techId, e) => {
    e.stopPropagation();
    try {
      const userIds = techId ? [Number(techId)] : [];
      await setRowTechs(orderId, userIds);
    } catch (err) {
      console.error("Error assigning tech:", err);
      alert(err?.response?.data?.error || "Failed to assign technician.");
    }
  };

  // Replace the full tech list for one row. Optimistic local update + refetch.
  const setRowTechs = async (orderId, userIds) => {
    const ids = Array.from(new Set((userIds || []).map(Number).filter(Boolean)));
    const names = ids
      .map((id) => techUsers.find((t) => Number(t.id) === id)?.username || "")
      .filter(Boolean);
    setWorkOrders((prev) =>
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
    try {
      await api.put(
        `/work-orders/${orderId}/techs`,
        { userIds: ids },
        { headers: { "Content-Type": "application/json", ...authHeaders() } }
      );
      await fetchWorkOrders();
    } catch (err) {
      console.error("Error setting techs:", err);
      alert(err?.response?.data?.error || "Failed to update techs.");
      await fetchWorkOrders();
    }
  };

  /* ------------------------------------------------------------------------ */
  /* DAY REVIEW: reschedule a missed job                                      */
  /* ------------------------------------------------------------------------ */
  // Latest day the review can cover: the debrief is a morning-after read, so
  // "Scheduled" only means "missed" once the day is over. Server-reported
  // Central today wins; the local compute only covers the first paint.
  const maxReviewDate = addDaysToDayStr(review?.today || chicagoToday(), -1);

  const reviewRows = Array.isArray(review?.workOrders) ? review.workOrders : [];
  const reviewBuckets = useMemo(() => {
    const out = { missed: [], moved: [], done: [] };
    for (const r of reviewRows) {
      if (out[r.bucket]) out[r.bucket].push(r);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  /**
   * Open the reschedule picker for a missed job. Defaults to tomorrow, keeping
   * the job's original time of day (that slot was chosen for a reason — site
   * access, a tenant's hours); noon when it had none, matching the server's
   * date-only default. End time blocks out the same window the calendar uses.
   */
  const openReschedule = (wo) => {
    const prevTime = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(
      String(wo?.scheduledDate || "").trim()
    );
    const startHHmm = prevTime ? prevTime[1] : "12:00";
    const [h, mi] = startHHmm.split(":").map(Number);
    const endMins = h * 60 + mi + RESCHEDULE_WINDOW_MIN;
    const endHHmm = `${String(Math.floor(endMins / 60) % 24).padStart(2, "0")}:${String(
      endMins % 60
    ).padStart(2, "0")}`;

    setRescheduleWO(wo);
    setRsDate(addDaysToDayStr(review?.today || chicagoToday(), 1));
    setRsTime(startHHmm);
    setRsEndTime(endHHmm);
  };

  const closeReschedule = () => {
    setRescheduleWO(null);
    setRsSaving(false);
  };

  /**
   * Save the new slot. Mirrors CalendarPage's schedule flow exactly — the same
   * multipart PUT /work-orders/:id/edit with scheduledDate + endTime and
   * status "Scheduled" — so a job rescheduled from here is indistinguishable
   * from one dragged on the calendar. Moving scheduledDate to a future day is
   * what drops the row out of Missed on the refresh below.
   */
  const saveReschedule = async () => {
    if (!rescheduleWO || !rsDate || !rsTime) return;
    if (rsEndTime && rsEndTime <= rsTime) {
      alert("End time must be after the start time.");
      return;
    }
    setRsSaving(true);
    try {
      const form = new FormData();
      form.append("scheduledDate", `${rsDate} ${rsTime}`);
      if (rsEndTime) form.append("endTime", rsEndTime);
      form.append("status", "Scheduled");

      await api.put(`/work-orders/${rescheduleWO.id}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      const woNum = rescheduleWO.workOrderNumber || rescheduleWO.id;
      closeReschedule();
      await Promise.all([fetchDayReview(review?.date), fetchWorkOrders()]);
      setFlashMsg(`WO ${woNum} rescheduled to ${fmtDayLabel(rsDate)}.`);
      setTimeout(() => setFlashMsg(""), 4000);
    } catch (err) {
      console.error("Error rescheduling:", err);
      alert(err?.response?.data?.error || "Failed to reschedule.");
      setRsSaving(false);
    }
  };

  // Status change from a review row. Same endpoint as the table, but the
  // refresh re-buckets the day — marking a forgotten job Completed moves it
  // out of Missed and into Done.
  const handleReviewStatusChange = async (e, id) => {
    e.stopPropagation();
    const newStatus = toCanonicalStatus(e.target.value);
    try {
      await api.put(
        `/work-orders/${id}/status`,
        { status: newStatus },
        { headers: authHeaders() }
      );
      await Promise.all([fetchDayReview(review?.date), fetchWorkOrders()]);
    } catch (err) {
      console.error("Error updating status:", err);
      alert(err?.response?.data?.error || "Failed to update status.");
    }
  };

  // maps
  const googleMapsApiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
  const openAddressInMaps = (e, addr, fallbackLabel) => {
    e.stopPropagation();
    const query = addr || fallbackLabel || "";
    if (!query) return;
    const url = `https://www.google.com/maps/embed/v1/place?key=${googleMapsApiKey}&q=${encodeURIComponent(
      query
    )}`;
    window.open(url, "_blank", "width=900,height=650");
  };

  return (
    <div className="work-orders-page">
      <div className="work-orders-container">
      {flashMsg ? <div className="flash-banner">{flashMsg}</div> : null}

      <div className="work-orders-header">
        <div>
          <h2 className="work-orders-title">Work Orders</h2>
          <div className="work-orders-subtitle">
            Filter by <span className="pill subtle">Today</span> or by status tabs.
          </div>
        </div>

        <div className="work-orders-actions">
          <Link
            to="/add-work-order"
            className="btn-primary-apple"
            onClick={(e) => e.stopPropagation()}
          >
            + Add New Work Order
          </Link>
        </div>
      </div>

      <div className="section-card">
        <div className="chips-toolbar">
          <div className="chips-row" role="tablist" aria-label="Work order filters">
            {[
              { key: "Today", label: "Today", count: chipCounts.Today },
              // Day Review sits next to Today: both are day-scoped views, and
              // the debrief is the first thing the office opens in the morning.
              // No count — it describes one chosen day, not a standing queue.
              { key: "Day Review", label: "Day Review", count: null },
              ...visibleStatusList.map((s) => ({
                key: s,
                label: s,
                count: chipCounts[s],
              })),
            ].map(({ key, label, count }) => {
              const active = selectedFilter === key;
              const accent = STATUS_COLOR[key];
              const accentStyle = accent
                ? {
                    background: active ? accent : "transparent",
                    border: `2px solid ${accent}`,
                    color: active ? "#fff" : accent,
                    borderRadius: 20,
                    padding: "4px 14px",
                    cursor: "pointer",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }
                : undefined;
              return (
                <button
                  key={key}
                  type="button"
                  className={accent ? "" : `chip ${active ? "active" : ""}`}
                  style={accentStyle}
                  onClick={() => setFilter(key)}
                >
                  <span className="chip-label">{label}</span>
                  {count == null ? null : (
                    <span
                      className={accent ? "" : "chip-count"}
                      style={
                        accent
                          ? {
                              background: active ? "#fff" : accent,
                              color: active ? accent : "#fff",
                              borderRadius: 10,
                              padding: "1px 8px",
                              fontSize: 12,
                              fontWeight: 700,
                            }
                          : undefined
                      }
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setFilter("Past Due")}
              style={{
                background: selectedFilter === "Past Due" ? "#dc2626" : "transparent",
                border: "2px solid #dc2626",
                color: selectedFilter === "Past Due" ? "#fff" : "#dc2626",
                borderRadius: 20,
                padding: "4px 14px",
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Past Due
              <span
                style={{
                  background: selectedFilter === "Past Due" ? "#fff" : "#dc2626",
                  color: selectedFilter === "Past Due" ? "#dc2626" : "#fff",
                  borderRadius: 10,
                  padding: "1px 8px",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {chipCounts["Past Due"] ?? 0}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setFilter("Follow-Up")}
              style={{
                background: selectedFilter === "Follow-Up" ? "#7c3aed" : "transparent",
                border: "2px solid #7c3aed",
                color: selectedFilter === "Follow-Up" ? "#fff" : "#7c3aed",
                borderRadius: 20,
                padding: "4px 14px",
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Follow-Up
              <span
                style={{
                  background: selectedFilter === "Follow-Up" ? "#fff" : "#7c3aed",
                  color: selectedFilter === "Follow-Up" ? "#7c3aed" : "#fff",
                  borderRadius: 10,
                  padding: "1px 8px",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {followup.length}
              </span>
            </button>
          </div>

          {/* ✅ Removed: “Mark Parts In” button + modal feature */}
        </div>

        {selectedFilter === "Follow-Up" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
            {followupLoading && (
              <div className="empty-state">Loading follow-up list…</div>
            )}
            {!followupLoading && followup.length === 0 && (
              <div className="empty-state">
                No direct-customer work orders are waiting for approval. 🎉
              </div>
            )}
            {!followupLoading && followup.map((wo) => {
              const phone = wo.phone;
              const days = wo.daysSinceSent;
              const badgeBg = daysBadgeColor(days);
              const lastTxt = wo.callCount > 0
                ? `${wo.lastOutcome || "Logged"}${wo.lastCalledAt ? ` • ${moment(wo.lastCalledAt).fromNow()}` : ""}`
                : "Never contacted";
              return (
                <div
                  key={wo.id}
                  style={{
                    border: "1px solid var(--border-color, #e5e7eb)",
                    borderRadius: 12,
                    padding: 16,
                    display: "flex",
                    gap: 16,
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    background: "var(--bg-card, #fff)",
                  }}
                >
                  <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
                        {wo.customer || "N/A"}
                      </span>
                      <span
                        style={{
                          background: badgeBg,
                          color: "#fff",
                          borderRadius: 999,
                          padding: "2px 10px",
                          fontSize: 12,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        }}
                        title={wo.estimateSentAt ? `Estimate sent ${moment(wo.estimateSentAt).format("MMM D, YYYY")}` : "No estimate-sent date"}
                      >
                        {days == null ? "—" : `${days} day${days === 1 ? "" : "s"} waiting`}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
                      {wo.siteLocation || "—"}
                      {wo.siteAddress ? ` • ${wo.siteAddress}` : ""}
                    </div>
                    {wo.problemDescription ? (
                      <div style={{ ...clampStyle(2), fontSize: 13, color: "var(--text-primary)", marginTop: 6 }}>
                        {wo.problemDescription}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      {phone ? (
                        <a
                          href={`tel:${phone}`}
                          style={{ fontSize: 16, fontWeight: 700, color: "#2563eb", textDecoration: "none" }}
                        >
                          📞 {phone}
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>No phone on file</span>
                      )}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                      Last follow-up: {lastTxt}
                      {wo.callCount > 0 ? ` (${wo.callCount} attempt${wo.callCount === 1 ? "" : "s"})` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn-primary-apple"
                      onClick={() => openCallModal(wo)}
                    >
                      Log Call
                    </button>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => navigate(`/view-work-order/${wo.id}`, { state: { from: "/work-orders" } })}
                    >
                      Open
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {selectedFilter === "Day Review" && (
          <div className="day-review">
            {/* Date control — the arrows hop to the adjacent day that actually
                had jobs (server-supplied), so they skip empty weekends; the
                picker reaches any past day directly. */}
            <div className="dr-datebar">
              <button
                type="button"
                className="dr-nav"
                onClick={() => setReviewDate(review?.prevDay)}
                disabled={reviewLoading || !review?.prevDay}
                title={
                  review?.prevDay
                    ? `Previous day with jobs — ${fmtDayLabel(review.prevDay)}`
                    : "No earlier day has scheduled jobs"
                }
                aria-label="Previous day with jobs"
              >
                ‹
              </button>

              {/* Shows the day being navigated to right away, so the label
                  doesn't sit on the previous day while the fetch is in flight. */}
              <div className="dr-daylabel">
                {reviewDate || review?.date
                  ? `Reviewing ${fmtDayLabel(reviewDate || review.date)}`
                  : reviewLoading
                  ? "Loading…"
                  : "Day Review"}
                {reviewLoading ? <span className="dr-loading"> · loading…</span> : null}
              </div>

              <button
                type="button"
                className="dr-nav"
                onClick={() => setReviewDate(review?.nextDay)}
                disabled={reviewLoading || !review?.nextDay}
                title={
                  review?.nextDay
                    ? `Next day with jobs — ${fmtDayLabel(review.nextDay)}`
                    : "No later finished day has scheduled jobs"
                }
                aria-label="Next day with jobs"
              >
                ›
              </button>

              <input
                type="date"
                className="control dr-datepicker"
                value={reviewDate || review?.date || ""}
                max={maxReviewDate}
                onChange={(e) => {
                  if (e.target.value) setReviewDate(e.target.value);
                }}
                title="Jump to a day"
                aria-label="Review date"
              />
            </div>

            {reviewError ? (
              <div className="dr-error">{reviewError}</div>
            ) : reviewLoading && !review ? (
              <div className="empty-state">Loading the day review…</div>
            ) : !review?.summary ? null : review.summary.scheduled === 0 ? (
              <div className="empty-state">
                Nothing was scheduled for {fmtDayLabel(review.date)}.
              </div>
            ) : (
              <>
                {/* Summary strip — counts come straight from the server's
                    buckets, the same ones the sections below render. */}
                <div className="dr-summary">
                  <span className="dr-stat">
                    <b>{review.summary.scheduled}</b> scheduled
                  </span>
                  <span className="dr-sep">·</span>
                  <span className="dr-stat">
                    <b>{review.summary.byBucket?.done ?? 0}</b> done
                  </span>
                  <span className="dr-sep">·</span>
                  <span className="dr-stat dr-stat-missed">
                    <b>{review.summary.byBucket?.missed ?? 0}</b> missed
                  </span>
                  <span className="dr-sep">·</span>
                  <span className="dr-stat">
                    <b>{review.summary.byBucket?.moved ?? 0}</b> moved along
                  </span>
                </div>

                {REVIEW_SECTIONS.map(({ key, title, blurb, accent }) => {
                  const rows = reviewBuckets[key] || [];

                  // Zero missed is the goal state, so it gets said out loud.
                  // The other two sections just disappear when empty.
                  if (!rows.length) {
                    if (key !== "missed") return null;
                    return (
                      <div key={key} className="dr-allclear">
                        All serviced ✓ — nothing from {fmtDayLabel(review.date)}{" "}
                        needs rescheduling.
                      </div>
                    );
                  }

                  const isMissed = key === "missed";
                  return (
                    <div key={key} className="dr-section">
                      <div
                        className="dr-section-head"
                        style={{ borderLeftColor: accent }}
                      >
                        <span className="dr-section-title" style={{ color: accent }}>
                          {title}
                        </span>
                        <span className="dr-section-count">{rows.length}</span>
                        <span className="dr-section-blurb">{blurb}</span>
                      </div>

                      <div className="table-wrap">
                        <table className="wo-table dr-table">
                          <thead>
                            <tr>
                              <th style={{ width: 76 }}>Time</th>
                              <th style={{ width: 76 }}>Created</th>
                              <th style={{ width: 112 }}>WO / PO</th>
                              <th style={{ width: 140 }}>Customer</th>
                              <th style={{ width: 210 }}>Site</th>
                              <th>Problem</th>
                              <th style={{ width: 110 }}>Techs</th>
                              <th style={{ width: 168 }}>Status</th>
                              <th style={{ width: isMissed ? 150 : 84 }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((order) => {
                              const { siteLocationName, siteAddress } = deriveSite(order);
                              const latest = parseLatestNote(order?.notes);
                              const noteTime = latest?.createdAt
                                ? moment.utc(latest.createdAt).fromNow()
                                : null;
                              const cleanedPO =
                                order.allPoNumbersFormatted ||
                                displayPO(order.workOrderNumber, order.poNumber);
                              const techs =
                                (Array.isArray(order.techNames) && order.techNames.length
                                  ? order.techNames
                                  : [order.assignedToName].filter(Boolean)
                                ).join(", ");

                              return (
                                <tr
                                  key={order.id}
                                  className="wo-row"
                                  onClick={() =>
                                    navigate(`/view-work-order/${order.id}`, {
                                      state: { from: "/work-orders" },
                                    })
                                  }
                                >
                                  <td className="wo-created">
                                    {fmtSchedTime(order.scheduledDate) || "—"}
                                  </td>

                                  <td
                                    className="wo-created"
                                    title={fmtCreatedFull(order.createdAt) || undefined}
                                  >
                                    {fmtCreatedCompact(order.createdAt)}
                                  </td>

                                  <td>
                                    <div className="wo-idcell">
                                      <div className="wo-idline">
                                        <span className="badge">WO</span>
                                        <span className="mono">
                                          {order.workOrderNumber || "—"}
                                        </span>
                                      </div>
                                      {cleanedPO ? (
                                        <div className="wo-idline subtle">
                                          <span className="badge badge-subtle">PO</span>
                                          <span className="mono">{cleanedPO}</span>
                                        </div>
                                      ) : null}
                                    </div>
                                  </td>

                                  <td className="cell-strong">{order.customer || "N/A"}</td>

                                  <td title={[siteLocationName, siteAddress].filter(Boolean).join(" — ") || "—"}>
                                    <div style={clampStyle(2)}>{siteLocationName || "—"}</div>
                                    {siteAddress ? (
                                      <button
                                        type="button"
                                        className="linklike dr-addr"
                                        onClick={(e) =>
                                          openAddressInMaps(e, siteAddress, siteLocationName)
                                        }
                                      >
                                        {siteAddress}
                                      </button>
                                    ) : null}
                                  </td>

                                  <td title={order.problemDescription || ""}>
                                    <div style={clampStyle(3)}>
                                      {order.problemDescription || "—"}
                                    </div>
                                    {latest?.text ? (
                                      <div
                                        className="latest-note"
                                        title={`${latest.text}${noteTime ? ` • ${noteTime}` : ""}`}
                                      >
                                        <span aria-hidden="true">📝</span> {latest.text}
                                        {noteTime ? ` • ${noteTime}` : ""}
                                      </div>
                                    ) : null}
                                  </td>

                                  <td className="dr-techs" title={techs || "Unassigned"}>
                                    {techs || "—"}
                                  </td>

                                  <td onClick={(e) => e.stopPropagation()}>
                                    <select
                                      className="control select"
                                      value={toCanonicalStatus(order.status)}
                                      onChange={(e) => handleReviewStatusChange(e, order.id)}
                                    >
                                      {STATUS_LIST.map((s) => (
                                        <option key={s} value={s}>
                                          {s}
                                        </option>
                                      ))}
                                    </select>
                                  </td>

                                  <td onClick={(e) => e.stopPropagation()}>
                                    <div className="dr-actions">
                                      {isMissed && (
                                        <button
                                          type="button"
                                          className="btn-primary-apple dr-resched"
                                          onClick={() => openReschedule(order)}
                                        >
                                          Reschedule
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className="chip dr-open"
                                        onClick={() =>
                                          navigate(`/view-work-order/${order.id}`, {
                                            state: { from: "/work-orders" },
                                          })
                                        }
                                      >
                                        Open
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {showSequence && (
          <div className="wo-seq-hint">
            {savingOrder
              ? "Saving service order…"
              : "Drag a row to set the order techs run today's jobs."}
          </div>
        )}

        {selectedFilter !== "Follow-Up" && selectedFilter !== "Day Review" && (
        <div className="table-wrap">
          <table className="wo-table">
            <thead>
              <tr>
                {showSequence && <th style={{ width: 62 }}>Order</th>}
                <th style={{ width: 84 }}>Created</th>
                {showAging && <th style={{ width: 84 }}>Days Waiting</th>}
                {/* Widened on the parts tab to fit the PO/supplier indicator line */}
                <th style={{ width: showParts ? 210 : 118 }}>WO / PO</th>
                <th style={{ width: 150 }}>Customer</th>
                <th style={{ width: 168 }}>Site Location</th>
                <th style={{ width: 188 }}>Site Address</th>
                <th style={{ width: 460 }}>Problem Description</th>
                <th style={{ width: 168 }}>Status</th>
                {userRole !== "tech" && <th style={{ width: 176 }}>Assigned To</th>}
              </tr>
            </thead>

            <tbody>
              {filteredOrders.map((order) => {
                const latest = parseLatestNote(order?.notes);
                // Note createdAt is stored UTC-naive; parse as UTC so "X ago" isn't ~5h off.
                const noteTime = latest?.createdAt
                  ? moment.utc(latest.createdAt).fromNow()
                  : null;

                const { siteLocationName, siteAddress } = deriveSite(order);

                const cleanedPO = order.allPoNumbersFormatted || displayPO(order.workOrderNumber, order.poNumber);

                const days = showAging ? daysInStatus(order) : null;
                const parts = showParts ? partsIndicator(order) : null;

                return (
                  <tr
                    key={order.id}
                    className={`wo-row${
                      showSequence && dragOverId === order.id ? " wo-row-dragover" : ""
                    }`}
                    draggable={showSequence}
                    onDragStart={showSequence ? (e) => onRowDragStart(e, order.id) : undefined}
                    onDragOver={showSequence ? (e) => onRowDragOver(e, order.id) : undefined}
                    onDrop={showSequence ? (e) => onRowDrop(e, order.id) : undefined}
                    onDragEnd={showSequence ? onRowDragEnd : undefined}
                    onClick={() =>
                      navigate(`/view-work-order/${order.id}`, {
                        state: { from: "/work-orders" },
                      })
                    }
                  >
                    {showSequence && (
                      <td className="wo-seq" title="Drag the row to change the service order">
                        <span className="wo-seq-grip" aria-hidden="true">⋮⋮</span>
                        <span className="wo-seq-num">
                          {order.serviceOrder == null ? "—" : order.serviceOrder}
                        </span>
                      </td>
                    )}

                    <td
                      className="wo-created"
                      title={fmtCreatedFull(order.createdAt) || undefined}
                    >
                      {fmtCreatedCompact(order.createdAt)}
                    </td>

                    {showAging && (
                      <td
                        className="wo-days"
                        title={
                          days == null
                            ? "No status-change history for this work order"
                            : `In "${toCanonicalStatus(order.status)}" since ${moment
                                .utc(order.statusChangedAt)
                                .local()
                                .format("MMM D, YYYY h:mm A")}`
                        }
                      >
                        <span
                          className="wo-days-value"
                          style={{ color: agingColorToken(days) }}
                        >
                          {days == null ? "—" : days}
                        </span>
                        {days != null && (
                          <span className="wo-days-unit">
                            {days === 1 ? "day" : "days"}
                          </span>
                        )}
                      </td>
                    )}

                    <td>
                      <div className="wo-idcell">
                        <div className="wo-idline">
                          <span className="badge">WO</span>
                          <span className="mono">{order.workOrderNumber || "—"}</span>
                        </div>
                        {cleanedPO ? (
                          <div className="wo-idline subtle">
                            <span className="badge badge-subtle">PO</span>
                            <span className="mono">{cleanedPO}</span>
                          </div>
                        ) : null}
                        {parts ? (
                          <div
                            className="wo-parts"
                            style={{ color: parts.color }}
                            title={parts.title}
                          >
                            {parts.text}
                          </div>
                        ) : null}
                      </div>
                    </td>

                    <td className="cell-strong">{order.customer || "N/A"}</td>

                    <td title={siteLocationName || "—"}>
                      <div style={clampStyle(2)}>{siteLocationName || "—"}</div>
                    </td>

                    <td title={siteAddress || "N/A"}>
                      {siteAddress ? (
                        <button
                          type="button"
                          className="linklike"
                          onClick={(e) => openAddressInMaps(e, siteAddress, siteLocationName)}
                        >
                          {siteAddress}
                        </button>
                      ) : (
                        "N/A"
                      )}
                    </td>

                    <td title={order.problemDescription || ""}>
                      <div style={clampStyle(6)}>{order.problemDescription || "—"}</div>

                      {latest?.text ? (
                        <div
                          className="latest-note"
                          title={`${latest.text}${noteTime ? ` • ${noteTime}` : ""}`}
                        >
                          <span aria-hidden="true">📝</span>{" "}
                          {latest.text}
                          {noteTime ? ` • ${noteTime}` : ""}
                        </div>
                      ) : null}
                    </td>

                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                        <select
                          className="control select"
                          value={toCanonicalStatus(order.status)}
                          onChange={(e) => handleStatusChange(e, order.id)}
                        >
                          {STATUS_LIST.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        {isPastDue(order) && (
                          <span
                            style={{
                              background: "#dc2626",
                              color: "#fff",
                              fontSize: 10,
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: 10,
                              marginLeft: 6,
                              whiteSpace: "nowrap",
                            }}
                          >
                            PAST DUE
                          </span>
                        )}
                      </div>
                    </td>

                    {userRole !== "tech" && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 4,
                            minWidth: 180,
                          }}
                        >
                          {techUsers.map((t) => {
                            const tid = Number(t.id);
                            const current = Array.isArray(order.techIds)
                              ? order.techIds
                              : order.assignedTo
                              ? [Number(order.assignedTo)]
                              : [];
                            const isSelected = current.some((x) => Number(x) === tid);
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const next = isSelected
                                    ? current.filter((x) => Number(x) !== tid)
                                    : [...current, tid];
                                  setRowTechs(order.id, next);
                                }}
                                style={{
                                  padding: "4px 8px",
                                  borderRadius: 16,
                                  fontSize: 11,
                                  fontWeight: 500,
                                  border: isSelected ? "2px solid #3b82f6" : "2px solid #4b5563",
                                  background: isSelected ? "#1d4ed8" : "#374151",
                                  color: isSelected ? "#fff" : "#9ca3af",
                                  cursor: "pointer",
                                  textAlign: "center",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {isSelected ? "✓ " : ""}
                                {t.username}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}

              {filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={(userRole !== "tech" ? 8 : 7) + (showAging ? 1 : 0) + (showSequence ? 1 : 0)}>
                    <div className="empty-state">No work orders for this filter.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
      </div>

      {/* ───── Reschedule modal (Day Review → Missed) ───── */}
      {rescheduleWO && (
        <div
          role="dialog"
          aria-modal="true"
          className="dr-modal-overlay"
          onClick={closeReschedule}
        >
          <div className="dr-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="dr-modal-title">
              Reschedule — {rescheduleWO.customer || "Work Order"}
            </h3>
            <div className="dr-modal-sub">
              <span className="mono">WO {rescheduleWO.workOrderNumber || rescheduleWO.id}</span>
              {rescheduleWO.scheduledDate ? (
                <>
                  {" · missed "}
                  {fmtDayLabel(String(rescheduleWO.scheduledDate).slice(0, 10))}
                  {fmtSchedTime(rescheduleWO.scheduledDate)
                    ? ` at ${fmtSchedTime(rescheduleWO.scheduledDate)}`
                    : ""}
                </>
              ) : null}
            </div>
            {rescheduleWO.problemDescription ? (
              <div className="dr-modal-problem" style={clampStyle(2)}>
                {rescheduleWO.problemDescription}
              </div>
            ) : null}

            <div className="dr-modal-grid">
              <div>
                <label className="dr-label" htmlFor="dr-rs-date">
                  Date
                </label>
                <input
                  id="dr-rs-date"
                  type="date"
                  className="control"
                  value={rsDate}
                  onChange={(e) => setRsDate(e.target.value)}
                />
              </div>
              <div>
                <label className="dr-label" htmlFor="dr-rs-start">
                  Start
                </label>
                <input
                  id="dr-rs-start"
                  type="time"
                  className="control"
                  value={rsTime}
                  onChange={(e) => setRsTime(e.target.value)}
                />
              </div>
              <div>
                <label className="dr-label" htmlFor="dr-rs-end">
                  End
                </label>
                <input
                  id="dr-rs-end"
                  type="time"
                  className="control"
                  value={rsEndTime}
                  onChange={(e) => setRsEndTime(e.target.value)}
                />
              </div>
            </div>

            <div className="dr-modal-note">
              Saving sets the status back to <b>Scheduled</b> on the new day.
            </div>

            <div className="dr-modal-actions">
              <button
                type="button"
                className="chip"
                onClick={closeReschedule}
                disabled={rsSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary-apple"
                onClick={saveReschedule}
                disabled={rsSaving || !rsDate || !rsTime}
              >
                {rsSaving ? "Saving…" : "Reschedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───── Log Call modal ───── */}
      {callModalWO && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closeCallModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-card, #fff)",
              borderRadius: 12,
              maxWidth: 560,
              width: "100%",
              maxHeight: "88vh",
              overflowY: "auto",
              padding: 24,
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
              Log Call — {callModalWO.customer}
            </h3>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
              {callModalWO.siteLocation || ""}
              {callModalWO.phone ? (
                <>
                  {" • "}
                  <a href={`tel:${callModalWO.phone}`} style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}>
                    {callModalWO.phone}
                  </a>
                </>
              ) : null}
            </div>

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>
              Outcome
            </label>
            <select
              className="control select"
              value={callOutcome}
              onChange={(e) => setCallOutcome(e.target.value)}
              style={{ width: "100%", marginBottom: 12 }}
            >
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>
              Notes
            </label>
            <textarea
              value={callNotes}
              onChange={(e) => setCallNotes(e.target.value)}
              rows={3}
              placeholder="What was said, next steps, callback time…"
              style={{
                width: "100%",
                borderRadius: 8,
                border: "1px solid var(--border-color, #d1d5db)",
                padding: 8,
                fontSize: 14,
                resize: "vertical",
                marginBottom: 8,
              }}
            />

            {/* Quick status shortcuts (offered, not automatic) */}
            {callOutcome === "Spoke - Approved" && (
              <button
                type="button"
                onClick={() => setWoStatusFromModal(callModalWO.id, "Approved")}
                style={{ background: "#22c55e", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 600, cursor: "pointer", marginBottom: 12 }}
              >
                Set WO status → Approved (opens estimate approval)
              </button>
            )}
            {callOutcome === "Spoke - Declined" && (
              <button
                type="button"
                onClick={() => setWoStatusFromModal(callModalWO.id, "Declined")}
                style={{ background: "#6b7280", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 600, cursor: "pointer", marginBottom: 12 }}
              >
                Set WO status → Declined
              </button>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginBottom: 18 }}>
              <button type="button" className="chip" onClick={closeCallModal} disabled={callSaving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary-apple"
                onClick={saveCall}
                disabled={callSaving || !callOutcome}
              >
                {callSaving ? "Saving…" : "Save Call"}
              </button>
            </div>

            <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: "var(--text-primary)" }}>
                Call history ({callHistory.length})
              </div>
              {callHistory.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>No prior attempts logged.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {callHistory.map((c) => (
                    <div key={c.id} style={{ fontSize: 13, borderLeft: "3px solid #7c3aed", paddingLeft: 10 }}>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                        {c.outcome}
                        <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
                          {" — "}{c.calledBy || "Unknown"}{" • "}{c.calledAt ? moment(c.calledAt).format("MMM D, YYYY h:mm A") : ""}
                        </span>
                      </div>
                      {c.notes ? <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>{c.notes}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
