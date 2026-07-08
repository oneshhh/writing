/* global APP, RW_MESSAGES_ROLE */

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

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const state = {
    contacts: [],
    projects: [],
    active: null,
    poll: null,
    presencePoll: null,
    privateKey: null,
    publicKeyJwk: null
  };

  const $ = (id) => document.getElementById(id);
  const msg = (text) => {
    $("msg").textContent = text || "";
  };

  function b64(bytes) {
    const data = new Uint8Array(bytes);
    let out = "";
    for (let i = 0; i < data.length; i += 1) out += String.fromCharCode(data[i]);
    return btoa(out);
  }

  function fromB64(value) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }

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

  function presenceLabel(lastActiveAt) {
    if (!lastActiveAt) return "Not active yet";
    const diff = Date.now() - new Date(lastActiveAt).getTime();
    if (diff < 2 * 60 * 1000) return "Active now";
    if (diff < 60 * 60 * 1000) return `Last active ${Math.max(2, Math.round(diff / 60000))}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `Last active ${Math.round(diff / 3600000)}h ago`;
    return `Last active ${new Date(lastActiveAt).toLocaleDateString()}`;
  }

  function presenceClass(lastActiveAt) {
    if (!lastActiveAt) return "";
    return Date.now() - new Date(lastActiveAt).getTime() < 2 * 60 * 1000 ? "online" : "";
  }

  async function importPublicKey(jwk) {
    return crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
  }

  async function importPrivateKey(jwk) {
    return crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
  }

  async function ensureIdentity() {
    const storageKey = `rw_e2ee_private_${user.id}`;
    const localPrivate = localStorage.getItem(storageKey);
    const existing = await APP.apiFetch("/api/messages/keys/me", { skipLoader: true }).catch(() => ({ key: null }));

    if (localPrivate) {
      state.privateKey = await importPrivateKey(JSON.parse(localPrivate));
      if (existing.key) {
        state.publicKeyJwk = existing.key.public_key_jwk;
        return;
      }
    }

    const pair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"]
    );
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    localStorage.setItem(storageKey, JSON.stringify(privateJwk));
    state.privateKey = pair.privateKey;
    state.publicKeyJwk = publicJwk;
    await APP.apiFetch("/api/messages/keys", { method: "POST", body: JSON.stringify({ public_key_jwk: publicJwk }), skipLoader: true });
  }

  async function heartbeat() {
    await APP.apiFetch("/api/messages/presence", { method: "POST", body: JSON.stringify({}), skipLoader: true }).catch(() => {});
  }

  async function loadConversations() {
    const out = await APP.apiFetch("/api/messages/conversations", { skipLoader: true });
    state.contacts = (out.contacts || []).sort((a, b) => {
      const unread = Number(b.unread_count || 0) - Number(a.unread_count || 0);
      if (unread) return unread;
      return new Date(b.last_message_at || b.last_active_at || 0) - new Date(a.last_message_at || a.last_active_at || 0);
    });
    state.projects = out.projects || [];
    renderConversationList();
  }

  function contactItem(contact) {
    const active = state.active?.kind === "direct" && state.active?.id === contact.id;
    const name = contact.full_name || contact.email || "User";
    const unread = Number(contact.unread_count || 0);
    return `<button class="chat-list-item ${active ? "active" : ""}" data-chat-kind="direct" data-chat-id="${contact.id}" ${contact.public_key ? "" : "disabled"} type="button">
      <span class="chat-avatar ${presenceClass(contact.last_active_at)}">${APP.escapeHtml(initials(name))}</span>
      <span class="chat-list-copy">
        <span class="chat-list-title">
          <strong>${APP.escapeHtml(name)}</strong>
          ${unread ? `<em>${unread > 99 ? "99+" : unread}</em>` : ""}
        </span>
        <span>${APP.escapeHtml(contact.role || "user")} - ${APP.escapeHtml(presenceLabel(contact.last_active_at))}</span>
        ${contact.public_key ? "" : "<span>Needs to open Messages once for encryption setup</span>"}
      </span>
    </button>`;
  }

  function projectItem(project) {
    const active = state.active?.kind === "project" && state.active?.id === project.id;
    return `<button class="chat-list-item ${active ? "active" : ""}" data-chat-kind="project" data-chat-id="${project.id}" type="button">
      <span class="chat-avatar room">#</span>
      <span class="chat-list-copy">
        <span class="chat-list-title"><strong>${APP.escapeHtml(project.title || "Project room")}</strong></span>
        <span>Project room - ${APP.escapeHtml(project.status || "active")}</span>
      </span>
    </button>`;
  }

  function renderConversationList() {
    const q = String($("chatSearch").value || "").toLowerCase();
    const contacts = state.contacts.filter((item) => `${item.full_name || ""} ${item.email || ""} ${item.role || ""}`.toLowerCase().includes(q));
    const projects = state.projects.filter((item) => `${item.title || ""} project room`.toLowerCase().includes(q));
    $("conversationList").innerHTML = `
      <div class="chat-list-section">People</div>
      ${
        contacts.length
          ? contacts.map(contactItem).join("")
          : "<div class='chat-empty-list'>No people found in your organisation.</div>"
      }
      ${
        projects.length
          ? `<div class="chat-list-section">Project Rooms</div>${projects.map(projectItem).join("")}`
          : ""
      }
    `;

    for (const button of document.querySelectorAll("[data-chat-kind]")) {
      button.onclick = async () => {
        const kind = button.getAttribute("data-chat-kind");
        const id = button.getAttribute("data-chat-id");
        const title = button.querySelector("strong")?.textContent || "Conversation";
        state.active = { kind, id, title };
        renderConversationList();
        await loadMessages();
        await loadConversations();
        if (state.poll) clearInterval(state.poll);
        state.poll = setInterval(async () => {
          await loadMessages();
          await loadConversations();
        }, 3500);
      };
    }
  }

  async function recipientsForActive() {
    if (!state.active) return [];
    if (state.active.kind === "direct") {
      const contact = state.contacts.find((item) => item.id === state.active.id);
      return [contact, { id: user.id, public_key: { public_key_jwk: state.publicKeyJwk } }].filter(Boolean);
    }
    const out = await APP.apiFetch(`/api/messages/contacts?project_id=${encodeURIComponent(state.active.id)}`, { skipLoader: true });
    return [...(out.users || []), { id: user.id, public_key: { public_key_jwk: state.publicKeyJwk } }];
  }

  async function encryptForRecipients(text, recipients) {
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(text));
    const rawKey = await crypto.subtle.exportKey("raw", aesKey);
    const keys = [];

    for (const recipient of recipients) {
      const jwk = recipient?.public_key?.public_key_jwk;
      if (!recipient?.id || !jwk) continue;
      const publicKey = await importPublicKey(jwk);
      const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey);
      keys.push({ user_id: recipient.id, encrypted_key: b64(encryptedKey) });
    }

    return { cipher_text: b64(cipher), iv: b64(iv), keys };
  }

  async function decryptMessage(row) {
    if (!row.encrypted_key) return "[No encrypted key for this device]";
    const rawKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, state.privateKey, fromB64(row.encrypted_key));
    const aesKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(row.iv) }, aesKey, fromB64(row.cipher_text));
    return dec.decode(plain);
  }

  function statusDot(status) {
    const safe = ["delivered", "read", "failed"].includes(status) ? status : "delivered";
    const label = safe === "read" ? "Read" : safe === "failed" ? "Failed" : "Delivered";
    return `<span class="message-status ${safe}" title="${label}"><i></i>${label}</span>`;
  }

  async function loadMessages() {
    if (!state.active) return;
    $("chatTitle").textContent = state.active.title;
    $("chatSubtitle").textContent =
      state.active.kind === "project"
        ? "Project room - encrypted for project members"
        : "Direct chat - only people in your organisation can message you";
    $("chatComposer").classList.remove("hidden");
    const query =
      state.active.kind === "project"
        ? `project_id=${encodeURIComponent(state.active.id)}`
        : `recipient_id=${encodeURIComponent(state.active.id)}`;
    const out = await APP.apiFetch(`/api/messages?${query}`, { skipLoader: true });
    const rows = [];
    for (const row of out.messages || []) {
      let text = "[Could not decrypt on this device]";
      try {
        text = await decryptMessage(row);
      } catch {}
      const mine = row.sender_id === user.id;
      rows.push(`<div class="chat-bubble ${mine ? "mine" : ""}">
        <div>${APP.escapeHtml(text)}</div>
        <span class="chat-meta">
          <span>${APP.escapeHtml(row.sender?.full_name || (mine ? "You" : "User"))} - ${APP.escapeHtml(timeLabel(row.created_at))}</span>
          ${mine ? statusDot(row.delivery_status) : ""}
        </span>
      </div>`);
    }
    const list = $("messageList");
    list.innerHTML = rows.join("") || "<div class='chat-empty-state'>No messages yet. Start the conversation.</div>";
    list.scrollTop = list.scrollHeight;
  }

  async function sendMessage() {
    msg("");
    if (!state.active) return msg("Choose a conversation first.");
    const input = $("messageText");
    const text = input.value.trim();
    if (!text) return;

    const send = $("sendMessage");
    send.disabled = true;
    try {
      const recipients = await recipientsForActive();
      const payload = await encryptForRecipients(text, recipients);
      if (!payload.keys.some((key) => key.user_id === user.id)) {
        return msg("Your encryption key is not ready. Refresh this page once.");
      }
      if (state.active.kind === "direct" && payload.keys.length < 2) {
        return msg("That user needs to open Messages once before they can receive encrypted messages.");
      }
      await APP.apiFetch("/api/messages", {
        method: "POST",
        skipLoader: true,
        body: JSON.stringify({
          ...payload,
          algorithm: "AES-GCM/RSA-OAEP-256",
          audience: state.active.kind === "project" ? "project" : "direct",
          project_id: state.active.kind === "project" ? state.active.id : null,
          recipient_id: state.active.kind === "direct" ? state.active.id : null
        })
      });
      input.value = "";
      await loadMessages();
      await loadConversations();
    } catch (e) {
      msg(e.message || String(e));
    } finally {
      send.disabled = false;
    }
  }

  $("chatSearch").addEventListener("input", renderConversationList);
  $("sendMessage").onclick = sendMessage;
  $("messageText").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  await ensureIdentity();
  await heartbeat();
  state.presencePoll = setInterval(heartbeat, 30000);
  await loadConversations();
})();
