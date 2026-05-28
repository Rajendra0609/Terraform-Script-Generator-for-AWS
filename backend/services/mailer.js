'use strict';
/**
 * mailer.js — Nodemailer wrapper for TFGen
 *
 * Configuration (all via .env):
 *   SMTP_HOST      e.g. smtp.gmail.com
 *   SMTP_PORT      e.g. 587  (STARTTLS) or 465 (SSL)
 *   SMTP_SECURE    'true' for port 465, leave blank/false for 587
 *   SMTP_USER      your sending email address (or SMTP login)
 *   SMTP_PASS      app-password / SMTP password
 *   SMTP_FROM      display name + address, e.g. "TFGen <no-reply@tfgen.io>"
 *   FRONTEND_URL   e.g. http://localhost:3000  (no trailing slash)
 *
 * Gmail quick-start:
 *   1. Enable 2-Step Verification on your Google account.
 *   2. Go to myaccount.google.com → Security → App passwords.
 *   3. Generate an app password for "Mail".
 *   4. Set SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER=you@gmail.com,
 *      SMTP_PASS=<16-char app password>, SMTP_FROM="TFGen <you@gmail.com>"
 */

const nodemailer = require('nodemailer');

// ── Transport (lazy-initialised so the server can start even if SMTP is
//    not configured yet; mis-configured SMTP will throw only on first send) ──

let _transport = null;

function getTransport() {
  if (_transport) return _transport;

  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'Email not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your .env file.'
    );
  }

  _transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: SMTP_SECURE === 'true',   // true → port 465 (SSL), false → STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return _transport;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a password-reset email.
 * @param {string} toEmail   recipient address
 * @param {string} rawToken  the plain-text reset token (NOT the hash)
 */
async function sendPasswordReset(toEmail, rawToken) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const resetLink   = `${frontendUrl}/reset-password?token=${rawToken}`;
  const from        = process.env.SMTP_FROM || `TFGen <${process.env.SMTP_USER}>`;

  const transport = getTransport();

  await transport.sendMail({
    from,
    to: toEmail,
    subject: 'Reset your TFGen password',
    text: [
      'Hi,',
      '',
      'You requested a password reset for your TFGen account.',
      'Click the link below to choose a new password (valid for 1 hour):',
      '',
      resetLink,
      '',
      'If you did not request this, you can safely ignore this email.',
      'Your password will not change until you click the link above and create a new one.',
      '',
      '— The TFGen Team',
    ].join('\n'),
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:40px 0;">
          <tr><td align="center">
            <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.07);">
              <!-- header -->
              <tr>
                <td style="background:linear-gradient(135deg,#00A87C 0%,#2563EB 100%);padding:32px 40px;">
                  <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">🔐 TFGen</p>
                </td>
              </tr>
              <!-- body -->
              <tr>
                <td style="padding:40px;">
                  <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#111827;">Reset your password</h1>
                  <p style="margin:0 0 28px;font-size:14px;color:#6B7280;line-height:1.6;">
                    We received a request to reset the password for your TFGen account
                    associated with <strong>${toEmail}</strong>.
                    Click the button below to choose a new password.
                  </p>
                  <!-- CTA button -->
                  <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                    <tr>
                      <td style="background:linear-gradient(135deg,#00A87C 0%,#2563EB 100%);border-radius:10px;">
                        <a href="${resetLink}"
                           style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">
                          Reset Password
                        </a>
                      </td>
                    </tr>
                  </table>
                  <!-- expiry note -->
                  <p style="margin:0 0 16px;font-size:13px;color:#6B7280;line-height:1.6;">
                    ⏰ This link expires in <strong>1 hour</strong>.
                  </p>
                  <!-- fallback link -->
                  <p style="margin:0 0 28px;font-size:12px;color:#9CA3AF;line-height:1.6;word-break:break-all;">
                    If the button doesn't work, copy and paste this URL into your browser:<br>
                    <a href="${resetLink}" style="color:#2563EB;">${resetLink}</a>
                  </p>
                  <hr style="border:none;border-top:1px solid #E5E7EB;margin:0 0 24px;">
                  <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.6;">
                    If you didn't request a password reset, you can safely ignore this email.
                    Your password will remain unchanged.
                  </p>
                </td>
              </tr>
              <!-- footer -->
              <tr>
                <td style="background:#F9FAFB;padding:20px 40px;border-top:1px solid #E5E7EB;">
                  <p style="margin:0;font-size:12px;color:#9CA3AF;text-align:center;">
                    Sent by TFGen · Terraform Infrastructure Generator
                  </p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  });
}

module.exports = { sendPasswordReset };
