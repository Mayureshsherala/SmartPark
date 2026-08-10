import { query } from '../config/db.js';
import { notify } from './notify.js';

const formatArrival = (value) => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function bookingAlerts(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || !req.user?.userId) return;
    const userId = req.user.userId;

    if (req.method === 'POST' && req.path === '/booking') {
      void (async () => {
        const [booking] = await query('SELECT b.*, u.email, u.phone FROM bookings b JOIN users u ON u.user_id = b.user_id WHERE b.user_id = ? ORDER BY b.booking_id DESC LIMIT 1', [userId]);
        if (!booking) return;
        const paymentNote = booking.payment_status === 'paid' ? ' Your monthly pass has reserved the slot.' : ` Pay Rs.${booking.amount_paid} to confirm it.`;
        await notify(req.app.get('io'), userId, 'booking_created', `Booking #${booking.booking_id} created for Slot ${booking.slot_number} on ${formatArrival(booking.expected_arrival)}.${paymentNote}`, booking.email, booking.phone);
      })().catch((error) => console.error('Booking notification failed:', error.message));
    }

    if (req.method === 'POST' && req.path === '/payment/verify' && req.body.bookingId) {
      void (async () => {
        const [booking] = await query("SELECT b.*, u.email, u.phone FROM bookings b JOIN users u ON u.user_id = b.user_id WHERE b.booking_id = ? AND b.user_id = ? AND b.payment_status = 'paid'", [req.body.bookingId, userId]);
        if (!booking) return;
        await notify(req.app.get('io'), userId, 'payment_success', `Payment of Rs.${booking.amount_paid} received for Booking #${booking.booking_id}. Slot ${booking.slot_number} is reserved.`, booking.email, booking.phone);
      })().catch((error) => console.error('Payment notification failed:', error.message));
    }
  });
  next();
}
