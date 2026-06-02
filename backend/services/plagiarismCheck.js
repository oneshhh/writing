const { DomUtils, parseDocument } = require("htmlparser2");
const { getSupabaseAdmin } = require("../utils/supabase");

const MAX_COMPARE_ARTICLES = Number(process.env.PLAGIARISM_COMPARE_LIMIT || 500);
const SHINGLE_SIZE = Number(process.env.PLAGIARISM_SHINGLE_SIZE || 5);

function htmlToText(html) {
  const document = parseDocument(String(html || ""));
  return DomUtils.textContent(document.children || []);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^a-z0-9.!?\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function articleToText(article) {
  return normalizeText(
    [
      article?.title,
      article?.short_description,
      htmlToText(article?.long_description || "")
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}

function wordsOf(text) {
  return normalizeText(text).match(/[a-z0-9][a-z0-9'-]*/g) || [];
}

function sentencesOf(text) {
  return normalizeText(text)
    .match(/[^.!?]+[.!?]*/g)
    ?.map((sentence) => sentence.replace(/[.!?]+$/, "").trim())
    .filter((sentence) => wordsOf(sentence).length >= 8) || [];
}

function shingles(words, size) {
  const out = new Set();
  if (words.length < size) return out;
  for (let i = 0; i <= words.length - size; i += 1) {
    out.add(words.slice(i, i + size).join(" "));
  }
  return out;
}

function intersectionSize(a, b) {
  let count = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) count += 1;
  }
  return count;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  const intersection = intersectionSize(a, b);
  return intersection / (a.size + b.size - intersection);
}

function containment(sourceSet, targetSet) {
  if (!sourceSet.size) return 0;
  return intersectionSize(sourceSet, targetSet) / sourceSet.size;
}

function compareTexts(sourceText, candidateText) {
  const sourceWords = wordsOf(sourceText);
  const candidateWords = wordsOf(candidateText);
  const sourceShingles = shingles(sourceWords, SHINGLE_SIZE);
  const candidateShingles = shingles(candidateWords, SHINGLE_SIZE);
  const sourceSentences = new Set(sentencesOf(sourceText));
  const candidateSentences = new Set(sentencesOf(candidateText));

  const shingleJaccard = jaccard(sourceShingles, candidateShingles);
  const sourceContainment = containment(sourceShingles, candidateShingles);
  const sentenceContainment = containment(sourceSentences, candidateSentences);
  const score = Math.max(shingleJaccard, sourceContainment * 0.85, sentenceContainment);

  return {
    score,
    shingle_jaccard: shingleJaccard,
    source_containment: sourceContainment,
    sentence_containment: sentenceContainment,
    shared_shingles: intersectionSize(sourceShingles, candidateShingles),
    shared_sentences: intersectionSize(sourceSentences, candidateSentences),
    source_words: sourceWords.length,
    candidate_words: candidateWords.length
  };
}

function labelFor(score) {
  if (score >= 0.45) return "high_similarity";
  if (score >= 0.22) return "possible_overlap";
  if (score >= 0.1) return "low_overlap";
  return "clear";
}

async function runPlagiarismCheck(article) {
  const sourceText = articleToText(article);
  const sourceWords = wordsOf(sourceText);

  if (sourceWords.length < 80) {
    return {
      provider: "internal-shingle-check",
      score: null,
      label: "too_short",
      status: "too_short",
      word_count: sourceWords.length,
      matches: []
    };
  }

  const db = getSupabaseAdmin();
  let query = db
    .from("articles")
    .select("id, unique_id, title, short_description, long_description, writer_id, project_id, status, updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX_COMPARE_ARTICLES);

  if (article?.id) query = query.neq("id", article.id);

  const { data, error } = await query;
  if (error) {
    return {
      provider: "internal-shingle-check",
      score: null,
      label: "unavailable",
      status: "error",
      reason: error.message,
      word_count: sourceWords.length,
      matches: []
    };
  }

  const matches = (data || [])
    .map((candidate) => {
      const metrics = compareTexts(sourceText, articleToText(candidate));
      return {
        article_id: candidate.id,
        unique_id: candidate.unique_id || null,
        title: candidate.title || "Untitled article",
        project_id: candidate.project_id,
        writer_id: candidate.writer_id,
        status: candidate.status,
        score: round(metrics.score),
        shingle_jaccard: round(metrics.shingle_jaccard),
        source_containment: round(metrics.source_containment),
        sentence_containment: round(metrics.sentence_containment),
        shared_shingles: metrics.shared_shingles,
        shared_sentences: metrics.shared_sentences,
        candidate_words: metrics.candidate_words
      };
    })
    .filter((match) => match.score >= 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const topScore = matches[0]?.score || 0;
  return {
    provider: "internal-shingle-check",
    score: topScore,
    label: labelFor(topScore),
    status: "completed",
    word_count: sourceWords.length,
    compared_articles: data?.length || 0,
    matches
  };
}

function round(value) {
  return typeof value === "number" ? Number(value.toFixed(4)) : value;
}

module.exports = { runPlagiarismCheck };
