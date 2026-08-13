const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/authMiddleware');

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
  }
};

const {
  reloadData,
  getCategories,
  getCategory,
  searchData,
  addEntry,
  editEntry,
  deleteEntry,
  getStats,
  addKbArticle,
  editKbArticle,
  deleteKbArticle,
} = require('../controllers/adminController');

// ── Admin / Knowledge Base Management Routes ────────────────────────────────
router.use(authMiddleware);
router.use(adminOnly);

router.get('/data/reload',                      reloadData);
router.get('/data/stats',                       getStats);
router.get('/data/categories',                  getCategories);
router.get('/data/categories/:category',        getCategory);
router.get('/data/search',                      searchData);

router.post('/data/categories/:category',       addEntry);
router.put('/data/categories/:category/:id',    editEntry);
router.delete('/data/categories/:category/:id', deleteEntry);

// Frontend Article Manager Endpoints
router.post('/kb',                              addKbArticle);
router.put('/kb/:id',                           editKbArticle);
router.delete('/kb/:id',                        deleteKbArticle);

module.exports = router;
