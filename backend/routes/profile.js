const express = require("express");
const { getSupabaseAdmin, getSupabasePublic } = require("../utils/supabase");
const { setCookie } = require("../utils/httpCookies");

const router = express.Router();

const COOKIE_ACCESS = "rw_at";
const COOKIE_REFRESH = "rw_rt";
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

function cookieOpts() {
  const secure = String(process.env.NODE_ENV || "development") === "production";
  return { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAgeMs: SESSION_MAX_AGE_MS };
}

function setSessionCookies(res, { accessToken, refreshToken }) {
  const opts = cookieOpts();
  if (accessToken) setCookie(res, COOKIE_ACCESS, accessToken, opts);
  if (refreshToken) setCookie(res, COOKIE_REFRESH, refreshToken, opts);
}

function firstNameFrom(fullName) {
  return String(fullName || "").trim().split(/\s+/).filter(Boolean)[0] || "";
}

function isSecurePasswordRequest(req) {
  if (String(process.env.NODE_ENV || "development") !== "production") return true;
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

function validatePassword(password, user) {
  const value = String(password || "");
  const lower = value.toLowerCase();
  const email = String(user.email || "").toLowerCase();
  const emailName = email.split("@")[0] || "";
  const nameParts = String(user.full_name || "")
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
  const weakTerms = ["password", "qwerty", "welcome", "letmein", "admin", "realwrite"];

  const checks = [
    { ok: value.length >= PASSWORD_MIN_LENGTH, message: `Use at least ${PASSWORD_MIN_LENGTH} characters.` },
    { ok: value.length <= PASSWORD_MAX_LENGTH, message: `Use no more than ${PASSWORD_MAX_LENGTH} characters.` },
    { ok: !/\s/.test(value), message: "Do not use spaces." },
    { ok: /[a-z]/.test(value), message: "Add a lowercase letter." },
    { ok: /[A-Z]/.test(value), message: "Add an uppercase letter." },
    { ok: /\d/.test(value), message: "Add a number." },
    { ok: /[^A-Za-z0-9]/.test(value), message: "Add a symbol." },
    { ok: !emailName || emailName.length < 3 || !lower.includes(emailName), message: "Do not include your email name." },
    { ok: !nameParts.some((part) => lower.includes(part)), message: "Do not include your name." },
    { ok: !weakTerms.some((term) => lower.includes(term)), message: "Avoid common password words." }
  ];

  return checks.filter((check) => !check.ok).map((check) => check.message);
}

router.get("/", async (req, res) => {
  const user = req.auth.user;
  return res.json({
    profile: {
      id: user.id,
      unique_id: user.unique_id,
      email: user.email,
      first_name: firstNameFrom(user.full_name),
      full_name: user.full_name,
      role: user.role
    }
  });
});

router.patch("/password", async (req, res) => {
  if (!isSecurePasswordRequest(req)) {
    return res.status(403).json({ error: "Password changes require HTTPS." });
  }

  const currentPassword = String(req.body?.current_password || "");
  const newPassword = String(req.body?.new_password || "");
  const confirmPassword = String(req.body?.confirm_password || "");
  const user = req.auth.user;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: "Current password, new password, and confirmation are required." });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "New password and confirmation do not match." });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: "New password must be different from your current password." });
  }

  const problems = validatePassword(newPassword, user);
  if (problems.length) return res.status(400).json({ error: problems[0], problems });

  const publicAuth = getSupabasePublic();
  const verified = await publicAuth.auth.signInWithPassword({ email: user.email, password: currentPassword });
  if (verified.error || !verified.data?.user?.id || verified.data.user.id !== user.id) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const adminAuth = getSupabaseAdmin();
  const { error } = await adminAuth.auth.admin.updateUserById(user.id, { password: newPassword });
  if (error) return res.status(400).json({ error: error.message });

  const refreshed = await publicAuth.auth.signInWithPassword({ email: user.email, password: newPassword });
  if (refreshed.data?.session?.access_token) {
    setSessionCookies(res, {
      accessToken: refreshed.data.session.access_token,
      refreshToken: refreshed.data.session.refresh_token
    });
  }

  return res.json({ ok: true });
});

module.exports = router;
