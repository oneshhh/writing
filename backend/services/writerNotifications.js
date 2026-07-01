const { createNotification } = require("./notifications");
const { sendWriterNotificationEmail } = require("./emailNotifications");

async function notifyWriter({
  userId,
  email,
  type,
  title,
  body,
  payload,
  emailSubject,
  emailText,
  emailHtml
}) {
  const notification = await createNotification({
    user_id: userId,
    type,
    title,
    body,
    payload: payload || null
  });

  await sendWriterNotificationEmail({
    to: email || null,
    subject: emailSubject || title,
    text: emailText || body,
    html: emailHtml || null,
    meta: { notification_id: notification.id, user_id: userId, type, payload: payload || null }
  });

  return notification;
}

module.exports = {
  notifyWriter
};
