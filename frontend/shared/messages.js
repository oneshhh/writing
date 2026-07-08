/* global APP, APP_CONFIG, RW_MESSAGES_ROLE */

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
    privateKey: null,
    publicKeyJwk: null
  };

  const msg = (text) => (document.getElementById("msg").textContent = text || "");

  function b64(bytes) {
    const data = new Uint8Array(bytes);
    let out = "";
    for (let i = 0; i < data.length; i += 1) out += String.fromCharCode(data[i]);
    return btoa(out);
  }

  function fromB64(value) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
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
      if (!existing.key) {
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
      } else {
        state.publicKeyJwk = existing.key.public_key_jwk;
      }
      return;
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

  async function loadConversations() {
    const out = await APP.apiFetch("/api/messages/conversations", { skipLoader: true });
    state.contacts = out.contacts || [];
    state.projects = out.projects || [];
    renderConversationList();
  }

  function renderConversationList() {
    const q = String(document.getElementById("chatSearch").value || "").toLowerCase();
    const items = [
      ...state.contacts.map((contact) => ({
        kind: "direct",
        id: contact.id,
        title: contact.full_name || contact.email || "User",
        sub: `${contact.role || "user"}${contact.public_key ? "" : " - needs key setup"}`,
        enabled: !!contact.public_key
      })),
      ...state.projects.map((project) => ({
        kind: "project",
        id: project.id,
        title: project.title || "Project room",
        sub: "Project room",
        enabled: true
      }))
    ].filter((item) => `${item.title} ${item.sub}`.toLowerCase().includes(q));

    document.getElementById("conversationList").innerHTML = items.length
      ? items
          .map(
            (item) => `<button class="chat-list-item ${state.active?.kind === item.kind && state.active?.id === item.id ? "active" : ""}" data-chat-kind="${item.kind}" data-chat-id="${item.id}" ${item.enabled ? "" : "disabled"} type="button">
              <span>
                <strong>${APP.escapeHtml(item.title)}</strong>
                <span>${APP.escapeHtml(item.sub)}</span>
              </span>
            </button>`
          )
          .join("")
      : "<div class='muted'>No conversations found.</div>";

    for (const button of document.querySelectorAll("[data-chat-kind]")) {
      button.onclick = async () => {
        state.active = {
          kind: button.getAttribute("data-chat-kind"),
          id: button.getAttribute("data-chat-id"),
          title: button.querySelector("strong")?.textContent || "Conversation"
        };
        renderConversationList();
        await loadMessages();
        if (state.poll) clearInterval(state.poll);
        state.poll = setInterval(loadMessages, 4500);
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

  async function loadMessages() {
    if (!state.active) return;
    const title = document.getElementById("chatTitle");
    title.textContent = state.active.title;
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
      rows.push(`<div class="chat-bubble ${row.sender_id === user.id ? "mine" : ""}">
        <div>${APP.escapeHtml(text)}</div>
        <span>${APP.escapeHtml(row.sender?.full_name || "User")} - ${APP.escapeHtml(new Date(row.created_at).toLocaleTimeString())}</span>
      </div>`);
    }
    const list = document.getElementById("messageList");
    list.innerHTML = rows.join("") || "<div class='muted'>No messages yet. Start the conversation.</div>";
    list.scrollTop = list.scrollHeight;
  }

  async function sendMessage() {
    msg("");
    if (!state.active) return msg("Choose a conversation first.");
    const input = document.getElementById("messageText");
    const text = input.value.trim();
    if (!text) return;

    const send = document.getElementById("sendMessage");
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
    } catch (e) {
      msg(e.message || String(e));
    } finally {
      send.disabled = false;
    }
  }

  document.getElementById("chatSearch").addEventListener("input", renderConversationList);
  document.getElementById("sendMessage").onclick = sendMessage;
  document.getElementById("messageText").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  await ensureIdentity();
  await loadConversations();
})();
