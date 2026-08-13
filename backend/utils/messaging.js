import nodemailer from 'nodemailer';

const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined }) : null;

export async function sendEmail({ to, subject, text, html }) {
  if (!to) return false;
  if (!transporter) {
    console.info(`[Email demo] To: ${to} | Subject: ${subject}`);
    return false;
  }
  await transporter.sendMail({ from: process.env.SMTP_FROM || 'SmartPark <noreply@smartparking.local>', to, subject, text, html: html || `<p>${text}</p>` });
  return true;
}

export async function sendAccountAlert({ email, subject, message }) {
  await sendEmail({ to: email, subject, text: message });
}
