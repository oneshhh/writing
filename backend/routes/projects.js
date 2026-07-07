const express = require("express");
const crypto = require("crypto");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const {
  getManagerProjectIds,
  requireManagerProjectAccess,
  ensureCreatorMembership
} = require("../utils/projectAccess");

const router = express.Router();

async function deleteProjectTree(db, projectId) {
  const { data: articles, error: articleListErr } = await db.from("articles").select("id").eq("project_id", projectId);
  if (articleListErr) throw articleListErr;

  const articleIds = (articles || []).map((article) => article.id).filter(Boolean);
  if (articleIds.length) {
    const { error: paymentByArticleErr } = await db.from("payments").delete().in("article_id", articleIds);
    if (paymentByArticleErr) throw paymentByArticleErr;
  }

  const { error: paymentErr } = await db.from("payments").delete().eq("project_id", projectId);
  if (paymentErr) throw paymentErr;

  const { error: articleErr } = await db.from("articles").delete().eq("project_id", projectId);
  if (articleErr) throw articleErr;

  const { error: assignmentErr } = await db.from("project_writers").delete().eq("project_id", projectId);
  if (assignmentErr) throw assignmentErr;

  await db.from("project_manager_invites").delete().eq("project_id", projectId);
  await db.from("project_managers").delete().eq("project_id", projectId);

  const { error: projectErr } = await db.from("projects").delete().eq("id", projectId);
  if (projectErr) throw projectErr;
}

function publicInvite(invite) {
  return {
    id: invite.id,
    project_id: invite.project_id,
    token: invite.token,
    expires_at: invite.expires_at,
    max_uses: invite.max_uses,
    used_count: invite.used_count,
    status: invite.status,
    created_at: invite.created_at
  };
}

router.get("/", async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  if (user.role === "admin") {
    const { data, error } = await db.from("projects").select("*").order("created_at", { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ projects: data });
  }

  if (user.role === "manager") {
    let projectIds;
    try {
      projectIds = await getManagerProjectIds(db, user.id);
    } catch (e) {
      return res.status(400).json({ error: e.message || String(e) });
    }
    if (!projectIds.length) return res.json({ projects: [] });

    const { data, error } = await db.from("projects").select("*").in("id", projectIds).order("created_at", { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ projects: data });
  }

  // writer
  const { data, error } = await db
    .from("project_writers")
    .select("projects(*)")
    .eq("writer_id", user.id);
  if (error) return res.status(400).json({ error: error.message });
  const projects = (data || []).map((row) => row.projects).filter(Boolean);
  return res.json({ projects });
});

router.post("/", authorizeRoles("manager"), async (req, res) => {
  const { title, description, ai_check_enabled, plagiarism_check_enabled, manager_ids } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("projects")
    .insert([
      {
        title,
        description: description || null,
        created_by: req.auth.user.id,
        ai_check_enabled: !!ai_check_enabled,
        plagiarism_check_enabled: !!plagiarism_check_enabled
      }
    ])
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });

  try {
    await ensureCreatorMembership(db, data.id, req.auth.user.id);
    const extraManagerIds = Array.from(new Set(Array.isArray(manager_ids) ? manager_ids : []))
      .map((value) => String(value || "").trim())
      .filter((managerId) => managerId && managerId !== req.auth.user.id);

    if (extraManagerIds.length) {
      const { data: managers, error: mErr } = await db
        .from("users")
        .select("id")
        .in("id", extraManagerIds)
        .eq("role", "manager")
        .eq("is_active", true);
      if (mErr) throw new Error(mErr.message);
      const validIds = new Set((managers || []).map((manager) => manager.id));
      const rows = extraManagerIds
        .filter((managerId) => validIds.has(managerId))
        .map((managerId) => ({
          project_id: data.id,
          manager_id: managerId,
          role: "manager",
          status: "active",
          invited_by: req.auth.user.id
        }));
      if (rows.length) {
        const { error: upsertErr } = await db.from("project_managers").upsert(rows, { onConflict: "project_id,manager_id" });
        if (upsertErr) throw new Error(upsertErr.message);
      }
    }
  } catch (e) {
    return res.status(400).json({ error: e.message || "Could not set project managers" });
  }

  return res.json({ project: data });
});

router.get("/:id/managers", authorizeRoles("manager", "admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();

  if (req.auth.user.role === "manager") {
    try {
      await requireManagerProjectAccess(db, id, req.auth.user.id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
    }
  }

  const { data, error } = await db
    .from("project_managers")
    .select("id,project_id,manager_id,role,status,joined_at")
    .eq("project_id", id)
    .eq("status", "active")
    .order("joined_at", { ascending: true });
  if (error) return res.status(400).json({ error: error.message });

  const managerIds = Array.from(new Set((data || []).map((row) => row.manager_id).filter(Boolean)));
  let usersById = new Map();
  if (managerIds.length) {
    const { data: users, error: usersErr } = await db
      .from("users")
      .select("id,full_name,unique_id,email")
      .in("id", managerIds);
    if (usersErr) return res.status(400).json({ error: usersErr.message });
    usersById = new Map((users || []).map((user) => [user.id, user]));
  }

  return res.json({ managers: (data || []).map((row) => ({ ...row, users: usersById.get(row.manager_id) || null })) });
});

router.post("/:id/managers", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const { manager_id } = req.body || {};
  if (!manager_id) return res.status(400).json({ error: "manager_id required" });

  const db = getSupabaseAdmin();
  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const { data: manager, error: managerErr } = await db
    .from("users")
    .select("id,role,is_active")
    .eq("id", manager_id)
    .single();
  if (managerErr) return res.status(400).json({ error: managerErr.message });
  if (manager.role !== "manager" || manager.is_active === false) {
    return res.status(400).json({ error: "Only active managers can be added." });
  }

  const { data, error } = await db
    .from("project_managers")
    .upsert(
      [{ project_id: id, manager_id, role: "manager", status: "active", invited_by: req.auth.user.id }],
      { onConflict: "project_id,manager_id" }
    )
    .select("id,project_id,manager_id,role,status,joined_at")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ manager: data });
});

router.delete("/:id/managers/:managerId", authorizeRoles("manager"), async (req, res) => {
  const { id, managerId } = req.params;
  if (managerId === req.auth.user.id) return res.status(400).json({ error: "You cannot remove yourself from this project." });

  const db = getSupabaseAdmin();
  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (managerId === project.created_by) return res.status(400).json({ error: "The project creator cannot be removed." });

  const { error } = await db
    .from("project_managers")
    .update({ status: "removed" })
    .eq("project_id", id)
    .eq("manager_id", managerId);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(204).send();
});

router.post("/:id/invites", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();
  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const rawDays = Number(req.body?.days || 7);
  const rawMaxUses = Number(req.body?.max_uses || 20);
  const days = Math.max(1, Math.min(30, Number.isFinite(rawDays) ? rawDays : 7));
  const maxUses = Math.max(1, Math.min(100, Number.isFinite(rawMaxUses) ? rawMaxUses : 20));
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("project_manager_invites")
    .insert([
      {
        project_id: id,
        token,
        created_by: req.auth.user.id,
        expires_at: expiresAt,
        max_uses: maxUses,
        used_count: 0,
        status: "active"
      }
    ])
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ invite: publicInvite(data) });
});

router.get("/invites/:token", authorizeRoles("manager"), async (req, res) => {
  const db = getSupabaseAdmin();
  const token = String(req.params.token || "");
  const { data: invite, error } = await db
    .from("project_manager_invites")
    .select("*,projects(id,title,description,status)")
    .eq("token", token)
    .single();
  if (error) return res.status(404).json({ error: "Invite not found" });
  if (invite.status !== "active" || new Date(invite.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: "Invite expired" });
  }
  if (Number(invite.used_count || 0) >= Number(invite.max_uses || 1)) {
    return res.status(410).json({ error: "Invite has reached its usage limit" });
  }
  return res.json({ invite: publicInvite(invite), project: invite.projects });
});

router.post("/invites/:token/accept", authorizeRoles("manager"), async (req, res) => {
  const db = getSupabaseAdmin();
  const token = String(req.params.token || "");
  const { data: invite, error } = await db.from("project_manager_invites").select("*").eq("token", token).single();
  if (error) return res.status(404).json({ error: "Invite not found" });
  if (invite.status !== "active" || new Date(invite.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: "Invite expired" });
  }
  if (Number(invite.used_count || 0) >= Number(invite.max_uses || 1)) {
    return res.status(410).json({ error: "Invite has reached its usage limit" });
  }

  const { data: existing, error: existingErr } = await db
    .from("project_managers")
    .select("id,status")
    .eq("project_id", invite.project_id)
    .eq("manager_id", req.auth.user.id)
    .maybeSingle();
  if (existingErr) return res.status(400).json({ error: existingErr.message });

  const { error: upsertErr } = await db.from("project_managers").upsert(
    [
      {
        project_id: invite.project_id,
        manager_id: req.auth.user.id,
        role: "manager",
        status: "active",
        invited_by: invite.created_by
      }
    ],
    { onConflict: "project_id,manager_id" }
  );
  if (upsertErr) return res.status(400).json({ error: upsertErr.message });

  if (!existing || existing.status !== "active") {
    await db
      .from("project_manager_invites")
      .update({ used_count: Number(invite.used_count || 0) + 1 })
      .eq("id", invite.id);
  }

  return res.json({ ok: true, project_id: invite.project_id });
});

router.post("/:id/writers", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const { writer_id, price_per_article } = req.body || {};
  if (!writer_id) return res.status(400).json({ error: "writer_id required" });
  const price = Number(price_per_article);
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Invalid price_per_article" });

  const db = getSupabaseAdmin();
  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const { data, error } = await db
    .from("project_writers")
    .upsert(
      [{ project_id: id, writer_id, price_per_article: price }],
      { onConflict: "project_id,writer_id" }
    )
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ assignment: data });
});

router.patch("/:id/writers/:writerId", authorizeRoles("manager"), async (req, res) => {
  const { id, writerId } = req.params;
  const { price_per_article } = req.body || {};
  const price = Number(price_per_article);
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Invalid price_per_article" });

  const db = getSupabaseAdmin();
  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const { data, error } = await db
    .from("project_writers")
    .update({ price_per_article: price })
    .eq("project_id", id)
    .eq("writer_id", writerId)
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ assignment: data });
});

router.delete("/:id/writers/:writerId", authorizeRoles("manager"), async (req, res) => {
  const { id, writerId } = req.params;
  const db = getSupabaseAdmin();

  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const { error } = await db.from("project_writers").delete().eq("project_id", id).eq("writer_id", writerId);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(204).send();
});

router.get("/:id/writers", authorizeRoles("manager", "admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();

  if (req.auth.user.role === "manager") {
    try {
      await requireManagerProjectAccess(db, id, req.auth.user.id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
    }
  }

  const { data, error } = await db
    .from("project_writers")
    .select("id,project_id,writer_id,price_per_article,assigned_at,users(id,full_name,unique_id,email)")
    .eq("project_id", id)
    .order("assigned_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ writers: data });
});

router.patch("/:id", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const { title, description, ai_check_enabled, plagiarism_check_enabled, status } = req.body || {};
  const db = getSupabaseAdmin();

  const { data: project, error: pErr } = await db.from("projects").select("*").eq("id", id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  try {
    await requireManagerProjectAccess(db, id, req.auth.user.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
  }

  const patch = {
    title: title ?? project.title,
    description: description ?? project.description,
    ai_check_enabled: ai_check_enabled === undefined ? project.ai_check_enabled : !!ai_check_enabled,
    plagiarism_check_enabled:
      plagiarism_check_enabled === undefined ? project.plagiarism_check_enabled : !!plagiarism_check_enabled,
    status: status ?? project.status
  };

  const { data, error } = await db.from("projects").update(patch).eq("id", id).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ project: data });
});

router.delete("/:id", authorizeRoles("manager", "admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();

  const { data: project, error: pErr } = await db.from("projects").select("id,created_by").eq("id", id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (req.auth.user.role === "manager") {
    try {
      await requireManagerProjectAccess(db, id, req.auth.user.id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message || "Forbidden" });
    }
  }

  try {
    await deleteProjectTree(db, id);
    return res.status(204).send();
  } catch (e) {
    return res.status(400).json({ error: e.message || "Could not delete project" });
  }
});

module.exports = router;
