import { query } from '../config/db.js';
import { sendAccountAlert } from './messaging.js';

export async function notify(io, userId, type, message, email, phone) {
  await query('INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)', [userId, type, message]);
  const notification = { userId, type, message, createdAt: new Date() };
  io.to(`user:${userId}`).emit('notification', notification);
  let recipientPhone = phone;
  if (!recipientPhone) {
    const [user] = await query('SELECT phone FROM users WHERE user_id = ?', [userId]);
    recipientPhone = user?.phone;
  }
  void sendAccountAlert({ email, phone: recipientPhone, subject: 'SmartPark update', message }).catch((error) => console.error('Email notification failed:', error.message));
}
