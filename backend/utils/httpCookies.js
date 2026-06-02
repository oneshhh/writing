function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Cookie name is required");

  const encodedValue = encodeURIComponent(String(value == null ? "" : value));
  const parts = [`${n}=${encodedValue}`];

  if (options.maxAgeMs != null) parts.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAgeMs) / 1000))}`);
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.secure) parts.push("Secure");
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function setCookie(res, name, value, options) {
  const v = serializeCookie(name, value, options);
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", [v]);
    return;
  }
  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", prev.concat([v]));
    return;
  }
  res.setHeader("Set-Cookie", [String(prev), v]);
}

function clearCookie(res, name, options = {}) {
  setCookie(res, name, "", { ...options, maxAgeMs: 0, expires: new Date(0) });
}

module.exports = { parseCookies, serializeCookie, setCookie, clearCookie };
