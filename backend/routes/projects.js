const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");

const router = express.Router();

router.get("/", async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  if (user.role === "admin") {
    const { data, error } = await db.from("projects").select("*").order("created_at", { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ projects: data });
  }

  if (user.role === "manager") {
    const { data, error } = await db
      .from("projects")
      .select("*")
      .eq("created_by", user.id)
      .order("created_at", { ascending: false });
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
  const { title, description, ai_check_enabled, plagiarism_check_enabled } = req.body || {};
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
  return res.json({ project: data });
});

router.post("/:id/writers", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const { writer_id, price_per_article } = req.body || {};
  if (!writer_id) return res.status(400).json({ error: "writer_id required" });
  const price = Number(price_per_article);
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Invalid price_per_article" });

  const db = getSupabaseAdmin();
  // ensure project belongs to this manager
  const { data: project, error: pErr } = await db.from("projects").select("id,created_by").eq("id", id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });

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
  // ensure project belongs to this manager
  const { data: project, error: pErr } = await db.from("projects").select("id,created_by").eq("id", id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });

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

  // ensure project belongs to this manager
  const { data: project, error: pErr } = await db.from("projects").select("id,created_by").eq("id", id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });

  const { error } = await db.from("project_writers").delete().eq("project_id", id).eq("writer_id", writerId);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(204).send();
});

router.get("/:id/writers", authorizeRoles("manager", "admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();

  if (req.auth.user.role === "manager") {
    const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", id).single();
    if (pErr) return res.status(400).json({ error: pErr.message });
    if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });
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
  if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });

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

module.exports = router;
