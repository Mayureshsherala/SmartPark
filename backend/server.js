import 'dotenv/config';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { query } from './config/db.js';
import { calculateBill } from './utils/billing.js';
import { notify } from './utils/notify.js';
import { requireHardwareKey } from './middleware/hardware.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import slotRoutes from './routes/slots.js';
import sessionRoutes from './routes/sessions.js';
import managementRoutes from './routes/management.js';

const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
const corsOptions = { origin(origin, callback) { if (!origin || allowedOrigins.includes(origin)) return callback(null, true); return callback(new Error('Origin is not allowed by CORS')); }, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], credentials: true };
const app = express(); app.set('trust proxy', 1); const server = http.createServer(app); const io = new Server(server, { cors: corsOptions });
const dirname = path.dirname(fileURLToPath(import.meta.url));
let lastHardwareHeartbeat = Date.now(); let hardwareDisconnected = false;
const validHardwareSlot = (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 6;

async function getRfidScanAction({ slot, uid }) {
  if (!validHardwareSlot(slot)) return { status: 400, message: 'Slot must be from 1 to 6' };
  const [parkingSlot] = await query('SELECT slot_id, status, current_user_id, current_session FROM slots WHERE slot_id = ?', [Number(slot)]);
  if (!parkingSlot) return { status: 404, message: 'Parking slot not found' };

  // 1. Exit Flow: Active Session at this slot
  if (parkingSlot.current_session) {
    const [session] = await query('SELECT ps.session_id, ps.user_id, ps.entry_time, ps.registered_hours, ps.payment_status, ps.exit_authorization_expires_at, u.pass_type, u.email, u.rfid_uid FROM parking_sessions ps JOIN users u ON u.user_id = ps.user_id WHERE ps.session_id = ? AND ps.exit_time IS NULL', [parkingSlot.current_session]);
    if (!session) return { status: 404, message: 'Active parking session not found' };

    const normalizedScannedUid = String(uid || '').replace(/\s+/g, '').toUpperCase();
    const normalizedUserUid = String(session.rfid_uid || '').replace(/\s+/g, '').toUpperCase();
    if (normalizedUserUid && normalizedScannedUid !== normalizedUserUid) {
      return { status: 403, message: 'This RFID card does not own the active parking session' };
    }

    if (session.payment_status === 'paid' || (session.exit_authorization_expires_at && new Date(session.exit_authorization_expires_at) > new Date())) {
      await query("UPDATE slots SET gate_status = 'open', last_updated = NOW() WHERE slot_id = ?", [Number(slot)]);
      io.emit('gateCommand', { slot: Number(slot), action: 'open' });
      return { status: 200, action: 'open_exit_gate', message: 'Exit payment completed. Gate opened!' };
    }

    const bill = calculateBill({ entryTime: session.entry_time, registeredHours: session.registered_hours, passType: session.pass_type, normalRate: process.env.NORMAL_RATE || 20, overtimeRate: process.env.OVERTIME_RATE || 40 });

    // FASTag Auto-Deduction on RFID Exit Scan
    const [fastag] = await query("SELECT * FROM fastag_accounts WHERE user_id = ? AND status = 'active'", [session.user_id]);
    if (fastag && Number(fastag.wallet_balance) >= bill.totalAmount) {
      const reference = `FASTAG_AUTO_EXIT_${Date.now()}`;
      const paymentRes = await query("INSERT INTO payments (session_id, user_id, amount, payment_mode, payment_time, razorpay_id, status) VALUES (?, ?, ?, 'fastag', NOW(), ?, 'success')", [session.session_id, session.user_id, bill.totalAmount, reference]);
      await query('UPDATE fastag_accounts SET wallet_balance = wallet_balance - ? WHERE fastag_id = ?', [bill.totalAmount, fastag.fastag_id]);
      await query("INSERT INTO fastag_transactions (fastag_id, payment_id, amount, transaction_type, reference_number, description) VALUES (?, ?, ?, 'debit', ?, ?)", [fastag.fastag_id, paymentRes.insertId, bill.totalAmount, reference, `Auto FASTag exit for Session #${session.session_id}`]);
      await query("UPDATE parking_sessions SET payment_status = 'paid', payment_mode = 'fastag', total_hours = ?, base_amount = ?, overtime_amount = ?, total_amount = ?, exit_authorization_expires_at = DATE_ADD(NOW(), INTERVAL 2 MINUTE) WHERE session_id = ?", [bill.totalHours, bill.baseAmount, bill.overtimeAmount, bill.totalAmount, session.session_id]);
      await query("UPDATE slots SET gate_status = 'open', last_updated = NOW() WHERE slot_id = ?", [Number(slot)]);
      io.emit('gateCommand', { slot: Number(slot), action: 'open' });
      await notify(io, session.user_id, 'exit_authorized', `FASTag auto-deducted Rs.${bill.totalAmount}. Gate opened for two minutes!`, session.email);
      return { status: 200, action: 'open_exit_gate', message: `FASTag auto-deducted Rs.${bill.totalAmount}. Gate opened!` };
    }

    await query('UPDATE parking_sessions SET exit_requested_at = NOW(), total_hours = ?, base_amount = ?, overtime_amount = ?, total_amount = ? WHERE session_id = ?', [bill.totalHours, bill.baseAmount, bill.overtimeAmount, bill.totalAmount, session.session_id]);
    await query("UPDATE slots SET gate_status = 'closed', last_updated = NOW() WHERE slot_id = ?", [Number(slot)]);
    await notify(io, session.user_id, 'exit_payment_required', `Exit requested for Slot ${slot}. Pay Rs.${bill.totalAmount} online to open the gate for two minutes.`, session.email);
    io.emit('exitPaymentRequested', { sessionId: session.session_id, slot: Number(slot), amount: bill.totalAmount });
    io.to(`user:${session.user_id}`).emit('exitPaymentRequested', { sessionId: session.session_id, slot: Number(slot), amount: bill.totalAmount });
    return { status: 202, action: 'payment_required', message: `Pay Rs.${bill.totalAmount} online to exit.` };
  }

  // 2. Reservation Entry Flow
  const [booking] = await query(
    "SELECT booking_id, user_id, arrived_at, payment_status, status FROM bookings WHERE slot_number = ? AND status IN ('pending', 'active') ORDER BY created_at DESC LIMIT 1",
    [Number(slot)]
  );

  if (booking) {
    if (booking.payment_status !== 'paid') {
      return { status: 402, message: 'Pre-booking advance payment is required' };
    }
    if (!booking.arrived_at) {
      return { status: 403, message: 'Press "Arrived at Slot" on website first to unlock RFID scanner' };
    }

    // Dynamically assign scanned RFID tag UID to this user & notify via Email
    let userName = 'User';
    if (uid) {
      const cleanUid = String(uid).trim();
      await query("UPDATE users SET rfid_uid = ?, status = 'active' WHERE user_id = ?", [cleanUid, booking.user_id]);
      const [u] = await query('SELECT email, phone, name FROM users WHERE user_id = ?', [booking.user_id]);
      userName = u?.name || 'User';
      await notify(
        io,
        booking.user_id,
        'rfid_assigned',
        `RFID Tag '${cleanUid}' has been assigned to your account for Booking #${booking.booking_id} at Slot P-${String(slot).padStart(2, '0')}. The barrier gate is now OPEN. Drive in now.`,
        u?.email,
        u?.phone
      );
    }

    await query("UPDATE slots SET gate_status = 'open', last_updated = NOW() WHERE slot_id = ?", [Number(slot)]);
    io.emit('gateCommand', { slot: Number(slot), action: 'open' });
    return { status: 202, action: 'awaiting_vehicle', message: `RFID Tag '${String(uid).trim()}' assigned to ${userName}. Gate open! Drive in now.` };
  }

  // 3. Free Walk-in Entry
  if (parkingSlot.status !== 'free') return { status: 409, message: 'Slot is not available' };
  
  if (uid) {
    const [existingUser] = await query("SELECT user_id FROM users WHERE REPLACE(rfid_uid, ' ', '') = REPLACE(?, ' ', '') AND status = 'active'", [uid]);
    if (!existingUser) {
      const [firstUser] = await query("SELECT user_id FROM users WHERE status = 'active' ORDER BY user_id ASC LIMIT 1");
      if (firstUser) await query("UPDATE users SET rfid_uid = ? WHERE user_id = ?", [String(uid).trim(), firstUser.user_id]);
    }
  }

  await query("UPDATE slots SET gate_status = 'open', last_updated = NOW() WHERE slot_id = ?", [Number(slot)]);
  io.emit('gateCommand', { slot: Number(slot), action: 'open' });
  return { status: 202, action: 'awaiting_vehicle', message: 'RFID accepted. Gate open! Park within 10 seconds.' };
}
app.set('io', io); app.use(cors(corsOptions)); app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); }); app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { if (req.originalUrl === '/api/phonepe/webhook') req.rawBody = Buffer.from(buffer); } })); app.use(rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false }));
app.get('/api/health', async (_req, res) => { try { await query('SELECT 1'); return res.json({ success: true, data: { database: 'connected', uptime: process.uptime() } }); } catch { return res.status(503).json({ success: false, message: 'Database unavailable' }); } });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' } });
app.use('/api/auth/login', loginLimiter); app.use('/api/auth', authRoutes); app.use('/api/event', eventRoutes);
app.get('/api/hardware/gates', requireHardwareKey, async (_req, res, next) => { try { const gates = await query('SELECT s.slot_id, s.gate_status, ps.exit_authorization_expires_at FROM slots s LEFT JOIN parking_sessions ps ON ps.session_id = s.current_session ORDER BY s.slot_id'); return res.json({ success: true, data: gates }); } catch (error) { return next(error); } });
app.post('/api/hardware/event', requireHardwareKey, async (req, res, next) => { try { const originalEvent = req.body || {}; await query('INSERT INTO hardware_events (event_type, slot_number, uid, payload) VALUES (?, ?, ?, ?)', [originalEvent.event || 'unknown', originalEvent.slot || null, originalEvent.uid || null, JSON.stringify(originalEvent)]); if (originalEvent.event === 'unknown_rfid') { io.to('admin').emit('unknownRFID', { slot: Number(originalEvent.slot), uid: originalEvent.uid, timestamp: originalEvent.timestamp || new Date() }); io.to('admins').emit('unknownRFID', { slot: Number(originalEvent.slot), uid: originalEvent.uid, timestamp: originalEvent.timestamp || new Date() }); return res.status(202).json({ success: true, data: {}, message: 'Unknown RFID alert recorded' }); } if (originalEvent.event === 'rfid_scan') { const result = await getRfidScanAction(originalEvent); return res.status(result.status).json({ success: result.status < 300, data: { action: result.action || null }, message: result.message }); } if (originalEvent.event === 'heartbeat') { lastHardwareHeartbeat = Date.now(); hardwareDisconnected = false; req.body = { event: 'status', slots: (originalEvent.slots || []).map((slot) => slot.status === 'occupied' ? 1 : 0) }; } else if (originalEvent.event === 'ir_timeout') req.body = { ...originalEvent, event: 'release' }; else if (originalEvent.event === 'entry') req.body = { ...originalEvent, hours: originalEvent.registered_hours || originalEvent.hours || 1 }; req.url = '/'; return eventRoutes(req, res, next); } catch (error) { return next(error); } });
app.use('/api/slots', slotRoutes); app.use('/api/sessions', sessionRoutes); app.post('/api/gate', (req, res, next) => { req.url = '/gate'; return slotRoutes(req, res, next); }); app.use('/api', managementRoutes);
io.on('connection', (socket) => { socket.join('public'); socket.on('joinRoom', (userId) => { socket.join(`user:${userId}`); socket.join(`user_${userId}`); }); socket.on('adminJoin', () => { socket.join('admins'); socket.join('admin'); }); socket.emit('connected', { timestamp: new Date() }); });
setInterval(async () => { try { const slots = await query('SELECT slot_id, status, gate_status, last_updated FROM slots ORDER BY slot_id'); const timestamp = new Date(); io.emit('allSlots', { slots }); io.emit('heartbeatSync', { slots, timestamp }); const occupied = slots.filter((slot) => slot.status === 'occupied').length; io.emit('occupancyRate', { percentage: Math.round((occupied / 6) * 100) }); if (Date.now() - lastHardwareHeartbeat > 15_000 && !hardwareDisconnected) { hardwareDisconnected = true; io.to('admin').emit('hardwareDisconnect', { timestamp }); io.to('admins').emit('hardwareDisconnect', { timestamp }); } } catch { /* database health endpoint reports unavailable data */ } }, 5_000);
setInterval(async () => { try { await query("UPDATE slots s JOIN parking_sessions ps ON ps.session_id = s.current_session SET s.gate_status = 'closed', s.last_updated = NOW() WHERE ps.exit_time IS NULL AND ps.exit_authorization_expires_at IS NOT NULL AND ps.exit_authorization_expires_at <= NOW() AND s.gate_status = 'open'"); } catch { /* retry on next interval */ } }, 5_000);
setInterval(async () => { try { const activeSessions = await query("SELECT ps.session_id, ps.slot_number, ps.entry_time, ps.registered_hours, u.pass_type FROM parking_sessions ps JOIN users u ON u.user_id = ps.user_id WHERE ps.exit_time IS NULL"); for (const session of activeSessions) { const bill = calculateBill({ entryTime: session.entry_time, registeredHours: session.registered_hours, passType: session.pass_type, normalRate: process.env.NORMAL_RATE || 20, overtimeRate: process.env.OVERTIME_RATE || 40 }); io.emit('billTick', { slot: session.slot_number, current_bill: bill.totalAmount, is_overtime: bill.overtimeHours > 0, elapsed_minutes: Math.round(bill.totalHours * 60), session_id: session.session_id }); } } catch { /* retry on next interval */ } }, 1_000);
const publicDir = path.join(dirname, 'public'); app.use(express.static(publicDir)); app.get('*', (req, res, next) => req.path.startsWith('/api') ? next() : res.sendFile(path.join(publicDir, 'index.html'), (error) => { if (error) next(); }));
app.use((error, _req, res, _next) => { console.error(error); res.status(error.status || 500).json({ success: false, message: error.message || 'Unexpected server error' }); });
const port = Number(process.env.PORT || 3000); server.listen(port, '0.0.0.0', () => console.log(`SmartPark server listening on http://0.0.0.0:${port}`));

