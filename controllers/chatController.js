'use strict';

/**
 * chatController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all chatbot API endpoints.
 *
 * Pipeline for POST /api/chat/send:
 *   1. Validate input
 *   2. Extract conversation history for context
 *   3. Search JSON Knowledge Base (returns top 1–5 ranked results)
 *   4. Send matched entries + history to Groq for natural language formatting
 *   5. Return formatted response
 */

const jsonSearchService = require('../services/jsonSearchService');
const {
  formatResponse,
  FALLBACK_MESSAGE,
} = require('../services/groqFormatterService');
const response = require('../utils/response');

// ── Helpers ────────────────────────────────────────────────────────────────────

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

// ── Greeting Detection Helper ──────────────────────────────────────────────────

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
    'greetings'
  ]);

  return greetings.has(normalized);
}

// ── Chat endpoints ─────────────────────────────────────────────────────────────

/**
 * POST /api/chat/send
 * Body: { message: string, history?: Array }
 *
 * history format (flexible — accepts multiple conventions):
 *   [{ role: 'user'|'assistant', content: '...' }]
 *   [{ sender: 'user'|'bot', text: '...' }]
 *   [{ sender: 'user'|'bot', message: '...' }]
 */
const sendMessage = async (req, res, next) => {
  const pipelineStart = Date.now();
  const { message, history } = req.body;

  const cleanMessage = (message || '').trim();
  if (!cleanMessage) {
    return response.error(res, 'Message cannot be empty.', 400);
  }

  // Check if it's ONLY a greeting
  if (isGreeting(cleanMessage)) {
    const botReply = "Hello! 👋 Welcome to Government Polytechnic Proddatur College Chatbot. How can I help you today?";
    console.log(`[Pipeline] 👋 Greeting detected: "${cleanMessage}". Returning immediate greeting response.`);
    return res.json({
      reply:        botReply,
      timestamp:    new Date().toISOString(),
      found:        false,
      resultsCount: 0,
    });
  }

  // Sanitize history — must be an array
  const safeHistory = Array.isArray(history) ? history : [];

  try {
    // ── Step 1: Search JSON Knowledge Base ────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Pipeline] 🔎 Searching JSON...`);
    console.log(`[Pipeline]    Query: "${cleanMessage.substring(0, 80)}"`);

    const searchStart  = Date.now();
    const topN         = getTopN(cleanMessage);
    const matchedItems = jsonSearchService.searchMultiple(cleanMessage, topN, safeHistory);
    const searchMs     = Date.now() - searchStart;

    if (matchedItems.length > 0) {
      console.log(`[Pipeline] ✅ Matching Entries Found: ${matchedItems.length} result(s) in ${searchMs}ms`);
      matchedItems.forEach((item, i) => {
        console.log(`[Pipeline]    [${i + 1}] ${item.title || item.category || 'untitled'}`);
      });
    } else {
      console.log(`[Pipeline] ⚠️  No matching entries found (${searchMs}ms) — will return fallback`);
    }

    // ── Step 2: Format response with Groq ────────────────────────────────────
    let botReply = '';

    if (matchedItems.length === 0) {
      botReply = FALLBACK_MESSAGE;
      console.log('[Pipeline] ↩️  Returning fallback (no KB match).');
    } else {
      console.log(`[Pipeline] 🤖 Sending to Groq for formatting...`);
      const aiStart = Date.now();
      // Pass all matched items + history for context-aware formatting
      botReply = await formatResponse(cleanMessage, matchedItems, safeHistory);
      console.log(`[Pipeline] ⏱️  Groq formatting completed in ${Date.now() - aiStart}ms`);
    }

    const totalMs = Date.now() - pipelineStart;
    console.log(`[Pipeline] ✅ Final Response Returned (total: ${totalMs}ms, reply: ${botReply.length} chars)`);
    console.log(`${'─'.repeat(60)}\n`);

    return res.json({
      reply:        botReply,
      timestamp:    new Date().toISOString(),
      found:        matchedItems.length > 0,
      resultsCount: matchedItems.length,
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
