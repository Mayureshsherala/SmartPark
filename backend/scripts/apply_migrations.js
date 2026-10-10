import { query, pool } from '../config/db.js';

async function applyMigrations() {
  try {
    console.log('Checking database columns in `bookings` table...');
    const columns = await query("SHOW COLUMNS FROM bookings LIKE 'arrived_at'");
    
    if (columns.length === 0) {
      console.log("Adding missing column `arrived_at` to `bookings` table...");
      await query("ALTER TABLE bookings ADD COLUMN arrived_at DATETIME NULL");
      console.log("Successfully added `arrived_at` column to `bookings` table!");
    } else {
      console.log("Column `arrived_at` already exists in `bookings` table.");
    }
  } catch (err) {
    console.error('Error applying migration:', err);
  } finally {
    await pool.end();
  }
}

applyMigrations();
