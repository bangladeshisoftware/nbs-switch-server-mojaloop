/**************************************************************************
 * Copyright © 2026 Bangladeshi Software Ltd. All rights reserved.
 * Distributed under the license terms specified in this repository.
 *
 * ORIGINAL AUTHOR: Muhammad Nasim (Developer)
 **************************************************************************/

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { testConnection } = require('./config/db');
const { startConsumer } = require('./consumers/index');
const routes = require('./routes/index');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// SERVER TIMEOUT
// Settlement complete takes 6 steps + delays - needs extra time
server.setTimeout(180000);
server.keepAliveTimeout = 185000;
server.headersTimeout = 190000;

// MIDDLEWARE
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

//  REQUEST TIMEOUT MIDDLEWARE
// Default 60s for all routes, 3 minutes for settlement routes
app.use((req, res, next) => {
  const isSettlement = req.path.includes('/settlement');
  const timeout = isSettlement ? 180000 : 60000;

  req.setTimeout(timeout, () => {
    console.error(
      `[TIMEOUT] ${req.method} ${req.path} timed out after ${timeout}ms`,
    );
    if (!res.headersSent) {
      res.status(503).json({
        error: 'Request timeout',
        message: `Request took longer than ${timeout / 1000}s`,
        path: req.path,
      });
    }
  });

  res.setTimeout(timeout, () => {
    console.error(`[TIMEOUT] Response timeout: ${req.method} ${req.path}`);
  });

  next();
});

//  ROUTES
app.use('/api/v1', routes);

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'r-switch-portal-backend',
    timestamp: new Date(),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

//  START
async function start() {
  await testConnection();
  await startConsumer();

  server.listen(PORT, () => {
    console.log(`R Switch Portal Backend running on port ${PORT}`);
    console.log(`Kafka consumer listening to Mojaloop topics`);
    console.log(`Server timeout: 3 minutes (settlement routes)`);
  });
}

start().catch(console.error);
