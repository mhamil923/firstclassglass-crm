// File: src/LineItemEditor.js
// Shared line item editor with template autocomplete and keyboard navigation.
// Used by both CreateEstimate.js and CreateInvoice.js.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import "./LineItemEditor.css";

function fmtMoney(val) {
  const n = Number(val);
  if (isNaN(n) || val === "" || val == null) return "";
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function LineItemEditor({ lineItems, setLineItems, nextTempId, cssPrefix }) {
  const p = cssPrefix; // shorthand

  // Template state
  const [templates, setTemplates] = useState([]);
  const [activeDropdown, setActiveDropdown] = useState(null); // tempId of open row
  const [dropdownIndex, setDropdownIndex] = useState(-1);

  // Refs for focus management — keyed by tempId
  const descRefs = useRef({});
  const amtRefs = useRef({});
  const rowRefs = useRef({});
  const pendingFocus = useRef(null);

  // Fetch templates once on mount
  useEffect(() => {
    api.get("/line-item-templates")
      .then((res) => setTemplates(res.data || []))
      .catch(() => {});
  }, []);

  // Focus new row's description after state update
  useEffect(() => {
    if (pendingFocus.current != null) {
      const tid = pendingFocus.current;
      pendingFocus.current = null;
      setTimeout(() => {
        if (descRefs.current[tid]) descRefs.current[tid].focus();
      }, 0);
    }
  }, [lineItems]);

  // Close dropdown on click outside
  useEffect(() => {
    const handler = (e) => {
      if (activeDropdown == null) return;
      const rowEl = rowRefs.current[activeDropdown];
      if (rowEl && !rowEl.contains(e.target)) {
        setActiveDropdown(null);
        setDropdownIndex(-1);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [activeDropdown]);

  // --- Line item CRUD ---
  const addLineItem = useCallback(() => {
    const newId = nextTempId.current++;
    setLineItems((prev) => [
      ...prev,
      { tempId: newId, description: "", quantity: "", amount: "", sortOrder: prev.length },
    ]);
    pendingFocus.current = newId;
    return newId;
  }, [setLineItems, nextTempId]);

  const updateLineItem = useCallback((tempId, field, value) => {
    setLineItems((prev) =>
      prev.map((li) => (li.tempId === tempId ? { ...li, [field]: value } : li))
    );
  }, [setLineItems]);

  const removeLineItem = useCallback((tempId) => {
    setLineItems((prev) => prev.filter((li) => li.tempId !== tempId));
  }, [setLineItems]);

  const moveLineItem = useCallback((index, direction) => {
    setLineItems((prev) => {
      const arr = [...prev];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= arr.length) return prev;
      [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
      return arr;
    });
  }, [setLineItems]);

  // --- Template filtering ---
  const getFilteredTemplates = useCallback((query) => {
    const q = (query || "").toLowerCase().trim();
    if (!q) return templates;
    return templates.filter((t) => t.description.toLowerCase().includes(q));
  }, [templates]);

  // --- Select a template ---
  const selectTemplate = useCallback((tempId, template) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        return {
          ...li,
          description: template.description,
          quantity: template.defaultQuantity != null ? String(template.defaultQuantity) : "",
          amount: template.defaultAmount != null ? String(template.defaultAmount) : "",
        };
      })
    );
    setActiveDropdown(null);
    setDropdownIndex(-1);
    // Focus amount field after selection
    setTimeout(() => {
      if (amtRefs.current[tempId]) amtRefs.current[tempId].focus();
    }, 0);
  }, [setLineItems]);

  // --- Save as template ---
  const saveAsTemplate = useCallback(async (li) => {
    try {
      const res = await api.post("/line-item-templates", {
        description: li.description.trim(),
        defaultQuantity: li.quantity ? Number(li.quantity) : 1,
        defaultAmount: li.amount ? Number(li.amount) : null,
      });
      setTemplates((prev) => [...prev, res.data]);
    } catch {
      // silently fail
    }
  }, []);

  // Check if description matches an existing template exactly
  const isExactMatch = useCallback((desc) => {
    if (!desc || !desc.trim()) return true; // empty = don't show save button
    const lower = desc.trim().toLowerCase();
    return templates.some((t) => t.description.toLowerCase() === lower);
  }, [templates]);

  // --- Keyboard handlers ---
  const handleDescKeyDown = useCallback((e, tempId, idx) => {
    const filtered = getFilteredTemplates(
      lineItems.find((li) => li.tempId === tempId)?.description
    );

    if (activeDropdown === tempId && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setDropdownIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setDropdownIndex((prev) => Math.max(prev - 1, -1));
        return;
      }
      if (e.key === "Enter" && dropdownIndex >= 0) {
        e.preventDefault();
        selectTemplate(tempId, filtered[dropdownIndex]);
        return;
      }
    }

    if (e.key === "Escape") {
      setActiveDropdown(null);
      setDropdownIndex(-1);
      return;
    }

    if (e.key === "Tab") {
      setActiveDropdown(null);
      setDropdownIndex(-1);
      // Let default tab go to amount field
      return;
    }

    // Backspace on empty row: remove and focus previous
    if (e.key === "Backspace") {
      const li = lineItems.find((l) => l.tempId === tempId);
      if (li && !li.description && !li.quantity && !li.amount && lineItems.length > 1) {
        e.preventDefault();
        const prevItem = idx > 0 ? lineItems[idx - 1] : null;
        removeLineItem(tempId);
        if (prevItem) {
          setTimeout(() => {
            if (amtRefs.current[prevItem.tempId]) amtRefs.current[prevItem.tempId].focus();
          }, 0);
        }
      }
    }
  }, [activeDropdown, dropdownIndex, getFilteredTemplates, lineItems, removeLineItem, selectTemplate]);

  const handleAmtKeyDown = useCallback((e, tempId, idx) => {
    // Tab on last row's amount field: add new row
    if (e.key === "Tab" && !e.shiftKey && idx === lineItems.length - 1) {
      e.preventDefault();
      addLineItem();
    }
  }, [lineItems.length, addLineItem]);

  // --- Highlight matching text in dropdown ---
  const highlightMatch = (text, query) => {
    if (!query || !query.trim()) return text;
    const q = query.trim();
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <span className="li-template-match">{text.slice(idx, idx + q.length)}</span>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <>
      {lineItems.length > 0 && (
        <div className={`${p}-li-header`}>
          <span>Qty</span>
          <span>Description</span>
          <span style={{ textAlign: "right" }}>Amount ($)</span>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )}

      {lineItems.map((li, idx) => {
        const filtered = activeDropdown === li.tempId
          ? getFilteredTemplates(li.description)
          : [];

        return (
          <div
            className={`${p}-li-row`}
            key={li.tempId}
            ref={(el) => { rowRefs.current[li.tempId] = el; }}
          >
            {/* Qty */}
            <input
              type="number"
              step="any"
              min="0"
              value={li.quantity}
              onChange={(e) => updateLineItem(li.tempId, "quantity", e.target.value)}
              className={`${p}-li-input`}
              placeholder="Qty"
            />

            {/* Description with autocomplete */}
            <div style={{ position: "relative" }}>
              <div className="li-desc-wrapper">
                <input
                  type="text"
                  value={li.description}
                  onChange={(e) => {
                    updateLineItem(li.tempId, "description", e.target.value);
                    setActiveDropdown(li.tempId);
                    setDropdownIndex(-1);
                  }}
                  onFocus={() => {
                    if (li.description) {
                      setActiveDropdown(li.tempId);
                      setDropdownIndex(-1);
                    }
                  }}
                  onKeyDown={(e) => handleDescKeyDown(e, li.tempId, idx)}
                  className={`${p}-li-input`}
                  placeholder="Description"
                  autoComplete="off"
                  ref={(el) => { descRefs.current[li.tempId] = el; }}
                />
                {/* Save as template icon */}
                {li.description && li.description.trim() && !isExactMatch(li.description) && (
                  <button
                    type="button"
                    className="li-save-template-btn"
                    onClick={() => saveAsTemplate(li)}
                    title="Save as template"
                  >
                    +
                  </button>
                )}
              </div>

              {/* Template autocomplete dropdown */}
              {activeDropdown === li.tempId && filtered.length > 0 && (
                <div className="li-template-dropdown">
                  {filtered.map((t, tIdx) => (
                    <div
                      key={t.id}
                      className={`li-template-option${tIdx === dropdownIndex ? " highlighted" : ""}`}
                      onMouseDown={() => selectTemplate(li.tempId, t)}
                      onMouseEnter={() => setDropdownIndex(tIdx)}
                    >
                      <span className="li-template-option-desc">
                        {highlightMatch(t.description, li.description)}
                      </span>
                      <span className="li-template-option-amount">
                        {t.defaultAmount != null ? fmtMoney(t.defaultAmount) : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Amount */}
            <input
              type="number"
              step="0.01"
              min="0"
              value={li.amount}
              onChange={(e) => updateLineItem(li.tempId, "amount", e.target.value)}
              onKeyDown={(e) => handleAmtKeyDown(e, li.tempId, idx)}
              className={`${p}-li-input`}
              placeholder="0.00"
              style={{ textAlign: "right" }}
              ref={(el) => { amtRefs.current[li.tempId] = el; }}
            />

            {/* Move up */}
            <button
              type="button"
              className={`${p}-li-btn`}
              onClick={() => moveLineItem(idx, -1)}
              disabled={idx === 0}
              title="Move up"
            >
              &#x25B2;
            </button>

            {/* Move down */}
            <button
              type="button"
              className={`${p}-li-btn`}
              onClick={() => moveLineItem(idx, 1)}
              disabled={idx === lineItems.length - 1}
              title="Move down"
            >
              &#x25BC;
            </button>

            {/* Remove */}
            <button
              type="button"
              className={`${p}-li-btn danger`}
              onClick={() => removeLineItem(li.tempId)}
              title="Remove"
            >
              &times;
            </button>
          </div>
        );
      })}

      <button type="button" className={`${p}-add-line`} onClick={addLineItem}>
        + Add Line Item
      </button>
    </>
  );
}
