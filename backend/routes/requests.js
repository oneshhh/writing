const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { requireManagerProjectAccess, getManagerProjectIds } = require("../utils/projectAccess");
const { createNotification } = require("../services/notifications");

const router = express.Router();

function parseLinks(value) {
  if (Array.isArray(value)) return value.map((link) => String(link || "").trim()).filter(Boolean).slice(0, 12);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((link) => link.trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function createAcceptedRequestPayment(db, request, writerId) {
  const amount = Number(request?.additional_payment || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const { data, error } = await db
    .from("payments")
    .insert([
      {
        writer_id: writerId,
        project_id: request.project_id,
        article_id: null,
        request_id: request.id,
        request_title: request.title || null,
        payment_reason: "request_bonus",
        amount,
        status: "pending"
      }
    ])
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getProjectWriterIds(db, projectId) {
  const { data, error } = await db.from("project_writers").select("writer_id").eq("project_id", projectId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.writer_id).filter(Boolean);
}

async function getWriterRequest(db, requestId, writerId) {
  const { data, error } = await db
    .from("project_request_recipients")
    .select("*,project_requests(*)")
    .eq("request_id", requestId)
    .eq("writer_id", writerId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function hydrateRequests(db, requests) {
  const requestIds = (requests || []).map((request) => request.id).filter(Boolean);
  if (!requestIds.length) return [];

  const { data: recipients, error: recipientsErr } = await db
    .from("project_request_recipients")
    .select("id,request_id,writer_id,status,responded_at,response_note,users(id,full_name,email,unique_id)")
    .in("request_id", requestIds);
  if (recipientsErr) throw new Error(recipientsErr.message);

  const grouped = new Map();
  for (const row of recipients || []) {
    const list = grouped.get(row.request_id) || [];
    list.push(row);
    grouped.set(row.request_id, list);
  }

  return (requests || []).map((request) => ({ ...request, recipients: grouped.get(request.id) || [] }));
}

async function getWriterRequestArticles(db, writerId, requestIds) {
  if (!requestIds.length) return new Map();
  const { data, error } = await db
    .from("articles")
    .select("id,request_id,title,status,updated_at,request_title")
    .eq("writer_id", writerId)
    .in("request_id", requestIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const map = new Map();
  for (const row of data || []) {
    if (row.request_id && !map.has(row.request_id)) map.set(row.request_id, row);
  }
  return map;
}

router.get("/", authorizeRoles("manager", "writer", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const projectId = req.query.project_id ? String(req.query.project_id) : null;

  try {
    if (user.role === "writer") {
      let q = db
        .from("project_request_recipients")
        .select("id,status,responded_at,response_note,submitted_at,fulfilled_at,linked_article_id,project_requests(*)")
        .eq("writer_id", user.id)
        .order("created_at", { ascending: false });
      const { data, error } = await q;
      if (error) return res.status(400).json({ error: error.message });
      let requests = (data || []).map((row) => ({
        ...row.project_requests,
        recipient_status: row.status,
        responded_at: row.responded_at,
        response_note: row.response_note,
        request_submitted_at: row.submitted_at,
        request_fulfilled_at: row.fulfilled_at,
        linked_article_id: row.linked_article_id || null
      }));
      const articleByRequestId = await getWriterRequestArticles(
        db,
        user.id,
        requests.map((request) => request.id).filter(Boolean)
      );
      requests = requests.map((request) => ({
        ...request,
        linked_article: articleByRequestId.get(request.id) || null
      }));
      if (projectId) requests = requests.filter((request) => request.project_id === projectId);
      return res.json({ requests });
    }

    let q = db.from("project_requests").select("*,projects(id,title)").order("created_at", { ascending: false });
    if (user.role === "manager") {
      const projectIds = await getManagerProjectIds(db, user.id);
      if (projectId && !projectIds.includes(projectId)) return res.status(403).json({ error: "Forbidden" });
      if (!projectIds.length) return res.json({ requests: [] });
      q = q.in("project_id", projectId ? [projectId] : projectIds);
    } else if (projectId) {
      q = q.eq("project_id", projectId);
    }

    const { data, error } = await q;
    if (error) return res.status(400).json({ error: error.message });
    const requests = await hydrateRequests(db, data || []);
    return res.json({ requests });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.post("/", authorizeRoles("manager"), async (req, res) => {
  const {
    project_id,
    title,
    brief,
    reference_links,
    additional_payment,
    due_at,
    send_scope,
    writer_ids
  } = req.body || {};
  if (!project_id) return res.status(400).json({ error: "project_id is required" });
  if (!title) return res.status(400).json({ error: "title is required" });

  const db = getSupabaseAdmin();
  try {
    await requireManagerProjectAccess(db, project_id, req.auth.user.id);

    const scope = send_scope === "personal" ? "personal" : "group";
    const projectWriterIds = await getProjectWriterIds(db, project_id);
    const requestedWriterIds = Array.from(new Set(Array.isArray(writer_ids) ? writer_ids : []))
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const recipients = scope === "personal" ? requestedWriterIds.slice(0, 1) : projectWriterIds;
    const validRecipients = recipients.filter((writerId) => projectWriterIds.includes(writerId));
    if (!validRecipients.length) return res.status(400).json({ error: "Select at least one assigned writer." });

    const amount = additional_payment === undefined || additional_payment === "" ? null : Number(additional_payment);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(400).json({ error: "Invalid additional payment" });
    }

    const { data: request, error } = await db
      .from("project_requests")
      .insert([
        {
          project_id,
          created_by: req.auth.user.id,
          title: String(title).trim(),
          brief: brief || null,
          reference_links: parseLinks(reference_links),
          additional_payment: amount,
          due_at: due_at || null,
          send_scope: scope
        }
      ])
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    const rows = validRecipients.map((writerId) => ({ request_id: request.id, writer_id: writerId }));
    const { error: recipientErr } = await db.from("project_request_recipients").insert(rows);
    if (recipientErr) throw new Error(recipientErr.message);

    await Promise.all(
      validRecipients.map((writerId) =>
        createNotification({
          user_id: writerId,
          type: "project_request",
          title: "New writing request",
          body: `${request.title}${amount && amount > 0 ? ` - Extra pay Rs ${amount}` : ""}`,
          payload: { request_id: request.id, project_id, send_scope: scope }
        }).catch(() => null)
      )
    );

    return res.json({ request });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.post("/:id/respond", authorizeRoles("writer"), async (req, res) => {
  const { id } = req.params;
  const action = String(req.body?.action || "");
  const responseNote = req.body?.response_note ? String(req.body.response_note) : null;
  if (!["accepted", "rejected"].includes(action)) return res.status(400).json({ error: "Invalid action" });

  const db = getSupabaseAdmin();
  try {
    const row = await getWriterRequest(db, id, req.auth.user.id);
    const request = row.project_requests;
    if (!request || request.status === "closed") return res.status(400).json({ error: "Request is closed" });
    if (row.status !== "pending") return res.status(400).json({ error: "Request already answered" });

    const { data: recipient, error } = await db
      .from("project_request_recipients")
      .update({ status: action, response_note: responseNote, responded_at: new Date().toISOString() })
      .eq("request_id", id)
      .eq("writer_id", req.auth.user.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    const requestPatch = { updated_at: new Date().toISOString() };
    if (action === "accepted" && request.send_scope === "personal") {
      requestPatch.status = "accepted";
      requestPatch.accepted_by = req.auth.user.id;
      requestPatch.accepted_at = new Date().toISOString();
    } else if (request.send_scope === "personal") {
      requestPatch.status = "rejected";
      requestPatch.closed_at = new Date().toISOString();
    }

    const { data: updatedRequest, error: requestErr } = await db
      .from("project_requests")
      .update(requestPatch)
      .eq("id", id)
      .select("*")
      .single();
    if (requestErr) throw new Error(requestErr.message);

    let payment = null;
    if (action === "accepted") {
      payment = await createAcceptedRequestPayment(db, request, req.auth.user.id);
    }

    await createNotification({
      user_id: request.created_by,
      type: "project_request_response",
      title: `Request ${action}`,
      body: `${req.auth.user.full_name || "A writer"} ${action} "${request.title}".`,
      payload: {
        request_id: id,
        project_id: request.project_id,
        writer_id: req.auth.user.id,
        payment_id: payment?.id || null
      }
    }).catch(() => null);

    return res.json({ recipient, request: updatedRequest, payment });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.patch("/:id/close", authorizeRoles("manager"), async (req, res) => {
  const { id } = req.params;
  const db = getSupabaseAdmin();
  try {
    const { data: request, error: getErr } = await db.from("project_requests").select("*").eq("id", id).single();
    if (getErr) throw new Error(getErr.message);
    await requireManagerProjectAccess(db, request.project_id, req.auth.user.id);
    const { data, error } = await db
      .from("project_requests")
      .update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await db.from("project_request_recipients").update({ status: "cancelled" }).eq("request_id", id).eq("status", "pending");
    return res.json({ request: data });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

module.exports = router;
