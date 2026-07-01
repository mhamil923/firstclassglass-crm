// File: src/App.js

import React, { Suspense } from "react";
import {
  BrowserRouter as Router,
  Route,
  Routes,
  Navigate
} from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
// Eager: needed for first paint / always rendered
import Home from "./Home";
import Login from "./Login";
import Navbar from "./Navbar";
import ErrorBoundary from "./ErrorBoundary";

// Lazy: heavier / not-first-viewed screens — each becomes its own chunk so the
// initial bundle only ships the landing page. Loaded on first navigation.
const WorkOrders = React.lazy(() => import("./WorkOrders"));
const AddWorkOrder = React.lazy(() => import("./AddWorkOrder"));
const ViewWorkOrder = React.lazy(() => import("./ViewWorkOrder"));
const CalendarPage = React.lazy(() => import("./CalendarPage"));
const HistoryReport = React.lazy(() => import("./HistoryReport"));
const PurchaseOrders = React.lazy(() => import("./PurchaseOrders"));
const Customers = React.lazy(() => import("./Customers"));
const ViewCustomer = React.lazy(() => import("./ViewCustomer"));
const ViewEstimate = React.lazy(() => import("./ViewEstimate"));
const ViewInvoice = React.lazy(() => import("./ViewInvoice"));
const Collections = React.lazy(() => import("./Collections"));
const SignContract = React.lazy(() => import("./SignContract"));
const EstimateResponse = React.lazy(() => import("./EstimateResponse"));
const Reports = React.lazy(() => import("./Reports"));
const RouteBuilder = React.lazy(() => import("./RouteBuilder"));
const LineItemTemplates = React.lazy(() => import("./LineItemTemplates"));
const PdfTemplates = React.lazy(() => import("./PdfTemplates"));
const PdfTemplateBuilder = React.lazy(() => import("./PdfTemplateBuilder"));
const PdfTemplateBuilderLegacy = React.lazy(() => import("./PdfTemplateBuilderLegacy"));
const CanvasTemplateEditor = React.lazy(() => import("./CanvasTemplateEditor"));
const EmailTemplates = React.lazy(() => import("./EmailTemplates"));
// Note: Bootstrap is imported in index.js before our custom styles

// Lightweight centered spinner shown while a lazy route chunk loads.
function PageSpinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
      <div
        style={{
          width: 36, height: 36, borderRadius: "50%",
          border: "3px solid var(--border-color)",
          borderTopColor: "var(--accent-blue)",
          animation: "fcg-spin 0.8s linear infinite",
        }}
      />
      <style>{`@keyframes fcg-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

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
          <ErrorBoundary>
          <Suspense fallback={<PageSpinner />}>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<Login />} />
            <Route path="/sign-contract/:token" element={<SignContract />} />
            <Route path="/estimate-response/:token" element={<EstimateResponse />} />

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
          </Suspense>
          </ErrorBoundary>
        </div>
      </Router>
    </ThemeProvider>
  );
}
