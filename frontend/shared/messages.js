/* global APP, RW_MESSAGES_ROLE, supabase */

(async function () {
  const role = window.RW_MESSAGES_ROLE;
  const user = await APP.requireRole(role);
  if (!user) return;

  const links =
    role === "manager"
      ? [
          { href: "/manager/dashboard.html", label: "Dashboard" },
          { href: "/manager/projects.html", label: "Projects" },
          { href: "/manager/review.html", label: "Review" },
          { href: "/manager/payments.html", label: "Payments" }
        ]
      : [
          { href: "/writer/dashboard.html", label: "Dashboard" },
          { href: "/writer/earnings.html", label: "Earnings" }
        ];
  await renderTopbar({ role, links });

  const defaultThreadTitle = "Select a chat";
  const defaultThreadSubtitle = "Choose a conversation on the left to continue messaging.";
  const defaultComposerHint = "Press Enter to send. Shift+Enter for a new line.";
  const state = {
    contacts: [],
    projects: [],
    active: null,
    realtime: null,
    realtimeChannel: null,
    presenceBeat: null,
    typingTimer: null,
    typingClearTimer: null,
    isTyping: false,
    activeTyper: null
  };

  const $ = (id) => document.getElementById(id);
  const msg = (text) => {
    $("msg").textContent = text || defaultComposerHint;
  };

  function initials(name) {
    return String(name || "U")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("");
  }

  function timeLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function contactById(id) {
    return state.contacts.find((item) => item.id === id) || null;
  }

  function projectById(id) {
    return state.projects.find((item) => item.id === id) || null;
  }

  function activeConversationKey() {
    if (!state.active) return "";
    if (state.active.kind === "project") return `project:${state.active.id}`;
    return `direct:${[user.id, state.active.id].sort().join(":")}`;
  }

  function presenceLabel(contact) {
    if (contact?.is_online) return "Active now";
    if (!contact?.last_active_at) return "Offline";
    const diff = Date.now() - new Date(contact.last_active_at).getTime();
    if (diff < 2 * 60 * 1000) return "Active now";
    if (diff < 60 * 60 * 1000) return `Last active ${Math.max(2, Math.round(diff / 60000))}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `Last active ${Math.round(diff / 3600000)}h ago`;
    return `Last active ${new Date(contact.last_active_at).toLocaleDateString()}`;
  }

  function presenceClass(contact) {
    if (contact?.is_online) return "online";
    if (!contact?.last_active_at) return "";
    return Date.now() - new Date(contact.last_active_at).getTime() < 2 * 60 * 1000 ? "online" : "";
  }

  function sortContacts(a, b) {
    const unread = Number(b.unread_count || 0) - Number(a.unread_count || 0);
    if (unread) return unread;
    return new Date(b.last_message_at || b.last_active_at || 0) - new Date(a.last_message_at || a.last_active_at || 0);
  }

  function sortProjects(a, b) {
    const unread = Number(b.unread_count || 0) - Number(a.unread_count || 0);
    if (unread) return unread;
    return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
  }

  function statusDot(status) {
    const safe = ["delivered", "read", "failed"].includes(status) ? status : "delivered";
    const label = safe === "read" ? "Read" : safe === "failed" ? "Failed" : "Delivered";
    return `<span class="message-status ${safe}" title="${label}"><i></i>${label}</span>`;
  }

  function isActiveRefresh(payload) {
    if (!state.active || !payload) return false;
    if (state.active.kind === "project") return payload.project_id === state.active.id;
    const ids = Array.isArray(payload.direct_user_ids) ? payload.direct_user_ids : [];
    return ids.includes(user.id) && ids.includes(state.active.id);
  }

  function applyPresenceState(presenceState) {
    const online = new Map();
    for (const slice of Object.values(presenceState || {})) {
      for (const entry of slice || []) {
        if (!entry?.user_id) continue;
        const existing = online.get(entry.user_id);
        const candidate = entry.online_at || null;
        if (!existing || (candidate && candidate > existing)) online.set(entry.user_id, candidate);
      }
    }
    state.contacts = state.contacts
      .map((contact) => ({
        ...contact,
        is_online: online.has(contact.id),
        last_active_at: online.get(contact.id) || contact.last_active_at
      }))
      .sort(sortContacts);
    renderConversationList();
    if (state.active) renderThreadHeader();
  }

  function handleTyping(payload) {
    if (!payload || payload.user_id === user.id) return;
    if (payload.conversation_key !== activeConversationKey()) return;
    clearTimeout(state.typingClearTimer);
    state.activeTyper = payload.is_typing ? { user_id: payload.user_id, full_name: payload.full_name || "Someone" } : null;
    if (payload.is_typing) {
      state.typingClearTimer = setTimeout(() => {
        state.activeTyper = null;
        renderThreadHeader();
      }, 1800);
    }
    renderThreadHeader();
  }

  function activeDetails() {
    if (!state.active) return null;
    if (state.active.kind === "project") {
      const project = projectById(state.active.id);
      return {
        title: state.active.title,
        avatar: "#",
        avatarClass: "room",
        subtitle: state.activeTyper ? `${state.activeTyper.full_name} is typing...` : `Project room - ${project?.status || "active"}`
      };
    }
    const contact = contactById(state.active.id);
    const name = contact?.full_name || contact?.email || state.active.title;
    return {
      title: name,
      avatar: initials(name),
      avatarClass: presenceClass(contact),
      subtitle: state.activeTyper ? `${state.activeTyper.full_name} is typing...` : `${contact?.role || "user"} - ${presenceLabel(contact)}`
    };
  }

  function renderThreadHeader() {
    if (!state.active) {
      msg(defaultComposerHint);
      return;
    }
    const active = activeDetails();
    $("chatTitle").textContent = active.title;
    $("chatSubtitle").textContent = active.subtitle;
    const avatar = $("chatHeaderAvatar");
    avatar.textContent = active.avatar;
    avatar.className = `chat-avatar ${active.avatarClass || ""}`.trim();
    msg(state.activeTyper ? active.subtitle : defaultComposerHint);
  }

  async function loadConversations() {
    const out = await APP.apiFetch("/api/messages/conversations", { skipLoader: true });
    state.contacts = (out.contacts || []).sort(sortContacts);
    state.projects = (out.projects || []).sort(sortProjects);
    renderConversationList();
    if (state.active) renderThreadHeader();
  }

  async function loadMessages() {
    if (!state.active) {
      renderEmptyThread();
      return;
    }
    renderThreadHeader();
    $("chatComposer").classList.remove("hidden");
    const query =
      state.active.kind === "project"
        ? `project_id=${encodeURIComponent(state.active.id)}`
        : `recipient_id=${encodeURIComponent(state.active.id)}`;
    const out = await APP.apiFetch(`/api/messages?${query}`, { skipLoader: true });
    const rows = [];
    let lastDay = "";
    for (const row of out.messages || []) {
      const mine = row.sender_id === user.id;
      const currentDay = dayLabel(row.created_at);
      if (currentDay && currentDay !== lastDay) {
        rows.push(`<div class="chat-date-divider"><span>${APP.escapeHtml(currentDay)}</span></div>`);
        lastDay = currentDay;
      }
      rows.push(`<div class="chat-message-row ${mine ? "mine" : ""}">
        ${mine ? "" : `<span class="chat-mini-avatar">${APP.escapeHtml(initials(row.sender?.full_name || "User"))}</span>`}
        <div class="chat-bubble ${mine ? "mine" : ""}">
          <span class="chat-sender">${APP.escapeHtml(row.sender?.full_name || (mine ? "You" : "User"))} - ${APP.escapeHtml(timeLabel(row.created_at))}</span>
          <div>${APP.escapeHtml(row.body || "")}</div>
          ${mine ? `<span class="chat-meta">${statusDot(row.delivery_status)}</span>` : ""}
        </div>
      </div>`);
    }
    const list = $("messageList");
    list.innerHTML = rows.length ? rows.join("") : "<div class='chat-empty-state'>No messages yet. Start the conversation.</div>";
    list.scrollTop = list.scrollHeight;
  }

  async function openConversation(kind, id, title) {
    emitTyping(false);
    state.activeTyper = null;
    state.active = { kind, id, title };
    renderConversationList();
    await loadMessages();
    await loadConversations();
  }

  function contactItem(contact) {
    const active = state.active?.kind === "direct" && state.active?.id === contact.id;
    const name = contact.full_name || contact.email || "User";
    const unread = Number(contact.unread_count || 0);
    return `<button class="chat-list-item ${active ? "active" : ""}" data-chat-kind="direct" data-chat-id="${contact.id}" type="button">
      <span class="chat-avatar ${presenceClass(contact)}">${APP.escapeHtml(initials(name))}</span>
      <span class="chat-list-copy">
        <span class="chat-list-title">
          <strong>${APP.escapeHtml(name)}</strong>
          ${unread ? `<em>${unread > 99 ? "99+" : unread}</em>` : ""}
        </span>
        <span>${APP.escapeHtml(contact.role || "user")} - ${APP.escapeHtml(presenceLabel(contact))}</span>
      </span>
    </button>`;
  }

  function projectItem(project) {
    const active = state.active?.kind === "project" && state.active?.id === project.id;
    const unread = Number(project.unread_count || 0);
    return `<button class="chat-list-item ${active ? "active" : ""}" data-chat-kind="project" data-chat-id="${project.id}" type="button">
      <span class="chat-avatar room">#</span>
      <span class="chat-list-copy">
        <span class="chat-list-title">
          <strong>${APP.escapeHtml(project.title || "Project room")}</strong>
          ${unread ? `<em>${unread > 99 ? "99+" : unread}</em>` : ""}
        </span>
        <span>Project room - ${APP.escapeHtml(project.status || "active")}</span>
      </span>
    </button>`;
  }

  function renderConversationList() {
    const q = String($("chatSearch").value || "").toLowerCase();
    const contacts = state.contacts.filter((item) => `${item.full_name || ""} ${item.email || ""} ${item.role || ""}`.toLowerCase().includes(q));
    const projects = state.projects.filter((item) => `${item.title || ""} project room`.toLowerCase().includes(q));
    $("conversationList").innerHTML = `
      <div class="chat-list-section">Project Rooms</div>
      ${
        projects.length
          ? projects.map(projectItem).join("")
          : "<div class='chat-empty-list'>No project rooms found.</div>"
      }
      ${
        contacts.length
          ? `<div class="chat-list-section">People</div>${contacts.map(contactItem).join("")}`
          : "<div class='chat-list-section'>People</div><div class='chat-empty-list'>No people found in your organisation.</div>"
      }
    `;

    for (const button of document.querySelectorAll("[data-chat-kind]")) {
      button.onclick = async () => {
        const kind = button.getAttribute("data-chat-kind");
        const id = button.getAttribute("data-chat-id");
        const title = button.querySelector("strong")?.textContent || "Conversation";
        await openConversation(kind, id, title);
      };
    }
  }

  function renderEmptyThread() {
    $("chatTitle").textContent = defaultThreadTitle;
    $("chatSubtitle").textContent = defaultThreadSubtitle;
    const avatar = $("chatHeaderAvatar");
    avatar.textContent = "#";
    avatar.className = "chat-avatar room";
    $("chatComposer").classList.add("hidden");
    $("messageList").innerHTML = `
      <div class="chat-empty-stage">
        <div class="chat-empty-stage-icon">
          <span class="material-symbols-outlined" aria-hidden="true">chat_bubble</span>
        </div>
        <h4>Select a chat to continue messaging.</h4>
        <p>Pick a project room or person from the left to open the conversation here.</p>
      </div>
    `;
    msg(defaultComposerHint);
  }

  async function sendMessage() {
    msg(defaultComposerHint);
    if (!state.active) return msg("Choose a conversation first.");
    const input = $("messageText");
    const text = input.value.trim();
    if (!text) return;

    const send = $("sendMessage");
    send.disabled = true;
    try {
      await APP.apiFetch("/api/messages", {
        method: "POST",
        skipLoader: true,
        body: JSON.stringify({
          text,
          audience: state.active.kind === "project" ? "project" : "direct",
          project_id: state.active.kind === "project" ? state.active.id : null,
          recipient_id: state.active.kind === "direct" ? state.active.id : null
        })
      });
      input.value = "";
      input.style.height = "auto";
      emitTyping(false);
      await loadMessages();
      await loadConversations();
    } catch (e) {
      msg(e.message || String(e));
    } finally {
      send.disabled = false;
    }
  }

  function emitTyping(isTyping) {
    if (!state.realtimeChannel || !state.active) return;
    if (!isTyping) {
      clearTimeout(state.typingTimer);
      state.typingTimer = null;
    }
    state.realtimeChannel.send({
      type: "broadcast",
      event: "typing",
      payload: {
        conversation_key: activeConversationKey(),
        user_id: user.id,
        full_name: user.full_name || user.email || "User",
        is_typing: isTyping
      }
    });
    state.isTyping = isTyping;
  }

  function scheduleTypingStop() {
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      if (state.isTyping) emitTyping(false);
    }, 1200);
  }

  async function setupRealtime() {
    if (!window.supabase?.createClient) return;
    try {
      const cfg = await APP.apiFetch("/api/messages/realtime-config", { skipLoader: true });
      state.realtime = window.supabase.createClient(cfg.url, cfg.key);
      const presenceKey = `${user.id}:${Math.random().toString(36).slice(2)}`;
      const channel = state.realtime.channel(cfg.topic, {
        config: {
          presence: { key: presenceKey },
          broadcast: { self: false }
        }
      });
      channel
        .on("presence", { event: "sync" }, () => {
          applyPresenceState(channel.presenceState());
        })
        .on("broadcast", { event: "messages:refresh" }, async ({ payload }) => {
          await loadConversations();
          if (isActiveRefresh(payload)) await loadMessages();
        })
        .on("broadcast", { event: "typing" }, ({ payload }) => {
          handleTyping(payload);
        });
      channel.subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        state.realtimeChannel = channel;
        await channel.track({
          user_id: user.id,
          full_name: user.full_name || user.email || "User",
          online_at: new Date().toISOString()
        });
      });
      state.presenceBeat = setInterval(async () => {
        await APP.apiFetch("/api/messages/presence", {
          method: "POST",
          skipLoader: true,
          body: JSON.stringify({})
        }).catch(() => {});
        if (state.realtimeChannel) {
          state.realtimeChannel.track({
            user_id: user.id,
            full_name: user.full_name || user.email || "User",
            online_at: new Date().toISOString()
          }).catch(() => {});
        }
      }, 30000);
    } catch {}
  }

  $("chatSearch").addEventListener("input", renderConversationList);
  $("sendMessage").onclick = sendMessage;
  for (const button of document.querySelectorAll(".coming-soon")) {
    button.addEventListener("click", () => {
      APP.ui?.toast?.(button.getAttribute("data-coming-soon") || "Coming soon", { kind: "success", ttlMs: 2600 });
    });
  }
  $("messageText").addEventListener("input", () => {
    const input = $("messageText");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    if (!state.active) return;
    if (!input.value.trim()) {
      if (state.isTyping) emitTyping(false);
      return;
    }
    if (!state.isTyping) emitTyping(true);
    scheduleTypingStop();
  });
  $("messageText").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  window.addEventListener("beforeunload", () => {
    if (state.isTyping) emitTyping(false);
    if (state.presenceBeat) clearInterval(state.presenceBeat);
    if (state.realtime && state.realtimeChannel) state.realtime.removeChannel(state.realtimeChannel);
  });

  await APP.apiFetch("/api/messages/presence", {
    method: "POST",
    skipLoader: true,
    body: JSON.stringify({})
  }).catch(() => {});
  await loadConversations();
  renderEmptyThread();
  await setupRealtime();
})();
