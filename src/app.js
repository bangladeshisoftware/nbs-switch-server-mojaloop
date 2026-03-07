require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

const { testConnection } = require('./config/db');
const { startConsumer }  = require('./consumers/index');
const routes             = require('./routes/index');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ─── ROUTES ───────────────────────────────────────────────────
app.use('/api/v1', routes);

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'r-switch-portal-backend', timestamp: new Date() });
});
app.get('/test-email', async (req, res) => {
  const nodemailer = require('nodemailer');
  
  const transporter = nodemailer.createTransport({
    host:   'mail.saskarentpay.xdomainhost.com',
    port:   465,
    secure: true,
    auth: {
      user: 'admin@saskarentpay.xdomainhost.com',
      pass: 'Z7W!KZi@bKvh[&)8',
    },
    family: 4,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
  });

  try {
    // Step 1: Connection verify করো
    await transporter.verify();
    console.log('✅ SMTP Connection OK');

    // Step 2: Email পাঠাও
    const info = await transporter.sendMail({
      from:    'admin@saskarentpay.xdomainhost.com',
      to:      'cao.bangladeshisoftware@gmail.com', // নিজেকেই পাঠাও
      subject: 'cPanel Test Email',
      html:    '<h1>Test from cPanel Node.js</h1>',
    });

    res.json({ success: true, messageId: info.messageId });

  } catch (err) {
    // Exact error return করো
    res.json({
      success: false,
      error:   err.message,
      code:    err.code,       // ECONNREFUSED, ETIMEDOUT etc
      command: err.command,    // AUTH, CONN etc
    });
  }
});
// ─── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── START ───────────────────────────────────────────────────
async function start() {
  await testConnection();   // verify MySQL
  await startConsumer();    // start Kafka consumer
  app.listen(PORT, () => {
    console.log(`🚀 R Switch Portal Backend running on port ${PORT}`);
    console.log(`📡 Kafka consumer listening to Mojaloop topics`);
  });
}

start().catch(console.error);
