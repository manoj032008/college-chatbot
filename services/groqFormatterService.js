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

/** Max characters of context to send to Groq (~1500 tokens) */
const MAX_CONTEXT_CHARS = 4000;

/** Max conversation history turns to include */
const MAX_HISTORY_TURNS = 3;

/**
 * Similarity threshold to bypass Groq and return a direct KB answer.
 * If the normalized user query closely matches a stored Q&A question,
 * return the stored answer without an AI call.
 */
const DIRECT_ANSWER_THRESHOLD = 0.75;

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are the official AI assistant of **Government Polytechnic Proddatur (GPT Proddatur)**, Andhra Pradesh, India.

Your ONLY job is to reformat and present the information from the provided Knowledge Base Context in clear, professional, well-structured English.

════════════════════════════════════════
CRITICAL RULES — FOLLOW WITHOUT EXCEPTION
════════════════════════════════════════

1. **NEVER invent, guess, or hallucinate** any information. If the answer is not in the context, say so.
2. **NEVER answer from memory** or from outside the provided context — use ONLY what is given.
3. **NEVER mention** "JSON", "knowledge base", "context", "Groq", "AI", or any internal system terms.
4. **NEVER repeat** the user's question back to them.
5. **NEVER add** extra facts, dates, fees, names, or details not present in the context.
6. **BRANCH/COURSE COUNT**: The college has EXACTLY the branches listed in the context. Do NOT add, invent, or mention any additional branches beyond what appears in the context. If the context lists 5 branches, list exactly those 5.

════════════════════════════════════════
FORMATTING RULES — ALWAYS APPLY
════════════════════════════════════════

7. Always write in **professional, grammatically correct English**.
8. **BE CONCISE** — prefer short bullet lists over long paragraphs. Do not pad responses.
9. Use **Markdown formatting**:
   - Use ### for main section headings
   - Use **bold** for important labels, names, and key terms
   - Use bullet lists (-) for multiple items
   - Use tables when comparing or listing structured data
10. For simple factual questions, answer in 2–5 bullet points or lines.
11. Do NOT produce large essays for simple questions.

════════════════════════════════════════
FALLBACK
════════════════════════════════════════

12. If the context does not contain the answer, reply EXACTLY with:
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

  const queryNorm = userMessage.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // Only attempt direct bypass for the top result
  const topItem = matchedItems[0];
  if (!topItem._qa_pairs || topItem._qa_pairs.length === 0) return null;

  let bestScore = 0;
  let bestAnswer = null;

  for (const qa of topItem._qa_pairs) {
    if (!qa.question || !qa.answer) continue;

    const questionNorm = qa.question.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

    // Exact match (after normalization)
    if (questionNorm === queryNorm) {
      bestScore = 1.0;
      bestAnswer = qa.answer;
      break;
    }

    // Containment check
    if (questionNorm.includes(queryNorm) || queryNorm.includes(questionNorm)) {
      const score = 0.9;
      if (score > bestScore) {
        bestScore = score;
        bestAnswer = qa.answer;
      }
      continue;
    }

    // Word overlap similarity
    const sim = wordOverlapSimilarity(queryNorm, questionNorm);
    if (sim > bestScore) {
      bestScore = sim;
      bestAnswer = qa.answer;
    }
  }

  if (bestScore >= DIRECT_ANSWER_THRESHOLD && bestAnswer) {
    console.log(`[Pipeline] ⚡ Direct KB answer found (similarity: ${bestScore.toFixed(2)}) — skipping Groq.`);
    // Return the raw answer (already formatted in JSON as markdown)
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

  const prompt = `---\nKnowledge Base Context:\n${contextText}\n---\n\nStudent Question: ${userMessage}\n\nUsing ONLY the knowledge base context above, provide a concise, well-formatted Markdown answer (prefer bullet lists, be brief):`;

  const historyMessages = buildHistoryMessages(history);
  const messagesToGroq  = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    ...historyMessages,
    { role: 'user',   content: prompt },
  ];

  console.log(`[Pipeline] 📤 Sending to Groq (${contextText.length} chars, model: llama-3.3-70b-versatile)`);

  try {
    const groq       = getClient();
    const completion = await groq.chat.completions.create({
      messages:    messagesToGroq,
      model:       'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens:  600,
    });

    const text = completion.choices[0]?.message?.content || '';

    if (!text.trim()) {
      console.log('[Pipeline] ⚠️  Groq returned empty response — using plain fallback.');
      return _plainFallback(items);
    }

    console.log(`[Pipeline] 📥 Groq Response: ${text.length} chars`);
    return text.trim();

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
