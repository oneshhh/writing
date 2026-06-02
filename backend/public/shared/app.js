/* global APP_CONFIG */

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
        <div id="rwLoaderSub" style="margin-top:2px;color:var(--rw-muted);font-size:12px;">Fetching the latest updates...</div>
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
  ensureLoader();
  document.getElementById("rwLoader").classList.add("on");
}

function loaderOff() {
  const el = document.getElementById("rwLoader");
  if (el) el.classList.remove("on");
}

function beginLoading(label, { sub } = {}) {
  window.__rwLoadCount = (window.__rwLoadCount || 0) + 1;
  ensureLoader();

  const titleEl = document.getElementById("rwLoaderTitle");
  const subEl = document.getElementById("rwLoaderSub");
  if (titleEl) titleEl.textContent = String(label || "Loading");
  if (subEl) subEl.textContent = String(sub || "Fetching the latest updates...");

  const spinner = document.getElementById("rwLoaderSpinner");
  const symbol = document.getElementById("rwLoaderSymbol");
  if (spinner) spinner.classList.remove("hidden");
  if (symbol) symbol.classList.add("hidden");

  loaderOn();
}

function endLoading() {
  window.__rwLoadCount = Math.max(0, (window.__rwLoadCount || 0) - 1);
  if ((window.__rwLoadCount || 0) === 0) loaderOff();
}

async function runActionOverlay({ title, sub, successSymbol = "check_circle", errorSymbol = "error", action }) {
  beginLoading(title || "Working...", { sub: sub || "Please wait..." });
  try {
    const result = await action();
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
    setTimeout(() => endLoading(), 520);
    return result;
  } catch (e) {
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
    setTimeout(() => endLoading(), 650);
    throw e;
  }
}

async function apiFetch(path, options) {
  const { skipLoader, ...fetchOptions } = options || {};
  const useLoader = !skipLoader;
  if (useLoader) beginLoading("Loading");
  try {
    const headers = new Headers((fetchOptions && fetchOptions.headers) || {});
    const isForm = typeof FormData !== "undefined" && fetchOptions?.body instanceof FormData;
    if (!isForm) headers.set("Content-Type", headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", headers.get("Cache-Control") || "no-cache");
    headers.set("Pragma", headers.get("Pragma") || "no-cache");

    const url = `${APP_CONFIG.apiBaseUrl}${path}`;
    const fetchOpts = { ...(fetchOptions || {}), headers, cache: "no-store", credentials: "include" };
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
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  } finally {
    if (useLoader) endLoading();
  }
}

async function requireAuth() {
  try {
    const me = await apiFetch("/api/auth/me", { skipLoader: true });
    return me.user || null;
  } catch {
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
    status === "draft"
      ? "b-draft"
      : status === "submitted"
        ? "b-submitted"
        : status === "approved"
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
