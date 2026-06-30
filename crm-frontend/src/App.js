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
import ViewEstimate from "./ViewEstimate";
import ViewInvoice from "./ViewInvoice";
import Collections from "./Collections";
import SignContract from "./SignContract";
import Reports from "./Reports";
import RouteBuilder from "./RouteBuilder";
import LineItemTemplates from "./LineItemTemplates";
import PdfTemplates from "./PdfTemplates";
import PdfTemplateBuilder from "./PdfTemplateBuilder";
import PdfTemplateBuilderLegacy from "./PdfTemplateBuilderLegacy";
import CanvasTemplateEditor from "./CanvasTemplateEditor";
import EmailTemplates from "./EmailTemplates";
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
            <Route path="/sign-contract/:token" element={<SignContract />} />

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

            {/* Collections / payment reminders (creation is done in QuickBooks) */}
            <Route
              path="/collections"
              element={
                <PrivateRoute>
                  <Collections />
                </PrivateRoute>
              }
            />

            {/* Estimates — VIEW only (standalone list/create pages retired; creation in QuickBooks).
                Kept because ViewWorkOrder links to /estimates/:id for CRM-created estimates. */}
            <Route
              path="/estimates/:id"
              element={
                <PrivateRoute>
                  <ViewEstimate />
                </PrivateRoute>
              }
            />

            {/* Invoices — VIEW only (standalone list/create pages retired; creation in QuickBooks).
                Kept because ViewWorkOrder + Collections "Open" link to /invoices/:id. */}
            <Route
              path="/invoices/:id"
              element={
                <PrivateRoute>
                  <ViewInvoice />
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

            {/* Line Item Templates */}
            <Route
              path="/line-item-templates"
              element={
                <PrivateRoute>
                  <LineItemTemplates />
                </PrivateRoute>
              }
            />

            {/* PDF Templates */}
            <Route
              path="/pdf-templates"
              element={
                <PrivateRoute>
                  <PdfTemplates />
                </PrivateRoute>
              }
            />
            <Route
              path="/pdf-templates/new"
              element={
                <PrivateRoute>
                  <PdfTemplateBuilder />
                </PrivateRoute>
              }
            />
            <Route
              path="/pdf-templates/canvas/new"
              element={
                <PrivateRoute>
                  <CanvasTemplateEditor />
                </PrivateRoute>
              }
            />
            <Route
              path="/pdf-templates/canvas/:id"
              element={
                <PrivateRoute>
                  <CanvasTemplateEditor />
                </PrivateRoute>
              }
            />
            <Route
              path="/pdf-templates/legacy/:id"
              element={
                <PrivateRoute>
                  <PdfTemplateBuilderLegacy />
                </PrivateRoute>
              }
            />
            <Route
              path="/pdf-templates/:id"
              element={
                <PrivateRoute>
                  <PdfTemplateBuilder />
                </PrivateRoute>
              }
            />
            <Route
              path="/email-templates"
              element={
                <PrivateRoute>
                  <EmailTemplates />
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

            {/* Route Builder */}
            <Route
              path="/route-builder"
              element={
                <PrivateRoute>
                  <RouteBuilder />
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
