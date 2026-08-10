export function requireAdmin(req, res, next) {
  return req.user?.role === 'admin'
    ? next()
    : res.status(403).json({ success: false, message: 'Administrator access required' });
}
