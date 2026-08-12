'use strict';

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const morgan        = require('morgan');
const path          = require('path');
const errorHandler  = require('./middleware/errorHandler');

// ── Route Imports ──────────────────────────────────────────────────────────────
const chatRoutes  = require('./routes/chat');
const adminRoutes = require('./routes/admin');

const app = express();

// ── Security & Parsing Middleware ───────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigins = [
  'https://gptproddaturclgchatbot.netlify.app'
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));


// ── Static Frontend ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────────
app.use('/api/chat',  chatRoutes);
app.use('/api/admin', adminRoutes);

// Direct mapping for requested endpoints
const { sendMessage } = require('./controllers/chatController');
app.post('/api/chat', sendMessage);

app.get('/api/knowledge', (req, res) => {
  try {
    const kbService = require('./services/jsonSearchService');
    return res.json(kbService.getAllArticles());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const kbService = require('./services/jsonSearchService');
    return res.json(kbService.getStats());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Settings & KB Endpoints ──────────────────────────────────────────────────────
app.post('/api/settings',       (req, res) => res.json({ message: 'Settings saved' }));
app.get('/api/kb/articles',     (req, res) => {
  try {
    const kbService = require('./services/jsonSearchService');
    const articles = kbService.getAllArticles();
    return res.json(articles);
  } catch (e) {
    return res.json([]);
  }
});

// ── Admin Stats Endpoint ─────────────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  try {
    const kbService = require('./services/jsonSearchService');
    const stats     = kbService.getStats();
    return res.json({
      kbArticlesCount:  stats.entries,
      kbCategories:     stats.categories,
    });
  } catch (e) {
    return res.json({ kbArticlesCount: 0, kbCategories: 0 });
  }
});

app.get('/api/admin/conversations', (req, res) => res.json([]));

// ── Health Check ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    const kbService = require('./services/jsonSearchService');
    const stats     = kbService.getStats();
    res.json({
      status:        'online',
      mode:          'JSON Knowledge Base',
      kb_entries:    stats.entries,
      kb_categories: stats.categories,
      timestamp:     new Date().toISOString(),
      environment:   process.env.NODE_ENV || 'development',
    });
  } catch (e) {
    res.json({ status: 'online', mode: 'JSON Knowledge Base', timestamp: new Date().toISOString() });
  }
});

// ── SPA Fallback ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Global Error Handler ─────────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
