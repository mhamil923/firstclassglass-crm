// File: src/ViewEstimate.js
import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import api from "./api";
import API_BASE_URL from "./config";
import "./ViewEstimate.css";

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

function statusClass(s) {
  if (!s) return "est-status-draft";
  const sl = s.toLowerCase();
  if (sl === "sent") return "est-status-sent";
  if (sl === "accepted") return "est-status-accepted";
  if (sl === "declined") return "est-status-declined";
  return "est-status-draft";
}

export default function ViewEstimate() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [converting, setConverting] = useState(false);

  const fetchEstimate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/estimates/${id}`);
      setEstimate(res.data);
    } catch (err) {
      console.error("Error fetching estimate:", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchEstimate();
  }, [fetchEstimate]);

  const handleStatusChange = async (newStatus) => {
    setStatusUpdating(true);
    try {
      await api.put(`/estimates/${id}/status`, { status: newStatus });
      await fetchEstimate();
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
      await api.post(`/estimates/${id}/generate-pdf`);
      await fetchEstimate();
    } catch (err) {
      console.error("Error generating PDF:", err);
      alert("Failed to generate PDF.");
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleSendEmail = async () => {
    try {
      const res = await api.post(`/estimates/${id}/send-email`);
      alert(res.data.message || "Email sent.");
      await fetchEstimate();
    } catch (err) {
      console.error("Error sending email:", err);
      alert("Failed to send email.");
    }
  };

  const handleConvertToInvoice = async () => {
    if (!window.confirm("Convert this estimate to an invoice?")) return;
    setConverting(true);
    try {
      const res = await api.post(`/estimates/${id}/convert-to-invoice`);
      const newInvoiceId = res.data?.invoiceId;
      if (newInvoiceId) {
        navigate(`/invoices/${newInvoiceId}`);
      } else {
        alert("Invoice created successfully.");
        await fetchEstimate();
      }
    } catch (err) {
      console.error("Error converting to invoice:", err);
      alert("Failed to convert estimate to invoice.");
    } finally {
      setConverting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this estimate? This cannot be undone.")) return;
    try {
      await api.delete(`/estimates/${id}`);
      navigate("/estimates");
    } catch (err) {
      console.error("Error deleting estimate:", err);
      alert("Failed to delete estimate.");
    }
  };

  if (loading) return <div className="ve-loading">Loading estimate...</div>;
  if (!estimate) return <div className="ve-loading">Estimate not found.</div>;

  const e = estimate;
  const lineItems = e.lineItems || [];
  const pdfUrl = e.pdfPath
    ? `${API_BASE_URL}/files?key=${encodeURIComponent(e.pdfPath)}`
    : null;
  const customerName = e.companyName || e.custName || "—";

  return (
    <div className="ve-page">
      <div className="ve-container">
        {/* Top bar */}
        <div className="ve-topbar">
          <Link to="/estimates" className="ve-back">&larr; Estimates</Link>
          <div className="ve-title-area">
            <h2 className="ve-title">Estimate</h2>
            <span className={`ve-status-pill ${statusClass(e.status)}`}>
              {e.status || "Draft"}
            </span>
          </div>
          <div className="ve-actions">
            <Link to={`/estimates/${id}/edit`} className="ve-btn ve-btn-secondary">
              Edit
            </Link>
            <button
              className="ve-btn ve-btn-primary"
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
                className="ve-btn ve-btn-secondary"
              >
                Download PDF
              </a>
            )}
            <button className="ve-btn ve-btn-secondary" onClick={handleSendEmail}>
              Send to Customer
            </button>
            <button
              className="ve-btn ve-btn-success"
              onClick={handleConvertToInvoice}
              disabled={converting}
            >
              {converting ? "Converting..." : "Convert to Invoice"}
            </button>
            <button className="ve-btn ve-btn-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
        </div>

        {/* Status Controls */}
        {e.status !== "Accepted" && e.status !== "Declined" && (
          <div className="ve-card">
            <div className="ve-card-body">
              <div className="ve-status-controls">
                {e.status === "Draft" && (
                  <button
                    className="ve-btn ve-btn-primary"
                    onClick={() => handleStatusChange("Sent")}
                    disabled={statusUpdating}
                  >
                    Mark as Sent
                  </button>
                )}
                {e.status === "Sent" && (
                  <>
                    <button
                      className="ve-btn ve-btn-success"
                      onClick={() => handleStatusChange("Accepted")}
                      disabled={statusUpdating}
                    >
                      Mark Accepted
                    </button>
                    <button
                      className="ve-btn ve-btn-danger"
                      onClick={() => handleStatusChange("Declined")}
                      disabled={statusUpdating}
                    >
                      Mark Declined
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Customer Info */}
        <div className="ve-card">
          <div className="ve-card-header">Customer</div>
          <div className="ve-card-body">
            <div className="ve-grid ve-grid-3">
              <div className="ve-field">
                <div className="ve-label">Company</div>
                <div className="ve-value">
                  {e.customerId ? (
                    <Link to={`/customers/${e.customerId}`}>{customerName}</Link>
                  ) : (
                    customerName
                  )}
                </div>
              </div>
              <div className="ve-field">
                <div className="ve-label">Phone</div>
                <div className={`ve-value${e.custPhone ? "" : " muted"}`}>
                  {e.custPhone || "—"}
                </div>
              </div>
              <div className="ve-field">
                <div className="ve-label">Email</div>
                <div className={`ve-value${e.custEmail ? "" : " muted"}`}>
                  {e.custEmail || "—"}
                </div>
              </div>
              <div className="ve-field">
                <div className="ve-label">Billing Address</div>
                <div className={`ve-value${e.billingAddress ? "" : " muted"}`}>
                  {[e.billingAddress, e.billingCity, e.billingState, e.billingZip]
                    .filter(Boolean).join(", ") || "—"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Project Info */}
        <div className="ve-card">
          <div className="ve-card-header">Project</div>
          <div className="ve-card-body">
            <div className="ve-grid ve-grid-3">
              <div className="ve-field">
                <div className="ve-label">Project Name</div>
                <div className={`ve-value${e.projectName ? "" : " muted"}`}>
                  {e.projectName || "—"}
                </div>
              </div>
              <div className="ve-field">
                <div className="ve-label">P.O. No.</div>
                <div className={`ve-value${e.poNumber ? "" : " muted"}`}>
                  {e.poNumber || "—"}
                </div>
              </div>
              <div className="ve-field">
                <div className="ve-label">Date</div>
                <div className="ve-value">{fmtDate(e.issueDate)}</div>
              </div>
              <div className="ve-field">
                <div className="ve-label">Address</div>
                <div className={`ve-value${e.projectAddress ? "" : " muted"}`}>
                  {[e.projectAddress, e.projectCity, e.projectState, e.projectZip]
                    .filter(Boolean).join(", ") || "—"}
                </div>
              </div>
              {e.expirationDate && (
                <div className="ve-field">
                  <div className="ve-label">Expires</div>
                  <div className="ve-value">{fmtDate(e.expirationDate)}</div>
                </div>
              )}
              {e.workOrderId && (
                <div className="ve-field">
                  <div className="ve-label">Work Order</div>
                  <div className="ve-value">
                    <Link to={`/view-work-order/${e.workOrderId}`}>
                      WO #{e.workOrderId}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div className="ve-card">
          <div className="ve-card-header">Line Items</div>
          {lineItems.length === 0 ? (
            <div className="ve-card-body" style={{ textAlign: "center", color: "var(--text-tertiary)" }}>
              No line items.
            </div>
          ) : (
            <>
              <table className="ve-li-table">
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

              <div className="ve-totals">
                <div className="ve-totals-row">
                  <span className="ve-totals-label">Subtotal</span>
                  <span className="ve-totals-value">{fmtMoney(e.subtotal)}</span>
                </div>
                {Number(e.taxRate) > 0 && (
                  <>
                    <div className="ve-totals-row">
                      <span className="ve-totals-label">Tax ({e.taxRate}%)</span>
                      <span className="ve-totals-value">{fmtMoney(e.taxAmount)}</span>
                    </div>
                  </>
                )}
                <div className="ve-totals-row grand">
                  <span className="ve-totals-label">Total</span>
                  <span className="ve-totals-value">{fmtMoney(e.total)}</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Notes & Terms */}
        {(e.notes || e.terms) && (
          <div className="ve-card">
            <div className="ve-card-header">Notes & Terms</div>
            <div className="ve-card-body">
              <div className="ve-grid ve-grid-2">
                <div className="ve-field">
                  <div className="ve-label">Notes</div>
                  <div className={`ve-notes-text${e.notes ? "" : " muted"}`}>
                    {e.notes || "—"}
                  </div>
                </div>
                <div className="ve-field">
                  <div className="ve-label">Terms</div>
                  <div className={`ve-notes-text${e.terms ? "" : " muted"}`}>
                    {e.terms || "—"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PDF Preview */}
        {pdfUrl && (
          <div className="ve-card">
            <div className="ve-card-header">
              <span>PDF Preview</span>
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ve-btn ve-btn-secondary"
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                Open in New Tab
              </a>
            </div>
            <iframe
              title="Estimate PDF Preview"
              src={pdfUrl + "#page=1&view=FitH"}
              className="ve-pdf-frame"
            />
          </div>
        )}
      </div>
    </div>
  );
}
