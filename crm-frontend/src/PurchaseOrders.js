// File: src/PurchaseOrders.js

import React, { useEffect, useState } from "react";

const API_BASE =
  process.env.REACT_APP_API_BASE || "http://FCGG.us-east-2.elasticbeanstalk.com";

const SUPPLIERS = [
  "All Suppliers",
  "Chicago Tempered",
  "CRL",
  "Oldcastle",
  "Casco",
];

const STATUSES = [
  "All Statuses",
  "On Order",
  "Ready for Pickup",
  "Picked Up",
  "Cancelled",
];

export default function PurchaseOrders() {
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [supplierFilter, setSupplierFilter] = useState("All Suppliers");
  const [statusFilter, setStatusFilter] = useState("On Order");
  const [search, setSearch] = useState("");

  // Form state for creating a new PO
  const [newSupplier, setNewSupplier] = useState("Chicago Tempered");
  const [newPoNumber, setNewPoNumber] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newRelatedWorkOrderId, setNewRelatedWorkOrderId] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [newPdfFile, setNewPdfFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const jwt = localStorage.getItem("jwt");

  const authHeaders = jwt
    ? {
        Authorization: `Bearer ${jwt}`,
      }
    : {};

  const loadPurchaseOrders = async () => {
    try {
      setLoading(true);
      setError("");

      const params = new URLSearchParams();

      if (supplierFilter && supplierFilter !== "All Suppliers") {
        params.set("supplier", supplierFilter);
      }

      if (statusFilter && statusFilter !== "All Statuses") {
        params.set("status", statusFilter);
      }

      if (search.trim()) {
        params.set("search", search.trim());
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
    loadPurchaseOrders();
  };

  const handleCreatePo = async (e) => {
    e.preventDefault();
    if (!newSupplier || !newPoNumber) {
      alert("Supplier and PO Number are required.");
      return;
    }
    if (!newPdfFile) {
      const confirmNoPdf = window.confirm(
        "No PDF selected. Create PO without attached PDF?"
      );
      if (!confirmNoPdf) return;
    }

    try {
      setSaving(true);
      setError("");

      const formData = new FormData();
      formData.append("supplier", newSupplier);
      formData.append("poNumber", newPoNumber);
      if (newDescription.trim()) formData.append("description", newDescription);
      if (newRelatedWorkOrderId.trim()) {
        formData.append("relatedWorkOrderId", newRelatedWorkOrderId.trim());
      }
      if (newNotes.trim()) formData.append("notes", newNotes.trim());
      // Default status: On Order (backend also defaults, but we keep it explicit)
      formData.append("status", "On Order");

      if (newPdfFile) {
        // any fieldname is fine; backend uses first PDF it finds
        formData.append("poPdf", newPdfFile);
      }

      const res = await fetch(`${API_BASE}/purchase-orders`, {
        method: "POST",
        headers: {
          ...authHeaders,
          // Don't set Content-Type here; browser sets multipart boundary
        },
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to create purchase order (${res.status}): ${text}`
        );
      }

      // Reset the form
      setNewPoNumber("");
      setNewDescription("");
      setNewRelatedWorkOrderId("");
      setNewNotes("");
      setNewPdfFile(null);

      // Reload list
      await loadPurchaseOrders();
    } catch (err) {
      console.error("Error creating purchase order:", err);
      setError(err.message || "Failed to create purchase order.");
    } finally {
      setSaving(false);
    }
  };

  const handleMarkPickedUp = async (po) => {
    if (!window.confirm(`Mark PO ${po.poNumber} as Picked Up?`)) return;

    try {
      const res = await fetch(`${API_BASE}/purchase-orders/${po.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({
          status: "Picked Up",
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to update PO (${res.status}): ${text}`);
      }

      const updated = await res.json();

      // Update local list
      setPurchaseOrders((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );

      // Optional: let user know
      if (updated.relatedWorkOrderId) {
        alert(
          `PO ${updated.poNumber} marked as Picked Up.\n` +
            `Related Work Order #${updated.relatedWorkOrderId} status has been updated on the backend.`
        );
      } else {
        alert(`PO ${updated.poNumber} marked as Picked Up.`);
      }
    } catch (err) {
      console.error("Error marking PO picked up:", err);
      setError(err.message || "Failed to update purchase order.");
    }
  };

  const handleOpenPdf = (po) => {
    if (!po.pdfPath) {
      alert("No PDF attached to this purchase order.");
      return;
    }
    const url = `${API_BASE}/files?key=${encodeURIComponent(po.pdfPath)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    setNewPdfFile(file || null);
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
                <label className="form-label">Search (PO #, description, notes)</label>
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
        </div>
      </div>

      {/* Create New PO */}
      <div className="card mb-4">
        <div className="card-header">Create New Purchase Order</div>
        <div className="card-body">
          <form onSubmit={handleCreatePo}>
            <div className="row g-3">
              <div className="col-md-3">
                <label className="form-label">Supplier</label>
                <select
                  className="form-select"
                  value={newSupplier}
                  onChange={(e) => setNewSupplier(e.target.value)}
                >
                  {SUPPLIERS.filter((s) => s !== "All Suppliers").map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-md-3">
                <label className="form-label">PO Number</label>
                <input
                  type="text"
                  className="form-control"
                  value={newPoNumber}
                  onChange={(e) => setNewPoNumber(e.target.value)}
                  required
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Related Work Order ID</label>
                <input
                  type="number"
                  className="form-control"
                  value={newRelatedWorkOrderId}
                  onChange={(e) => setNewRelatedWorkOrderId(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">PO PDF</label>
                <input
                  type="file"
                  accept="application/pdf"
                  className="form-control"
                  onChange={handleFileChange}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label">Description</label>
                <textarea
                  className="form-control"
                  rows={2}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="What is this PO for?"
                />
              </div>
              <div className="col-md-6">
                <label className="form-label">Notes</label>
                <textarea
                  className="form-control"
                  rows={2}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Any additional notes..."
                />
              </div>
              <div className="col-12 text-end">
                <button
                  type="submit"
                  className="btn btn-success"
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Create Purchase Order"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* List */}
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
                  <th>Description</th>
                  <th>Status</th>
                  <th>Related WO</th>
                  <th>Created</th>
                  <th>PDF</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {purchaseOrders.length === 0 && !loading && (
                  <tr>
                    <td colSpan="8" className="text-center py-3">
                      No purchase orders found.
                    </td>
                  </tr>
                )}
                {purchaseOrders.map((po) => (
                  <tr key={po.id}>
                    <td>{po.supplier}</td>
                    <td>{po.poNumber}</td>
                    <td>{po.description}</td>
                    <td>{po.status}</td>
                    <td>{po.relatedWorkOrderId || "-"}</td>
                    <td>
                      {po.createdAt
                        ? new Date(po.createdAt).toLocaleString()
                        : "-"}
                    </td>
                    <td>
                      {po.pdfPath ? (
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
                      {po.status !== "Picked Up" && (
                        <button
                          type="button"
                          className="btn btn-sm btn-success me-2"
                          onClick={() => handleMarkPickedUp(po)}
                        >
                          Mark Picked Up
                        </button>
                      )}
                      {/* You can add more actions here later (edit/delete) */}
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
