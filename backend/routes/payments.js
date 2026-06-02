const express = require("express");
const multer = require("multer");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { createNotification } = require("../services/notifications");

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

function parseCommonFilters(req) {
  const projectIdFilter = req.query.project_id ? String(req.query.project_id) : null;
  const writerIdFilter = req.query.writer_id ? String(req.query.writer_id) : null;
  const fromFilter = req.query.from ? String(req.query.from) : null;
  const toFilter = req.query.to ? String(req.query.to) : null;
  return { projectIdFilter, writerIdFilter, fromFilter, toFilter };
}

async function getManagerProjectIds(db, managerId) {
  const { data: projects, error } = await db.from("projects").select("id").eq("created_by", managerId);
  if (error) throw new Error(error.message);
  return (projects || []).map((p) => p.id);
}

function applyDateFilters(q, { fromFilter, toFilter }) {
  if (fromFilter) q = q.gte("created_at", fromFilter);
  if (toFilter) q = q.lt("created_at", toFilter);
  return q;
}

router.get("/stats", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const { projectIdFilter, writerIdFilter, fromFilter, toFilter } = parseCommonFilters(req);

  try {
    let q = db.from("payments").select("amount,status,created_at");

    if (user.role === "writer") {
      q = q.eq("writer_id", user.id);
    } else if (user.role === "manager") {
      const projectIds = await getManagerProjectIds(db, user.id);
      if (!projectIds.length) return res.json({ paid_amount: 0, pending_amount: 0, payments_count: 0 });
      if (projectIdFilter && !projectIds.includes(projectIdFilter)) return res.status(403).json({ error: "Forbidden" });
      q = q.in("project_id", projectIds);
      if (projectIdFilter) q = q.eq("project_id", projectIdFilter);
    } else {
      // admin: no project restriction
      if (projectIdFilter) q = q.eq("project_id", projectIdFilter);
    }

    if (writerIdFilter) q = q.eq("writer_id", writerIdFilter);
    q = applyDateFilters(q, { fromFilter, toFilter });

    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) return res.status(400).json({ error: error.message });

    let paid_amount = 0;
    let pending_amount = 0;
    for (const p of data || []) {
      const amt = Number(p.amount || 0);
      if (!Number.isFinite(amt)) continue;
      if (p.status === "paid") paid_amount += amt;
      else if (p.status === "pending") pending_amount += amt;
    }

    return res.json({ paid_amount, pending_amount, payments_count: (data || []).length });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

router.get("/by-article-ids", authorizeRoles("admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const idsRaw = String(req.query.ids || "").trim();
  if (!idsRaw) return res.json({ payments: [] });
  const ids = Array.from(new Set(idsRaw.split(",").map((x) => x.trim()).filter(Boolean)));
  if (!ids.length) return res.json({ payments: [] });
  const { data, error } = await db
    .from("payments")
    .select("id,article_id,amount,status,paid_at,created_at,payment_id,proof_url")
    .in("article_id", ids)
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ payments: data });
});

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

  const { projectIdFilter, writerIdFilter, fromFilter, toFilter } = parseCommonFilters(req);

  // Note: avoid embedding users directly because payments can have multiple FKs to users (writer_id, paid_by),
  // which makes the relationship ambiguous for PostgREST embeds. We'll hydrate writer info manually when needed.
  const select = "*,articles(id,title,unique_id,status)";

  if (user.role === "writer") {
    let q = db
      .from("payments")
      .select(select, { count: "exact" })
      .eq("writer_id", user.id)
      .order("created_at", { ascending: false });
    q = applyDateFilters(q, { fromFilter, toFilter });
    if (usePaging) q = q.range(rangeFrom, rangeTo);
    const { data, error, count } = await q;
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ payments: data, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
  }

  if (user.role === "manager") {
    let projectIds;
    try {
      projectIds = await getManagerProjectIds(db, user.id);
    } catch (e) {
      return res.status(400).json({ error: e.message || String(e) });
    }
    if (!projectIds.length) return res.json({ payments: [] });

    if (projectIdFilter && !projectIds.includes(projectIdFilter)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    let q = db
      .from("payments")
      .select(select, { count: "exact" })
      .in("project_id", projectIds)
      .order("created_at", { ascending: false });
    if (projectIdFilter) q = q.eq("project_id", projectIdFilter);
    if (writerIdFilter) q = q.eq("writer_id", writerIdFilter);
    q = applyDateFilters(q, { fromFilter, toFilter });
    if (usePaging) q = q.range(rangeFrom, rangeTo);
    const { data, error, count } = await q;
    if (error) return res.status(400).json({ error: error.message });
    // Hydrate writer info (name/email) for this page
    const writerIds = Array.from(new Set((data || []).map((p) => p.writer_id).filter(Boolean)));
    let writerMap = new Map();
    if (writerIds.length) {
      const { data: users, error: uErr } = await db
        .from("users")
        .select("id,full_name,email")
        .in("id", writerIds);
      if (uErr) return res.status(400).json({ error: uErr.message });
      writerMap = new Map((users || []).map((u) => [u.id, u]));
    }
    const hydrated = (data || []).map((p) => ({ ...p, writer: writerMap.get(p.writer_id) || null }));
    return res.json({ payments: hydrated, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
  }

  let q = db.from("payments").select(select, { count: "exact" }).order("created_at", { ascending: false });
  if (projectIdFilter) q = q.eq("project_id", projectIdFilter);
  if (writerIdFilter) q = q.eq("writer_id", writerIdFilter);
  q = applyDateFilters(q, { fromFilter, toFilter });
  if (usePaging) q = q.range(rangeFrom, rangeTo);
  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });

  // Admin: hydrate writer info too
  const writerIds = Array.from(new Set((data || []).map((p) => p.writer_id).filter(Boolean)));
  let writerMap = new Map();
  if (writerIds.length) {
    const { data: users, error: uErr } = await db.from("users").select("id,full_name,email").in("id", writerIds);
    if (uErr) return res.status(400).json({ error: uErr.message });
    writerMap = new Map((users || []).map((u) => [u.id, u]));
  }
  const hydrated = (data || []).map((p) => ({ ...p, writer: writerMap.get(p.writer_id) || null }));
  return res.json({ payments: hydrated, total: count ?? null, limit: usePaging ? limit : null, offset: usePaging ? rangeFrom : null });
});

router.get("/summary", authorizeRoles("manager"), async (req, res) => {
  const db = getSupabaseAdmin();
  const managerId = req.auth.user.id;
  const { data: projects, error: pErr } = await db.from("projects").select("id").eq("created_by", managerId);
  if (pErr) return res.status(400).json({ error: pErr.message });
  const projectIds = (projects || []).map((p) => p.id);
  if (!projectIds.length) return res.json({ by_writer: [] });

  const { data: payments, error } = await db
    .from("payments")
    .select("writer_id,amount,status")
    .in("project_id", projectIds);
  if (error) return res.status(400).json({ error: error.message });

  const map = new Map();
  for (const p of payments || []) {
    const row = map.get(p.writer_id) || { writer_id: p.writer_id, total_earned: 0, total_paid: 0, balance_due: 0 };
    const amt = Number(p.amount || 0);
    row.total_earned += amt;
    if (p.status === "paid") row.total_paid += amt;
    map.set(p.writer_id, row);
  }
  const by_writer = Array.from(map.values()).map((r) => ({ ...r, balance_due: r.total_earned - r.total_paid }));
  return res.json({ by_writer });
});

router.patch("/:id/pay", authorizeRoles("manager"), upload.single("proof"), async (req, res) => {
  const { id } = req.params;
  const { payment_id } = req.body || {};

  const db = getSupabaseAdmin();
  const { data: payment, error: getErr } = await db.from("payments").select("*").eq("id", id).single();
  if (getErr) return res.status(400).json({ error: getErr.message });

  // ensure manager owns project
  const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", payment.project_id).single();
  if (pErr) return res.status(400).json({ error: pErr.message });
  if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });

  let proof_url = payment.proof_url || null;
  if (req.file) {
    // Upload to Supabase Storage bucket "payment-proofs"
    const bucket = "payment-proofs";
    const path = `${payment.writer_id}/${payment.article_id}/${Date.now()}_${req.file.originalname}`;
    const { error: upErr } = await db.storage.from(bucket).upload(path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true
    });
    if (upErr) return res.status(400).json({ error: upErr.message });
    const { data: pub } = db.storage.from(bucket).getPublicUrl(path);
    proof_url = pub?.publicUrl || null;
  }

  const patch = {
    status: "paid",
    payment_id: payment_id || null,
    proof_url,
    paid_by: req.auth.user.id,
    paid_at: new Date().toISOString()
  };

  const { data: updated, error } = await db.from("payments").update(patch).eq("id", id).select("*").single();
  if (error) return res.status(400).json({ error: error.message });

  await createNotification({
    user_id: updated.writer_id,
    type: "payment_received",
    title: "Payment received",
    body: `Your payment of ₹${updated.amount} has been processed.${updated.payment_id ? " Payment ID: " + updated.payment_id : ""}`,
    payload: { payment_id: updated.id, article_id: updated.article_id, project_id: updated.project_id }
  });

  return res.json({ payment: updated });
});

module.exports = router;
