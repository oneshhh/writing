const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { getManagerProjectIds, requireManagerProjectAccess } = require("../utils/projectAccess");

const router = express.Router();
const PLAIN_ALGORITHM = "plain";

async function writerProjectIds(db, writerId) {
  const { data, error } = await db.from("project_writers").select("project_id").eq("writer_id", writerId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.project_id).filter(Boolean);
}

async function accessibleProjectIds(db, user) {
  if (user.role === "manager") return getManagerProjectIds(db, user.id);
  if (user.role === "writer") return writerProjectIds(db, user.id);
  let query = db.from("projects").select("id").order("created_at", { ascending: false });
  if (user.organization_id) query = query.eq("organization_id", user.organization_id);
  const { data, error } = await query.limit(500);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.id).filter(Boolean);
}

async function touchLastActive(db, userId) {
  if (!userId) return;
  await db.from("users").update({ last_active_at: new Date().toISOString() }).eq("id", userId);
}

function sameOrganization(a, b) {
  if (!a?.organization_id || !b?.organization_id) return true;
  return a.organization_id === b.organization_id;
}

function uniqueIds(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function realtimeTopicForUser(user) {
  return `messages:${user?.organization_id || "global"}`;
}

async function broadcastRealtime(topic, event, payload) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !topic || !event) return;
  try {
    await fetch(`${url}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {})
    });
  } catch {}
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
    body: row.cipher_text || "",
    delivery_status: deliveryStatus,
    is_unread: messageIsUnreadFor(row, userId)
  };
}

async function markMessagesRead(db, rows, userId) {
  const now = new Date().toISOString();
  let updated = 0;
  for (const row of rows || []) {
    if (!messageIsUnreadFor(row, userId)) continue;
    const { error } = await db
      .from("encrypted_messages")
      .update({
        read_by: { ...(row.read_by || {}), [userId]: now },
        delivery_status: row.audience === "direct" ? "read" : row.delivery_status || "delivered"
      })
      .eq("id", row.id);
    if (!error) updated += 1;
  }
  return updated;
}

async function projectMemberIds(db, projectId) {
  const [writers, managers] = await Promise.all([
    db.from("project_writers").select("writer_id").eq("project_id", projectId),
    db.from("project_managers").select("manager_id").eq("project_id", projectId).eq("status", "active")
  ]);
  if (writers.error) throw new Error(writers.error.message);
  if (managers.error) throw new Error(managers.error.message);
  return uniqueIds([
    ...(writers.data || []).map((row) => row.writer_id),
    ...(managers.data || []).map((row) => row.manager_id)
  ]);
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

router.get("/realtime-config", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
  if (!url || !key) return res.status(500).json({ error: "Realtime is not configured" });
  return res.json({
    url,
    key,
    topic: realtimeTopicForUser(req.auth.user)
  });
});

router.post("/presence", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const lastActiveAt = new Date().toISOString();
  const { error } = await db.from("users").update({ last_active_at: lastActiveAt }).eq("id", req.auth.user.id);
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ ok: true, last_active_at: lastActiveAt });
});

router.get("/contacts", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const q = String(req.query.q || "").trim();
  const projectId = req.query.project_id ? String(req.query.project_id) : null;
  const select = "id,unique_id,email,full_name,role,is_active,organization_id,last_active_at";

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
      return res.json({ users: data || [] });
    }

    let query = db.from("users").select(select).eq("is_active", true).neq("id", req.auth.user.id).order("full_name", { ascending: true });
    if (req.auth.user.organization_id) query = query.eq("organization_id", req.auth.user.organization_id);
    if (q) query = query.ilike("full_name", `%${q}%`);
    const { data, error } = await query.limit(120);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ users: data || [] });
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
      .select("id,unique_id,email,full_name,role,is_active,organization_id,last_active_at")
      .eq("is_active", true)
      .neq("id", user.id)
      .order("full_name", { ascending: true });
    if (user.organization_id) usersDbQuery = usersDbQuery.eq("organization_id", user.organization_id);

    const [usersQuery, projectIds] = await Promise.all([usersDbQuery.limit(120), accessibleProjectIds(db, user)]);
    if (usersQuery.error) return res.status(400).json({ error: usersQuery.error.message });

    const [projectsQuery, directMessages, projectMessages] = await Promise.all([
      projectIds.length
        ? db.from("projects").select("id,title,status").in("id", projectIds).order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      db
        .from("encrypted_messages")
        .select("id,sender_id,recipient_id,project_id,audience,created_at,delivery_status,read_by")
        .eq("algorithm", PLAIN_ALGORITHM)
        .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
        .order("created_at", { ascending: false })
        .limit(500),
      projectIds.length
        ? db
            .from("encrypted_messages")
            .select("id,sender_id,recipient_id,project_id,audience,created_at,delivery_status,read_by")
            .eq("algorithm", PLAIN_ALGORITHM)
            .eq("audience", "project")
            .in("project_id", projectIds)
            .order("created_at", { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [], error: null })
    ]);

    if (projectsQuery.error) return res.status(400).json({ error: projectsQuery.error.message });
    if (directMessages.error) return res.status(400).json({ error: directMessages.error.message });
    if (projectMessages.error) return res.status(400).json({ error: projectMessages.error.message });

    const unreadByContact = new Map();
    const lastByContact = new Map();
    for (const row of directMessages.data || []) {
      if (row.audience !== "direct") continue;
      const otherId = row.sender_id === user.id ? row.recipient_id : row.sender_id;
      if (!otherId) continue;
      if (!lastByContact.has(otherId)) lastByContact.set(otherId, row.created_at);
      if (messageIsUnreadFor(row, user.id)) unreadByContact.set(otherId, (unreadByContact.get(otherId) || 0) + 1);
    }

    const unreadByProject = new Map();
    const lastByProject = new Map();
    for (const row of projectMessages.data || []) {
      if (!row.project_id) continue;
      if (!lastByProject.has(row.project_id)) lastByProject.set(row.project_id, row.created_at);
      if (messageIsUnreadFor(row, user.id)) unreadByProject.set(row.project_id, (unreadByProject.get(row.project_id) || 0) + 1);
    }

    return res.json({
      contacts: (usersQuery.data || []).map((contact) => ({
        ...contact,
        unread_count: unreadByContact.get(contact.id) || 0,
        last_message_at: lastByContact.get(contact.id) || null
      })),
      projects: (projectsQuery.data || []).map((project) => ({
        ...project,
        unread_count: unreadByProject.get(project.id) || 0,
        last_message_at: lastByProject.get(project.id) || null
      }))
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

    let query = db
      .from("encrypted_messages")
      .select("id,sender_id,recipient_id,project_id,organization_id,audience,cipher_text,created_at,delivery_status,read_by,sender:users!encrypted_messages_sender_id_fkey(id,full_name,email,role)")
      .eq("algorithm", PLAIN_ALGORITHM)
      .order("created_at", { ascending: true })
      .limit(250);

    if (projectId) {
      const allowed = await canAccessProject(db, user, projectId);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
      query = query.eq("audience", "project").eq("project_id", projectId);
    } else if (recipientId) {
      const { data: recipient, error: recipientErr } = await db
        .from("users")
        .select("id,organization_id,is_active")
        .eq("id", recipientId)
        .maybeSingle();
      if (recipientErr) return res.status(400).json({ error: recipientErr.message });
      if (!recipient?.is_active || !sameOrganization(user, recipient)) return res.status(403).json({ error: "Forbidden" });
      query = query.or(`and(sender_id.eq.${user.id},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${user.id})`);
    } else {
      query = query.or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`);
    }

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const updated = await markMessagesRead(db, data || [], user.id);
    if (updated) {
      await broadcastRealtime(realtimeTopicForUser(user), "messages:refresh", {
        reason: "read",
        project_id: projectId || null,
        direct_user_ids: recipientId ? uniqueIds([user.id, recipientId]) : null
      });
    }

    return res.json({
      messages: (data || []).map((row) => withMessageStatus(row, user.id))
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.post("/", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const text = String(req.body?.text || "").trim();
  const audience = req.body?.audience === "project" ? "project" : "direct";
  const projectId = req.body?.project_id ? String(req.body.project_id) : null;
  const recipientId = req.body?.recipient_id ? String(req.body.recipient_id) : null;

  if (!text) return res.status(400).json({ error: "Message text is required" });

  try {
    touchLastActive(db, user.id).catch(() => {});

    if (audience === "project") {
      if (!projectId) return res.status(400).json({ error: "project_id is required for project messages" });
      const allowed = await canAccessProject(db, user, projectId);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
    } else if (!recipientId) {
      return res.status(400).json({ error: "recipient_id is required" });
    } else {
      const { data: recipient, error: recipientErr } = await db
        .from("users")
        .select("id,organization_id,is_active")
        .eq("id", recipientId)
        .maybeSingle();
      if (recipientErr) return res.status(400).json({ error: recipientErr.message });
      if (!recipient?.is_active || !sameOrganization(user, recipient)) return res.status(403).json({ error: "Forbidden" });
    }

    const now = new Date().toISOString();
    const { data, error } = await db
      .from("encrypted_messages")
      .insert([
        {
          sender_id: user.id,
          recipient_id: audience === "project" ? null : recipientId,
          project_id: audience === "project" ? projectId : null,
          organization_id: user.organization_id || null,
          audience,
          cipher_text: text,
          iv: "",
          salt: "",
          algorithm: PLAIN_ALGORITHM,
          encrypted_keys: {},
          delivery_status: "delivered",
          read_by: { [user.id]: now }
        }
      ])
      .select("id,sender_id,recipient_id,project_id,organization_id,audience,cipher_text,created_at,delivery_status,read_by,sender:users!encrypted_messages_sender_id_fkey(id,full_name,email,role)")
      .single();
    if (error) throw new Error(error.message);

    await broadcastRealtime(realtimeTopicForUser(user), "messages:refresh", {
      reason: "message",
      message_id: data.id,
      project_id: audience === "project" ? projectId : null,
      direct_user_ids: audience === "direct" ? uniqueIds([user.id, recipientId]) : null
    });

    return res.json({ message: withMessageStatus(data, user.id) });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.get("/unread-count", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  try {
    touchLastActive(db, user.id).catch(() => {});
    const projectIds = new Set(await accessibleProjectIds(db, user));
    let query = db
      .from("encrypted_messages")
      .select("id,sender_id,recipient_id,project_id,audience,read_by,organization_id")
      .eq("algorithm", PLAIN_ALGORITHM)
      .neq("sender_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (user.organization_id) query = query.eq("organization_id", user.organization_id);
    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });
    const unread = (data || []).filter((row) => {
      if (row.audience === "direct") return row.recipient_id === user.id && messageIsUnreadFor(row, user.id);
      return projectIds.has(row.project_id) && messageIsUnreadFor(row, user.id);
    }).length;
    return res.json({ unread });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

module.exports = router;
