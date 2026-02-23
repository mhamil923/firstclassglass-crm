// File: src/EmailTemplates.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api";
import "./EmailTemplates.css";

const MERGE_FIELDS = [
  "{{customerName}}",
  "{{projectName}}",
  "{{projectAddress}}",
  "{{poNumber}}",
  "{{total}}",
  "{{invoiceNumber}}",
  "{{shipToName}}",
  "{{shipToAddress}}",
  "{{issueDate}}",
  "{{dueDate}}",
  "{{balanceDue}}",
  "{{daysOverdue}}",
  "{{terms}}",
  "{{companyName}}",
  "{{companyPhone}}",
];

const TYPE_OPTIONS = [
  { value: "estimate", label: "Estimate" },
  { value: "invoice", label: "Invoice" },
  { value: "payment_reminder", label: "Payment Reminder" },
];

const TYPE_LABELS = {
  estimate: "Estimate",
  invoice: "Invoice",
  payment_reminder: "Payment Reminder",
};

export default function EmailTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'new' | template object
  const [form, setForm] = useState({ name: "", type: "estimate", subject: "", body: "", isDefault: false });
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/email-templates");
      setTemplates(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching email templates:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const openNew = () => {
    setEditing("new");
    setForm({ name: "", type: "estimate", subject: "", body: "", isDefault: false });
  };

  const openEdit = (tpl) => {
    setEditing(tpl);
    setForm({
      name: tpl.name || "",
      type: tpl.type || "estimate",
      subject: tpl.subject || "",
      body: tpl.body || "",
      isDefault: !!tpl.isDefault,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.subject.trim() || !form.body.trim()) {
      alert("Name, subject, and body are required.");
      return;
    }
    setSaving(true);
    try {
      if (editing === "new") {
        await api.post("/email-templates", form);
      } else {
        await api.put(`/email-templates/${editing.id}`, form);
      }
      setEditing(null);
      fetchTemplates();
    } catch (err) {
      console.error("Error saving template:", err);
      alert("Failed to save template.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this email template?")) return;
    try {
      await api.delete(`/email-templates/${id}`);
      if (editing && editing.id === id) setEditing(null);
      fetchTemplates();
    } catch (err) {
      console.error("Error deleting template:", err);
      alert("Failed to delete template.");
    }
  };

  const insertMergeField = (field) => {
    const textarea = bodyRef.current;
    if (!textarea) {
      setForm((f) => ({ ...f, body: f.body + field }));
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = form.body.substring(0, start);
    const after = form.body.substring(end);
    const newBody = before + field + after;
    setForm((f) => ({ ...f, body: newBody }));
    // Restore cursor position after React re-render
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + field.length, start + field.length);
    }, 0);
  };

  return (
    <div className="et-page">
      <div className="et-topbar">
        <h2 className="et-title">Email Templates</h2>
        <button className="et-btn et-btn-primary" onClick={openNew}>
          + Create Template
        </button>
      </div>

      {/* Template List */}
      <div className="et-table-wrap">
        {loading ? (
          <div className="et-empty">Loading...</div>
        ) : templates.length === 0 ? (
          <div className="et-empty">No email templates found.</div>
        ) : (
          <table className="et-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Subject</th>
                <th style={{ width: 140 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.name}
                    {t.isDefault ? (
                      <span className="et-badge et-badge-default">Default</span>
                    ) : null}
                  </td>
                  <td>
                    <span className={`et-badge et-badge-${t.type}`}>
                      {TYPE_LABELS[t.type] || t.type}
                    </span>
                  </td>
                  <td>
                    <span className="et-subject-preview">{t.subject}</span>
                  </td>
                  <td>
                    <div className="et-actions-cell">
                      <button
                        className="et-btn et-btn-secondary et-btn-sm"
                        onClick={() => openEdit(t)}
                      >
                        Edit
                      </button>
                      <button
                        className="et-btn et-btn-danger et-btn-sm"
                        onClick={() => handleDelete(t.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Editor */}
      {editing && (
        <div className="et-editor">
          <h3 className="et-editor-title">
            {editing === "new" ? "Create Template" : `Edit: ${editing.name}`}
          </h3>

          <div className="et-editor-row">
            <div className="et-editor-field">
              <label className="et-editor-label">Template Name</label>
              <input
                type="text"
                className="et-editor-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g., Estimate - Standard"
              />
            </div>
            <div className="et-editor-field" style={{ maxWidth: 220 }}>
              <label className="et-editor-label">Type</label>
              <select
                className="et-editor-input et-editor-select"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="et-editor-field" style={{ marginBottom: 16 }}>
            <label className="et-editor-label">Subject</label>
            <input
              type="text"
              className="et-editor-input"
              value={form.subject}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              placeholder="Email subject line..."
            />
          </div>

          <div className="et-editor-field">
            <label className="et-editor-label">Body</label>
            <div className="et-merge-chips">
              {MERGE_FIELDS.map((field) => (
                <span
                  key={field}
                  className="et-merge-chip"
                  onClick={() => insertMergeField(field)}
                  title={`Insert ${field}`}
                >
                  {field}
                </span>
              ))}
            </div>
            <textarea
              ref={bodyRef}
              className="et-editor-input et-editor-textarea"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder="Email body with merge fields..."
            />
          </div>

          <div className="et-editor-toggle">
            <input
              type="checkbox"
              id="et-default-toggle"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
            />
            <label htmlFor="et-default-toggle">Set as default template for this type</label>
          </div>

          <div className="et-editor-actions">
            <button className="et-btn et-btn-secondary" onClick={cancelEdit}>
              Cancel
            </button>
            {editing !== "new" && (
              <button
                className="et-btn et-btn-danger"
                onClick={() => handleDelete(editing.id)}
              >
                Delete
              </button>
            )}
            <button
              className="et-btn et-btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Template"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
