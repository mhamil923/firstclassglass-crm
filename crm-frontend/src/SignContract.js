// File: src/SignContract.js
// PUBLIC tokenized contract-signing page (no auth). Routed at /sign-contract/:token.
// Reads GET /public/contract/:token, lets the customer review the contract PDF +
// key terms, captures a signature (self-contained canvas pad — no extra deps),
// and POSTs /public/contract/:token/sign. Handles already-signed / invalid / 409.
import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import api from "./api";

const money = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : "$" + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDate(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); }
  catch { return String(d); }
}

// Self-contained signature pad (touch + mouse)
function SignaturePad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const dirty = useRef(false);

  const pos = (e) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
  };
  const start = (e) => { e.preventDefault(); drawing.current = true; last.current = pos(e); };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const c = canvasRef.current; const ctx = c.getContext("2d");
    const p = pos(e);
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p; dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(canvasRef.current.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvasRef.current; c.getContext("2d").clearRect(0, 0, c.width, c.height);
    dirty.current = false; onChange("");
  };

  useEffect(() => {
    const c = canvasRef.current;
    // size the backing store to the displayed size for crisp lines
    c.width = c.offsetWidth * 2; c.height = c.offsetHeight * 2;
  }, []);

  return (
    <div>
      <canvas
        ref={canvasRef}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{ width: "100%", height: 180, border: "2px dashed #b0b0b0", borderRadius: 10, touchAction: "none", background: "#fff" }}
      />
      <button type="button" onClick={clear} style={{ marginTop: 8, fontSize: 13, padding: "6px 14px", cursor: "pointer", background: "#f1f1f1", border: "1px solid #ccc", borderRadius: 6 }}>
        Clear
      </button>
    </div>
  );
}

export default function SignContract() {
  const { token } = useParams();
  const [state, setState] = useState({ phase: "loading", data: null });
  const [signerName, setSignerName] = useState("");
  const [signatureData, setSignatureData] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/public/contract/${token}`);
        if (!alive) return;
        const d = res.data || {};
        if (d.status === "already_signed") setState({ phase: "already", data: null });
        else if (d.status === "ok") setState({ phase: "ready", data: d });
        else setState({ phase: "invalid", data: null });
      } catch (e) {
        if (alive) setState({ phase: "invalid", data: null });
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const submit = async () => {
    if (!signerName.trim() || !signatureData || !agreed) return;
    setSubmitting(true);
    try {
      await api.post(`/public/contract/${token}/sign`, { signerName: signerName.trim(), signatureData });
      setState({ phase: "done", data: null });
    } catch (e) {
      if (e?.response?.status === 409) setState({ phase: "already", data: null });
      else { alert(e?.response?.data?.error || "Failed to submit. Please try again."); setSubmitting(false); }
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

  if (state.phase === "loading") return wrap(card(<p>Loading contract…</p>));
  if (state.phase === "invalid") return wrap(card(<><h2>Contract Not Found</h2><p>This contract link is invalid or has expired.</p></>));
  if (state.phase === "already") return wrap(card(<><div style={{ fontSize: 42 }}>✓</div><h2>Already Signed</h2><p>This contract has already been signed. Thank you.</p></>));
  if (state.phase === "done") return wrap(card(<><div style={{ fontSize: 42, color: "#22c55e" }}>✓</div><h2>Contract Signed</h2><p>Thank you, {signerName}. A copy has been recorded. First Class Glass &amp; Mirror, Inc. will be in touch.</p></>));

  const d = state.data;
  const canSubmit = signerName.trim() && signatureData && agreed && !submitting;

  return wrap(
    <>
      <div style={{ background: "#fff", borderTop: "4px solid #1b5e20", borderRadius: 12, padding: 24, marginTop: 16 }}>
        <h2 style={{ margin: 0, color: "#1b5e20" }}>Residential Sales Order Agreement</h2>
        <p style={{ color: "#555", marginTop: 4 }}>
          {d.customer ? `${d.customer} — ` : ""}{d.projectAddress || ""}
        </p>

        {d.pdfUrl && (
          <iframe title="Contract PDF" src={d.pdfUrl} style={{ width: "100%", height: 460, border: "1px solid #ddd", borderRadius: 8, marginTop: 12 }} />
        )}

        <div style={{ marginTop: 16, background: "#f8faf8", border: "1px solid #e2e8e2", borderRadius: 8, padding: 16, fontSize: 14 }}>
          <strong>Key terms</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
            <li><strong>Scope:</strong> {d.scopeOfWork || "See contract"}</li>
            {money(d.contractTotal) && <li><strong>Contract total:</strong> {money(d.contractTotal)}</li>}
            <li><strong>Down payment:</strong> {d.downPaymentPercent != null ? `${Number(d.downPaymentPercent)}% of contract total` : "See contract"}</li>
            {(d.startDate || d.completionDate) && (
              <li><strong>Dates:</strong> {d.startDate ? fmtDate(d.startDate) : "TBD"} → {d.completionDate ? fmtDate(d.completionDate) : "TBD"}</li>
            )}
            <li><strong>Cancellation:</strong> You may cancel within 3 business days (815 ILCS 505/2B). After that, a 50% cancellation fee applies. {d.county || "DuPage"} County venue.</li>
          </ul>
        </div>

        <div style={{ marginTop: 20 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Full legal name</label>
          <input
            type="text" value={signerName} onChange={(e) => setSignerName(e.target.value)}
            placeholder="Type your full legal name"
            style={{ width: "100%", padding: 10, fontSize: 16, borderRadius: 8, border: "1px solid #ccc", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Signature</label>
          <SignaturePad onChange={setSignatureData} />
        </div>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 16, fontSize: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I acknowledge the work described and agree to the terms of this Agreement, including the cancellation policy.</span>
        </label>

        <button
          type="button" onClick={submit} disabled={!canSubmit}
          style={{
            marginTop: 20, width: "100%", padding: 16, fontSize: 17, fontWeight: 700, borderRadius: 10, border: "none",
            background: canSubmit ? "#1b5e20" : "#9ca3af", color: "#fff", cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {submitting ? "Submitting…" : "Sign & Submit"}
        </button>
        <p style={{ textAlign: "center", fontSize: 11, color: "#999", marginTop: 12 }}>
          First Class Glass &amp; Mirror, Inc. · 1513 Industrial Drive, Itasca, IL 60143 · 630-250-9777
        </p>
      </div>
    </>
  );
}
