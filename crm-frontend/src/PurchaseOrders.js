// File: src/PurchaseOrders.js

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";

const SUPPLIERS = ["All Suppliers", "Chicago Tempered", "CRL", "Oldcastle", "Casco"];
const STATUSES = ["All Statuses", "On Order", "Picked Up"];

/* ---------- auth header (match WorkOrders.js / ViewWorkOrder.js) ---------- */
const authHeaders = () => {
  const token = localStorage.getItem("jwt");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/* ---------- helpers ---------- */
const safeLower = (v) => String(v || "").toLowerCase();

function inferSupplierFromText(text) {
  const s = safeLower(text);

  // Strong matches first
  if (s.includes("chicago tempered") || s.includes("chicagotempered") || s.includes("chicago_tempered")) {
    return "Chicago Tempered";
  }
  if (s.includes("crl")) return "CRL";
  if (s.includes("oldcastle")) return "Oldcastle";
  if (s.includes("casco")) return "Casco";

  // Weaker "CT" style matches (guarded to reduce false positives)
  // Examples it should catch: "/ct/", "ct_", "ct-", " ct "
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
  const picked = !!(
    (po && po.poPickedUp) ??
    (po && po.po_picked_up) ??
    (po && po.pickedUp) ??
    (po && po.poPicked) ??
    (po && po.picked_up)
  );

  const explicit =
    (po && po.poStatus) ??
    (po && po.po_status) ??
    (po && po.status) ??
    (po && po.poStatusText) ??
    "";

  if (explicit) {
    const e = safeLower(explicit);
    if (e.includes("picked")) return "Picked Up";
    if (e.includes("on") && e.includes("order")) return "On Order";
  }
  return picked ? "Picked Up" : "On Order";
}

export default function PurchaseOrders() {
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [supplierFilter, setSupplierFilter] = useState("All Suppliers");
  const [statusFilter, setStatusFilter] = useState("On Order");
  const [search, setSearch] = useState("");

  // server-side search (hit Search button) + keep client-side filtering as backup
  const [searchApplied, setSearchApplied] = useState("");

  // PDF modal viewer (in-app)
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfTitle, setPdfTitle] = useState("");

  const navigate = useNavigate();

  const closePdfModal = () => {
    setPdfModalOpen(false);
    setPdfUrl("");
    setPdfTitle("");
  };

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

      const res = await api.get("/purchase-orders", {
        headers: authHeaders(),
        params,
      });

      const rows = Array.isArray(res.data) ? res.data : res.data?.rows;
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
  }, [supplierFilter, statusFilter, searchApplied]);

  useEffect(() => {
    loadPurchaseOrders();
  }, [loadPurchaseOrders]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearchApplied(search);
  };

  const handleMarkPickedUp = async (po) => {
    const poNum = po?.poNumber || "";
    if (!window.confirm(`Mark PO ${poNum} as Picked Up?`)) return;

    setError("");

    const normalizeIncoming = (obj) => {
      if (!obj || typeof obj !== "object") return obj;

      const poPdfPath =
        obj.poPdfPath ??
        obj.po_pdf_path ??
        obj.poPdf ??
        obj.po_pdf ??
        "";

      // extra filename fields that might exist
      const originalName =
        obj.poPdfOriginalName ??
        obj.po_pdf_original_name ??
        obj.poPdfFilename ??
        obj.po_pdf_filename ??
        obj.filename ??
        "";

      const supplierRaw =
        obj.supplier ??
        obj.poSupplier ??
        obj.po_supplier ??
        obj.vendor ??
        obj.vendorName ??
        obj.supplierName ??
        obj.poVendor ??
        obj.po_vendor ??
        "";

      const inferText = [supplierRaw, poPdfPath, originalName].filter(Boolean).join(" ");
      const inferred = inferSupplierFromText(inferText);

      const supplier = supplierRaw || inferred || "";

      const workOrderId =
        obj.workOrderId ??
        obj.work_order_id ??
        obj.woId ??
        obj.workOrderID ??
        obj.workOrder_id ??
        null;

      const workOrderNumber =
        obj.workOrderNumber ??
        obj.work_order_number ??
        obj.woNumber ??
        obj.workOrderNo ??
        "";

      const createdAt =
        obj.createdAt ??
        obj.created_at ??
        obj.createdOn ??
        obj.created_date ??
        null;

      const workOrderStatus =
        obj.workOrderStatus ??
        obj.work_order_status ??
        obj.woStatus ??
        obj.statusText ??
        obj.workOrder_status ??
        "";

      return {
        ...obj,
        supplier,
        poSupplier: (obj.poSupplier ?? supplier) || "",
        poPdfPath: poPdfPath || "",
        poPdfOriginalName: originalName || "",
        workOrderId,
        workOrderNumber,
        createdAt,
        workOrderStatus,
      };
    };

    try {
      let updated = null;

      try {
        const r = await api.put(`/purchase-orders/${po.id}/mark-picked-up`, null, {
          headers: authHeaders(),
        });
        updated = r.data;
      } catch (e1) {
        try {
          const r = await api.put(
            `/purchase-orders/${po.id}/picked-up`,
            { pickedUp: true },
            { headers: authHeaders() }
          );
          updated = r.data;
        } catch (e2) {
          const woId = po.workOrderId ?? po.work_order_id ?? po.woId;
          if (!woId) throw e2;

          const form = new FormData();
          form.append("poPickedUp", "1");

          const r = await api.put(`/work-orders/${woId}/edit`, form, {
            headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
          });

          updated = { ...po, poPickedUp: true, poStatus: "Picked Up", ...r.data };
        }
      }

      const normalized = normalizeIncoming(updated);

      setPurchaseOrders((prev) =>
        prev.map((item) =>
          item.id === po.id
            ? { ...item, ...normalized, poPickedUp: true, poStatus: "Picked Up" }
            : item
        )
      );

      const woNum = normalized?.workOrderNumber || po?.workOrderNumber || "";
      alert(
        `PO ${normalized?.poNumber || poNum} marked as Picked Up.` +
          (woNum ? `\nRelated Work Order #${woNum} has been updated.` : "")
      );
    } catch (err) {
      console.error("❌ Error marking PO picked up:", err?.response || err);
      const status = err?.response?.status;
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Failed to update purchase order.";
      setError(status ? `Update failed (HTTP ${status}) — ${msg}` : msg);
    }
  };

  // ✅ In-app PDF viewer (modal)
  const handleOpenPdf = (po) => {
    const key = po?.poPdfPath || po?.po_pdf_path || po?.poPdf || "";
    if (!key) {
      alert("No PDF attached to this purchase order.");
      return;
    }

    const url = `${API_BASE_URL}/files?key=${encodeURIComponent(key)}`;
    const title = `PO ${po?.poNumber || ""}`.trim();

    setPdfUrl(url);
    setPdfTitle(title || "Purchase Order PDF");
    setPdfModalOpen(true);
  };

  const handleViewWorkOrder = (po) => {
    const woId = po?.workOrderId ?? po?.work_order_id ?? po?.woId ?? null;
    if (!woId) {
      alert("No related work order linked to this purchase order.");
      return;
    }
    navigate(`/work-orders/${woId}`);
  };

  // ✅ Normalize fields so the UI always displays something even if backend uses different names
  const normalizedPurchaseOrders = useMemo(() => {
    return (purchaseOrders || []).map((po) => {
      const poPdfPath = (po.poPdfPath ?? po.po_pdf_path ?? po.poPdf ?? po.po_pdf ?? "") || "";

      const originalName =
        (po.poPdfOriginalName ??
          po.po_pdf_original_name ??
          po.poPdfFilename ??
          po.po_pdf_filename ??
          po.filename ??
          "") || "";

      const supplierRaw =
        (po.supplier ??
          po.poSupplier ??
          po.po_supplier ??
          po.vendor ??
          po.vendorName ??
          po.supplierName ??
          po.poVendor ??
          po.po_vendor ??
          "") || "";

      // Best-effort inference using *multiple* fields
      const inferText = [supplierRaw, poPdfPath, originalName].filter(Boolean).join(" ");
      const inferred = inferSupplierFromText(inferText);

      const supplier = supplierRaw || inferred || "";

      const workOrderStatus =
        (po.workOrderStatus ??
          po.work_order_status ??
          po.woStatus ??
          po.workOrder_status ??
          po.workOrderStatusText ??
          "") || "";

      const poStatus = normalizePoStatus(po);
      const poPickedUp = !!(po.poPickedUp ?? po.po_picked_up ?? po.pickedUp);

      return {
        ...po,
        supplier,
        poSupplier: (po.poSupplier ?? supplier) || "",
        poNumber: (po.poNumber ?? po.po_number ?? po.poNo ?? "") || "",
        customer: (po.customer ?? po.customerName ?? "") || "",
        siteLocation: (po.siteLocation ?? po.site_name ?? po.siteName ?? "") || "",
        siteAddress: (po.siteAddress ?? po.site_address ?? "") || "",
        workOrderNumber: (po.workOrderNumber ?? po.work_order_number ?? po.woNumber ?? "") || "",
        workOrderId: po.workOrderId ?? po.work_order_id ?? po.woId ?? null,
        poPdfPath,
        poPdfOriginalName: originalName,
        createdAt: po.createdAt ?? po.created_at ?? po.createdOn ?? po.created_date ?? null,
        poPickedUp,
        poStatus,
        workOrderStatus,
      };
    });
  }, [purchaseOrders]);

  // ✅ Only show "Waiting on Parts" work orders in Purchase Orders tab
  const waitingOnPartsOnly = useMemo(() => {
    return (normalizedPurchaseOrders || []).filter((po) => {
      const s = safeLower(po.workOrderStatus || "");
      return s === "waiting on parts" || s.includes("waiting on parts");
    });
  }, [normalizedPurchaseOrders]);

  // Client-side search as a backup
  const filteredPurchaseOrders = useMemo(() => {
    const q = (search || "").trim().toLowerCase();
    const base = waitingOnPartsOnly;

    // Supplier filter client-side too (important because supplier may be inferred)
    const supplierFiltered =
      supplierFilter && supplierFilter !== "All Suppliers"
        ? base.filter((po) => safeLower(po.supplier) === safeLower(supplierFilter))
        : base;

    // Status filter client-side too
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
  }, [waitingOnPartsOnly, search, supplierFilter, statusFilter]);

  // Buttons: match your screenshot (all blue, even spacing, same width, no wrap)
  const btnStyle = {
    minWidth: 140,
  };

  return (
    <div className="container mt-4">
      <h2>Purchase Orders</h2>

      {/* Filters */}
      <div className="card mb-4">
        <div className="card-body">
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
                    <button
                      type="button"
                      className="btn btn-link btn-sm"
                      onClick={() => setSearchApplied("")}
                    >
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
            <b>Showing only work orders with status: “Waiting on Parts”.</b>
          </div>
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center">
          <span>Purchase Orders List</span>
          {loading && <span className="text-muted">Loading...</span>}
        </div>

        <div className="card-body p-0">
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

                {filteredPurchaseOrders.map((po) => (
                  <tr key={po.id}>
                    <td>{po.supplier || "-"}</td>
                    <td>{po.poNumber || "-"}</td>
                    <td>{po.customer || "-"}</td>
                    <td>{po.siteLocation || po.siteAddress || "-"}</td>
                    <td>{po.workOrderNumber || "-"}</td>
                    <td>{po.poStatus || (po.poPickedUp ? "Picked Up" : "On Order")}</td>
                    <td>{po.createdAt ? new Date(po.createdAt).toLocaleString() : "-"}</td>

                    <td>
                      {po.poPdfPath ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          style={btnStyle}
                          onClick={() => handleOpenPdf(po)}
                        >
                          View PDF
                        </button>
                      ) : (
                        <span className="text-muted">No PDF</span>
                      )}
                    </td>

                    <td>
                      {/* keep them on ONE line like your screenshot */}
                      <div className="d-flex align-items-center gap-2" style={{ flexWrap: "nowrap" }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          style={btnStyle}
                          onClick={() => handleViewWorkOrder(po)}
                        >
                          View Work Order
                        </button>

                        {!po.poPickedUp && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            style={btnStyle}
                            onClick={() => handleMarkPickedUp(po)}
                          >
                            Mark Picked Up
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* small footer */}
          <div className="p-3 text-muted" style={{ fontSize: "0.85rem" }}>
            Showing <b>{filteredPurchaseOrders.length}</b> of{" "}
            <b>{waitingOnPartsOnly.length}</b> (Waiting on Parts) purchase orders.
          </div>
        </div>
      </div>

      {/* -------- In-app PDF Modal -------- */}
      {pdfModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closePdfModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 2000,
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 1100,
              margin: "0 auto",
              background: "#fff",
              borderRadius: 10,
              overflow: "hidden",
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            }}
          >
            <div className="d-flex align-items-center justify-content-between p-3 border-bottom">
              <div className="fw-bold">{pdfTitle || "Purchase Order PDF"}</div>
              <div className="d-flex align-items-center gap-2">
                {/* optional: open in new tab if someone wants it */}
                {pdfUrl ? (
                  <a className="btn btn-sm btn-outline-secondary" href={pdfUrl} target="_blank" rel="noreferrer">
                    Open in New Tab
                  </a>
                ) : null}
                <button className="btn btn-sm btn-primary" onClick={closePdfModal}>
                  Close
                </button>
              </div>
            </div>

            <div style={{ height: "80vh" }}>
              {pdfUrl ? (
                <iframe
                  title="PO PDF Viewer"
                  src={pdfUrl}
                  style={{ width: "100%", height: "100%", border: 0 }}
                />
              ) : (
                <div className="p-4 text-muted">No PDF URL.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
