const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
require("dotenv").config();
require("./utils/runtimeConfig").loadRuntimeConfigIntoEnv();

const { authenticate } = require("./middleware/authenticate");
const { ensureAppReady, getSetupState } = require("./services/appSetup");

const authRoutes = require("./routes/auth");
const setupRoutes = require("./routes/setup");
const adminSettingsRoutes = require("./routes/adminSettings");
const usersRoutes = require("./routes/users");
const projectsRoutes = require("./routes/projects");
const articlesRoutes = require("./routes/articles");
const paymentsRoutes = require("./routes/payments");
const notificationsRoutes = require("./routes/notifications");
const exportRoutes = require("./routes/export");
const deployRoutes = require("./routes/deploy");
const profileRoutes = require("./routes/profile");
const requestsRoutes = require("./routes/requests");
const calendarRoutes = require("./routes/calendar");
const messagesRoutes = require("./routes/messages");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

const port = Number(process.env.PORT || 3000);
const allowedOrigins = String(process.env.CORS_ORIGINS || `http://localhost:${port}`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Serve the frontend (multi-page HTML) locally. Vercel serves backend/public
// directly from the CDN, while local dev falls back to ../frontend.
const publicDir = path.join(__dirname, "public");
const frontendDir = require("fs").existsSync(publicDir) ? publicDir : path.join(__dirname, "..", "frontend");
app.use(
  express.static(frontendDir, {
    setHeaders: (res, filePath) => {
      // Avoid confusing cache behavior during local dev.
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    }
  })
);

app.get("/", async (_req, res) => {
  try {
    const state = await ensureAppReady();
    return res.redirect(state.ready ? "/login.html" : "/setup.html");
  } catch {
    return res.redirect("/setup.html");
  }
});

app.get("/health", async (_req, res) => {
  try {
    const state = await ensureAppReady();
    return res.json({ ok: state.ready, setup: state });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Setup check failed" });
  }
});

app.use("/api/setup", setupRoutes);

app.use("/api", async (req, res, next) => {
  try {
    if (req.path.startsWith("/setup")) return next();
    const state = await ensureAppReady();
    if (state.ready) return next();
    return res.status(503).json({
      error: "The application setup is incomplete. Finish setup at /setup.html before using the API.",
      setup_required: true
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Setup status unavailable" });
  }
});

app.use("/api/auth", authenticate.optional, authRoutes);
app.use("/api/admin/settings", authenticate.required, adminSettingsRoutes);
app.use("/api/users", authenticate.required, usersRoutes);
app.use("/api/projects", authenticate.required, projectsRoutes);
app.use("/api/articles", authenticate.required, articlesRoutes);
app.use("/api/payments", authenticate.required, paymentsRoutes);
app.use("/api/notifications", authenticate.required, notificationsRoutes);
app.use("/api/export", authenticate.required, exportRoutes);
app.use("/api/profile", authenticate.required, profileRoutes);
app.use("/api/requests", authenticate.required, requestsRoutes);
app.use("/api/calendar", authenticate.required, calendarRoutes);
app.use("/api/messages", authenticate.required, messagesRoutes);
app.use("/api/deploy", deployRoutes);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-unused-vars
  const _next = next;
  const status = err.status || err.statusCode || 500;
  const safeMsg = status >= 500 ? "Server error" : err.message || "Error";
  res.status(status).json({ error: safeMsg });
});

if (!process.env.VERCEL) {
  ensureAppReady()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`Startup bootstrap warning: ${error.message || error}`);
    })
    .finally(() => {
      app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`API listening on http://localhost:${port}`);
      });
    });
}

module.exports = app;
