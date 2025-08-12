// File: src/ViewWorkOrder.js

import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "./api";
import moment from "moment";
import API_BASE_URL from "./config";
import "./ViewWorkOrder.css";

export default function ViewWorkOrder() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [workOrder, setWorkOrder] = useState(null);
  const [newNote, setNewNote] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [uploading, setUploading] = useState(false);

  const fileUrl = (key) =>
    key ? `${API_BASE_URL}/files?key=${encodeURIComponent(key)}` : null;

  const fetchWorkOrder = async () => {
    try {
      const { data } = await api.get(`/work-orders/${id}`);
      setWorkOrder(data);
    } catch (error) {
      console.error("⚠️ Error fetching work order:", error);
    }
  };

  useEffect(() => {
    fetchWorkOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!workOrder) {
    return (
      <div className="view-container">
        <p className="loading-text">Loading work order details…</p>
      </div>
    );
  }

  const {
    poNumber,
    customer,
    siteLocation,
    billingAddress,
    problemDescription,
    status,
    scheduledDate,
    pdfPath,
    photoPath,
    notes,
    assignedToName,
  } = workOrder;

  // Parse existing notes
  let notesArray = [];
  if (notes) {
    try {
      notesArray = typeof notes === "string" ? JSON.parse(notes) : notes;
    } catch {
      notesArray = [];
    }
  }

  // Add a new note
  const handleAddNote = async () => {
    if (!newNote.trim()) return;
    try {
      await api.post(`/work-orders/${id}/notes`, { text: newNote });
      setNewNote("");
      setShowNoteInput(false);
      fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error adding note:", error);
      alert("Failed to add note.");
    }
  };

  // Upload attachments (photos) using the edit endpoint; backend will append
  const handleAttachmentChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const formData = new FormData();
    // backend expects "photoFile" (and allows up to 20 files)
    files.forEach((f) => formData.append("photoFile", f));

    try {
      setUploading(true);
      await api.put(`/work-orders/${id}/edit`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchWorkOrder();
    } catch (error) {
      console.error("⚠️ Error uploading attachments:", error);
      alert("Failed to upload attachments.");
    } finally {
      setUploading(false);
      e.target.value = ""; // reset input
    }
  };

  // Existing attachments
  const attachments = (photoPath || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="view-container">
      <div className="view-card">
        <h2 className="view-title">Work Order Details</h2>

        <ul className="detail-list">
          <li className="detail-item">
            <span className="detail-label">WO/PO #:</span>
            <span className="detail-value">{poNumber || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Customer:</span>
            <span className="detail-value">{customer}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Site Location:</span>
            <span className="detail-value">{siteLocation || "—"}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Billing Address:</span>
            <span className="detail-value prewrap">{billingAddress}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Problem Description:</span>
            <span className="detail-value prewrap">{problemDescription}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Status:</span>
            <span className="detail-value">{status}</span>
          </li>
          <li className="detail-item">
            <span className="detail-label">Scheduled Date:</span>
            <span className="detail-value">
              {scheduledDate
                ? moment(scheduledDate).format("YYYY-MM-DD HH:mm")
                : "Not Scheduled"}
            </span>
          </li>
          {assignedToName && (
            <li className="detail-item">
              <span className="detail-label">Assigned To:</span>
              <span className="detail-value">{assignedToName}</span>
            </li>
          )}
        </ul>

        {/* PDF viewer */}
        {pdfPath ? (
          <div className="view-card section-card">
            <h3 className="section-header">Work Order PDF</h3>
            {/* Use the /files resolver so it works with S3 or local */}
            <iframe
              src={fileUrl(pdfPath)}
              className="pdf-frame"
              title="Work Order PDF"
            />
            <div className="pdf-actions">
              <a
                href={fileUrl(pdfPath)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in new tab
              </a>
            </div>
          </div>
        ) : (
          <div className="section-card">
            <h3 className="section-header">Work Order PDF</h3>
            <em className="empty-text">No PDF attached.</em>
          </div>
        )}

        {/* Attachments (photos) */}
        <div className="section-card">
          <h3 className="section-header">Attachments</h3>

          {attachments.length ? (
            <div className="attachments">
              {attachments.map((relPath, i) => {
                const url = fileUrl(relPath);
                return (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                    <img src={url} alt={`attachment-${i}`} className="attachment-img" />
                  </a>
                );
              })}
            </div>
          ) : (
            <p className="empty-text">No attachments yet.</p>
          )}

          <div className="attachment-upload">
            <label className="upload-label">
              {uploading ? "Uploading…" : "Add photos"}
              <input
                type="file"
                multiple
                accept="image/*"
                onChange={handleAttachmentChange}
                disabled={uploading}
                style={{ display: "none" }}
              />
            </label>
          </div>
        </div>

        {/* Notes */}
        <div className="section-card">
          <h3 className="section-header">Notes</h3>

          <button
            className="toggle-note-btn"
            onClick={() => setShowNoteInput((v) => !v)}
          >
            {showNoteInput ? "Cancel" : "Add Note"}
          </button>

          {showNoteInput && (
            <div className="add-note">
              <textarea
                className="note-input"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Write your note here..."
                rows={3}
              />
              <button className="toggle-note-btn" onClick={handleAddNote}>
                Submit Note
              </button>
            </div>
          )}

          {notesArray.length > 0 ? (
            <ul className="notes-list">
              {notesArray.map((n, idx) => (
                <li key={idx} className="note-item">
                  <small className="note-timestamp">
                    {moment(n.createdAt).format("YYYY-MM-DD HH:mm")}
                  </small>
                  <p className="note-text">{n.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-text">No notes added.</p>
          )}
        </div>

        <button className="back-btn" onClick={() => navigate("/work-orders")}>
          ← Back to List
        </button>
      </div>
    </div>
  );
}
