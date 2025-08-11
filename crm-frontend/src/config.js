// src/config.js
// Source of truth for the backend base URL

const raw = (process.env.REACT_APP_API_URL || "").trim();

// If missing, use a sensible dev default, but in prod warn loudly.
let base = raw;
if (!base && process.env.NODE_ENV === "development") {
  base = "http://localhost:8080";
}

// Normalize (remove trailing slash)
const API_BASE_URL = (base || "").replace(/\/$/, "");

if (!API_BASE_URL && process.env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.warn(
    "[config] REACT_APP_API_URL is empty in production build — frontend cannot reach backend."
  );
}

export default API_BASE_URL;
