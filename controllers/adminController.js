'use strict';

const jsonSearchService = require('../services/jsonSearchService');
const response          = require('../utils/response');

// ── Reload all JSON files from disk ──────────────────────────────────────────
const reloadData = (req, res, next) => {
  try {
    const result = jsonSearchService.reload();
    return res.json(result);
  } catch (err) { next(err); }
};

// ── KB stats ──────────────────────────────────────────────────────────────────
const getStats = (req, res, next) => {
  try {
    const stats = jsonSearchService.getStats();
    return res.json(stats);
  } catch (err) { next(err); }
};

// ── Get all categories ─────────────────────────────────────────────────────────
const getCategories = (req, res, next) => {
  try {
    const cats = jsonSearchService.getAllCategories();
    return res.json({ categories: cats });
  } catch (err) { next(err); }
};

// ── Get data for a specific category ──────────────────────────────────────────
const getCategory = (req, res, next) => {
  try {
    const { category } = req.params;
    const data = jsonSearchService.getCategoryData(category);
    if (!data) return response.error(res, 'Category not found', 404);
    return res.json(data);
  } catch (err) { next(err); }
};

// ── Search across all categories ───────────────────────────────────────────────
const searchData = (req, res, next) => {
  try {
    const { query, top } = req.query;
    if (!query) return response.error(res, 'Query parameter is required', 400);

    if (top) {
      const topN    = parseInt(top) || 3;
      const results = jsonSearchService.searchMultiple(query, topN);
      return res.json({ results, count: results.length });
    }

    const result = jsonSearchService.search(query);
    return res.json({ match: result, found: !!result });
  } catch (err) { next(err); }
};

// ── Add a new entry to a category ─────────────────────────────────────────────
const addEntry = (req, res, next) => {
  try {
    const { category } = req.params;
    const data         = req.body;
    if (!data || Object.keys(data).length === 0) {
      return response.error(res, 'Request body cannot be empty', 400);
    }
    const result = jsonSearchService.addEntry(category, data);
    return res.json({ message: 'Entry added successfully', data: result });
  } catch (err) { next(err); }
};

// ── Edit an existing entry ─────────────────────────────────────────────────────
const editEntry = (req, res, next) => {
  try {
    const { category, id } = req.params;
    const data             = req.body;
    const result           = jsonSearchService.editEntry(category, id, data);
    if (!result) return response.error(res, 'Entry not found', 404);
    return res.json({ message: 'Entry updated successfully', data: result });
  } catch (err) { next(err); }
};

// ── Delete an entry ────────────────────────────────────────────────────────────
const deleteEntry = (req, res, next) => {
  try {
    const { category, id } = req.params;
    const success          = jsonSearchService.deleteEntry(category, id);
    if (!success) return response.error(res, 'Entry not found', 404);
    return res.json({ message: 'Entry deleted successfully' });
  } catch (err) { next(err); }
};

// ── Admin KB CRUD for frontend compatibility ───────────────────────────────────
const addKbArticle = (req, res, next) => {
  try {
    const { category, title, content } = req.body;
    if (!category || !title) {
      return response.error(res, 'Category and Title are required', 400);
    }
    const cat = category.toLowerCase().trim();
    const newEntry = {
      title,
      category: cat,
      keywords: title.split(/\s+/).filter(w => w.length > 2),
      content,
    };
    const result = jsonSearchService.addEntry(cat, newEntry);
    return res.json({ message: 'Article saved successfully', data: result });
  } catch (err) { next(err); }
};

const editKbArticle = (req, res, next) => {
  try {
    const { id } = req.params;
    const { category, title, content } = req.body;
    const result = jsonSearchService.editEntryGlobal(id, { category, title, content });
    if (!result) return response.error(res, 'Article not found', 404);
    return res.json({ message: 'Article updated successfully', data: result });
  } catch (err) { next(err); }
};

const deleteKbArticle = (req, res, next) => {
  try {
    const { id } = req.params;
    const success = jsonSearchService.deleteEntryGlobal(id);
    if (!success) return response.error(res, 'Article not found', 404);
    return res.json({ message: 'Article deleted successfully' });
  } catch (err) { next(err); }
};

module.exports = {
  reloadData, getStats, getCategories, getCategory,
  searchData, addEntry, editEntry, deleteEntry,
  addKbArticle, editKbArticle, deleteKbArticle,
};
