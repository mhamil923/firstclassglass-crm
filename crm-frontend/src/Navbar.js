// File: src/Navbar.js

import React, { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import ThemeToggle from "./components/ThemeToggle";
import "./Navbar.css";

export default function Navbar() {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);

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
        </ul>

        <div className="navbar-right">
          <ThemeToggle />
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
