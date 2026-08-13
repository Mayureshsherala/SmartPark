import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { query } from '../config/db.js';
import { authenticate, sessionCookieOptions, signToken } from '../middleware/auth.js';
import { sendAccountAlert, sendEmail } from '../utils/messaging.js';

const router = Router();
const cleanUser = ({ password, ...user }) => user;
const validPassword = (value) => typeof value === 'string' && value.length >= 8 && /\d/.test(value);
const validPhone = (value) => /^\d{10}$/.test(String(value || '').replace(/\D/g, ''));
const normalizedEmail = (value) => String(value || '').trim().toLowerCase();
const hashOtp = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many OTP requests. Please try again in 15 minutes.' } });

const writeSession = (res, user) => { const accessToken = signToken(user); return res.cookie('smartpark_token', accessToken, sessionCookieOptions).json({ success: true, data: { user: cleanUser(user), accessToken }, message: 'Welcome back' }); };
const signLoginVerification = (user) => jwt.sign({ userId: user.user_id, type: 'login_verification' }, process.env.JWT_SECRET, { expiresIn: '10m' });

async function createOtp(user, purpose) {
  const code = crypto.randomInt(100000, 1000000).toString();
  await query('UPDATE auth_tokens SET used_at = NOW() WHERE email = ? AND purpose = ? AND used_at IS NULL', [user.email, purpose]);
  await query('INSERT INTO auth_tokens (user_id, email, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', [user.user_id, user.email, purpose, hashOtp(code)]);
  return code;
}

async function createAndSendOtp(user, purpose) {
  const code = await createOtp(user, purpose);
  const label = purpose === 'email_verification' ? 'email verification' : 'password reset';
  await sendAccountAlert({
    email: user.email,
    phone: user.phone,
    subject: `SmartPark ${label} OTP`,
    message: `Your SmartPark ${label} OTP is ${code}. It expires in 10 minutes. Do not share this code.`,
  });
}

async function createAndSendLoginOtp(user) {
  const emailCode = await createOtp(user, 'login_email');
  const delivered = await sendEmail({ to: user.email, subject: 'SmartPark login OTP', text: `Your SmartPark login OTP is ${emailCode}. It expires in 10 minutes. Do not share this code.` });
  if (!delivered) {
    const error = new Error('Email OTP delivery is not configured. Ask the administrator to set the SMTP variables in Railway.');
    error.status = 503;
    throw error;
  }
}

async function consumeOtp(email, purpose, code) {
  const [token] = await query('SELECT * FROM auth_tokens WHERE email = ? AND purpose = ? AND token_hash = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1', [email, purpose, hashOtp(code)]);
  if (!token) return null;
  await query('UPDATE auth_tokens SET used_at = NOW() WHERE token_id = ?', [token.token_id]);
  return token;
}

async function findOtp(email, purpose, code) {
  const [token] = await query('SELECT * FROM auth_tokens WHERE email = ? AND purpose = ? AND token_hash = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1', [email, purpose, hashOtp(code)]);
  return token || null;
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, phone, password, confirmPassword, vehicleNumber, vehicleType, vehicleColor, vehicleModel, acceptedTerms } = req.body;
    const accountEmail = normalizedEmail(email);
    if (!name?.trim() || !accountEmail || !validPhone(phone) || !validPassword(password)) return res.status(400).json({ success: false, message: 'Provide a name, valid 10-digit phone number, and password with at least 8 characters including a number' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ success: false, message: 'Passwords do not match' });
    if (acceptedTerms === false) return res.status(400).json({ success: false, message: 'Accept the terms before creating an account' });
    const existing = await query('SELECT user_id FROM users WHERE email = ?', [accountEmail]);
    if (existing.length) return res.status(409).json({ success: false, message: 'An account already uses this email' });
    const result = await query('INSERT INTO users (name, email, phone, password, vehicle_number, vehicle_type, vehicle_color, vehicle_model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [name.trim(), accountEmail, String(phone).replace(/\D/g, ''), await bcrypt.hash(password, 12), vehicleNumber?.toUpperCase() || null, vehicleType || 'car', vehicleColor || null, vehicleModel || null, 'pending_rfid']);
    const [user] = await query('SELECT * FROM users WHERE user_id = ?', [result.insertId]);
    await createAndSendOtp(user, 'email_verification');
    const accessToken = signToken(user);
    return res.status(201).cookie('smartpark_token', accessToken, sessionCookieOptions).json({ success: true, data: { user: cleanUser(user), accessToken }, message: 'Registration successful. Check your email for the verification OTP.' });
  } catch (error) { return next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const [user] = await query('SELECT * FROM users WHERE email = ?', [normalizedEmail(email)]);
    if (!user || !(await bcrypt.compare(password || '', user.password))) return res.status(401).json({ success: false, message: 'Invalid email or password' });
    if (user.status === 'blocked') return res.status(403).json({ success: false, message: 'Invalid email or password' });
    await createAndSendLoginOtp(user);
    return res.json({ success: true, data: { requiresLoginVerification: true, loginVerificationToken: signLoginVerification(user), email: user.email }, message: 'A login OTP was sent to your email.' });
  } catch (error) { return next(error); }
});

router.post('/login/resend', otpLimiter, async (req, res, next) => {
  let verification;
  try {
    verification = jwt.verify(req.body.loginVerificationToken || '', process.env.JWT_SECRET);
  } catch (error) { return res.status(401).json({ success: false, message: 'Login verification has expired. Please sign in again.' }); }
  if (verification.type !== 'login_verification') return res.status(401).json({ success: false, message: 'Invalid login verification request' });
  try {
    const [user] = await query('SELECT * FROM users WHERE user_id = ? AND status <> ?', [verification.userId, 'blocked']);
    if (!user) return res.status(401).json({ success: false, message: 'Login verification has expired' });
    await createAndSendLoginOtp(user);
    return res.json({ success: true, data: {}, message: 'A new login OTP was sent to your email.' });
  } catch (error) { return next(error); }
});

router.post('/login/verify', otpLimiter, async (req, res, next) => {
  try {
    const verification = jwt.verify(req.body.loginVerificationToken || '', process.env.JWT_SECRET);
    const { emailOtp } = req.body;
    if (verification.type !== 'login_verification' || !/^\d{6}$/.test(String(emailOtp || ''))) return res.status(400).json({ success: false, message: 'Enter the 6-digit email OTP' });
    const [user] = await query('SELECT * FROM users WHERE user_id = ? AND status <> ?', [verification.userId, 'blocked']);
    if (!user) return res.status(401).json({ success: false, message: 'Login verification has expired' });
    const emailToken = await findOtp(user.email, 'login_email', emailOtp);
    if (!emailToken) return res.status(400).json({ success: false, message: 'The OTP is invalid or expired' });
    await query('UPDATE auth_tokens SET used_at = NOW() WHERE token_id = ?', [emailToken.token_id]);
    return writeSession(res, user);
  } catch (error) { return res.status(401).json({ success: false, message: 'Login verification has expired. Please sign in again.' }); }
});

router.post('/email-verification/send', authenticate, otpLimiter, async (req, res, next) => {
  try {
    const [user] = await query('SELECT * FROM users WHERE user_id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    if (user.email_verified_at) return res.json({ success: true, data: {}, message: 'Email is already verified' });
    await createAndSendOtp(user, 'email_verification');
    return res.json({ success: true, data: {}, message: 'Verification OTP sent to your email' });
  } catch (error) { return next(error); }
});

router.post('/email-verification/confirm', authenticate, async (req, res, next) => {
  try {
    const code = String(req.body.code || '');
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ success: false, message: 'Enter the 6-digit OTP' });
    const [user] = await query('SELECT * FROM users WHERE user_id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    if (user.email_verified_at) return res.json({ success: true, data: { user: cleanUser(user) }, message: 'Email is already verified' });
    if (!await consumeOtp(user.email, 'email_verification', code)) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    await query('UPDATE users SET email_verified_at = NOW() WHERE user_id = ?', [user.user_id]);
    const [updatedUser] = await query('SELECT * FROM users WHERE user_id = ?', [user.user_id]);
    return res.json({ success: true, data: { user: cleanUser(updatedUser) }, message: 'Email verified successfully' });
  } catch (error) { return next(error); }
});

router.post('/password-reset/request', otpLimiter, async (req, res, next) => {
  try {
    const email = normalizedEmail(req.body.email);
    const [user] = await query('SELECT * FROM users WHERE email = ?', [email]);
    if (user) await createAndSendOtp(user, 'password_reset');
    return res.json({ success: true, data: {}, message: 'If that email is registered, a password-reset OTP has been sent.' });
  } catch (error) { return next(error); }
});

router.post('/password-reset/confirm', otpLimiter, async (req, res, next) => {
  try {
    const email = normalizedEmail(req.body.email);
    const code = String(req.body.code || '');
    const { newPassword, confirmPassword } = req.body;
    if (!/^\d{6}$/.test(code) || !validPassword(newPassword) || newPassword !== confirmPassword) return res.status(400).json({ success: false, message: 'Provide a valid OTP and matching password with at least 8 characters including a number' });
    const token = await consumeOtp(email, 'password_reset', code);
    if (!token) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    const [user] = await query('SELECT * FROM users WHERE user_id = ?', [token.user_id]);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    await query('UPDATE users SET password = ? WHERE user_id = ?', [await bcrypt.hash(newPassword, 12), user.user_id]);
    await sendAccountAlert({ email: user.email, phone: user.phone, subject: 'SmartPark password changed', message: 'Your SmartPark password was reset successfully. If this was not you, contact support immediately.' });
    return res.json({ success: true, data: {}, message: 'Password reset successfully. You can now log in.' });
  } catch (error) { return next(error); }
});

router.post('/logout', (_req, res) => res.clearCookie('smartpark_token', { path: '/' }).json({ success: true, data: {}, message: 'Logged out' }));
router.get('/me', authenticate, async (req, res, next) => { try { const [user] = await query('SELECT * FROM users WHERE user_id = ?', [req.user.userId]); return res.json({ success: true, data: cleanUser(user) }); } catch (error) { return next(error); } });
router.put('/profile', authenticate, async (req, res, next) => { try { const { name, phone, vehicleNumber, vehicleType, vehicleColor, vehicleModel, notificationPreferences } = req.body; if (phone && !validPhone(phone)) return res.status(400).json({ success: false, message: 'Phone must contain 10 digits' }); await query('UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), vehicle_number = COALESCE(?, vehicle_number), vehicle_type = COALESCE(?, vehicle_type), vehicle_color = COALESCE(?, vehicle_color), vehicle_model = COALESCE(?, vehicle_model), notification_preferences = COALESCE(?, notification_preferences) WHERE user_id = ?', [name, phone ? String(phone).replace(/\D/g, '') : null, vehicleNumber?.toUpperCase(), vehicleType, vehicleColor, vehicleModel, notificationPreferences ? JSON.stringify(notificationPreferences) : null, req.user.userId]); const [user] = await query('SELECT * FROM users WHERE user_id = ?', [req.user.userId]); return res.json({ success: true, data: cleanUser(user), message: 'Profile updated' }); } catch (error) { return next(error); } });
router.put('/password', authenticate, async (req, res, next) => { try { const { currentPassword, newPassword, confirmPassword } = req.body; const [user] = await query('SELECT * FROM users WHERE user_id = ?', [req.user.userId]); if (!user || !(await bcrypt.compare(currentPassword || '', user.password))) return res.status(400).json({ success: false, message: 'Current password is incorrect' }); if (!validPassword(newPassword) || (confirmPassword !== undefined && newPassword !== confirmPassword)) return res.status(400).json({ success: false, message: 'Use a matching password of at least 8 characters including a number' }); await query('UPDATE users SET password = ? WHERE user_id = ?', [await bcrypt.hash(newPassword, 12), req.user.userId]); await sendAccountAlert({ email: user.email, phone: user.phone, subject: 'SmartPark password changed', message: 'Your SmartPark password was changed. If this was not you, reset your password immediately.' }); return res.json({ success: true, data: {}, message: 'Password changed' }); } catch (error) { return next(error); } });
export default router;
