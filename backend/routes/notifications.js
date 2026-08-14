const express = require("express");
const { getSupabaseAdmin } = require("../utils/supabase");
const { isMissingNotificationsTableError } = require("../utils/notificationSupport");

const router = express.Router();

router.get("/", async (req, res) => {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("notifications")
    .select("*")
    .eq("user_id", req.auth.user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingNotificationsTableError(error)) {
      return res.json({ notifications: [], unavailable: true });
    }
    return res.status(400).json({ error: error.message });
  }
  return res.json({ notifications: data });
});

router.get("/unread-count", async (req, res) => {
  const db = getSupabaseAdmin();
  const { count, error } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", req.auth.user.id)
    .eq("read", false);
  if (error) {
    if (isMissingNotificationsTableError(error)) {
      return res.json({ unread: 0, unavailable: true });
    }
    return res.status(400).json({ error: error.message });
  }
  return res.json({ unread: Number(count || 0) });
});

router.patch("/:id/read", async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("notifications")
    .update({ read: true })
    .eq("id", id)
    .eq("user_id", req.auth.user.id)
    .select("*")
    .single();
  if (error) {
    if (isMissingNotificationsTableError(error)) {
      return res.json({ notification: null, unavailable: true });
    }
    return res.status(400).json({ error: error.message });
  }
  return res.json({ notification: data });
});

module.exports = router;
