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
import Customers from "./Customers";
import ViewCustomer from "./ViewCustomer";
import Estimates from "./Estimates";
import CreateEstimate from "./CreateEstimate";
import ViewEstimate from "./ViewEstimate";
import Invoices from "./Invoices";
import CreateInvoice from "./CreateInvoice";
import ViewInvoice from "./ViewInvoice";
import Reports from "./Reports";
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

            {/* Customers */}
            <Route
              path="/customers"
              element={
                <PrivateRoute>
                  <Customers />
                </PrivateRoute>
              }
            />
            <Route
              path="/customers/new"
              element={
                <PrivateRoute>
                  <ViewCustomer />
                </PrivateRoute>
              }
            />
            <Route
              path="/customers/:id"
              element={
                <PrivateRoute>
                  <ViewCustomer />
                </PrivateRoute>
              }
            />

            {/* Estimates */}
            <Route
              path="/estimates"
              element={
                <PrivateRoute>
                  <Estimates />
                </PrivateRoute>
              }
            />
            <Route
              path="/estimates/new"
              element={
                <PrivateRoute>
                  <CreateEstimate />
                </PrivateRoute>
              }
            />
            <Route
              path="/estimates/:id"
              element={
                <PrivateRoute>
                  <ViewEstimate />
                </PrivateRoute>
              }
            />
            <Route
              path="/estimates/:id/edit"
              element={
                <PrivateRoute>
                  <CreateEstimate />
                </PrivateRoute>
              }
            />

            {/* Invoices */}
            <Route
              path="/invoices"
              element={
                <PrivateRoute>
                  <Invoices />
                </PrivateRoute>
              }
            />
            <Route
              path="/invoices/new"
              element={
                <PrivateRoute>
                  <CreateInvoice />
                </PrivateRoute>
              }
            />
            <Route
              path="/invoices/:id"
              element={
                <PrivateRoute>
                  <ViewInvoice />
                </PrivateRoute>
              }
            />
            <Route
              path="/invoices/:id/edit"
              element={
                <PrivateRoute>
                  <CreateInvoice />
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

            {/* Reports */}
            <Route
              path="/reports"
              element={
                <PrivateRoute>
                  <Reports />
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
