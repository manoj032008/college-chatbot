'use strict';

/**
 * fuzzySearch.js
 * ──────────────────────────────────────────────────────
 * Lightweight fuzzy string matching utilities for the
 * JSON Knowledge Base search engine.
 *
 * Algorithms:
 *  • Levenshtein distance  — character-level edit distance
 *  • Jaro-Winkler          — handles typos & transpositions
 *  • Token-based overlap   — word-set intersection scoring
 */

// ── Levenshtein distance ──────────────────────────────────────────────────────
function levenshtein(a, b) {
  const la = a.length;
  const lb = b.length;
  const dp = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[la][lb];
}

// ── Jaro similarity ───────────────────────────────────────────────────────────
function jaro(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end   = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

// ── Jaro-Winkler similarity ───────────────────────────────────────────────────
function jaroWinkler(s1, s2, p = 0.1) {
  const j = jaro(s1, s2);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return j + prefix * p * (1 - j);
}

// ── Token overlap score ───────────────────────────────────────────────────────
function tokenOverlap(query, target) {
  const qTokens = new Set(query.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  const tTokens = new Set(target.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  let overlap = 0;
  for (const t of qTokens) {
    if (tTokens.has(t)) overlap++;
  }
  return qTokens.size > 0 ? overlap / qTokens.size : 0;
}

// ── Main fuzzy match ──────────────────────────────────────────────────────────
/**
 * Returns a similarity score [0..1] between query and target string.
 * Combines Jaro-Winkler + token overlap for robust matching.
 */
function fuzzyScore(query, target) {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (!q || !t) return 0;

  // Exact match
  if (q === t) return 1.0;
  // Containment
  if (t.includes(q) || q.includes(t)) return 0.9;

  const jw    = jaroWinkler(q, t);
  const token = tokenOverlap(q, t);

  // Weighted combination
  return jw * 0.6 + token * 0.4;
}

/**
 * Returns true if query fuzzy-matches target above the given threshold.
 */
function isFuzzyMatch(query, target, threshold = 0.55) {
  return fuzzyScore(query, target) >= threshold;
}

/**
 * Given an array of strings, returns those that fuzzy-match the query,
 * sorted by score descending.
 * @param {string}   query     — the user query
 * @param {string[]} targets   — array of candidate strings
 * @param {number}   threshold — minimum score [0..1] to include
 * @returns {{ target: string, score: number }[]}
 */
function fuzzyFilter(query, targets, threshold = 0.55) {
  if (!query || !Array.isArray(targets)) return [];
  return targets
    .map(target => ({ target, score: fuzzyScore(query, target) }))
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

function normalizeForExactMatch(q) {
  if (!q) return '';
  let normalized = q.toLowerCase();

  // Remove unnecessary punctuation (replace with space to keep words separate)
  normalized = normalized.replace(/[''"?!.,;:()[\]{}_-]/g, ' ');

  // Normalize variations like "who is", "who's", "whos", etc.
  normalized = normalized.replace(/\bwho's\b/g, 'who is');
  normalized = normalized.replace(/\bwhos\b/g, 'who is');
  normalized = normalized.replace(/\bwhat's\b/g, 'what is');
  normalized = normalized.replace(/\bwhats\b/g, 'what is');
  normalized = normalized.replace(/\bhow's\b/g, 'how is');
  normalized = normalized.replace(/\bhows\b/g, 'how is');

  const words = normalized.split(/\s+/);

  const fillerWords = new Set([
    'the', 'of', 'a', 'an', 'department', 'dept', 'branch', 'engineering', 'college', 'is', 'are', 'was', 'were',
    'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'and', 'or', 'any', 'some', 'please', 'know',
    'tell', 'give', 'show', 'me', 'info', 'information', 'details'
  ]);

  // Mini spelling mapping specifically for normalization
  const miniSpelling = {
    'principle': 'principal',
    'princple': 'principal',
    'principl': 'principal',
    'princpal': 'principal',
    'addmission': 'admission',
    'admision': 'admission',
    'fees': 'fee',
    'fess': 'fee',
    'exams': 'exam',
    'collage': 'college',
    'govt': 'government',
    'scolarship': 'scholarship',
    'timing': 'timings',
    'timngs': 'timings',
    'time': 'timings'
  };

  const mappedWords = words.map(w => {
    let word = w;
    if (miniSpelling[word]) {
      word = miniSpelling[word];
    }

    // Mappings and abbreviations
    if (word === 'eee' || word === 'electrical' || word === 'ee') return 'eee';
    if (word === 'ece' || word === 'electronics' || word === 'ec' || word === 'dece') return 'ece';
    if (word === 'cse' || word === 'cs' || w === 'cme' || w === 'dcme') return 'cse';
    if (word === 'civil' || word === 'ce') return 'civil';
    if (word === 'mechanical' || word === 'mech' || word === 'me') return 'mech';
    if (word === 'hod' || word === 'head') return 'hod';
    if (word === 'principal' || word === 'gurumurthy') return 'principal';

    // Singular/plural and normalization
    if (word === 'timings' || word === 'timing' || word === 'time') return 'timings';
    if (word === 'fees' || word === 'fee') return 'fees';
    if (word === 'admissions' || word === 'admission') return 'admission';
    if (word === 'hostels' || word === 'hostel') return 'hostel';
    if (word === 'scholarships' || word === 'scholarship') return 'scholarship';
    if (word === 'placements' || word === 'placement') return 'placement';
    if (word === 'facilities' || word === 'facility') return 'facility';
    if (word === 'laboratories' || word === 'labs' || word === 'lab') return 'lab';
    if (word === 'departments' || word === 'branches' || word === 'courses') return 'courses';

    return word;
  }).filter(w => w.length > 0 && !fillerWords.has(w));

  return mappedWords.join(' ');
}

module.exports = { fuzzyScore, isFuzzyMatch, fuzzyFilter, levenshtein, jaroWinkler, tokenOverlap, normalizeForExactMatch };
