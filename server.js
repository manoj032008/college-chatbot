require('dotenv').config();
const app = require('./app');
const PORT = process.env.PORT || 5000;
// ─────────────────────────────────────────────────────────────
// Pre-load JSON Knowledge Base
// ─────────────────────────────────────────────────────────────
const kbService = require('./services/jsonSearchService');
const stats = kbService.getStats();
console.log(
  `[KB] ✅ Knowledge Base ready: ${stats.categories} categories, ${stats.entries} entries`
);
// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       🎓 College Chatbot                        ║');
  console.log('║       📚 JSON Knowledge Base Mode               ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  🚀 Server running on port: ${PORT}              ║`);
  console.log(`║  📁 Environment: ${(process.env.NODE_ENV || 'development').padEnd(24)}║`);
  console.log('║  💾 Database: JSON Knowledge Base               ║');
  console.log('║  🔐 Authentication: Disabled                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});