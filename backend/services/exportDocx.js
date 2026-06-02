const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
const { Parser } = require("htmlparser2");

function parseHtmlToParagraphs(html) {
  const paragraphs = [];
  let currentText = "";
  let currentHeading = null;

  function flush() {
    const t = currentText.trim();
    if (!t) {
      currentText = "";
      return;
    }
    if (currentHeading) {
      paragraphs.push(new Paragraph({ text: t, heading: currentHeading }));
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun(t)] }));
    }
    currentText = "";
    currentHeading = null;
  }

  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "h2") currentHeading = HeadingLevel.HEADING_2;
        if (name === "h3") currentHeading = HeadingLevel.HEADING_3;
        if (["p", "br", "div", "li", "h2", "h3"].includes(name)) {
          flush();
        }
      },
      ontext(data) {
        currentText += data;
      },
      onclosetag(name) {
        if (["p", "div", "li", "h2", "h3"].includes(name)) flush();
      }
    },
    { decodeEntities: true }
  );
  parser.write(html || "");
  parser.end();
  flush();
  return paragraphs;
}

async function exportArticleDocxBuffer({ article, writerName, reviewedAt }) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: article.title || "Untitled", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun({
                text: `${writerName || "Unknown"}${reviewedAt ? " • " + new Date(reviewedAt).toLocaleString() : ""}`,
                color: "666666"
              })
            ]
          }),
          ...(article.short_description
            ? [new Paragraph({ children: [new TextRun({ text: article.short_description, italics: true })] })]
            : []),
          ...parseHtmlToParagraphs(article.long_description || ""),
          ...(Array.isArray(article.seo_tags) && article.seo_tags.length
            ? [new Paragraph({ children: [new TextRun({ text: `SEO tags: ${article.seo_tags.join(", ")}`, color: "666666" })] })]
            : [])
        ]
      }
    ]
  });

  return Packer.toBuffer(doc);
}

module.exports = { exportArticleDocxBuffer };

