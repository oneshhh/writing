const EMAIL_NOTIFICATIONS_ENABLED = String(process.env.ENABLE_EMAIL_NOTIFICATIONS || "").toLowerCase() === "true";

async function sendWriterNotificationEmail({ to, subject, text, html, meta } = {}) {
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    return {
      enabled: false,
      skipped: true,
      reason: "Email notifications are disabled. Configure SMTP and set ENABLE_EMAIL_NOTIFICATIONS=true to enable.",
      preview: { to: to || null, subject: subject || null, text: text || null, html: html || null, meta: meta || null }
    };
  }

  // Placeholder for future SMTP integration. Wire your transport here when the app email account is ready.
  return {
    enabled: true,
    skipped: true,
    reason: "SMTP transport placeholder is not configured yet.",
    preview: { to: to || null, subject: subject || null, text: text || null, html: html || null, meta: meta || null }
  };
}

module.exports = {
  EMAIL_NOTIFICATIONS_ENABLED,
  sendWriterNotificationEmail
};
