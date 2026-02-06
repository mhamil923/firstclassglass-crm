// File: src/PurchaseOrders.js
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";
import "./PurchaseOrders.css";

const SUPPLIERS = ["All Suppliers", "Chicago Tempered", "CRL", "Oldcastle", "Casco"];
const STATUSES = ["All Statuses", "On Order", "Picked Up"];
const NEEDS_TO_BE_SCHEDULED = "Needs to be Scheduled";

/* ---------- auth header (match WorkOrders.js / ViewWorkOrder.js) ---------- */
const authHeaders = () => {
  const token = localStorage.getItem("jwt");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/* ---------- helpers ---------- */
const safeLower = (v) => String(v || "").toLowerCase();

const firstNonNullish = (...vals) => {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

function inferSupplierFromText(text) {
  const s = safeLower(text);

  if (s.includes("chicago tempered") || s.includes("chicagotempered") || s.includes("chicago_tempered")) {
    return "Chicago Tempered";
  }
  if (s.includes("crl")) return "CRL";
  if (s.includes("oldcastle")) return "Oldcastle";
  if (s.includes("casco")) return "Casco";

  const hasCT =
    s.includes("/ct/") ||
    s.includes("\\ct\\") ||
    s.includes(" ct ") ||
    s.includes("ct_") ||
    s.includes("ct-") ||
    s.includes("_ct_") ||
    s.includes("-ct-");

  if (hasCT) return "Chicago Tempered";
  return "";
}

function normalizePoStatus(po) {
  const pickedVal = po
    ? firstNonNullish(po.poPickedUp, po.po_picked_up, po.pickedUp, po.poPicked, po.picked_up)
    : undefined;

  const picked = !!pickedVal;

  const explicit = po
    ? firstNonNullish(po.poStatus, po.po_status, po.status, po.poStatusText, "")
    : "";

  if (explicit) {
    const e = safeLower(explicit);
    if (e.includes("picked")) return "Picked Up";
    if (e.includes("on") && e.includes("order")) return "On Order";
  }
  return picked ? "Picked Up" : "On Order";
}

function isWaitingOnPartsText(statusText) {
  const s = safeLower(statusText || "");
  return (s.includes("waiting") && s.includes("parts")) || s === "waiting on parts";
}

/**
 * ✅ IMPORTANT: no route probing (it caused the Home flash).
 * If your actual view route differs, change DEFAULT_WORK_ORDER_ROUTE_BASE.
 */
const WORK_ORDER_ROUTE_STORAGE_KEY = "fcgg_work_order_route_base";
const DEFAULT_WORK_ORDER_ROUTE_BASE = "/view-work-order";

function buildWorkOrderPath(routeBase, woId) {
  const base = (routeBase || "").trim();
  if (!base) return `/view-work-order/${woId}`;
  return `${base.replace(/\/+$/, "")}/${woId}`;
}

/* ---------- component ---------- */
export default function PurchaseOrders() {
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [supplierFilter, setSupplierFilter] = useState("All Suppliers");
  const [statusFilter, setStatusFilter] = useState("On Order");
  const [search, setSearch] = useState("");
  const [searchApplied, setSearchApplied] = useState("");

  // Waiting-on-parts work orders lookup (so we can show ALL Waiting on Parts WOs, even if no PO exists yet)
  const [waitingWoIdSet, setWaitingWoIdSet] = useState(() => new Set());
  const [woMetaById, setWoMetaById] = useState(() => ({})); // { [id]: { status, number, customer, siteLocation, siteAddress } }

  // PDF modal viewer (in-app)
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfTitle, setPdfTitle] = useState("");
  const [pdfPo, setPdfPo] = useState(null);

  // per-row action loading
  const [busyIds, setBusyIds] = useState(() => new Set());

  const navigate = useNavigate();
  const location = useLocation();

  const currentPathWithQuery = () => `${location.pathname}${location.search || ""}`;

  const closePdfModal = () => {
    setPdfModalOpen(false);
    setPdfUrl("");
    setPdfTitle("");
    setPdfPo(null);
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearchApplied(search);
  };

  /**
   * Fetch Work Orders that are "Waiting on Parts" so the PO tab shows ALL of them
   * (even if /purchase-orders endpoint only returns rows that already have PO data).
   */
  const fetchWaitingOnPartsWorkOrders = useCallback(async () => {
    const headers = authHeaders();

    const tryCalls = [
      () => api.get("/work-orders", { headers, params: { status: "waiting-on-parts" } }),
      () => api.get("/work-orders", { headers, params: { workOrderStatus: "Waiting on Parts" } }),
      () => api.get("/work-orders", { headers, params: { status: "Waiting on Parts" } }),
      () => api.get("/work-orders", { headers }), // fallback: fetch all and filter client-side
    ];

    for (const fn of tryCalls) {
      try {
        const r = await fn();
        const rows = Array.isArray(r.data) ? r.data : r.data?.rows;
        const list = Array.isArray(rows) ? rows : [];

        const waitingOnly = list.filter((wo) => {
          const st = firstNonNullish(
            wo.workOrderStatus,
            wo.work_order_status,
            wo.status,
            wo.statusText,
            wo.workOrderStatusText,
            ""
          );
          return isWaitingOnPartsText(st);
        });

        const idSet = new Set();
        const meta = {};

        waitingOnly.forEach((wo) => {
          const id = firstNonNullish(wo.id, wo.workOrderId, wo.work_order_id, wo.woId, null);
          if (!id) return;

          const st = firstNonNullish(
            wo.workOrderStatus,
            wo.work_order_status,
            wo.status,
            wo.statusText,
            wo.workOrderStatusText,
            ""
          );

          const num = firstNonNullish(
            wo.workOrderNumber,
            wo.work_order_number,
            wo.woNumber,
            wo.workOrderNo,
            ""
          );

          const customer = firstNonNullish(wo.customer, wo.customerName, wo.customer_name, "");
          const siteLocation = firstNonNullish(wo.siteLocation, wo.site_name, wo.siteName, wo.site, "");
          const siteAddress = firstNonNullish(wo.siteAddress, wo.site_address, wo.address, "");

          idSet.add(id);
          meta[id] = {
            status: st || "",
            number: num || "",
            customer: customer || "",
            siteLocation: siteLocation || "",
            siteAddress: siteAddress || "",
          };
        });

        setWaitingWoIdSet(idSet);
        setWoMetaById(meta);
        return;
      } catch {
        // keep trying
      }
    }

    setWaitingWoIdSet(new Set());
    setWoMetaById({});
  }, []);

  const loadPurchaseOrders = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const params = {};

      if (supplierFilter && supplierFilter !== "All Suppliers") {
        params.supplier = supplierFilter;
      }

      if (statusFilter && statusFilter !== "All Statuses") {
        if (statusFilter === "On Order") {
          params.status = "on-order";
          params.poStatus = "On Order";
        } else if (statusFilter === "Picked Up") {
          params.status = "picked-up";
          params.poStatus = "Picked Up";
        }
      }

      if (searchApplied.trim()) {
        params.search = searchApplied.trim();
      }

      const [poRes] = await Promise.all([
        api.get("/purchase-orders", { headers: authHeaders(), params }),
        fetchWaitingOnPartsWorkOrders(),
      ]);

      const rows = Array.isArray(poRes.data) ? poRes.data : poRes.data?.rows;
      setPurchaseOrders(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error("❌ Error loading purchase orders:", err?.response || err);

      const status = err?.response?.status;
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Failed to load purchase orders.";

      setError(status ? `Failed to fetch (HTTP ${status}) — ${msg}` : msg);
      setPurchaseOrders([]);
    } finally {
      setLoading(false);
    }
  }, [supplierFilter, statusFilter, searchApplied, fetchWaitingOnPartsWorkOrders]);

  useEffect(() => {
    loadPurchaseOrders();
  }, [loadPurchaseOrders]);

  const updateWorkOrderStatusToNeedsScheduling = async (woId) => {
    if (!woId) return false;

    const headersJson = { ...authHeaders() };

    const jsonPayloads = [
      { status: NEEDS_TO_BE_SCHEDULED },
      { workOrderStatus: NEEDS_TO_BE_SCHEDULED },
      { work_order_status: NEEDS_TO_BE_SCHEDULED },
    ];

    const jsonEndpoints = [
      `/work-orders/${woId}/status`,
      `/work-orders/${woId}/update-status`,
      `/work-orders/${woId}/set-status`,
      `/work-orders/${woId}`,
    ];

    for (const endpoint of jsonEndpoints) {
      for (const payload of jsonPayloads) {
        try {
          await api.put(endpoint, payload, { headers: headersJson });
          return true;
        } catch {
          // keep trying
        }
      }
    }

    try {
      const form = new FormData();
      form.append("status", NEEDS_TO_BE_SCHEDULED);
      form.append("workOrderStatus", NEEDS_TO_BE_SCHEDULED);
      form.append("work_order_status", NEEDS_TO_BE_SCHEDULED);

      await api.put(`/work-orders/${woId}/edit`, form, {
        headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
      });

      return true;
    } catch {
      return false;
    }
  };

  const handleMarkPickedUp = async (row) => {
    const woId = firstNonNullish(row?.workOrderId, row?.work_order_id, row?.woId, null);
    const poNum = row?.poNumber || "";
    const isSynthetic = typeof row?.id === "string" && String(row.id).startsWith("wo-");

    if (!woId) {
      alert("No related work order linked to this row.");
      return;
    }

    const stillWaiting =
      waitingWoIdSet.has(woId) || isWaitingOnPartsText(firstNonNullish(row.workOrderStatus, row.statusText, ""));
    if (!stillWaiting) {
      alert("This work order is no longer in Waiting on Parts.");
      return;
    }

    setBusyIds((prev) => {
      const next = new Set(prev);
      next.add(String(row.id));
      return next;
    });

    try {
      if (!window.confirm(`Mark as Picked Up and move Work Order to "${NEEDS_TO_BE_SCHEDULED}"?`)) {
        return;
      }

      if (!isSynthetic) {
        try {
          await api.put(`/purchase-orders/${row.id}/mark-picked-up`, null, { headers: authHeaders() });
        } catch (e1) {
          try {
            await api.put(
              `/purchase-orders/${row.id}/picked-up`,
              { pickedUp: true },
              { headers: authHeaders() }
            );
          } catch (e2) {
            try {
              const form = new FormData();
              form.append("poPickedUp", "1");
              await api.put(`/work-orders/${woId}/edit`, form, {
                headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
              });
            } catch {
              // ignore; still moving WO status
            }
          }
        }
      }

      const statusOk = await updateWorkOrderStatusToNeedsScheduling(woId);
      if (!statusOk) {
        alert("Work order status update endpoint might differ. The UI will still be updated.");
      }

      setWaitingWoIdSet((prev) => {
        const next = new Set(prev);
        next.delete(woId);
        return next;
      });

      setWoMetaById((prev) => {
        const next = { ...(prev || {}) };
        if (next[woId]) next[woId] = { ...(next[woId] || {}), status: NEEDS_TO_BE_SCHEDULED };
        return next;
      });

      setPurchaseOrders((prev) =>
        (prev || []).map((po) => {
          if (po.id !== row.id) return po;
          return {
            ...po,
            poPickedUp: true,
            poStatus: "Picked Up",
            workOrderStatus: NEEDS_TO_BE_SCHEDULED,
            work_order_status: NEEDS_TO_BE_SCHEDULED,
            workOrderStatusText: NEEDS_TO_BE_SCHEDULED,
          };
        })
      );

      alert(
        `Marked Picked Up.\n` +
          `Work Order moved to: ${NEEDS_TO_BE_SCHEDULED}` +
          (poNum ? `\nPO: ${poNum}` : "")
      );

      loadPurchaseOrders();
    } catch (err) {
      console.error("❌ Error marking picked up:", err?.response || err);
      const status = err?.response?.status;
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Failed to update.";
      setError(status ? `Update failed (HTTP ${status}) — ${msg}` : msg);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(String(row.id));
        return next;
      });
    }
  };

  const handleOpenPdf = (po) => {
    const key = firstNonNullish(po?.poPdfPath, po?.po_pdf_path, po?.poPdf, "") || "";
    if (!key) {
      alert("No PDF attached to this purchase order.");
      return;
    }

    const url = `${API_BASE_URL}/files?key=${encodeURIComponent(key)}`;
    const title = `PO ${po?.poNumber || ""}`.trim();

    setPdfPo(po || null);
    setPdfUrl(url);
    setPdfTitle(title || "Purchase Order PDF");
    setPdfModalOpen(true);
  };

  const handleViewWorkOrder = (row) => {
    const woId = firstNonNullish(row?.workOrderId, row?.work_order_id, row?.woId, null);
    if (!woId) {
      alert("No related work order linked to this row.");
      return;
    }

    const savedBase =
      localStorage.getItem(WORK_ORDER_ROUTE_STORAGE_KEY) || DEFAULT_WORK_ORDER_ROUTE_BASE;

    const path = buildWorkOrderPath(savedBase, woId);

    navigate(path, { state: { from: currentPathWithQuery() } });

    localStorage.setItem(WORK_ORDER_ROUTE_STORAGE_KEY, savedBase);
  };

  const normalizedPurchaseOrders = useMemo(() => {
    return (purchaseOrders || []).map((po) => {
      const poPdfPath =
        (firstNonNullish(po.poPdfPath, po.po_pdf_path, po.poPdf, po.po_pdf, "") || "") + "";

      const originalName =
        (firstNonNullish(
          po.poPdfOriginalName,
          po.po_pdf_original_name,
          po.poPdfFilename,
          po.po_pdf_filename,
          po.filename,
          ""
        ) || "") + "";

      const supplierRaw =
        (firstNonNullish(
          po.supplier,
          po.poSupplier,
          po.po_supplier,
          po.vendor,
          po.vendorName,
          po.supplierName,
          po.poVendor,
          po.po_vendor,
          ""
        ) || "") + "";

      const inferText = [supplierRaw, poPdfPath, originalName].filter(Boolean).join(" ");
      const inferred = inferSupplierFromText(inferText);
      const supplier = supplierRaw || inferred || "";

      const workOrderId = firstNonNullish(po.workOrderId, po.work_order_id, po.woId, null);

      const woStatusFromLookup =
        workOrderId && woMetaById[workOrderId] ? woMetaById[workOrderId].status : "";

      const workOrderStatus =
        (woStatusFromLookup ||
          firstNonNullish(
            po.workOrderStatus,
            po.work_order_status,
            po.woStatus,
            po.workOrder_status,
            po.workOrderStatusText,
            ""
          ) ||
          "") + "";

      const poStatus = normalizePoStatus(po);
      const poPickedUp = !!firstNonNullish(po.poPickedUp, po.po_picked_up, po.pickedUp, false);

      const woNumFromLookup =
        workOrderId && woMetaById[workOrderId] ? woMetaById[workOrderId].number : "";

      const workOrderNumber =
        (firstNonNullish(po.workOrderNumber, po.work_order_number, po.woNumber, "") ||
          woNumFromLookup ||
          "") + "";

      const customer =
        (firstNonNullish(po.customer, po.customerName, "") ||
          (workOrderId && woMetaById[workOrderId] ? woMetaById[workOrderId].customer : "") ||
          "") + "";

      const siteLocation =
        (firstNonNullish(po.siteLocation, po.site_name, po.siteName, "") ||
          (workOrderId && woMetaById[workOrderId] ? woMetaById[workOrderId].siteLocation : "") ||
          "") + "";

      const siteAddress =
        (firstNonNullish(po.siteAddress, po.site_address, "") ||
          (workOrderId && woMetaById[workOrderId] ? woMetaById[workOrderId].siteAddress : "") ||
          "") + "";

      return {
        ...po,
        supplier,
        poSupplier: (firstNonNullish(po.poSupplier, supplier, "") || "") + "",
        poNumber: (firstNonNullish(po.poNumber, po.po_number, po.poNo, "") || "") + "",
        customer,
        siteLocation,
        siteAddress,
        workOrderNumber,
        workOrderId,
        poPdfPath,
        poPdfOriginalName: originalName,
        createdAt: firstNonNullish(po.createdAt, po.created_at, po.createdOn, po.created_date, null),
        poPickedUp,
        poStatus,
        workOrderStatus,
      };
    });
  }, [purchaseOrders, woMetaById]);

  const combinedWaitingRows = useMemo(() => {
    const poByWoId = new Map();
    normalizedPurchaseOrders.forEach((po) => {
      if (po?.workOrderId) poByWoId.set(po.workOrderId, po);
    });

    const synthetic = [];
    for (const woId of waitingWoIdSet) {
      if (poByWoId.has(woId)) continue;

      const meta = woMetaById[woId] || {};
      synthetic.push({
        id: `wo-${woId}`,
        supplier: "",
        poSupplier: "",
        poNumber: "",
        customer: meta.customer || "",
        siteLocation: meta.siteLocation || "",
        siteAddress: meta.siteAddress || "",
        workOrderNumber: meta.number || "",
        workOrderId: woId,
        poPdfPath: "",
        poPdfOriginalName: "",
        createdAt: null,
        poPickedUp: false,
        poStatus: "On Order",
        workOrderStatus: meta.status || "Waiting on Parts",
        __synthetic: true,
      });
    }

    const all = [...normalizedPurchaseOrders, ...synthetic];

    return all.filter((row) => {
      const byLookup = row.workOrderId ? waitingWoIdSet.has(row.workOrderId) : false;
      const byText = isWaitingOnPartsText(row.workOrderStatus);
      return byLookup || byText;
    });
  }, [normalizedPurchaseOrders, waitingWoIdSet, woMetaById]);

  const filteredPurchaseOrders = useMemo(() => {
    const q = (search || "").trim().toLowerCase();
    const base = combinedWaitingRows;

    const supplierFiltered =
      supplierFilter && supplierFilter !== "All Suppliers"
        ? base.filter((po) => safeLower(po.supplier) === safeLower(supplierFilter))
        : base;

    const statusFiltered =
      statusFilter && statusFilter !== "All Statuses"
        ? supplierFiltered.filter((po) => normalizePoStatus(po) === statusFilter)
        : supplierFiltered;

    if (!q) return statusFiltered;

    return statusFiltered.filter((po) => {
      const fieldsToSearch = [
        po.poNumber,
        po.customer,
        po.siteLocation,
        po.siteAddress,
        po.workOrderNumber,
        po.supplier,
      ];
      return fieldsToSearch.some((val) => safeLower(val).includes(q));
    });
  }, [combinedWaitingRows, search, supplierFilter, statusFilter]);

  const btnStyle = { minWidth: 140 };

  const pdfCanMarkPickedUp = useMemo(() => {
    if (!pdfPo) return false;
    const woId = firstNonNullish(pdfPo.workOrderId, pdfPo.work_order_id, pdfPo.woId, null);
    if (!woId) return false;
    const stillWaiting = waitingWoIdSet.has(woId) || isWaitingOnPartsText(pdfPo.workOrderStatus);
    return stillWaiting;
  }, [pdfPo, waitingWoIdSet]);

  const handlePdfMarkPickedUp = async () => {
    if (!pdfPo) return;
    await handleMarkPickedUp(pdfPo);
    closePdfModal();
  };

  return (
    <div className="po-page">
      <div className="po-container">
        {/* Page header */}
        <div className="po-header">
          <div>
            <h1 className="po-title">Purchase Orders</h1>
            <p className="text-muted" style={{ marginTop: 4, fontSize: 13 }}>
              Showing all work orders in <b>Waiting on Parts</b> — mark "Picked Up" to move to{" "}
              <b>{NEEDS_TO_BE_SCHEDULED}</b>.
            </p>
          </div>
        </div>

      {/* Filters */}
      <div className="po-section-card">
          <div className="row g-3 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Supplier</label>
              <select
                className="form-select"
                value={supplierFilter}
                onChange={(e) => setSupplierFilter(e.target.value)}
              >
                {SUPPLIERS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-md-3">
              <label className="form-label">Status</label>
              <select
                className="form-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-md-4">
              <form onSubmit={handleSearchSubmit}>
                <label className="form-label">Search (PO #, customer, site, WO #)</label>
                <div className="input-group">
                  <input
                    type="text"
                    className="form-control"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search purchase orders..."
                  />
                  <button className="btn btn-primary" type="submit" disabled={loading}>
                    Search
                  </button>
                </div>

                {searchApplied.trim() && (
                  <div className="mt-2">
                    <span className="badge text-bg-light" style={{ border: "1px solid #e5e7eb" }}>
                      Server filter: <b>{searchApplied}</b>
                    </span>
                    <button type="button" className="btn btn-link btn-sm" onClick={() => setSearchApplied("")}>
                      Clear server filter
                    </button>
                  </div>
                )}
              </form>
            </div>

            <div className="col-md-2 text-end">
              <button
                className="btn btn-primary mt-3 mt-md-0"
                type="button"
                onClick={loadPurchaseOrders}
                disabled={loading}
                style={{ minWidth: 120 }}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-3 text-muted" style={{ fontSize: "0.9rem" }}>
            Purchase orders are derived from work orders (PO Number, Supplier, and PO PDF).
            <br />
            <b>Showing ALL work orders with status: "Waiting on Parts".</b>
          </div>
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      <div className="po-section-card" style={{ padding: 0 }}>
        <div className="po-section-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 className="po-section-title" style={{ margin: 0 }}>Purchase Orders List</h3>
          {loading ? (
            <span className="text-muted" style={{ fontSize: 12 }}>Loading…</span>
          ) : null}
        </div>

        <div style={{ padding: 0 }}>
          <div className="table-responsive">
            <table className="table table-striped table-hover mb-0">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>PO #</th>
                  <th>Customer</th>
                  <th>Site</th>
                  <th>Work Order #</th>
                  <th>PO Status</th>
                  <th>Created</th>
                  <th>PDF</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredPurchaseOrders.length === 0 && !loading && (
                  <tr>
                    <td colSpan="9" className="text-center py-3">
                      No purchase orders found.
                    </td>
                  </tr>
                )}

                {filteredPurchaseOrders.map((row) => {
                  const woId = row.workOrderId;
                  const stillWaiting =
                    (woId && waitingWoIdSet.has(woId)) || isWaitingOnPartsText(row.workOrderStatus);

                  const isBusy = busyIds.has(String(row.id));

                  return (
                    <tr key={row.id}>
                      <td>{row.supplier || "-"}</td>
                      <td>{row.poNumber || "-"}</td>
                      <td>{row.customer || "-"}</td>
                      <td>{row.siteLocation || row.siteAddress || "-"}</td>
                      <td>{row.workOrderNumber || "-"}</td>
                      <td>{row.poStatus || (row.poPickedUp ? "Picked Up" : "On Order")}</td>
                      <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>

                      <td>
                        {row.poPdfPath ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            style={btnStyle}
                            onClick={() => handleOpenPdf(row)}
                            disabled={isBusy}
                          >
                            View PDF
                          </button>
                        ) : (
                          <span className="text-muted">No PDF</span>
                        )}
                      </td>

                      <td>
                        <div className="d-flex align-items-center gap-2" style={{ flexWrap: "nowrap" }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            style={btnStyle}
                            onClick={() => handleViewWorkOrder(row)}
                            disabled={isBusy}
                          >
                            View Work Order
                          </button>

                          {stillWaiting && (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              style={btnStyle}
                              onClick={() => handleMarkPickedUp(row)}
                              disabled={isBusy}
                            >
                              {isBusy ? "Working..." : "Mark Picked Up"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="p-3 text-muted" style={{ fontSize: "0.85rem" }}>
            Showing <b>{filteredPurchaseOrders.length}</b> of <b>{combinedWaitingRows.length}</b>{" "}
            (Waiting on Parts) rows.
          </div>
        </div>
      </div>

      {/* -------- In-app PDF Modal -------- */}
      {pdfModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closePdfModal}
          className="pdf-modal"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="pdf-modal-content"
            style={{ maxWidth: 1100 }}
          >
            <div className="pdf-modal-header">
              <h3 className="pdf-modal-title">{pdfTitle || "Purchase Order PDF"}</h3>
              <div className="d-flex align-items-center gap-2">
                {pdfCanMarkPickedUp ? (
                  <button className="btn btn-sm btn-primary" onClick={handlePdfMarkPickedUp}>
                    Mark Picked Up
                  </button>
                ) : null}

                <button className="pdf-modal-close" onClick={closePdfModal} aria-label="Close">
                  ×
                </button>
              </div>
            </div>

            <div className="pdf-modal-body">
              {pdfUrl ? (
                <iframe title="PO PDF Viewer" src={pdfUrl} />
              ) : (
                <div className="p-4 text-muted">No PDF URL.</div>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
