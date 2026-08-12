const express = require('express');
const router  = express.Router();

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
// In production, add an auth middleware before all routes below.

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
