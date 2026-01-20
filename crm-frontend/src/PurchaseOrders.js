// File: src/PurchaseOrders.js

import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const API_BASE =
  process.env.REACT_APP_API_BASE || "http://FCGG.us-east-2.elasticbeanstalk.com";

const SUPPLIERS = [
  "All Suppliers",
  "Chicago Tempered",
  "CRL",
  "Oldcastle",
  "Casco",
];

const STATUSES = ["All Statuses", "On Order", "Picked Up"];

export default function PurchaseOrders() {
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [supplierFilter, setSupplierFilter] = useState("All Suppliers");
  const [statusFilter, setStatusFilter] = useState("On Order");
  const [search, setSearch] = useState("");

  const jwt = localStorage.getItem("jwt");

  const authHeaders = jwt
    ? {
        Authorization: `Bearer ${jwt}`,
      }
    : {};

  const navigate = useNavigate();

  const loadPurchaseOrders = async () => {
    try {
      setLoading(true);
      setError("");

      const params = new URLSearchParams();

      if (supplierFilter && supplierFilter !== "All Suppliers") {
        params.set("supplier", supplierFilter);
      }

      // Map UI status → backend query value
      if (statusFilter && statusFilter !== "All Statuses") {
        if (statusFilter === "On Order") {
          params.set("status", "on-order");
        } else if (statusFilter === "Picked Up") {
          params.set("status", "picked-up");
        }
      }

      const url = `${API_BASE}/purchase-orders${
        params.toString() ? `?${params.toString()}` : ""
      }`;

      const res = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to load purchase orders (${res.status})`);
      }

      const data = await res.json();
      setPurchaseOrders(data || []);
    } catch (err) {
      console.error("Error loading purchase orders:", err);
      setError(err.message || "Failed to load purchase orders.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPurchaseOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierFilter, statusFilter]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    // Search is applied client-side; data is already loaded.
  };

  const handleMarkPickedUp = async (po) => {
    if (!window.confirm(`Mark PO ${po.poNumber || ""} as Picked Up?`)) return;

    try {
      const res = await fetch(
        `${API_BASE}/purchase-orders/${po.id}/mark-picked-up`,
        {
          method: "PUT",
          headers: {
            ...authHeaders,
          },
        }
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to update PO (${res.status}): ${text}`);
      }

      const updated = await res.json();

      setPurchaseOrders((prev) =>
        prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item
        )
      );

      if (updated.workOrderNumber) {
        alert(
          `PO ${updated.poNumber || ""} marked as Picked Up.\n` +
            `Related Work Order #${updated.workOrderNumber} has been updated on the backend.`
        );
      } else {
        alert(`PO ${updated.poNumber || ""} marked as Picked Up.`);
      }
    } catch (err) {
      console.error("Error marking PO picked up:", err);
      setError(err.message || "Failed to update purchase order.");
    }
  };

  const handleOpenPdf = (po) => {
    if (!po.poPdfPath) {
      alert("No PDF attached to this purchase order.");
      return;
    }
    const url = `${API_BASE}/files?key=${encodeURIComponent(po.poPdfPath)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleViewWorkOrder = (po) => {
    if (!po.workOrderId) {
      alert("No related work order linked to this purchase order.");
      return;
    }
    navigate(`/work-orders/${po.workOrderId}`);
  };

  const filteredPurchaseOrders = purchaseOrders.filter((po) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;

    const fieldsToSearch = [
      po.poNumber,
      po.customer,
      po.siteLocation,
      po.siteAddress,
      po.workOrderNumber,
      po.supplier,
    ];

    return fieldsToSearch.some((val) =>
      (val || "").toString().toLowerCase().includes(q)
    );
  });

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
                <label className="form-label">
                  Search (PO #, customer, site, WO #)
                </label>
                <div className="input-group">
                  <input
                    type="text"
                    className="form-control"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search purchase orders..."
                  />
                  <button className="btn btn-primary" type="submit">
                    Search
                  </button>
                </div>
              </form>
            </div>
            <div className="col-md-2 text-end">
              <button
                className="btn btn-outline-secondary mt-3 mt-md-0"
                type="button"
                onClick={loadPurchaseOrders}
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="mt-3 text-muted" style={{ fontSize: "0.9rem" }}>
            Purchase orders are derived from work orders (PO Number, Supplier,
            and PO PDF). To add or change a PO, edit the related work order.
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
                    <td>
                      {po.poStatus ||
                        (po.poPickedUp ? "Picked Up" : "On Order")}
                    </td>
                    <td>
                      {po.createdAt
                        ? new Date(po.createdAt).toLocaleString()
                        : "-"}
                    </td>
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
        </div>
      </div>
    </div>
  );
}
