const express = require("express");
const { authorizeRoles } = require("../middleware/authorize");
const { getSupabaseAdmin } = require("../utils/supabase");
const { makeArticleTextExport, safeExportFilename } = require("../services/exportArticleTemplate");
const { exportArticlePdf } = require("../services/exportPDF");
const { exportArticleDocxBuffer } = require("../services/exportDocx");
const { requireManagerProjectAccess } = require("../utils/projectAccess");

const router = express.Router();

async function loadExportContext(req, res) {
  const { articleId } = req.params;
  const db = getSupabaseAdmin();
  const user = req.auth.user;

  const { data: article, error } = await db.from("articles").select("*").eq("id", articleId).single();
  if (error) {
    res.status(400).json({ error: error.message });
    return null;
  }

  const { data: project, error: pErr } = await db.from("projects").select("title,created_by").eq("id", article.project_id).single();
  if (pErr) {
    res.status(400).json({ error: pErr.message });
    return null;
  }

  if (user.role === "writer" && article.writer_id !== user.id) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  if (user.role === "manager") {
    try {
      await requireManagerProjectAccess(db, article.project_id, user.id);
    } catch (e) {
      res.status(e.status || 403).json({ error: e.message || "Forbidden" });
      return null;
    }
  }

  const { data: writer } = await db.from("users").select("full_name").eq("id", article.writer_id).single();
  return { article, writerName: writer?.full_name, projectTitle: project?.title };
}

router.get("/:articleId/pdf", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const ctx = await loadExportContext(req, res);
  if (!ctx) return;

  const pdfDoc = exportArticlePdf(ctx);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeExportFilename(ctx.article, "pdf")}"`);
  pdfDoc.pipe(res);
  pdfDoc.end();
});

router.get("/:articleId/docx", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const ctx = await loadExportContext(req, res);
  if (!ctx) return;

  const buf = await exportArticleDocxBuffer(ctx);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${safeExportFilename(ctx.article, "docx")}"`);
  res.end(buf);
});

router.get("/:articleId/txt", authorizeRoles("writer", "manager", "admin"), async (req, res) => {
  const ctx = await loadExportContext(req, res);
  if (!ctx) return;

  const text = makeArticleTextExport(ctx);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeExportFilename(ctx.article, "txt")}"`);
  res.end(text);
});

module.exports = router;
