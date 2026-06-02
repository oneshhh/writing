const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { exportArticlePdf } = require("../services/exportPDF");
const { exportArticleDocxBuffer } = require("../services/exportDocx");

const router = express.Router();

router.get("/:articleId/pdf", authorizeRoles("manager", "admin"), async (req, res) => {
  const { articleId } = req.params;
  const db = getSupabaseAdmin();

  const { data: article, error } = await db.from("articles").select("*").eq("id", articleId).single();
  if (error) return res.status(400).json({ error: error.message });

  if (req.auth.user.role === "manager") {
    const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", article.project_id).single();
    if (pErr) return res.status(400).json({ error: pErr.message });
    if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });
  }

  const { data: writer } = await db.from("users").select("full_name").eq("id", article.writer_id).single();
  const pdfDoc = exportArticlePdf({ article, writerName: writer?.full_name, reviewedAt: article.reviewed_at });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${article.unique_id || "article"}.pdf"`);
  pdfDoc.pipe(res);
  pdfDoc.end();
});

router.get("/:articleId/docx", authorizeRoles("manager", "admin"), async (req, res) => {
  const { articleId } = req.params;
  const db = getSupabaseAdmin();

  const { data: article, error } = await db.from("articles").select("*").eq("id", articleId).single();
  if (error) return res.status(400).json({ error: error.message });

  if (req.auth.user.role === "manager") {
    const { data: project, error: pErr } = await db.from("projects").select("created_by").eq("id", article.project_id).single();
    if (pErr) return res.status(400).json({ error: pErr.message });
    if (project.created_by !== req.auth.user.id) return res.status(403).json({ error: "Forbidden" });
  }

  const { data: writer } = await db.from("users").select("full_name").eq("id", article.writer_id).single();
  const buf = await exportArticleDocxBuffer({ article, writerName: writer?.full_name, reviewedAt: article.reviewed_at });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${article.unique_id || "article"}.docx"`);
  res.end(buf);
});

module.exports = router;

