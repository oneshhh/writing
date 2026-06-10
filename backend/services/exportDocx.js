const fs = require("fs");
const path = require("path");
const { AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } = require("docx");
const { getExportMeta, parseHtmlToBlocks } = require("./exportArticleTemplate");

const COLORS = {
  primary: "0D2B22",
  primary2: "476459",
  text: "1C1B1B"
};

function paragraphText(text, options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 140 },
    children: [
      new TextRun({
        text: String(text || ""),
        bold: !!options.bold,
        italics: !!options.italics,
        color: options.color || COLORS.text,
        size: options.size || 22
      })
    ]
  });
}

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, color: COLORS.primary, size: 22, allCaps: true })]
  });
}

function blocksToParagraphs(html) {
  const blocks = parseHtmlToBlocks(html);
  if (!blocks.length) return [paragraphText("-")];
  return blocks.map((block) => {
    if (block.type === "h1") return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 });
    if (block.type === "h2") return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 });
    if (block.type === "h3") return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_3 });
    return new Paragraph({
      bullet: block.type === "list" ? { level: 0 } : undefined,
      spacing: { after: 140 },
      children: [new TextRun({ text: block.text, color: COLORS.text, size: 22 })]
    });
  });
}

function logoRun() {
  const logoPath = path.join(__dirname, "..", "public", "assets", "realwrite-logo.png");
  if (!fs.existsSync(logoPath)) return null;
  return new ImageRun({ data: fs.readFileSync(logoPath), transformation: { width: 42, height: 42 }, type: "png" });
}

async function exportArticleDocxBuffer({ article, writerName, projectTitle, downloadedAt = new Date() }) {
  const logo = logoRun();
  const meta = getExportMeta({ article, writerName, projectTitle, downloadedAt });
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [logo, new TextRun({ text: logo ? "  Real Write" : "Real Write", bold: true, color: COLORS.primary, size: 26 })].filter(Boolean)
    }),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 180 },
      children: [new TextRun({ text: article.title || "Untitled", bold: true, color: COLORS.primary, size: 34 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 280 },
      children: [new TextRun({ text: "Article export", color: COLORS.primary2, size: 20 })]
    }),
    sectionHeading("Article information"),
    ...meta.map(([label, value]) =>
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({ text: `${label}: `, bold: true, color: COLORS.primary, size: 20 }),
          new TextRun({ text: String(value || "-"), color: COLORS.text, size: 20 })
        ]
      })
    )
  ];

  if (article.short_description) {
    children.push(sectionHeading("Short description"));
    children.push(paragraphText(article.short_description, { italics: true }));
  }

  children.push(sectionHeading("Long description"));
  children.push(...blocksToParagraphs(article.long_description || ""));

  if (article.manager_note) {
    children.push(sectionHeading("Manager remark"));
    children.push(paragraphText(article.manager_note));
  }

  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Aptos", color: COLORS.text } } },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          run: { color: COLORS.primary, bold: true, size: 34 },
          paragraph: { spacing: { after: 180 } }
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: COLORS.primary, bold: true, size: 30 },
          paragraph: { spacing: { before: 280, after: 120 } }
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: COLORS.primary, bold: true, size: 26 },
          paragraph: { spacing: { before: 220, after: 100 } }
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: COLORS.primary2, bold: true, size: 23 },
          paragraph: { spacing: { before: 180, after: 80 } }
        }
      ]
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } }
        },
        children
      }
    ]
  });

  return Packer.toBuffer(doc);
}

module.exports = { exportArticleDocxBuffer };
