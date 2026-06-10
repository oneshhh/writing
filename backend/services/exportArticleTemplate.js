const { Parser } = require("htmlparser2");

function htmlToPlainText(html) {
  let text = "";
  const parser = new Parser(
    {
      ontext(data) {
        text += data;
      },
      onopentag(name) {
        if (["p", "br", "div", "h1", "h2", "h3", "h4", "h5", "li"].includes(name)) text += "\n";
      },
      onclosetag(name) {
        if (["p", "div", "h1", "h2", "h3", "h4", "h5", "li"].includes(name)) text += "\n";
      }
    },
    { decodeEntities: true }
  );
  parser.write(html || "");
  parser.end();
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function parseHtmlToBlocks(html) {
  const blocks = [];
  let currentText = "";
  let currentType = "paragraph";

  function flush() {
    const text = currentText.replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: currentType, text });
    currentText = "";
    currentType = "paragraph";
  }

  const parser = new Parser(
    {
      onopentag(name) {
        if (["p", "div", "li", "h1", "h2", "h3", "br"].includes(name)) flush();
        if (["h1", "h2", "h3"].includes(name)) currentType = name;
        if (name === "li") currentType = "list";
      },
      ontext(data) {
        currentText += data;
      },
      onclosetag(name) {
        if (["p", "div", "li", "h1", "h2", "h3"].includes(name)) flush();
      }
    },
    { decodeEntities: true }
  );
  parser.write(html || "");
  parser.end();
  flush();
  return blocks;
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatCheckScore(score) {
  if (score == null || score === "") return "n/a";
  if (typeof score === "number") return Number.isFinite(score) ? String(score) : "n/a";
  if (typeof score === "string") return score;
  if (typeof score === "object") {
    if (score.score != null) {
      return typeof score.score === "number" ? `${Math.round(score.score * 100)}%` : String(score.score);
    }
    if (score.status) return String(score.status);
  }
  return "n/a";
}

function getExportMeta({ article, writerName, projectTitle, downloadedAt = new Date() }) {
  const tags = Array.isArray(article.seo_tags) ? article.seo_tags.filter(Boolean) : [];
  return [
    ["Article ID", article.unique_id || article.id || "-"],
    ["Status", article.status || "-"],
    ["Writer", writerName || "Unknown"],
    ["Project", projectTitle || article.project_id || "-"],
    ["AI score", formatCheckScore(article.ai_score)],
    ["Plagiarism score", formatCheckScore(article.plagiarism_score)],
    ["Created", formatDate(article.created_at)],
    ["Updated", formatDate(article.updated_at)],
    ["Submitted", formatDate(article.submitted_at)],
    ["Reviewed", formatDate(article.reviewed_at)],
    ["Downloaded", formatDate(downloadedAt)],
    ["SEO tags", tags.length ? tags.join(", ") : "-"]
  ];
}

function makeArticleTextExport({ article, writerName, projectTitle, downloadedAt = new Date() }) {
  const meta = getExportMeta({ article, writerName, projectTitle, downloadedAt });
  const lines = [
    "REAL WRITE ARTICLE EXPORT",
    "",
    `Title: ${article.title || "Untitled"}`,
    "",
    ...meta.map(([label, value]) => `${label}: ${value}`),
    "",
    "Short description",
    "-----------------",
    article.short_description || "-",
    "",
    "Long description",
    "----------------",
    htmlToPlainText(article.long_description || "") || "-",
    "",
    "Manager remark",
    "--------------",
    article.manager_note || "-"
  ];
  return `${lines.join("\n")}\n`;
}

function safeExportFilename(article, extension) {
  const base = String(article.unique_id || article.title || article.id || "article")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${base || "article"}.${extension}`;
}

module.exports = {
  formatCheckScore,
  formatDate,
  getExportMeta,
  htmlToPlainText,
  makeArticleTextExport,
  parseHtmlToBlocks,
  safeExportFilename
};
