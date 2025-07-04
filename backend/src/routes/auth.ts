import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { 
  User, 
  LoginRequest, 
  RegisterRequest, 
  AuthResponse,
  LoginRequestSchema,
  RegisterRequestSchema,
  validateData, 
  generateId, 
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  ApiResponse 
} from '@scalesim/shared';
import { database } from '../database/index';
import { logger } from '../utils/logger';
import {
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserSessions,
  authenticateToken,
  logUserActivity
} from '../middleware/auth';

const router = Router();

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-super-secret-jwt-refresh-key-change-in-production';

// Helper function to generate tokens
function generateTokens(userId: string, rememberMe: boolean = false): { accessToken: string; refreshToken: string } {
  const accessToken = jwt.sign(
    { userId, type: 'access' },
    JWT_SECRET,
    { 
      expiresIn: JWT_EXPIRES_IN,
      issuer: 'scalesim',
      audience: 'scalesim-api'
    } as jwt.SignOptions
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { 
      expiresIn: rememberMe ? '30d' : JWT_REFRESH_EXPIRES_IN,
      issuer: 'scalesim',
      audience: 'scalesim-api'
    } as jwt.SignOptions
  );

  return { accessToken, refreshToken };
}

// ============================================================================
// EMAIL/PASSWORD AUTHENTICATION
// ============================================================================

// POST /api/auth/register - Register with email and password
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate request data
    const validationResult = RegisterRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      return next(new ValidationError('Validation failed', validationResult.error.errors));
    }
    
    const registrationData = validationResult.data;

    // Check if user already exists
    const existingUserStmt = database.prepare('SELECT * FROM users WHERE email = ?');
    const existingUser = existingUserStmt.get(registrationData.email);
    
    if (existingUser) {
      return next(new ValidationError('User with this email already exists', []));
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(registrationData.password, saltRounds);

    // Generate user ID
    const userId = 'user-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    // Insert user into database
    const insertUserStmt = database.prepare(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, email_verified)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertUserStmt.run(
      userId,
      registrationData.email,
      passwordHash,
      registrationData.first_name,
      registrationData.last_name,
      0  // false as 0 for SQLite
    );

    // Create default user preferences
    const insertPreferencesStmt = database.prepare(`
      INSERT INTO user_preferences (user_id)
      VALUES (?)
    `);
    insertPreferencesStmt.run(userId);

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(userId);

    // Store refresh token
    const refreshTokenId = 'refresh-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    const insertSessionStmt = database.prepare(`
      INSERT INTO user_sessions (id, user_id, refresh_token, expires_at)
      VALUES (?, ?, ?, ?)
    `);
    insertSessionStmt.run(refreshTokenId, userId, refreshToken, expiresAt.toISOString());

    // Return response
    const user: Partial<User> = {
      id: userId,
      email: registrationData.email,
      first_name: registrationData.first_name,
      last_name: registrationData.last_name,
      email_verified: false
    };

    const response: AuthResponse = {
      success: true,
      user: user as User,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600
    };

    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login - Login with email and password
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate request data
    const validationResult = LoginRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      return next(new ValidationError('Validation failed', validationResult.error.errors));
    }
    
    const loginData = validationResult.data;

    // Find user by email
    const userStmt = database.prepare('SELECT * FROM users WHERE email = ?');
    const user = userStmt.get(loginData.email) as User | undefined;

    if (!user) {
      return next(new UnauthorizedError('Invalid email or password'));
    }

    // Verify password
    const passwordValid = await bcrypt.compare(loginData.password, user.password_hash || '');
    if (!passwordValid) {
      return next(new UnauthorizedError('Invalid email or password'));
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id, loginData.remember_me);

    // Store refresh token
    const refreshTokenId = 'refresh-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const expiresAt = new Date(Date.now() + (loginData.remember_me ? 30 : 7) * 24 * 60 * 60 * 1000);
    
    const insertSessionStmt = database.prepare(`
      INSERT INTO user_sessions (id, user_id, refresh_token, expires_at)
      VALUES (?, ?, ?, ?)
    `);
    insertSessionStmt.run(refreshTokenId, user.id, refreshToken, expiresAt.toISOString());

    // Clean user data (remove password hash)
    const { password_hash, ...userWithoutPassword } = user;

    const response: AuthResponse = {
      success: true,
      user: userWithoutPassword as User,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/logout - Logout and invalidate refresh token
router.post('/logout', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    const userId = (req as any).user?.id;

    if (refreshToken) {
      // Remove specific refresh token
      const deleteStmt = database.prepare('DELETE FROM user_sessions WHERE refresh_token = ?');
      deleteStmt.run(refreshToken);
    } else if (userId) {
      // Remove all user sessions
      const deleteAllStmt = database.prepare('DELETE FROM user_sessions WHERE user_id = ?');
      deleteAllStmt.run(userId);
    }

    const response: ApiResponse = {
      success: true,
      timestamp: new Date()
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/refresh - Refresh access token using refresh token
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return next(new UnauthorizedError('Refresh token is required'));
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET) as { userId: string; type: string };
    
    if (decoded.type !== 'refresh') {
      return next(new UnauthorizedError('Invalid token type'));
    }

    // Check if refresh token exists in database
    const sessionStmt = database.prepare('SELECT * FROM user_sessions WHERE refresh_token = ? AND expires_at > ?');
    const session = sessionStmt.get(refreshToken, new Date().toISOString());

    if (!session) {
      return next(new UnauthorizedError('Invalid or expired refresh token'));
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(decoded.userId);

    // Update refresh token in database
    const updateSessionStmt = database.prepare(`
      UPDATE user_sessions 
      SET refresh_token = ?, expires_at = ? 
      WHERE refresh_token = ?
    `);
    
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    updateSessionStmt.run(newRefreshToken, newExpiresAt.toISOString(), refreshToken);

    const response: AuthResponse = {
      success: true,
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: 3600
    };

    res.json(response);
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError('Invalid refresh token'));
    }
    next(error);
  }
});

// ============================================================================
// PASSWORD RESET
// ============================================================================

// POST /api/auth/forgot-password - Request password reset
router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      next(new ValidationError('Email is required', []));
      return;
    }
    
    // Check if user exists
    const userStmt = database.prepare('SELECT * FROM users WHERE email = ?');
    const user = userStmt.get(email) as User | undefined;
    
    // Always return success to prevent email enumeration
    const response: ApiResponse = {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
      timestamp: new Date()
    };
    
    if (user) {
      // TODO: Implement email sending with reset token
      // For now, just log the request
      logger.info(`Password reset requested for: ${email}`);
      
      logUserActivity(user.id, 'update', 'user', user.id, {
        action: 'password_reset_requested'
      });
    }
    
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/reset-password - Reset password with token
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      next(new ValidationError('Token and password are required', []));
      return;
    }
    
    if (password.length < 6) {
      next(new ValidationError('Password must be at least 6 characters', []));
      return;
    }
    
    // TODO: Implement token validation and password reset
    // For now, return not implemented
    next(new Error('Password reset not implemented yet'));
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// OAUTH AUTHENTICATION (PLACEHOLDERS)
// ============================================================================

// GET /api/auth/oauth/:provider - Initiate OAuth flow
router.get('/oauth/:provider', (req: Request, res: Response, next: NextFunction) => {
  const { provider } = req.params;
  
  if (!['google', 'github', 'linkedin', 'facebook'].includes(provider)) {
    next(new ValidationError('Invalid OAuth provider', []));
    return;
  }
  
  // TODO: Implement OAuth initiation
  // For now, return not implemented
  res.status(501).json({
    success: false,
    message: `OAuth authentication with ${provider} is not implemented yet`,
    timestamp: new Date()
  });
});

// GET /api/auth/oauth/:provider/callback - OAuth callback handler
router.get('/oauth/:provider/callback', (req: Request, res: Response, next: NextFunction) => {
  const { provider } = req.params;
  
  // TODO: Implement OAuth callback handling
  // For now, return not implemented
  res.status(501).json({
    success: false,
    message: `OAuth callback for ${provider} is not implemented yet`,
    timestamp: new Date()
  });
});

// POST /api/auth/oauth/link - Link OAuth account to existing user
router.post('/oauth/link', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  // TODO: Implement OAuth account linking
  // For now, return not implemented
  res.status(501).json({
    success: false,
    message: 'OAuth account linking is not implemented yet',
    timestamp: new Date()
  });
});

// ============================================================================
// USER PROFILE ROUTES
// ============================================================================

// GET /api/auth/profile - Get current user profile
router.get('/profile', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      next(new UnauthorizedError('User not found'));
      return;
    }
    
    // Get user preferences
    const preferencesStmt = database.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
    const preferences = preferencesStmt.get(req.user.id);
    
    const response: ApiResponse = {
      success: true,
      data: {
        user: {
          ...req.user,
          password_hash: undefined
        },
        preferences
      },
      timestamp: new Date()
    };
    
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/profile - Update user profile
router.put('/profile', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      next(new UnauthorizedError('User not found'));
      return;
    }
    
    const { first_name, last_name, avatar_url } = req.body;
    const now = new Date().toISOString();
    
    // Update user profile
    const updateUserStmt = database.prepare(`
      UPDATE users SET 
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        avatar_url = COALESCE(?, avatar_url),
        updated_at = ?
      WHERE id = ?
    `);
    
    updateUserStmt.run(first_name, last_name, avatar_url, now, req.user.id);
    
    // Get updated user
    const userStmt = database.prepare('SELECT * FROM users WHERE id = ?');
    const updatedUser = userStmt.get(req.user.id) as User;
    
    // Log activity
    logUserActivity(req.user.id, 'update', 'user', req.user.id, {
      action: 'profile_updated',
      fields_updated: Object.keys(req.body)
    });
    
    const response: ApiResponse = {
      success: true,
      data: {
        ...updatedUser,
        password_hash: undefined
      },
      message: 'Profile updated successfully',
      timestamp: new Date()
    };
    
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/preferences - Get user preferences
router.get('/preferences', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      next(new UnauthorizedError('User not found'));
      return;
    }
    
    const preferencesStmt = database.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
    const preferences = preferencesStmt.get(req.user.id);
    
    const response: ApiResponse = {
      success: true,
      data: preferences,
      timestamp: new Date()
    };
    
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/preferences - Update user preferences
router.put('/preferences', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      next(new UnauthorizedError('User not found'));
      return;
    }
    
    const { theme, notifications, public_profile, default_project_visibility } = req.body;
    const now = new Date().toISOString();
    
    // Update user preferences
    const updatePreferencesStmt = database.prepare(`
      UPDATE user_preferences SET 
        theme = COALESCE(?, theme),
        notifications = COALESCE(?, notifications),
        public_profile = COALESCE(?, public_profile),
        default_project_visibility = COALESCE(?, default_project_visibility),
        updated_at = ?
      WHERE user_id = ?
    `);
    
    updatePreferencesStmt.run(
      theme, 
      notifications, 
      public_profile, 
      default_project_visibility, 
      now, 
      req.user.id
    );
    
    // Get updated preferences
    const preferencesStmt = database.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
    const updatedPreferences = preferencesStmt.get(req.user.id);
    
    // Log activity
    logUserActivity(req.user.id, 'update', 'user', req.user.id, {
      action: 'preferences_updated',
      fields_updated: Object.keys(req.body)
    });
    
    const response: ApiResponse = {
      success: true,
      data: updatedPreferences,
      message: 'Preferences updated successfully',
      timestamp: new Date()
    };
    
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/auth/sessions - Revoke all user sessions
router.delete('/sessions', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      next(new UnauthorizedError('User not found'));
      return;
    }
    
    await revokeAllUserSessions(req.user.id);
    
    // Log activity
    logUserActivity(req.user.id, 'update', 'user', req.user.id, {
      action: 'all_sessions_revoked'
    });
    
    const response: ApiResponse = {
      success: true,
      message: 'All sessions revoked successfully',
      timestamp: new Date()
    };
    
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// USER PROFILE ENDPOINT
// ============================================================================

router.get('/me', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.id;
    
    const userStmt = database.prepare('SELECT * FROM users WHERE id = ?');
    const user = userStmt.get(userId) as User | undefined;

    if (!user) {
      return next(new UnauthorizedError('User not found'));
    }

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;

    res.json({
      success: true,
      data: userWithoutPassword
    });
  } catch (error) {
    next(error);
  }
});

export default router; 