// File: src/SendEmailModal.js
import React, { useEffect, useState, useCallback, useRef } from "react";
import api from "./api";
import "./SendEmailModal.css";

export default function SendEmailModal({
  isOpen,
  onClose,
  type = "estimate",       // 'estimate' | 'invoice' | 'payment_reminder'
  entityId,
  entityData,
  customerEmail = "",
  customerName = "",
  onSent,
}) {
  const [recipientEmail, setRecipientEmail] = useState(customerEmail || "");
  const [recipientName, setRecipientName] = useState(customerName || "");
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachmentName, setAttachmentName] = useState("");
  const [saveEmail, setSaveEmail] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const templateType = type === "payment_reminder" ? "payment_reminder" : type;

  // Use refs to avoid stale closures in loadPreview without causing re-render loops
  const recipientEmailRef = useRef(recipientEmail);
  const recipientNameRef = useRef(recipientName);
  recipientEmailRef.current = recipientEmail;
  recipientNameRef.current = recipientName;

  const loadPreview = useCallback(async (tmplId) => {
    try {
      const res = await api.post("/email/preview", {
        templateId: tmplId || undefined,
        type: templateType,
        entityId,
      });
      setSubject(res.data.subject || "");
      setBody(res.data.body || "");
      if (res.data.recipientEmail && !recipientEmailRef.current) {
        setRecipientEmail(res.data.recipientEmail);
      }
      if (res.data.recipientName && !recipientNameRef.current) {
        setRecipientName(res.data.recipientName);
      }
      const entityType = type === "payment_reminder" ? "invoice" : type;
      setAttachmentName(res.data.attachmentName || `${entityType}_${entityId}.pdf`);
    } catch (err) {
      console.error("Error loading preview:", err);
    }
  }, [type, templateType, entityId]);

  // Initialize state and load templates when modal opens
  useEffect(() => {
    if (!isOpen) {
      setLoaded(false);
      return;
    }
    setRecipientEmail(customerEmail || "");
    setRecipientName(customerName || "");
    setError("");
    setSaveEmail(false);
    setSending(false);

    // Load templates
    api.get(`/email-templates?type=${templateType}`)
      .then((res) => {
        const tmpls = Array.isArray(res.data) ? res.data : [];
        setTemplates(tmpls);
        const def = tmpls.find((t) => t.isDefault) || tmpls[0];
        const defId = def ? String(def.id) : "";
        setSelectedTemplateId(defId);
        return loadPreview(defId);
      })
      .then(() => setLoaded(true))
      .catch((err) => {
        console.error("Error loading templates:", err);
        setLoaded(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, customerEmail, customerName, templateType, entityId]);

  const handleTemplateChange = (e) => {
    const newId = e.target.value;
    setSelectedTemplateId(newId);
    loadPreview(newId);
  };

  const handleSend = async () => {
    if (!recipientEmail || !recipientEmail.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    setError("");
    setSending(true);

    try {
      let endpoint;
      if (type === "estimate") {
        endpoint = `/email/send-estimate/${entityId}`;
      } else if (type === "invoice") {
        endpoint = `/email/send-invoice/${entityId}`;
      } else {
        endpoint = `/email/send-reminder/${entityId}`;
      }

      await api.post(endpoint, {
        recipientEmail,
        recipientName,
        subject,
        body,
        templateId: selectedTemplateId || undefined,
        saveEmail,
      });

      onSent && onSent();
      onClose();
    } catch (err) {
      console.error("Error sending email:", err);
      setError(err.response?.data?.error || err.message || "Failed to send email.");
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  const titleMap = {
    estimate: "Send Estimate via Email",
    invoice: "Send Invoice via Email",
    payment_reminder: "Send Payment Reminder",
  };

  return (
    <div className="sem-overlay" onClick={onClose}>
      <div className="sem-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sem-header">
          <h3>{titleMap[type] || "Send Email"}</h3>
          <button className="sem-close-btn" onClick={onClose}>&times;</button>
        </div>

        {/* Body */}
        <div className="sem-body">
          {error && <div className="sem-error">{error}</div>}

          {/* TO */}
          <div className="sem-field">
            <label className="sem-label">To</label>
            <input
              type="email"
              className={`sem-input${!recipientEmail && loaded ? " sem-invalid" : ""}`}
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="customer@email.com"
              autoFocus
            />
            {!customerEmail && (
              <div className="sem-checkbox-row">
                <input
                  type="checkbox"
                  id="sem-save-email"
                  checked={saveEmail}
                  onChange={(e) => setSaveEmail(e.target.checked)}
                />
                <label htmlFor="sem-save-email">Save email to customer profile</label>
              </div>
            )}
          </div>

          {/* Template */}
          {templates.length > 0 && (
            <div className="sem-field">
              <label className="sem-label">Template</label>
              <select
                className="sem-input sem-select"
                value={selectedTemplateId}
                onChange={handleTemplateChange}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}{t.isDefault ? " (Default)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Subject */}
          <div className="sem-field">
            <label className="sem-label">Subject</label>
            <input
              type="text"
              className="sem-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject..."
            />
          </div>

          {/* Body */}
          <div className="sem-field">
            <label className="sem-label">Message</label>
            <textarea
              className="sem-input sem-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Email body..."
            />
          </div>

          {/* Attachment */}
          {attachmentName && (
            <div className="sem-field">
              <label className="sem-label">Attachment</label>
              <div className="sem-attachment">
                <span className="sem-attachment-icon">📎</span>
                <span className="sem-attachment-name">{attachmentName}</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sem-footer">
          <button className="sem-btn sem-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="sem-btn sem-btn-send"
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? "Sending..." : "Send Email"}
          </button>
        </div>
      </div>
    </div>
  );
}
