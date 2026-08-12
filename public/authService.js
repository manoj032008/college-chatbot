// Local Authentication Service (authService.js)
// Emulates a lightweight JWT-like auth provider using browser LocalStorage.
'use strict';

class AuthService {
  constructor() {
    this._usersKey = 'local_users';
    this._sessionKey = 'local_session';

    // Seed default admin account if users are empty
    if (!localStorage.getItem(this._usersKey)) {
      const defaultUsers = [
        {
          id: 'admin-1',
          username: 'admin',
          email: 'admin@college.edu',
          password: 'password123', // stored in plain text/simple for stateless mock
          role: 'admin'
        }
      ];
      localStorage.setItem(this._usersKey, JSON.stringify(defaultUsers));
    }
  }

  // Get all registered users helper
  _getUsers() {
    try {
      return JSON.parse(localStorage.getItem(this._usersKey)) || [];
    } catch (e) {
      return [];
    }
  }

  // Save users helper
  _saveUsers(users) {
    localStorage.setItem(this._usersKey, JSON.stringify(users));
  }

  // Validate email pattern
  _isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Register a new user
   */
  register(username, email, password) {
    const cleanUsername = (username || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanUsername) {
      return { success: false, message: 'Username cannot be empty.' };
    }
    if (!this._isValidEmail(cleanEmail)) {
      return { success: false, message: 'Please enter a valid email address.' };
    }
    if (!password || password.length < 6) {
      return { success: false, message: 'Password must be at least 6 characters.' };
    }

    const users = this._getUsers();

    // Prevent duplicate email registration
    const emailExists = users.some(u => u.email === cleanEmail);
    if (emailExists) {
      return { success: false, message: 'An account with this email already exists.' };
    }

    // Prevent duplicate username registration (optional, but good practice)
    const usernameExists = users.some(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (usernameExists) {
      return { success: false, message: 'Username is already taken.' };
    }

    const newUser = {
      id: 'usr-' + Date.now(),
      username: cleanUsername,
      email: cleanEmail,
      password: password,
      role: 'student' // Default role
    };

    users.push(newUser);
    this._saveUsers(users);

    return { success: true, message: 'Registration successful! You can now log in.' };
  }

  /**
   * Login a user
   */
  login(usernameOrEmail, password) {
    const query = (usernameOrEmail || '').trim().toLowerCase();
    if (!query || !password) {
      return { success: false, message: 'Username/Email and password are required.' };
    }

    const users = this._getUsers();
    const user = users.find(u => u.username.toLowerCase() === query || u.email === query);

    if (!user || user.password !== password) {
      return { success: false, message: 'Invalid username/email or password.' };
    }

    // Set active session (exclude password for security mock)
    const sessionUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    };

    localStorage.setItem(this._sessionKey, JSON.stringify(sessionUser));
    return { success: true, user: sessionUser };
  }

  /**
   * Logout user
   */
  logout() {
    localStorage.removeItem(this._sessionKey);
    return { success: true };
  }

  /**
   * Get active logged in user
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
   * Check if user is logged in
   */
  isLoggedIn() {
    return this.getCurrentUser() !== null;
  }
}

// Attach to window so index.html script can access it directly
if (typeof window !== 'undefined') {
  window.authService = new AuthService();
}
