// File: src/Navbar.js

import React, { useState, useEffect, useCallback } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import api from "./api";
import ThemeToggle from "./components/ThemeToggle";
import "./Navbar.css";

/* ========== Settings Modal ========== */
function SettingsModal({ onClose }) {
  const [nextInvoiceNumber, setNextInvoiceNumber] = useState("");
  const [defaultInvoiceTerms, setDefaultInvoiceTerms] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/settings");
      const s = res.data || {};
      setNextInvoiceNumber(s.nextInvoiceNumber || "1");
      setDefaultInvoiceTerms(s.defaultInvoiceTerms || "");
    } catch (err) {
      console.error("Error fetching settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put("/settings", { nextInvoiceNumber, defaultInvoiceTerms });
      onClose();
    } catch (err) {
      console.error("Error saving settings:", err);
      alert("Failed to save settings.");
    } finally {
      setSaving(false);
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

            <div className="settings-actions">
              <button className="settings-btn settings-btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button className="settings-btn settings-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Navbar() {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const handleLogout = () => {
    localStorage.removeItem("jwt");
    navigate("/login");
  };

  const toggleNavbar = () => {
    setIsOpen(!isOpen);
  };

  // Close navbar when a link is clicked (mobile)
  const closeNavbar = () => {
    setIsOpen(false);
  };

  return (
    <nav className="navbar navbar-expand-lg">
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
          <li className="nav-item">
            <NavLink className="nav-link" to="/" end onClick={closeNavbar}>
              Home
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/work-orders" onClick={closeNavbar}>
              Work Orders
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/customers" onClick={closeNavbar}>
              Customers
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/estimates" onClick={closeNavbar}>
              Estimates
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/invoices" onClick={closeNavbar}>
              Invoices
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/calendar" onClick={closeNavbar}>
              Calendar
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/purchase-orders" onClick={closeNavbar}>
              Purchase Orders
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/history" onClick={closeNavbar}>
              History
            </NavLink>
          </li>

          <li className="nav-item">
            <NavLink className="nav-link" to="/reports" onClick={closeNavbar}>
              Reports
            </NavLink>
          </li>
        </ul>

        <div className="navbar-right">
          <button
            className="settings-gear-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
          </button>
          <ThemeToggle />
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </nav>
  );
}
