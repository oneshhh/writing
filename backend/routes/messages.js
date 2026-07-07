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

async function canAccessProject(db, user, projectId) {
  if (user.role === "admin") return true;
  if (user.role === "manager") {
    await requireManagerProjectAccess(db, projectId, user.id);
    return true;
  }
  const ids = await writerProjectIds(db, user.id);
  return ids.includes(projectId);
}

router.get("/contacts", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const q = String(req.query.q || "").trim();
  const select = "id,unique_id,email,full_name,role,is_active";
  let byName = db.from("users").select(select).eq("is_active", true).neq("id", req.auth.user.id).order("full_name", { ascending: true });
  if (q) byName = byName.ilike("full_name", `%${q}%`);
  const { data, error } = await byName.limit(80);
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ users: data });
});

router.get("/", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const recipientId = req.query.recipient_id ? String(req.query.recipient_id) : null;
  const projectId = req.query.project_id ? String(req.query.project_id) : null;

  try {
    let q = db.from("encrypted_messages").select("*,sender:users!encrypted_messages_sender_id_fkey(id,full_name,email,role)").order("created_at", { ascending: true }).limit(200);

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
    return res.json({ messages: data });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.post("/", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { recipient_id, project_id, audience, cipher_text, iv, salt, algorithm } = req.body || {};
  if (!cipher_text || !iv || !salt) return res.status(400).json({ error: "Encrypted message payload is required" });

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
          salt,
          algorithm: algorithm || "AES-GCM/PBKDF2"
        }
      ])
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return res.json({ message: data });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

module.exports = router;
