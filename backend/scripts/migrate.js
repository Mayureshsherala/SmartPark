import 'dotenv/config';
import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(dirname, '../../database/schema.sql');
const databaseConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_parking',
  multipleStatements: true,
};

async function createInitialAdmin(connection) {
  const [admins] = await connection.execute("SELECT user_id FROM users WHERE role = 'admin' LIMIT 1");
  if (admins.length) return;

  const { INITIAL_ADMIN_NAME: name, INITIAL_ADMIN_EMAIL: email, INITIAL_ADMIN_PASSWORD: password, INITIAL_ADMIN_PHONE: phone } = process.env;
  if (!name || !email || !password) {
    console.warn('No initial administrator was created. Set INITIAL_ADMIN_NAME, INITIAL_ADMIN_EMAIL, and INITIAL_ADMIN_PASSWORD, then run npm run migrate once.');
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !/\d/.test(password)) throw new Error('INITIAL_ADMIN_EMAIL must be valid and INITIAL_ADMIN_PASSWORD must contain at least 8 characters and one number');

  await connection.execute("INSERT INTO users (name, email, password, phone, status, role, email_verified_at) VALUES (?, ?, ?, ?, 'active', 'admin', NOW())", [name.trim(), email.trim().toLowerCase(), await bcrypt.hash(password, 12), phone || null]);
  console.log(`Created initial SmartPark administrator: ${email.trim().toLowerCase()}`);
}

async function main() {
  const connection = await mysql.createConnection(databaseConfig);
  try {
    const [tables] = await connection.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'");
    if (!tables.length) {
      const rawSchema = await fs.readFile(schemaPath, 'utf8');
      const schema = rawSchema.replace(/^CREATE DATABASE[^;]+;\s*/im, '').replace(/^USE\s+[^;]+;\s*/im, '');
      await connection.query(schema);
      console.log('Created SmartPark database tables.');
    }
    await createInitialAdmin(connection);
  } finally {
    await connection.end();
  }
}

main().catch((error) => { console.error('Database migration failed:', error.message); process.exit(1); });
