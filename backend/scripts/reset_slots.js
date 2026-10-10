import { query, pool } from '../config/db.js';

async function resetSlots() {
  try {
    console.log('Resetting all slots to free...');
    
    // 1. Close all active parking sessions
    const sessionsRes = await query("UPDATE parking_sessions SET exit_time = COALESCE(exit_time, NOW()) WHERE exit_time IS NULL");
    console.log(`Updated active parking sessions: ${sessionsRes.affectedRows}`);

    // 2. Complete active/pending bookings
    const bookingsRes = await query("UPDATE bookings SET status = 'completed' WHERE status IN ('pending', 'active', 'reserved', 'paid')");
    console.log(`Updated active/pending bookings: ${bookingsRes.affectedRows}`);

    // 3. Reset all slots to free and clear current_user_id, current_session
    const slotsRes = await query("UPDATE slots SET status = 'free', current_user_id = NULL, current_session = NULL, gate_status = 'open', last_updated = NOW()");
    console.log(`Reset slots: ${slotsRes.affectedRows}`);

    console.log('Successfully freed all slots!');
  } catch (err) {
    console.error('Error resetting slots:', err);
  } finally {
    await pool.end();
  }
}

resetSlots();
