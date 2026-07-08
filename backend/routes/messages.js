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
  const ids = (users || []).map((user) => user.id).filter(Boolean);
  if (!ids.length) return [];
  const { data: keys, error } = await db.from("user_public_keys").select("user_id,public_key_jwk,algorithm,updated_at").in("user_id", ids);
  if (error) throw new Error(error.message);
  const keyMap = new Map((keys || []).map((key) => [key.user_id, key]));
  return (users || []).map((user) => ({ ...user, public_key: keyMap.get(user.id) || null }));
}

router.get("/keys/me", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("user_public_keys").select("*").eq("user_id", req.auth.user.id).maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ key: data || null });
});

router.post("/keys", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const publicKey = req.body?.public_key_jwk;
  if (!publicKey || typeof publicKey !== "object") return res.status(400).json({ error: "public_key_jwk is required" });
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("user_public_keys")
    .upsert([{ user_id: req.auth.user.id, public_key_jwk: publicKey, algorithm: "RSA-OAEP-256", updated_at: new Date().toISOString() }])
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ key: data });
});

router.get("/contacts", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const q = String(req.query.q || "").trim();
  const projectId = req.query.project_id ? String(req.query.project_id) : null;
  const select = "id,unique_id,email,full_name,role,is_active";

  try {
    if (projectId) {
      const allowed = await canAccessProject(db, req.auth.user, projectId);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
      const ids = (await projectMemberIds(db, projectId)).filter((id) => id !== req.auth.user.id);
      if (!ids.length) return res.json({ users: [] });
      const { data, error } = await db.from("users").select(select).in("id", ids).eq("is_active", true).order("full_name", { ascending: true });
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ users: await hydratePublicKeys(db, data || []) });
    }

    let query = db.from("users").select(select).eq("is_active", true).neq("id", req.auth.user.id).order("full_name", { ascending: true });
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
    const usersQuery = await db
      .from("users")
      .select("id,unique_id,email,full_name,role,is_active")
      .eq("is_active", true)
      .neq("id", user.id)
      .order("full_name", { ascending: true })
      .limit(120);
    if (usersQuery.error) return res.status(400).json({ error: usersQuery.error.message });

    const [contacts, projects] = await Promise.all([
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
          })
    ]);
    return res.json({ contacts, projects });
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
      q = q.or(`and(sender_id.eq.${user.id},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${user.id})`);
    } else {
      q = q.or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`);
    }

    const { data, error } = await q;
    if (error) return res.status(400).json({ error: error.message });

    const ids = (data || []).map((row) => row.id);
    let keyMap = new Map();
    if (ids.length) {
      const { data: keys, error: keyErr } = await db
        .from("encrypted_message_keys")
        .select("message_id,encrypted_key")
        .in("message_id", ids)
        .eq("user_id", user.id);
      if (keyErr) return res.status(400).json({ error: keyErr.message });
      keyMap = new Map((keys || []).map((key) => [key.message_id, key.encrypted_key]));
    }

    return res.json({ messages: (data || []).map((row) => ({ ...row, encrypted_key: keyMap.get(row.id) || null })) });
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
    const isProject = audience === "project";
    if (isProject) {
      if (!project_id) return res.status(400).json({ error: "project_id is required for project messages" });
      const allowed = await canAccessProject(db, req.auth.user, project_id);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
    } else if (!recipient_id) {
      return res.status(400).json({ error: "recipient_id is required" });
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
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    const keyRows = keys
      .filter((key) => key?.user_id && key?.encrypted_key)
      .map((key) => ({ message_id: data.id, user_id: key.user_id, encrypted_key: key.encrypted_key }));
    if (!keyRows.some((key) => key.user_id === req.auth.user.id)) {
      return res.status(400).json({ error: "Sender encrypted key is required" });
    }
    const { error: keyErr } = await db.from("encrypted_message_keys").insert(keyRows);
    if (keyErr) throw new Error(keyErr.message);

    return res.json({ message: data });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

module.exports = router;
