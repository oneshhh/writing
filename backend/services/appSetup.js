const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { buildUserUniqueId } = require("../utils/uniqueId");
const {
  getRuntimeConfigPath,
  hasRuntimeConfigFile,
  loadRuntimeConfigIntoEnv,
  saveRuntimeConfig
} = require("../utils/runtimeConfig");
const { getSupabaseAdmin } = require("../utils/supabase");

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
const APP_SETUP_CACHE_TTL_MS = 8000;

let cachedState = null;
let cachedAt = 0;
let setupPromise = null;

function trimOrNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function hasSupabaseConfig() {
  return Boolean(trimOrNull(process.env.SUPABASE_URL) && trimOrNull(process.env.SUPABASE_ANON_KEY) && trimOrNull(process.env.SUPABASE_SERVICE_ROLE_KEY));
}

function hasDatabaseConfig() {
  if (trimOrNull(process.env.DATABASE_URL)) return true;
  return Boolean(
    trimOrNull(process.env.DB_HOST) &&
      trimOrNull(process.env.DB_PORT) &&
      trimOrNull(process.env.DB_USER) &&
      trimOrNull(process.env.DB_PASSWORD) &&
      trimOrNull(process.env.DB_NAME)
  );
}

function buildDatabaseConnectionOptions() {
  const connectionString = trimOrNull(process.env.DATABASE_URL);
  const sslMode = String(process.env.DB_SSL || "").trim().toLowerCase();
  const ssl =
    sslMode === "require" || sslMode === "true"
      ? { rejectUnauthorized: false }
      : sslMode === "disable" || sslMode === "false" || !sslMode
        ? false
        : { rejectUnauthorized: false };

  if (connectionString) {
    return { connectionString, ssl };
  }

  return {
    host: trimOrNull(process.env.DB_HOST),
    port: Number(process.env.DB_PORT || 5432),
    user: trimOrNull(process.env.DB_USER),
    password: trimOrNull(process.env.DB_PASSWORD),
    database: trimOrNull(process.env.DB_NAME),
    ssl
  };
}

async function withPgClient(callback) {
  const client = new Client(buildDatabaseConnectionOptions());
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function tableExists(client, tableName) {
  const out = await client.query("select to_regclass($1) as table_name", [`public.${tableName}`]);
  return Boolean(out.rows?.[0]?.table_name);
}

async function getAdminCount() {
  const db = getSupabaseAdmin();
  const { count, error } = await db.from("users").select("id", { count: "exact", head: true }).eq("role", "admin");
  if (error) throw new Error(error.message);
  return Number(count || 0);
}

async function nextAdminUniqueId(db) {
  const { data, error } = await db.from("users").select("unique_id").eq("role", "admin").ilike("unique_id", "ADM-%");
  if (error) throw new Error(error.message);
  const maxSeq = (data || []).reduce((max, row) => {
    const raw = String(row.unique_id || "");
    if (!raw.startsWith("ADM-")) return max;
    const seq = Number(raw.slice(4));
    return Number.isInteger(seq) && seq > max ? seq : max;
  }, 0);
  return buildUserUniqueId("admin", maxSeq + 1);
}

async function findAuthUserByEmail(db, email) {
  let page = 1;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  while (page <= 20) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const users = data?.users || [];
    const match = users.find((user) => String(user.email || "").trim().toLowerCase() === normalizedEmail);
    if (match) return match;
    if (users.length < 200) break;
    page += 1;
  }
  return null;
}

async function upsertAdminAppUser(db, authUser, fullName) {
  const email = String(authUser?.email || "").trim().toLowerCase();
  if (!authUser?.id || !email) throw new Error("Supabase auth user is missing required fields.");

  const { data: existingById, error: byIdErr } = await db.from("users").select("*").eq("id", authUser.id).maybeSingle();
  if (byIdErr) throw new Error(byIdErr.message);
  if (existingById) {
    const { data, error } = await db
      .from("users")
      .update({
        email,
        full_name: fullName || existingById.full_name,
        role: "admin",
        is_active: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", authUser.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const uniqueId = await nextAdminUniqueId(db);
  const { data, error } = await db
    .from("users")
    .insert([
      {
        id: authUser.id,
        unique_id: uniqueId,
        email,
        full_name: fullName,
        role: "admin",
        is_active: true
      }
    ])
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function ensureStorageBucket() {
  const db = getSupabaseAdmin();
  try {
    const { error } = await db.storage.createBucket("payment-proofs", {
      public: true,
      fileSizeLimit: 5242880,
      allowedMimeTypes: ["image/png", "image/jpeg", "application/pdf"]
    });
    if (error && !String(error.message || "").toLowerCase().includes("already")) throw new Error(error.message);
    return true;
  } catch (error) {
    const message = String(error?.message || "");
    if (message.toLowerCase().includes("already")) return true;
    return false;
  }
}

async function ensureDatabaseSchema() {
  if (!hasDatabaseConfig()) throw new Error("Missing database connection details.");
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await withPgClient(async (client) => {
    await client.query(sql);
  });
  return true;
}

async function bootstrapAdmin({ email, password, fullName }) {
  if (!hasSupabaseConfig()) throw new Error("Supabase must be configured before creating an admin account.");
  if (!email || !password || !fullName) throw new Error("Admin full name, email, and password are required.");
  const db = getSupabaseAdmin();

  const currentAdminCount = await getAdminCount();
  if (currentAdminCount > 0) {
    throw new Error("An admin account already exists for this workspace.");
  }

  let authUser = await findAuthUserByEmail(db, email);
  if (!authUser) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName }
    });
    if (error) throw new Error(error.message);
    authUser = data?.user || null;
  }

  if (!authUser) throw new Error("Could not create the admin auth user.");
  const appUser = await upsertAdminAppUser(db, authUser, fullName);
  invalidateSetupState();
  return { authUser, appUser };
}

function buildConfigFromPayload(payload) {
  const config = {
    APP_NAME: trimOrNull(payload.app_name) || trimOrNull(process.env.APP_NAME) || "Real Write",
    APP_URL: trimOrNull(payload.app_url),
    CORS_ORIGINS: trimOrNull(payload.cors_origins),
    SUPABASE_URL: trimOrNull(payload.supabase_url),
    SUPABASE_ANON_KEY: trimOrNull(payload.supabase_anon_key),
    SUPABASE_SERVICE_ROLE_KEY: trimOrNull(payload.supabase_service_role_key),
    SUPABASE_JWT_AUD: trimOrNull(payload.supabase_jwt_aud) || "authenticated",
    DATABASE_URL: trimOrNull(payload.database_url),
    DB_HOST: trimOrNull(payload.db_host),
    DB_PORT: trimOrNull(payload.db_port),
    DB_USER: trimOrNull(payload.db_user),
    DB_PASSWORD: trimOrNull(payload.db_password),
    DB_NAME: trimOrNull(payload.db_name),
    DB_SSL: trimOrNull(payload.db_ssl),
    HUGGINGFACE_API_TOKEN: trimOrNull(payload.huggingface_api_token),
    AI_DETECTOR_MODEL: trimOrNull(payload.ai_detector_model),
    DEPLOY_TOKEN: trimOrNull(payload.deploy_token)
  };

  if (!config.CORS_ORIGINS && config.APP_URL) config.CORS_ORIGINS = config.APP_URL;
  return config;
}

function validateConfig(config) {
  if (!trimOrNull(config.SUPABASE_URL)) throw new Error("Supabase URL is required.");
  if (!trimOrNull(config.SUPABASE_ANON_KEY)) throw new Error("Supabase anon key is required.");
  if (!trimOrNull(config.SUPABASE_SERVICE_ROLE_KEY)) throw new Error("Supabase service role key is required.");

  const hasDbUrl = trimOrNull(config.DATABASE_URL);
  const hasDbFields = trimOrNull(config.DB_HOST) && trimOrNull(config.DB_PORT) && trimOrNull(config.DB_USER) && trimOrNull(config.DB_PASSWORD) && trimOrNull(config.DB_NAME);
  if (!hasDbUrl && !hasDbFields) {
    throw new Error("Provide either DATABASE_URL or the database host, port, user, password, and database name.");
  }
}

async function configureApplication(payload) {
  const config = buildConfigFromPayload(payload);
  validateConfig(config);
  saveRuntimeConfig(config);
  loadRuntimeConfigIntoEnv({ overwrite: true });
  await ensureAppReady({ refresh: true });
  return config;
}

async function maybeBootstrapAdminFromEnv() {
  const email = trimOrNull(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = trimOrNull(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  const fullName = trimOrNull(process.env.BOOTSTRAP_ADMIN_FULL_NAME);
  if (!email || !password || !fullName) return false;

  try {
    const adminCount = await getAdminCount();
    if (adminCount > 0) return false;
    await bootstrapAdmin({ email, password, fullName });
    return true;
  } catch {
    return false;
  }
}

async function computeSetupState() {
  loadRuntimeConfigIntoEnv();

  const issues = [];
  const runtimeConfigFile = hasRuntimeConfigFile();
  const supabaseConfigured = hasSupabaseConfig();
  const databaseConfigured = hasDatabaseConfig();
  let schemaReady = false;
  let adminExists = false;
  let storageReady = false;

  if (!supabaseConfigured) issues.push("Supabase credentials are missing.");
  if (!databaseConfigured) issues.push("Database connection details are missing.");

  if (databaseConfigured) {
    try {
      schemaReady = await withPgClient(async (client) => tableExists(client, "users"));
      if (!schemaReady) issues.push("Application tables have not been created yet.");
    } catch (error) {
      issues.push(error.message || "Could not reach the configured database.");
    }
  }

  if (supabaseConfigured && schemaReady) {
    try {
      adminExists = (await getAdminCount()) > 0;
      if (!adminExists) issues.push("No admin account exists yet.");
    } catch (error) {
      issues.push(error.message || "Could not inspect application users.");
    }

    try {
      storageReady = await ensureStorageBucket();
    } catch {
      storageReady = false;
    }
  }

  return {
    app_name: trimOrNull(process.env.APP_NAME) || "Real Write",
    app_url: trimOrNull(process.env.APP_URL),
    config_path: getRuntimeConfigPath(),
    runtime_config_file: runtimeConfigFile,
    supabase_configured: supabaseConfigured,
    database_configured: databaseConfigured,
    schema_ready: schemaReady,
    storage_ready: storageReady,
    admin_exists: adminExists,
    ready: supabaseConfigured && databaseConfigured && schemaReady && adminExists,
    setup_locked: supabaseConfigured && databaseConfigured && schemaReady && adminExists,
    issues
  };
}

function invalidateSetupState() {
  cachedState = null;
  cachedAt = 0;
}

async function getSetupState({ refresh = false } = {}) {
  if (!refresh && cachedState && Date.now() - cachedAt < APP_SETUP_CACHE_TTL_MS) {
    return cachedState;
  }
  const state = await computeSetupState();
  cachedState = state;
  cachedAt = Date.now();
  return state;
}

async function ensureAppReady({ refresh = false } = {}) {
  if (!refresh && setupPromise) return setupPromise;
  setupPromise = (async () => {
    loadRuntimeConfigIntoEnv();
    if (hasSupabaseConfig() && hasDatabaseConfig()) {
      await ensureDatabaseSchema();
      await ensureStorageBucket();
      await maybeBootstrapAdminFromEnv();
    }
    const state = await getSetupState({ refresh: true });
    return state;
  })();

  try {
    return await setupPromise;
  } finally {
    setupPromise = null;
  }
}

module.exports = {
  bootstrapAdmin,
  configureApplication,
  ensureAppReady,
  getSetupState,
  invalidateSetupState
};
