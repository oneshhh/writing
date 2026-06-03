import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const nodeModules = "C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const require = createRequire(`${nodeModules}/`);
const canvasPkg = require("@napi-rs/canvas");

globalThis.DOMMatrix = canvasPkg.DOMMatrix;
globalThis.ImageData = canvasPkg.ImageData;
globalThis.Path2D = canvasPkg.Path2D;

const pdfjsLib = await import(
  "file:///C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pdfjs-dist/legacy/build/pdf.mjs"
);

class NodeCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    const canvas = canvasPkg.createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const [pdfPath, outDir] = process.argv.slice(2);
if (!pdfPath || !outDir) {
  console.error("Usage: node render_pdf_pages.mjs input.pdf out_dir");
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(pdfPath));
const task = pdfjsLib.getDocument({
  data: bytes,
  disableFontFace: false,
  disableWorker: true,
  useSystemFonts: true,
});
const pdf = await task.promise;
const factory = new NodeCanvasFactory();

for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.8 });
  const canvasAndContext = factory.create(viewport.width, viewport.height);
  await page.render({
    canvasContext: canvasAndContext.context,
    viewport,
    canvasFactory: factory,
  }).promise;
  const output = path.join(outDir, `page-${String(pageNum).padStart(2, "0")}.png`);
  fs.writeFileSync(output, canvasAndContext.canvas.toBuffer("image/png"));
  factory.destroy(canvasAndContext);
}

console.log(`Rendered ${pdf.numPages} pages to ${outDir}`);
