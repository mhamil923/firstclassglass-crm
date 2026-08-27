// File: src/RecordPaymentModal.js
// The ONE Record Payment modal + payment-history renderer, shared by Collections,
// the Reports → Aging tab, and the ViewWorkOrder invoice cards. Don't fork it —
// all three post to POST /invoices/:id/payments and get the recomputed invoice
// back through onSaved(invoice, payments) so each page can update its own row.
//
// Styling is Apple Design System tokens only (var(--bg-card-solid), --bg-secondary,
// --text-primary/secondary/tertiary, --border-color, --accent-*), so it renders
// correctly on all three host pages in both light and dark themes.
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";

export const PAYMENT_METHODS = ["Check", "ACH", "Card", "Cash", "Other"];

export const fmtPayMoney = (v) =>
  "$" + (Number(v) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// payments_v2.paymentDate is a DATE. Render the calendar day that was typed rather
// than letting new Date("2026-08-20") get shifted back a day by the local timezone.
export const fmtPayDate = (d) => {
  if (!d) return "—";
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return String(d);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// "$1,000.00 on Aug 20, 2026 (Check #4411)"
export const paymentLabel = (p) => {
  const ref = p.reference ? ` #${p.reference}` : "";
  const how = p.method ? ` (${p.method}${ref})` : ref ? ` (${p.reference})` : "";
  return `${fmtPayMoney(p.amount)} on ${fmtPayDate(p.paymentDate)}${how}`;
};

const FIELD = {
  width: "100%",
  boxSizing: "border-box",
  padding: 10,
  borderRadius: 8,
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  fontSize: 14,
};
const LABEL = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-secondary)" };
const SECONDARY_BTN = {
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  padding: "10px 18px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};
// Record Payment is the happy-path action everywhere it appears, so it's the green
// primary — distinct from the blue "Draft Reminder" / chase actions beside it.
export const RECORD_PAYMENT_BTN = {
  background: "var(--accent-green, #34c759)",
  color: "#fff",
  border: "none",
  fontWeight: 600,
  cursor: "pointer",
};

/* ============================ The modal ============================ */
// props:
//   invoice  { id, label, customer, total, outstanding }  — outstanding pre-fills Amount
//   onClose()
//   onSaved(updatedInvoice, payments)
export default function RecordPaymentModal({ invoice, onClose, onSaved }) {
  const outstanding = Math.max(0, Number(invoice?.outstanding) || 0);
  // Full payment is one click: the amount arrives pre-filled with the balance.
  const [amount, setAmount] = useState(outstanding ? outstanding.toFixed(2) : "");
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [method, setMethod] = useState("Check");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const amountRef = useRef(null);

  useEffect(() => { amountRef.current?.focus(); amountRef.current?.select(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const parsed = useMemo(() => Number(String(amount).replace(/[$,\s]/g, "")), [amount]);
  const overpay = Number.isFinite(parsed) && parsed > outstanding + 0.004;
  const valid = Number.isFinite(parsed) && parsed > 0 && !overpay && !!paymentDate;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!valid || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.post(`/invoices/${invoice.id}/payments`, {
        amount: parsed,
        paymentDate,
        method,
        reference: reference.trim(),
        notes: notes.trim(),
      });
      onSaved?.(res.data?.invoice, res.data?.payments || []);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to record payment.");
      setSaving(false);
    }
  };

  const remaining = Number.isFinite(parsed) && parsed > 0 ? Math.max(0, outstanding - parsed) : outstanding;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Record payment"
      onClick={() => !saving && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 16 }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{ background: "var(--bg-card-solid)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md, 12px)", maxWidth: 420, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
      >
        <h3 style={{ margin: "0 0 2px", fontSize: 18, fontWeight: 700 }}>Record Payment</h3>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14 }}>
          {invoice?.customer ? `${invoice.customer} — ` : ""}{invoice?.label || `Invoice #${invoice?.id}`}
          {" · "}
          <strong style={{ color: "var(--text-primary)" }}>{fmtPayMoney(outstanding)}</strong> outstanding
        </div>

        {error && (
          <div style={{ background: "rgba(255,59,48,0.12)", border: "1px solid var(--accent-red, #ff3b30)", color: "var(--accent-red, #ff3b30)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <label style={LABEL} htmlFor="rp-amount">Amount</label>
        <input
          id="rp-amount" ref={amountRef} type="text" inputMode="decimal" value={amount}
          onChange={(e) => { setAmount(e.target.value); setError(""); }}
          style={{ ...FIELD, marginBottom: overpay ? 4 : 12, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
        />
        {overpay && (
          <div style={{ fontSize: 12, color: "var(--accent-red, #ff3b30)", marginBottom: 12 }}>
            Over the {fmtPayMoney(outstanding)} balance. There is no credits system — record {fmtPayMoney(outstanding)} or less.
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL} htmlFor="rp-date">Date</label>
            <input id="rp-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} style={FIELD} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL} htmlFor="rp-method">Method</label>
            <select id="rp-method" value={method} onChange={(e) => setMethod(e.target.value)} style={FIELD}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <label style={LABEL} htmlFor="rp-ref">Reference {method === "Check" ? "(check #)" : "(optional)"}</label>
        <input id="rp-ref" type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={method === "Check" ? "4411" : "Confirmation / transaction #"} style={{ ...FIELD, marginBottom: 12 }} />

        <label style={LABEL} htmlFor="rp-notes">Note (optional)</label>
        <input id="rp-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={255} style={{ ...FIELD, marginBottom: 14 }} />

        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", background: "var(--bg-secondary)", borderRadius: 8, padding: "8px 12px", marginBottom: 16 }}>
          {remaining <= 0.004
            ? <>Clears the balance — this invoice will be marked <strong style={{ color: "var(--accent-green, #34c759)" }}>Paid</strong> and leave Collections.</>
            : <>Remaining balance after this payment: <strong style={{ color: "var(--text-primary)" }}>{fmtPayMoney(remaining)}</strong></>}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" onClick={onClose} disabled={saving} style={SECONDARY_BTN}>Cancel</button>
          <button
            type="submit" disabled={!valid || saving}
            style={{ ...RECORD_PAYMENT_BTN, padding: "10px 18px", borderRadius: 8, ...((!valid || saving) ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
          >
            {saving ? "Saving…" : "Record Payment"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ==================== Payment history (invoice cards) ==================== */
// One payment  -> "Paid $1,000.00 on Aug 20, 2026 (Check #4411)"
// Two or more  -> "2 payments · $1,000.00", click to expand the list.
// Each row carries the confirm-guarded delete affordance.
export function PaymentHistory({ invoiceId, payments, onChanged, style }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const list = Array.isArray(payments) ? payments : [];
  if (!list.length) return null;

  const total = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const remove = async (p) => {
    if (busyId) return;
    if (!window.confirm(`Delete this ${fmtPayMoney(p.amount)} payment? The invoice balance will be restored.`)) return;
    setBusyId(p.id);
    try {
      const res = await api.delete(`/invoices/${invoiceId}/payments/${p.id}`);
      onChanged?.(res.data?.invoice, res.data?.payments || []);
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to delete payment.");
    } finally {
      setBusyId(null);
    }
  };

  const delBtn = (p) => (
    <button
      type="button" title="Delete this payment" disabled={busyId === p.id}
      onClick={(e) => { e.stopPropagation(); remove(p); }}
      style={{ background: "none", border: "none", color: "var(--accent-red, #ff3b30)", cursor: "pointer", fontSize: 12, padding: "0 2px", lineHeight: 1, opacity: busyId === p.id ? 0.4 : 1 }}
    >
      {busyId === p.id ? "…" : "✕"}
    </button>
  );

  return (
    <div className="tiny" style={{ padding: "0 8px", color: "var(--accent-green, #34c759)", fontWeight: 600, ...style }}>
      {list.length === 1 ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span>Paid {paymentLabel(list[0])}</span>
          {delBtn(list[0])}
        </span>
      ) : (
        <>
          <button
            type="button" onClick={() => setOpen((o) => !o)}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", fontWeight: 600, textDecoration: "underline" }}
          >
            {open ? "▾" : "▸"} {list.length} payments · {fmtPayMoney(total)}
          </button>
          {open && (
            <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 2, fontWeight: 500 }}>
              {list.map((p) => (
                <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span>{paymentLabel(p)}</span>
                  {delBtn(p)}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
