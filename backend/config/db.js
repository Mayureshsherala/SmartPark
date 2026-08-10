import mysql from 'mysql2/promise';
import 'dotenv/config';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_parking', waitForConnections: true,
  connectionLimit: 10, timezone: '+05:30'
});

export const query = async (sql, values = []) => {
  const [rows] = await pool.execute(sql, values);
  return rows;
};

export const withTransaction = async (work) => {
  const connection = await pool.getConnection();
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
  catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
};
