// File: src/EditWorkOrder.js
import React, { useState, useEffect, useMemo } from "react";
import api from "./api";
import API_BASE_URL from "./config";
import { useNavigate, useParams } from "react-router-dom";
import "./EditWorkOrder.css";

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

export default function EditWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  // Files
  const [pdfFile, setPdfFile] = useState(null); // WO PDF replacement
  const [estimateFiles, setEstimateFiles] = useState([]); // multiple
  const [poFiles, setPoFiles] = useState([]); // multiple

  // Quick note
  const [quickNote, setQuickNote] = useState("");

  // For safer date/time control
  const scheduledDateInput = useMemo(() => {
    if (!workOrder?.scheduledDate) return "";
    try {
      const dt = new Date(workOrder.scheduledDate);
      const pad = (n) => String(n).padStart(2, "0");
      const yyyy = dt.getFullYear();
      const mm = pad(dt.getMonth() + 1);
      const dd = pad(dt.getDate());
      const hh = pad(dt.getHours());
      const mi = pad(dt.getMinutes());
      return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
    } catch {
      return "";
    }
  }, [workOrder?.scheduledDate]);

  useEffect(() => {
    // fetch the work order
    api
      .get(`/work-orders/${id}`, { withCredentials: true })
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
      .get("/users", { params: { assignees: 1 }, withCredentials: true })
      .then((res) =>
        setUsers((res.data || []).filter((u) => u.username !== "Mark"))
      )
      .catch((err) => console.error("⚠️ Error fetching users:", err));
  }, [id]);

  const onChange = (patch) =>
    setWorkOrder((w) => ({ ...(w || {}), ...patch }));

  const handleWOFileChange = (e) => {
    setPdfFile(e.target.files?.[0] ?? null);
  };
  const handleEstimateFiles = (e) => {
    const files = Array.from(e.target.files || []);
    setEstimateFiles(files);
  };
  const handlePOFiles = (e) => {
    const files = Array.from(e.target.files || []);
    setPoFiles(files);
  };

  const appendQuickNoteIfAny = async () => {
    const text = (quickNote || "").trim();
    if (!text) return;
    try {
      // Primary shape
      await api.put(
        `/work-orders/${id}/notes`,
        { notes: text, append: true },
        { withCredentials: true }
      );
    } catch (e1) {
      try {
        // Fallback shape
        await api.put(
          `/work-orders/${id}/notes`,
          { text, append: true },
          { withCredentials: true }
        );
      } catch (e2) {
        console.error(
          "⚠️ Failed to append note:",
          e2?.response?.data?.error || e2?.message || e1?.message
        );
      }
    }
  };

  const handleUpdate = async (event) => {
    event.preventDefault();
    if (!workOrder) return;

    try {
      const formData = new FormData();

      // Core fields
      formData.append("workOrderNumber", workOrder.workOrderNumber || "");
      formData.append("poNumber", workOrder.poNumber || "");
      formData.append("customer", workOrder.customer || "");
      formData.append("customerPhone", workOrder.customerPhone || "");
      formData.append("customerEmail", workOrder.customerEmail || "");

      // Location set (legacy + explicit)
      formData.append("siteLocation", workOrder.siteLocation || "");
      formData.append("siteName", workOrder.siteName || "");
      formData.append("siteAddress", workOrder.siteAddress || "");

      // Billing
      formData.append("billingAddress", workOrder.billingAddress || "");

      // Problem
      formData.append("problemDescription", workOrder.problemDescription || "");

      // Status / Assign / Schedule
      formData.append("status", workOrder.status || "Needs to be Scheduled");
      formData.append("assignedTo", workOrder.assignedTo || "");
      formData.append("scheduledDate", workOrder.scheduledDate || "");

      // Replace WO PDF (optional)
      if (pdfFile) formData.append("pdfFile", pdfFile);

      // Append Estimate PDFs (optional, multiple)
      if (estimateFiles?.length) {
        for (const f of estimateFiles) formData.append("estimatePdfFiles", f);
      }

      // Append PO PDFs (optional, multiple)
      if (poFiles?.length) {
        for (const f of poFiles) formData.append("poPdfFiles", f);
      }

      await api.put(`/work-orders/${id}/edit`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: true,
      });

      await appendQuickNoteIfAny();

      navigate("/work-orders");
    } catch (err) {
      console.error("⚠️ Error updating work order:", err?.response || err);
      alert(err?.response?.data?.error || "Error updating work order. See console.");
    }
  };

  /**
   * Robust multi-strategy delete:
   *  - DELETE /work-orders/:id
   *  - POST   /work-orders/:id?_method=DELETE   (method-override)
   *  - POST   /work-orders/:id/delete
   *  - DELETE /work-orders { id }
   * Includes withCredentials on each attempt and surfaces precise server errors.
   */
  const handleDelete = async () => {
    if (deleting) return;
    if (!window.confirm("Delete this work order? This cannot be undone.")) return;

    setDeleting(true);

    const showErr = (err, label) => {
      const status = err?.response?.status;
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Unknown error";
      console.error(`❌ ${label} failed`, { status, msg, err });
      return { status, msg };
    };

    try {
      // Try 1: canonical REST
      await api.delete(`/work-orders/${id}`, { withCredentials: true });
      navigate("/work-orders");
      return;
    } catch (e1) {
      const { status, msg } = showErr(e1, "DELETE /work-orders/:id");
      // If 401/403, no point trying others without creds; but we already pass withCredentials.
      // Keep going.
    }

    try {
      // Try 2: method-override style
      await api.post(`/work-orders/${id}?_method=DELETE`, null, {
        withCredentials: true,
      });
      navigate("/work-orders");
      return;
    } catch (e2) {
      showErr(e2, "POST /work-orders/:id?_method=DELETE");
    }

    try {
      // Try 3: explicit /delete endpoint
      await api.post(`/work-orders/${id}/delete`, null, {
        withCredentials: true,
      });
      navigate("/work-orders");
      return;
    } catch (e3) {
      showErr(e3, "POST /work-orders/:id/delete");
    }

    try {
      // Try 4: bulk-style body
      await api.delete(`/work-orders`, {
        data: { id, purgeFiles: true },
        withCredentials: true,
        headers: { "Content-Type": "application/json" },
      });
      navigate("/work-orders");
      return;
    } catch (e4) {
      const { status, msg } = showErr(e4, "DELETE /work-orders { id }");
      alert(`Failed to delete (status ${status ?? "?"}). ${msg}. See console for details.`);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <p className="text-center mt-4">Loading…</p>;
  if (!workOrder) return <p className="text-center text-danger mt-4">Not found.</p>;

  return (
    <div className="edit-container">
      <form onSubmit={handleUpdate} className="edit-card">
        <h2 className="edit-title">Edit Work Order</h2>

        {/* Row: WO # / PO # */}
        <div className="form-row">
          <div className="form-group">
            <label>Work Order #</label>
            <input
              type="text"
              className="form-control-custom"
              value={workOrder.workOrderNumber || ""}
              onChange={(e) => onChange({ workOrderNumber: e.target.value })}
              placeholder="e.g., 24-00123"
            />
          </div>

          <div className="form-group">
            <label>PO Number</label>
            <input
              type="text"
              className="form-control-custom"
              value={workOrder.poNumber || ""}
              onChange={(e) => onChange({ poNumber: e.target.value })}
              placeholder="e.g., TS-45678"
            />
          </div>
        </div>

        {/* Row: Customer / Phone / Email */}
        <div className="form-row">
          <div className="form-group">
            <label>Customer Name</label>
            <input
              type="text"
              className="form-control-custom"
              required
              value={workOrder.customer || ""}
              onChange={(e) => onChange({ customer: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Customer Phone</label>
            <input
              type="tel"
              className="form-control-custom"
              value={workOrder.customerPhone || ""}
              onChange={(e) => onChange({ customerPhone: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Customer Email</label>
            <input
              type="email"
              className="form-control-custom"
              value={workOrder.customerEmail || ""}
              onChange={(e) => onChange({ customerEmail: e.target.value })}
            />
          </div>
        </div>

        {/* Row: Site Name / Site Address */}
        <div className="form-row">
          <div className="form-group">
            <label>Site Name</label>
            <input
              type="text"
              className="form-control-custom"
              value={workOrder.siteName || ""}
              onChange={(e) => onChange({ siteName: e.target.value })}
              placeholder="e.g., Woodward HQ, Starbucks #1234"
            />
          </div>

          <div className="form-group">
            <label>Site Address</label>
            <input
              type="text"
              className="form-control-custom"
              value={workOrder.siteAddress || ""}
              onChange={(e) => onChange({ siteAddress: e.target.value })}
              placeholder="Street, City, State ZIP"
            />
          </div>
        </div>

        {/* Legacy Site Location (kept for compatibility) */}
        <div className="form-group">
          <label>Site Location (Legacy)</label>
          <textarea
            className="form-textarea-custom"
            rows="2"
            value={workOrder.siteLocation || ""}
            onChange={(e) => onChange({ siteLocation: e.target.value })}
            placeholder="(Optional if Site Name/Address are filled)"
          />
        </div>

        {/* Billing */}
        <div className="form-group">
          <label>Billing Address</label>
          <textarea
            className="form-textarea-custom"
            rows="3"
            required
            value={workOrder.billingAddress || ""}
            onChange={(e) => onChange({ billingAddress: e.target.value })}
            placeholder="Street, City, State ZIP"
          />
        </div>

        {/* Problem */}
        <div className="form-group">
          <label>Problem Description</label>
          <textarea
            className="form-textarea-custom"
            rows="4"
            required
            value={workOrder.problemDescription || ""}
            onChange={(e) => onChange({ problemDescription: e.target.value })}
          />
        </div>

        {/* Status / Assigned / Schedule */}
        <div className="form-row">
          <div className="form-group">
            <label>Status</label>
            <select
              className="form-select-custom"
              value={workOrder.status || "Needs to be Scheduled"}
              onChange={(e) => onChange({ status: e.target.value })}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Assign To</label>
            <select
              className="form-select-custom"
              value={workOrder.assignedTo || ""}
              onChange={(e) => onChange({ assignedTo: e.target.value })}
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
            <label>Scheduled Date & Time</label>
            <input
              type="datetime-local"
              className="form-control-custom"
              value={workOrder.scheduledDate ? scheduledDateInput || "" : ""}
              onChange={(e) => onChange({ scheduledDate: e.target.value })}
            />
          </div>
        </div>

        {/* Files: WO PDF, Estimates, POs */}
        <div className="form-group">
          <label>Replace Work Order PDF (Optional)</label>
          <input
            type="file"
            className="form-file-custom"
            accept="application/pdf"
            onChange={handleWOFileChange}
          />
          {workOrder.pdfPath && (
            <small className="text-muted">
              Current PDF:{" "}
              <a
                href={`${API_BASE_URL}/files?key=${encodeURIComponent(
                  workOrder.pdfPath
                )}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {workOrder.pdfPath}
              </a>
            </small>
          )}
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Upload Estimate PDF(s) (Optional)</label>
            <input
              type="file"
              className="form-file-custom"
              accept="application/pdf"
              multiple
              onChange={handleEstimateFiles}
            />
            {!!workOrder?.estimatePdfPaths && (
              <small className="text-muted d-block">
                Existing: {String(workOrder.estimatePdfPaths)}
              </small>
            )}
          </div>

          <div className="form-group">
            <label>Upload PO PDF(s) (Optional)</label>
            <input
              type="file"
              className="form-file-custom"
              accept="application/pdf"
              multiple
              onChange={handlePOFiles}
            />
            {!!workOrder?.poPdfPaths && (
              <small className="text-muted d-block">
                Existing: {String(workOrder.poPdfPaths)}
              </small>
            )}
          </div>
        </div>

        {/* Quick Note (appends to notes history) */}
        <div className="form-group">
          <label>Add Note (optional, appends)</label>
          <textarea
            className="form-textarea-custom"
            rows="3"
            value={quickNote}
            onChange={(e) => setQuickNote(e.target.value)}
            placeholder="e.g., Parts In / Spoke with customer / On site at 8AM"
          />
        </div>

        <div className="button-row">
          <button type="submit" className="btn-custom btn-save" disabled={deleting}>
            Save Changes
          </button>
          <button
            type="button"
            className="btn-custom btn-delete"
            onClick={handleDelete}
            disabled={deleting}
            title={deleting ? "Deleting…" : "Delete work order"}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            className="btn-custom btn-back"
            onClick={() => navigate("/work-orders")}
            disabled={deleting}
          >
            Back
          </button>
        </div>
      </form>
    </div>
  );
}
