/* global APP */

async function renderTopbar({ role, links }) {
  const bar = document.getElementById("topbar");
  if (!bar) return;

  const guessIcon = (label, href) => {
    const l = String(label || "").toLowerCase();
    const h = String(href || "").toLowerCase();
    if (l.includes("dashboard")) return "dashboard";
    if (l.includes("users") || l.includes("team")) return "groups";
    if (l.includes("project")) return "folder_copy";
    if (l.includes("review")) return "fact_check";
    if (l.includes("payment")) return "payments";
    if (l.includes("earning")) return "paid";
    if (l.includes("submit") || h.includes("submit")) return "edit";
    if (l.includes("editor") || h.includes("editor")) return "description";
    if (l.includes("notification")) return "notifications";
    if (l.includes("settings")) return "settings";
    return "chevron_right";
  };

  const rawTitle = String(document.title || "");
  const titleParts = rawTitle
    .split(/(?:\u2022|â€¢|•)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pageTitle = titleParts.length ? titleParts[titleParts.length - 1] : rawTitle;
  const navLinks = (links || []).map((l) => ({
    href: l.href,
    label: l.label,
    icon: l.icon || guessIcon(l.label, l.href)
  }));
  navLinks.push({ href: "/shared/notifications.html", label: "Notifications", icon: "notifications" });
  navLinks.push({ href: "/profile.html", label: "Profile", icon: "account_circle" });

  const pathname = String(window.location.pathname || "");
  const isActive = (href) => {
    if (!href) return false;
    try {
      const u = new URL(href, window.location.origin);
      return u.pathname === pathname;
    } catch {
      return false;
    }
  };

  bar.className = "rw-shell";
  bar.innerHTML = `
    <aside class="rw-sidebar" aria-label="Primary navigation">
      <a class="rw-brand" href="${role ? `/${encodeURIComponent(role)}/dashboard.html` : "/login.html"}" aria-label="Real Write home">
        <img class="rw-brand-logo" src="/assets/realwrite-logo.png" alt="Real Write logo" loading="eager" decoding="async" />
        <span>
          <span class="rw-brand-name">Real Write</span>
          <span class="rw-brand-sub">${role ? APP.escapeHtml(String(role).toUpperCase()) : "Editorial Suite"}</span>
        </span>
      </a>

      <nav class="rw-nav">
        ${navLinks
          .map(
            (l) => `
          <a href="${l.href}" class="${isActive(l.href) ? "active" : ""}">
            <span class="material-symbols-outlined" aria-hidden="true">${l.icon}</span>
            <span>${APP.escapeHtml(l.label)}</span>
          </a>
        `
          )
          .join("")}
      </nav>

      <div class="rw-sidebar-footer">
        <span class="rw-chip" title="Signed-in role">
          <span class="material-symbols-outlined" aria-hidden="true">verified_user</span>
          <span>${role ? APP.escapeHtml(String(role)) : "guest"}</span>
        </span>
        ${
          role
            ? `<button class="rw-chip" id="rwLogout" type="button" style="cursor:pointer;justify-content:center;">
          <span class="material-symbols-outlined" aria-hidden="true">logout</span>
          <span>Logout</span>
        </button>`
            : ""
        }
      </div>
    </aside>

    <header class="rw-header" role="banner">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        <button class="rw-icon-btn rw-menu-btn" id="rwMenuBtn" type="button" aria-label="Menu">
          <span class="material-symbols-outlined" aria-hidden="true">menu</span>
        </button>
        <div class="rw-header-title" title="${APP.escapeHtml(pageTitle)}">${APP.escapeHtml(pageTitle || "Dashboard")}</div>
      </div>
      <div class="rw-header-actions"></div>
    </header>
  `;

  const logoutBtn = document.getElementById("rwLogout");
  if (logoutBtn && role) {
    logoutBtn.onclick = (e) => {
      e.preventDefault();
      APP.logout();
    };
  }

  const menuBtn = document.getElementById("rwMenuBtn");
  if (menuBtn) {
    menuBtn.onclick = () => {
      document.body.classList.toggle("rw-sidebar-open");
    };
  }

  // Mobile: tap outside sidebar to close.
  let backdrop = document.getElementById("rwBackdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "rwBackdrop";
    backdrop.className = "rw-backdrop";
    document.body.appendChild(backdrop);
  }
  backdrop.onclick = () => document.body.classList.remove("rw-sidebar-open");

  // Desktop: ensure sidebar isn't accidentally left in an "open" state.
  const syncSidebarState = () => {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    if (!mobile) document.body.classList.remove("rw-sidebar-open");
  };
  syncSidebarState();
  window.addEventListener("resize", syncSidebarState);

  for (const a of bar.querySelectorAll(".rw-nav a")) {
    a.addEventListener("click", () => document.body.classList.remove("rw-sidebar-open"));
  }

  if (role) document.title = `${String(role).toUpperCase()} \u2022 ${pageTitle || rawTitle}`;
}

window.renderTopbar = renderTopbar;
