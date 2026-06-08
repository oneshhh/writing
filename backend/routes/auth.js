const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin, getSupabasePublic } = require("../utils/supabase");
const { buildUserUniqueId } = require("../utils/uniqueId");
const { setCookie, clearCookie } = require("../utils/httpCookies");

const router = express.Router();

const COOKIE_ACCESS = "rw_at";
const COOKIE_REFRESH = "rw_rt";
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const USER_ID_PREFIX_BY_ROLE = { admin: "ADM", manager: "MGR", writer: "WRT" };

function cookieOpts() {
  const secure = String(process.env.NODE_ENV || "development") === "production";
  return { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAgeMs: SESSION_MAX_AGE_MS };
}

async function nextUserUniqueId(db, role) {
  const prefix = USER_ID_PREFIX_BY_ROLE[role];
  const { data, error } = await db
    .from("users")
    .select("unique_id")
    .eq("role", role)
    .ilike("unique_id", `${prefix}-%`);
  if (error) throw error;

  const maxSeq = (data || []).reduce((max, row) => {
    const raw = String(row.unique_id || "");
    if (!raw.startsWith(`${prefix}-`)) return max;
    const seq = Number(raw.slice(prefix.length + 1));
    return Number.isInteger(seq) && seq > max ? seq : max;
  }, 0);

  return buildUserUniqueId(role, maxSeq + 1);
}

function isUniqueConstraintError(error) {
  const msg = String(error?.message || "");
  return error?.code === "23505" || msg.includes("duplicate key value") || msg.includes("users_unique_id_key");
}

function isUserUniqueIdError(error) {
  const msg = String(error?.message || "");
  const details = String(error?.details || "");
  return msg.includes("users_unique_id_key") || details.includes("users_unique_id_key");
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
  const { id, full_name, role, avatar_url } = req.body || {};
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!id || !email || !full_name || !role) {
    return res.status(400).json({ error: "id, email, full_name, role are required" });
  }
  if (!["admin", "manager", "writer"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  const db = getSupabaseAdmin();
  const [byId, byEmail] = await Promise.all([
    db.from("users").select("id").eq("id", id).limit(1),
    db.from("users").select("id").eq("email", email).limit(1)
  ]);
  const lookupErr = byId.error || byEmail.error;
  if (lookupErr) return res.status(400).json({ error: lookupErr.message });
  if ((byId.data || []).length) {
    return res.status(409).json({ error: "This Supabase Auth user already has an app user row." });
  }
  if ((byEmail.data || []).length) {
    return res.status(409).json({ error: "This email already has an app user row." });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let unique_id;
    try {
      unique_id = await nextUserUniqueId(db, role);
    } catch (e) {
      return res.status(400).json({ error: e.message || "Could not generate user ID" });
    }

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

    if (!error) return res.json({ user: data });
    if (isUserUniqueIdError(error)) continue;
    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ error: "This Supabase Auth user or email already has an app user row." });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(409).json({ error: "Could not create a unique user ID. Please try again." });
});

router.get("/me", async (req, res) => {
  if (!req.auth?.user) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ user: req.auth.user });
});

module.exports = router;
