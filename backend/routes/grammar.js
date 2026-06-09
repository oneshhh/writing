const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");

const router = express.Router();
const MAX_TEXT_LENGTH = Number(process.env.GRAMMAR_MAX_TEXT_LENGTH || 20000);
const REQUEST_TIMEOUT_MS = Number(process.env.GRAMMAR_TIMEOUT_MS || 8000);

function normalizeLanguageToolUrl(rawUrl) {
  const base = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return base.endsWith("/v2/check") ? base : `${base}/v2/check`;
}

router.post("/check", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const languageToolUrl = normalizeLanguageToolUrl(process.env.LANGUAGETOOL_URL);
  if (!languageToolUrl) {
    return res.json({ enabled: false, matches: [], error: "LanguageTool is not configured." });
  }

  const text = String(req.body?.text || "");
  const language = String(req.body?.language || "en-US").trim() || "en-US";
  if (!text.trim()) return res.json({ enabled: true, matches: [] });
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(413).json({ error: `Text is too long for one grammar check. Limit is ${MAX_TEXT_LENGTH} characters.` });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const form = new URLSearchParams();
    form.set("text", text);
    form.set("language", language);

    const response = await fetch(languageToolUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({ error: body?.message || `LanguageTool failed (${response.status})` });
    }

    const matches = Array.isArray(body.matches) ? body.matches : [];
    return res.json({ enabled: true, matches });
  } catch (e) {
    const message = e?.name === "AbortError" ? "LanguageTool request timed out." : e.message || "LanguageTool is unavailable.";
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
