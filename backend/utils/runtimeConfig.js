const fs = require("fs");
const path = require("path");

const CONFIG_PATH = process.env.RUNTIME_CONFIG_PATH
  ? path.resolve(process.env.RUNTIME_CONFIG_PATH)
  : path.join(__dirname, "..", ".runtime-config.json");

const PERSISTED_KEYS = [
  "APP_NAME",
  "APP_URL",
  "CORS_ORIGINS",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_AUD",
  "DATABASE_URL",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "DB_SSL",
  "HUGGINGFACE_API_TOKEN",
  "HF_TOKEN",
  "AI_DETECTOR_MODEL",
  "DEPLOY_TOKEN",
  "PAYMENT_PROOF_BUCKET",
  "PAYMENT_PROOF_UPLOADS_ENABLED"
];

function hasRuntimeConfigFile() {
  return fs.existsSync(CONFIG_PATH);
}

function readRuntimeConfig() {
  if (!hasRuntimeConfigFile()) return {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadRuntimeConfigIntoEnv({ overwrite = false } = {}) {
  const config = readRuntimeConfig();
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === "") continue;
    if (!overwrite && process.env[key]) continue;
    process.env[key] = String(value);
  }
  return config;
}

function sanitizePersistedConfig(input) {
  const out = {};
  for (const key of PERSISTED_KEYS) {
    const value = input?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    out[key] = text;
  }
  return out;
}

function saveRuntimeConfig(input) {
  const payload = sanitizePersistedConfig(input);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function getRuntimeConfigPath() {
  return CONFIG_PATH;
}

module.exports = {
  getRuntimeConfigPath,
  hasRuntimeConfigFile,
  loadRuntimeConfigIntoEnv,
  readRuntimeConfig,
  saveRuntimeConfig,
  sanitizePersistedConfig
};
