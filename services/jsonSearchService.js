'use strict';

/**
 * jsonSearchService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Intelligent Knowledge Base Engine for GPT Proddatur College Chatbot.
 *
 * Architecture:
 *   1. On startup/reload, scan every .json file in /data and /knowledge (if exists)
 *   2. Validate and automatically repair JSON schemas
 *   3. Normalize each file's data array into a flat list of searchable entries
 *   4. Index questions in memory and track categories, entries, and statistics
 *   5. Support hot-reloading cache via directory watching
 *   6. On query: spelling-correct → normalize → keyword → synonym-expand → score every entry → return top N
 *   7. Support conversation-history context for follow-up questions
 */

const fs   = require('fs');
const path = require('path');
const { fuzzyScore, isFuzzyMatch, normalizeForExactMatch } = require('../utils/fuzzySearch');
const { extractQAPairs }           = require('../utils/responseFormatter');

// ─────────────────────────────────────────────────────────────────────────────
// SPELLING CORRECTION MAP
// Common misspellings → corrected form. Applied BEFORE synonym expansion.
// Keys must be lowercase. Values must be the correct lowercase form.
// ─────────────────────────────────────────────────────────────────────────────
const SPELLING_CORRECTIONS = {
  // Principal / Principle — most important correction for this chatbot
  'principle':        'principal',
  'princple':         'principal',
  'principl':         'principal',
  'principla':        'principal',
  'princpal':         'principal',
  'pricipal':         'principal',
  'prinicpal':        'principal',
  'principlal':       'principal',

  // Admission
  'addmission':       'admission',
  'admision':         'admission',
  'admissions':       'admission',

  // Fee
  'fees':             'fee',
  'fess':             'fee',

  // Examination
  'exams':            'exam',
  'examinations':     'exam',
  'examination':      'exam',

  // Faculty
  'facalty':          'faculty',
  'facuty':           'faculty',

  // College
  'collage':          'college',
  'colleg':           'college',

  // Government
  'goverment':        'government',
  'govrnment':        'government',
  'govt':             'government',

  // Scholarship
  'scolarship':       'scholarship',
  'scholrship':       'scholarship',

  // Placement
  'placment':         'placement',

  // Contact
  'contect':          'contact',
  'contack':          'contact',

  // Timing
  'timeing':          'timing',
  'timngs':           'timings',
  'timins':           'timings',

  // Result
  'resullt':          'result',
  'reslt':            'result',

  // Certificate
  'certifcate':       'certificate',
  'certifiate':       'certificate',

  // Department
  'departmnt':        'department',
  'deparment':        'department',

  // Mechanical
  'mechnical':        'mechanical',
  'mechancial':       'mechanical',

  // Electrical
  'electical':        'electrical',
  'electricl':        'electrical',

  // Electronics
  'electroncis':      'electronics',
  'electronis':       'electronics',

  // Computer
  'compter':          'computer',
  'computr':          'computer',

  // Library
  'libary':           'library',
  'librry':           'library',

  // Hostel
  'hostle':           'hostel',
  'hostal':           'hostel',

  // Canteen
  'canten':           'canteen',

  // Sports
  'sprots':           'sports',

  // Transport
  'transprt':         'transport',
  'tranport':         'transport',

  // Academic
  'acadmic':          'academic',

  // Vision
  'vison':            'vision',

  // Mission
  'mision':           'mission',
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNONYM / ALIAS MAP
// Maps canonical terms → list of user variations (and vice-versa during expand)
// ─────────────────────────────────────────────────────────────────────────────
const SYNONYM_MAP = {
  // Departments / branches
  civil:          ['civil engineering', 'ce', 'civil dept', 'civil department'],
  mechanical:     ['mechanical engineering', 'me', 'mech', 'mech dept'],
  electrical:     ['electrical engineering', 'eee', 'ee', 'electrical dept', 'electrical electronics'],
  electronics:    ['ece', 'electronics communication', 'ec', 'electronics dept'],
  computer:       ['cse', 'cs', 'computer engineering', 'computer science', 'comp', 'cme', 'dcme'],
  branches:       ['departments', 'courses', 'diploma', 'programs', 'engineering', 'streams', 'sections'],

  // People
  // IMPORTANT: 'hod' and 'head' are NOT aliased to 'principal'.
  // They are separate intents handled by _detectIntent().
  // 'principle' is handled by SPELLING_CORRECTIONS (→ principal) before this runs.
  principal:      ['gurumurthy', 'gurumurthy reddy', 'p gurumurthy',
                   'principal name', 'name of principal', 'college principal',
                   'principal of college', 'principal of the college', "principal's message",
                   'principal message', 'head of institution', 'head of college',
                   'institution head', 'college head'],
  faculty:        ['teachers', 'lecturers', 'professors', 'staff', 'lecturer', 'instructor'],
  alumni:         ['old students', 'alumni committee', 'ex-students', 'alumnus', 'alumini', 'alumuni'],

  // Academic
  fee:            ['fees', 'fee structure', 'tuition', 'charges', 'cost', 'payment', 'amount'],
  admission:      ['admissions', 'enroll', 'joining', 'registration', 'apply', 'polycet', 'entrance'],
  exam:           ['examinations', 'examination', 'test', 'assessment', 'semester', 'end term', 'midterm', 'marks', 'result'],
  syllabus:       ['curriculum', 'subjects', 'topics', 'course content', 'sem subjects'],
  scholarship:    ['scholarships', 'financial aid', 'stipend', 'merit', 'grant', 'sc st', 'bc scholarship'],
  placement:      ['placements', 'campus placement', 'hiring', 'internship', 'job', 'jobs', 'career', 'employment', 'recruitment', 'companies'],
  result:         ['results', 'marks', 'grades', 'score', 'performance'],

  // College info
  about:          ['college info', 'institution', 'polytechnic', 'gpt proddatur', 'government polytechnic', 'college history', 'established'],
  vision:         ['vision statement', 'college vision', 'department vision'],
  mission:        ['mission statement', 'college mission', 'department mission'],
  aims:           ['objectives', 'goals', 'purpose', 'aim', 'targets'],
  goals:          ['strategic goals', 'college goals', 'institutional goals', 'objectives'],
  achievements:   ['hallmarks', 'hallmarks and achievements', 'hallmarks and achivements', 'achivements', 'accomplishments', 'awards', 'recognition', 'notable', 'college achievements', 'institutional achievements'],
  hallmarks:      ['hallmarks and achievements', 'hallmarks and achivements', 'achievements', 'achivements', 'awards', 'accomplishments', 'recognition', 'milestones'],
  notifications:  ['notice', 'announcement', 'circular', 'update', 'news'],
  committee:      ['committees', 'cell', 'council', 'board', 'body', 'team'],

  // Facilities
  hostel:         ['accommodation', 'boarding', 'residence', 'dormitory', 'rooms', 'pg'],
  library:        ['books', 'reading room', 'e-library', 'journals', 'resources', 'reading'],
  bus:            ['transport', 'travel', 'commute', 'route', 'vehicle', 'shuttle'],
  labs:           ['laboratory', 'practical', 'workshop', 'computer lab', 'lab'],
  canteen:        ['mess', 'food', 'cafeteria', 'dining', 'lunch'],
  sports:         ['games', 'athletics', 'playground', 'fitness', 'ground'],
  facility:       ['facilities', 'infrastructure', 'amenities', 'campus', 'building'],

  // Contact
  phone:          ['contact', 'contact number', 'mobile', 'telephone', 'call', 'reach', 'number'],
  address:        ['location', 'map', 'where', 'place', 'situated', 'korrapadu', 'proddatur'],
  website:        ['url', 'link', 'online', 'web', 'portal'],

  // Time
  timings:        ['office hours', 'working hours', 'schedule', 'hours', 'time', 'timing',
                   'college-timings', 'college timings', 'college time', 'working time',
                   'college hours', 'college schedule', 'when does college start', 'college start',
                   'college open', 'college close', 'start time', 'end time', 'open time',
                   'close time', 'college working time', 'college working hours'],
  holiday:        ['holidays', 'vacation', 'leave', 'break', 'calendar'],
  notification:   ['notifications', 'notice', 'announcement', 'circular', 'update'],
  faq:            ['faqs', 'frequently asked', 'common questions', 'questions'],
};

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY DETECTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function detectQueryEntities(query) {
  const q = query.toLowerCase();
  const entities = {
    dept: null,
    topic: null
  };

  if (/\b(eee|electrical|ee)\b/i.test(q)) entities.dept = 'eee';
  else if (/\b(ece|electronics|ec|dece)\b/i.test(q)) entities.dept = 'ece';
  else if (/\b(cse|computer|cme|dcme)\b/i.test(q)) entities.dept = 'cse';
  else if (/\bcivil\b/i.test(q)) entities.dept = 'civil';
  else if (/\b(mechanical|mech)\b/i.test(q)) entities.dept = 'mech';

  const topics = ['hod', 'principal', 'fees', 'admission', 'courses', 'hostel', 'scholarship', 'placements', 'timings', 'contact', 'facilities', 'laboratories', 'departments'];
  for (const t of topics) {
    if (new RegExp('\\b' + t + '\\b', 'i').test(q)) {
      entities.topic = t;
      break;
    }
  }

  return entities;
}

function getEntryEntities(entry) {
  const file = (entry.source_file || '').toLowerCase();
  const cat = (entry.source_category || '').toLowerCase();
  const title = (entry._title_lower || '').toLowerCase();

  let dept = null;
  if (file.includes('eee') || cat.includes('eee')) dept = 'eee';
  else if (file.includes('ece') || cat.includes('ece')) dept = 'ece';
  else if (file.includes('computer') || cat.includes('computer') || file.includes('cse') || cat.includes('cse')) dept = 'cse';
  else if (file.includes('civil') || cat.includes('civil')) dept = 'civil';
  else if (file.includes('mechanical') || cat.includes('mechanical')) dept = 'mech';

  let topic = null;
  const topics = ['hod', 'principal', 'fees', 'admission', 'courses', 'hostel', 'scholarship', 'placements', 'timings', 'contact', 'facilities', 'laboratories', 'departments'];
  for (const t of topics) {
    if (file.includes(t) || cat.includes(t) || title.includes(t)) {
      topic = t;
      break;
    }
  }

  return { dept, topic };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION — maps user queries to specific, high-precision intents
// so we can boost the correct KB entry overwhelmingly above others.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detected intent shape:
 *   { type: string, department?: string, maxResults: number }
 *
 * type values:
 *   'principal'          → who is the principal
 *   'hod_ece'            → who is HOD of ECE
 *   'hod_cse'            → who is HOD of CSE/Computer Engineering
 *   'hod_civil'          → who is HOD of Civil
 *   'hod_mech'           → who is HOD of Mechanical
 *   'hod_eee'            → who is HOD of Electrical
 *   'hod_general'        → who is HOD (no dept specified)
 *   'timings'            → college timings
 *   'courses'            → available branches/courses
 *   'fees'               → fee structure
 *   'admission'          → admission process
 *   'contact'            → contact information
 *   'faculty_ece'        → faculty of ECE dept
 *   'faculty_cse'        → faculty of CSE dept
 *   'ece_dept'           → ECE department general info
 *   'cse_dept'           → CSE department general info
 *   'civil_dept'         → Civil dept
 *   'mech_dept'          → Mechanical dept
 *   'eee_dept'           → Electrical dept
 *   null                 → no specific intent detected
 */
function detectIntent(normalizedQuery) {
  const q = normalizedQuery;

  // ── HOD / Head of Department patterns ─────────────────────────────────────
  // These MUST come before department-only patterns
  const hodPatterns = [
    { pattern: /\b(hod|head|in-?charge|incharge)\b.*(ece|electronics|communication)/i,       intent: 'hod_ece',    max: 1 },
    { pattern: /\b(ece|electronics|communication).*(hod|head|in-?charge|incharge)\b/i,       intent: 'hod_ece',    max: 1 },
    { pattern: /\bwho\b.*(head|leads|runs|hod).*(ece|electronics)/i,                         intent: 'hod_ece',    max: 1 },
    { pattern: /\b(hod|head|in-?charge|incharge)\b.*(cse|computer|cme)/i,                   intent: 'hod_cse',    max: 1 },
    { pattern: /\b(cse|computer|cme).*(hod|head|in-?charge|incharge)\b/i,                   intent: 'hod_cse',    max: 1 },
    { pattern: /\bwho\b.*(head|leads|runs|hod).*(cse|computer)/i,                            intent: 'hod_cse',    max: 1 },
    { pattern: /\b(hod|head|in-?charge|incharge)\b.*(civil)/i,                              intent: 'hod_civil',  max: 1 },
    { pattern: /\bcivil.*(hod|head|in-?charge|incharge)\b/i,                                intent: 'hod_civil',  max: 1 },
    { pattern: /\b(hod|head|in-?charge|incharge)\b.*(mechanical|mech)/i,                    intent: 'hod_mech',   max: 1 },
    { pattern: /\b(mechanical|mech).*(hod|head|in-?charge|incharge)\b/i,                    intent: 'hod_mech',   max: 1 },
    { pattern: /\b(hod|head|in-?charge|incharge)\b.*(electrical|eee)/i,                     intent: 'hod_eee',    max: 1 },
    { pattern: /\b(electrical|eee).*(hod|head|in-?charge|incharge)\b/i,                     intent: 'hod_eee',    max: 1 },
    { pattern: /\b(hod|head of department|department head)\b/i,                              intent: 'hod_general',max: 2 },
  ];
  for (const { pattern, intent, max } of hodPatterns) {
    if (pattern.test(q)) {
      return { type: intent, maxResults: max };
    }
  }

  // ── Principal ─────────────────────────────────────────────────────────────
  if (/\b(principal|gurumurthy|head of institution|head of college)\b/i.test(q)) {
    return { type: 'principal', maxResults: 1 };
  }

  // ── College Timings ───────────────────────────────────────────────────────
  if (/\b(timing|timings|working hours|office hours|college time|schedule|when.*start|when.*end|when.*open|when.*close)\b/i.test(q)) {
    return { type: 'timings', maxResults: 1 };
  }

  // ── Courses / Branches ────────────────────────────────────────────────────
  if (/\b(courses|branches|departments|programs|streams|what.*available|available.*branch|available.*course|how many.*branch)\b/i.test(q)) {
    return { type: 'courses', maxResults: 2 };
  }

  // ── Fees ─────────────────────────────────────────────────────────────────
  if (/\b(fee|fees|fee structure|tuition|charges|cost|payment|how much)\b/i.test(q)) {
    return { type: 'fees', maxResults: 2 };
  }

  // ── Admission ─────────────────────────────────────────────────────────────
  if (/\b(admission|admissions|polycet|how to join|how to apply|enroll|lateral entry|direct entry)\b/i.test(q)) {
    return { type: 'admission', maxResults: 2 };
  }

  // ── Contact ───────────────────────────────────────────────────────────────
  if (/\b(contact|phone|mobile|email|address|location|where is|how to reach|website|korrapadu)\b/i.test(q)) {
    return { type: 'contact', maxResults: 1 };
  }

  // ── Faculty (department-specific) ─────────────────────────────────────────
  if (/\bfaculty\b.*(ece|electronics)/i.test(q) || /(ece|electronics).*\bfaculty\b/i.test(q)) {
    return { type: 'faculty_ece', maxResults: 1 };
  }
  if (/\bfaculty\b.*(cse|computer|cme)/i.test(q) || /(cse|computer|cme).*\bfaculty\b/i.test(q)) {
    return { type: 'faculty_cse', maxResults: 1 };
  }

  // ── Department-specific info ──────────────────────────────────────────────
  if (/\b(ece|electronics.*(communication)?|dece)\b/i.test(q)) {
    return { type: 'ece_dept', maxResults: 2 };
  }
  if (/\b(cse|computer engineering|cme|dcme)\b/i.test(q)) {
    return { type: 'cse_dept', maxResults: 2 };
  }
  if (/\bcivil\b/i.test(q)) {
    return { type: 'civil_dept', maxResults: 2 };
  }
  if (/\b(mechanical|mech)\b/i.test(q)) {
    return { type: 'mech_dept', maxResults: 2 };
  }
  if (/\b(electrical|eee)\b/i.test(q)) {
    return { type: 'eee_dept', maxResults: 2 };
  }

  return { type: null, maxResults: null };
}

/**
 * Given a detected intent, return a score boost for entries that match it.
 * Returns a non-negative number to ADD to the entry's score.
 */
function intentBoostForEntry(entry, intent) {
  if (!intent || !intent.type) return 0;

  const cat     = (entry.source_category || '').toLowerCase();
  const file    = (entry.source_file || '').toLowerCase();

  // Helper: is this from others.json (broad mixed-topic file)?
  const isOthers = file.includes('others');

  // Helper: is this a principal-file entry?
  const isPrincipal = file.includes('principal') || cat.includes('principal');

  // Helper: which dept does this entry belong to?
  const isEEE   = cat.includes('eee') || file.includes('eee');
  const isECE   = cat.includes('ece') || file.includes('ece');
  const isCSE   = cat.includes('computer') || file.includes('computer');
  const isCivil = cat.includes('civil') || file.includes('civil');
  const isMech  = cat.includes('mechanical') || file.includes('mechanical');

  switch (intent.type) {
    case 'hod_eee':
      if (isEEE) return 80;                        // strong boost for correct dept
      if (isPrincipal) return -100;                // hard block principal
      if (isOthers) return -50;                    // suppress cross-topic entries
      if (isECE || isCSE || isCivil || isMech) return -50;  // wrong dept penalty
      return 0;

    case 'hod_ece':
      if (isECE) return 80;
      if (isPrincipal) return -100;
      if (isOthers) return -50;
      if (isEEE || isCSE || isCivil || isMech) return -50;
      return 0;

    case 'hod_cse':
      if (isCSE) return 80;
      if (isPrincipal) return -100;
      if (isOthers) return -50;
      if (isEEE || isECE || isCivil || isMech) return -50;
      return 0;

    case 'hod_civil':
      if (isCivil) return 80;
      if (isPrincipal) return -100;
      if (isOthers) return -50;
      if (isEEE || isECE || isCSE || isMech) return -50;
      return 0;

    case 'hod_mech':
      if (isMech) return 80;
      if (isPrincipal) return -100;
      if (isOthers) return -50;
      if (isEEE || isECE || isCSE || isCivil) return -50;
      return 0;

    case 'hod_general':
      // Generic HOD — boost all dept files, suppress principal
      if (isPrincipal) return -40;
      if (isEEE || isECE || isCSE || isCivil || isMech) return 30;
      return 0;

    case 'principal':
      if (isPrincipal) return 80;
      // Strongly penalize department files for a principal-specific query
      if (isECE || isCSE || isCivil || isMech || isEEE) return -50;
      if (isOthers) return -20;
      return 0;

    case 'timings':
      if (cat.includes('college-timings') || cat.includes('timings') || file.includes('timings')) return 80;
      if (isOthers) return -30;
      return 0;

    case 'courses':
    case 'admission':
      if (cat.includes('admission') || file.includes('admission')) return 60;
      if (isOthers) return 20;
      return 0;

    case 'fees':
      if (cat.includes('fee') || file.includes('fee')) return 80;
      if (isOthers) return -30;
      return 0;

    case 'contact':
      if (cat.includes('contact') || file.includes('contact')) return 80;
      if (isOthers) return -30;
      return 0;

    case 'faculty_ece':
    case 'ece_dept':
      if (isECE) return 60;
      if (isPrincipal) return -60;
      if (isOthers) return -30;
      if (isEEE || isCSE || isCivil || isMech) return -30;
      return 0;

    case 'faculty_cse':
    case 'cse_dept':
      if (isCSE) return 60;
      if (isPrincipal) return -60;
      if (isOthers) return -30;
      if (isEEE || isECE || isCivil || isMech) return -30;
      return 0;

    case 'civil_dept':
      if (isCivil) return 60;
      if (isPrincipal) return -40;
      if (isOthers) return -20;
      if (isEEE || isECE || isCSE || isMech) return -30;
      return 0;

    case 'mech_dept':
      if (isMech) return 60;
      if (isPrincipal) return -40;
      if (isOthers) return -20;
      if (isEEE || isECE || isCSE || isCivil) return -30;
      return 0;

    case 'eee_dept':
      if (isEEE) return 60;
      if (isPrincipal) return -40;
      if (isOthers) return -20;
      if (isECE || isCSE || isCivil || isMech) return -30;
      return 0;

    default:
      return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP WORDS — filtered before scoring
// ─────────────────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'from', 'up', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'than', 'too', 'very', 'just', 'because', 'as', 'until',
  'while', 'both', 'if', 'then', 'that', 'this', 'these', 'those',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'me',
  'tell', 'give', 'show', 'i', 'my', 'we', 'our', 'you', 'your', 'it',
  'its', 'any', 'all', 'also', 'not', 'and', 'or', 'but', 'so', 'get',
  'info', 'information', 'details', 'please', 'want', 'know', 'need',
  'like', 'going', 'let', 'there', 'here', 'yes', 'no', 'ok', 'okay',
]);

// ─────────────────────────────────────────────────────────────────────────────
// STORED-QUESTION NORMALIZATION
// Used to compare stored KB questions against user's normalized query fairly.
// Strips stop words, expands abbreviations so "Who is the HOD of EEE?"
// normalizes to the same tokens as the user's "who is hod of eee".
// ─────────────────────────────────────────────────────────────────────────────

const _NORM_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'from', 'up', 'into', 'through', 'and', 'or',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'tell', 'give', 'show', 'me', 'please', 'info', 'information', 'details',
]);

const _NORM_ABBREV = {
  'eee': 'eee', 'electrical': 'eee', 'ee': 'eee',
  'ece': 'ece', 'electronics': 'ece', 'ec': 'ece', 'dece': 'ece',
  'cse': 'cse', 'computer': 'cse', 'cme': 'cse', 'dcme': 'cse',
  'civil': 'civil', 'ce': 'civil',
  'mechanical': 'mech', 'mech': 'mech', 'me': 'mech',
  'hod': 'hod', 'head': 'hod', 'incharge': 'hod',
  'principal': 'principal', 'gurumurthy': 'principal',
  'fees': 'fee', 'fee': 'fee', 'tuition': 'fee',
  'admission': 'admission', 'admissions': 'admission',
  'timings': 'timings', 'timing': 'timings', 'time': 'timings',
  'hostel': 'hostel', 'hostels': 'hostel',
  'department': 'dept', 'departments': 'dept', 'dept': 'dept',
  'branch': 'branch', 'branches': 'branch',
};

function _normalizeStoredQuestion(q) {
  if (!q) return '';
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => _NORM_ABBREV[w] || w)
    .filter(w => w.length > 1 && !_NORM_STOPWORDS.has(w))
    .join(' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING WEIGHTS
// ─────────────────────────────────────────────────────────────────────────────
const SCORE = {
  EXACT_TITLE:              30,
  PARTIAL_TITLE:            18,
  FUZZY_TITLE:              12,
  TITLE_KW_HIT:              8,
  EXACT_KEYWORD:            15,
  PARTIAL_KEYWORD:           9,
  FUZZY_KEYWORD:             5,
  CATEGORY_MATCH:           12,
  CATEGORY_PARTIAL:          7,
  // ── QA matching — these MUST dominate to ensure exact-question entries win ──
  QA_QUESTION_EXACT:       100,  // was 20 — now overwhelmingly dominant
  QA_QUESTION_NEAR_EXACT:   70,  // normalized-match (stopwords stripped)
  QA_QUESTION_FUZZY:        35,  // was 10
  QA_TEXT_HIT:              15,  // was 6
  CONTENT_HIT:               4,
  SYNONYM_BONUS:             3,
  SPELLING_CORRECTED:        5,
};

// Minimum score to include in results
const MIN_SCORE = 4;

class JsonSearchService {
  constructor() {
    this.dataDir       = path.join(__dirname, '../data');
    this.knowledgeDir  = path.join(__dirname, '../knowledge');

    /** Raw normalized entries — array of entry objects */
    this.entries       = [];
    /** Category → [entries] index */
    this.byCategory    = {};

    // Statistics and Audit Log
    this.filesLoaded   = 0;
    this.filesSkipped  = 0;
    this.ignoredFiles  = [];
    this.validationErrors = [];
    this.indexedQuestionsCount = 0;

    this.watcher = null;

    /**
     * exactMatchIndex: Map<normalizedQuestion → entry>
     * Built at load time. Enables O(1) exact-match lookup.
     */
    this.exactMatchIndex = new Map();

    // Perform initial boot scan
    this.loadAllData();
    this.setupWatcher();
  }

  // ── DATA LOADING ────────────────────────────────────────────────────────────

  /**
   * Scan /data and /knowledge, read every .json file, normalize entries, build index.
   */
  loadAllData() {
    this.entries          = [];
    this.byCategory       = {};
    this.exactMatchMap    = new Map(); // legacy compat
    this.exactMatchIndex  = new Map(); // new O(1) lookup index
    this.filesLoaded      = 0;
    this.filesSkipped     = 0;
    this.ignoredFiles     = [];
    this.validationErrors = [];
    this.indexedQuestionsCount = 0;

    const directoriesToScan = [];
    if (fs.existsSync(this.dataDir)) {
      directoriesToScan.push({ path: this.dataDir, name: 'data' });
    }
    if (fs.existsSync(this.knowledgeDir)) {
      directoriesToScan.push({ path: this.knowledgeDir, name: 'knowledge' });
    }

    if (directoriesToScan.length === 0) {
      console.warn('[KB] ⚠️ No knowledge or data directory exists.');
      return;
    }

    // Collect all JSON files uniquely by name (avoid duplicate scanning if directories overlap)
    const seenFiles = new Set();
    const allFiles = [];

    for (const dirInfo of directoriesToScan) {
      try {
        const files = fs.readdirSync(dirInfo.path);
        for (const file of files) {
          if (!file.endsWith('.json')) {
            // Ignored file type
            if (file !== '.gitkeep' && !fs.statSync(path.join(dirInfo.path, file)).isDirectory()) {
              this.ignoredFiles.push({ file: path.join(dirInfo.name, file), reason: 'Non-JSON file format' });
            }
            continue;
          }
          const uniqueKey = file.toLowerCase();
          if (!seenFiles.has(uniqueKey)) {
            seenFiles.add(uniqueKey);
            allFiles.push({ filename: file, dirInfo });
          }
        }
      } catch (err) {
        console.error(`[KB] ❌ Error reading directory ${dirInfo.path}:`, err.message);
        this.validationErrors.push(`Directory read error for ${dirInfo.name}: ${err.message}`);
      }
    }

    for (const fileItem of allFiles) {
      this._loadFile(fileItem.filename, fileItem.dirInfo);
    }

    // Build category index AND exact-match index
    for (const entry of this.entries) {
      const cat = entry.source_category;
      if (!this.byCategory[cat]) this.byCategory[cat] = [];
      this.byCategory[cat].push(entry);

      // Index every QA question in this entry for O(1) exact lookup
      if (entry._qa_pairs && entry._qa_pairs.length > 0) {
        for (const qa of entry._qa_pairs) {
          if (!qa.question) continue;
          const normQ = _normalizeStoredQuestion(qa.question);
          if (normQ && normQ.length > 3) {
            // Store: normQ → { entry, answer }
            if (!this.exactMatchIndex.has(normQ)) {
              this.exactMatchIndex.set(normQ, { entry, answer: qa.answer });
            }
          }
        }
      }
    }

    // Print Detailed Startup Log
    console.log('\n====================================================');
    console.log('📖 KNOWLEDGE BASE STARTUP REPORT');
    console.log('====================================================');
    console.log(`📂 Loaded JSON Files:      ${this.filesLoaded}`);
    console.log(`🗂️ Loaded Categories:      ${Object.keys(this.byCategory).length}`);
    console.log(`📝 Knowledge Entries:      ${this.entries.length}`);
    console.log(`❓ Indexed QuestionsCount:  ${this.indexedQuestionsCount}`);
    console.log(`⚠️ Ignored Files:          ${this.ignoredFiles.length}`);
    if (this.ignoredFiles.length > 0) {
      this.ignoredFiles.forEach(f => console.log(`   - ${f.file} (${f.reason})`));
    }
    console.log(`❌ Validation Errors:      ${this.validationErrors.length}`);
    if (this.validationErrors.length > 0) {
      this.validationErrors.forEach(err => console.log(`   - ${err}`));
    }
    console.log('====================================================\n');
  }

  /**
   * Load and validate a single JSON file.
   */
  _loadFile(filename, dirInfo) {
    const filePath = path.join(dirInfo.path, filename);
    const category = path.basename(filename, '.json').toLowerCase().trim();

    const WRAPPER_KEYS = new Set([
      'department', 'section', 'committee', 'branch', 'info', 'data_info',
      'details', 'record', 'document', 'entity', 'college', 'institution',
    ]);

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      
      // Validation Check: Encoding check (check for presence of replacement character \uFFFD)
      if (raw.includes('\uFFFD')) {
        throw new Error('UTF-8 decoding / encoding mismatch (replacement char detected)');
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        this.ignoredFiles.push({ file: path.join(dirInfo.name, filename), reason: `JSON syntax error: ${parseErr.message}` });
        this.validationErrors.push(`Failed to parse JSON file "${filename}": ${parseErr.message}`);
        this.filesSkipped++;
        return;
      }

      let dataArray = [];

      if (Array.isArray(parsed)) {
        dataArray = parsed;
      } else if (typeof parsed === 'object' && parsed !== null) {
        if (Array.isArray(parsed.data)) {
          dataArray = parsed.data;
        } else if (Array.isArray(parsed.entries)) {
          dataArray = parsed.entries;
        } else if (Array.isArray(parsed.items)) {
          dataArray = parsed.items;
        } else {
          // Check wrapper keys (e.g. { "department": { ... } })
          let unwrapped = null;
          for (const wk of WRAPPER_KEYS) {
            if (parsed[wk] && typeof parsed[wk] === 'object' && !Array.isArray(parsed[wk])) {
              unwrapped = parsed[wk];
              break;
            }
          }

          // Single object wrapper check
          if (!unwrapped) {
            const rootKeys = Object.keys(parsed);
            if (rootKeys.length === 1) {
              const onlyVal = parsed[rootKeys[0]];
              if (
                onlyVal &&
                typeof onlyVal === 'object' &&
                !Array.isArray(onlyVal) &&
                (onlyVal.content || onlyVal.title || onlyVal.keywords)
              ) {
                unwrapped = onlyVal;
              }
            }
          }

          if (unwrapped) {
            dataArray = [unwrapped];
          } else {
            // Flat object treated as a single entry
            dataArray = [parsed];
          }
        }
      }

      let count = 0;
      for (let rawEntry of dataArray) {
        const normalized = this._normalizeAndValidateEntry(rawEntry, category, filename);
        if (normalized) {
          this.entries.push(normalized);
          count++;
        }
      }

      if (count === 0) {
        this.validationErrors.push(`File "${filename}" contains 0 valid knowledge entries.`);
      } else {
        this.filesLoaded++;
      }

    } catch (err) {
      this.validationErrors.push(`Error loading file "${filename}": ${err.message}`);
      this.filesSkipped++;
    }
  }

  /**
   * Normalize and validate/repair one raw entry.
   */
  _normalizeAndValidateEntry(raw, category, sourceFile) {
    if (!raw || typeof raw !== 'object') {
      this.validationErrors.push(`[${sourceFile}] Entry is not a valid object.`);
      return null;
    }

    // Required fields & repairs
    let title = (raw.title || raw.name || raw.heading || '').trim();
    if (!title) {
      // Auto-repair: Use filename category title case
      title = category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      this.validationErrors.push(`[${sourceFile}] Missing entry title. Auto-repaired to: "${title}"`);
    }

    let keywords = [];
    const rawKws = raw.keywords || raw.tags || [];
    if (Array.isArray(rawKws)) {
      keywords = rawKws.map(k => String(k).toLowerCase().trim()).filter(Boolean);
    } else if (typeof rawKws === 'string') {
      keywords = rawKws.split(',').map(k => k.toLowerCase().trim()).filter(Boolean);
    }
    
    // Auto-repair missing keywords using tokens from the title
    if (keywords.length === 0) {
      keywords = title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      this.validationErrors.push(`[${sourceFile}] Missing keywords for "${title}". Auto-extracted from title.`);
    }

    // ── Extract Q&A pairs from content ────────────────────────────────────────
    let content = raw.content;
    let answer = raw.answer || raw.description || null;

    let qaPairs = [];
    if (content) {
      qaPairs = extractQAPairs(content);
    }

    // If no QA pairs extracted but there is a top-level answer or description, construct a QA pair
    if (qaPairs.length === 0 && answer) {
      qaPairs = [{ question: '', answer: String(answer) }];
    }

    // If still no QA pairs, try to extract description from structured content object
    if (qaPairs.length === 0 && typeof content === 'object' && content !== null && !Array.isArray(content)) {
      const contentDesc = content.description || content.info || content.text || '';
      if (contentDesc) {
        qaPairs = [{ question: '', answer: String(contentDesc) }];
      }
    }

    // Deduplicate questions and filter empty entries inside content
    const cleanQaPairs = [];
    const seenQuestions = new Set();

    for (const qa of qaPairs) {
      const qText = (qa.question || '').trim();
      const aText = (qa.answer || '').trim();

      // Skip entries with no content at all
      if (!qText && !aText) {
        this.validationErrors.push(`[${sourceFile}] Skipped empty Q&A pair in "${title}".`);
        continue;
      }

      const qKey = qText.toLowerCase();
      if (qText && seenQuestions.has(qKey)) {
        this.validationErrors.push(`[${sourceFile}] Duplicate question detected in "${title}": "${qText}". Auto-deduplicated.`);
        continue;
      }

      if (qText) {
        seenQuestions.add(qKey);
      }
      cleanQaPairs.push({ question: qText, answer: aText });
    }

    // ── Build expanded search text ─────────────────────────────────────────────
    const qaText = cleanQaPairs
      .map(qa => `${qa.question} ${qa.answer}`)
      .join(' ')
      .toLowerCase();

    // Extract raw text from structured content fields (description, college_timings, etc.)
    let rawContentText = '';
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const textParts = [];
      for (const [key, val] of Object.entries(content)) {
        // Skip the Q&A arrays — already in qaText
        if (key === 'possible_questions_answers' || key === 'questions_answers') continue;
        if (typeof val === 'string' && val.trim()) textParts.push(val.trim());
      }
      rawContentText = textParts.join(' ').toLowerCase();
    }

    const searchText = [
      title.toLowerCase(),
      keywords.join(' '),
      qaText,
      (answer || '').toLowerCase(),
      rawContentText,
      category.replace(/-/g, ' '),
    ].join(' ');

    if (!searchText.trim() || searchText.replace(/\s/g, '').length < 3) {
      this.validationErrors.push(`[${sourceFile}] Entry "${title}" has no searchable text. Skipped.`);
      return null;
    }

    // Update indexed questions counter
    this.indexedQuestionsCount += cleanQaPairs.filter(qa => qa.question).length;

    let showInKnowledgeBase = true;
    if (raw.showInKnowledgeBase !== undefined) {
      showInKnowledgeBase = !!raw.showInKnowledgeBase;
    } else {
      const mainFiles = [
        'about.json',
        'academics.json',
        'admission.json',
        'eee.json', 'civil engineering.json', 'computer engineering.json', 'ece.json', 'mechanical engineering.json',
        'examination.json',
        'others.json',
        'alumuni.json',
        'contact.json',
        'college-timings.json'
      ];
      const fileLower = sourceFile.toLowerCase();
      showInKnowledgeBase = mainFiles.includes(fileLower);
    }

    return {
      id:              raw.id || `gen_${Math.random().toString(36).substr(2, 9)}`,
      title,
      keywords,
      category:        raw.category || category,
      source_category: category,
      source_file:     sourceFile,
      showInKnowledgeBase,
      content:         cleanQaPairs.length > 0 ? cleanQaPairs : (content || answer),
      answer:          answer,
      description:     raw.description || null,
      _title_lower:    title.toLowerCase(),
      _search_text:    searchText,
      _qa_pairs:       cleanQaPairs,
    };
  }

  // ── HOT RELOADING WATCHER ───────────────────────────────────────────────────

  setupWatcher() {
    if (this.watcher) return;
    const watchDirs = [];
    if (fs.existsSync(this.dataDir)) watchDirs.push(this.dataDir);
    if (fs.existsSync(this.knowledgeDir)) watchDirs.push(this.knowledgeDir);

    if (watchDirs.length === 0) return;

    try {
      const chokidar = require('chokidar');
      this.watcher = chokidar.watch(watchDirs, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true
      });

      this.watcher.on('all', (event, filePath) => {
        if (filePath.endsWith('.json')) {
          console.log(`[KB WATCHER] 🔄 FS Event "${event}" on ${filePath}. Hot-reloading...`);
          this.reload();
        }
      });
      console.log(`[KB] 👀 Hot-reloading file watcher active on: ${watchDirs.join(', ')}`);
    } catch (e) {
      // Native fs.watch fallback
      this.watchers = [];
      for (const dir of watchDirs) {
        try {
          const watcher = fs.watch(dir, (eventType, filename) => {
            if (filename && filename.endsWith('.json')) {
              console.log(`[KB WATCHER] 🔄 Native FS Event "${eventType}" on ${filename}. Hot-reloading...`);
              this.reload();
            }
          });
          this.watchers.push(watcher);
        } catch (err) {
          console.error(`[KB] Failed to watch ${dir}:`, err.message);
        }
      }
    }
  }

  reload() {
    this.loadAllData();
    return {
      success:          true,
      message:          'Knowledge base hot-reloaded successfully.',
      filesLoaded:      this.filesLoaded,
      categories:       Object.keys(this.byCategory).length,
      entries:          this.entries.length,
      indexedQuestions: this.indexedQuestionsCount,
    };
  }

  // ── QUERY PROCESSING & SEARCH ──────────────────────────────────────────────

  /**
   * Apply spelling corrections to individual words in a query.
   * Returns the corrected query string and a flag if any corrections were made.
   */
  _applySpellingCorrections(query) {
    const words = query.split(/\s+/);
    let corrected = false;
    const fixed = words.map(word => {
      const lower = word.toLowerCase();
      if (SPELLING_CORRECTIONS[lower]) {
        corrected = true;
        return SPELLING_CORRECTIONS[lower];
      }
      return lower;
    });
    return { correctedQuery: fixed.join(' '), wasSpellingCorrected: corrected };
  }

  /**
   * Full query normalization pipeline:
   *   1. Lowercase
   *   2. Remove punctuation / special chars
   *   3. Normalize whitespace
   *   4. Apply spelling corrections (principle → principal, etc.)
   *   5. Return normalized string + metadata
   */
  _normalizeQuery(query) {
    // Step 1-3: Basic cleanup
    const cleaned = query
      .toLowerCase()
      .replace(/[''"?!.,;:()[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Step 4: Apply spelling corrections
    const { correctedQuery, wasSpellingCorrected } = this._applySpellingCorrections(cleaned);

    return { normalized: correctedQuery, wasSpellingCorrected };
  }

  /**
   * Extract meaningful keywords from a normalized query,
   * filtering stop words and very short tokens.
   */
  _extractKeywords(normalizedQuery) {
    return normalizedQuery
      .split(' ')
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }

  /**
   * Expand a keyword list using the synonym map.
   * For each keyword, find its canonical form and all aliases.
   */
  _expandWithSynonyms(keywords) {
    const expanded = new Set(keywords);

    for (const kw of keywords) {
      // Direct canonical key match
      if (SYNONYM_MAP[kw]) {
        expanded.add(kw);
        SYNONYM_MAP[kw].forEach(s => expanded.add(s));
      }

      // Check if keyword is an alias of any canonical term
      for (const [canonical, alts] of Object.entries(SYNONYM_MAP)) {
        if (canonical === kw || alts.includes(kw) || alts.some(a => a.includes(kw) && kw.length > 3)) {
          expanded.add(canonical);
          alts.forEach(a => expanded.add(a));
        }
      }
    }

    return [...expanded];
  }

  /**
   * Extract topic context from recent conversation history.
   */
  _extractContextFromHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];

    const recent = history.slice(-4);
    const contextWords = [];

    for (const msg of recent) {
      const text = (msg.content || msg.text || msg.message || '').toLowerCase();
      if (!text) continue;

      const deptPatterns = [
        'civil', 'mechanical', 'electrical', 'electronics', 'ece', 'computer', 'cse',
        'eee', 'mech', 'hostel', 'library', 'transport', 'placement', 'fee', 'alumni',
        'principal', 'faculty', 'admission', 'scholarship', 'exam', 'timings', 'timing',
      ];
      for (const pattern of deptPatterns) {
        if (text.includes(pattern)) {
          contextWords.push(pattern);
        }
      }
    }

    return [...new Set(contextWords)];
  }

  /**
   * Score a single KB entry against the user's query.
   *
   * Scoring layers:
   *   1. Title matching (exact / partial / fuzzy / keyword-in-title)
   *   2. Category matching
   *   3. Keyword array matching (exact / partial / fuzzy)
   *   4. Full-text search in pre-computed search text
   *   5. Exact phrase match in search text
   *   6. Q&A question text matching (exact / fuzzy / keyword overlap)
   *   7. Q&A + answer text keyword matching (expanded keywords)
   *   8. Spelling correction bonus
   */
  _scoreEntry(entry, keywords, expandedKeywords, normalizedQuery, wasSpellingCorrected) {
    let score = 0;
    const title = entry._title_lower;
    const searchText = entry._search_text;

    // ── 1. Title matching ────────────────────────────────────────────────────
    if (title) {
      if (title === normalizedQuery) {
        score += SCORE.EXACT_TITLE;
      } else if (title.includes(normalizedQuery) || normalizedQuery.includes(title)) {
        score += SCORE.PARTIAL_TITLE;
      } else {
        const fs = fuzzyScore(normalizedQuery, title);
        if (fs >= 0.85)      score += SCORE.EXACT_TITLE * 0.8;
        else if (fs >= 0.70) score += SCORE.FUZZY_TITLE * 1.5;
        else if (fs >= 0.55) score += SCORE.FUZZY_TITLE;
      }

      // Each original keyword appearing in the title gets a significant bonus
      for (const kw of keywords) {
        if (kw.length > 2 && title.includes(kw)) {
          score += SCORE.TITLE_KW_HIT;
        }
      }

      // Expanded keywords in title (smaller bonus)
      for (const kw of expandedKeywords) {
        if (kw.length > 3 && title.includes(kw) && !keywords.includes(kw)) {
          score += SCORE.TITLE_KW_HIT / 2;
        }
      }
    }

    // ── 2. Category matching ─────────────────────────────────────────────────
    const catLower = (entry.source_category || '').replace(/-/g, ' ');
    for (const kw of expandedKeywords) {
      if (kw.length < 2) continue;
      if (catLower === kw) {
        score += SCORE.CATEGORY_MATCH;
      } else if (catLower.includes(kw) || kw.includes(catLower)) {
        score += SCORE.CATEGORY_PARTIAL;
      } else if (isFuzzyMatch(kw, catLower, 0.75)) {
        score += SCORE.CATEGORY_PARTIAL / 2;
      }
    }

    // ── 3. Keyword array matching ────────────────────────────────────────────
    for (const kw of expandedKeywords) {
      if (kw.length < 2) continue;
      for (const ik of entry.keywords) {
        if (ik === kw) {
          score += SCORE.EXACT_KEYWORD;
        } else if (ik.includes(kw) || kw.includes(ik)) {
          if (kw.length <= 3) {
            const regex = new RegExp('\\b' + kw + '\\b');
            if (regex.test(ik)) {
              score += SCORE.PARTIAL_KEYWORD;
            }
          } else {
            score += SCORE.PARTIAL_KEYWORD;
          }
        } else if (isFuzzyMatch(kw, ik, 0.72)) {
          score += SCORE.FUZZY_KEYWORD;
        }
      }
    }

    // ── 4. Full-text search in pre-computed search text ───────────────────────
    for (const kw of keywords) {
      if (kw.length > 2 && searchText.includes(kw)) {
        score += SCORE.CONTENT_HIT;
      }
    }

    // Expanded keywords in search text (smaller bonus)
    for (const kw of expandedKeywords) {
      if (kw.length > 3 && searchText.includes(kw) && !keywords.includes(kw)) {
        score += SCORE.CONTENT_HIT / 2;
      }
    }

    // ── 5. Exact phrase match in search text ─────────────────────────────────
    if (normalizedQuery.length > 4 && searchText.includes(normalizedQuery)) {
      score += SCORE.QA_TEXT_HIT;
    }

    // ── 6. Q&A question text matching ─────────────────────────────────────────
    if (entry._qa_pairs && entry._qa_pairs.length > 0) {
      let bestQaScore = 0;

      for (const qa of entry._qa_pairs) {
        if (!qa.question) continue;
        const qLower = qa.question.toLowerCase();

        // ── Exact raw string match ───────────────────────────────────────────
        if (qLower === normalizedQuery) {
          bestQaScore = Math.max(bestQaScore, SCORE.QA_QUESTION_EXACT);
          continue;
        }

        // ── Normalized match: strip stopwords from both sides ────────────────
        // This handles: stored "Who is the HOD of EEE?" vs user "who hod eee"
        const qNorm = _normalizeStoredQuestion(qa.question);
        const uNorm = _normalizeStoredQuestion(normalizedQuery);
        if (qNorm && uNorm && qNorm === uNorm) {
          bestQaScore = Math.max(bestQaScore, SCORE.QA_QUESTION_NEAR_EXACT);
          continue;
        }

        // ── Containment check (raw) ──────────────────────────────────────────
        if (qLower.includes(normalizedQuery) || normalizedQuery.includes(qLower)) {
          bestQaScore = Math.max(bestQaScore, SCORE.QA_QUESTION_FUZZY);
          continue;
        }

        // ── Normalized containment ───────────────────────────────────────────
        if (qNorm && uNorm && (qNorm.includes(uNorm) || uNorm.includes(qNorm))) {
          bestQaScore = Math.max(bestQaScore, SCORE.QA_QUESTION_FUZZY);
          continue;
        }

        // ── Fuzzy question match ─────────────────────────────────────────────
        const qs = fuzzyScore(normalizedQuery, qLower);
        if (qs >= 0.80) {
          bestQaScore = Math.max(bestQaScore, SCORE.QA_QUESTION_FUZZY);
        } else if (qs >= 0.65) {
          bestQaScore = Math.max(bestQaScore, SCORE.QA_TEXT_HIT);
        }

        // Normalized fuzzy
        if (qNorm && uNorm) {
          const qsNorm = fuzzyScore(uNorm, qNorm);
          if (qsNorm >= 0.80) {
            bestQaScore = Math.max(bestQaScore, SCORE.QA_QUESTION_FUZZY);
          }
        }

        // ── Keyword overlap in stored question ───────────────────────────────
        let kwHits = 0;
        for (const kw of keywords) {
          if (kw.length > 2 && qLower.includes(kw)) kwHits++;
        }
        if (kwHits > 0) {
          const kwScore = SCORE.QA_TEXT_HIT * Math.min(kwHits, 3) / 3;
          bestQaScore = Math.max(bestQaScore, kwScore);
        }
      }

      score += bestQaScore;

      // ── 7. Q&A answer text keyword matching ─────────────────────────────────
      const qaFullText = entry._qa_pairs
        .map(qa => `${qa.question} ${qa.answer}`)
        .join(' ')
        .toLowerCase();

      for (const kw of expandedKeywords) {
        if (kw.length > 2 && qaFullText.includes(kw)) {
          score += SCORE.CONTENT_HIT / 2;
        }
      }
    }

    // ── 8. Spelling correction bonus ─────────────────────────────────────────
    // If spelling was corrected AND this entry has a positive score, apply a small
    // bonus to ensure corrected queries don't fall just below the threshold.
    if (wasSpellingCorrected && score > 0) {
      score += SCORE.SPELLING_CORRECTED;
    }

    return score;
  }

  search(query, history = []) {
    const results = this.searchMultiple(query, 1, history);
    return results.length > 0 ? results[0] : null;
  }

  searchMultiple(query, topN = 5, history = []) {
    // ── Full normalization pipeline ──────────────────────────────────────────
    const { normalized: normalizedQuery, wasSpellingCorrected } = this._normalizeQuery(query);

    let keywords = this._extractKeywords(normalizedQuery);

    // If stop-word filtering left nothing, relax: use all words > 1 char
    if (keywords.length === 0) {
      keywords = normalizedQuery.split(' ').filter(w => w.length > 1);
    }
    if (keywords.length === 0) return [];

    // Add context from conversation history
    const contextWords = this._extractContextFromHistory(history);
    if (contextWords.length > 0) {
      const combined = [...new Set([...keywords, ...contextWords])];
      keywords = combined;
    }

    const expandedKeywords = this._expandWithSynonyms(keywords);

    // ── Intent Detection ─────────────────────────────────────────────────────
    // Run on the ORIGINAL query (before normalization can strip dept names)
    const intent = detectIntent(query);

    // Debug log
    console.log(`\n[SEARCH] User query: ${query}`);
    console.log(`[SEARCH] Normalized: "${normalizedQuery}" | SpellingFixed: ${wasSpellingCorrected}`);
    console.log(`[SEARCH] Keywords: [${keywords.join(', ')}] → Expanded to ${expandedKeywords.length} terms`);
    if (intent.type) {
      console.log(`[INTENT] Detected: ${intent.type} (maxResults override: ${intent.maxResults})`);
    } else {
      console.log(`[INTENT] None detected — general search`);
    }

    // ── EXACT-MATCH SHORT-CIRCUIT ─────────────────────────────────────────────
    // Check the pre-built index for a normalized exact match.
    // If found, skip scoring entirely and return immediately.
    const userNormForIndex = _normalizeStoredQuestion(query);
    if (userNormForIndex && this.exactMatchIndex.has(userNormForIndex)) {
      const { entry, answer } = this.exactMatchIndex.get(userNormForIndex);
      console.log(`[EXACT-MATCH] ⚡ Direct index hit for "${userNormForIndex}" → "${entry.title}" (${entry.source_file})`);
      return [entry];
    }

    // Also try the raw normalized query in the index
    if (normalizedQuery && this.exactMatchIndex.has(normalizedQuery)) {
      const { entry } = this.exactMatchIndex.get(normalizedQuery);
      console.log(`[EXACT-MATCH] ⚡ Raw normalized index hit → "${entry.title}"`);
      return [entry];
    }

    // Score all entries (base score + intent boost)
    const scored = [];
    for (const entry of this.entries) {
      const baseScore   = this._scoreEntry(entry, keywords, expandedKeywords, normalizedQuery, wasSpellingCorrected);
      const boost       = intentBoostForEntry(entry, intent);
      const totalScore  = baseScore + boost;
      // Only include if total score is positive (boost alone cannot pull in
      // an entry that has ZERO base relevance — negative boost entries filtered)
      if (totalScore >= MIN_SCORE && baseScore >= 0) {
        scored.push({ entry, score: totalScore });
      }
    }

    // Last-resort fuzzy fallback: if nothing scored above threshold, try
    // fuzzy title matching to avoid false negatives for short queries
    if (scored.length === 0 && normalizedQuery.length > 2) {
      for (const entry of this.entries) {
        const titleScore = fuzzyScore(normalizedQuery, entry._title_lower);
        if (titleScore >= 0.60) {
          const boost = intentBoostForEntry(entry, intent);
          const total = titleScore * 20 + boost;
          if (total > 0) scored.push({ entry, score: total });
        }
      }
    }

    if (scored.length === 0) {
      console.log(`[RESULTS] No results found above threshold.`);
      return [];
    }

    scored.sort((a, b) => b.score - a.score);

    // Log top candidates before dedup
    console.log(`[RESULTS] Top candidates:`);
    scored.slice(0, 5).forEach(({ entry, score }) => {
      console.log(`  [${score.toFixed(1)}] "${entry.title}" (${entry.source_file})`);
    });

    // ── Determine effective result limit ─────────────────────────────────────
    // If intent gave us a maxResults, use that; otherwise use the caller's topN.
    const effectiveMax = (intent.maxResults !== null && intent.maxResults !== undefined)
      ? Math.min(intent.maxResults, topN)
      : topN;

    // ── Deduplicate by title + source_file ───────────────────────────────────
    const seen    = new Set();
    const unique  = [];
    for (const { entry, score } of scored) {
      // Key combines title + file to avoid two different files with same title
      const key = `${entry._title_lower}|${entry.source_file}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ entry, score });
        if (unique.length >= effectiveMax) break;
      }
    }

    console.log(`[FINAL] Returning ${unique.length} result(s): ${unique.map(u => `"${u.entry.title}"`).join(', ')}`);

    return unique.map(u => u.entry);
  }

  searchByCategory(categoryName) {
    const cat = categoryName.toLowerCase().trim();
    if (this.byCategory[cat]) return this.byCategory[cat];
    for (const [key, entries] of Object.entries(this.byCategory)) {
      if (key.includes(cat) || cat.includes(key)) return entries;
    }
    return null;
  }

  // ── STATS & UTILITY API ──────────────────────────────────────────────────────

  getStats() {
    return {
      categories:            Object.keys(this.byCategory).length,
      entries:               this.entries.length,
      filesLoaded:           this.filesLoaded,
      filesSkipped:          this.filesSkipped,
      ignoredFiles:          this.ignoredFiles,
      validationErrors:      this.validationErrors,
      indexedQuestionsCount: this.indexedQuestionsCount,
      dataDir:               this.dataDir,
      knowledgeDir:          this.knowledgeDir,
    };
  }

  getAllCategories() {
    return Object.entries(this.byCategory).map(([name, entries]) => ({
      name,
      entries: entries.length,
    }));
  }

  getAllArticles() {
    const { formatKbItem } = require('../utils/responseFormatter');
    return this.entries.map(entry => ({
      id:       entry.id || 0,
      category: entry.source_category,
      title:    entry.title || '',
      content:  entry._qa_pairs.length > 0
        ? entry._qa_pairs.map(qa => qa.answer).join(' | ')
        : (typeof entry.content === 'string' ? entry.content : formatKbItem(entry)),
      showInKnowledgeBase: entry.showInKnowledgeBase,
    }));
  }

  getCategoryData(category) {
    return this.byCategory[category.toLowerCase()] || null;
  }

  addEntry(category, entryData) {
    const cat = category.toLowerCase();
    if (!this.byCategory[cat]) this.byCategory[cat] = [];

    const maxId = this.entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    entryData.id = maxId + 1;

    const normalized = this._normalizeAndValidateEntry(entryData, cat, `${cat}.json`);
    if (!normalized) throw new Error('Entry normalization failed — check title/content fields.');

    this.byCategory[cat].push(normalized);
    this.entries.push(normalized);
    this._saveCategory(cat);
    return normalized;
  }

  editEntry(category, id, updatedEntry) {
    const cat     = category.toLowerCase();
    const entries = this.byCategory[cat];
    if (!entries) return null;

    const idx = entries.findIndex(e => String(e.id) === String(id));
    if (idx === -1) return null;

    const merged     = { ...entries[idx], ...updatedEntry, id };
    const normalized = this._normalizeAndValidateEntry(merged, cat, entries[idx].source_file);
    entries[idx]     = normalized;

    const globalIdx = this.entries.findIndex(e => String(e.id) === String(id) && e.source_category === cat);
    if (globalIdx !== -1) this.entries[globalIdx] = normalized;

    this._saveCategory(cat);
    return normalized;
  }

  deleteEntry(category, id) {
    const cat     = category.toLowerCase();
    const entries = this.byCategory[cat];
    if (!entries) return false;

    const idx = entries.findIndex(e => String(e.id) === String(id));
    if (idx === -1) return false;

    entries.splice(idx, 1);

    const gIdx = this.entries.findIndex(e => String(e.id) === String(id) && e.source_category === cat);
    if (gIdx !== -1) this.entries.splice(gIdx, 1);

    this._saveCategory(cat);
    return true;
  }

  editEntryGlobal(id, updatedEntry) {
    for (const cat of Object.keys(this.byCategory)) {
      const result = this.editEntry(cat, id, updatedEntry);
      if (result) return result;
    }
    return null;
  }

  deleteEntryGlobal(id) {
    for (const cat of Object.keys(this.byCategory)) {
      if (this.deleteEntry(cat, id)) return true;
    }
    return false;
  }

  _saveCategory(category) {
    const entries  = this.byCategory[category] || [];
    const filePath = path.join(this.dataDir, `${category}.json`);

    const toWrite = entries.map(e => {
      const clean = {};
      for (const [k, v] of Object.entries(e)) {
        if (!k.startsWith('_')) clean[k] = v;
      }
      return clean;
    });

    try {
      fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), 'utf8');
    } catch (err) {
      console.error(`[KB] ❌ Failed to save ${category}.json:`, err.message);
    }
  }
}

module.exports = new JsonSearchService();
