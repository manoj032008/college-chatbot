'use strict';

/**
 * chatController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all chatbot API endpoints.
 *
 * Pipeline for POST /api/chat/send:
 *   1. Validate input
 *   2. Check in-memory response cache (normalized key)
 *   3. Detect greetings → immediate response
 *   4. Search JSON Knowledge Base (returns top 1–5 ranked results)
 *   5. Check if top result has a direct high-confidence answer → skip Groq
 *   6. If needed, send matched entries + history to Groq for formatting
 *   7. Cache and return formatted response
 */

const jsonSearchService = require('../services/jsonSearchService');
const {
  formatResponse,
  tryDirectAnswer,
  FALLBACK_MESSAGE,
} = require('../services/groqFormatterService');
const response = require('../utils/response');

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY RESPONSE CACHE
// ─────────────────────────────────────────────────────────────────────────────

/** Max entries in cache before oldest entries are evicted */
const CACHE_MAX_SIZE = 200;

/** Cache: normalized question string → { reply, timestamp } */
const responseCache = new Map();

/**
 * Normalize a query for cache key purposes.
 * Lowercase, trim, collapse whitespace, remove punctuation.
 */
function normalizeCacheKey(query) {
  return query
    .toLowerCase()
    .replace(/[''\"?!.,;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get cached response for a query, or null.
 */
function getCached(query) {
  const key = normalizeCacheKey(query);
  return responseCache.get(key) || null;
}

/**
 * Store a response in cache, evicting oldest if over limit.
 */
function setCached(query, reply) {
  const key = normalizeCacheKey(query);
  if (responseCache.size >= CACHE_MAX_SIZE) {
    // Evict the oldest entry
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
  responseCache.set(key, { reply, timestamp: Date.now() });
}

/**
 * Invalidate (clear) the entire response cache.
 * Called when the knowledge base is hot-reloaded.
 */
function invalidateCache() {
  const size = responseCache.size;
  responseCache.clear();
  console.log(`[Cache] ♻️  Response cache invalidated (${size} entries cleared).`);
}

// Hook into the KB watcher — invalidate cache on every KB reload
try {
  // jsonSearchService exposes a reload event via its reload() method.
  // We wrap it to also invalidate cache.
  const originalReload = jsonSearchService.reload.bind(jsonSearchService);
  jsonSearchService.reload = function () {
    const result = originalReload();
    invalidateCache();
    return result;
  };
} catch (e) {
  console.warn('[Cache] Could not hook KB reload for cache invalidation:', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many top results to retrieve from the KB.
 * For short/specific questions: fewer results are cleaner.
 * For broad questions: more context helps Groq give comprehensive answers.
 */
function getTopN(query) {
  const words = query.trim().split(/\s+/).length;
  if (words <= 2)  return 3;   // short query — top 3
  if (words <= 5)  return 4;   // medium query — top 4
  return 5;                    // long query — top 5
}

// ─────────────────────────────────────────────────────────────────────────────
// GREETING DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function isGreeting(message) {
  const normalized = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  const greetings = new Set([
    'hi',
    'hii',
    'hiii',
    'hello',
    'hey',
    'hey there',
    'good morning',
    'good afternoon',
    'good evening',
    'good night',
    'greetings',
    'thanks',
    'thank you',
    'thankyou',
    'thank u',
    'ty',
    'ok',
    'okay',
    'fine',
    'alright',
  ]);

  return greetings.has(normalized);
}

function getGreetingReply(message) {
  const norm = message.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (norm.startsWith('thank') || norm === 'ty') {
    return "You're welcome! 😊 Feel free to ask me anything else about Government Polytechnic Proddatur.";
  }
  return "Hello! 👋 Welcome to Government Polytechnic Proddatur College Chatbot.\n\nHow can I help you today? You can ask me about:\n- **Admissions** and eligibility\n- **Courses** and departments\n- **Fees** and scholarships\n- **Exams** and results\n- **Facilities** and campus life\n- **College timings** and contact info";
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/chat/send
 * Body: { message: string, history?: Array }
 */
const sendMessage = async (req, res, next) => {
  const pipelineStart = Date.now();
  const { message, history } = req.body;

  const cleanMessage = (message || '').trim();
  if (!cleanMessage) {
    return response.error(res, 'Message cannot be empty.', 400);
  }

  // ── Step 1: Greeting fast-path ────────────────────────────────────────────
  if (isGreeting(cleanMessage)) {
    const botReply = getGreetingReply(cleanMessage);
    console.log(`[Pipeline] 👋 Greeting detected: "${cleanMessage}" → instant reply (${Date.now() - pipelineStart}ms)`);
    return res.json({
      reply:        botReply,
      timestamp:    new Date().toISOString(),
      found:        false,
      resultsCount: 0,
      cached:       false,
    });
  }

  // ── Step 2: Check response cache ──────────────────────────────────────────
  const cached = getCached(cleanMessage);
  if (cached) {
    console.log(`[Pipeline] ⚡ Cache HIT for: "${cleanMessage.substring(0, 60)}" (${Date.now() - pipelineStart}ms)`);
    return res.json({
      reply:        cached.reply,
      timestamp:    new Date().toISOString(),
      found:        true,
      resultsCount: 1,
      cached:       true,
    });
  }

  // Sanitize history — must be an array
  const safeHistory = Array.isArray(history) ? history : [];

  try {
    // ── Step 3: Search JSON Knowledge Base ───────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Pipeline] 🔎 Searching JSON...`);
    console.log(`[Pipeline]    Query: "${cleanMessage.substring(0, 80)}"`);

    const searchStart  = Date.now();
    const topN         = getTopN(cleanMessage);
    const matchedItems = jsonSearchService.searchMultiple(cleanMessage, topN, safeHistory);
    const searchMs     = Date.now() - searchStart;

    console.log(`[PERF] Search: ${searchMs}ms`);

    if (matchedItems.length > 0) {
      console.log(`[Pipeline] ✅ Matching Entries Found: ${matchedItems.length} result(s)`);
      matchedItems.forEach((item, i) => {
        console.log(`[Pipeline]    [${i + 1}] ${item.title || item.category || 'untitled'}`);
      });
    } else {
      console.log(`[Pipeline] ⚠️  No matching entries found (${searchMs}ms) — will return fallback`);
    }

    // ── Step 4: Format response ───────────────────────────────────────────────
    let botReply = '';

    if (matchedItems.length === 0) {
      botReply = FALLBACK_MESSAGE;
      console.log('[Pipeline] ↩️  Returning fallback (no KB match).');
    } else {
      // Try direct answer first (skips Groq if high-confidence match found)
      const directAnswer = tryDirectAnswer(cleanMessage, matchedItems);
      if (directAnswer) {
        botReply = directAnswer;
        console.log(`[PERF] Direct answer returned (no Groq call). Total: ${Date.now() - pipelineStart}ms`);
      } else {
        console.log(`[Pipeline] 🤖 Sending to Groq for formatting...`);
        const aiStart = Date.now();
        botReply = await formatResponse(cleanMessage, matchedItems, safeHistory);
        const aiMs = Date.now() - aiStart;
        console.log(`[PERF] Groq: ${aiMs}ms`);
      }
    }

    // ── Step 5: Cache and return ──────────────────────────────────────────────
    if (botReply && botReply !== FALLBACK_MESSAGE) {
      setCached(cleanMessage, botReply);
    }

    const totalMs = Date.now() - pipelineStart;
    console.log(`[PERF] Total: ${totalMs}ms`);
    console.log(`[Pipeline] ✅ Final Response Returned (${botReply.length} chars)`);
    console.log(`${'─'.repeat(60)}\n`);

    return res.json({
      reply:        botReply,
      timestamp:    new Date().toISOString(),
      found:        matchedItems.length > 0,
      resultsCount: matchedItems.length,
      cached:       false,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chat/sessions
 * Stateless chatbot — no DB sessions.
 */
const getSessions = async (req, res) => res.json([]);

/**
 * GET /api/chat/messages/:sessionId
 * Stateless chatbot — no DB sessions.
 */
const getMessages = async (req, res) => res.json([]);

/**
 * DELETE /api/chat/sessions
 * No-op in stateless mode.
 */
const deleteSessions = async (req, res) =>
  res.json({ message: 'Chat history cleared.' });

module.exports = { sendMessage, getSessions, getMessages, deleteSessions };
