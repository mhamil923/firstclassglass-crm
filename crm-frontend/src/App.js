// File: src/App.js

import React from "react";
import {
  BrowserRouter as Router,
  Route,
  Routes,
  Navigate
} from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./Home";
import WorkOrders from "./WorkOrders";
import AddWorkOrder from "./AddWorkOrder";
import ViewWorkOrder from "./ViewWorkOrder";
import CalendarPage from "./CalendarPage";
import HistoryReport from "./HistoryReport";   // ← existing
import Login from "./Login";
import Navbar from "./Navbar";
import PurchaseOrders from "./PurchaseOrders"; // ← NEW import
// Note: Bootstrap is imported in index.js before our custom styles

// A wrapper for protecting routes
function PrivateRoute({ children }) {
  const token = localStorage.getItem("jwt");
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <ThemeProvider>
      <Router>
        {/* Render Navbar on all pages */}
        <Navbar />

        <div className="app-content">
          <Routes>
            {/* Public */}
            <Route path="/login" element={<Login />} />

            {/* Protected */}
            <Route
              path="/"
              element={
                <PrivateRoute>
                  <Home />
                </PrivateRoute>
              }
            />
            <Route
              path="/work-orders"
              element={
                <PrivateRoute>
                  <WorkOrders />
                </PrivateRoute>
              }
            />
            <Route
              path="/add-work-order"
              element={
                <PrivateRoute>
                  <AddWorkOrder />
                </PrivateRoute>
              }
            />
            <Route
              path="/view-work-order/:id"
              element={
                <PrivateRoute>
                  <ViewWorkOrder />
                </PrivateRoute>
              }
            />
            <Route
              path="/calendar"
              element={
                <PrivateRoute>
                  <CalendarPage />
                </PrivateRoute>
              }
            />
            <Route
              path="/history"
              element={
                <PrivateRoute>
                  <HistoryReport />
                </PrivateRoute>
              }
            />

            {/* NEW: Purchase Orders tab */}
            <Route
              path="/purchase-orders"
              element={
                <PrivateRoute>
                  <PurchaseOrders />
                </PrivateRoute>
              }
            />

            {/* Catch-all redirect */}
            <Route
              path="*"
              element={
                localStorage.getItem("jwt") ? (
                  <Navigate to="/" replace />
                ) : (
                  <Navigate to="/login" replace />
                )
              }
            />
          </Routes>
        </div>
      </Router>
    </ThemeProvider>
  );
}
