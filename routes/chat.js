const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/authMiddleware');

const {
  sendMessage,
  getSessions,
  getMessages,
  deleteSessions,
} = require('../controllers/chatController');

// ── Chatbot Routes ──────────────────────────────────────────────────────────
router.use(authMiddleware);

router.post('/send',                  sendMessage);
router.get('/sessions',               getSessions);
router.get('/messages/:sessionId',    getMessages);
router.delete('/sessions',            deleteSessions);

module.exports = router;
