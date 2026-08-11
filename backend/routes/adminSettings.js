const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { buildSettingsPayload, createPaymentProofBucket, getSetupState, updateApplicationSettings } = require("../services/appSetup");

const router = express.Router();

router.use(authorizeRoles("admin"));

router.get("/", async (_req, res) => {
  try {
    const { config, secrets } = buildSettingsPayload();
    const state = await getSetupState({ refresh: true });
    return res.json({ config, secrets, state });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not load admin settings." });
  }
});

router.patch("/", async (req, res) => {
  try {
    const state = await updateApplicationSettings(req.body || {});
    const { config, secrets } = buildSettingsPayload();
    return res.json({ ok: true, config, secrets, state });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not save admin settings." });
  }
});

router.post("/payment-proof-bucket", async (_req, res) => {
  try {
    const result = await createPaymentProofBucket();
    const state = await getSetupState({ refresh: true });
    return res.json({ ok: true, created: result.created, bucket: result.bucket, state });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not create the payment proof bucket." });
  }
});

module.exports = router;
