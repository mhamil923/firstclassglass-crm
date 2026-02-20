// File: src/LineItemTemplates.js
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api";
import "./LineItemTemplates.css";

function fmtMoney(val) {
  const n = Number(val);
  if (isNaN(n) || val === "" || val == null) return "—";
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function LineItemTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const debounceRef = useRef(null);

  // Inline editing
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Add new template
  const [adding, setAdding] = useState(false);
  const [newTpl, setNewTpl] = useState({ description: "", defaultQuantity: "1", defaultAmount: "", category: "" });

  const fetchTemplates = useCallback(async (q) => {
    setLoading(true);
    try {
      const params = {};
      if (q && q.trim()) params.search = q.trim();
      const res = await api.get("/line-item-templates", { params });
      setTemplates(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching templates:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates("");
  }, [fetchTemplates]);

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchTemplates(val), 300);
  };

  // Edit
  const startEdit = (tpl) => {
    setEditingId(tpl.id);
    setEditForm({
      description: tpl.description || "",
      defaultQuantity: tpl.defaultQuantity != null ? String(tpl.defaultQuantity) : "",
      defaultAmount: tpl.defaultAmount != null ? String(tpl.defaultAmount) : "",
      category: tpl.category || "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({});
  };

  const saveEdit = async (id) => {
    if (!editForm.description.trim()) return;
    try {
      await api.put(`/line-item-templates/${id}`, {
        description: editForm.description.trim(),
        defaultQuantity: editForm.defaultQuantity ? Number(editForm.defaultQuantity) : null,
        defaultAmount: editForm.defaultAmount ? Number(editForm.defaultAmount) : null,
        category: editForm.category.trim() || null,
      });
      setEditingId(null);
      fetchTemplates(search);
    } catch (err) {
      console.error("Error saving template:", err);
      alert("Failed to save template.");
    }
  };

  const handleEditKeyDown = (e, id) => {
    if (e.key === "Enter") saveEdit(id);
    if (e.key === "Escape") cancelEdit();
  };

  // Delete
  const handleDelete = async (id) => {
    if (!window.confirm("Delete this template?")) return;
    try {
      await api.delete(`/line-item-templates/${id}`);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error("Error deleting template:", err);
      alert("Failed to delete template.");
    }
  };

  // Add
  const handleAdd = async () => {
    if (!newTpl.description.trim()) return;
    try {
      await api.post("/line-item-templates", {
        description: newTpl.description.trim(),
        defaultQuantity: newTpl.defaultQuantity ? Number(newTpl.defaultQuantity) : 1,
        defaultAmount: newTpl.defaultAmount ? Number(newTpl.defaultAmount) : null,
        category: newTpl.category.trim() || null,
      });
      setNewTpl({ description: "", defaultQuantity: "1", defaultAmount: "", category: "" });
      setAdding(false);
      fetchTemplates(search);
    } catch (err) {
      console.error("Error adding template:", err);
      alert("Failed to add template.");
    }
  };

  const handleAddKeyDown = (e) => {
    if (e.key === "Enter") handleAdd();
    if (e.key === "Escape") setAdding(false);
  };

  return (
    <div className="lit-page">
      <div className="lit-container">
        <div className="lit-header">
          <div>
            <h2 className="lit-title">Line Item Templates</h2>
            <div className="lit-subtitle">
              Manage saved templates that appear as autocomplete suggestions when adding line items.
            </div>
          </div>
          <div className="lit-actions">
            <button className="btn-primary-apple" onClick={() => setAdding(true)}>
              + Add Template
            </button>
          </div>
        </div>

        <div className="lit-card">
          <div className="lit-card-body">
            <div className="lit-search-wrap">
              <input
                type="text"
                className="lit-search-input"
                placeholder="Search templates..."
                value={search}
                onChange={handleSearchChange}
              />
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="lit-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th style={{ width: 80 }}>Qty</th>
                  <th style={{ width: 120, textAlign: "right" }}>Amount</th>
                  <th style={{ width: 140 }}>Category</th>
                  <th style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {/* Add new row */}
                {adding && (
                  <tr className="lit-edit-row">
                    <td>
                      <input
                        className="lit-inline-input"
                        value={newTpl.description}
                        onChange={(e) => setNewTpl({ ...newTpl, description: e.target.value })}
                        onKeyDown={handleAddKeyDown}
                        placeholder="Description"
                        autoFocus
                      />
                    </td>
                    <td>
                      <input
                        className="lit-inline-input"
                        type="number"
                        value={newTpl.defaultQuantity}
                        onChange={(e) => setNewTpl({ ...newTpl, defaultQuantity: e.target.value })}
                        onKeyDown={handleAddKeyDown}
                        placeholder="1"
                      />
                    </td>
                    <td>
                      <input
                        className="lit-inline-input"
                        type="number"
                        step="0.01"
                        value={newTpl.defaultAmount}
                        onChange={(e) => setNewTpl({ ...newTpl, defaultAmount: e.target.value })}
                        onKeyDown={handleAddKeyDown}
                        placeholder="0.00"
                        style={{ textAlign: "right" }}
                      />
                    </td>
                    <td>
                      <input
                        className="lit-inline-input"
                        value={newTpl.category}
                        onChange={(e) => setNewTpl({ ...newTpl, category: e.target.value })}
                        onKeyDown={handleAddKeyDown}
                        placeholder="Category"
                      />
                    </td>
                    <td>
                      <div className="lit-row-actions">
                        <button className="lit-action-btn save" onClick={handleAdd}>Save</button>
                        <button className="lit-action-btn" onClick={() => setAdding(false)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}

                {templates.length === 0 && !loading && !adding && (
                  <tr>
                    <td colSpan={5}>
                      <div className="lit-empty">
                        {search ? "No templates match your search." : "No templates yet. Add your first template to get started."}
                      </div>
                    </td>
                  </tr>
                )}

                {templates.map((tpl) => (
                  <tr key={tpl.id}>
                    {editingId === tpl.id ? (
                      <>
                        <td>
                          <input
                            className="lit-inline-input"
                            value={editForm.description}
                            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                            onKeyDown={(e) => handleEditKeyDown(e, tpl.id)}
                            autoFocus
                          />
                        </td>
                        <td>
                          <input
                            className="lit-inline-input"
                            type="number"
                            value={editForm.defaultQuantity}
                            onChange={(e) => setEditForm({ ...editForm, defaultQuantity: e.target.value })}
                            onKeyDown={(e) => handleEditKeyDown(e, tpl.id)}
                          />
                        </td>
                        <td>
                          <input
                            className="lit-inline-input"
                            type="number"
                            step="0.01"
                            value={editForm.defaultAmount}
                            onChange={(e) => setEditForm({ ...editForm, defaultAmount: e.target.value })}
                            onKeyDown={(e) => handleEditKeyDown(e, tpl.id)}
                            style={{ textAlign: "right" }}
                          />
                        </td>
                        <td>
                          <input
                            className="lit-inline-input"
                            value={editForm.category}
                            onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                            onKeyDown={(e) => handleEditKeyDown(e, tpl.id)}
                          />
                        </td>
                        <td>
                          <div className="lit-row-actions">
                            <button className="lit-action-btn save" onClick={() => saveEdit(tpl.id)}>Save</button>
                            <button className="lit-action-btn" onClick={cancelEdit}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <span className="lit-desc">{tpl.description}</span>
                        </td>
                        <td>{tpl.defaultQuantity != null ? tpl.defaultQuantity : "—"}</td>
                        <td style={{ textAlign: "right" }}>{fmtMoney(tpl.defaultAmount)}</td>
                        <td>
                          <span className="lit-category">{tpl.category || "—"}</span>
                        </td>
                        <td>
                          <div className="lit-row-actions">
                            <button className="lit-action-btn" onClick={() => startEdit(tpl)}>Edit</button>
                            <button className="lit-action-btn danger" onClick={() => handleDelete(tpl.id)}>Delete</button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {loading && (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              Loading...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
