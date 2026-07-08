const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { getManagerProjectIds, requireManagerProjectAccess } = require("../utils/projectAccess");

const router = express.Router();

async function writerProjectIds(db, writerId) {
  const { data, error } = await db.from("project_writers").select("project_id").eq("writer_id", writerId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.project_id).filter(Boolean);
}

async function touchLastActive(db, userId) {
  if (!userId) return;
  await db.from("users").update({ last_active_at: new Date().toISOString() }).eq("id", userId);
}

function sameOrganization(a, b) {
  if (!a?.organization_id || !b?.organization_id) return true;
  return a.organization_id === b.organization_id;
}

function messageIsUnreadFor(row, userId) {
  if (!row || row.sender_id === userId) return false;
  return !row.read_by || !row.read_by[userId];
}

function withMessageStatus(row, userId) {
  const readBy = row.read_by || {};
  let deliveryStatus = row.delivery_status || "delivered";
  if (row.sender_id === userId && Object.keys(readBy).some((id) => id !== userId)) {
    deliveryStatus = "read";
  }
  return {
    ...row,
    delivery_status: deliveryStatus,
    encrypted_key: row.encrypted_keys?.[userId] || null,
    is_unread: messageIsUnreadFor(row, userId)
  };
}

async function markMessagesRead(db, rows, userId) {
  const now = new Date().toISOString();
  const updates = (rows || [])
    .filter((row) => messageIsUnreadFor(row, userId))
    .map((row) =>
      db
        .from("encrypted_messages")
        .update({
          read_by: { ...(row.read_by || {}), [userId]: now },
          delivery_status: row.audience === "direct" ? "read" : row.delivery_status || "delivered"
        })
        .eq("id", row.id)
    );
  if (updates.length) await Promise.all(updates);
}

async function projectMemberIds(db, projectId) {
  const [writers, managers] = await Promise.all([
    db.from("project_writers").select("writer_id").eq("project_id", projectId),
    db.from("project_managers").select("manager_id").eq("project_id", projectId).eq("status", "active")
  ]);
  if (writers.error) throw new Error(writers.error.message);
  if (managers.error) throw new Error(managers.error.message);
  return Array.from(
    new Set([
      ...(writers.data || []).map((row) => row.writer_id),
      ...(managers.data || []).map((row) => row.manager_id)
    ].filter(Boolean))
  );
}

async function canAccessProject(db, user, projectId) {
  if (user.role === "admin") return true;
  if (user.role === "manager") {
    await requireManagerProjectAccess(db, projectId, user.id);
    return true;
  }
  const ids = await writerProjectIds(db, user.id);
  return ids.includes(projectId);
}

async function hydratePublicKeys(db, users) {
  return (users || []).map((user) => ({
    ...user,
    public_key: user.public_key_jwk
      ? {
          user_id: user.id,
          public_key_jwk: user.public_key_jwk,
          algorithm: "RSA-OAEP-256",
          updated_at: user.public_key_updated_at || null
        }
      : null
  }));
}

router.get("/keys/me", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("users")
    .select("id,public_key_jwk,public_key_updated_at")
    .eq("id", req.auth.user.id)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  const key = data?.public_key_jwk
    ? {
        user_id: data.id,
        public_key_jwk: data.public_key_jwk,
        algorithm: "RSA-OAEP-256",
        updated_at: data.public_key_updated_at || null
      }
    : null;
  return res.json({ key });
});

router.post("/keys", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const publicKey = req.body?.public_key_jwk;
  if (!publicKey || typeof publicKey !== "object") return res.status(400).json({ error: "public_key_jwk is required" });
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("users")
    .update({ public_key_jwk: publicKey, public_key_updated_at: new Date().toISOString() })
    .eq("id", req.auth.user.id)
    .select("id,public_key_jwk,public_key_updated_at")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({
    key: {
      user_id: data.id,
      public_key_jwk: data.public_key_jwk,
      algorithm: "RSA-OAEP-256",
      updated_at: data.public_key_updated_at || null
    }
  });
});

router.post("/presence", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { error } = await db.from("users").update({ last_active_at: new Date().toISOString() }).eq("id", req.auth.user.id);
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ ok: true });
});

router.get("/contacts", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const q = String(req.query.q || "").trim();
  const projectId = req.query.project_id ? String(req.query.project_id) : null;
  const select = "id,unique_id,email,full_name,role,is_active,organization_id,last_active_at,public_key_jwk,public_key_updated_at";

  try {
    touchLastActive(db, req.auth.user.id).catch(() => {});
    if (projectId) {
      const allowed = await canAccessProject(db, req.auth.user, projectId);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
      const ids = (await projectMemberIds(db, projectId)).filter((id) => id !== req.auth.user.id);
      if (!ids.length) return res.json({ users: [] });
      let projectUsers = db.from("users").select(select).in("id", ids).eq("is_active", true).order("full_name", { ascending: true });
      if (req.auth.user.organization_id) projectUsers = projectUsers.eq("organization_id", req.auth.user.organization_id);
      const { data, error } = await projectUsers;
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ users: await hydratePublicKeys(db, data || []) });
    }

    let query = db.from("users").select(select).eq("is_active", true).neq("id", req.auth.user.id).order("full_name", { ascending: true });
    if (req.auth.user.organization_id) query = query.eq("organization_id", req.auth.user.organization_id);
    if (q) query = query.ilike("full_name", `%${q}%`);
    const { data, error } = await query.limit(120);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ users: await hydratePublicKeys(db, data || []) });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.get("/conversations", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  try {
    touchLastActive(db, user.id).catch(() => {});
    let usersDbQuery = db
      .from("users")
      .select("id,unique_id,email,full_name,role,is_active,organization_id,last_active_at,public_key_jwk,public_key_updated_at")
      .eq("is_active", true)
      .neq("id", user.id)
      .order("full_name", { ascending: true });
    if (user.organization_id) usersDbQuery = usersDbQuery.eq("organization_id", user.organization_id);
    const usersQuery = await usersDbQuery.limit(120);
    if (usersQuery.error) return res.status(400).json({ error: usersQuery.error.message });

    const [contacts, projects, recentMessages] = await Promise.all([
      hydratePublicKeys(db, usersQuery.data || []),
      user.role === "manager"
        ? getManagerProjectIds(db, user.id).then(async (ids) => {
            if (!ids.length) return [];
            const { data, error } = await db.from("projects").select("id,title,status").in("id", ids).order("created_at", { ascending: false });
            if (error) throw new Error(error.message);
            return data || [];
          })
        : writerProjectIds(db, user.id).then(async (ids) => {
            if (!ids.length) return [];
            const { data, error } = await db.from("projects").select("id,title,status").in("id", ids).order("created_at", { ascending: false });
            if (error) throw new Error(error.message);
            return data || [];
          }),
      db
        .from("encrypted_messages")
        .select("id,sender_id,recipient_id,project_id,audience,created_at,delivery_status,read_by")
        .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
        .order("created_at", { ascending: false })
        .limit(500)
    ]);
    if (recentMessages.error) return res.status(400).json({ error: recentMessages.error.message });

    const unreadByContact = new Map();
    const lastByContact = new Map();
    for (const row of recentMessages.data || []) {
      if (row.audience !== "direct") continue;
      const otherId = row.sender_id === user.id ? row.recipient_id : row.sender_id;
      if (!otherId) continue;
      if (!lastByContact.has(otherId)) lastByContact.set(otherId, row.created_at);
      if (messageIsUnreadFor(row, user.id)) unreadByContact.set(otherId, (unreadByContact.get(otherId) || 0) + 1);
    }

    return res.json({
      contacts: contacts.map((contact) => ({
        ...contact,
        unread_count: unreadByContact.get(contact.id) || 0,
        last_message_at: lastByContact.get(contact.id) || null
      })),
      projects
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.get("/", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const recipientId = req.query.recipient_id ? String(req.query.recipient_id) : null;
  const projectId = req.query.project_id ? String(req.query.project_id) : null;

  try {
    touchLastActive(db, user.id).catch(() => {});
    let q = db
      .from("encrypted_messages")
      .select("*,sender:users!encrypted_messages_sender_id_fkey(id,full_name,email,role)")
      .order("created_at", { ascending: true })
      .limit(250);

    if (projectId) {
      const allowed = await canAccessProject(db, user, projectId);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
      q = q.eq("audience", "project").eq("project_id", projectId);
    } else if (recipientId) {
      const { data: recipient, error: recipientErr } = await db
        .from("users")
        .select("id,organization_id,is_active")
        .eq("id", recipientId)
        .maybeSingle();
      if (recipientErr) return res.status(400).json({ error: recipientErr.message });
      if (!recipient?.is_active || !sameOrganization(user, recipient)) return res.status(403).json({ error: "Forbidden" });
      q = q.or(`and(sender_id.eq.${user.id},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${user.id})`);
    } else {
      q = q.or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`);
    }

    const { data, error } = await q;
    if (error) return res.status(400).json({ error: error.message });
    await markMessagesRead(db, data || [], user.id);

    return res.json({
      messages: (data || []).map((row) => withMessageStatus(row, user.id))
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.post("/", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { recipient_id, project_id, audience, cipher_text, iv, keys, algorithm } = req.body || {};
  if (!cipher_text || !iv || !Array.isArray(keys) || !keys.length) {
    return res.status(400).json({ error: "Encrypted message payload and recipient keys are required" });
  }

  try {
    touchLastActive(db, req.auth.user.id).catch(() => {});
    const isProject = audience === "project";
    const encryptedKeys = keys.reduce((acc, key) => {
      if (key?.user_id && key?.encrypted_key) acc[key.user_id] = key.encrypted_key;
      return acc;
    }, {});
    if (!encryptedKeys[req.auth.user.id]) {
      return res.status(400).json({ error: "Sender encrypted key is required" });
    }

    if (isProject) {
      if (!project_id) return res.status(400).json({ error: "project_id is required for project messages" });
      const allowed = await canAccessProject(db, req.auth.user, project_id);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
    } else if (!recipient_id) {
      return res.status(400).json({ error: "recipient_id is required" });
    } else {
      const { data: recipient, error: recipientErr } = await db
        .from("users")
        .select("id,organization_id,is_active")
        .eq("id", recipient_id)
        .maybeSingle();
      if (recipientErr) return res.status(400).json({ error: recipientErr.message });
      if (!recipient?.is_active || !sameOrganization(req.auth.user, recipient)) return res.status(403).json({ error: "Forbidden" });
    }

    const { data, error } = await db
      .from("encrypted_messages")
      .insert([
        {
          sender_id: req.auth.user.id,
          recipient_id: isProject ? null : recipient_id,
          project_id: isProject ? project_id : null,
          organization_id: req.auth.user.organization_id || null,
          audience: isProject ? "project" : "direct",
          cipher_text,
          iv,
          salt: "",
          algorithm: algorithm || "AES-GCM/RSA-OAEP-256"
        }
      ])
      .select("id,sender_id,recipient_id,project_id,organization_id,audience,cipher_text,iv,salt,algorithm,created_at")
      .single();
    if (error) throw new Error(error.message);

    const { data: updated, error: updateErr } = await db
      .from("encrypted_messages")
      .update({
        encrypted_keys: encryptedKeys,
        delivery_status: "delivered",
        read_by: { [req.auth.user.id]: new Date().toISOString() }
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (updateErr) {
      await db.from("encrypted_messages").update({ delivery_status: "failed" }).eq("id", data.id);
      throw new Error(updateErr.message);
    }

    return res.json({ message: updated });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.get("/unread-count", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  try {
    touchLastActive(db, user.id).catch(() => {});
    let query = db
      .from("encrypted_messages")
      .select("id,sender_id,recipient_id,project_id,audience,read_by,encrypted_keys,organization_id")
      .neq("sender_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (user.organization_id) query = query.eq("organization_id", user.organization_id);
    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });
    const unread = (data || []).filter((row) => {
      if (row.audience === "direct" && row.recipient_id !== user.id) return false;
      if (row.audience === "project" && !row.encrypted_keys?.[user.id]) return false;
      return messageIsUnreadFor(row, user.id);
    }).length;
    return res.json({ unread });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

module.exports = router;
