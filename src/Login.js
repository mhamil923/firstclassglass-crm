import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api"; // your axios instance with baseURL + interceptor
import "bootstrap/dist/css/bootstrap.min.css";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const handleSubmit = async e => {
    e.preventDefault();
    try {
      const { data } = await api.post("/auth/login", { username, password });
      // store the token
      localStorage.setItem("jwt", data.token);
      // navigate into the protected app
      navigate("/work-orders");
    } catch (err) {
      console.error("Login error:", err.response?.data || err);
      alert(err.response?.data?.error || "Login failed");
    }
  };

  return (
    <div className="container mt-4">
      <h2 className="text-center text-primary">Login</h2>
      <form
        onSubmit={handleSubmit}
        className="card p-4 mx-auto"
        style={{ maxWidth: 400 }}
      >
        <div className="mb-3">
          <label>Username</label>
          <input
            required
            className="form-control"
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
        </div>
        <div className="mb-3">
          <label>Password</label>
          <input
            required
            type="password"
            className="form-control"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary w-100">
          Log In
        </button>
      </form>
    </div>
  );
}
