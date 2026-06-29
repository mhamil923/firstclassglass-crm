// File: src/Collections.js
// Standalone Collections / payment-reminder page. Extracted from the former
// Invoices list page when the standalone Estimates/Invoices nav pages were retired
// (invoice creation now happens in QuickBooks). Reads the unchanged collections
// backend: GET /invoices/collections, PUT /invoices/:id/paylink,
// POST /invoices/:id/reminder/{draft,send,skip}.
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

  const daysOverdueBadge = (d) => {
    if (d == null || d < 0) return { background: "#34c759", color: "#fff", label: d == null ? "—" : "Not due" };
    if (d < 45) return { background: "#f59e0b", color: "#fff", label: `${d}d` };
    return { background: "#dc2626", color: "#fff", label: `${d}d` };
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
                  <th style={{ width: 230 }}></th>
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
                        <span title={lateFeeTip} style={{ color: row.lateFee > 0 ? "#dc2626" : "var(--text-tertiary)", fontWeight: row.lateFee > 0 ? 700 : 400, cursor: "help" }}>
                          {fmtMoney(row.lateFee)}
                        </span>
                      </td>
                      <td data-label="Stage">{row.reminderStage}</td>
                      <td data-label="Last Reminded" style={{ fontSize: 12 }}>
                        {row.lastReminderAt ? fmtDate(row.lastReminderAt) : <span style={{ color: "var(--text-tertiary)" }}>Never</span>}
                      </td>
                      <td data-label="Pay Link">
                        {!editing && row.qbPayLink ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "#34c759", fontWeight: 700 }}>✓ On file</span>
                            <button type="button" className="link-btn" style={{ fontSize: 11, background: "none", border: "none", color: "#1b5e20", cursor: "pointer", textDecoration: "underline" }} onClick={() => setPayLinkEdit((m) => ({ ...m, [row.id]: row.qbPayLink || "" }))}>edit</button>
                          </span>
                        ) : !editing ? (
                          <button type="button" style={{ fontSize: 12, background: "none", border: "none", color: "#1b5e20", cursor: "pointer", textDecoration: "underline" }} onClick={() => setPayLinkEdit((m) => ({ ...m, [row.id]: "" }))}>+ Add pay link</button>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                            <input
                              type="text"
                              value={payLinkEdit[row.id]}
                              onChange={(e) => setPayLinkEdit((m) => ({ ...m, [row.id]: e.target.value }))}
                              placeholder="Paste QuickBooks pay URL"
                              style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #ccc", borderRadius: 6, width: 180 }}
                            />
                            <button type="button" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => savePayLink(row.id)}>Save</button>
                            <button type="button" style={{ fontSize: 12, cursor: "pointer" }} onClick={() => setPayLinkEdit((m) => { const n = { ...m }; delete n[row.id]; return n; })}>✕</button>
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button type="button" className="btn-primary-apple" style={{ fontSize: 12, padding: "4px 10px", marginRight: 4 }} onClick={() => openDraft(row)}>Draft Reminder</button>
                        <button type="button" style={{ fontSize: 12, padding: "4px 10px", marginRight: 4, cursor: "pointer" }} onClick={() => navigate(`/invoices/${row.id}`)}>Open</button>
                        <button type="button" style={{ fontSize: 12, padding: "4px 10px", cursor: "pointer" }} onClick={() => skipReminder(row.id)}>Skip</button>
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
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 600, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700 }}>
              Review reminder — {draftModal.row.customer} (#{draftModal.row.invoiceNumber})
            </h3>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0 16px", fontSize: 13 }}>
              <span>Stage: <strong>{draftModal.reminderStage}</strong></span>
              <span>Outstanding: <strong>{fmtMoney(draftModal.outstanding)}</strong></span>
              <span style={{ color: draftModal.lateFee > 0 ? "#dc2626" : "inherit" }}>
                Late fee: <strong>{fmtMoney(draftModal.lateFee)}</strong>
              </span>
              <span>Pay link: <strong style={{ color: draftModal.payLinkOnFile ? "#34c759" : "#dc2626" }}>{draftModal.payLinkOnFile ? "✓ included" : "none on file"}</strong></span>
            </div>
            {draftModal.noPayLinkWarning && (
              <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 12 }}>
                {draftModal.noPayLinkWarning}
              </div>
            )}
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>To</label>
            <input type="text" value={draftModal.to} onChange={(e) => setDraftModal((m) => ({ ...m, to: e.target.value }))} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #d1d5db", marginBottom: 12 }} />
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Subject</label>
            <input type="text" value={draftModal.subject} onChange={(e) => setDraftModal((m) => ({ ...m, subject: e.target.value }))} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #d1d5db", marginBottom: 12 }} />
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Body</label>
            <textarea value={draftModal.body} onChange={(e) => setDraftModal((m) => ({ ...m, body: e.target.value }))} rows={14} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #d1d5db", resize: "vertical", fontFamily: "inherit", fontSize: 13 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => setDraftModal(null)} disabled={draftModal.sending} style={{ padding: "8px 16px", cursor: "pointer" }}>Cancel</button>
              <button type="button" className="btn-primary-apple" onClick={sendDraft} disabled={draftModal.sending || !draftModal.to || !draftModal.subject || !draftModal.body}>
                {draftModal.sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
