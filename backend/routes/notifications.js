const express = require("express");
const { getSupabaseAdmin } = require("../utils/supabase");

const router = express.Router();

router.get("/", async (req, res) => {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("notifications")
    .select("*")
    .eq("user_id", req.auth.user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ notifications: data });
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
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ notification: data });
});

module.exports = router;

