'use strict';

/**
 * responseFormatter.js
 * ─────────────────────────────────────────────────────────
 * Converts raw JSON knowledge base entries into clean,
 * readable plain-text blocks before passing to Groq AI.
 *
 * Handles ALL content structures found in the data files:
 *   • content: "plain string"
 *   • content: { question, answer }
 *   • content: { questions: [...], answer: "..." }
 *   • content: { questions_answers: [{question, answer}] }
 *   • content: [{ question, answer }, ...]
 *   • content: { key: value, ... }  (generic object)
 *   • answer: "top-level answer field"
 */

// ── Title Case Helper ─────────────────────────────────────────────────────────
function titleCase(str) {
  return str
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Flatten generic nested object into key: value lines ───────────────────────
function flattenObject(obj, prefix = '', depth = 0) {
  if (depth > 3) return [];
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    // Skip internal/meta fields
    if (['id', 'keywords', 'page', 'source', 'website', 'department'].includes(key)) continue;
    const label = prefix ? `${prefix} › ${titleCase(key)}` : titleCase(key);
    if (val === null || val === undefined || val === '') continue;
    if (typeof val === 'object' && !Array.isArray(val)) {
      lines.push(...flattenObject(val, label, depth + 1));
    } else if (Array.isArray(val)) {
      if (val.length === 0) continue;
      const items = val.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
      lines.push(`${label}: ${items.join(', ')}`);
    } else {
      lines.push(`${label}: ${val}`);
    }
  }
  return lines;
}

// ── Extract Q&A pairs from any content structure ──────────────────────────────
/**
 * Normalizes any content structure into an array of { question, answer } pairs.
 * Returns empty array if no Q&A structure detected.
 *
 * Supported structures:
 *   • content: "plain string"
 *   • content: [{ question, answer }, ...]
 *   • content: { questions_answers: [{question, answer}] }
 *   • content: { possible_questions_answers: [{question, answer}] }
 *   • content: { possibleQuestions: [...], answer: "" }
 *   • content: { description: "...", possible_questions_answers: [...] }  ← mixed
 *   • content: { question: "...", answer: "..." }
 *   • content: { answer: "..." }
 *   • content: { key: value, ... }  (generic object — flattened)
 */
function extractQAPairs(content) {
  if (!content) return [];

  // Case 1: content is a plain string — treat as a standalone answer
  if (typeof content === 'string') {
    return [{ question: '', answer: content }];
  }

  // Case 2: content is an array
  if (Array.isArray(content)) {
    const pairs = [];
    for (const item of content) {
      if (typeof item === 'object' && item !== null) {
        if (item.question || item.answer) {
          pairs.push({ question: (item.question || '').trim(), answer: (item.answer || '').trim() });
        } else if (item.content) {
          const subPairs = extractQAPairs(item.content);
          for (const sub of subPairs) {
            const q = sub.question || item.title || '';
            pairs.push({ question: q.trim(), answer: sub.answer.trim() });
          }
        }
      } else if (typeof item === 'string' && item.trim()) {
        pairs.push({ question: '', answer: item.trim() });
      }
    }
    return pairs;
  }

  // Case 3: content is an object
  if (typeof content === 'object') {
    const pairs = [];

    // ── Step A: Collect description / summary text fields into a leading pair ──
    // These are plain-text fields that coexist with Q&A arrays in mixed structures
    // (e.g., college-timings.json has description + college_timings + possible_questions_answers)
    const TEXT_FIELDS = ['description', 'info', 'text', 'summary', 'overview', 'note', 'notes'];
    const descParts = [];
    for (const field of TEXT_FIELDS) {
      if (content[field] && typeof content[field] === 'string' && content[field].trim()) {
        descParts.push(content[field].trim());
      }
    }
    // Collect other simple string fields that aren't Q&A arrays or known skippable keys
    const SKIP_FIELDS = new Set([
      'description', 'info', 'text', 'summary', 'overview', 'note', 'notes',
      'possible_questions_answers', 'questions_answers', 'possibleQuestions',
      'questions', 'answer', 'question',
      'id', 'page', 'website', 'source', 'department',
    ]);
    for (const [key, val] of Object.entries(content)) {
      if (SKIP_FIELDS.has(key)) continue;
      if (typeof val === 'string' && val.trim()) {
        descParts.push(`${titleCase(key)}: ${val.trim()}`);
      }
    }
    if (descParts.length > 0) {
      pairs.push({ question: '', answer: descParts.join('\n') });
    }

    // ── Step B: Extract Q&A pairs from recognized array fields ────────────────

    // Case 3a: { questions_answers: [{question, answer}] }
    if (Array.isArray(content.questions_answers)) {
      for (const qa of content.questions_answers) {
        if (qa && (qa.question || qa.answer)) {
          pairs.push({ question: (qa.question || '').trim(), answer: (qa.answer || '').trim() });
        }
      }
      // If we got Q&A pairs, return them (with any leading description pair)
      if (pairs.length > 0) return pairs;
    }

    // Case 3a2: { possible_questions_answers: [{question, answer}] }
    if (Array.isArray(content.possible_questions_answers)) {
      for (const qa of content.possible_questions_answers) {
        if (qa && (qa.question || qa.answer)) {
          pairs.push({ question: (qa.question || '').trim(), answer: (qa.answer || '').trim() });
        }
      }
      if (pairs.length > 0) return pairs;
    }

    // Case 3a3: { possibleQuestions: [...], answer: "..." }
    if (Array.isArray(content.possibleQuestions) && content.answer) {
      pairs.push({ question: content.possibleQuestions[0] || '', answer: content.answer });
      if (pairs.length > 0) return pairs;
    }

    // Case 3b: { questions: [...], answer: "..." }
    if (content.answer && Array.isArray(content.questions)) {
      pairs.push({ question: content.questions[0] || '', answer: content.answer });
      if (pairs.length > 0) return pairs;
    }

    // Case 3c: { question: "...", answer: "..." }
    if (content.answer && (content.question || typeof content.question === 'string')) {
      pairs.push({ question: (content.question || '').trim(), answer: content.answer.trim() });
      if (pairs.length > 0) return pairs;
    }

    // Case 3d: { answer: "..." } (just an answer, no question)
    if (content.answer) {
      pairs.push({ question: '', answer: content.answer.trim() });
      if (pairs.length > 0) return pairs;
    }

    // Case 3e: If we already collected description parts (step A), return those
    if (pairs.length > 0) return pairs;

    // Case 3f: generic key-value object — flatten it as last resort
    const lines = flattenObject(content);
    if (lines.length > 0) {
      return [{ question: '', answer: lines.join('\n') }];
    }
  }

  return [];
}

// ── Pick the most relevant Q&A pairs for a given query ────────────────────────
/**
 * Given an array of Q&A pairs and a query string, return the top N most relevant.
 * Uses simple keyword overlap scoring.
 * Default maxPairs reduced to 3 to avoid context bloat.
 */
function pickRelevantQAs(qaPairs, query, maxPairs = 3) {
  if (!query || qaPairs.length <= maxPairs) return qaPairs.slice(0, maxPairs);

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  // High-value entity keywords that must dominate scoring when present in both
  // the query and a QA pair. This ensures "hod of ece" picks the HOD pair,
  // not the vision/mission pair just because it has more keyword overlaps.
  const ENTITY_KEYWORDS = [
    'hod', 'head', 'principal', 'name', 'who', 'timings', 'timing', 'hours',
    'fee', 'fees', 'admission', 'hostel', 'contact', 'phone', 'address',
    'faculty', 'lecturer', 'intake', 'seats', 'lab', 'laboratories',
  ];

  const scored = qaPairs.map(qa => {
    const text = `${qa.question} ${qa.answer}`.toLowerCase();
    let score = 0;

    // Standard keyword overlap
    for (const word of queryWords) {
      if (text.includes(word)) score++;
    }

    // Exact phrase match bonus
    if (text.includes(queryLower)) score += 5;

    // Question exact match bonus
    if (qa.question && qa.question.toLowerCase().includes(queryLower)) score += 3;

    // ── Entity keyword bonus ──────────────────────────────────────────────────
    // If both the user's query AND this QA pair contain an entity keyword,
    // give a large bonus so entity-specific pairs always win over generic ones.
    for (const entityKw of ENTITY_KEYWORDS) {
      const queryHasEntity = queryLower.includes(entityKw);
      const qaHasEntity    = text.includes(entityKw);
      if (queryHasEntity && qaHasEntity) {
        score += 10; // Large bonus — ensures the HOD/principal/timing pair wins
      }
    }

    return { qa, score };
  });

  // Sort by score descending, take top maxPairs
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxPairs).map(s => s.qa);
}

// ── Format a single KB entry into a readable text block ──────────────────────
/**
 * Converts one KB entry into a clean text block to send to Groq.
 * @param {Object} item  — one entry from the knowledge base
 * @param {string} query — the user's original query (for relevance filtering)
 */
function formatKbItem(item, query = '') {
  if (!item) return '';

  const parts = [];

  // Header
  if (item.title) parts.push(`📋 Topic: ${item.title}`);
  if (item.category) parts.push(`🗂️ Category: ${item.category}`);
  if (parts.length > 0) parts.push('');

  // Extract Q&A pairs from content
  const qaPairs = extractQAPairs(item.content);

  if (qaPairs.length > 0) {
    // Pick the most relevant Q&A pairs (max 3)
    const relevant = pickRelevantQAs(qaPairs, query, 3);

    // Deduplicate answers before including — don't include the same answer twice
    const seenAnswers = new Set();
    for (const { question, answer } of relevant) {
      if (!answer) continue;
      const answerKey = answer.trim().toLowerCase().replace(/\s+/g, ' ');
      if (seenAnswers.has(answerKey)) continue;
      seenAnswers.add(answerKey);
      if (question) parts.push(`Q: ${question}`);
      parts.push(`A: ${answer}`);
      parts.push('');
    }
  }

  // Top-level answer field (e.g., alumuni.json plain string content already extracted above)
  // But some items have top-level answer/description fields separate from content
  const extraFields = ['answer', 'description', 'details', 'info', 'note', 'notes'];
  for (const field of extraFields) {
    if (item[field] && typeof item[field] === 'string' && item[field].trim()) {
      parts.push(`${titleCase(field)}: ${item[field]}`);
      parts.push('');
    }
  }

  return parts.join('\n').trim();
}

// ── Format multiple KB entries into one context block ────────────────────────
/**
 * Merges multiple KB entries into a single text block for Groq.
 * @param {Object[]} items — array of KB entries
 * @param {string}   query — the user's original query
 */
function formatMultipleItems(items, query = '') {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return formatKbItem(items[0], query);

  return items
    .map((item, i) => `--- Result ${i + 1}: ${item.title || item.category || ''} ---\n${formatKbItem(item, query)}`)
    .join('\n\n');
}

module.exports = {
  formatKbItem,
  formatMultipleItems,
  extractQAPairs,
  pickRelevantQAs,
  flattenObject,
  titleCase,
};
