const express = require('express');
const router  = express.Router();

const {
  sendMessage,
  getSessions,
  getMessages,
  deleteSessions,
} = require('../controllers/chatController');

// ── Chatbot Routes ──────────────────────────────────────────────────────────
// Stateless public chatbot — no auth required

router.post('/send',                  sendMessage);
router.get('/sessions',               getSessions);
router.get('/messages/:sessionId',    getMessages);
router.delete('/sessions',            deleteSessions);

module.exports = router;
