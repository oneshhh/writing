const express = require("express");

const router = express.Router();

router.post("/", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!process.env.DEPLOY_TOKEN) return res.status(501).json({ error: "DEPLOY_TOKEN not set" });
  if (!token || token !== process.env.DEPLOY_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  // Intentionally a stub: running shell scripts from the API is risky.
  return res.json({ ok: true, message: "Deploy endpoint configured (stub). Wire to deploy.sh on server." });
});

module.exports = router;

