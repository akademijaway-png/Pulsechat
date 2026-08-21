'use strict';

/**
 * Outgoing email abstraction.
 * - When SMTP_URL is configured, mails are really sent (nodemailer).
 * - Otherwise the link is logged to the server console and, in development,
 *   exposed in the API response so the flow stays testable.
 */
const config = require('./config');

let transporter = null;
if (config.smtpUrl) {
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport(config.smtpUrl);
}

async function sendResetEmail(user, resetUrl) {
  const subject = 'PulseChat — Reset your password';
  const text = [
    `Hi ${user.display_name},`,
    '',
    'We received a request to reset your PulseChat password.',
    'Open the link below to choose a new password (valid for 30 minutes):',
    '',
    resetUrl,
    '',
    'If you did not ask for this, you can safely ignore this email.',
  ].join('\n');

  if (transporter) {
    await transporter.sendMail({
      from: config.mailFrom,
      to: user.email,
      subject,
      text,
    });
    return null; // real delivery — never leak the link in the API
  }

  console.log(`\n[mailer:dev] Password reset for ${user.email} (${user.display_name}):\n  ${resetUrl}\n`);
  return resetUrl; // dev only
}

module.exports = { sendResetEmail };
