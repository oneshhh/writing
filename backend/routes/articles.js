const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { buildArticleUniqueId } = require("../utils/uniqueId");
const { runAiCheck } = require("../services/aiCheck");
const { runPlagiarismCheck } = require("../services/plagiarismCheck");
const { createNotification } = require("../services/notifications");

const router = express.Router();

async function nextArticleUniqueId(db, projectId) {
  const prefix = `ART-${projectId}-`;
  const { data, error } = await db
    .from("articles")
    .select("unique_id")
    .eq("project_id", projectId)
    .ilike("unique_id", `${prefix}%`);
  if (error) throw error;

  const maxSeq = (data || []).reduce((max, row) => {
    const raw = String(row.unique_id || "");
    if (!raw.startsWith(prefix)) return max;
    const seq = Number(raw.slice(prefix.length));
    return Number.isInteger(seq) && seq > max ? seq : max;
  }, 0);

  return buildArticleUniqueId(projectId, maxSeq + 1);
}

function isUniqueConstraintError(error) {
  const msg = String(error?.message || "");
  return error?.code === "23505" || msg.includes("articles_unique_id_key") || msg.includes("duplicate key value");
}

router.get("/", async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit = limitRaw === undefined ? null : Number(limitRaw);
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  const usePaging = Number.isFinite(limit) && limit > 0;
  const rangeFrom = usePaging ? Math.max(0, Number.isFinite(offset) ? offset : 0) : null;
  const rangeTo = usePaging ? rangeFrom + limit - 1 : null;

  if (user.role === "writer") {
    let q = db
      .from("articles")
      .select("*", { count: "exact" })
      .eq("writer_id", user.id)
      .order("updated_at", { ascending: false });
    if (usePaging) q = q.range(rangeFrom, rangeTo);
    const { data, error, count } = await q;
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ articles: data, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
  }

  if (user.role === "manager") {
    // manager sees articles in their projects
    const { data: projects, error: pErr } = await db.from("projects").select("id").eq("created_by", user.id);
    if (pErr) return res.status(400).json({ error: pErr.message });
    const projectIds = (projects || []).map((p) => p.id);
    if (projectIds.length === 0) return res.json({ articles: [] });

    let q = db
      .from("articles")
      .select("*", { count: "exact" })
      .in("project_id", projectIds)
      .order("submitted_at", { ascending: false, nullsFirst: false });
    if (usePaging) q = q.range(rangeFrom, rangeTo);
    const { data, error, count } = await q;
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ articles: data, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
  }

  // admin
  let q = db.from("articles").select("*", { count: "exact" }).order("created_at", { ascending: false });
  if (usePaging) q = q.range(rangeFrom, rangeTo);
  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ articles: data, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
});

router.get("/stats/me", authorizeRoles("writer"), async (req, res) => {
  const db = getSupabaseAdmin();
  const writerId = req.auth.user.id;

  const { data, error } = await db
    .from("articles")
    .select("status")
    .eq("writer_id", writerId);
  if (error) return res.status(400).json({ error: error.message });

  const counts = { approved: 0, rejected: 0, rework: 0, draft: 0, submitted: 0 };
  for (const row of data || []) {
    if (counts[row.status] !== undefined) counts[row.status] += 1;
  }
  return res.json({ counts });
});

router.get("/stats/monthly", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const monthsRaw = req.query.months;
  const months = Math.max(1, Math.min(24, Number.isFinite(Number(monthsRaw)) ? Number(monthsRaw) : 12));

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1, 0, 0, 0));
  const startIso = start.toISOString();

  const monthKey = (iso) => String(iso || "").slice(0, 7); // YYYY-MM
  const keys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1, 0, 0, 0));
    keys.push(d.toISOString().slice(0, 7));
  }
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));

  async function applyRows(rows) {
    for (const r of rows || []) {
      const k = monthKey(r.created_at);
      if (counts[k] !== undefined) counts[k] += 1;
    }
  }

  if (user.role === "writer") {
    const { data, error } = await db
      .from("articles")
      .select("id,created_at")
      .eq("writer_id", user.id)
      .gte("created_at", startIso)
      .order("created_at", { ascending: true });
    if (error) return res.status(400).json({ error: error.message });
    await applyRows(data);
    return res.json({ months: keys.map((k) => ({ month: k, count: counts[k] })) });
  }

  if (user.role === "manager") {
    const { data: projects, error: pErr } = await db.from("projects").select("id").eq("created_by", user.id);
    if (pErr) return res.status(400).json({ error: pErr.message });
    const projectIds = (projects || []).map((p) => p.id);
    if (projectIds.length === 0) return res.json({ months: keys.map((k) => ({ month: k, count: 0 })) });

    const { data, error } = await db
      .from("articles")
      .select("id,created_at")
      .in("project_id", projectIds)
      .gte("created_at", startIso)
      .order("created_at", { ascending: true });
    if (error) return res.status(400).json({ error: error.message });
    await applyRows(data);
    return res.json({ months: keys.map((k) => ({ month: k, count: counts[k] })) });
  }

  // admin
  const { data, error } = await db
    .from("articles")
    .select("id,created_at")
    .gte("created_at", startIso)
    .order("created_at", { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  await applyRows(data);
  return res.json({ months: keys.map((k) => ({ month: k, count: counts[k] })) });
});

router.get("/admin/list", authorizeRoles("admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit = limitRaw === undefined ? 10 : Number(limitRaw);
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  const usePaging = Number.isFinite(limit) && limit > 0;
  const rangeFrom = usePaging ? Math.max(0, Number.isFinite(offset) ? offset : 0) : 0;
  const rangeTo = usePaging ? rangeFrom + limit - 1 : null;

  const projectId = req.query.project_id ? String(req.query.project_id) : null;
  const q = String(req.query.q || "").trim();

  const baseSelect = "id,unique_id,project_id,writer_id,title,status,created_at,updated_at,submitted_at,reviewed_at";

  const buildQuery = () => {
    let query = db.from("articles").select(baseSelect, { count: "exact" }).order("created_at", { ascending: false });
    if (projectId) query = query.eq("project_id", projectId);
    return query;
  };

  // Search: do best-effort OR across `title` and `unique_id` (and writer_id) via two queries + union.
  if (q) {
    const [byTitle, byUid] = await Promise.all([
      buildQuery().ilike("title", `%${q}%`),
      buildQuery().ilike("unique_id", `%${q}%`)
    ]);
    const err = byTitle.error || byUid.error;
    if (err) return res.status(400).json({ error: err.message });
    const all = [...(byTitle.data || []), ...(byUid.data || [])];
    const dedup = Array.from(new Map(all.map((a) => [a.id, a])).values()).sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );
    const paged = usePaging ? dedup.slice(rangeFrom, rangeFrom + limit) : dedup;
    return res.json({ articles: paged, total: dedup.length, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
  }

  let query = buildQuery();
  if (usePaging && rangeTo != null) query = query.range(rangeFrom, rangeTo);
  const { data, error, count } = await query;
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ articles: data, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
});

router.get("/admin/enriched", authorizeRoles("admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const out = await db
    .from("articles")
    .select("id,unique_id,project_id,writer_id,title,status,created_at,updated_at,submitted_at,reviewed_at", { count: "exact" });
  // We'll delegate filtering/paging to /admin/list to keep this endpoint simple.
  // This route is unused for now but kept for future expansion.
  if (out.error) return res.status(400).json({ error: out.error.message });
  return res.json({ articles: out.data, total: out.count ?? null });
});

router.get("/:id", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();
  const user = req.auth.user;

  const { data: article, error: getErr } = await db.from("articles").select("*").eq("id", id).single();
  if (getErr) return res.status(400).json({ error: getErr.message });

  if (user.role === "writer") {
    if (article.writer_id !== user.id) return res.status(403).json({ error: "Forbidden" });
    return res.json({ article });
  }

  if (user.role === "manager") {
    const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", article.project_id).single();
    if (pErr) return res.status(400).json({ error: pErr.message });
    if (project.created_by !== user.id) return res.status(403).json({ error: "Forbidden" });
    return res.json({ article });
  }

  // admin
  return res.json({ article });
});

router.delete("/:id", authorizeRoles("admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();

  // Delete related payment rows first (best-effort) to avoid FK constraints.
  await db.from("payments").delete().eq("article_id", id);

  const { error } = await db.from("articles").delete().eq("id", id);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(204).send();
});

router.post("/", authorizeRoles("writer"), async (req, res) => {
  const { project_id, title, short_description, long_description, article_type, seo_tags } = req.body || {};
  if (!project_id) return res.status(400).json({ error: "project_id is required" });
  if (!title) return res.status(400).json({ error: "title is required" });

  const db = getSupabaseAdmin();
  // ensure writer is assigned to project
  const { data: assignment, error: aErr } = await db
    .from("project_writers")
    .select("id")
    .eq("project_id", project_id)
    .eq("writer_id", req.auth.user.id)
    .maybeSingle();
  if (aErr) return res.status(400).json({ error: aErr.message });
  if (!assignment) return res.status(403).json({ error: "Writer not assigned to project" });

  const articlePayload = {
    project_id,
    writer_id: req.auth.user.id,
    title,
    short_description: short_description || null,
    long_description: long_description || null,
    article_type: article_type || "other",
    seo_tags: Array.isArray(seo_tags) ? seo_tags : null
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let unique_id;
    try {
      unique_id = await nextArticleUniqueId(db, project_id);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { data, error } = await db
      .from("articles")
      .insert([{ ...articlePayload, unique_id }])
      .select("*")
      .single();
    if (!error) return res.json({ article: data });
    if (!isUniqueConstraintError(error) || attempt === 2) return res.status(400).json({ error: error.message });
  }

  return res.status(409).json({ error: "Could not generate a unique article id. Please try again." });
});

router.patch("/:id", authorizeRoles("writer"), async (req, res) => {
  const { id } = req.params;
  const { title, short_description, long_description, article_type, seo_tags } = req.body || {};

  const db = getSupabaseAdmin();
  const { data: article, error: getErr } = await db.from("articles").select("*").eq("id", id).single();
  if (getErr) return res.status(400).json({ error: getErr.message });
  if (article.writer_id !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });
  if (!["draft", "rework"].includes(article.status)) return res.status(400).json({ error: "Cannot edit in this status" });

  const patch = {
    title: title ?? article.title,
    short_description: short_description ?? article.short_description,
    long_description: long_description ?? article.long_description,
    article_type: article_type ?? article.article_type,
    seo_tags: seo_tags === undefined ? article.seo_tags : Array.isArray(seo_tags) ? seo_tags : null
  };

  const { data, error } = await db.from("articles").update(patch).eq("id", id).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ article: data });
});

router.post("/:id/submit", authorizeRoles("writer"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();

  const { data: article, error: getErr } = await db.from("articles").select("*").eq("id", id).single();
  if (getErr) return res.status(400).json({ error: getErr.message });
  if (article.writer_id !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });
  if (!["draft", "rework"].includes(article.status)) return res.status(400).json({ error: "Cannot submit in this status" });

  const { data: project, error: pErr } = await db.from("projects").select("*").eq("id", article.project_id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });

  const { data: updated, error: upErr } = await db
    .from("articles")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), manager_note: null })
    .eq("id", id)
    .select("*")
    .single();
  if (upErr) return res.status(400).json({ error: upErr.message });

  // Checks (best-effort for now)
  const patchChecks = {};
  if (project.ai_check_enabled) patchChecks.ai_score = await runAiCheck(updated);
  if (project.plagiarism_check_enabled) patchChecks.plagiarism_score = await runPlagiarismCheck(updated);
  if (Object.keys(patchChecks).length) {
    await db.from("articles").update(patchChecks).eq("id", id);
  }

  return res.json({ article: { ...updated, ...patchChecks } });
});

router.post("/:id/review", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const { action, manager_note } = req.body || {};
  if (!["approved", "rejected", "rework"].includes(action)) return res.status(400).json({ error: "Invalid action" });

  const db = getSupabaseAdmin();
  const { data: article, error: getErr } = await db.from("articles").select("*").eq("id", id).single();
  if (getErr) return res.status(400).json({ error: getErr.message });
  if (article.status !== "submitted") return res.status(400).json({ error: "Only submitted articles can be reviewed" });

  const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", article.project_id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });

  const { data: updated, error } = await db
    .from("articles")
    .update({
      status: action,
      manager_note: action === "approved" ? null : manager_note || null,
      reviewed_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });

  // If approved, create a pending payment for this article (best-effort)
  if (action === "approved") {
    const { data: assignment } = await db
      .from("project_writers")
      .select("price_per_article")
      .eq("project_id", updated.project_id)
      .eq("writer_id", updated.writer_id)
      .maybeSingle();
    const amount = assignment?.price_per_article ?? 0;
    await db
      .from("payments")
      .upsert(
        [
          {
            writer_id: updated.writer_id,
            project_id: updated.project_id,
            article_id: updated.id,
            amount,
            status: "pending"
          }
        ],
        { onConflict: "article_id" }
      );
  }

  // Notify writer
  const type =
    action === "approved" ? "article_approved" : action === "rejected" ? "article_rejected" : "article_rework";
  await createNotification({
    user_id: updated.writer_id,
    type,
    title: `Article ${action}`,
    body:
      action === "approved"
        ? `Your article "${updated.title}" was approved.`
        : `Your article "${updated.title}" was marked as ${action}. ${manager_note ? "Note: " + manager_note : ""}`.trim(),
    payload: { article_id: updated.id, project_id: updated.project_id }
  });

  return res.json({ article: updated });
});

// internal route (optional): re-run checks
router.post("/:id/checks", authorizeRoles("manager", "admin"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();
  const { data: article, error: getErr } = await db.from("articles").select("*").eq("id", id).single();
  if (getErr) return res.status(400).json({ error: getErr.message });
  const { data: project, error: pErr } = await db.from("projects").select("*").eq("id", article.project_id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });

  const patch = {};
  if (project.ai_check_enabled) patch.ai_score = await runAiCheck(article);
  if (project.plagiarism_check_enabled) patch.plagiarism_score = await runPlagiarismCheck(article);
  if (!Object.keys(patch).length) {
    // Nothing to do (checks disabled). Return current article as-is.
    return res.json({ article });
  }
  const { data: updated, error } = await db.from("articles").update(patch).eq("id", id).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ article: updated });
});

module.exports = router;
