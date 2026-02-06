import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api"; // your axios instance with baseURL + interceptor
import ThemeToggle from "./components/ThemeToggle";
import "./Login.css";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const { data } = await api.post("/auth/login", { username, password });
      // store the token
      localStorage.setItem("jwt", data.token);
      // navigate into the protected app
      navigate("/work-orders");
    } catch (err) {
      console.error("Login error:", err.response?.data || err);
      setError(err.response?.data?.error || "Login failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Theme toggle in top right */}
      <div className="login-theme-toggle">
        <ThemeToggle />
      </div>

      <div className="login-container">
        {/* Brand/Logo Section */}
        <div className="login-brand">
          <h1 className="login-brand-title">First Class Glass</h1>
          <p className="login-brand-subtitle">CRM System</p>
        </div>

        {/* Login Card */}
        <div className="login-card">
          <h2 className="login-card-title">Welcome Back</h2>
          <p className="login-card-subtitle">Sign in to your account</p>

          {/* Error Message */}
          {error && (
            <div className="login-error">
              <span className="login-error-icon">⚠</span>
              <span className="login-error-text">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="login-form">
            <div className="login-form-group">
              <label className="login-label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                required
                className="login-input"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                autoComplete="username"
              />
            </div>

            <div className="login-form-group">
              <label className="login-label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                required
                type="password"
                className="login-input"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className={`login-btn ${loading ? "loading" : ""}`}
              disabled={loading}
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="login-footer">
          <p className="login-footer-text">
            First Class Glass CRM &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
