const { getSupabaseAdmin, getSupabasePublic } = require("../utils/supabase");
const { parseCookies, setCookie } = require("../utils/httpCookies");

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const parts = header.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
}

const COOKIE_ACCESS = "rw_at";
const COOKIE_REFRESH = "rw_rt";
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);

function cookieOpts() {
  const secure = String(process.env.NODE_ENV || "development") === "production";
  return { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAgeMs: SESSION_MAX_AGE_MS };
}

function getCookieTokens(req) {
  const cookies = parseCookies(req.headers.cookie);
  return { accessToken: cookies[COOKIE_ACCESS] || null, refreshToken: cookies[COOKIE_REFRESH] || null };
}

function setSessionCookies(res, { accessToken, refreshToken }) {
  const opts = cookieOpts();
  if (accessToken) setCookie(res, COOKIE_ACCESS, accessToken, opts);
  if (refreshToken) setCookie(res, COOKIE_REFRESH, refreshToken, opts);
}

async function verifySupabaseJwt(token) {
  // Validate the access token via Supabase Auth using the service role key.
  // This avoids using JWT secrets and avoids JWKS fetch issues.
  const db = getSupabaseAdmin();
  const { data, error } = await db.auth.getUser(token);
  if (error) throw new Error(error.message || "Invalid token");
  if (!data?.user?.id) throw new Error("Invalid token");
  return { sub: data.user.id };
}

async function loadAppUser(db, userId) {
  const { data, error } = await db.from("users").select("*").eq("id", userId).single();
  if (error) return null;
  return data;
}

async function refreshSessionFromCookie(req, res) {
  const { refreshToken } = getCookieTokens(req);
  if (!refreshToken) return null;
  const sb = getSupabasePublic();
  const { data, error } = await sb.auth.refreshSession({ refresh_token: refreshToken });
  if (error) return null;
  const session = data?.session;
  if (!session?.access_token) return null;
  setSessionCookies(res, { accessToken: session.access_token, refreshToken: session.refresh_token || refreshToken });
  return session.access_token;
}

async function resolveAccessToken(req, res) {
  const headerToken = getBearerToken(req);
  if (headerToken) return headerToken;
  const { accessToken } = getCookieTokens(req);
  if (accessToken) return accessToken;
  return await refreshSessionFromCookie(req, res);
}

const authenticate = {
  required: async (req, res, next) => {
    try {
      let token = await resolveAccessToken(req, res);
      if (!token) return res.status(401).json({ error: "Unauthorized" });

      let jwtPayload;
      try {
        jwtPayload = await verifySupabaseJwt(token);
      } catch (_e) {
        const refreshed = await refreshSessionFromCookie(req, res);
        if (!refreshed) return res.status(401).json({ error: "Unauthorized" });
        token = refreshed;
        jwtPayload = await verifySupabaseJwt(token);
      }
      const userId = jwtPayload.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const db = getSupabaseAdmin();
      const appUser = await loadAppUser(db, userId);
      if (!appUser || appUser.is_active === false) return res.status(401).json({ error: "Unauthorized" });

      req.auth = { token, jwt: jwtPayload, user: appUser };
      // Rolling cookie expiry: keep sessions alive while the user stays active.
      const cookies = getCookieTokens(req);
      if (cookies.accessToken && cookies.refreshToken) setSessionCookies(res, cookies);
      return next();
    } catch (e) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  },
  optional: async (req, res, next) => {
    try {
      let token = await resolveAccessToken(req, res);
      if (!token) return next();

      let jwtPayload;
      try {
        jwtPayload = await verifySupabaseJwt(token);
      } catch (_e) {
        const refreshed = await refreshSessionFromCookie(req, res);
        if (!refreshed) return next();
        token = refreshed;
        jwtPayload = await verifySupabaseJwt(token);
      }
      const userId = jwtPayload.sub;
      if (!userId) return next();
      const db = getSupabaseAdmin();
      const appUser = await loadAppUser(db, userId);
      if (!appUser || appUser.is_active === false) return next();
      req.auth = { token, jwt: jwtPayload, user: appUser };
      const cookies = getCookieTokens(req);
      if (cookies.accessToken && cookies.refreshToken) setSessionCookies(res, cookies);
      return next();
    } catch (_e) {
      return next();
    }
  }
};

module.exports = { authenticate };
