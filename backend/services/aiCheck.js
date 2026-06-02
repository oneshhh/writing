const os = require("os");
const path = require("path");
const { DomUtils, parseDocument } = require("htmlparser2");

const MODEL_ID = process.env.AI_DETECTOR_MODEL || "marcuscedricridia/Earlybird-fast-ONNX";
const MIN_WORDS_FOR_MODEL = Number(process.env.AI_DETECTOR_MIN_WORDS || 100);
const MAX_CHUNKS = Number(process.env.AI_DETECTOR_MAX_CHUNKS || 8);
const CHUNK_TARGET_WORDS = Number(process.env.AI_DETECTOR_CHUNK_WORDS || 260);

let detectorPromise;

function htmlToText(html) {
  const document = parseDocument(String(html || ""));
  return DomUtils.textContent(document.children || []);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function articleToText(article) {
  const parts = [
    article?.title,
    article?.short_description,
    htmlToText(article?.long_description || "")
  ];
  return normalizeText(parts.filter(Boolean).join("\n\n"));
}

function wordsOf(text) {
  return normalizeText(text).match(/[A-Za-z][A-Za-z'-]*|\d+/g) || [];
}

function splitSentences(text) {
  return normalizeText(text)
    .match(/[^.!?]+[.!?]*/g)
    ?.map((sentence) => normalizeText(sentence))
    .filter(Boolean) || [];
}

function chunkText(text) {
  const paragraphs = String(text || "")
    .split(/\n\s*\n/g)
    .map(normalizeText)
    .filter(Boolean);
  const source = paragraphs.length > 1 ? paragraphs : splitSentences(text);
  const pieces = source.length ? source : [normalizeText(text)].filter(Boolean);
  const chunks = [];
  let current = [];
  let currentWords = 0;

  for (const piece of pieces) {
    const pieceWords = wordsOf(piece).length;
    if (current.length && currentWords + pieceWords > CHUNK_TARGET_WORDS) {
      chunks.push(current.join(" "));
      current = [];
      currentWords = 0;
    }
    current.push(piece);
    currentWords += pieceWords;
  }

  if (current.length) chunks.push(current.join(" "));
  return chunks
    .filter((chunk) => wordsOf(chunk).length >= 40)
    .slice(0, Math.max(1, MAX_CHUNKS));
}

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const transformers = await import("@huggingface/transformers");
      const { env, pipeline } = transformers;

      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(os.tmpdir(), "real-write-transformers-cache");

      return pipeline("text-classification", MODEL_ID, {
        dtype: process.env.AI_DETECTOR_DTYPE || "q8"
      });
    })();
  }
  return detectorPromise;
}

function isAiLabel(label) {
  const value = String(label || "").toLowerCase();
  return value.includes("ai") || value.includes("machine") || value.includes("generated") || value.includes("fake") || value === "label_1";
}

function normalizePrediction(output) {
  const first = Array.isArray(output) ? output[0] : output;
  if (!first) return { aiProbability: null, label: "unknown", confidence: null };

  const label = String(first.label || "unknown");
  const confidence = typeof first.score === "number" ? first.score : null;
  if (confidence == null) return { aiProbability: null, label, confidence: null };

  return {
    aiProbability: isAiLabel(label) ? confidence : 1 - confidence,
    label,
    confidence
  };
}

async function runModelCheck(text) {
  const chunks = chunkText(text);
  const detector = await getDetector();
  const results = [];

  for (const chunk of chunks) {
    const prediction = normalizePrediction(await detector(chunk, { truncation: true, max_length: 512 }));
    results.push({
      words: wordsOf(chunk).length,
      label: prediction.label,
      confidence: prediction.confidence,
      aiProbability: prediction.aiProbability
    });
  }

  const scored = results.filter((result) => typeof result.aiProbability === "number");
  if (!scored.length) throw new Error("Model returned no usable prediction scores.");

  const totalWords = scored.reduce((sum, result) => sum + result.words, 0) || 1;
  const score = scored.reduce((sum, result) => sum + result.aiProbability * result.words, 0) / totalWords;

  return {
    provider: "earlybird-fast-onnx",
    model: MODEL_ID,
    score,
    label: score >= 0.75 ? "likely_ai" : score >= 0.45 ? "mixed_or_uncertain" : "likely_human",
    confidence: score >= 0.85 || score <= 0.15 ? "high" : score >= 0.65 || score <= 0.35 ? "medium" : "low",
    status: "completed",
    word_count: wordsOf(text).length,
    chunks: scored.map((result) => ({
      words: result.words,
      label: result.label,
      confidence: round(result.confidence),
      ai_probability: round(result.aiProbability)
    }))
  };
}

function round(value) {
  return typeof value === "number" ? Number(value.toFixed(4)) : value;
}

function heuristicFallback(text, reason) {
  const words = wordsOf(text).map((word) => word.toLowerCase());
  const sentences = splitSentences(text);
  const uniqueWords = new Set(words);
  const sentenceLengths = sentences.map((sentence) => wordsOf(sentence).length).filter(Boolean);
  const avgSentence = average(sentenceLengths);
  const sentenceStd = standardDeviation(sentenceLengths);
  const transitionCount = countMatches(text, [
    "in conclusion",
    "furthermore",
    "moreover",
    "it is important to note",
    "as a result",
    "overall",
    "therefore"
  ]);

  const vocabularyPenalty = clamp(1 - uniqueWords.size / Math.max(1, words.length), 0, 1);
  const uniformity = clamp(1 - sentenceStd / Math.max(1, avgSentence), 0, 1);
  const transitionDensity = clamp((transitionCount / Math.max(1, words.length)) * 80, 0, 1);
  const score = clamp(0.2 + vocabularyPenalty * 0.35 + uniformity * 0.35 + transitionDensity * 0.1, 0, 1);

  return {
    provider: "heuristic-fallback",
    model: MODEL_ID,
    score,
    label: score >= 0.7 ? "possibly_ai" : score >= 0.45 ? "uncertain" : "likely_human",
    confidence: "low",
    status: "fallback",
    reason,
    word_count: words.length
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function countMatches(text, phrases) {
  const lower = String(text || "").toLowerCase();
  return phrases.reduce((sum, phrase) => {
    const pattern = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    return sum + (lower.match(pattern) || []).length;
  }, 0);
}

async function runAiCheck(article) {
  const text = articleToText(article);
  const wordCount = wordsOf(text).length;

  if (wordCount < 40) {
    return {
      provider: "earlybird-fast-onnx",
      model: MODEL_ID,
      score: null,
      label: "too_short",
      confidence: "low",
      status: "too_short",
      word_count: wordCount
    };
  }

  if (wordCount < MIN_WORDS_FOR_MODEL) {
    return heuristicFallback(text, `Text has fewer than ${MIN_WORDS_FOR_MODEL} words; Earlybird is weak on short text.`);
  }

  try {
    return await runModelCheck(text);
  } catch (error) {
    return heuristicFallback(text, error.message || "Earlybird model unavailable.");
  }
}

module.exports = { runAiCheck };
