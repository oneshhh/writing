const PDFDocument = require("pdfkit");
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

function exportArticlePdf({ article, writerName, reviewedAt }) {
  const doc = new PDFDocument({ margin: 50 });

  doc.fontSize(20).text(article.title || "Untitled", { align: "center" });
  doc.moveDown(0.25);
  doc
    .fontSize(10)
    .fillColor("#555")
    .text(`${writerName || "Unknown"} • ${reviewedAt ? new Date(reviewedAt).toLocaleString() : ""}`, {
      align: "center"
    });
  doc.moveDown(0.75);
  doc.fillColor("#000").moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown();

  if (article.short_description) {
    doc.fontSize(12).fillColor("#111").font("Times-Italic").text(article.short_description);
    doc.font("Times-Roman").moveDown();
  }

  const body = htmlToPlainText(article.long_description || "");
  doc.fontSize(12).fillColor("#111").text(body || "");

  doc.moveDown();
  if (Array.isArray(article.seo_tags) && article.seo_tags.length) {
    doc.fontSize(9).fillColor("#555").text(`SEO tags: ${article.seo_tags.join(", ")}`, { align: "left" });
  }

  return doc;
}

module.exports = { exportArticlePdf };

