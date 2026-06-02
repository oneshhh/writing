const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin, getSupabasePublic } = require("../utils/supabase");
const { buildUserUniqueId } = require("../utils/uniqueId");
const { setCookie, clearCookie } = require("../utils/httpCookies");

const router = express.Router();

const COOKIE_ACCESS = "rw_at";
const COOKIE_REFRESH = "rw_rt";
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);

function cookieOpts() {
  const secure = String(process.env.NODE_ENV || "development") === "production";
  return { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAgeMs: SESSION_MAX_AGE_MS };
}

router.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (email.length > 320 || password.length > 1024) return res.status(400).json({ error: "Invalid input" });

  try {
    const sb = getSupabasePublic();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data?.session?.access_token) return res.status(401).json({ error: "Wrong credentials." });

    const opts = cookieOpts();
    setCookie(res, COOKIE_ACCESS, data.session.access_token, opts);
    setCookie(res, COOKIE_REFRESH, data.session.refresh_token, opts);

    return res.json({ ok: true });
  } catch (_e) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/logout", async (_req, res) => {
  const opts = cookieOpts();
  clearCookie(res, COOKIE_ACCESS, opts);
  clearCookie(res, COOKIE_REFRESH, opts);
  return res.json({ ok: true });
});

// Admin creates an app user row (Supabase auth user should already exist, or you can extend this later)
router.post("/register", authorizeRoles("admin"), async (req, res) => {
  const { id, email, full_name, role, avatar_url } = req.body || {};
  if (!id || !email || !full_name || !role) {
    return res.status(400).json({ error: "id, email, full_name, role are required" });
  }
  if (!["admin", "manager", "writer"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  const db = getSupabaseAdmin();

  const { count, error: countErr } = await db
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("role", role);
  if (countErr) return res.status(400).json({ error: countErr.message });
  const unique_id = buildUserUniqueId(role, (count || 0) + 1);

  const { data, error } = await db
    .from("users")
    .insert([
      {
        id,
        unique_id,
        email,
        full_name,
        role,
        avatar_url: avatar_url || null
      }
    ])
    .select("*")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  return res.json({ user: data });
});

router.get("/me", async (req, res) => {
  if (!req.auth?.user) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ user: req.auth.user });
});

module.exports = router;
