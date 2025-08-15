// File: src/EditWorkOrder.js
import React, { useState, useEffect } from "react";
import api from "./api";
import API_BASE_URL from "./config";
import { useNavigate, useParams } from "react-router-dom";
import "./EditWorkOrder.css";

export default function EditWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pdfFile, setPdfFile] = useState(null);

  useEffect(() => {
    // fetch the work order
    api
      .get(`/work-orders/${id}`)
      .then((res) => {
        setWorkOrder(res.data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("⚠️ Error fetching work order:", err);
        setLoading(false);
      });

    // fetch assignees list (hide Mark)
    api
      .get("/users", { params: { assignees: 1 } })
      .then((res) => setUsers((res.data || []).filter((u) => u.username !== "Mark")))
      .catch((err) => console.error("⚠️ Error fetching users:", err));
  }, [id]);

  const handleFileChange = (e) => {
    setPdfFile(e.target.files[0]);
  };

  const handleUpdate = (event) => {
    event.preventDefault();
    if (!workOrder) return;

    const formData = new FormData();
    formData.append("poNumber", workOrder.poNumber || "");
    formData.append("customer", workOrder.customer || "");
    formData.append("siteLocation", workOrder.siteLocation || "");
    formData.append("billingAddress", workOrder.billingAddress || "");
    formData.append("problemDescription", workOrder.problemDescription || "");
    formData.append("status", workOrder.status || "Needs to be Scheduled");
    formData.append("assignedTo", workOrder.assignedTo || "");
    formData.append("customerPhone", workOrder.customerPhone || "");
    formData.append("customerEmail", workOrder.customerEmail || "");

    if (pdfFile) {
      formData.append("pdfFile", pdfFile);
    }

    api
      .put(`/work-orders/${id}/edit`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then(() => navigate("/work-orders"))
      .catch((err) => {
        console.error("⚠️ Error updating work order:", err.response || err);
        alert("Error updating work order. See console.");
      });
  };

  const handleDelete = () => {
    if (window.confirm("Delete this work order?")) {
      api
        .delete(`/work-orders/${id}`)
        .then(() => navigate("/work-orders"))
        .catch((err) => {
          console.error("Error deleting work order:", err);
          alert("Failed to delete. See console.");
        });
    }
  };

  if (loading) return <p className="text-center mt-4">Loading…</p>;
  if (!workOrder) return <p className="text-center text-danger mt-4">Not found.</p>;

  return (
    <div className="edit-container">
      <form onSubmit={handleUpdate} className="edit-card">
        <h2 className="edit-title">Edit Work Order</h2>

        <div className="form-group">
          <label>PO Number</label>
          <input
            type="text"
            className="form-control-custom"
            value={workOrder.poNumber || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, poNumber: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Customer Name</label>
          <input
            type="text"
            className="form-control-custom"
            required
            value={workOrder.customer || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, customer: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Customer Phone (optional)</label>
          <input
            type="tel"
            className="form-control-custom"
            value={workOrder.customerPhone || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, customerPhone: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Customer Email (optional)</label>
          <input
            type="email"
            className="form-control-custom"
            value={workOrder.customerEmail || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, customerEmail: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Site Location</label>
          <textarea
            className="form-textarea-custom"
            rows="3"
            required
            value={workOrder.siteLocation || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, siteLocation: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Billing Address</label>
          <textarea
            className="form-textarea-custom"
            rows="3"
            required
            value={workOrder.billingAddress || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, billingAddress: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Problem Description</label>
          <textarea
            className="form-textarea-custom"
            rows="4"
            required
            value={workOrder.problemDescription || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, problemDescription: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>Status</label>
          <select
            className="form-select-custom"
            value={workOrder.status || "Needs to be Scheduled"}
            onChange={(e) => setWorkOrder({ ...workOrder, status: e.target.value })}
          >
            <option value="Needs to be Scheduled">Needs to be Scheduled</option>
            <option value="Scheduled">Scheduled</option>
            <option value="Waiting for Approval">Waiting for Approval</option>
            <option value="Waiting on Parts">Waiting on Parts</option>
            <option value="Completed">Completed</option>
          </select>
        </div>

        <div className="form-group">
          <label>Assign To</label>
          <select
            className="form-select-custom"
            value={workOrder.assignedTo || ""}
            onChange={(e) => setWorkOrder({ ...workOrder, assignedTo: e.target.value })}
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Replace Work Order PDF (Optional)</label>
          <input
            type="file"
            className="form-file-custom"
            accept="application/pdf"
            onChange={handleFileChange}
          />
          {workOrder.pdfPath && (
            <small className="text-muted">
              Current PDF:{" "}
              <a
                href={`${API_BASE_URL}/files?key=${encodeURIComponent(workOrder.pdfPath)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {workOrder.pdfPath}
              </a>
            </small>
          )}
        </div>

        <div className="button-row">
          <button type="submit" className="btn-custom btn-save">
            Save Changes
          </button>
          <button type="button" className="btn-custom btn-delete" onClick={handleDelete}>
            Delete
          </button>
          <button
            type="button"
            className="btn-custom btn-back"
            onClick={() => navigate("/work-orders")}
          >
            Back
          </button>
        </div>
      </form>
    </div>
  );
}
