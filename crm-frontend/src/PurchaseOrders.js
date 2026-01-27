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

export default function PurchaseOrders() {
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [supplierFilter, setSupplierFilter] = useState("All Suppliers");
  const [statusFilter, setStatusFilter] = useState("On Order");
  const [search, setSearch] = useState("");

  // server-side search (hit Search button) + keep client-side filtering as backup
  const [searchApplied, setSearchApplied] = useState("");

  const navigate = useNavigate();

  const loadPurchaseOrders = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      // ✅ Build query params that are compatible with either backend style:
      // - status=on-order/picked-up  OR  status=On Order/Picked Up
      // - supplier=Chicago Tempered etc
      // - search=...
      const params = {};

      if (supplierFilter && supplierFilter !== "All Suppliers") {
        params.supplier = supplierFilter;
      }

      if (statusFilter && statusFilter !== "All Statuses") {
        // Use hyphen values first (your current backend mapping),
        // but also include a readable fallback field some backends expect.
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

      // Backend might return array OR { rows: [...] }
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
    // loadPurchaseOrders will rerun because searchApplied changes
  };

  const handleMarkPickedUp = async (po) => {
    const poNum = po?.poNumber || "";
    if (!window.confirm(`Mark PO ${poNum} as Picked Up?`)) return;

    setError("");

    // Helper to normalize fields coming back from backend
    const normalizeIncoming = (obj) => {
      if (!obj || typeof obj !== "object") return obj;
      return {
        ...obj,
        // Common field aliases:
        supplier: obj.supplier ?? obj.poSupplier ?? obj.po_supplier ?? obj.vendor ?? "",
        poSupplier: obj.poSupplier ?? obj.supplier ?? obj.po_supplier ?? obj.vendor ?? "",
        poPdfPath: obj.poPdfPath ?? obj.po_pdf_path ?? obj.poPdf ?? obj.po_pdf ?? "",
        workOrderId: obj.workOrderId ?? obj.work_order_id ?? obj.woId ?? obj.workOrderID ?? obj.workOrder_id,
        workOrderNumber: obj.workOrderNumber ?? obj.work_order_number ?? obj.woNumber ?? obj.workOrderNo,
        createdAt: obj.createdAt ?? obj.created_at ?? obj.createdOn ?? obj.created_date,
      };
    };

    try {
      // ✅ Try multiple endpoints (since backends often differ)
      let updated = null;

      try {
        const r = await api.put(`/purchase-orders/${po.id}/mark-picked-up`, null, {
          headers: authHeaders(),
        });
        updated = r.data;
      } catch (e1) {
        try {
          const r = await api.put(`/purchase-orders/${po.id}/picked-up`, { pickedUp: true }, { headers: authHeaders() });
          updated = r.data;
        } catch (e2) {
          // Fallback: update via work order edit (if backend derives PO from work order)
          // If we have a workOrderId, toggle poPickedUp there
          const woId = po.workOrderId ?? po.work_order_id ?? po.woId;
          if (!woId) throw e2;

          const form = new FormData();
          form.append("poPickedUp", "1");

          const r = await api.put(`/work-orders/${woId}/edit`, form, {
            headers: { "Content-Type": "multipart/form-data", ...authHeaders() },
          });

          // Some APIs return the work order; we still want to reflect PO row in UI
          updated = { ...po, poPickedUp: true, poStatus: "Picked Up", ...r.data };
        }
      }

      const normalized = normalizeIncoming(updated);

      setPurchaseOrders((prev) =>
        prev.map((item) => (item.id === po.id ? { ...item, ...normalized, poPickedUp: true, poStatus: "Picked Up" } : item))
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

  const handleOpenPdf = (po) => {
    const key = po?.poPdfPath || po?.po_pdf_path || po?.poPdf || "";
    if (!key) {
      alert("No PDF attached to this purchase order.");
      return;
    }
    const url = `${API_BASE_URL}/files?key=${encodeURIComponent(key)}`;
    window.open(url, "_blank", "noopener,noreferrer");
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
    return (purchaseOrders || []).map((po) => ({
      ...po,
      supplier: po.supplier ?? po.poSupplier ?? po.po_supplier ?? po.vendor ?? "",
      poNumber: po.poNumber ?? po.po_number ?? po.poNo ?? "",
      customer: po.customer ?? po.customerName ?? "",
      siteLocation: po.siteLocation ?? po.site_name ?? po.siteName ?? "",
      siteAddress: po.siteAddress ?? po.site_address ?? "",
      workOrderNumber: po.workOrderNumber ?? po.work_order_number ?? po.woNumber ?? "",
      workOrderId: po.workOrderId ?? po.work_order_id ?? po.woId ?? null,
      poPdfPath: po.poPdfPath ?? po.po_pdf_path ?? po.poPdf ?? po.po_pdf ?? "",
      createdAt: po.createdAt ?? po.created_at ?? po.createdOn ?? po.created_date ?? null,
      poPickedUp: !!(po.poPickedUp ?? po.po_picked_up ?? po.pickedUp),
      poStatus: po.poStatus ?? po.po_status ?? "",
    }));
  }, [purchaseOrders]);

  // Client-side search as a backup (even though we also support server-side searchApplied)
  const filteredPurchaseOrders = useMemo(() => {
    const q = (search || "").trim().toLowerCase();
    if (!q) return normalizedPurchaseOrders;

    return normalizedPurchaseOrders.filter((po) => {
      const fieldsToSearch = [
        po.poNumber,
        po.customer,
        po.siteLocation,
        po.siteAddress,
        po.workOrderNumber,
        po.supplier,
      ];
      return fieldsToSearch.some((val) => (val || "").toString().toLowerCase().includes(q));
    });
  }, [normalizedPurchaseOrders, search]);

  return (
    <div className="container mt-4">
      <h2>Purchase Orders</h2>

      {/* Filters */}
      <div className="card mb-4">
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Supplier</label>
              <select className="form-select" value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
                {SUPPLIERS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-md-3">
              <label className="form-label">Status</label>
              <select className="form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
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
                      onClick={() => {
                        setSearchApplied("");
                        // also reload (searchApplied change triggers load)
                      }}
                    >
                      Clear server filter
                    </button>
                  </div>
                )}
              </form>
            </div>

            <div className="col-md-2 text-end">
              <button
                className="btn btn-outline-secondary mt-3 mt-md-0"
                type="button"
                onClick={loadPurchaseOrders}
                disabled={loading}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-3 text-muted" style={{ fontSize: "0.9rem" }}>
            Purchase orders are derived from work orders (PO Number, Supplier, and PO PDF). To add or change a PO, edit the related work order.
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
                          className="btn btn-sm btn-outline-primary"
                          onClick={() => handleOpenPdf(po)}
                        >
                          View PDF
                        </button>
                      ) : (
                        <span className="text-muted">No PDF</span>
                      )}
                    </td>

                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary me-2"
                        onClick={() => handleViewWorkOrder(po)}
                      >
                        View Work Order
                      </button>

                      {!po.poPickedUp && (
                        <button
                          type="button"
                          className="btn btn-sm btn-success"
                          onClick={() => handleMarkPickedUp(po)}
                        >
                          Mark Picked Up
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* small footer */}
          <div className="p-3 text-muted" style={{ fontSize: "0.85rem" }}>
            Showing <b>{filteredPurchaseOrders.length}</b> of <b>{normalizedPurchaseOrders.length}</b> purchase orders.
          </div>
        </div>
      </div>
    </div>
  );
}
