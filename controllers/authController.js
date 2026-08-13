'use strict';

const db = require('../database/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const JWT_SECRET = process.env.JWT_SECRET || 'default_fallback_secret_for_dev';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Helper to check if a client ID is a placeholder/mock value
function isPlaceholderClientId(clientId) {
  if (!clientId) return true;
  const clean = clientId.trim().toLowerCase();
  return clean.startsWith('your-') || 
         clean.startsWith('your_') || 
         clean.includes('placeholder') || 
         clean.includes('example.com') ||
         clean === 'your_google_oauth_client_id_here.apps.googleusercontent.com' ||
         !clean.endsWith('.apps.googleusercontent.com');
}

const isGoogleConfigured = !isPlaceholderClientId(GOOGLE_CLIENT_ID);

// Initialize OAuth2 client if client ID is valid
let googleClient;
if (GOOGLE_CLIENT_ID && isGoogleConfigured) {
  googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  console.log(`[Auth] Google Client ID loaded and verified: ${GOOGLE_CLIENT_ID}`);
} else {
  console.warn(`[Auth] ⚠️ Google Client ID is missing or using a placeholder: "${GOOGLE_CLIENT_ID}". Google Sign-In will be disabled or show configuration error.`);
}

// Validate email helper
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * POST /api/auth/register
 */
exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const cleanUsername = (username || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanUsername || cleanUsername.length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    // Check if email already exists
    const emailCheck = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (emailCheck) {
      return res.status(400).json({ success: false, message: 'This email is already registered. Please sign in.' });
    }

    // Check if username already exists
    const usernameCheck = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(cleanUsername.toLowerCase());
    if (usernameCheck) {
      return res.status(400).json({ success: false, message: 'Username is already taken.' });
    }

    // Hash password
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const userId = 'usr-' + Date.now();

    // Insert user (role is student by default, unless it's 'admin' for a special seed or configured)
    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role)
      VALUES (?, ?, ?, ?, 'student')
    `).run(userId, cleanUsername, cleanEmail, passwordHash);

    return res.status(201).json({
      success: true,
      message: 'Registration successful! You can now log in.'
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during registration.' });
  }
};

/**
 * POST /api/auth/login
 */
exports.login = async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;

    const query = (usernameOrEmail || '').trim().toLowerCase();
    if (!query || !password) {
      return res.status(400).json({ success: false, message: 'Username/Email and password are required.' });
    }

    // Search user by email or username
    const user = db.prepare(`
      SELECT * FROM users 
      WHERE LOWER(username) = ? OR LOWER(email) = ?
    `).get(query, query);

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid username/email or password.' });
    }

    // Check if user has password (might be a Google-only account)
    if (!user.password_hash) {
      return res.status(400).json({
        success: false,
        message: 'This account was created with Google Sign-In. Please use Continue with Google.'
      });
    }

    // Compare passwords
    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid username/email or password.' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
};

/**
 * POST /api/auth/google
 */
exports.googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, message: 'Google ID token is required.' });
    }

    if (!GOOGLE_CLIENT_ID || !isGoogleConfigured) {
      return res.status(500).json({
        success: false,
        message: 'Google Sign-In configuration is missing.'
      });
    }

    if (!googleClient) {
      googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
    }

    // Verify token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email.toLowerCase();
    const name = payload.name || payload.given_name || email.split('@')[0];

    // Find user by google_id
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

    if (!user) {
      // Check if user exists by email (link Google ID if already registered via email)
      user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);

      if (user) {
        // Link Google account
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
        // Fetch updated user
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      } else {
        // Create new user for Google sign in
        const userId = 'usr-' + Date.now();
        
        // Generate a unique username from name
        let baseUsername = name.replace(/\s+/g, '').substring(0, 15);
        let username = baseUsername;
        let counter = 1;
        
        // Verify uniqueness of username
        while (db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(username.toLowerCase())) {
          username = baseUsername + counter;
          counter++;
        }

        db.prepare(`
          INSERT INTO users (id, username, email, role, google_id)
          VALUES (?, ?, ?, 'student', ?)
        `).run(userId, username, email, googleId);

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      }
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Google login error:', err);
    return res.status(401).json({ success: false, message: 'Google authentication failed.' });
  }
};

/**
 * GET /api/auth/me
 */
exports.getMe = async (req, res) => {
  try {
    // req.user is set by authMiddleware
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    // Fetch fresh user data from database
    const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User no longer exists.' });
    }

    return res.json({
      success: true,
      user
    });
  } catch (err) {
    console.error('getMe error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

/**
 * GET /api/auth/config
 */
exports.getConfig = async (req, res) => {
  return res.json({
    googleClientId: isGoogleConfigured ? GOOGLE_CLIENT_ID : ''
  });
};
