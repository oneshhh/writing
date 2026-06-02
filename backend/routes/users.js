const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");

const router = express.Router();

router.get("/writers", authorizeRoles("manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const q = String(req.query.q || "").trim();

  let query = db
    .from("users")
    .select("id,unique_id,email,full_name,role,avatar_url,created_at,is_active")
    .eq("role", "writer")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (q) {
    // Best-effort search across name/email.
    // Supabase JS doesn't support OR across columns without raw filters, so do 2 queries and union client-side.
    const [byName, byEmail] = await Promise.all([
      db
        .from("users")
        .select("id,unique_id,email,full_name,role,avatar_url,created_at,is_active")
        .eq("role", "writer")
        .eq("is_active", true)
        .ilike("full_name", `%${q}%`)
        .order("created_at", { ascending: false }),
      db
        .from("users")
        .select("id,unique_id,email,full_name,role,avatar_url,created_at,is_active")
        .eq("role", "writer")
        .eq("is_active", true)
        .ilike("email", `%${q}%`)
        .order("created_at", { ascending: false })
    ]);
    const err = byName.error || byEmail.error;
    if (err) return res.status(400).json({ error: err.message });
    const all = [...(byName.data || []), ...(byEmail.data || [])];
    const dedup = new Map(all.map((u) => [u.id, u]));
    return res.json({ users: Array.from(dedup.values()) });
  }

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ users: data });
});

router.get("/", authorizeRoles("admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("users")
    .select("id,unique_id,email,full_name,role,avatar_url,created_at,is_active")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ users: data });
});

router.get("/by-ids", authorizeRoles("admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const idsRaw = String(req.query.ids || "").trim();
  if (!idsRaw) return res.json({ users: [] });
  const ids = Array.from(new Set(idsRaw.split(",").map((x) => x.trim()).filter(Boolean)));
  if (!ids.length) return res.json({ users: [] });
  const { data, error } = await db
    .from("users")
    .select("id,email,full_name,role,is_active")
    .in("id", ids);
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ users: data });
});

router.patch("/:id/status", authorizeRoles("admin"), async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body || {};
  if (typeof is_active !== "boolean") return res.status(400).json({ error: "is_active must be boolean" });
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("users")
    .update({ is_active })
    .eq("id", id)
    .select("id,is_active")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ user: data });
});

module.exports = router;
