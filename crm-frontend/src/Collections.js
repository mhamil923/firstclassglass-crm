// File: src/Collections.js
// Standalone Collections / payment-reminder page. Extracted from the former
// Invoices list page when the standalone Estimates/Invoices nav pages were retired
// (invoice creation now happens in QuickBooks). Reads the unchanged collections
// backend: GET /invoices/collections, PUT /invoices/:id/paylink,
// POST /invoices/:id/reminder/{draft,send,skip}.
//
// Styling: Apple Design System tokens only (var(--bg-card-solid), --bg-secondary,
// --text-primary, --text-secondary, --border-color, --accent-blue/green/orange/red).
// Buttons reuse the shared accent-blue primary class (btn-primary-apple) and the
// estimate-send modal's inline secondary style — dark-mode correct in both themes.
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "./api";
import "./Invoices.css";

function fmtMoney(val) {
  const n = Number(val) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

// ── Shared design-system button styles (theme tokens; even sizing) ───────────
// Secondary/ghost button = the same treatment the estimate-send modal's Cancel uses.
const SECONDARY_BTN = {
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};
// Compact, even-height sizing for the table-row action buttons (Draft/Open/Skip).
const ROW_BTN = {
  fontSize: 12,
  height: 30,
  padding: "0 12px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  whiteSpace: "nowrap",
  boxSizing: "border-box",
  lineHeight: 1,
};
// Themed inputs (match the estimate-send modal fields).
const FIELD = {
  width: "100%",
  boxSizing: "border-box",
  padding: 10,
  borderRadius: 8,
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};
const MODAL_LABEL = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-secondary)" };

export default function Collections() {
  const navigate = useNavigate();
  const [collections, setCollections] = useState([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [payLinkEdit, setPayLinkEdit] = useState({}); // { [invoiceId]: draftValue }
  const [draftModal, setDraftModal] = useState(null);

  const fetchCollections = useCallback(async () => {
    setCollectionsLoading(true);
    try {
      const res = await api.get("/invoices/collections");
      setCollections(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching collections:", err);
      setCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const savePayLink = async (invoiceId) => {
    const link = payLinkEdit[invoiceId] ?? "";
    try {
      await api.put(`/invoices/${invoiceId}/paylink`, { qbPayLink: link });
      setPayLinkEdit((m) => { const n = { ...m }; delete n[invoiceId]; return n; });
      setCollections((prev) => prev.map((c) => (c.id === invoiceId ? { ...c, qbPayLink: link } : c)));
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to save pay link.");
    }
  };

  const openDraft = async (row) => {
    try {
      const res = await api.post(`/invoices/${row.id}/reminder/draft`, {});
      const d = res.data || {};
      setDraftModal({
        invoiceId: row.id,
        row,
        to: d.to || row.customerEmail || "",
        subject: d.subject || "",
        body: d.body || "",
        lateFee: d.lateFee ?? row.lateFee ?? 0,
        outstanding: d.outstanding ?? row.outstanding ?? 0,
        reminderStage: d.reminderStage || row.reminderStage,
        payLinkOnFile: !!d.payLinkOnFile,
        noPayLinkWarning: d.noPayLinkWarning || null,
        sending: false,
      });
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to draft reminder.");
    }
  };

  const sendDraft = async () => {
    if (!draftModal || draftModal.sending) return; // guard against double-click
    setDraftModal((m) => ({ ...m, sending: true }));
    try {
      await api.post(`/invoices/${draftModal.invoiceId}/reminder/send`, {
        to: draftModal.to,
        subject: draftModal.subject,
        body: draftModal.body,
      });
      setDraftModal(null);
      await fetchCollections();
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to send reminder.");
      setDraftModal((m) => (m ? { ...m, sending: false } : m));
    }
  };

  const skipReminder = async (invoiceId) => {
    try {
      await api.post(`/invoices/${invoiceId}/reminder/skip`, {});
      await fetchCollections();
    } catch (err) {
      alert(err?.response?.data?.error || "Failed to skip.");
    }
  };

  // Overdue badge colors from design tokens: green (not due) / amber (0–44) / red (45+)
  const daysOverdueBadge = (d) => {
    if (d == null || d < 0) return { background: "var(--accent-green)", color: "#fff", label: d == null ? "—" : "Not due" };
    if (d < 45) return { background: "var(--accent-orange)", color: "#fff", label: `${d}d` };
    return { background: "var(--accent-red)", color: "#fff", label: `${d}d` };
  };

  return (
    <div className="inv-page">
      <div className="inv-container">
        <div className="inv-header">
          <div>
            <h2 className="inv-title">Collections</h2>
            <div className="inv-subtitle">
              Unpaid &amp; partial invoices, most overdue first. QuickBooks Desktop is the source of truth — the CRM tracks overdue status, computes late fees, and drafts reminders for your review before sending.
            </div>
          </div>
        </div>

        <div className="cust-section-card">
          <div style={{ overflowX: "auto" }}>
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Customer / Invoice #</th>
                  <th style={{ textAlign: "right" }}>Outstanding</th>
                  <th style={{ textAlign: "center" }}>Days Overdue</th>
                  <th style={{ textAlign: "right" }}>Late Fee</th>
                  <th>Reminder Stage</th>
                  <th>Last Reminded</th>
                  <th>Pay Link</th>
                  <th style={{ width: 250 }}></th>
                </tr>
              </thead>
              <tbody>
                {collections.length === 0 && !collectionsLoading && (
                  <tr><td colSpan={8}><div className="inv-empty">No unpaid or partial invoices to collect. 🎉</div></td></tr>
                )}
                {collections.map((row) => {
                  const badge = daysOverdueBadge(row.daysOverdue);
                  const isPartial = Number(row.amountPaid) > 0 && Number(row.amountPaid) < Number(row.total);
                  const editing = Object.prototype.hasOwnProperty.call(payLinkEdit, row.id);
                  const lateFeeTip =
                    row.lateFee > 0
                      ? `15% applied at the 45-day due date, compounding +15% every 30 days. Outstanding ${fmtMoney(row.outstanding)} → late fee ${fmtMoney(row.lateFee)} (stage: ${row.reminderStage}).`
                      : "No late fee — not yet 45 days past the invoice date.";
                  return (
                    <tr key={row.id}>
                      <td data-label="Customer">
                        <div style={{ fontWeight: 600 }}>{row.customer}</div>
                        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>#{row.invoiceNumber}</div>
                      </td>
                      <td data-label="Outstanding" style={{ textAlign: "right" }}>
                        <div style={{ fontWeight: 700 }}>{fmtMoney(row.outstanding)}</div>
                        {isPartial && (
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                            Paid {fmtMoney(row.amountPaid)} of {fmtMoney(row.total)}
                          </div>
                        )}
                      </td>
                      <td data-label="Days Overdue" style={{ textAlign: "center" }}>
                        <span style={{ background: badge.background, color: badge.color, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {badge.label}
                        </span>
                      </td>
                      <td data-label="Late Fee" style={{ textAlign: "right" }}>
                        <span title={lateFeeTip} style={{ color: row.lateFee > 0 ? "var(--accent-red)" : "var(--text-tertiary)", fontWeight: row.lateFee > 0 ? 700 : 400, cursor: "help" }}>
                          {fmtMoney(row.lateFee)}
                        </span>
                      </td>
                      <td data-label="Stage" style={{ color: "var(--text-primary)" }}>{row.reminderStage}</td>
                      <td data-label="Last Reminded" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        {row.lastReminderAt ? fmtDate(row.lastReminderAt) : <span style={{ color: "var(--text-tertiary)" }}>Never</span>}
                      </td>
                      <td data-label="Pay Link">
                        {!editing && row.qbPayLink ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "var(--accent-green)", fontWeight: 700 }}>✓ On file</span>
                            <button type="button" style={{ fontSize: 11, background: "none", border: "none", color: "var(--accent-blue)", cursor: "pointer", textDecoration: "underline", padding: 0 }} onClick={() => setPayLinkEdit((m) => ({ ...m, [row.id]: row.qbPayLink || "" }))}>edit</button>
                          </span>
                        ) : !editing ? (
                          <button type="button" style={{ fontSize: 12, background: "none", border: "none", color: "var(--accent-blue)", cursor: "pointer", textDecoration: "underline", padding: 0 }} onClick={() => setPayLinkEdit((m) => ({ ...m, [row.id]: "" }))}>+ Add pay link</button>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                            <input
                              type="text"
                              value={payLinkEdit[row.id]}
                              onChange={(e) => setPayLinkEdit((m) => ({ ...m, [row.id]: e.target.value }))}
                              placeholder="Paste QuickBooks pay URL"
                              style={{ ...FIELD, width: 180, fontSize: 12, padding: "5px 8px" }}
                            />
                            <button type="button" style={{ ...ROW_BTN, background: "var(--accent-blue)", color: "#fff", border: "none", height: 28, padding: "0 10px" }} onClick={() => savePayLink(row.id)}>Save</button>
                            <button type="button" style={{ ...ROW_BTN, ...SECONDARY_BTN, height: 28, padding: "0 10px" }} onClick={() => setPayLinkEdit((m) => { const n = { ...m }; delete n[row.id]; return n; })}>✕</button>
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <button type="button" className="btn-primary-apple" style={ROW_BTN} onClick={() => openDraft(row)}>Draft Reminder</button>
                          <button type="button" style={{ ...ROW_BTN, ...SECONDARY_BTN }} onClick={() => navigate(`/invoices/${row.id}`)}>Open</button>
                          <button type="button" style={{ ...ROW_BTN, ...SECONDARY_BTN }} onClick={() => skipReminder(row.id)}>Skip</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {collectionsLoading && (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>Loading...</div>
          )}
        </div>
      </div>

      {/* Review-before-send Draft Reminder modal */}
      {draftModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => !draftModal.sending && setDraftModal(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-card-solid)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", maxWidth: 600, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
              Review reminder — {draftModal.row.customer} (#{draftModal.row.invoiceNumber})
            </h3>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0 16px", fontSize: 13, color: "var(--text-secondary)" }}>
              <span>Stage: <strong style={{ color: "var(--text-primary)" }}>{draftModal.reminderStage}</strong></span>
              <span>Outstanding: <strong style={{ color: "var(--text-primary)" }}>{fmtMoney(draftModal.outstanding)}</strong></span>
              <span>
                Late fee: <strong style={{ color: draftModal.lateFee > 0 ? "var(--accent-red)" : "var(--text-primary)" }}>{fmtMoney(draftModal.lateFee)}</strong>
              </span>
              <span>Pay link: <strong style={{ color: draftModal.payLinkOnFile ? "var(--accent-green)" : "var(--accent-red)" }}>{draftModal.payLinkOnFile ? "✓ included" : "none on file"}</strong></span>
            </div>
            {draftModal.noPayLinkWarning && (
              <div style={{ background: "rgba(255,149,0,0.12)", border: "1px solid var(--accent-orange)", color: "var(--accent-orange)", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 12 }}>
                {draftModal.noPayLinkWarning}
              </div>
            )}
            <label style={MODAL_LABEL}>To</label>
            <input type="text" value={draftModal.to} onChange={(e) => setDraftModal((m) => ({ ...m, to: e.target.value }))} style={{ ...FIELD, marginBottom: 12 }} />
            <label style={MODAL_LABEL}>Subject</label>
            <input type="text" value={draftModal.subject} onChange={(e) => setDraftModal((m) => ({ ...m, subject: e.target.value }))} style={{ ...FIELD, marginBottom: 12 }} />
            <label style={MODAL_LABEL}>Body</label>
            <textarea value={draftModal.body} onChange={(e) => setDraftModal((m) => ({ ...m, body: e.target.value }))} rows={14} style={{ ...FIELD, resize: "vertical", fontFamily: "inherit", fontSize: 13 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => setDraftModal(null)} disabled={draftModal.sending} style={{ ...SECONDARY_BTN, padding: "10px 18px", borderRadius: 8, cursor: "pointer" }}>Cancel</button>
              <button type="button" className="btn-primary-apple" onClick={sendDraft} disabled={draftModal.sending || !draftModal.to || !draftModal.subject || !draftModal.body} style={(draftModal.sending || !draftModal.to || !draftModal.subject || !draftModal.body) ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                {draftModal.sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
