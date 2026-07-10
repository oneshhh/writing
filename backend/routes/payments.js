const express = require("express");
const multer = require("multer");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { notifyWriter } = require("../services/writerNotifications");
const { getManagerProjectIds, requireManagerProjectAccess } = require("../utils/projectAccess");

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

function parseCommonFilters(req) {
  const projectIdFilter = req.query.project_id ? String(req.query.project_id) : null;
  const writerIdFilter = req.query.writer_id ? String(req.query.writer_id) : null;
  const fromFilter = req.query.from ? String(req.query.from) : null;
  const toFilter = req.query.to ? String(req.query.to) : null;
  return { projectIdFilter, writerIdFilter, fromFilter, toFilter };
}

function applyDateFilters(q, { fromFilter, toFilter }) {
  if (fromFilter) q = q.gte("created_at", fromFilter);
  if (toFilter) q = q.lt("created_at", toFilter);
  return q;
}

function normalizeIso(input) {
  if (!input) return null;
  const date = new Date(String(input));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildMonthlyBuckets({ fromIso, toIso }) {
  const now = new Date();
  const fallbackStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1, 0, 0, 0));
  const safeEnd = toIso ? new Date(toIso) : new Date();
  const safeStart = fromIso ? new Date(fromIso) : fallbackStart;
  const start = new Date(Date.UTC(safeStart.getUTCFullYear(), safeStart.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(safeEnd.getUTCFullYear(), safeEnd.getUTCMonth(), 1, 0, 0, 0));
  if (start > end) return [];

  const months = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function summarizeMonthlyPayments(rows, monthKeys) {
  const bucketMap = new Map(
    monthKeys.map((month) => [
      month,
      { month, paid_amount: 0, pending_amount: 0, total_amount: 0, payments_count: 0 }
    ])
  );

  for (const row of rows || []) {
    const month = String(row.created_at || "").slice(0, 7);
    if (!bucketMap.has(month)) continue;
    const bucket = bucketMap.get(month);
    const amount = Number(row.amount || 0);
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    bucket.total_amount += safeAmount;
    bucket.payments_count += 1;
    if (row.status === "paid") bucket.paid_amount += safeAmount;
    if (row.status === "pending") bucket.pending_amount += safeAmount;
  }

  return monthKeys.map((month) => bucketMap.get(month));
}

async function uploadProofFile(db, payment, file) {
  if (!file) return payment.proof_url || null;
  const bucket = "payment-proofs";
  const targetKey = payment.article_id || payment.request_id || payment.id;
  const path = `${payment.writer_id}/${targetKey}/${Date.now()}_${file.originalname}`;
  const { error: upErr } = await db.storage.from(bucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: true
  });
  if (upErr) throw new Error(upErr.message);
  const { data: pub } = db.storage.from(bucket).getPublicUrl(path);
  return pub?.publicUrl || null;
}

async function verifyPaymentAccess(db, payment, user) {
  if (user.role === "admin") return;
  await requireManagerProjectAccess(db, payment.project_id, user.id);
}

async function markPaymentPaid({ db, payment, actor, paymentId, proofUrl }) {
  const paymentTarget = payment.articles?.title || payment.request_title || (payment.article_id ? "your article" : "your accepted request");
  const patch = {
    status: "paid",
    payment_id: paymentId || null,
    proof_url: proofUrl || payment.proof_url || null,
    paid_by: actor.id,
    paid_at: new Date().toISOString()
  };

  const { data: updated, error } = await db.from("payments").update(patch).eq("id", payment.id).select("*").single();
  if (error) throw new Error(error.message);

  const { data: writer, error: writerErr } = await db
    .from("users")
    .select("id,email,full_name")
    .eq("id", updated.writer_id)
    .maybeSingle();
  if (writerErr) throw new Error(writerErr.message);

  await notifyWriter({
    userId: updated.writer_id,
    email: writer?.email || null,
    type: "payment_received",
    title: "Payment approved",
    body: `Your payment has been approved for ${paymentTarget}.`,
    payload: {
      payment_id: updated.id,
      article_id: updated.article_id,
      request_id: updated.request_id || null,
      project_id: updated.project_id
    },
    emailSubject: "Real Write: payment approved",
    emailText: `Your payment has been approved for ${paymentTarget}.${updated.payment_id ? ` Payment ID: ${updated.payment_id}` : ""}`
  });

  return updated;
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
    } else if (projectIdFilter) {
      q = q.eq("project_id", projectIdFilter);
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

router.get("/stats/monthly", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const { projectIdFilter, writerIdFilter, fromFilter, toFilter } = parseCommonFilters(req);
  const fromIso = normalizeIso(fromFilter);
  const toIso = normalizeIso(toFilter);
  const monthKeys = buildMonthlyBuckets({ fromIso, toIso });
  if (!monthKeys.length) return res.json({ months: [] });

  try {
    let q = db.from("payments").select("amount,status,created_at,project_id,writer_id");

    if (user.role === "writer") {
      q = q.eq("writer_id", user.id);
    } else if (user.role === "manager") {
      const projectIds = await getManagerProjectIds(db, user.id);
      if (!projectIds.length) return res.json({ months: summarizeMonthlyPayments([], monthKeys) });
      if (projectIdFilter && !projectIds.includes(projectIdFilter)) return res.status(403).json({ error: "Forbidden" });
      q = q.in("project_id", projectIds);
      if (projectIdFilter) q = q.eq("project_id", projectIdFilter);
    } else if (projectIdFilter) {
      q = q.eq("project_id", projectIdFilter);
    }

    if (writerIdFilter) q = q.eq("writer_id", writerIdFilter);
    q = applyDateFilters(q, { fromFilter: fromIso, toFilter: toIso });

    const { data, error } = await q.order("created_at", { ascending: true });
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ months: summarizeMonthlyPayments(data || [], monthKeys) });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
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
  let projectIds;
  try {
    projectIds = await getManagerProjectIds(db, managerId);
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
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

router.patch("/bulk-pay", authorizeRoles("manager", "admin"), upload.single("proof"), async (req, res) => {
  const ids = Array.isArray(req.body?.payment_ids)
    ? req.body.payment_ids
    : String(req.body?.payment_ids || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  const uniqueIds = Array.from(new Set(ids));
  if (!uniqueIds.length) return res.status(400).json({ error: "payment_ids is required" });

  const db = getSupabaseAdmin();
  const { data: payments, error } = await db
    .from("payments")
    .select("*,articles(id,title,unique_id,status)")
    .in("id", uniqueIds);
  if (error) return res.status(400).json({ error: error.message });
  if ((payments || []).length !== uniqueIds.length) return res.status(404).json({ error: "One or more payments were not found" });

  try {
    for (const payment of payments || []) {
      if (payment.status === "paid") {
        const err = new Error("Only pending payments can be marked as paid");
        err.status = 400;
        throw err;
      }
      await verifyPaymentAccess(db, payment, req.auth.user);
    }

    const proofUrl = req.file ? await uploadProofFile(db, payments[0], req.file) : null;
    const updated = [];
    for (const payment of payments || []) {
      updated.push(
        await markPaymentPaid({
          db,
          payment,
          actor: req.auth.user,
          paymentId: req.body?.payment_id || null,
          proofUrl
        })
      );
    }

    return res.json({ payments: updated, count: updated.length });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.patch("/:id/pay", authorizeRoles("manager", "admin"), upload.single("proof"), async (req, res) => {
  const { id } = req.params;
  const { payment_id } = req.body || {};

  const db = getSupabaseAdmin();
  const { data: payment, error: getErr } = await db
    .from("payments")
    .select("*,articles(id,title,unique_id,status)")
    .eq("id", id)
    .single();
  if (getErr) return res.status(400).json({ error: getErr.message });
  if (payment.status === "paid") return res.status(400).json({ error: "Payment is already marked as paid" });

  try {
    await verifyPaymentAccess(db, payment, req.auth.user);
    const proofUrl = await uploadProofFile(db, payment, req.file);
    const updated = await markPaymentPaid({
      db,
      payment,
      actor: req.auth.user,
      paymentId: payment_id || null,
      proofUrl
    });
    return res.json({ payment: updated });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

module.exports = router;
