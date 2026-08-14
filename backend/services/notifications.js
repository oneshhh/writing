const { getSupabaseAdmin } = require("../utils/supabase");
const { isMissingNotificationsTableError } = require("../utils/notificationSupport");

async function createNotification({ user_id, type, title, body, payload }) {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("notifications")
    .insert([{ user_id, type, title, body, payload: payload || null }])
    .select("*")
    .single();
  if (error) {
    if (isMissingNotificationsTableError(error)) return null;
    throw new Error(error.message);
  }
  return data;
}

module.exports = { createNotification };
