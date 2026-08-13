import nodemailer from 'nodemailer';

const resendApiKey = process.env.RESEND_API_KEY?.trim();
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = smtpConfigured ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;
const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_FROM || 'SmartPark <noreply@smartpark.local>';

async function sendWithResend({ to, subject, text, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'SmartPark/1.0' },
    body: JSON.stringify({ from: emailFrom, to: [to], subject, text, html: html || `<p>${text}</p>` }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || `Resend email request failed with status ${response.status}`);
  }
  return true;
}

export async function sendEmail({ to, subject, text, html }) {
  if (!to) return false;
  if (resendApiKey) return sendWithResend({ to, subject, text, html });
  if (!transporter) {
    console.info(`[Email unavailable] To: ${to} | Subject: ${subject}`);
    return false;
  }
  await transporter.sendMail({ from: emailFrom, to, subject, text, html: html || `<p>${text}</p>` });
  return true;
}

export async function sendAccountAlert({ email, subject, message }) {
  await sendEmail({ to: email, subject, text: message });
}
