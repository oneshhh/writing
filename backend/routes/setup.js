const express = require("express");
const { bootstrapAdmin, configureApplication, ensureAppReady, getSetupState } = require("../services/appSetup");

const router = express.Router();

router.get("/status", async (_req, res) => {
  try {
    const state = await getSetupState({ refresh: true });
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not inspect setup status." });
  }
});

router.post("/configure", async (req, res) => {
  try {
    const current = await getSetupState({ refresh: true });
    if (current.setup_locked) {
      return res.status(409).json({ error: "Setup is already complete for this workspace." });
    }

    await configureApplication(req.body || {});

    let admin = null;
    if (req.body?.admin_email || req.body?.admin_password || req.body?.admin_full_name) {
      admin = await bootstrapAdmin({
        email: String(req.body?.admin_email || "").trim().toLowerCase(),
        password: String(req.body?.admin_password || ""),
        fullName: String(req.body?.admin_full_name || "").trim()
      });
    }

    const state = await ensureAppReady({ refresh: true });
    return res.json({
      ok: true,
      admin_created: Boolean(admin),
      state
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not save setup configuration." });
  }
});

router.post("/bootstrap-admin", async (req, res) => {
  try {
    const state = await getSetupState({ refresh: true });
    if (!state.supabase_configured || !state.database_configured || !state.schema_ready) {
      return res.status(400).json({ error: "Configure the deployment and create the schema before creating an admin." });
    }
    if (state.admin_exists) {
      return res.status(409).json({ error: "An admin account already exists." });
    }

    const result = await bootstrapAdmin({
      email: String(req.body?.admin_email || "").trim().toLowerCase(),
      password: String(req.body?.admin_password || ""),
      fullName: String(req.body?.admin_full_name || "").trim()
    });
    const nextState = await ensureAppReady({ refresh: true });
    return res.json({ ok: true, admin: result.appUser, state: nextState });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not create the admin account." });
  }
});

module.exports = router;
