const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { getManagerProjectIds } = require("../utils/projectAccess");

const router = express.Router();

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function dateWindow(req) {
  const startRaw = String(req.query.start || "").trim();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : new Date().toISOString().slice(0, 10);
  const days = Math.max(1, Math.min(60, Number(req.query.days || 30)));
  const endDate = new Date(`${start}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + days);
  return { start, end: endDate.toISOString().slice(0, 10), days };
}

function addCount(map, day, key) {
  if (!day) return;
  const row = map.get(day) || { date: day, submitted: 0, approved: 0, requests_due: 0, notes: [] };
  row[key] = Number(row[key] || 0) + 1;
  map.set(day, row);
}

router.get("/", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const user = req.auth.user;
  const { start, end } = dateWindow(req);
  const projectId = req.query.project_id ? String(req.query.project_id) : null;
  const buckets = new Map();

  try {
    if (user.role === "writer") {
      const { data: articles, error } = await db
        .from("articles")
        .select("id,status,submitted_at,reviewed_at,title")
        .eq("writer_id", user.id)
        .gte("created_at", `${start}T00:00:00.000Z`)
        .lt("created_at", `${end}T00:00:00.000Z`);
      if (error) return res.status(400).json({ error: error.message });

      for (const article of articles || []) {
        addCount(buckets, dateOnly(article.submitted_at), "submitted");
        if (article.status === "approved") addCount(buckets, dateOnly(article.reviewed_at), "approved");
      }

      const { data: requests, error: requestErr } = await db
        .from("project_request_recipients")
        .select("project_requests(id,title,due_at,status)")
        .eq("writer_id", user.id);
      if (requestErr) return res.status(400).json({ error: requestErr.message });
      for (const row of requests || []) {
        const due = dateOnly(row.project_requests?.due_at);
        if (due >= start && due < end) addCount(buckets, due, "requests_due");
      }
    } else {
      let projectIds = [];
      if (user.role === "manager") {
        projectIds = await getManagerProjectIds(db, user.id);
        if (projectId && !projectIds.includes(projectId)) return res.status(403).json({ error: "Forbidden" });
      }
      if (projectId) projectIds = [projectId];

      let q = db
        .from("articles")
        .select("id,status,project_id,reviewed_at,submitted_at,title")
        .gte("reviewed_at", `${start}T00:00:00.000Z`)
        .lt("reviewed_at", `${end}T00:00:00.000Z`);
      if (projectIds.length) q = q.in("project_id", projectIds);
      const { data: articles, error } = await q;
      if (error) return res.status(400).json({ error: error.message });
      for (const article of articles || []) {
        if (article.status === "approved") addCount(buckets, dateOnly(article.reviewed_at), "approved");
      }

      let rq = db.from("project_requests").select("id,title,due_at,project_id,status").not("due_at", "is", null);
      if (projectIds.length) rq = rq.in("project_id", projectIds);
      const { data: requests, error: requestErr } = await rq;
      if (requestErr) return res.status(400).json({ error: requestErr.message });
      for (const request of requests || []) {
        const due = dateOnly(request.due_at);
        if (due >= start && due < end) addCount(buckets, due, "requests_due");
      }
    }

    const { data: notes, error: notesErr } = await db
      .from("calendar_notes")
      .select("*")
      .eq("user_id", user.id)
      .gte("event_date", start)
      .lt("event_date", end)
      .order("event_date", { ascending: true });
    if (notesErr) return res.status(400).json({ error: notesErr.message });
    for (const note of notes || []) {
      const day = dateOnly(note.event_date);
      const row = buckets.get(day) || { date: day, submitted: 0, approved: 0, requests_due: 0, notes: [] };
      row.notes.push(note);
      buckets.set(day, row);
    }

    return res.json({ start, end, days: Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e) });
  }
});

router.post("/notes", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { title, note, event_date, project_id } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event_date || ""))) {
    return res.status(400).json({ error: "event_date must be YYYY-MM-DD" });
  }

  const { data, error } = await db
    .from("calendar_notes")
    .insert([{ user_id: req.auth.user.id, project_id: project_id || null, title, note: note || null, event_date }])
    .select("*")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ note: data });
});

router.delete("/notes/:id", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const db = getSupabaseAdmin();
  const { error } = await db.from("calendar_notes").delete().eq("id", req.params.id).eq("user_id", req.auth.user.id);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(204).send();
});

module.exports = router;
