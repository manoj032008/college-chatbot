// Authentication Service (authService.js)
// Interacts with backend API endpoints for register, login, and Google Sign-in.
'use strict';

class AuthService {
  constructor() {
    this._tokenKey = 'auth_token';
    this._sessionKey = 'auth_user';
  }

  // Determine API base dynamically to support both local and production environments
  _getApiBase() {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return '';
      }
    }
    return 'https://college-chatbot-dnii.onrender.com';
  }

  // Helper to validate email format on the client side
  _isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Register a new user
   */
  async register(username, email, password) {
    const cleanUsername = (username || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanUsername || cleanUsername.length < 3) {
      return { success: false, message: 'Username must be at least 3 characters.' };
    }
    if (!this._isValidEmail(cleanEmail)) {
      return { success: false, message: 'Please enter a valid email address.' };
    }
    if (!password || password.length < 6) {
      return { success: false, message: 'Password must be at least 6 characters.' };
    }

    try {
      const response = await fetch(this._getApiBase() + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUsername, email: cleanEmail, password })
      });

      const data = await response.json();
      if (!response.ok) {
        return { success: false, message: data.message || 'Registration failed.' };
      }

      return { success: true, message: data.message || 'Registration successful! You can now log in.' };
    } catch (e) {
      console.error('Registration fetch error:', e);
      return { success: false, message: 'Server is currently offline or unreachable. Please try again later.' };
    }
  }

  /**
   * Login a user
   */
  async login(usernameOrEmail, password) {
    const query = (usernameOrEmail || '').trim();
    if (!query || !password) {
      return { success: false, message: 'Username/Email and password are required.' };
    }

    try {
      const response = await fetch(this._getApiBase() + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: query, password })
      });

      const data = await response.json();
      if (!response.ok) {
        return { success: false, message: data.message || 'Login failed.' };
      }

      // Save token and user details
      localStorage.setItem(this._tokenKey, data.token);
      localStorage.setItem(this._sessionKey, JSON.stringify(data.user));

      return { success: true, user: data.user };
    } catch (e) {
      console.error('Login fetch error:', e);
      return { success: false, message: 'Server is currently offline or unreachable. Please try again later.' };
    }
  }

  /**
   * Login with Google
   */
  async loginWithGoogle(idToken) {
    if (!idToken) {
      return { success: false, message: 'Google authentication failed.' };
    }

    try {
      const response = await fetch(this._getApiBase() + '/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      });

      const data = await response.json();
      if (!response.ok) {
        return { success: false, message: data.message || 'Google login failed.' };
      }

      // Save token and user details
      localStorage.setItem(this._tokenKey, data.token);
      localStorage.setItem(this._sessionKey, JSON.stringify(data.user));

      return { success: true, user: data.user };
    } catch (e) {
      console.error('Google login fetch error:', e);
      return { success: false, message: 'Server is currently offline or unreachable. Please try again later.' };
    }
  }

  /**
   * Logout user
   */
  logout() {
    localStorage.removeItem(this._tokenKey);
    localStorage.removeItem(this._sessionKey);
    return { success: true };
  }

  /**
   * Get auth token
   */
  getToken() {
    return localStorage.getItem(this._tokenKey);
  }

  /**
   * Get active logged in user from local cache (synchronous helper)
   */
  getCurrentUser() {
    try {
      const session = localStorage.getItem(this._sessionKey);
      return session ? JSON.parse(session) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Check if user has credentials locally
   */
  isLoggedIn() {
    return this.getToken() !== null && this.getCurrentUser() !== null;
  }

  /**
   * Get Authorization headers object
   */
  getAuthHeaders() {
    const token = this.getToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  /**
   * Verify session token against backend on reload (asynchronous)
   */
  async verifySession() {
    const token = this.getToken();
    if (!token) {
      this.logout();
      return null;
    }

    try {
      const response = await fetch(this._getApiBase() + '/api/auth/me', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders()
        }
      });

      const data = await response.json();
      if (!response.ok) {
        // If authentication failed (e.g. expired or invalid token), log out
        if (response.status === 401) {
          this.logout();
        }
        return null;
      }

      // Keep user details updated in cache
      localStorage.setItem(this._sessionKey, JSON.stringify(data.user));
      return data.user;
    } catch (e) {
      console.error('Verify session error:', e);
      // On network failure, we preserve the cached user session so they aren't logged out
      return this.getCurrentUser();
    }
  }
}

// Attach to window so index.html script can access it directly
if (typeof window !== 'undefined') {
  window.authService = new AuthService();
}
