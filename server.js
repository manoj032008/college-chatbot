require('dotenv').config();

const app  = require('./app');
const PORT = process.env.PORT || 5000;

// ── Pre-load JSON Knowledge Base ───────────────────────────────────────────────
// This ensures the KB is ready before any requests arrive
const kbService = require('./services/jsonSearchService');
const stats     = kbService.getStats();
console.log(`[KB] ✅ Knowledge Base ready: ${stats.categories} categories, ${stats.entries} entries`);

// ── Start server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  🎓 College Chatbot — JSON Knowledge Base Mode   ║`);
  console.log(`║  🚀 Running on: http://localhost:${PORT}             ║`);
  console.log(`║  📁 Mode: ${(process.env.NODE_ENV || 'development').padEnd(10)} No DB, No Auth          ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
