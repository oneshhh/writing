/* global APP_CONFIG */

const DEFAULT_LOADER_DELAY_MS = 900;
const ACTION_RESULT_VISIBLE_MS = 160;
const AUTH_CACHE_KEY = "rwAuthUser";
const AUTH_CACHE_TTL_MS = 30000;

function getLoaderState() {
  if (!window.__rwLoaderState) {
    window.__rwLoaderState = {
      count: 0,
      timer: null,
      visible: false
    };
  }
  return window.__rwLoaderState;
}

function ensureLoader() {
  if (document.getElementById("rwLoader")) return;
  const el = document.createElement("div");
  el.id = "rwLoader";
  el.className = "rw-loader";
  el.innerHTML = `
    <div class="rw-loader-card" role="status" aria-live="polite" aria-label="Loading">
      <div class="rw-loader-icon" aria-hidden="true">
        <div class="rw-spinner" id="rwLoaderSpinner" aria-hidden="true"></div>
        <span class="material-symbols-outlined rw-loader-symbol hidden" id="rwLoaderSymbol" aria-hidden="true">check_circle</span>
      </div>
      <div>
        <div id="rwLoaderTitle" style="font-weight:750;color:var(--rw-text);font-size:13px;">Loading</div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
}

function ensureToastHost() {
  if (document.getElementById("rwToastHost")) return;
  const host = document.createElement("div");
  host.id = "rwToastHost";
  host.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:250;display:flex;flex-direction:column;gap:10px;max-width:min(420px,calc(100vw - 32px));";
  document.body.appendChild(host);
}

function toast(message, { kind = "error", ttlMs = 6500 } = {}) {
  ensureToastHost();
  const host = document.getElementById("rwToastHost");
  const el = document.createElement("div");
  const isErr = kind === "error";
  const border = isErr ? "rgba(186,26,26,0.25)" : "rgba(71,100,89,0.25)";
  const bg = isErr ? "rgba(255,218,214,0.88)" : "rgba(201,234,220,0.7)";
  const fg = isErr ? "#7a0b12" : "#0c5a54";
  el.style.cssText = `
    border:1px solid ${border};
    background:${bg};
    color:${fg};
    border-radius:16px;
    padding:12px 12px;
    box-shadow:0 18px 40px rgba(0,0,0,0.10);
    font-weight:650;
    font-size:13px;
    backdrop-filter: blur(10px);
  `;
  el.textContent = String(message || "");
  host.appendChild(el);
  setTimeout(() => el.remove(), ttlMs);
}

function loaderOn() {
  const state = getLoaderState();
  ensureLoader();
  document.getElementById("rwLoader").classList.add("on");
  state.visible = true;
}

function loaderOff() {
  const state = getLoaderState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const el = document.getElementById("rwLoader");
  if (el) el.classList.remove("on");
  state.visible = false;
}

function beginLoading(label, { sub, delayMs = DEFAULT_LOADER_DELAY_MS } = {}) {
  const state = getLoaderState();
  state.count += 1;
  window.__rwLoadCount = state.count;
  ensureLoader();

  const titleEl = document.getElementById("rwLoaderTitle");
  if (titleEl) titleEl.textContent = String(label || "Loading");

  const spinner = document.getElementById("rwLoaderSpinner");
  const symbol = document.getElementById("rwLoaderSymbol");
  if (spinner) spinner.classList.remove("hidden");
  if (symbol) symbol.classList.add("hidden");

  if (state.visible || state.timer) return;

  const waitMs = Math.max(0, Number(delayMs) || 0);
  if (waitMs === 0) {
    loaderOn();
    return;
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.count > 0) loaderOn();
  }, waitMs);
}

function endLoading() {
  const state = getLoaderState();
  state.count = Math.max(0, state.count - 1);
  window.__rwLoadCount = state.count;
  if (state.count === 0) loaderOff();
}

function isLoaderVisible() {
  return getLoaderState().visible && document.getElementById("rwLoader")?.classList.contains("on");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCachedAuthUser() {
  try {
    const raw = sessionStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.user || Number(parsed.expiresAt || 0) <= Date.now()) {
      sessionStorage.removeItem(AUTH_CACHE_KEY);
      return null;
    }
    return parsed.user;
  } catch {
    return null;
  }
}

function setCachedAuthUser(user) {
  try {
    if (!user) {
      sessionStorage.removeItem(AUTH_CACHE_KEY);
      return;
    }
    sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS }));
  } catch {}
}

async function runActionOverlay({ title, sub, successSymbol = "check_circle", errorSymbol = "error", action }) {
  beginLoading(title || "Working...", { sub: sub || "Please wait..." });
  try {
    const result = await action();
    if (!isLoaderVisible()) {
      endLoading();
      return result;
    }

    const spinner = document.getElementById("rwLoaderSpinner");
    const symbol = document.getElementById("rwLoaderSymbol");
    if (spinner) spinner.classList.add("hidden");
    if (symbol) {
      symbol.textContent = successSymbol;
      symbol.classList.remove("hidden");
      symbol.classList.remove("rw-loader-err");
      symbol.classList.add("rw-loader-ok");
      symbol.classList.add("rw-loader-pop");
      setTimeout(() => symbol.classList.remove("rw-loader-pop"), 450);
    }
    await delay(ACTION_RESULT_VISIBLE_MS);
    endLoading();
    return result;
  } catch (e) {
    if (!isLoaderVisible()) {
      endLoading();
      throw e;
    }

    const spinner = document.getElementById("rwLoaderSpinner");
    const symbol = document.getElementById("rwLoaderSymbol");
    if (spinner) spinner.classList.add("hidden");
    if (symbol) {
      symbol.textContent = errorSymbol;
      symbol.classList.remove("hidden");
      symbol.classList.remove("rw-loader-ok");
      symbol.classList.add("rw-loader-err");
      symbol.classList.add("rw-loader-pop");
      setTimeout(() => symbol.classList.remove("rw-loader-pop"), 450);
    }
    await delay(ACTION_RESULT_VISIBLE_MS);
    endLoading();
    throw e;
  }
}

async function apiFetch(path, options) {
  const { skipLoader, loaderDelayMs = DEFAULT_LOADER_DELAY_MS, ...fetchOptions } = options || {};
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const useLoader = !skipLoader && method !== "GET";
  if (useLoader) beginLoading("Working", { delayMs: loaderDelayMs });
  try {
    const headers = new Headers((fetchOptions && fetchOptions.headers) || {});
    const isForm = typeof FormData !== "undefined" && fetchOptions?.body instanceof FormData;
    if (!isForm) headers.set("Content-Type", headers.get("Content-Type") || "application/json");

    const url = `${APP_CONFIG.apiBaseUrl}${path}`;
    const fetchOpts = { ...(fetchOptions || {}), headers, credentials: "include" };
    let res;
    try {
      res = await fetch(url, fetchOpts);
    } catch (e) {
      throw new Error(
        `Cannot reach API at ${APP_CONFIG.apiBaseUrl}. Start the backend server (PORT ${APP_CONFIG.apiBaseUrl.split(":").pop()}).`
      );
    }

    if (res.status === 304) {
      res = await fetch(url, { ...fetchOpts, cache: "reload" });
    }

    if (res.status === 204) return {};

    const body = await res.json().catch(() => ({}));
    if (res.status === 401) setCachedAuthUser(null);
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  } finally {
    if (useLoader) endLoading();
  }
}

async function requireAuth() {
  const cachedUser = getCachedAuthUser();
  if (cachedUser) return cachedUser;
  if (window.__rwAuthUserPromise) {
    try {
      return await window.__rwAuthUserPromise;
    } catch {
      setCachedAuthUser(null);
      window.location.href = "/login.html";
      return null;
    }
  }
  try {
    window.__rwAuthUserPromise = apiFetch("/api/auth/me", { skipLoader: true })
      .then((me) => {
        const user = me.user || null;
        setCachedAuthUser(user);
        return user;
      })
      .finally(() => {
        window.__rwAuthUserPromise = null;
      });
    return await window.__rwAuthUserPromise;
  } catch {
    setCachedAuthUser(null);
    window.location.href = "/login.html";
    return null;
  }
}

async function requireRole(...roles) {
  const user = await requireAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) {
    window.location.href = `/${user.role}/dashboard.html`;
    return null;
  }
  return user;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tableSkeleton(tbodyId, { rows = 6, cols = 4 } = {}) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const cells = Array.from({ length: cols }).map((_, idx) => {
    const w = idx === 0 ? 64 : idx === cols - 1 ? 40 : 52;
    const width = Math.max(26, Math.min(90, w + Math.round((Math.random() - 0.5) * 18)));
    return `<td><div class="rw-skeleton rw-skel-cell" style="width:${width}%;"></div></td>`;
  });
  tbody.innerHTML = Array.from({ length: rows })
    .map(() => `<tr>${cells.join("")}</tr>`)
    .join("");
}

function textSkeleton(id, { kind = "line", width = "68%" } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const cls = kind === "num" ? "rw-skel-num" : "rw-skel-line";
  el.innerHTML = `<span class="rw-skeleton ${cls}" style="display:inline-block;width:${width};"></span>`;
}

function clearText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text == null ? "" : String(text);
}

function badgeForStatus(status) {
  const cls =
    status === "draft" || status === "open" || status === "pending"
      ? "b-draft"
      : status === "submitted"
        ? "b-submitted"
        : status === "approved" || status === "accepted"
          ? "b-approved"
          : status === "rework"
            ? "b-rework"
            : "b-rejected";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function formatCheckScore(score) {
  if (!score) return "n/a";
  if (typeof score === "number") return String(score);
  if (typeof score === "string") return score;
  if (typeof score === "object") {
    if (score.score == null) return score.status ? String(score.status) : "n/a";
    return typeof score.score === "number" ? `${Math.round(score.score * 100)}%` : String(score.score);
  }
  return "n/a";
}

function checkBadge(score) {
  const text = formatCheckScore(score);
  const isNa = text === "n/a" || text === "not_configured" || text === "disabled";
  const cls = isNa ? "b-draft" : "b-submitted";
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST", body: JSON.stringify({}), skipLoader: true });
  } catch {
    // ignore
  }
  setCachedAuthUser(null);
  window.location.href = "/login.html";
}

window.APP = {
  apiFetch,
  requireAuth,
  requireRole,
  setText,
  escapeHtml,
  badgeForStatus,
  formatCheckScore,
  checkBadge,
  logout,
  ui: { beginLoading, endLoading, runActionOverlay, tableSkeleton, textSkeleton, clearText, toast }
};

window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || String(e?.reason || "Something went wrong");
  toast(msg, { kind: "error" });
});

window.addEventListener("error", (e) => {
  const msg = e?.error?.message || e?.message;
  if (msg) toast(msg, { kind: "error" });
});
