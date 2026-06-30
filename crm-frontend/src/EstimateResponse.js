// File: src/EstimateResponse.js
// PUBLIC tokenized estimate Accept/Decline page (no auth). Routed at
// /estimate-response/:token. Reads GET /public/estimate-response/:token, shows the
// estimate PDF + key info + two buttons, POSTs the chosen action. The ?action=
// query param (from the email buttons) pre-highlights but still requires a click
// (so mail-client link prefetchers can't auto-accept). Handles already-responded / 409.
import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import api from "./api";

const money = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : "$" + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export default function EstimateResponse() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const preAction = (searchParams.get("action") || "").toLowerCase();
  const [state, setState] = useState({ phase: "loading", data: null, response: null });
  const [submitting, setSubmitting] = useState(false);
  const [doneAction, setDoneAction] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/public/estimate-response/${token}`);
        if (!alive) return;
        const d = res.data || {};
        if (d.status === "ok") setState({ phase: "ready", data: d, response: null });
        else if (d.status === "already_responded") setState({ phase: "already", data: null, response: d.response });
        else setState({ phase: "invalid", data: null, response: null });
      } catch (e) {
        if (alive) setState({ phase: "invalid", data: null, response: null });
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const respond = async (action) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/public/estimate-response/${token}`, { action });
      setDoneAction(action);
      setState((s) => ({ ...s, phase: "done" }));
    } catch (e) {
      if (e?.response?.status === 409) setState({ phase: "already", data: null, response: null });
      else { alert(e?.response?.data?.error || "Something went wrong. Please try again."); setSubmitting(false); }
    }
  };

  const wrap = (children) => (
    <div style={{ minHeight: "100vh", background: "#f3f4f6", padding: 16, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>{children}</div>
    </div>
  );
  const card = (inner) => (
    <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 6px 24px rgba(0,0,0,0.08)", marginTop: 24, textAlign: "center" }}>{inner}</div>
  );

  if (state.phase === "loading") return wrap(card(<p>Loading estimate…</p>));
  if (state.phase === "invalid") return wrap(card(<><h2>Estimate Not Found</h2><p>This estimate link is invalid or has expired.</p></>));
  if (state.phase === "already") return wrap(card(<><div style={{ fontSize: 42 }}>✓</div><h2>Already Responded</h2><p>You've already {state.response === "Declined" ? "declined" : (state.response === "Accepted" ? "accepted" : "responded to")} this estimate. Thank you.</p></>));
  if (state.phase === "done") return wrap(card(<>
    <div style={{ fontSize: 42, color: doneAction === "accept" ? "#16a34a" : "#dc2626" }}>{doneAction === "accept" ? "✓" : "✕"}</div>
    <h2>Thank you</h2>
    <p>We've received your response — this estimate has been <strong>{doneAction === "accept" ? "accepted" : "declined"}</strong>. First Class Glass &amp; Mirror, Inc. will be in touch.</p>
  </>));

  const d = state.data;
  return wrap(
    <div style={{ background: "#fff", borderTop: "4px solid #1b5e20", borderRadius: 12, padding: 24, marginTop: 16 }}>
      <h2 style={{ margin: 0, color: "#1b5e20" }}>Your Estimate</h2>
      <p style={{ color: "#555", marginTop: 4 }}>
        {d.customer ? `${d.customer}` : ""}{d.siteAddress ? ` — ${d.siteAddress}` : ""}
        {money(d.amount) ? ` · ${money(d.amount)}` : ""}
      </p>

      {d.pdfUrl && (
        <iframe title="Estimate PDF" src={d.pdfUrl} style={{ width: "100%", height: 460, border: "1px solid #ddd", borderRadius: 8, marginTop: 12 }} />
      )}

      <p style={{ marginTop: 16, fontSize: 14, color: "#444" }}>Please review your estimate above, then choose:</p>

      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button
          type="button" onClick={() => respond("accept")} disabled={submitting}
          style={{ flex: 1, minWidth: 200, padding: 18, fontSize: 18, fontWeight: 800, borderRadius: 10, border: preAction === "accept" ? "3px solid #0b3d2e" : "none", background: submitting ? "#9ca3af" : "#16a34a", color: "#fff", cursor: submitting ? "not-allowed" : "pointer" }}
        >
          {submitting ? "…" : "✓ Accept Estimate"}
        </button>
        <button
          type="button" onClick={() => respond("decline")} disabled={submitting}
          style={{ flex: 1, minWidth: 200, padding: 18, fontSize: 18, fontWeight: 800, borderRadius: 10, border: preAction === "decline" ? "3px solid #7f1d1d" : "none", background: submitting ? "#9ca3af" : "#dc2626", color: "#fff", cursor: submitting ? "not-allowed" : "pointer" }}
        >
          {submitting ? "…" : "✕ Decline Estimate"}
        </button>
      </div>

      <p style={{ textAlign: "center", fontSize: 11, color: "#999", marginTop: 18 }}>
        First Class Glass &amp; Mirror, Inc. · 1513 Industrial Drive, Itasca, IL 60143 · 630-250-9777
      </p>
    </div>
  );
}
