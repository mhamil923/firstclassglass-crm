// File: src/Navbar.js

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link, NavLink, useNavigate, useLocation } from "react-router-dom";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import api from "./api";
import ThemeToggle from "./components/ThemeToggle";
import "./Navbar.css";

/* ========== NAV CONFIG ========== */
const NAV_ITEMS = [
  { id: "home", label: "Home", to: "/" },
  { id: "work-orders", label: "Work Orders", to: "/work-orders" },
  { id: "purchase-orders", label: "Purchase Orders", to: "/purchase-orders" },
  // Calendar promoted out of the old "Planning" dropdown into the slot Planning
  // occupied; Route Builder (its only other child) moved into Records.
  { id: "calendar", label: "Calendar", to: "/calendar" },
  {
    id: "records",
    label: "Records",
    children: [
      // "History" lives in the navbar search box (Enter → /history?q=…), not here.
      // Collections, Email Templates and Route Builder demoted from top level.
      // Every route below is unchanged — only where the link lives moved.
      { label: "Customers", to: "/customers" },
      { label: "Reports", to: "/reports" },
      { label: "Collections", to: "/collections" },
      { label: "Email Templates", to: "/email-templates" },
      { label: "Route Builder", to: "/route-builder" },
    ],
  },
];

const NAV_ITEMS_MAP = new Map(NAV_ITEMS.map((i) => [i.id, i]));
const DEFAULT_ORDER = NAV_ITEMS.map((i) => i.id);
const STORAGE_KEY = "navbar-order";

function loadNavOrder() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ORDER;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== DEFAULT_ORDER.length) return DEFAULT_ORDER;
    // Validate all IDs exist
    const valid = parsed.every((id) => NAV_ITEMS_MAP.has(id));
    return valid ? parsed : DEFAULT_ORDER;
  } catch {
    return DEFAULT_ORDER;
  }
}

function saveNavOrder(order) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
}

/* ========== Sortable Nav Item (DnD) ========== */
const DND_TYPE = "nav-order-item";

function SortableNavItem({ id, label, index, moveItem }) {
  const ref = useRef(null);

  const [{ isDragging }, drag, preview] = useDrag({
    type: DND_TYPE,
    item: { id, index },
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const [, drop] = useDrop({
    accept: DND_TYPE,
    hover(item, monitor) {
      if (!ref.current) return;
      const dragIndex = item.index;
      const hoverIndex = index;
      if (dragIndex === hoverIndex) return;

      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = clientOffset.y - hoverBoundingRect.top;

      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) return;
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) return;

      moveItem(dragIndex, hoverIndex);
      item.index = hoverIndex;
    },
  });

  preview(drop(ref));

  return (
    <div
      ref={ref}
      className={`settings-nav-order-item${isDragging ? " dragging" : ""}`}
    >
      <span ref={drag} className="settings-nav-order-grip" title="Drag to reorder">
        ⠿
      </span>
      <span className="settings-nav-order-label">{label}</span>
    </div>
  );
}

/* ========== Settings Modal ========== */
function SettingsModal({ onClose, navOrder, onNavOrderChange }) {
  const [nextInvoiceNumber, setNextInvoiceNumber] = useState("");
  const [defaultInvoiceTerms, setDefaultInvoiceTerms] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [localOrder, setLocalOrder] = useState(navOrder);

  // Email settings
  const [emailSettings, setEmailSettings] = useState({
    senderEmail: "", senderPassword: "", senderName: "", replyTo: "",
    stripePublishableKey: "", stripeSecretKey: "", stripeWebhookSecret: "",
    stripeEnabled: false, appPublicUrl: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showStripeSecret, setShowStripeSecret] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailTestResult, setEmailTestResult] = useState("");

  // Line item templates
  const [templates, setTemplates] = useState([]);
  const [editingTpl, setEditingTpl] = useState(null); // id of template being edited
  const [editForm, setEditForm] = useState({});
  const [addingTpl, setAddingTpl] = useState(false);
  const [newTpl, setNewTpl] = useState({ description: "", defaultQuantity: "1", defaultAmount: "", category: "" });

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, tplRes, emailRes] = await Promise.all([
        api.get("/settings"),
        api.get("/line-item-templates"),
        api.get("/email-settings").catch(() => ({ data: {} })),
      ]);
      const s = settingsRes.data || {};
      setNextInvoiceNumber(s.nextInvoiceNumber || "1");
      setDefaultInvoiceTerms(s.defaultInvoiceTerms || "");
      setTemplates(tplRes.data || []);
      const es = emailRes.data || {};
      setEmailSettings({
        senderEmail: es.senderEmail || "",
        senderPassword: es.senderPassword || "",
        senderName: es.senderName || "",
        replyTo: es.replyTo || "",
        stripePublishableKey: es.stripePublishableKey || "",
        stripeSecretKey: es.stripeSecretKey || "",
        stripeWebhookSecret: es.stripeWebhookSecret || "",
        stripeEnabled: !!es.stripeEnabled,
        appPublicUrl: es.appPublicUrl || "",
      });
    } catch (err) {
      console.error("Error fetching settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleEditTpl = (tpl) => {
    setEditingTpl(tpl.id);
    setEditForm({
      description: tpl.description,
      defaultQuantity: tpl.defaultQuantity != null ? String(tpl.defaultQuantity) : "",
      defaultAmount: tpl.defaultAmount != null ? String(tpl.defaultAmount) : "",
      category: tpl.category || "",
    });
  };

  const handleSaveTpl = async (id) => {
    try {
      await api.put(`/line-item-templates/${id}`, {
        description: editForm.description,
        defaultQuantity: editForm.defaultQuantity ? Number(editForm.defaultQuantity) : null,
        defaultAmount: editForm.defaultAmount ? Number(editForm.defaultAmount) : null,
        category: editForm.category || null,
      });
      setEditingTpl(null);
      const res = await api.get("/line-item-templates");
      setTemplates(res.data || []);
    } catch (err) {
      console.error("Error saving template:", err);
    }
  };

  const handleDeleteTpl = async (id) => {
    if (!window.confirm("Delete this template?")) return;
    try {
      await api.delete(`/line-item-templates/${id}`);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error("Error deleting template:", err);
    }
  };

  const handleAddTpl = async () => {
    if (!newTpl.description.trim()) return;
    try {
      const res = await api.post("/line-item-templates", {
        description: newTpl.description.trim(),
        defaultQuantity: newTpl.defaultQuantity ? Number(newTpl.defaultQuantity) : 1,
        defaultAmount: newTpl.defaultAmount ? Number(newTpl.defaultAmount) : null,
        category: newTpl.category.trim() || null,
      });
      setTemplates((prev) => [...prev, res.data]);
      setNewTpl({ description: "", defaultQuantity: "1", defaultAmount: "", category: "" });
      setAddingTpl(false);
    } catch (err) {
      console.error("Error adding template:", err);
    }
  };

  const moveItem = useCallback((fromIndex, toIndex) => {
    setLocalOrder((prev) => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  }, []);

  const handleResetOrder = () => {
    setLocalOrder(DEFAULT_ORDER);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        api.put("/settings", { nextInvoiceNumber, defaultInvoiceTerms }),
        api.put("/email-settings", emailSettings),
      ]);
      saveNavOrder(localOrder);
      onNavOrderChange(localOrder);
      onClose();
    } catch (err) {
      console.error("Error saving settings:", err);
      alert("Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    setEmailTestResult("");
    try {
      // Save email settings first
      await api.put("/email-settings", emailSettings);
      const res = await api.post("/email-settings/test");
      setEmailTestResult(res.data.message || "Test email sent!");
    } catch (err) {
      setEmailTestResult(err.response?.data?.error || "Failed to send test email.");
    } finally {
      setTestingEmail(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="settings-modal-title">Settings</h3>

        {loading ? (
          <p style={{ color: "var(--text-tertiary)", fontSize: 14 }}>Loading...</p>
        ) : (
          <>
            <div className="settings-field">
              <label className="settings-label">Next Invoice Number</label>
              <input
                className="settings-input"
                value={nextInvoiceNumber}
                onChange={(e) => setNextInvoiceNumber(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label className="settings-label">Default Payment Terms</label>
              <textarea
                className="settings-input settings-textarea"
                value={defaultInvoiceTerms}
                onChange={(e) => setDefaultInvoiceTerms(e.target.value)}
                rows={4}
              />
            </div>

            <div className="settings-divider" />

            {/* Email Configuration */}
            <div className="settings-field">
              <label className="settings-label">Email Configuration</label>
              <p className="settings-hint">
                Configure Yahoo Mail to send estimates, invoices, and payment reminders.
                You need a Yahoo App Password (Account Settings → Security → Generate App Password).
              </p>
            </div>

            <div className="settings-field">
              <label className="settings-label" style={{ fontSize: 11 }}>Yahoo Email Address</label>
              <input
                className="settings-input"
                type="email"
                value={emailSettings.senderEmail}
                onChange={(e) => setEmailSettings((s) => ({ ...s, senderEmail: e.target.value }))}
                placeholder="youremail@yahoo.com"
              />
            </div>

            <div className="settings-field">
              <label className="settings-label" style={{ fontSize: 11 }}>App Password</label>
              <div style={{ position: "relative" }}>
                <input
                  className="settings-input"
                  type={showPassword ? "text" : "password"}
                  value={emailSettings.senderPassword}
                  onChange={(e) => setEmailSettings((s) => ({ ...s, senderPassword: e.target.value }))}
                  placeholder="Yahoo app password"
                  style={{ paddingRight: 60 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", color: "var(--accent-blue)",
                    cursor: "pointer", fontSize: 12, fontWeight: 600
                  }}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div className="settings-field">
              <label className="settings-label" style={{ fontSize: 11 }}>Sender Display Name</label>
              <input
                className="settings-input"
                value={emailSettings.senderName}
                onChange={(e) => setEmailSettings((s) => ({ ...s, senderName: e.target.value }))}
                placeholder="First Class Glass & Mirror, Inc."
              />
            </div>

            <div className="settings-field">
              <label className="settings-label" style={{ fontSize: 11 }}>Reply-To Email (optional)</label>
              <input
                className="settings-input"
                type="email"
                value={emailSettings.replyTo}
                onChange={(e) => setEmailSettings((s) => ({ ...s, replyTo: e.target.value }))}
                placeholder="Leave blank to use sender email"
              />
            </div>

            <div className="settings-field">
              <button
                type="button"
                className="settings-btn-test"
                onClick={handleTestEmail}
                disabled={testingEmail || !emailSettings.senderEmail || !emailSettings.senderPassword}
                style={{
                  padding: "8px 16px", borderRadius: 8, border: "1px solid var(--border-color-strong)",
                  background: "var(--bg-secondary)", color: "var(--text-primary)", cursor: "pointer",
                  fontSize: 13, fontWeight: 600, transition: "var(--transition-fast)",
                  opacity: (testingEmail || !emailSettings.senderEmail || !emailSettings.senderPassword) ? 0.5 : 1
                }}
              >
                {testingEmail ? "Testing..." : "Test Connection"}
              </button>
              {emailTestResult && (
                <span style={{
                  marginLeft: 12, fontSize: 13, fontWeight: 500,
                  color: emailTestResult.includes("success") || emailTestResult.includes("sent") ? "var(--accent-green)" : "var(--accent-red)"
                }}>
                  {emailTestResult}
                </span>
              )}
            </div>

            <div className="settings-divider" />

            {/* Stripe Payment Configuration */}
            <div className="settings-field">
              <label className="settings-label">Stripe Payment Configuration</label>
              <p className="settings-hint">
                Enable online payments for invoices via Stripe. Get your API keys at{" "}
                <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-blue)" }}>
                  dashboard.stripe.com/apikeys
                </a>
              </p>
            </div>

            <div className="settings-field">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                <input
                  type="checkbox"
                  checked={emailSettings.stripeEnabled}
                  onChange={(e) => setEmailSettings((s) => ({ ...s, stripeEnabled: e.target.checked }))}
                  style={{ width: 16, height: 16, accentColor: "var(--accent-blue)" }}
                />
                Enable Stripe Payments
              </label>
            </div>

            {emailSettings.stripeEnabled && (
              <>
                <div className="settings-field">
                  <label className="settings-label" style={{ fontSize: 11 }}>Publishable Key</label>
                  <input
                    className="settings-input"
                    value={emailSettings.stripePublishableKey}
                    onChange={(e) => setEmailSettings((s) => ({ ...s, stripePublishableKey: e.target.value }))}
                    placeholder="pk_test_... or pk_live_..."
                  />
                </div>

                <div className="settings-field">
                  <label className="settings-label" style={{ fontSize: 11 }}>Secret Key</label>
                  <div style={{ position: "relative" }}>
                    <input
                      className="settings-input"
                      type={showStripeSecret ? "text" : "password"}
                      value={emailSettings.stripeSecretKey}
                      onChange={(e) => setEmailSettings((s) => ({ ...s, stripeSecretKey: e.target.value }))}
                      placeholder="sk_test_... or sk_live_..."
                      style={{ paddingRight: 60 }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowStripeSecret(!showStripeSecret)}
                      style={{
                        position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                        background: "none", border: "none", color: "var(--accent-blue)",
                        cursor: "pointer", fontSize: 12, fontWeight: 600
                      }}
                    >
                      {showStripeSecret ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <div className="settings-field">
                  <label className="settings-label" style={{ fontSize: 11 }}>Webhook Secret (optional)</label>
                  <input
                    className="settings-input"
                    type="password"
                    value={emailSettings.stripeWebhookSecret}
                    onChange={(e) => setEmailSettings((s) => ({ ...s, stripeWebhookSecret: e.target.value }))}
                    placeholder="whsec_..."
                  />
                  <p className="settings-hint" style={{ marginTop: 4 }}>
                    Set up a webhook at dashboard.stripe.com/webhooks pointing to your backend URL + /api/stripe/webhook
                  </p>
                </div>

                <div className="settings-field">
                  <label className="settings-label" style={{ fontSize: 11 }}>Backend Public URL</label>
                  <input
                    className="settings-input"
                    value={emailSettings.appPublicUrl}
                    onChange={(e) => setEmailSettings((s) => ({ ...s, appPublicUrl: e.target.value }))}
                    placeholder="https://your-app.elasticbeanstalk.com"
                  />
                  <p className="settings-hint" style={{ marginTop: 4 }}>
                    The public URL where customers access estimate review and invoice payment pages.
                  </p>
                </div>
              </>
            )}

            <div className="settings-divider" />

            {/* Line Item Templates */}
            <div className="settings-field">
              <label className="settings-label">Line Item Templates</label>
              <p className="settings-hint">Saved templates appear as autocomplete suggestions when adding line items.</p>
              <div className="settings-tpl-table">
                <div className="settings-tpl-header">
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Amount</span>
                  <span>Category</span>
                  <span></span>
                </div>
                {templates.map((tpl) => (
                  <div className="settings-tpl-row" key={tpl.id}>
                    {editingTpl === tpl.id ? (
                      <>
                        <input className="settings-input settings-tpl-input" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                        <input className="settings-input settings-tpl-input" type="number" value={editForm.defaultQuantity} onChange={(e) => setEditForm({ ...editForm, defaultQuantity: e.target.value })} />
                        <input className="settings-input settings-tpl-input" type="number" step="0.01" value={editForm.defaultAmount} onChange={(e) => setEditForm({ ...editForm, defaultAmount: e.target.value })} />
                        <input className="settings-input settings-tpl-input" value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} />
                        <div className="settings-tpl-actions">
                          <button type="button" className="settings-tpl-action-btn" onClick={() => handleSaveTpl(tpl.id)} title="Save">Save</button>
                          <button type="button" className="settings-tpl-action-btn" onClick={() => setEditingTpl(null)} title="Cancel">Cancel</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="settings-tpl-desc">{tpl.description}</span>
                        <span className="settings-tpl-qty">{tpl.defaultQuantity != null ? tpl.defaultQuantity : "—"}</span>
                        <span className="settings-tpl-amt">{tpl.defaultAmount != null ? "$" + Number(tpl.defaultAmount).toFixed(2) : "—"}</span>
                        <span className="settings-tpl-cat">{tpl.category || "—"}</span>
                        <div className="settings-tpl-actions">
                          <button type="button" className="settings-tpl-action-btn" onClick={() => handleEditTpl(tpl)} title="Edit">Edit</button>
                          <button type="button" className="settings-tpl-action-btn danger" onClick={() => handleDeleteTpl(tpl.id)} title="Delete">Del</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}

                {addingTpl ? (
                  <div className="settings-tpl-row">
                    <input className="settings-input settings-tpl-input" placeholder="Description" value={newTpl.description} onChange={(e) => setNewTpl({ ...newTpl, description: e.target.value })} />
                    <input className="settings-input settings-tpl-input" type="number" placeholder="Qty" value={newTpl.defaultQuantity} onChange={(e) => setNewTpl({ ...newTpl, defaultQuantity: e.target.value })} />
                    <input className="settings-input settings-tpl-input" type="number" step="0.01" placeholder="Amount" value={newTpl.defaultAmount} onChange={(e) => setNewTpl({ ...newTpl, defaultAmount: e.target.value })} />
                    <input className="settings-input settings-tpl-input" placeholder="Category" value={newTpl.category} onChange={(e) => setNewTpl({ ...newTpl, category: e.target.value })} />
                    <div className="settings-tpl-actions">
                      <button type="button" className="settings-tpl-action-btn" onClick={handleAddTpl}>Add</button>
                      <button type="button" className="settings-tpl-action-btn" onClick={() => setAddingTpl(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="settings-tpl-add-btn"
                    onClick={() => setAddingTpl(true)}
                  >
                    + Add Template
                  </button>
                )}
              </div>
            </div>

            <div className="settings-divider" />

            <div className="settings-field">
              <div className="settings-label-row">
                <label className="settings-label">Navbar Order</label>
                <button
                  type="button"
                  className="settings-reset-link"
                  onClick={handleResetOrder}
                >
                  Reset to Default
                </button>
              </div>
              <p className="settings-hint">Drag items to reorder the navigation bar.</p>
              <DndProvider backend={HTML5Backend}>
                <div className="settings-nav-order">
                  {localOrder.map((id, index) => {
                    const item = NAV_ITEMS_MAP.get(id);
                    if (!item) return null;
                    return (
                      <SortableNavItem
                        key={id}
                        id={id}
                        label={item.label}
                        index={index}
                        moveItem={moveItem}
                      />
                    );
                  })}
                </div>
              </DndProvider>
            </div>

            <div className="settings-actions">
              <button
                className="settings-btn settings-btn-secondary"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="settings-btn settings-btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ========== Main Navbar ========== */
export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null);
  const [navOrder, setNavOrder] = useState(loadNavOrder);
  const navRef = useRef(null);

  const currentPath = location.pathname;

  // Close dropdown on click outside
  useEffect(() => {
    if (!openDropdown) return;
    const handleClick = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openDropdown]);

  // Close dropdown on route change
  useEffect(() => {
    setOpenDropdown(null);
  }, [currentPath]);

  const handleLogout = () => {
    localStorage.removeItem("jwt");
    navigate("/login");
  };

  const toggleNavbar = () => {
    setIsOpen(!isOpen);
  };

  const closeNavbar = () => {
    setIsOpen(false);
    setOpenDropdown(null);
  };

  const toggleDropdown = (id) => {
    setOpenDropdown((prev) => (prev === id ? null : id));
  };

  /* ===== Global History search ===== */
  const [navSearch, setNavSearch] = useState("");
  // Between 1025-1200px the navbar has literally zero spare horizontal space,
  // so the input collapses to an icon there and expands as an overlay on click
  // (absolutely positioned, so expanding never reflows the bar). Above 1200px
  // and in the ≤1024px stacked layout the input is always visible and this
  // flag is inert.
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef(null);

  const openSearch = () => {
    setSearchExpanded(true);
    // focus after the CSS transition starts so the caret lands correctly
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // Keep the box showing whatever History is currently filtered by, so the two
  // never disagree. Only tracks the URL — clearing with Escape sticks until the
  // next navigation.
  useEffect(() => {
    if (currentPath === "/history") {
      const q = new URLSearchParams(location.search).get("q") || "";
      setNavSearch(q);
    }
  }, [currentPath, location.search]);

  const submitNavSearch = (e) => {
    e.preventDefault();
    const q = navSearch.trim();
    // Already on History? Replace, so repeated searches don't pile up history
    // entries the Back button has to chew through.
    const replace = currentPath === "/history";
    navigate(q ? `/history?q=${encodeURIComponent(q)}` : "/history", { replace });
    setSearchExpanded(false);
    closeNavbar();
  };

  const onNavSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setNavSearch("");
      setSearchExpanded(false);
      e.currentTarget.blur();
    }
  };

  const orderedItems = useMemo(
    () => navOrder.map((id) => NAV_ITEMS_MAP.get(id)).filter(Boolean),
    [navOrder]
  );

  const isDropdownActive = useCallback(
    (item) => {
      if (!item.children) return false;
      return item.children.some(
        (c) => c.to === currentPath || (c.to !== "/" && currentPath.startsWith(c.to))
      );
    },
    [currentPath]
  );

  return (
    <nav className="navbar navbar-expand-lg" ref={navRef}>
      <Link className="navbar-brand" to="/">
        First Class Glass CRM
      </Link>

      <button
        className="navbar-toggler"
        type="button"
        onClick={toggleNavbar}
        aria-label="Toggle navigation"
      >
        <span className="navbar-toggler-icon"></span>
      </button>

      <div className={`navbar-collapse ${isOpen ? "show" : ""}`}>
        <ul className="navbar-nav">
          {orderedItems.map((item) =>
            item.children ? (
              <li key={item.id} className="nav-item nav-dropdown">
                <button
                  className={`nav-link nav-dropdown-toggle${
                    isDropdownActive(item) ? " active" : ""
                  }`}
                  onClick={() => toggleDropdown(item.id)}
                >
                  {item.label}
                  <span className="nav-dropdown-arrow">▾</span>
                </button>
                {openDropdown === item.id && (
                  <div className="nav-dropdown-menu">
                    {item.children.map((child) => (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        className={({ isActive }) =>
                          `nav-dropdown-item${isActive ? " active" : ""}`
                        }
                        onClick={closeNavbar}
                        end={child.to === "/"}
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
                {/* Mobile accordion: always render, toggled via CSS + state */}
                <div
                  className={`nav-dropdown-accordion${
                    openDropdown === item.id ? " open" : ""
                  }`}
                >
                  {item.children.map((child) => (
                    <NavLink
                      key={child.to}
                      to={child.to}
                      className={({ isActive }) =>
                        `nav-dropdown-accordion-item${isActive ? " active" : ""}`
                      }
                      onClick={closeNavbar}
                      end={child.to === "/"}
                    >
                      {child.label}
                    </NavLink>
                  ))}
                </div>
              </li>
            ) : (
              <li key={item.id} className="nav-item">
                <NavLink
                  className="nav-link"
                  to={item.to}
                  end={item.to === "/"}
                  onClick={closeNavbar}
                >
                  {item.label}
                </NavLink>
              </li>
            )
          )}
        </ul>

        {/* Global work-order search — Enter jumps to History with the query.
            Deliberately Enter-to-search only (no live results): every keystroke
            would refetch the whole work-order list. */}
        <form
          className={`navbar-search${searchExpanded ? " expanded" : ""}`}
          onSubmit={submitNavSearch}
          role="search"
        >
          {/* Icon is decorative when the input is inline; at the cramped
              breakpoint CSS turns it into the button that expands the field. */}
          <button
            type="button"
            className="navbar-search-icon-btn"
            onClick={openSearch}
            aria-label="Search work orders"
            tabIndex={-1}
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a1 1 0 01-1.414 1.414l-3.329-3.328A7 7 0 012 9z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <input
            ref={searchInputRef}
            type="search"
            className="navbar-search-input"
            placeholder="Search work orders…"
            aria-label="Search work orders"
            value={navSearch}
            onChange={(e) => setNavSearch(e.target.value)}
            onKeyDown={onNavSearchKeyDown}
            onBlur={() => { if (!navSearch.trim()) setSearchExpanded(false); }}
          />
        </form>

        <div className="navbar-right">
          <button
            className="settings-gear-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <ThemeToggle />
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          navOrder={navOrder}
          onNavOrderChange={setNavOrder}
        />
      )}
    </nav>
  );
}
