require('dotenv').config();
const app = require('./app');
const PORT = process.env.PORT || 5000;

// ── Ephemeral Filesystem Detection ──────────────────────────────────────────
const isRender = process.env.RENDER === 'true';
const isEphemeral = isRender && !process.env.PERSISTENT_DISK_PATH;

// ── Pre-load JSON Knowledge Base ─────────────────────────────────────────────
const kbService = require('./services/jsonSearchService');
const stats = kbService.getStats();
console.log(
  `[KB] ✅ Knowledge Base ready: ${stats.categories} categories, ${stats.entries} entries`
);

// ── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       🎓 College Chatbot                        ║');
  console.log('║       📚 JSON Knowledge Base Mode               ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  🚀 Server running on port: ${PORT.toString().padEnd(20)}║`);
  console.log(`║  📁 Environment: ${(process.env.NODE_ENV || 'development').padEnd(24)}║`);
  console.log('║  💾 Database: SQLite (users.db) + JSON KB       ║');
  console.log('║  🔐 Authentication: Enabled (JWT)               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  
  if (isEphemeral) {
    console.warn('\n╔═════════════════════ WARNING ═════════════════════╗');
    console.warn('║ ⚠️ Ephemeral filesystem detected (Render web).     ║');
    console.warn('║    The users SQLite database is saved on a disk    ║');
    console.warn('║    that resets on restarts/deploys.              ║');
    console.warn('║    To retain data, configure a Persistent Disk.  ║');
    console.warn('╚═══════════════════════════════════════════════════╝\n');
  } else {
    console.log('[Database] Storage is persistent (local dev / persistent disk).\n');
  }
});