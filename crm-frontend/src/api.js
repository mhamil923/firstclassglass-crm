// src/api.js
import axios from "axios";
import API_BASE_URL from "./config";

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  withCredentials: false, // we use Bearer tokens, not cookies
});

// Attach JWT if present
api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem("jwt");
  if (token) {
    cfg.headers = cfg.headers || {};
    cfg.headers.Authorization = `Bearer ${token}`;
  }
  return cfg;
});

// Optional: handle 401s by clearing token
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401) {
      localStorage.removeItem("jwt");
    }
    return Promise.reject(err);
  }
);

export default api;
