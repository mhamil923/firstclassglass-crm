// File: src/RouteBuilder.js
import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import api from "./api";
import { useNavigate, useSearchParams } from "react-router-dom";
import "./RouteBuilder.css";

const SHOP_ADDRESS = "1513 Industrial Dr, Itasca, IL 60143";

const fmtDuration = (seconds) => {
  if (!seconds) return "\u2014";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
};

const fmtDistance = (meters) => {
  if (!meters) return "\u2014";
  const mi = (meters / 1609.34).toFixed(1);
  return `${mi} mi`;
};

export default function RouteBuilder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const debounceRef = useRef(null);

  // Step tracking (1=anchor, 2=nearby, 3=route)
  const [step, setStep] = useState(1);

  // Step 1: Anchor
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [routeDate, setRouteDate] = useState(() => {
    const p = searchParams.get("date");
    return p || new Date().toISOString().split("T")[0];
  });

  // Step 2: Nearby
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState("");
  const [tiers, setTiers] = useState({ closest: [], near: [], moderate: [], further: [] });
  const [nearbyMeta, setNearbyMeta] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Step 3: Route
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState("");
  const [manualStops, setManualStops] = useState(null); // null = use routeData order

  // Confirm
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);
  const [assignees, setAssignees] = useState([]);
  const [selectedTech, setSelectedTech] = useState("");

  // Load assignees on mount
  useEffect(() => {
    api.get("/users", { params: { assignees: 1 } })
      .then(res => setAssignees(Array.isArray(res.data) ? res.data : []))
      .catch(() => {});
  }, []);

  // Auto-load anchor from URL params
  useEffect(() => {
    const anchorId = searchParams.get("anchorId");
    if (anchorId) {
      api.get(`/work-orders/${anchorId}`)
        .then(res => {
          if (res.data) setAnchor(res.data);
        })
        .catch(() => {});
    }
  }, [searchParams]);

  /* ========================= Search ========================= */
  const doSearch = useCallback(async (term) => {
    if (!term || term.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      // Search by customer and by WO/PO number in parallel
      const [resCust, resPo] = await Promise.allSettled([
        api.get("/work-orders/search", { params: { customer: term } }),
        api.get("/work-orders/search", { params: { poNumber: term } }),
      ]);
      const all = [];
      const seen = new Set();
      for (const r of [resCust, resPo]) {
        if (r.status === "fulfilled" && Array.isArray(r.value.data)) {
          for (const wo of r.value.data) {
            if (!seen.has(wo.id)) { seen.add(wo.id); all.push(wo); }
          }
        }
      }
      setSearchResults(all.slice(0, 20));
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const onSearchChange = (e) => {
    const val = e.target.value;
    setSearchTerm(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  };

  const selectAnchor = (wo) => {
    setAnchor(wo);
    setSearchTerm("");
    setSearchResults([]);
    // Reset downstream
    setStep(1);
    setTiers({ closest: [], near: [], moderate: [], further: [] });
    setSelectedIds(new Set());
    setRouteData(null);
    setManualStops(null);
    setConfirmDone(false);
    setNearbyError("");
    setRouteError("");
  };

  const clearAnchor = () => {
    setAnchor(null);
    setStep(1);
    setTiers({ closest: [], near: [], moderate: [], further: [] });
    setSelectedIds(new Set());
    setRouteData(null);
    setManualStops(null);
    setNearbyMeta(null);
    setConfirmDone(false);
  };

  /* ========================= Find Nearby ========================= */
  const handleFindNearby = useCallback(async () => {
    if (!anchor) return;
    setNearbyLoading(true);
    setNearbyError("");
    setSelectedIds(new Set());
    setRouteData(null);
    setManualStops(null);
    setStep(2);
    try {
      const res = await api.post("/route-builder/find-nearby", {
        anchorWorkOrderId: anchor.id,
        maxDriveMinutes: 60,
      });
      const d = res.data;
      setTiers(d.tiers || { closest: [], near: [], moderate: [], further: [] });
      setNearbyMeta({ totalCandidates: d.totalCandidates, skippedNoAddress: d.skippedNoAddress, warning: d.warning, method: d.method });
    } catch (err) {
      setNearbyError(err?.response?.data?.error || "Failed to find nearby work orders.");
    } finally {
      setNearbyLoading(false);
    }
  }, [anchor]);

  /* ========================= Selection ========================= */
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    // Reset route when selection changes
    setRouteData(null);
    setManualStops(null);
    if (step > 2) setStep(2);
  };

  // Build a flat list of all nearby WOs for lookup
  const allNearby = useMemo(() => {
    const all = [];
    for (const key of ["closest", "near", "moderate", "further"]) {
      if (tiers[key]) all.push(...tiers[key]);
    }
    return all;
  }, [tiers]);

  const nearbyMap = useMemo(() => {
    const m = new Map();
    for (const wo of allNearby) m.set(wo.id, wo);
    return m;
  }, [allNearby]);

  const totalNearby = allNearby.length;

  /* ========================= Build Route ========================= */
  const handleBuildRoute = useCallback(async () => {
    if (selectedIds.size === 0 || !anchor) return;
    setRouteLoading(true);
    setRouteError("");
    setStep(3);
    try {
      const anchorAddr = anchor.siteAddress || anchor.siteLocation || "";
      const stops = [
        { id: anchor.id, address: anchorAddr, label: `WO ${anchor.workOrderNumber || anchor.id} \u2022 ${anchor.customer}` },
      ];
      for (const id of selectedIds) {
        const wo = nearbyMap.get(id);
        if (wo) {
          stops.push({
            id: wo.id,
            address: wo.siteAddress || wo.siteLocation || "",
            label: `WO ${wo.workOrderNumber || wo.id} \u2022 ${wo.customer}`,
          });
        }
      }

      const res = await api.post("/routes/best", { stops });
      setRouteData(res.data);
      setManualStops(null);
    } catch (err) {
      setRouteError(err?.response?.data?.error || "Failed to optimize route.");
    } finally {
      setRouteLoading(false);
    }
  }, [anchor, selectedIds, nearbyMap]);

  /* ========================= Manual Reorder ========================= */
  const displayStops = useMemo(() => {
    if (manualStops) return manualStops;
    if (routeData?.orderedStops) return routeData.orderedStops;
    return [];
  }, [manualStops, routeData]);

  const handleMoveStop = (idx, dir) => {
    const arr = [...displayStops];
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    setManualStops(arr);
  };

  const handleRemoveStop = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const arr = displayStops.filter(s => s.id !== id);
    if (arr.length === 0) {
      setRouteData(null);
      setManualStops(null);
      setStep(2);
    } else {
      setManualStops(arr);
    }
  };

  /* ========================= Confirm ========================= */
  const handleConfirm = useCallback(async () => {
    if (!anchor) return;
    setConfirmLoading(true);
    try {
      const ids = [anchor.id, ...selectedIds];
      await api.post("/route-builder/confirm-route", {
        workOrderIds: ids,
        scheduledDate: routeDate,
        assignedTo: selectedTech ? Number(selectedTech) : null,
      });
      setConfirmDone(true);
    } catch (err) {
      setRouteError(err?.response?.data?.error || "Failed to schedule work orders.");
    } finally {
      setConfirmLoading(false);
    }
  }, [anchor, selectedIds, routeDate, selectedTech]);

  const handleOpenGoogleMaps = () => {
    // Build URL from current display order
    const url = routeData?.googleMapsUrl;
    if (url) window.open(url, "_blank");
  };

  /* ========================= Render helpers ========================= */
  const renderTier = (label, items, tierClass) => {
    if (!items || items.length === 0) return null;
    return (
      <div className={`rb-tier ${tierClass}`}>
        <div className="rb-tier-header">
          <span className="rb-tier-dot" />
          <span>{label}</span>
          <span className="rb-tier-count">{items.length}</span>
        </div>
        {items.map(wo => (
          <div
            key={wo.id}
            className={`rb-wo-card${selectedIds.has(wo.id) ? " rb-wo-selected" : ""}`}
            onClick={() => toggleSelect(wo.id)}
          >
            <input
              type="checkbox"
              className="rb-wo-checkbox"
              checked={selectedIds.has(wo.id)}
              onChange={() => toggleSelect(wo.id)}
              onClick={e => e.stopPropagation()}
            />
            <div className="rb-wo-info">
              <div className="rb-wo-title">
                {wo.workOrderNumber ? `WO #${wo.workOrderNumber}` : `#${wo.id}`}
                {wo.customer ? ` \u2022 ${wo.customer}` : ""}
              </div>
              <div className="rb-wo-detail">
                {wo.siteAddress || wo.siteLocation || ""}
              </div>
              {wo.problemDescription && (
                <div className="rb-wo-problem">{wo.problemDescription}</div>
              )}
            </div>
            <span className="rb-drive-badge">{wo.driveDurationText || `${wo.driveMinutes} min`}</span>
          </div>
        ))}
      </div>
    );
  };

  const allTiersEmpty = totalNearby === 0;

  return (
    <div className="rb-page">
      <div className="rb-container">
        {/* Header */}
        <div className="rb-header">
          <h2 className="rb-title">Route Builder</h2>
          <div className="rb-subtitle">Plan an optimized day route around an anchor job.</div>
        </div>

        {/* Error banner */}
        {(nearbyError || routeError) && (
          <div className="rb-alert rb-alert-error">
            {nearbyError || routeError}
          </div>
        )}

        {/* Success banner */}
        {confirmDone && (
          <div className="rb-alert rb-alert-success">
            <span>{selectedIds.size + 1} work order{selectedIds.size > 0 ? "s" : ""} scheduled for {routeDate}!</span>
            <button className="rb-btn-text" onClick={() => navigate("/calendar")}>View Calendar</button>
          </div>
        )}

        {/* ==================== STEP 1: Select Anchor ==================== */}
        <section className="rb-section">
          <div className="rb-section-header">
            <span className="rb-step-badge">1</span>
            <h3 className="rb-section-title">Select Anchor Job</h3>
          </div>
          <div className="rb-section-body">
            {!anchor ? (
              <>
                <div className="rb-search-row">
                  <input
                    className="rb-search-input"
                    placeholder="Search by customer name, WO #, or PO #..."
                    value={searchTerm}
                    onChange={onSearchChange}
                    autoFocus
                  />
                  {searchLoading && <span className="rb-spinner" />}
                </div>
                {searchResults.length > 0 && (
                  <div className="rb-search-results">
                    {searchResults.map(wo => (
                      <div key={wo.id} className="rb-search-item" onClick={() => selectAnchor(wo)}>
                        <div className="rb-search-item-top">
                          <span className="rb-search-item-wo">
                            {wo.workOrderNumber ? `WO #${wo.workOrderNumber}` : `#${wo.id}`}
                          </span>
                          <span className="rb-search-item-cust">{wo.customer || "\u2014"}</span>
                          <span className="rb-search-item-status">{wo.status || "New"}</span>
                        </div>
                        <div className="rb-search-item-addr">
                          {wo.siteAddress || wo.siteLocation || "No address"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="rb-anchor-card">
                <div className="rb-anchor-info">
                  <div className="rb-anchor-wo">
                    {anchor.workOrderNumber ? `WO #${anchor.workOrderNumber}` : `#${anchor.id}`}
                    {anchor.poNumber ? ` \u2022 PO ${anchor.poNumber}` : ""}
                  </div>
                  <div className="rb-anchor-customer">{anchor.customer || "\u2014"}</div>
                  <div className="rb-anchor-addr">
                    {anchor.siteLocation || ""}{anchor.siteLocation && anchor.siteAddress ? " \u2014 " : ""}{anchor.siteAddress || "No address"}
                  </div>
                </div>
                <button className="rb-btn-text" onClick={clearAnchor}>Change</button>
              </div>
            )}

            <label className="rb-label">Route Date</label>
            <input
              type="date"
              className="rb-date-input"
              value={routeDate}
              onChange={e => setRouteDate(e.target.value)}
            />

            {anchor && !confirmDone && (
              <div>
                <button
                  className="rb-btn-primary"
                  onClick={handleFindNearby}
                  disabled={nearbyLoading}
                >
                  {nearbyLoading ? "Searching nearby jobs..." : "Find Nearby Jobs"}
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ==================== STEP 2: Nearby Results ==================== */}
        {step >= 2 && !confirmDone && (
          <section className="rb-section">
            <div className="rb-section-header">
              <span className="rb-step-badge">2</span>
              <h3 className="rb-section-title">Nearby Work Orders</h3>
              {selectedIds.size > 0 && (
                <span className="rb-badge">{selectedIds.size} selected</span>
              )}
            </div>
            <div className="rb-section-body">
              {nearbyLoading ? (
                <div className="rb-loading">
                  <span className="rb-spinner" style={{ marginRight: 10 }} />
                  Calculating drive times...
                </div>
              ) : (
                <>
                  {renderTier("Closest (under 15 min)", tiers.closest, "rb-tier-green")}
                  {renderTier("Near (15\u201330 min)", tiers.near, "rb-tier-yellow")}
                  {renderTier("Moderate (30\u201345 min)", tiers.moderate, "rb-tier-orange")}
                  {renderTier("Further (45\u201360 min)", tiers.further, "rb-tier-red")}

                  {allTiersEmpty && !nearbyLoading && (
                    <div className="rb-empty">
                      No nearby work orders found within 60 minutes.
                      {nearbyMeta?.totalCandidates === 0 && nearbyMeta?.skippedNoAddress === 0 && (
                        <div style={{ fontSize: 13, marginTop: 6, color: "var(--text-tertiary)" }}>
                          No work orders have "Needs to be Scheduled" status.
                        </div>
                      )}
                    </div>
                  )}

                  {nearbyMeta?.skippedNoAddress > 0 && (
                    <div className="rb-skipped">
                      {nearbyMeta.skippedNoAddress} work order{nearbyMeta.skippedNoAddress !== 1 ? "s" : ""} skipped (no address on file).
                    </div>
                  )}

                  {nearbyMeta?.warning && (
                    <div className="rb-skipped">{nearbyMeta.warning}</div>
                  )}

                  {selectedIds.size > 0 && (
                    <div>
                      <button
                        className="rb-btn-primary"
                        onClick={handleBuildRoute}
                        disabled={routeLoading}
                      >
                        {routeLoading
                          ? "Optimizing route..."
                          : `Build Route (${selectedIds.size + 1} stops)`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {/* ==================== STEP 3: Route Preview ==================== */}
        {step >= 3 && routeData && !confirmDone && (
          <section className="rb-section">
            <div className="rb-section-header">
              <span className="rb-step-badge">3</span>
              <h3 className="rb-section-title">Optimized Route</h3>
            </div>
            <div className="rb-section-body">
              {/* Summary */}
              <div className="rb-route-summary">
                <div className="rb-stat">
                  <span className="rb-stat-value">{fmtDistance(routeData.totalDistanceMeters)}</span>
                  <span className="rb-stat-label">Total Distance</span>
                </div>
                <div className="rb-stat">
                  <span className="rb-stat-value">{fmtDuration(routeData.totalDurationSeconds)}</span>
                  <span className="rb-stat-label">Drive Time</span>
                </div>
                {routeData.totalDurationInTrafficSeconds && routeData.totalDurationInTrafficSeconds !== routeData.totalDurationSeconds && (
                  <div className="rb-stat">
                    <span className="rb-stat-value">{fmtDuration(routeData.totalDurationInTrafficSeconds)}</span>
                    <span className="rb-stat-label">With Traffic</span>
                  </div>
                )}
                <div className="rb-stat">
                  <span className="rb-stat-value">{displayStops.length}</span>
                  <span className="rb-stat-label">Stops</span>
                </div>
              </div>

              {/* Timeline */}
              <div className="rb-timeline">
                {/* Start: Shop */}
                <div className="rb-timeline-stop rb-timeline-shop">
                  <div className="rb-timeline-dot" />
                  <div className="rb-timeline-content">
                    <strong>Start: Shop</strong>
                    <span>{SHOP_ADDRESS}</span>
                  </div>
                </div>

                {/* Stops */}
                {displayStops.map((stop, idx) => (
                  <div key={stop.id} className="rb-timeline-stop">
                    {stop.legDurationSeconds > 0 && (
                      <div className="rb-timeline-leg">
                        {fmtDuration(stop.legDurationSeconds)} drive
                        {stop.legDistanceMeters ? ` \u2022 ${fmtDistance(stop.legDistanceMeters)}` : ""}
                      </div>
                    )}
                    <div className="rb-timeline-dot" />
                    <div className="rb-timeline-stop-row">
                      <div className="rb-timeline-content">
                        <strong>Stop {idx + 1}: {stop.label || stop.address}</strong>
                        <span>{stop.address}</span>
                      </div>
                      <div className="rb-timeline-actions">
                        <button
                          className="rb-btn-icon"
                          onClick={() => handleMoveStop(idx, -1)}
                          disabled={idx === 0}
                          title="Move up"
                        >&uarr;</button>
                        <button
                          className="rb-btn-icon"
                          onClick={() => handleMoveStop(idx, 1)}
                          disabled={idx === displayStops.length - 1}
                          title="Move down"
                        >&darr;</button>
                        <button
                          className="rb-btn-icon rb-btn-icon-danger"
                          onClick={() => handleRemoveStop(stop.id)}
                          title="Remove"
                        >&times;</button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* End: Shop */}
                <div className="rb-timeline-stop rb-timeline-shop">
                  <div className="rb-timeline-dot" />
                  <div className="rb-timeline-content">
                    <strong>End: Shop</strong>
                    <span>{SHOP_ADDRESS}</span>
                  </div>
                </div>
              </div>

              {routeData.warning && (
                <div className="rb-skipped">{routeData.warning}</div>
              )}

              {/* Tech assignment */}
              <div className="rb-assign-row">
                <label className="rb-label" style={{ marginTop: 0 }}>Assign Technician (optional)</label>
                <select
                  className="rb-select"
                  value={selectedTech}
                  onChange={e => setSelectedTech(e.target.value)}
                >
                  <option value="">-- Unassigned --</option>
                  {assignees.map(u => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
                </select>
              </div>

              {/* Action buttons */}
              <div className="rb-actions">
                <button className="rb-btn-secondary" onClick={handleOpenGoogleMaps}>
                  Open in Google Maps
                </button>
                <button
                  className="rb-btn-primary"
                  style={{ marginTop: 0 }}
                  onClick={handleConfirm}
                  disabled={confirmLoading}
                >
                  {confirmLoading
                    ? "Scheduling..."
                    : `Schedule ${selectedIds.size + 1} Jobs for ${routeDate}`}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
