export function requireHardwareKey(req, res, next) {
  const expectedKey = process.env.HARDWARE_API_KEY;
  const receivedKey = req.get('X-Hardware-Key');
  if (!expectedKey || receivedKey !== expectedKey) return res.status(401).json({ success: false, message: 'Invalid hardware API key' });
  return next();
}
