import jwt from 'jsonwebtoken';

const cookieValue = (request, name) => request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);

export function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || cookieValue(req, 'smartpark_token');
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); return next(); }
  catch { return res.status(401).json({ success: false, message: 'Invalid or expired session' }); }
}

export const signToken = (user) => jwt.sign({ userId: user.user_id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
export const sessionCookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
