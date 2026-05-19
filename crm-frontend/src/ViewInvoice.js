// File: src/ViewInvoice.js
import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";
import SendEmailModal from "./SendEmailModal";
import "./ViewInvoice.css";

function fmtMoney(val) {
  const n = Number(val) || 0;
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function statusClass(s) {
  if (!s) return "vi-status-draft";
  const sl = s.toLowerCase();
  if (sl === "sent") return "vi-status-sent";
  if (sl === "partial") return "vi-status-partial";
  if (sl === "paid") return "vi-status-paid";
  if (sl === "overdue") return "vi-status-overdue";
  if (sl === "void") return "vi-status-void";
  return "vi-status-draft";
}

const PAYMENT_METHOD_LABEL = {
  check: "Check",
  credit_card: "Credit Card",
  cash: "Cash",
  other: "Other",
};

function paymentStatusStyle(status) {
  const s = String(status || "Unpaid");
  if (s === "Paid") return { bg: "#34c759", color: "#fff", label: "Paid" };
  if (s === "Partial") return { bg: "#f59e0b", color: "#fff", label: "Partial" };
  return { bg: "#ef4444", color: "#fff", label: "Unpaid" };
}

export default function ViewInvoice() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfTemplates, setPdfTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailModalType, setEmailModalType] = useState("invoice");
  const [emailHistory, setEmailHistory] = useState([]);

  // Payment modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    paymentMethod: "check",
    checkNumber: "",
    referenceNote: "",
    paymentDate: todayISO(),
  });
  const [paymentSaving, setPaymentSaving] = useState(false);

  const fetchInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/invoices/${id}`);
      setInvoice(res.data);
      if (res.data.templateId && !selectedTemplateId) {
        setSelectedTemplateId(String(res.data.templateId));
      }
    } catch (err) {
      console.error("Error fetching invoice:", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  useEffect(() => {
    api.get("/pdf-templates?type=invoice").then((res) => {
      setPdfTemplates(Array.isArray(res.data) ? res.data : []);
    }).catch(() => {});
  }, []);

  const fetchEmailHistory = useCallback(() => {
    api.get(`/email-log?invoiceId=${id}`).then((res) => {
      setEmailHistory(Array.isArray(res.data) ? res.data : []);
    }).catch(() => {});
  }, [id]);

  useEffect(() => {
    fetchEmailHistory();
  }, [fetchEmailHistory]);

  const handleStatusChange = async (newStatus) => {
    if (newStatus === "Void" && !window.confirm("Mark this invoice as void? This cannot be undone.")) return;
    setStatusUpdating(true);
    try {
      await api.put(`/invoices/${id}/status`, { status: newStatus });
      await fetchInvoice();
    } catch (err) {
      console.error("Error updating status:", err);
      alert("Failed to update status.");
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleGeneratePdf = async () => {
    setGeneratingPdf(true);
    try {
      await api.post(`/invoices/${id}/generate-pdf`, selectedTemplateId ? { templateId: selectedTemplateId } : {});
      await fetchInvoice();
    } catch (err) {
      console.error("Error generating PDF:", err);
      alert("Failed to generate PDF.");
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleSendEmail = () => {
    setEmailModalType("invoice");
    setShowEmailModal(true);
  };

  const handleSendReminder = () => {
    setEmailModalType("payment_reminder");
    setShowEmailModal(true);
  };

  const handleEmailSent = () => {
    fetchInvoice();
    fetchEmailHistory();
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this invoice? This cannot be undone.")) return;
    try {
      await api.delete(`/invoices/${id}`);
      navigate("/invoices");
    } catch (err) {
      console.error("Error deleting invoice:", err);
      alert(err?.response?.data?.error || "Failed to delete invoice.");
    }
  };

  // Payment modal handlers
  const openPaymentModal = () => {
    setPaymentForm({
      amount: invoice ? String(Number(invoice.balanceDue) || "") : "",
      paymentMethod: "check",
      checkNumber: "",
      referenceNote: "",
      paymentDate: todayISO(),
    });
    setShowPaymentModal(true);
  };

  const handlePaymentChange = (e) => {
    const { name, value } = e.target;
    setPaymentForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleRecordPayment = async () => {
    if (!paymentForm.amount || Number(paymentForm.amount) <= 0) {
      alert("Please enter a valid payment amount.");
      return;
    }
    setPaymentSaving(true);
    try {
      await api.post(`/invoices/${id}/payments`, paymentForm);
      setShowPaymentModal(false);
      await fetchInvoice();
    } catch (err) {
      console.error("Error recording payment:", err);
      alert("Failed to record payment.");
    } finally {
      setPaymentSaving(false);
    }
  };

  const handleDeletePayment = async (paymentId) => {
    if (!window.confirm("Delete this payment record?")) return;
    try {
      await api.delete(`/invoices/${id}/payments/${paymentId}`);
      await fetchInvoice();
    } catch (err) {
      console.error("Error deleting payment:", err);
      alert("Failed to delete payment.");
    }
  };

  if (loading) return <div className="vi-loading">Loading invoice...</div>;
  if (!invoice) return <div className="vi-loading">Invoice not found.</div>;

  const inv = invoice;
  const lineItems = inv.lineItems || [];
  const payments = inv.payments || [];
  const pdfUrl = inv.pdfPath
    ? `${API_BASE_URL}/files?key=${encodeURIComponent(inv.pdfPath)}`
    : null;
  const customerName = inv.companyName || inv.custName || "—";
  const isDraft = inv.status === "Draft";
  const isVoid = inv.status === "Void";
  const balanceDue = Number(inv.balanceDue) || 0;
  const invoiceTotal = Number(inv.total) || 0;
  const amountPaid = Number(inv.amountPaid) || 0;

  // Derive paymentStatus from amounts if backend didn't supply it
  let paymentStatus = inv.paymentStatus;
  if (!paymentStatus) {
    if (amountPaid >= invoiceTotal && invoiceTotal > 0) paymentStatus = "Paid";
    else if (amountPaid > 0) paymentStatus = "Partial";
    else paymentStatus = "Unpaid";
  }
  const payStyle = paymentStatusStyle(paymentStatus);

  return (
    <div className="vi-page">
      <div className="vi-container">
        {/* Top bar */}
        <div className="vi-topbar">
          <Link to="/invoices" className="vi-back">&larr; Invoices</Link>
          <div className="vi-title-area">
            <h2 className="vi-title">Invoice #{inv.invoiceNumber}</h2>
            <span className={`vi-status-pill ${statusClass(inv.status)}`}>
              {inv.status || "Draft"}
            </span>
            <span
              style={{
                background: payStyle.bg,
                color: payStyle.color,
                fontSize: 12,
                fontWeight: 700,
                padding: "4px 12px",
                borderRadius: 999,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginLeft: 8,
              }}
              title="Payment status"
            >
              {paymentStatus === "Partial"
                ? `Partial — ${fmtMoney(amountPaid)} of ${fmtMoney(invoiceTotal)}`
                : payStyle.label}
            </span>
          </div>
          <div className="vi-actions">
            {isDraft && (
              <Link to={`/invoices/${id}/edit`} className="vi-btn vi-btn-secondary">
                Edit
              </Link>
            )}
            {pdfTemplates.length > 1 && (
              <select
                className="vi-btn vi-btn-secondary"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                style={{
                  WebkitAppearance: 'auto',
                  MozAppearance: 'auto',
                  appearance: 'auto',
                  backgroundColor: '#1c1c1e',
                  color: '#f5f5f7',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  borderRadius: '12px',
                  padding: '10px 16px',
                  fontSize: '14px',
                  cursor: 'pointer',
                  outline: 'none',
                  minWidth: 130,
                  backgroundImage: 'none'
                }}
              >
                <option value="">Default Template</option>
                {pdfTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            <button
              className="vi-btn vi-btn-primary"
              onClick={handleGeneratePdf}
              disabled={generatingPdf}
            >
              {generatingPdf ? "Generating..." : pdfUrl ? "Regenerate PDF" : "Generate PDF"}
            </button>
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="vi-btn vi-btn-secondary"
              >
                Download PDF
              </a>
            )}
            <button className="vi-btn vi-btn-secondary" onClick={handleSendEmail}>
              Send to Customer
            </button>
            <button className="vi-btn vi-btn-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
        </div>

        {/* Status Controls */}
        {!isVoid && inv.status !== "Paid" && (
          <div className="vi-card">
            <div className="vi-card-body">
              <div className="vi-status-controls">
                {isDraft && (
                  <button
                    className="vi-btn vi-btn-primary"
                    onClick={() => handleStatusChange("Sent")}
                    disabled={statusUpdating}
                  >
                    Mark as Sent
                  </button>
                )}
                {(inv.status === "Sent" || inv.status === "Overdue" || inv.status === "Partial") && (
                  <>
                    <button
                      className="vi-btn vi-btn-success"
                      onClick={openPaymentModal}
                    >
                      Record Payment
                    </button>
                    <button
                      className="vi-btn vi-btn-primary"
                      onClick={handleSendReminder}
                    >
                      Send Reminder
                    </button>
                    {balanceDue > 0 && (
                      <button
                        className="vi-btn vi-btn-success"
                        onClick={() => handleStatusChange("Paid")}
                        disabled={statusUpdating}
                      >
                        Mark as Paid
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Customer Info */}
        <div className="vi-card">
          <div className="vi-card-header">Customer</div>
          <div className="vi-card-body">
            <div className="vi-grid vi-grid-3">
              <div className="vi-field">
                <div className="vi-label">Company</div>
                <div className="vi-value">
                  {inv.customerId ? (
                    <Link to={`/customers/${inv.customerId}`}>{customerName}</Link>
                  ) : (
                    customerName
                  )}
                </div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Phone</div>
                <div className={`vi-value${inv.custPhone ? "" : " muted"}`}>
                  {inv.custPhone || "—"}
                </div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Email</div>
                <div className={`vi-value${inv.custEmail ? "" : " muted"}`}>
                  {inv.custEmail || "—"}
                </div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Billing Address</div>
                <div className={`vi-value${(inv.effectiveBillingAddress || inv.billingAddress) ? "" : " muted"}`}>
                  {[inv.effectiveBillingAddress || inv.billingAddress,
                    inv.effectiveBillingCity || inv.billingCity,
                    inv.effectiveBillingState || inv.billingState,
                    inv.effectiveBillingZip || inv.billingZip]
                    .filter(Boolean).join(", ") || "—"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Invoice Details */}
        <div className="vi-card">
          <div className="vi-card-header">Invoice Details</div>
          <div className="vi-card-body">
            <div className="vi-grid vi-grid-3">
              <div className="vi-field">
                <div className="vi-label">Invoice #</div>
                <div className="vi-value" style={{ fontWeight: 700 }}>
                  {inv.invoiceNumber}
                </div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Issue Date</div>
                <div className="vi-value">{fmtDate(inv.issueDate)}</div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Due Date</div>
                <div className={`vi-value${inv.status === "Overdue" ? " vi-overdue-text" : ""}`}>
                  {fmtDate(inv.dueDate)}
                </div>
              </div>
              <div className="vi-field">
                <div className="vi-label">P.O. No.</div>
                <div className={`vi-value${inv.poNumber ? "" : " muted"}`}>
                  {inv.poNumber || "—"}
                </div>
              </div>
              {inv.projectName && (
                <div className="vi-field">
                  <div className="vi-label">Ship To</div>
                  <div className="vi-value">
                    {inv.projectName}
                    {inv.shipToAddress && <><br />{inv.shipToAddress}</>}
                    {(inv.shipToCity || inv.shipToState || inv.shipToZip) && (
                      <><br />{[inv.shipToCity, inv.shipToState].filter(Boolean).join(", ")}{inv.shipToZip ? " " + inv.shipToZip : ""}</>
                    )}
                  </div>
                </div>
              )}
              {inv.workOrderId && (
                <div className="vi-field">
                  <div className="vi-label">Work Order</div>
                  <div className="vi-value">
                    <Link to={`/view-work-order/${inv.workOrderId}`}>
                      WO #{inv.workOrderId}
                    </Link>
                  </div>
                </div>
              )}
              {inv.estimateId && (
                <div className="vi-field">
                  <div className="vi-label">Estimate</div>
                  <div className="vi-value">
                    <Link to={`/estimates/${inv.estimateId}`}>
                      Estimate #{inv.estimateId}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div className="vi-card">
          <div className="vi-card-header">Line Items</div>
          {lineItems.length === 0 ? (
            <div className="vi-card-body" style={{ textAlign: "center", color: "var(--text-tertiary)" }}>
              No line items.
            </div>
          ) : (
            <>
              <table className="vi-li-table">
                <thead>
                  <tr>
                    <th className="col-qty">Qty</th>
                    <th>Description</th>
                    <th className="col-amount">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => (
                    <tr key={li.id}>
                      <td className="col-qty">
                        {li.quantity != null && Number(li.quantity) > 0
                          ? (Number(li.quantity) === Math.floor(Number(li.quantity))
                              ? Math.floor(Number(li.quantity))
                              : Number(li.quantity).toFixed(2))
                          : ""}
                      </td>
                      <td>{li.description}</td>
                      <td className="col-amount">{fmtMoney(li.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="vi-totals">
                <div className="vi-totals-row">
                  <span className="vi-totals-label">Subtotal</span>
                  <span className="vi-totals-value">{fmtMoney(inv.subtotal)}</span>
                </div>
                {Number(inv.taxRate) > 0 && (
                  <div className="vi-totals-row">
                    <span className="vi-totals-label">Tax ({inv.taxRate}%)</span>
                    <span className="vi-totals-value">{fmtMoney(inv.taxAmount)}</span>
                  </div>
                )}
                <div className="vi-totals-row grand">
                  <span className="vi-totals-label">Total</span>
                  <span className="vi-totals-value">{fmtMoney(inv.total)}</span>
                </div>
                {Number(inv.amountPaid) > 0 && (
                  <div className="vi-totals-row">
                    <span className="vi-totals-label">Amount Paid</span>
                    <span className="vi-totals-value vi-paid-amount">{fmtMoney(inv.amountPaid)}</span>
                  </div>
                )}
                <div className="vi-totals-row balance">
                  <span className="vi-totals-label">Balance Due</span>
                  <span className={`vi-totals-value${balanceDue > 0 ? " vi-balance-due" : " vi-paid-amount"}`}>
                    {fmtMoney(inv.balanceDue)}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Payments */}
        <div className="vi-card">
          <div className="vi-card-header">
            <span>Payments</span>
            {!isVoid && balanceDue > 0 && (
              <button
                className="vi-btn vi-btn-success"
                style={{ padding: "6px 14px", fontSize: 13 }}
                onClick={openPaymentModal}
              >
                + Record Payment
              </button>
            )}
          </div>
          <div className="vi-card-body" style={{ paddingBottom: 0 }}>
            <div className="vi-grid vi-grid-3">
              <div className="vi-field">
                <div className="vi-label">Invoice Total</div>
                <div className="vi-value" style={{ fontWeight: 700 }}>{fmtMoney(invoiceTotal)}</div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Amount Paid</div>
                <div className="vi-value vi-paid-amount" style={{ fontWeight: 700 }}>{fmtMoney(amountPaid)}</div>
              </div>
              <div className="vi-field">
                <div className="vi-label">Balance Remaining</div>
                <div
                  className="vi-value"
                  style={{
                    fontWeight: 700,
                    color: balanceDue > 0 ? "#ef4444" : "#34c759",
                  }}
                >
                  {fmtMoney(balanceDue)}
                </div>
              </div>
            </div>
          </div>
          {payments.length === 0 ? (
            <div className="vi-card-body" style={{ textAlign: "center", color: "var(--text-tertiary)" }}>
              No payments recorded.
            </div>
          ) : (
            <table className="vi-payments-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Method</th>
                  <th>Check #</th>
                  <th>Amount</th>
                  <th>Note</th>
                  <th>Recorded By</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const methodKey = String(p.paymentMethod || "").toLowerCase();
                  const methodLabel = PAYMENT_METHOD_LABEL[methodKey] || p.paymentMethod || "—";
                  const isCheck = methodKey === "check";
                  return (
                    <tr key={p.id}>
                      <td>{fmtDate(p.paymentDate)}</td>
                      <td>{methodLabel}</td>
                      <td>{isCheck ? (p.checkNumber || "—") : "—"}</td>
                      <td style={{ fontWeight: 700, color: "#34c759" }}>{fmtMoney(p.amount)}</td>
                      <td>{p.referenceNote || p.notes || "—"}</td>
                      <td>{p.recordedBy || "—"}</td>
                      <td>
                        <button
                          className="vi-btn-icon danger"
                          onClick={() => handleDeletePayment(p.id)}
                          title="Delete payment"
                        >
                          &times;
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Notes & Terms */}
        {(inv.notes || inv.terms) && (
          <div className="vi-card">
            <div className="vi-card-header">Notes & Terms</div>
            <div className="vi-card-body">
              <div className="vi-grid vi-grid-2">
                <div className="vi-field">
                  <div className="vi-label">Notes</div>
                  <div className={`vi-notes-text${inv.notes ? "" : " muted"}`}>
                    {inv.notes || "—"}
                  </div>
                </div>
                <div className="vi-field">
                  <div className="vi-label">Terms</div>
                  <div className={`vi-notes-text${inv.terms ? "" : " muted"}`}>
                    {inv.terms || "—"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PDF Preview */}
        {pdfUrl && (
          <div className="vi-card">
            <div className="vi-card-header">
              <span>PDF Preview</span>
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="vi-btn vi-btn-secondary"
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                Open in New Tab
              </a>
            </div>
            <iframe
              title="Invoice PDF Preview"
              src={pdfUrl + "#page=1&view=FitH"}
              className="vi-pdf-frame"
            />
          </div>
        )}

        {/* Email History */}
        {emailHistory.length > 0 && (
          <div className="vi-card">
            <div className="vi-card-header">Email History</div>
            <table className="vi-li-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Recipient</th>
                  <th>Subject</th>
                  <th className="col-amount">Status</th>
                </tr>
              </thead>
              <tbody>
                {emailHistory.map((log) => (
                  <tr key={log.id}>
                    <td>{fmtDate(log.sentAt)}</td>
                    <td>{log.recipientEmail}</td>
                    <td>{log.subject}</td>
                    <td className="col-amount">
                      <span style={{
                        color: log.status === 'sent' ? 'var(--accent-green)' : 'var(--accent-red)',
                        fontWeight: 600, fontSize: 12, textTransform: 'uppercase'
                      }}>
                        {log.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Send Email Modal */}
      <SendEmailModal
        isOpen={showEmailModal}
        onClose={() => setShowEmailModal(false)}
        type={emailModalType}
        entityId={id}
        entityData={invoice}
        customerEmail={inv.custEmail || ""}
        customerName={customerName}
        onSent={handleEmailSent}
      />

      {/* Payment Modal */}
      {showPaymentModal && (
        <div className="vi-modal-overlay" onClick={() => setShowPaymentModal(false)}>
          <div className="vi-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="vi-modal-header">Record Payment</h3>
            <div className="vi-modal-field">
              <label className="vi-modal-label">Payment Date</label>
              <input
                type="date"
                name="paymentDate"
                value={paymentForm.paymentDate}
                onChange={handlePaymentChange}
                className="vi-modal-input"
              />
            </div>
            <div className="vi-modal-field">
              <label className="vi-modal-label">Amount ($)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                name="amount"
                value={paymentForm.amount}
                onChange={handlePaymentChange}
                className="vi-modal-input"
                placeholder="0.00"
                autoFocus
              />
            </div>
            <div className="vi-modal-field">
              <label className="vi-modal-label">Payment Method</label>
              <select
                name="paymentMethod"
                value={paymentForm.paymentMethod}
                onChange={handlePaymentChange}
                className="vi-modal-input"
              >
                <option value="check">Check</option>
                <option value="credit_card">Credit Card</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </div>
            {paymentForm.paymentMethod === "check" && (
              <div className="vi-modal-field">
                <label className="vi-modal-label">Check Number</label>
                <input
                  type="text"
                  name="checkNumber"
                  value={paymentForm.checkNumber}
                  onChange={handlePaymentChange}
                  className="vi-modal-input"
                  placeholder="e.g. 1023"
                />
              </div>
            )}
            <div className="vi-modal-field">
              <label className="vi-modal-label">Reference Note (optional)</label>
              <textarea
                name="referenceNote"
                value={paymentForm.referenceNote}
                onChange={handlePaymentChange}
                className="vi-modal-input vi-modal-textarea"
                placeholder="Transaction ID, memo, anything to remember..."
                rows={2}
              />
            </div>
            <div className="vi-modal-actions">
              <button
                className="vi-btn vi-btn-secondary"
                onClick={() => setShowPaymentModal(false)}
              >
                Cancel
              </button>
              <button
                className="vi-btn vi-btn-success"
                onClick={handleRecordPayment}
                disabled={paymentSaving}
              >
                {paymentSaving ? "Saving..." : "Record Payment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
