// File: src/App.js

import React from "react";
import {
  BrowserRouter as Router,
  Route,
  Routes,
  Navigate
} from "react-router-dom";
import Home from "./Home";
import WorkOrders from "./WorkOrders";
import AddWorkOrder from "./AddWorkOrder";
import EditWorkOrder from "./EditWorkOrder";
import ViewWorkOrder from "./ViewWorkOrder";
import CalendarPage from "./CalendarPage";
import HistoryReport from "./HistoryReport";   // ← updated import
import Login from "./Login";
import Navbar from "./Navbar";               
import "bootstrap/dist/css/bootstrap.min.css";

// A wrapper for protecting routes
function PrivateRoute({ children }) {
  const token = localStorage.getItem("jwt");
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Router>
      {/* Render Navbar on all pages */}
      <Navbar />

      <div className="container mt-4">
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
            path="/edit-work-order/:id"
            element={
              <PrivateRoute>
                <EditWorkOrder />
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
                <HistoryReport />     {/* ← new route */}
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
  );
}
