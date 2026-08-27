'use strict';

/**
 * groqFormatterService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends retrieved JSON knowledge base data to Groq AI for natural language
 * formatting ONLY.
 *
 * Rules:
 *  • Groq MUST NOT invent or add facts.
 *  • Only reformats what the JSON provides.
 *  • Receives only the relevant context — never the entire knowledge base.
 *  • Supports conversation history for context-aware answers.
 *  • tryDirectAnswer() bypasses Groq for high-confidence direct KB matches.
 */

const Groq = require('groq-sdk');
const { formatKbItem, formatMultipleItems } = require('../utils/responseFormatter');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_MESSAGE =
  "I couldn't find this information in my current college knowledge base. For the latest official information, please visit the Government Polytechnic Proddatur website.\n\n**Government Polytechnic Proddatur:**\nhttps://govtpolyproddatur.ac.in/";

/** Max characters of context to send to Groq (~1200 tokens) */
const MAX_CONTEXT_CHARS = 3000;

/** Max conversation history turns to include */
const MAX_HISTORY_TURNS = 2;

/**
 * Similarity threshold to bypass Groq and return a direct KB answer.
 * Lowered to 0.65 so that well-normalized question matches reliably bypass Groq.
 */
const DIRECT_ANSWER_THRESHOLD = 0.65;

/** Groq model — llama-3.1-8b-instant is much faster for simple Q&A */
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are the official AI assistant of **Government Polytechnic Proddatur (GPT Proddatur)**, Andhra Pradesh, India.

Your ONLY job is to answer the student's question using the information in the Knowledge Base Context below.

════════════════════════════════════════
CRITICAL RULES — FOLLOW WITHOUT EXCEPTION
════════════════════════════════════════

1. **NEVER invent, guess, or hallucinate** any information. If the answer is not in the context, say so.
2. **NEVER answer from memory** or from outside the provided context — use ONLY what is given.
3. **NEVER mention** "JSON", "knowledge base", "context", "Groq", "AI", or any internal system terms.
4. **NEVER repeat** the user's question back to them.
5. **NEVER add** extra facts, dates, fees, names, or details not present in the context.
6. **BRANCH/COURSE COUNT**: The college has EXACTLY the branches listed in the context. Do NOT add, invent, or mention any additional branches beyond what appears in the context.
7. **FOCUS STRICTLY ON THE QUESTION**: If multiple context entries are provided, use ONLY the entry or entries directly relevant to the user's specific question. Ignore context entries that answer a different question.
8. **DEDUPLICATION** — This is MANDATORY:
   - If the same fact, sentence, name, or bullet point appears in the context more than once, state it ONLY ONCE in your answer.
   - NEVER repeat the same sentence or bullet point twice.
   - NEVER write the same person's name or title more than once.
   - If multiple context entries say the same thing, pick the clearest one and ignore the rest.
9. **DEPARTMENT ISOLATION**: If the question asks about a specific department (e.g., EEE, ECE, CSE), answer ONLY using information about that department. Do NOT include information about other departments, the principal, or unrelated committees.

════════════════════════════════════════
FORMATTING AND LENGTH RULES
════════════════════════════════════════

10. **ANSWER LENGTH — always match the question type**:
    - Simple factual question (who/what/when/where): **1–2 sentences maximum**. No bullet list needed.
    - List question (what are the branches / facilities / etc.): **Short bullet list only**.
    - Explanation question: **Concise paragraph or short bullets**.
    - Only give a detailed response when the user explicitly asks for details, 8-marks, or "explain in full".
11. Always write in **professional, grammatically correct English**.
12. Use **Markdown formatting** where appropriate:
    - Use **bold** for important names and key terms.
    - Use bullet lists (-) for multiple items.
    - Do NOT use headers for simple 1-2 line answers.
13. **Do NOT pad responses.** Do NOT add unnecessary introductions, summaries, or conclusions.

════════════════════════════════════════
FALLBACK
════════════════════════════════════════

14. If the context does not contain the answer, reply EXACTLY with:
    "I couldn't find this information in my current college knowledge base. For the latest official information, please visit the Government Polytechnic Proddatur website.\\n\\n**Government Polytechnic Proddatur:**\\nhttps://govtpolyproddatur.ac.in/"

Do NOT add any extra explanation to the fallback message.`;



// ─────────────────────────────────────────────────────────────────────────────
// CLIENT INITIALIZATION (lazy)
// ─────────────────────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is not set in .env');
    }
    _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT ANSWER BYPASS (no Groq needed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple word-overlap similarity between two strings (normalized).
 * Returns a score between 0 and 1.
 */
function wordOverlapSimilarity(a, b) {
  const tokensA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1));
  const tokensB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  return intersection / Math.max(tokensA.size, tokensB.size);
}

/**
 * Try to return a direct answer from the KB without calling Groq.
 *
 * Returns a formatted string answer if a high-confidence QA pair is found,
 * or null if Groq should be used instead.
 *
 * @param {string}  userMessage   — the original user question
 * @param {Array}   matchedItems  — KB entries from search
 * @returns {string|null}
 */
function tryDirectAnswer(userMessage, matchedItems) {
  if (!matchedItems || matchedItems.length === 0) return null;

  // Normalize the user's query — strip punctuation, lowercase, trim
  const queryRaw  = userMessage.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  // Also compute a stopword-stripped version for better matching
  const queryNorm = queryRaw
    .split(/\s+/)
    .filter(w => w.length > 1 && !new Set(['a','an','the','is','are','of','in','on','at','by','for','with','about','from','and','or','who','what','how','when','where','tell','me','give','show','please','info','information','details']).has(w))
    .join(' ');

  // Only attempt direct bypass for the top result
  const topItem = matchedItems[0];
  if (!topItem._qa_pairs || topItem._qa_pairs.length === 0) return null;

  let bestScore  = 0;
  let bestAnswer = null;

  for (const qa of topItem._qa_pairs) {
    if (!qa.question || !qa.answer) continue;

    const storedRaw  = qa.question.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    // Stopword-stripped stored question
    const storedNorm = storedRaw
      .split(/\s+/)
      .filter(w => w.length > 1 && !new Set(['a','an','the','is','are','of','in','on','at','by','for','with','about','from','and','or','who','what','how','when','where','tell','me','give','show','please','info','information','details']).has(w))
      .join(' ');

    // Exact raw match (after normalization)
    if (storedRaw === queryRaw) {
      bestScore  = 1.0;
      bestAnswer = qa.answer;
      break;
    }

    // Exact normalized match (stopwords stripped from both sides)
    if (storedNorm && queryNorm && storedNorm === queryNorm) {
      const score = 0.95;
      if (score > bestScore) { bestScore = score; bestAnswer = qa.answer; }
      continue;
    }

    // Containment check (raw)
    if (storedRaw.includes(queryRaw) || queryRaw.includes(storedRaw)) {
      const score = 0.90;
      if (score > bestScore) { bestScore = score; bestAnswer = qa.answer; }
      continue;
    }

    // Containment check (normalized)
    if (storedNorm && queryNorm && (storedNorm.includes(queryNorm) || queryNorm.includes(storedNorm))) {
      const score = 0.85;
      if (score > bestScore) { bestScore = score; bestAnswer = qa.answer; }
      continue;
    }

    // Word overlap similarity (normalized tokens)
    const sim = wordOverlapSimilarity(queryNorm, storedNorm);
    if (sim > bestScore) {
      bestScore  = sim;
      bestAnswer = qa.answer;
    }
  }

  if (bestScore >= DIRECT_ANSWER_THRESHOLD && bestAnswer) {
    console.log(`[Pipeline] ⚡ Direct KB answer found (similarity: ${bestScore.toFixed(2)}) — skipping Groq.`);
    return bestAnswer.trim();
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert conversation history array to Groq message format.
 */
function buildHistoryMessages(history, maxTurns = MAX_HISTORY_TURNS) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const messages = [];

  for (const msg of history) {
    let role    = 'user';
    let content = '';

    if (msg.role === 'user' || msg.role === 'assistant') {
      role    = msg.role;
      content = msg.content || msg.text || msg.message || '';
    } else if (msg.sender === 'user' || msg.type === 'user') {
      role    = 'user';
      content = msg.content || msg.text || msg.message || '';
    } else if (msg.sender === 'bot' || msg.sender === 'assistant' || msg.type === 'bot') {
      role    = 'assistant';
      content = msg.content || msg.text || msg.message || '';
    } else {
      content = msg.content || msg.text || msg.message || '';
      if (!content) continue;
    }

    if (content.trim()) {
      messages.push({ role, content: content.trim() });
    }
  }

  const maxMessages = maxTurns * 2;
  return messages.slice(-maxMessages);
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAIN TEXT FALLBACK (when Groq unavailable)
// ─────────────────────────────────────────────────────────────────────────────

function _plainFallback(items) {
  if (!items || items.length === 0) return FALLBACK_MESSAGE;

  const results = Array.isArray(items) ? items : [items];
  const parts   = [];

  for (const item of results) {
    if (item.title) {
      parts.push(`**${item.title}**`);
    }

    if (item._qa_pairs && item._qa_pairs.length > 0) {
      for (const { answer } of item._qa_pairs.slice(0, 4)) {
        if (answer) parts.push(`- ${answer}`);
      }
    } else if (typeof item.content === 'string') {
      parts.push(item.content);
    } else if (item.answer) {
      parts.push(item.answer);
    }

    parts.push('');
  }

  return parts.join('\n').trim() || FALLBACK_MESSAGE;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE DEDUPLICATION — post-process Groq output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove duplicate sentences and bullet points from the AI response.
 * Preserves order — keeps the FIRST occurrence of each unique sentence.
 *
 * @param {string} text — the raw Groq response
 * @returns {string}   — deduplicated response
 */
function deduplicateResponse(text) {
  if (!text || typeof text !== 'string') return text;

  const lines = text.split('\n');
  const seen = new Set();
  const result = [];

  for (const line of lines) {
    // Normalize line for comparison: lowercase, strip markdown symbols, collapse spaces
    const normalized = line
      .replace(/^[\s\-\*\#\>]+/, '')  // strip leading markdown
      .replace(/\*\*/g, '')           // strip bold markers
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!normalized) {
      // Preserve empty lines (but deduplicate consecutive blank lines)
      if (result.length > 0 && result[result.length - 1] !== '') {
        result.push(line);
      }
      continue;
    }

    // Short lines (headers, short labels) are always kept
    if (normalized.length < 15) {
      result.push(line);
      continue;
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(line);
    }
    // else: duplicate line — silently skip it
  }

  return result.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FORMATTING FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format one or more matched KB items into a natural language response via Groq.
 * Only called when tryDirectAnswer() returns null.
 *
 * @param {string}   userMessage   — the user's original question
 * @param {Array}    matchedItems  — array of KB entries from jsonSearchService
 * @param {Array}    history       — conversation history (optional)
 * @returns {Promise<string>}      — formatted response
 */
async function formatResponse(userMessage, matchedItems, history = []) {
  const items = Array.isArray(matchedItems) ? matchedItems : [matchedItems];

  if (!items || items.length === 0) {
    console.log('[Pipeline] ⚠️  No matching entries — returning fallback.');
    return FALLBACK_MESSAGE;
  }

  console.log(`[Pipeline] ✅ Matching Entries: ${items.map(i => i.title || i.category || 'untitled').join(' | ')}`);

  // Build context text (only most relevant entries)
  let contextText = items.length === 1
    ? formatKbItem(items[0], userMessage)
    : formatMultipleItems(items, userMessage);

  // Truncate context if too long
  if (contextText.length > MAX_CONTEXT_CHARS) {
    contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + '\n... [context truncated]';
    console.log(`[Pipeline] ⚠️  Context truncated to ${MAX_CONTEXT_CHARS} chars`);
  }

  if (!contextText || contextText.trim().length < 5) {
    console.log('[Pipeline] ⚠️  Context too short — using plain fallback.');
    return _plainFallback(items);
  }

  const prompt = `---\nKnowledge Base Context:\n${contextText}\n---\n\nStudent Question: ${userMessage}\n\nUsing ONLY the knowledge base context above, answer the question concisely. For a simple factual question, use 1-2 sentences. For lists, use brief bullets. Never repeat information.`;

  const historyMessages = buildHistoryMessages(history);
  const messagesToGroq  = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    ...historyMessages,
    { role: 'user',   content: prompt },
  ];

  console.log(`[Pipeline] 📤 Sending to Groq (${contextText.length} chars, model: ${GROQ_MODEL})`);

  try {
    const groq       = getClient();
    const completion = await groq.chat.completions.create({
      messages:    messagesToGroq,
      model:       GROQ_MODEL,
      temperature: 0.1,
      max_tokens:  400,
    });

    const text = completion.choices[0]?.message?.content || '';

    if (!text.trim()) {
      console.log('[Pipeline] ⚠️  Groq returned empty response — using plain fallback.');
      return _plainFallback(items);
    }

    // Post-process: remove duplicate sentences/bullets from Groq output
    const deduplicated = deduplicateResponse(text.trim());
    console.log(`[Pipeline] 📥 Groq Response: ${text.length} chars → deduplicated: ${deduplicated.length} chars`);
    return deduplicated;

  } catch (error) {
    console.error('[Groq] ❌ Error calling API:', error.message || error);
    console.log('[Pipeline] ⚠️  Groq failed — using plain text fallback.');
    return _plainFallback(items);
  }
}

/**
 * Legacy single-item wrapper — kept for backward compatibility.
 */
async function formatSingleResponse(userMessage, matchedItem, history = []) {
  return formatResponse(userMessage, [matchedItem], history);
}

/**
 * Legacy multi-item wrapper — kept for backward compatibility.
 */
async function formatMultipleResponses(userMessage, matchedItems, history = []) {
  return formatResponse(userMessage, matchedItems, history);
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  formatResponse,
  formatSingleResponse,
  formatMultipleResponses,
  tryDirectAnswer,
  FALLBACK_MESSAGE,
};
