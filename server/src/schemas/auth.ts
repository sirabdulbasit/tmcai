import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Invalid email format').optional(),
  empcode: z.string().min(1).max(50).optional(),
  password: z.string().min(1, 'Password is required').max(200),
}).refine(data => data.email || data.empcode, {
  message: 'email or empcode is required',
  path: ['email'],
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters').max(200),
});

export const createUserSchema = z.object({
  empcode: z.string().min(1, 'Employee code is required').max(50),
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(200),
  userType: z.enum(['SA', 'AD', 'ST', 'BS'], { message: 'Invalid userType. Must be: SA, AD, ST, or BS' }),
  department: z.string().max(100).optional(),
  clientNumber: z.string().max(20).optional(),
  // Demo expiry — optional. Non-null means demoExpirySuspendJob will
  // auto-suspend (is_active=false) at this time. ISO-8601 string;
  // the route parses to Date before persisting. NULL = permanent account.
  expiresAt: z.string().datetime().optional().nullable(),
});

export const setupPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(200),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email format'),
  baseUrl: z.string().url().optional(),
});
