const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
require("dotenv").config();

const { authenticate } = require("./middleware/authenticate");

const authRoutes = require("./routes/auth");
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
app.get("/", (req, res) => res.redirect("/login.html"));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authenticate.optional, authRoutes);
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
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://localhost:${port}`);
  });
}

module.exports = app;
