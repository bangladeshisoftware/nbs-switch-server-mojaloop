const nodemailer = require('nodemailer');

//  EMAIL TRANSPORTER
function createTransporter() {
  const port = parseInt(process.env.SMTP_PORT || '465');

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    family: 4,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

//  Base send email function.
async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { skipped: true, reason: 'SMTP not configured' };
  }

  const transporter = createTransporter();

  const mailOptions = {
    from:
      process.env.SMTP_FROM ||
      `"R Switch Portal" <${process.env.SMTP_USER || 'smtpuser@gmail.com'}>`,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    throw err;
  }
}

//  OTP EMAIL TEMPLATE
async function sendOTPEmail({ to, username, otp }) {
  const subject = 'R Switch Portal — Login OTP';

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body {
    margin: 0;
    padding: 0;
    background-color: #0e1116;
    font-family: Arial, Helvetica, sans-serif;
  }

  .wrapper {
    max-width: 520px;
    margin: 40px auto;
    padding: 20px;
  }

  .card {
    background-color: #161b22;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid #21262d;
    box-shadow: 0 10px 30px rgba(0,0,0,0.4);
  }

  .header {
    padding: 28px 32px;
background-image: linear-gradient(120deg, #a1c4fd 0%, #c2e9fb 100%);
    text-align: left;
  }

  .header h1 {
    margin: 0;
    font-size: 18px;
    color: #0e1116;
    font-weight: 700;
    letter-spacing: 1px;
  }

  .header p {
    margin: 6px 0 0;
    font-size: 12px;
    color: #0e1116;
    opacity: 0.8;
  }

  .body {
    padding: 32px;
    color: #c9d1d9;
  }

  .greeting {
    font-size: 14px;
    margin-bottom: 24px;
  }

  .otp-label {
    font-size: 11px;
    letter-spacing: 1.5px;
    color: #8b949e;
    margin-bottom: 8px;
  }

  .otp-box {
    background-color: #0e1116;
    border: 2px solid #00e676;
    border-radius: 10px;
    padding: 22px;
    text-align: center;
    margin-bottom: 24px;
  }

  .otp-code {
    font-size: 36px;
    font-weight: 700;
    letter-spacing: 10px;
    color: #00e676;
  }

  .info {
    font-size: 13px;
    line-height: 1.6;
    color: #8b949e;
    margin-bottom: 20px;
  }

  .warning {
    background-color: #1c1f26;
    border-left: 4px solid #ff9800;
    padding: 14px 16px;
    border-radius: 6px;
    font-size: 12px;
    color: #c9d1d9;
  }

  .footer {
    border-top: 1px solid #21262d;
    padding: 20px 32px;
    text-align: center;
    font-size: 11px;
    color: #6e7681;
    line-height: 1.6;
  }

  .brand {
    font-weight: 600;
    color: #00e676;
  }

</style>
</head>

<body>
  <div class="wrapper">
    <div class="card">

      <div class="header">
        <h1>R SWITCH PORTAL</h1>
        <p>Mojaloop Financial Switch Management</p>
      </div>

      <div class="body">

        <p class="greeting">
          Hello <strong>${username}</strong>,
        </p>

        <p class="info">
          We received a request to access your secure R Switch Portal account.
          Please use the one-time password (OTP) below to complete your authentication.
        </p>

        <div class="otp-label">YOUR ONE-TIME PASSWORD</div>
        <div class="otp-box">
          <div class="otp-code">${otp}</div>
        </div>

        <div class="warning">
          This OTP is valid for <strong>10 minutes</strong> only.<br/>
           Never share this code with anyone.<br/>
          If you did not request this login, please ignore this email or contact support immediately.
        </div>

      </div>

      <div class="footer">
        <div class="brand">R Switch Portal</div>
        Presented by Bangladeshi Software Ltd.<br/>
        Secure Infrastructure for Digital Financial Ecosystems<br/><br/>
        This is an automated security message. Please do not reply.
      </div>

    </div>
  </div>
</body>
</html>`;

  return sendEmail({ to, subject, html });
}

//  SETTLEMENT NOTIFICATION EMAIL
async function sendSettlementEmail({ to, dfspName, dfspId, settlementData }) {
  const {
    settlementId,
    windowId,
    settledAt,
    sentAmount,
    receivedAmount,
    netPosition,
    currency,
    transferCount,
    committedCount,
    failedCount,
    positionAfter,
    netDebitCap,
  } = settlementData;

  const netColor = netPosition >= 0 ? '#00cc44' : '#ff4444';
  const netLabel = netPosition >= 0 ? 'Receivable' : 'Payable';
  const netAbs = Math.abs(netPosition).toLocaleString('en-US', {
    minimumFractionDigits: 2,
  });
  const fmtAmt = (v) =>
    parseFloat(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const fmtDate = (d) =>
    d
      ? new Date(d).toLocaleString('en-US', {
          timeZone: 'Asia/Dhaka',
          hour12: false,
        })
      : 'N/A';

  const subject = `[R Switch] Settlement Completed — ${dfspId} | ID: ${settlementId}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body      { background: #0a0a0a; font-family: Arial, sans-serif; }
    .wrap     { max-width: 560px; margin: 30px auto; padding: 16px; }
    .card     { background: #111; border: 1px solid #1e1e1e; border-radius: 12px; overflow: hidden; }
    .hdr      { background: #0d0d0d; border-bottom: 2px solid #00ff00; padding: 20px 28px; display: flex; align-items: center; gap: 14px; }
    .hdr-icon { width: 40px; height: 40px; background: #00ff00; border-radius: 8px;
                display: flex; align-items: center; justify-content: center;
                font-size: 20px; font-weight: 900; color: #000; flex-shrink: 0; }
    .hdr h1   { font-size: 15px; color: #fff; font-weight: 700; }
    .hdr p    { font-size: 10px; color: #666; margin-top: 2px; }
    .body     { padding: 24px 28px; }
    .greeting { color: #999; font-size: 12px; margin-bottom: 18px; line-height: 1.5; }
    .section  { margin-bottom: 18px; }
    .sec-title{ font-size: 9px; color: #555; letter-spacing: 2px; text-transform: uppercase;
                margin-bottom: 8px; font-family: 'Courier New', monospace; }
    .meta-row { display: flex; justify-content: space-between; padding: 6px 0;
                border-bottom: 1px solid #1a1a1a; }
    .meta-row:last-child { border-bottom: none; }
    .meta-label { font-size: 11px; color: #666; }
    .meta-val   { font-size: 11px; color: #ccc; font-weight: 600; font-family: 'Courier New', monospace; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .stat-box   { background: #0d0d0d; border: 1px solid #1e1e1e; border-radius: 7px; padding: 12px; }
    .stat-label { font-size: 9px; color: #555; margin-bottom: 4px; letter-spacing: 1px; }
    .stat-val   { font-size: 18px; font-weight: 700; font-family: 'Courier New', monospace; }
    .net-box    { background: #0d0d0d; border: 2px solid ${netColor}33;
                  border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0; }
    .net-label  { font-size: 10px; color: #666; margin-bottom: 6px; letter-spacing: 1px; }
    .net-val    { font-size: 28px; font-weight: 700; color: ${netColor};
                  font-family: 'Courier New', monospace; }
    .net-sub    { font-size: 10px; color: ${netColor}; margin-top: 4px; }
    .pos-box    { background: #001a00; border: 1px solid #003300; border-radius: 7px; padding: 12px; }
    .pos-row    { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .pos-row:last-child { margin-bottom: 0; }
    .note       { background: #1a1500; border: 1px solid #2a2000; border-radius: 6px;
                  padding: 10px 14px; margin-top: 16px; }
    .note p     { font-size: 10px; color: #888; line-height: 1.6; }
    .footer     { border-top: 1px solid #1a1a1a; padding: 14px 28px;
                  text-align: center; color: #333; font-size: 9px; }
  </style>
</head>
<body>
<div class="wrap">
  <div class="card">

    <!-- Header -->
    <div class="hdr">
      <div class="hdr-icon">⬡</div>
      <div>
        <h1>Settlement Completed</h1>
        <p>R Switch Portal — Mojaloop Financial Switch</p>
      </div>
    </div>

    <div class="body">
      <p class="greeting">
        Dear <strong style="color:#fff">${dfspName}</strong> (<span style="color:#00ff00">${dfspId}</span>),<br>
        The end-of-day settlement has been successfully completed.
        Below is your settlement summary for this period.
      </p>

      <!-- Settlement Info -->
      <div class="section">
        <div class="sec-title">Settlement Information</div>
        <div class="meta-row"><span class="meta-label">Settlement ID</span><span class="meta-val">${settlementId}</span></div>
        <div class="meta-row"><span class="meta-label">Window ID</span><span class="meta-val">${windowId}</span></div>
        <div class="meta-row"><span class="meta-label">Settled At</span><span class="meta-val">${fmtDate(settledAt)}</span></div>
        <div class="meta-row"><span class="meta-label">Currency</span><span class="meta-val">${currency || 'BDT'}</span></div>
      </div>

      <!-- Transaction Stats -->
      <div class="section">
        <div class="sec-title">Transaction Summary</div>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-label">TOTAL TRANSFERS</div>
            <div class="stat-val" style="color:#fff">${transferCount || 0}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">COMMITTED</div>
            <div class="stat-val" style="color:#00cc44">${committedCount || 0}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">SENT AMOUNT</div>
            <div class="stat-val" style="color:#ff6644; font-size:14px">${fmtAmt(sentAmount)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">RECEIVED AMOUNT</div>
            <div class="stat-val" style="color:#00cc44; font-size:14px">${fmtAmt(receivedAmount)}</div>
          </div>
        </div>
      </div>

      <!-- Net Position -->
      <div class="net-box">
        <div class="net-label">NET POSITION</div>
        <div class="net-val">${netAbs} ${currency || 'BDT'}</div>
        <div class="net-sub">${netLabel}</div>
      </div>

      <!-- Position After Settlement -->
      <div class="section">
        <div class="sec-title">Account Position After Settlement</div>
        <div class="pos-box">
          <div class="pos-row">
            <span style="font-size:11px;color:#666">Current Position</span>
            <span style="font-size:11px;color:#00ff00;font-family:'Courier New',monospace;font-weight:700">
              ${fmtAmt(positionAfter)} ${currency || 'BDT'}
            </span>
          </div>
          <div class="pos-row">
            <span style="font-size:11px;color:#666">Net Debit Cap</span>
            <span style="font-size:11px;color:#ccc;font-family:'Courier New',monospace">
              ${fmtAmt(netDebitCap)} ${currency || 'BDT'}
            </span>
          </div>
          <div class="pos-row">
            <span style="font-size:11px;color:#666">Available</span>
            <span style="font-size:11px;color:#00aaff;font-family:'Courier New',monospace;font-weight:700">
              ${fmtAmt((netDebitCap || 0) - (positionAfter || 0))} ${currency || 'BDT'}
            </span>
          </div>
        </div>
      </div>

      <div class="note">
        <p>
          Position has been reset to 0 after settlement.<br>
          A new settlement window is now open for the next period.<br>
          For any queries, contact the R Switch operations team.
        </p>
      </div>
    </div>

    <div class="footer">
      R Switch Portal &nbsp;·&nbsp; Automated Settlement Notification &nbsp;·&nbsp; Do not reply<br>
      ${new Date().getFullYear()} © Mojaloop Financial Switch
    </div>
  </div>
</div>
</body>
</html>`;

  return sendEmail({ to, subject, html });
}

//  SEND SETTLEMENT EMAILS TO ALL DFSPs
async function sendSettlementEmailsToAll({
  pool,
  settlementId,
  windowId,
  participants,
}) {
  const emailResults = [];

  try {
    const [dfsps] = await pool.execute(
      `SELECT dfsp_id, name, currency, email FROM dfsps WHERE email IS NOT NULL AND email != ''`,
    );

    if (dfsps.length === 0) {
      return emailResults;
    }

    const settledAt = new Date();

    for (const dfsp of dfsps) {
      try {
        const [[stats]] = await pool.execute(
          `
          SELECT
            COUNT(*)                                              AS total,
            SUM(status = 'COMMITTED')                            AS committed,
            SUM(status = 'FAILED')                               AS failed,
            SUM(CASE WHEN payer_fsp = ? AND status = 'COMMITTED' THEN amount ELSE 0 END) AS sent,
            SUM(CASE WHEN payee_fsp = ? AND status = 'COMMITTED' THEN amount ELSE 0 END) AS received
          FROM transfers
          WHERE (payer_fsp = ? OR payee_fsp = ?)
            AND DATE(created_at) = CURDATE()`,
          [dfsp.dfsp_id, dfsp.dfsp_id, dfsp.dfsp_id, dfsp.dfsp_id],
        );

        const [[pos]] = await pool.execute(
          `
          SELECT current_position, net_debit_cap
          FROM dfsp_positions
          WHERE dfsp_id = ? LIMIT 1`,
          [dfsp.dfsp_id],
        );

        const sentAmt = parseFloat(stats.sent || 0);
        const receivedAmt = parseFloat(stats.received || 0);
        const netPos = receivedAmt - sentAmt;

        await sendSettlementEmail({
          to: dfsp.email,
          dfspName: dfsp.name || dfsp.dfsp_id,
          dfspId: dfsp.dfsp_id,
          settlementData: {
            settlementId,
            windowId,
            settledAt,
            sentAmount: sentAmt,
            receivedAmount: receivedAmt,
            netPosition: netPos,
            currency: dfsp.currency || 'BDT',
            transferCount: parseInt(stats.total || 0),
            committedCount: parseInt(stats.committed || 0),
            failedCount: parseInt(stats.failed || 0),
            positionAfter: parseFloat(pos?.current_position || 0),
            netDebitCap: parseFloat(pos?.net_debit_cap || 0),
          },
        });

        emailResults.push({
          dfsp_id: dfsp.dfsp_id,
          email: dfsp.email,
          status: 'sent',
        });
      } catch (e) {
        emailResults.push({
          dfsp_id: dfsp.dfsp_id,
          email: dfsp.email,
          status: 'failed',
          error: e.message,
        });
      }
    }
  } catch (e) {
    // skip.
  }

  return emailResults;
}

module.exports = {
  sendEmail,
  sendOTPEmail,
  sendSettlementEmail,
  sendSettlementEmailsToAll,
};
