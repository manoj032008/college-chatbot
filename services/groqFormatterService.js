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
 */

const Groq = require('groq-sdk');
const { formatKbItem, formatMultipleItems } = require('../utils/responseFormatter');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_MESSAGE =
  "I couldn't find this information in my current college knowledge base. For the latest official information, please visit the Government Polytechnic Proddatur website.\n\n**Government Polytechnic Proddatur:**\nhttps://govtpolyproddatur.ac.in/";

/** Max characters of context to send to Groq (~2000 tokens) */
const MAX_CONTEXT_CHARS = 6000;

/** Max conversation history turns to include */
const MAX_HISTORY_TURNS = 3;

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

════════════════════════════════════════
FORMATTING RULES — ALWAYS APPLY
════════════════════════════════════════

6. Always write in **professional, grammatically correct English**.
7. Always use **Markdown formatting**:
   - Use ### for main section headings
   - Use #### for sub-section headings  
   - Use **bold** for important labels, names, and key terms
   - Use bullet lists (-) for multiple items
   - Use tables (| col | col |) when comparing or listing structured data
   - Separate sections with a blank line
8. Keep responses **concise and scannable** — use short paragraphs and lists, not walls of text.
9. If multiple topics appear, **group them under headings** for clarity.

════════════════════════════════════════
FORMATTING EXAMPLES
════════════════════════════════════════

Example 1 — Listing lecturers:

### Lecturers in the General Section

The General Section includes the following lecturers:

#### English
- **P. Sudhakar**
- **B. Naresh Babu**

#### Physics
- **Dr. P. Surendra Reddy**
- **N. Siva Krishna**

#### Mathematics *(Contract)*
- **P. Pavan Kumar Naidu**
- **M. V. Madhavi**

Example 2 — Fee structure:

### Fee Structure

| Course | Annual Fee |
|--------|------------|
| Diploma in Civil Engineering | ₹12,000 |
| Diploma in Computer Engineering | ₹14,000 |

════════════════════════════════════════
FALLBACK
════════════════════════════════════════

10. If the context does not contain the answer, reply EXACTLY with:
    "I couldn't find this information in my current college knowledge base. For the latest official information, please visit the Government Polytechnic Proddatur website.\n\n**Government Polytechnic Proddatur:**\nhttps://govtpolyproddatur.ac.in/"

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
// HISTORY FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert conversation history array to Groq message format.
 * Accepts history items as: { role, content } or { sender, text/message } etc.
 *
 * @param {Array}  history — raw history from frontend
 * @param {number} maxTurns — max number of exchanges to include
 * @returns {Array} array of { role: 'user'|'assistant', content: string }
 */
function buildHistoryMessages(history, maxTurns = MAX_HISTORY_TURNS) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const messages = [];

  for (const msg of history) {
    // Normalize role
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
      // Default: try to guess from available fields
      content = msg.content || msg.text || msg.message || '';
      if (!content) continue;
    }

    if (content.trim()) {
      messages.push({ role, content: content.trim() });
    }
  }

  // Take only the last N turns (user+assistant = 2 messages per turn)
  const maxMessages = maxTurns * 2;
  return messages.slice(-maxMessages);
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAIN TEXT FALLBACK (when Groq unavailable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format the matched items without AI — just return the raw Q&A content.
 */
function _plainFallback(items) {
  if (!items || items.length === 0) return FALLBACK_MESSAGE;

  const results = Array.isArray(items) ? items : [items];
  const parts   = [];

  for (const item of results) {
    if (item.title) {
      parts.push(`**${item.title}**`);
    }

    // Try Q&A pairs first
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
 * Format one or more matched KB items into a natural language response.
 *
 * @param {string}   userMessage   — the user's original question
 * @param {Array}    matchedItems  — array of KB entries from jsonSearchService
 * @param {Array}    history       — conversation history (optional)
 * @returns {Promise<string>}      — formatted response
 */
async function formatResponse(userMessage, matchedItems, history = []) {
  // ── Step 1: Normalize input ────────────────────────────────────────────────
  const items = Array.isArray(matchedItems) ? matchedItems : [matchedItems];

  if (!items || items.length === 0) {
    console.log('[Pipeline] ⚠️  No matching entries — returning fallback.');
    return FALLBACK_MESSAGE;
  }

  console.log(`[Pipeline] 🔎 Searching JSON... (${items.length} result(s) to process)`);
  console.log(`[Pipeline] ✅ Matching Entries Found: ${items.map(i => i.title || i.category || 'untitled').join(' | ')}`);

  // ── Step 2: Build context text ────────────────────────────────────────────
  let contextText = items.length === 1
    ? formatKbItem(items[0], userMessage)
    : formatMultipleItems(items, userMessage);

  // Truncate context if too long
  if (contextText.length > MAX_CONTEXT_CHARS) {
    contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + '\n... [additional context truncated]';
    console.log(`[Pipeline] ⚠️  Context truncated to ${MAX_CONTEXT_CHARS} chars`);
  }

  if (!contextText || contextText.trim().length < 5) {
    console.log('[Pipeline] ⚠️  Context too short — using plain fallback.');
    return _plainFallback(items);
  }

  const prompt = `---\nKnowledge Base Context:\n${contextText}\n---\n\nStudent Question: ${userMessage}\n\nUsing ONLY the knowledge base context above, provide a clear, professional, well-formatted Markdown answer:`;

  // Build message sequence: system + optional history + current turn
  const historyMessages = buildHistoryMessages(history);
  const messagesToGroq  = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    ...historyMessages,
    { role: 'user',   content: prompt },
  ];

  console.log(`[Pipeline] 📤 Context Sent To Groq... (${contextText.length} chars, model: llama-3.3-70b-versatile)`);

  try {
    const groq       = getClient();
    const completion = await groq.chat.completions.create({
      messages:    messagesToGroq,
      model:       'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens:  1200,
    });

    const text = completion.choices[0]?.message?.content || '';

    if (!text.trim()) {
      console.log('[Pipeline] ⚠️  Groq returned empty response — using plain fallback.');
      return _plainFallback(items);
    }

    console.log(`[Pipeline] 📥 Groq Response Received... (${text.length} chars)`);
    console.log('[Pipeline] ✅ Final Response Returned.');

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
  FALLBACK_MESSAGE,
};
