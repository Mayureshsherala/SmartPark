import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import QRCode from 'qrcode';
import { query, withTransaction } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { notify } from '../utils/notify.js';
import { sendBookingConfirmation, sendBookingPaymentReceipt } from '../utils/pdf.js';
import { bookingAlerts } from '../utils/bookingAlerts.js';
import { createPhonePeCheckout, getPhonePeOrderStatus, isPhonePeConfigured } from '../utils/phonepe.js';

const router = Router(); const admin = [authenticate, requireAdmin];
router.use(bookingAlerts);
const PREBOOKING_ADVANCE = 20;

const phonePeRedirectUrl = (merchantOrderId) => {
  const origin = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0];
  const redirect = new URL(process.env.PHONEPE_REDIRECT_URL || origin);
  redirect.searchParams.set('phonepeOrder', merchantOrderId);
  return redirect.toString();
};

const phonePeDetails = (payload) => Array.isArray(payload?.paymentDetails) ? payload.paymentDetails[0] : null;

const settlePhonePeOrder = async ({ merchantOrderId, statusPayload, app }) => {
  const state = String(statusPayload?.state || 'PENDING').toUpperCase();
  if (state !== 'COMPLETED') {
    await query('UPDATE phonepe_payment_attempts SET state = ?, response_payload = ? WHERE merchant_order_id = ?', [state, JSON.stringify(statusPayload), merchantOrderId]);
    return { state, paid: false };
  }
  const details = phonePeDetails(statusPayload);
  const result = await withTransaction(async (connection) => {
    const [[attempt]] = await connection.execute('SELECT * FROM phonepe_payment_attempts WHERE merchant_order_id = ? FOR UPDATE', [merchantOrderId]);
    if (!attempt) throw Object.assign(new Error('PhonePe payment attempt was not found'), { status: 404 });
    if (Number(statusPayload.amount) !== Number(attempt.amount_paisa)) throw Object.assign(new Error('PhonePe payment amount does not match this booking'), { status: 409 });
    if (attempt.state === 'COMPLETED') return { paid: false, attempt, booking: null };
    const [[booking]] = await connection.execute('SELECT * FROM bookings WHERE booking_id = ? AND user_id = ? FOR UPDATE', [attempt.booking_id, attempt.user_id]);
    if (!booking || booking.status !== 'pending') throw Object.assign(new Error('This booking can no longer be paid'), { status: 409 });
    if (booking.payment_status === 'paid') {
      await connection.execute('UPDATE phonepe_payment_attempts SET state = ?, phonepe_order_id = ?, phonepe_transaction_id = ?, response_payload = ? WHERE merchant_order_id = ?', ['COMPLETED', statusPayload.orderId || null, details?.transactionId || null, JSON.stringify(statusPayload), merchantOrderId]);
      return { paid: false, attempt, booking };
    }
    const [reservation] = await connection.execute("UPDATE slots SET status = 'reserved', last_updated = NOW() WHERE slot_id = ? AND status = 'free'", [booking.slot_number]);
    if (!reservation.affectedRows) throw Object.assign(new Error('Selected slot is no longer available'), { status: 409 });
    const reference = details?.transactionId || statusPayload.orderId || merchantOrderId;
    await connection.execute("INSERT INTO payments (user_id, booking_id, amount, payment_mode, payment_time, razorpay_id, status) VALUES (?, ?, ?, 'phonepe_upi', NOW(), ?, 'success')", [attempt.user_id, booking.booking_id, Number(attempt.amount_paisa) / 100, reference]);
    await connection.execute("UPDATE bookings SET payment_status = 'paid', razorpay_id = ? WHERE booking_id = ?", [reference, booking.booking_id]);
    await connection.execute('UPDATE phonepe_payment_attempts SET state = ?, phonepe_order_id = ?, phonepe_transaction_id = ?, response_payload = ? WHERE merchant_order_id = ?', ['COMPLETED', statusPayload.orderId || null, details?.transactionId || null, JSON.stringify(statusPayload), merchantOrderId]);
    return { paid: true, attempt, booking };
  });
  if (result.paid) {
    const [user] = await query('SELECT email, phone FROM users WHERE user_id = ?', [result.attempt.user_id]);
    app.get('io').emit('slotStatusChange', { slot: Number(result.booking.slot_number), status: 'reserved', user_name: 'Reserved' });
    await notify(app.get('io'), result.attempt.user_id, 'phonepe_payment', `PhonePe UPI payment of Rs.${PREBOOKING_ADVANCE} completed for Booking #${result.booking.booking_id}. Slot ${result.booking.slot_number} is reserved.`, user?.email, user?.phone);
  }
  return { state, paid: result.paid, booking: result.booking };
};

router.post('/booking', authenticate, async (req, res, next) => {
  try {
    const { slotNumber, expectedArrival, durationHours, vehicleNumber, notes } = req.body;
    const arrival = new Date(expectedArrival);
    const duration = Number(durationHours);
    if (!slotNumber || Number(slotNumber) < 1 || Number(slotNumber) > 6 || !Number.isInteger(duration) || duration < 1 || duration > 12 || Number.isNaN(arrival.getTime())) return res.status(400).json({ success: false, message: 'Choose a valid slot, arrival time, and duration between 1 and 12 hours' });
    if (arrival < new Date(Date.now() - 5 * 60 * 1000) || arrival > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) return res.status(400).json({ success: false, message: 'Bookings can start now and must be scheduled within the next 7 days' });
    const [user] = await query('SELECT status FROM users WHERE user_id = ?', [req.user.userId]);
    if (!user || user.status === 'blocked') return res.status(403).json({ success: false, message: 'Your account is blocked from making bookings' });
    const [slot] = await query('SELECT status FROM slots WHERE slot_id = ?', [slotNumber]);
    if (!slot || slot.status !== 'free') return res.status(409).json({ success: false, message: 'Selected slot is unavailable' });
    const activeBookings = await query("SELECT booking_id FROM bookings WHERE user_id = ? AND status IN ('pending', 'active')", [req.user.userId]);
    if (activeBookings.length) return res.status(409).json({ success: false, message: 'Only one active booking is allowed at a time' });
    const overlap = await query("SELECT booking_id FROM bookings WHERE slot_number = ? AND status IN ('pending', 'active') AND expected_arrival < DATE_ADD(?, INTERVAL ? HOUR) AND DATE_ADD(expected_arrival, INTERVAL duration_hours HOUR) > ?", [slotNumber, arrival, duration, arrival]);
    if (overlap.length) return res.status(409).json({ success: false, message: 'This slot is already reserved for the selected period' });
    const result = await query("INSERT INTO bookings (user_id, slot_number, booking_date, expected_arrival, booking_expires_at, duration_hours, notes, status, amount_paid, payment_status, vehicle_number) VALUES (?, ?, NOW(), ?, DATE_ADD(?, INTERVAL 30 MINUTE), ?, ?, 'pending', ?, 'unpaid', ?)", [req.user.userId, slotNumber, arrival, arrival, duration, notes || null, PREBOOKING_ADVANCE, vehicleNumber?.toUpperCase() || null]);
    req.app.get('io').emit('newBooking', { slot: Number(slotNumber), user_name: 'Awaiting payment', arrival: arrival.toISOString() });
    return res.status(201).json({ success: true, data: { booking_id: result.insertId, amount: PREBOOKING_ADVANCE, payment_status: 'unpaid', reserved: false, duration_hours: duration }, message: `Pay the mandatory non-refundable Rs.20 online advance to reserve this ${duration}-hour slot.` });
  } catch (error) { return next(error); }
});

router.post('/payment/verify', authenticate, (req, res, next) => {
  if (req.body.bookingId && String(req.body.mode || '').toLowerCase() === 'cash') return res.status(400).json({ success: false, message: 'Pre-bookings require an online Rs.20 advance payment' });
  return next();
});

router.post('/refunds/request', authenticate, async (req, res, next) => {
  try {
    const [payment] = await query('SELECT booking_id FROM payments WHERE payment_id = ? AND user_id = ?', [Number(req.body.paymentId), req.user.userId]);
    if (payment?.booking_id) return res.status(400).json({ success: false, message: 'The Rs.20 pre-booking advance is non-refundable' });
    return next();
  } catch (error) { return next(error); }
});
router.post('/booking', authenticate, async (req, res, next) => { try { const { slotNumber, expectedArrival, durationHours, vehicleNumber, notes } = req.body; const arrival = new Date(expectedArrival); if (!slotNumber || Number(slotNumber) < 1 || Number(slotNumber) > 6 || !Number.isInteger(Number(durationHours)) || Number(durationHours) < 1 || Number(durationHours) > 12 || Number.isNaN(arrival.getTime())) return res.status(400).json({ success: false, message: 'Choose a valid slot, arrival time, and duration between 1 and 12 hours' }); if (arrival < new Date() || arrival > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) return res.status(400).json({ success: false, message: 'Bookings must be scheduled within the next 7 days' }); const [user] = await query('SELECT status, pass_type FROM users WHERE user_id = ?', [req.user.userId]); if (!user || user.status === 'blocked') return res.status(403).json({ success: false, message: 'Your account is blocked from making bookings' }); const [slot] = await query('SELECT status FROM slots WHERE slot_id = ?', [slotNumber]); if (!slot || slot.status !== 'free') return res.status(409).json({ success: false, message: 'Selected slot is unavailable' }); const activeBookings = await query("SELECT booking_id FROM bookings WHERE user_id = ? AND status IN ('pending', 'active')", [req.user.userId]); if (activeBookings.length) return res.status(409).json({ success: false, message: 'Only one active booking is allowed at a time' }); const overlap = await query("SELECT booking_id FROM bookings WHERE slot_number = ? AND status IN ('pending', 'active') AND expected_arrival < DATE_ADD(?, INTERVAL ? HOUR) AND DATE_ADD(expected_arrival, INTERVAL duration_hours HOUR) > ?", [slotNumber, arrival, durationHours, arrival]); if (overlap.length) return res.status(409).json({ success: false, message: 'This slot is already reserved for the selected period' }); const amount = user.pass_type === 'monthly' ? 0 : Number(durationHours) * Number(process.env.NORMAL_RATE || 20); const expires = new Date(arrival.getTime() + 30 * 60 * 1000); const result = await query("INSERT INTO bookings (user_id, slot_number, booking_date, expected_arrival, booking_expires_at, duration_hours, notes, status, amount_paid, payment_status, vehicle_number) VALUES (?, ?, NOW(), ?, ?, ?, ?, 'pending', ?, ?, ?)", [req.user.userId, slotNumber, arrival, expires, durationHours, notes || null, amount, user.pass_type === 'monthly' ? 'paid' : 'unpaid', vehicleNumber?.toUpperCase() || null]); if (amount === 0) { const reservation = await query("UPDATE slots SET status = 'reserved', last_updated = NOW() WHERE slot_id = ? AND status = 'free'", [slotNumber]); if (!reservation.affectedRows) { await query("UPDATE bookings SET status = 'cancelled' WHERE booking_id = ?", [result.insertId]); return res.status(409).json({ success: false, message: 'Selected slot is no longer available' }); } req.app.get('io').emit('slotStatusChange', { slot: Number(slotNumber), status: 'reserved', user_name: 'Reserved' }); } req.app.get('io').emit('newBooking', { slot: Number(slotNumber), user_name: 'Reserved', arrival: arrival.toISOString() }); return res.status(201).json({ success: true, data: { booking_id: result.insertId, amount, payment_status: user.pass_type === 'monthly' ? 'paid' : 'unpaid', reserved: amount === 0 }, message: amount === 0 ? 'Slot reserved with your monthly pass.' : 'Booking created. Continue to payment to reserve the slot.' }); } catch (error) { return next(error); } });
router.get('/booking/my', authenticate, async (req, res, next) => { try { return res.json({ success: true, data: await query('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC', [req.user.userId]) }); } catch (error) { return next(error); } });
router.get('/booking/admin/all', ...admin, async (_req, res, next) => { try { return res.json({ success: true, data: await query('SELECT b.*, u.name, u.email FROM bookings b JOIN users u ON u.user_id = b.user_id ORDER BY b.created_at DESC') }); } catch (error) { return next(error); } });
router.get('/booking/:id', authenticate, async (req, res, next) => { try { const [booking] = await query('SELECT * FROM bookings WHERE booking_id = ?', [req.params.id]); if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' }); if (booking.user_id !== req.user.userId && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Not permitted' }); return res.json({ success: true, data: booking }); } catch (error) { return next(error); } });
router.put('/booking/:id/cancel', authenticate, async (req, res, next) => { try { const [booking] = await query("SELECT * FROM bookings WHERE booking_id = ? AND status IN ('pending','active')", [req.params.id]); if (!booking) return res.status(404).json({ success: false, message: 'Cancellable booking not found' }); if (booking.user_id !== req.user.userId && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Not permitted' }); await withTransaction(async (connection) => { await connection.execute("UPDATE bookings SET status = 'cancelled' WHERE booking_id = ?", [booking.booking_id]); const [remaining] = await connection.execute("SELECT booking_id FROM bookings WHERE slot_number = ? AND booking_id <> ? AND status IN ('pending','active') LIMIT 1", [booking.slot_number, booking.booking_id]); if (!remaining.length) await connection.execute("UPDATE slots SET status = 'free', last_updated = NOW() WHERE slot_id = ? AND status = 'reserved'", [booking.slot_number]); }); req.app.get('io').emit('slotStatusChange', { slot: Number(booking.slot_number), status: 'free', user_name: null }); return res.json({ success: true, data: {}, message: 'Booking cancelled and slot released' }); } catch (error) { return next(error); } });
router.put('/booking/:id', authenticate, async (req, res, next) => { try { const arrival = new Date(req.body.expectedArrival); const [booking] = await query("SELECT * FROM bookings WHERE booking_id = ? AND status = 'pending'", [req.params.id]); if (!booking) return res.status(404).json({ success: false, message: 'Only pending bookings can be rescheduled' }); if (booking.user_id !== req.user.userId && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Not permitted' }); if (Number.isNaN(arrival.getTime()) || arrival < new Date() || arrival > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) return res.status(400).json({ success: false, message: 'Choose an arrival time within the next 7 days' }); const overlap = await query("SELECT booking_id FROM bookings WHERE slot_number = ? AND booking_id <> ? AND status IN ('pending', 'active') AND expected_arrival < DATE_ADD(?, INTERVAL ? HOUR) AND DATE_ADD(expected_arrival, INTERVAL duration_hours HOUR) > ?", [booking.slot_number, booking.booking_id, arrival, booking.duration_hours, arrival]); if (overlap.length) return res.status(409).json({ success: false, message: 'This slot is not available at the selected time' }); await query('UPDATE bookings SET expected_arrival = ?, booking_expires_at = DATE_ADD(?, INTERVAL 30 MINUTE) WHERE booking_id = ?', [arrival, arrival, booking.booking_id]); return res.json({ success: true, data: {}, message: 'Booking arrival time updated' }); } catch (error) { return next(error); } });
router.get('/booking/:id/confirmation', authenticate, async (req, res, next) => { try { const [booking] = await query('SELECT b.*, u.name FROM bookings b JOIN users u ON u.user_id = b.user_id WHERE b.booking_id = ?', [req.params.id]); if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' }); if (booking.user_id !== req.user.userId && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Not permitted' }); return sendBookingConfirmation(res, booking); } catch (error) { return next(error); } });
router.get('/booking/:id/payment-receipt', authenticate, async (req, res, next) => { try { const [booking] = await query('SELECT b.*, u.name, p.payment_id, p.payment_time, p.payment_mode, p.razorpay_id FROM bookings b JOIN users u ON u.user_id = b.user_id LEFT JOIN payments p ON p.payment_id = (SELECT payment_id FROM payments WHERE booking_id = b.booking_id AND status = \'success\' ORDER BY payment_time DESC LIMIT 1) WHERE b.booking_id = ?', [req.params.id]); if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' }); if (booking.user_id !== req.user.userId && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Not permitted' }); if (booking.payment_status !== 'paid') return res.status(409).json({ success: false, message: 'Payment receipt is available after payment completes' }); return sendBookingPaymentReceipt(res, booking); } catch (error) { return next(error); } });
router.post('/payment/order', authenticate, async (req, res, next) => { try { const { bookingId, sessionId, amount } = req.body; let payable = Number(amount); if (bookingId) { const [booking] = await query("SELECT amount_paid, status FROM bookings WHERE booking_id = ? AND user_id = ?", [bookingId, req.user.userId]); if (!booking || !['pending', 'active'].includes(booking.status)) return res.status(404).json({ success: false, message: 'Payable booking not found' }); payable = Number(booking.amount_paid); } if (!payable || payable <= 0) return res.status(400).json({ success: false, message: 'A valid amount is required' }); if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return res.json({ success: true, data: { demo: true, amount: payable * 100, receipt: `demo_${Date.now()}` }, message: 'Demo payment order created' }); const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }); const order = await razorpay.orders.create({ amount: Math.round(payable * 100), currency: 'INR', receipt: `park_${bookingId || sessionId || Date.now()}` }); return res.json({ success: true, data: { ...order, key: process.env.RAZORPAY_KEY_ID } }); } catch (error) { return next(error); } });
router.post('/payment/verify', authenticate, async (req, res, next) => { try { const { bookingId, sessionId, amount, razorpayPaymentId, razorpayOrderId, razorpaySignature, mode = 'online' } = req.body; if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) { if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) return res.status(400).json({ success: false, message: 'Payment gateway verification details are required' }); const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex'); if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature))) return res.status(400).json({ success: false, message: 'Payment verification failed' }); } let payable = Number(amount); let booking; if (bookingId) { [booking] = await query("SELECT booking_id, amount_paid, status, payment_status, slot_number FROM bookings WHERE booking_id = ? AND user_id = ?", [bookingId, req.user.userId]); if (!booking || !['pending', 'active'].includes(booking.status)) return res.status(404).json({ success: false, message: 'Payable booking not found' }); if (booking.payment_status === 'paid') return res.status(409).json({ success: false, message: 'This booking is already paid' }); payable = Number(booking.amount_paid); } if (!payable || payable < 0) return res.status(400).json({ success: false, message: 'A valid payment amount is required' }); await withTransaction(async (connection) => { if (bookingId) { const [reservation] = await connection.execute("UPDATE slots SET status = 'reserved', last_updated = NOW() WHERE slot_id = ? AND status = 'free'", [booking.slot_number]); if (!reservation.affectedRows) throw Object.assign(new Error('Selected slot is no longer available'), { status: 409 }); } await connection.execute('INSERT INTO payments (session_id, user_id, booking_id, amount, payment_mode, payment_time, razorpay_id, status) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)', [sessionId || null, req.user.userId, bookingId || null, payable, mode, razorpayPaymentId || null, 'success']); if (bookingId) await connection.execute("UPDATE bookings SET payment_status = 'paid', razorpay_id = ? WHERE booking_id = ? AND user_id = ?", [razorpayPaymentId || null, bookingId, req.user.userId]); if (sessionId) await connection.execute("UPDATE parking_sessions SET payment_status = 'paid', payment_mode = ? WHERE session_id = ? AND user_id = ?", [mode, sessionId, req.user.userId]); }); if (booking) req.app.get('io').emit('slotStatusChange', { slot: Number(booking.slot_number), status: 'reserved', user_name: 'Reserved' }); req.app.get('io').emit('paymentConfirmed', { bookingId, sessionId }); return res.json({ success: true, data: { slot_number: booking?.slot_number }, message: 'Payment verified and slot reserved' }); } catch (error) { return next(error); } });
router.post('/phonepe/booking/:id/initiate', authenticate, async (req, res, next) => {
  try {
    if (!isPhonePeConfigured()) return res.status(503).json({ success: false, message: 'PhonePe UAT is not configured. Add PHONEPE_CLIENT_ID and PHONEPE_CLIENT_SECRET to backend/.env.' });
    const [booking] = await query("SELECT b.*, u.phone FROM bookings b JOIN users u ON u.user_id = b.user_id WHERE b.booking_id = ? AND b.user_id = ?", [req.params.id, req.user.userId]);
    if (!booking || booking.status !== 'pending' || booking.payment_status === 'paid') return res.status(404).json({ success: false, message: 'An unpaid pending booking is required for PhonePe payment.' });
    const merchantOrderId = `SP_${booking.booking_id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const amountPaisa = Math.round(Number(booking.amount_paid) * 100);
    await query('INSERT INTO phonepe_payment_attempts (merchant_order_id, booking_id, user_id, amount_paisa) VALUES (?, ?, ?, ?)', [merchantOrderId, booking.booking_id, req.user.userId, amountPaisa]);
    let checkout;
    try {
      checkout = await createPhonePeCheckout({ merchantOrderId, amountPaisa, redirectUrl: phonePeRedirectUrl(merchantOrderId), phoneNumber: booking.phone, metaInfo: { udf1: String(booking.booking_id), udf2: String(req.user.userId), udf3: 'SmartPark' } });
    } catch (error) {
      await query('UPDATE phonepe_payment_attempts SET state = ? WHERE merchant_order_id = ?', ['INITIATION_FAILED', merchantOrderId]);
      throw error;
    }
    await query('UPDATE phonepe_payment_attempts SET phonepe_order_id = ?, state = ?, response_payload = ? WHERE merchant_order_id = ?', [checkout.orderId || null, checkout.state || 'PENDING', JSON.stringify(checkout), merchantOrderId]);
    return res.status(201).json({ success: true, data: { merchantOrderId, bookingId: booking.booking_id, amount: Number(booking.amount_paid), state: checkout.state || 'PENDING', redirectUrl: checkout.redirectUrl, expiresAt: checkout.expireAt }, message: 'PhonePe UAT checkout is ready. Complete the UPI payment on PhonePe.' });
  } catch (error) { return next(error); }
});
router.get('/phonepe/order/:merchantOrderId/status', authenticate, async (req, res, next) => {
  try {
    const [attempt] = await query('SELECT merchant_order_id FROM phonepe_payment_attempts WHERE merchant_order_id = ? AND user_id = ?', [req.params.merchantOrderId, req.user.userId]);
    if (!attempt) return res.status(404).json({ success: false, message: 'PhonePe payment attempt not found.' });
    const statusPayload = await getPhonePeOrderStatus(attempt.merchant_order_id);
    const result = await settlePhonePeOrder({ merchantOrderId: attempt.merchant_order_id, statusPayload, app: req.app });
    return res.json({ success: true, data: { merchantOrderId: attempt.merchant_order_id, state: result.state, paid: result.paid, bookingId: result.booking?.booking_id || null }, message: result.paid ? 'PhonePe payment completed and slot reserved.' : `PhonePe payment is ${result.state.toLowerCase()}.` });
  } catch (error) { return next(error); }
});
router.post('/phonepe/webhook', async (req, res) => {
  const providedSignature = String(req.headers['phonepe-checksum-signature'] || '').replace(/^sha256[=\s]/i, '');
  const authorization = String(req.headers.authorization || '').replace(/^sha256[=\s]/i, '');
  const rawPayload = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expectedSignature = process.env.PHONEPE_WEBHOOK_SECRET ? crypto.createHmac('sha256', process.env.PHONEPE_WEBHOOK_SECRET).update(rawPayload).digest('hex') : '';
  const expectedAuthorization = process.env.PHONEPE_WEBHOOK_USERNAME && process.env.PHONEPE_WEBHOOK_PASSWORD ? crypto.createHash('sha256').update(`${process.env.PHONEPE_WEBHOOK_USERNAME}:${process.env.PHONEPE_WEBHOOK_PASSWORD}`).digest('hex') : '';
  const matches = (actual, expected) => actual && expected && actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!matches(providedSignature, expectedSignature) && !matches(authorization, expectedAuthorization)) return res.status(401).json({ success: false, message: 'Invalid PhonePe webhook signature.' });
  const payload = req.body?.payload || req.body || {};
  const merchantOrderId = payload.merchantOrderId;
  if (!merchantOrderId) return res.status(400).json({ success: false, message: 'PhonePe webhook is missing merchantOrderId.' });
  res.status(202).json({ success: true, data: {}, message: 'PhonePe webhook accepted.' });
  getPhonePeOrderStatus(merchantOrderId).then((statusPayload) => settlePhonePeOrder({ merchantOrderId, statusPayload, app: req.app })).catch((error) => console.error('PhonePe webhook verification failed:', error.message));
});
router.get('/payment/history', authenticate, async (req, res, next) => { try { return res.json({ success: true, data: await query('SELECT * FROM payments WHERE user_id = ? ORDER BY payment_time DESC', [req.user.userId]) }); } catch (error) { return next(error); } });
router.get('/payments/admin/all', ...admin, async (_req, res, next) => { try { const payments = await query("SELECT p.*, u.name, u.email, b.slot_number, b.expected_arrival, b.duration_hours FROM payments p JOIN users u ON u.user_id = p.user_id LEFT JOIN bookings b ON b.booking_id = p.booking_id ORDER BY p.payment_time DESC"); return res.json({ success: true, data: payments }); } catch (error) { return next(error); } });
router.get('/users', ...admin, async (req, res, next) => { try { const { search = '', page = 1, limit = 20 } = req.query; const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100); const safeOffset = Math.max((Number.parseInt(page, 10) - 1) * safeLimit, 0); const rows = await query(`SELECT user_id, name, email, phone, vehicle_number, rfid_uid, status, pass_type, role, registered_date FROM users WHERE name LIKE ? OR email LIKE ? OR vehicle_number LIKE ? ORDER BY registered_date DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, [`%${search}%`, `%${search}%`, `%${search}%`]); return res.json({ success: true, data: rows }); } catch (error) { return next(error); } });
router.post('/users', ...admin, async (req, res, next) => { try { const { name, email, password, phone, vehicleNumber, role = 'user' } = req.body; const result = await query('INSERT INTO users (name, email, password, phone, vehicle_number, role) VALUES (?, ?, ?, ?, ?, ?)', [name, email, await bcrypt.hash(password || 'parking123', 12), phone || null, vehicleNumber || null, role]); return res.status(201).json({ success: true, data: { user_id: result.insertId }, message: 'User created' }); } catch (error) { return next(error); } });
router.put('/users/:id/block', ...admin, async (req, res, next) => { try { const status = req.body.blocked ? 'blocked' : 'active'; await query('UPDATE users SET status = ? WHERE user_id = ?', [status, req.params.id]); return res.json({ success: true, data: { status }, message: `User ${status}` }); } catch (error) { return next(error); } });
router.put('/users/:id/rfid', ...admin, async (req, res, next) => { try { const uid = req.body.rfidUid?.trim(); if (!uid) return res.status(400).json({ success: false, message: 'RFID UID is required' }); await query("UPDATE users SET rfid_uid = ?, status = 'active' WHERE user_id = ?", [uid, req.params.id]); const [user] = await query('SELECT name, email FROM users WHERE user_id = ?', [req.params.id]); if (user) await notify(req.app.get('io'), Number(req.params.id), 'rfid_assigned', 'Your RFID card is active. You can now park and book a slot.', user.email); return res.json({ success: true, data: {}, message: 'RFID card assigned and account activated' }); } catch (error) { return next(error); } });
router.put('/users/:id/pass', ...admin, async (req, res, next) => { try { await query('UPDATE users SET pass_type = ? WHERE user_id = ?', [req.body.passType === 'monthly' ? 'monthly' : 'normal', req.params.id]); return res.json({ success: true, data: {}, message: 'Pass type updated' }); } catch (error) { return next(error); } });
router.get('/notifications', authenticate, async (req, res, next) => { try { return res.json({ success: true, data: await query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.userId]) }); } catch (error) { return next(error); } });
router.put('/notifications/read', authenticate, async (req, res, next) => { try { await query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [req.user.userId]); return res.json({ success: true, data: {}, message: 'Notifications marked read' }); } catch (error) { return next(error); } });
router.delete('/notifications/:id', authenticate, async (req, res, next) => { try { await query('DELETE FROM notifications WHERE notif_id = ? AND user_id = ?', [req.params.id, req.user.userId]); return res.json({ success: true, data: {}, message: 'Notification deleted' }); } catch (error) { return next(error); } });
router.get('/rates', async (_req, res, next) => { try { const [rates] = await query('SELECT * FROM rates WHERE rate_id = 1'); return res.json({ success: true, data: rates }); } catch (error) { return next(error); } });
router.put('/rates', ...admin, async (req, res, next) => { try { const { normalRate, overtimeRate, peakRate, peakStart, peakEnd } = req.body; await query('UPDATE rates SET normal_rate = ?, overtime_rate = ?, peak_rate = ?, peak_start = ?, peak_end = ?, updated_at = NOW() WHERE rate_id = 1', [normalRate, overtimeRate, peakRate, peakStart, peakEnd]); return res.json({ success: true, data: {}, message: 'Rates updated' }); } catch (error) { return next(error); } });
router.get('/reports/:period', ...admin, async (req, res, next) => { try { const period = req.params.period; const periodSql = period === 'daily' ? 'DATE(entry_time) = CURDATE()' : period === 'weekly' ? 'entry_time >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)' : 'entry_time >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)'; const [summary] = await query(`SELECT COUNT(*) AS sessions, COALESCE(SUM(total_amount), 0) AS revenue, COALESCE(AVG(total_amount), 0) AS average_bill FROM parking_sessions WHERE ${periodSql}`); const chart = await query(`SELECT DATE(entry_time) AS date, COUNT(*) AS sessions, COALESCE(SUM(total_amount), 0) AS revenue FROM parking_sessions WHERE ${periodSql} GROUP BY DATE(entry_time) ORDER BY date`); return res.json({ success: true, data: { summary, chart } }); } catch (error) { return next(error); } });
router.get('/hardware/status', ...admin, async (_req, res, next) => { try { const [lastEvent] = await query('SELECT created_at, payload FROM hardware_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1', ['heartbeat']); const slots = await query('SELECT slot_id, label, status, gate_status, last_updated FROM slots ORDER BY slot_id'); let payload = {}; try { payload = typeof lastEvent?.payload === 'string' ? JSON.parse(lastEvent.payload) : lastEvent?.payload || {}; } catch { payload = {}; } return res.json({ success: true, data: { connected: Boolean(lastEvent) && Date.now() - new Date(lastEvent.created_at).getTime() < 15_000, lastHeartbeat: lastEvent?.created_at || null, components: payload.components || {}, firmware: payload.firmware || null, keypadHours: payload.keypadHours || 1, slots } }); } catch (error) { return next(error); } });
router.get('/hardware/events', ...admin, async (req, res, next) => { try { const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100); const events = await query('SELECT event_id, event_type, slot_number, uid, payload, created_at FROM hardware_events ORDER BY created_at DESC LIMIT ?', [limit]); return res.json({ success: true, data: events }); } catch (error) { return next(error); } });

router.get('/fastag/me', authenticate, async (req, res, next) => {
  try {
    const [account] = await query('SELECT fastag_id, tag_number, vehicle_number, provider_name, wallet_balance, status, linked_at FROM fastag_accounts WHERE user_id = ?', [req.user.userId]);
    return res.json({ success: true, data: account || null });
  } catch (error) { return next(error); }
});

router.post('/fastag/link', authenticate, async (req, res, next) => {
  try {
    const tagNumber = String(req.body.tagNumber || '').trim().toUpperCase();
    const vehicleNumber = String(req.body.vehicleNumber || '').trim().toUpperCase();
    if (tagNumber.length < 6 || !vehicleNumber) return res.status(400).json({ success: false, message: 'Provide a valid FASTag ID and vehicle number' });
    const [user] = await query('SELECT vehicle_number FROM users WHERE user_id = ?', [req.user.userId]);
    if (user?.vehicle_number && user.vehicle_number !== vehicleNumber) return res.status(400).json({ success: false, message: 'FASTag vehicle number must match your registered vehicle' });
    const [tagOwner] = await query('SELECT user_id FROM fastag_accounts WHERE tag_number = ?', [tagNumber]);
    if (tagOwner && tagOwner.user_id !== req.user.userId) return res.status(409).json({ success: false, message: 'This FASTag ID is already linked to another SmartPark account' });
    await query('INSERT INTO fastag_accounts (user_id, tag_number, vehicle_number) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE tag_number = VALUES(tag_number), vehicle_number = VALUES(vehicle_number), status = \'active\'', [req.user.userId, tagNumber, vehicleNumber]);
    const [account] = await query('SELECT fastag_id, tag_number, vehicle_number, provider_name, wallet_balance, status, linked_at FROM fastag_accounts WHERE user_id = ?', [req.user.userId]);
    return res.status(201).json({ success: true, data: account, message: 'FASTag linked in SmartPark demo mode with Rs.500 balance.' });
  } catch (error) { return next(error); }
});

router.post('/fastag/top-up', authenticate, async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 50 || amount > 5000) return res.status(400).json({ success: false, message: 'Top up an amount between Rs.50 and Rs.5,000' });
    const [account] = await query('SELECT * FROM fastag_accounts WHERE user_id = ? AND status = \'active\'', [req.user.userId]);
    if (!account) return res.status(404).json({ success: false, message: 'Link an active FASTag first' });
    const reference = `FASTAG_TOPUP_${crypto.randomUUID()}`;
    await withTransaction(async (connection) => { await connection.execute('UPDATE fastag_accounts SET wallet_balance = wallet_balance + ? WHERE fastag_id = ?', [amount, account.fastag_id]); await connection.execute('INSERT INTO fastag_transactions (fastag_id, amount, transaction_type, reference_number, description) VALUES (?, ?, \'credit\', ?, ?)', [account.fastag_id, amount, reference, 'Demo wallet top-up']); });
    const [updated] = await query('SELECT fastag_id, tag_number, vehicle_number, provider_name, wallet_balance, status, linked_at FROM fastag_accounts WHERE fastag_id = ?', [account.fastag_id]);
    return res.json({ success: true, data: updated, message: 'Demo FASTag wallet topped up successfully.' });
  } catch (error) { return next(error); }
});

router.post('/payment/qr/booking/:id', authenticate, async (req, res, next) => {
  try {
    const [booking] = await query("SELECT booking_id, amount_paid, payment_status, status FROM bookings WHERE booking_id = ? AND user_id = ?", [req.params.id, req.user.userId]);
    if (!booking || booking.status !== 'pending' || booking.payment_status === 'paid') return res.status(404).json({ success: false, message: 'An unpaid pending booking is required' });
    const upiId = process.env.UPI_ID || 'smartpark@upi';
    const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent('SmartPark Parking')}&am=${encodeURIComponent(Number(booking.amount_paid).toFixed(2))}&cu=INR&tn=${encodeURIComponent(`SmartPark Booking ${booking.booking_id}`)}`;
    return res.json({ success: true, data: { upiId, upiUrl, qrDataUrl: await QRCode.toDataURL(upiUrl, { width: 280, margin: 2 }), amount: Number(booking.amount_paid), bookingId: booking.booking_id }, message: 'Scan the QR in any UPI app, then confirm the demo payment.' });
  } catch (error) { return next(error); }
});

router.post('/fastag/pay/booking/:id', authenticate, async (req, res, next) => {
  try {
    const payment = await withTransaction(async (connection) => {
      const [[booking]] = await connection.execute("SELECT * FROM bookings WHERE booking_id = ? AND user_id = ? FOR UPDATE", [req.params.id, req.user.userId]);
      if (!booking || booking.status !== 'pending' || booking.payment_status === 'paid') throw Object.assign(new Error('An unpaid pending booking is required'), { status: 404 });
      const [[account]] = await connection.execute("SELECT * FROM fastag_accounts WHERE user_id = ? AND status = 'active' FOR UPDATE", [req.user.userId]);
      if (!account) throw Object.assign(new Error('Link an active FASTag before paying'), { status: 404 });
      const amount = Number(booking.amount_paid);
      if (Number(account.wallet_balance) < amount) throw Object.assign(new Error('Insufficient FASTag balance. Top up your demo wallet first.'), { status: 409 });
      const [reservation] = await connection.execute("UPDATE slots SET status = 'reserved', last_updated = NOW() WHERE slot_id = ? AND status = 'free'", [booking.slot_number]);
      if (!reservation.affectedRows) throw Object.assign(new Error('Selected slot is no longer available'), { status: 409 });
      const reference = `FASTAG_${crypto.randomUUID()}`;
      const [paymentResult] = await connection.execute("INSERT INTO payments (user_id, booking_id, amount, payment_mode, payment_time, razorpay_id, status) VALUES (?, ?, ?, 'fastag', NOW(), ?, 'success')", [req.user.userId, booking.booking_id, amount, reference]);
      await connection.execute('UPDATE fastag_accounts SET wallet_balance = wallet_balance - ? WHERE fastag_id = ?', [amount, account.fastag_id]);
      await connection.execute("INSERT INTO fastag_transactions (fastag_id, payment_id, amount, transaction_type, reference_number, description) VALUES (?, ?, ?, 'debit', ?, ?)", [account.fastag_id, paymentResult.insertId, amount, reference, `Parking booking #${booking.booking_id}`]);
      await connection.execute("UPDATE bookings SET payment_status = 'paid', razorpay_id = ? WHERE booking_id = ?", [reference, booking.booking_id]);
      return { booking, amount, reference };
    });
    const [user] = await query('SELECT email, phone FROM users WHERE user_id = ?', [req.user.userId]);
    req.app.get('io').emit('slotStatusChange', { slot: Number(payment.booking.slot_number), status: 'reserved', user_name: 'Reserved' });
    await notify(req.app.get('io'), req.user.userId, 'fastag_payment', `FASTag payment of Rs.${payment.amount} completed for Booking #${payment.booking.booking_id}. Slot ${payment.booking.slot_number} is reserved.`, user?.email, user?.phone);
    return res.json({ success: true, data: { bookingId: payment.booking.booking_id, slotNumber: payment.booking.slot_number, reference: payment.reference }, message: 'FASTag payment completed and slot reserved.' });
  } catch (error) { return next(error); }
});

router.get('/refunds/me', authenticate, async (req, res, next) => { try { return res.json({ success: true, data: await query('SELECT r.*, p.payment_mode FROM refunds r JOIN payments p ON p.payment_id = r.payment_id WHERE r.user_id = ? ORDER BY r.created_at DESC', [req.user.userId]) }); } catch (error) { return next(error); } });
router.post('/refunds/request', authenticate, async (req, res, next) => {
  try {
    const paymentId = Number(req.body.paymentId); const reason = String(req.body.reason || '').trim();
    if (!paymentId || reason.length < 5) return res.status(400).json({ success: false, message: 'Provide a payment and refund reason' });
    const [payment] = await query("SELECT * FROM payments WHERE payment_id = ? AND user_id = ? AND status = 'success'", [paymentId, req.user.userId]);
    if (!payment) return res.status(404).json({ success: false, message: 'Eligible payment not found' });
    const existing = await query("SELECT refund_id FROM refunds WHERE payment_id = ? AND status IN ('requested','approved','processed')", [paymentId]);
    if (existing.length) return res.status(409).json({ success: false, message: 'A refund already exists for this payment' });
    const result = await query('INSERT INTO refunds (payment_id, booking_id, user_id, amount, reason) VALUES (?, ?, ?, ?, ?)', [payment.payment_id, payment.booking_id, req.user.userId, payment.amount, reason]);
    return res.status(201).json({ success: true, data: { refundId: result.insertId }, message: 'Refund request sent to the admin.' });
  } catch (error) { return next(error); }
});
router.get('/refunds/admin', ...admin, async (_req, res, next) => { try { return res.json({ success: true, data: await query('SELECT r.*, u.name, u.email, p.payment_mode FROM refunds r JOIN users u ON u.user_id = r.user_id JOIN payments p ON p.payment_id = r.payment_id ORDER BY r.created_at DESC') }); } catch (error) { return next(error); } });
router.put('/refunds/:id', ...admin, async (req, res, next) => {
  try {
    const action = req.body.action; const note = String(req.body.note || '').trim();
    if (!['approve', 'reject', 'process'].includes(action)) return res.status(400).json({ success: false, message: 'Choose approve, reject, or process' });
    const result = await withTransaction(async (connection) => {
      const [[refund]] = await connection.execute('SELECT r.*, p.payment_mode FROM refunds r JOIN payments p ON p.payment_id = r.payment_id WHERE r.refund_id = ? FOR UPDATE', [req.params.id]);
      if (!refund) throw Object.assign(new Error('Refund not found'), { status: 404 });
      if (action === 'reject') { if (refund.status !== 'requested') throw Object.assign(new Error('Only requested refunds can be rejected'), { status: 409 }); await connection.execute("UPDATE refunds SET status = 'rejected', admin_note = ?, processed_by = ?, processed_at = NOW() WHERE refund_id = ?", [note || 'Rejected by admin', req.user.userId, refund.refund_id]); return { ...refund, status: 'rejected' }; }
      if (action === 'approve') { if (refund.status !== 'requested') throw Object.assign(new Error('Only requested refunds can be approved'), { status: 409 }); await connection.execute("UPDATE refunds SET status = 'approved', admin_note = ?, processed_by = ? WHERE refund_id = ?", [note || 'Approved by admin', req.user.userId, refund.refund_id]); return { ...refund, status: 'approved' }; }
      if (refund.status !== 'approved') throw Object.assign(new Error('Approve the refund before processing it'), { status: 409 });
      const reference = `REFUND_${crypto.randomUUID()}`;
      if (refund.payment_mode === 'fastag') { const [[account]] = await connection.execute('SELECT * FROM fastag_accounts WHERE user_id = ? FOR UPDATE', [refund.user_id]); if (!account) throw Object.assign(new Error('FASTag account no longer exists'), { status: 409 }); await connection.execute('UPDATE fastag_accounts SET wallet_balance = wallet_balance + ? WHERE fastag_id = ?', [refund.amount, account.fastag_id]); await connection.execute("INSERT INTO fastag_transactions (fastag_id, payment_id, amount, transaction_type, reference_number, description) VALUES (?, ?, ?, 'credit', ?, ?)", [account.fastag_id, refund.payment_id, refund.amount, reference, `Refund #${refund.refund_id}`]); }
      await connection.execute("UPDATE refunds SET status = 'processed', admin_note = ?, provider_reference = ?, processed_by = ?, processed_at = NOW() WHERE refund_id = ?", [note || 'Refund processed', reference, req.user.userId, refund.refund_id]);
      return { ...refund, status: 'processed', providerReference: reference };
    });
    const [user] = await query('SELECT email, phone FROM users WHERE user_id = ?', [result.user_id]);
    await notify(req.app.get('io'), result.user_id, 'refund_update', `Refund #${result.refund_id} is ${result.status}.${result.status === 'processed' ? ` Reference: ${result.providerReference}.` : ''}`, user?.email, user?.phone);
    return res.json({ success: true, data: result, message: `Refund ${result.status}.` });
  } catch (error) { return next(error); }
});
export default router;
