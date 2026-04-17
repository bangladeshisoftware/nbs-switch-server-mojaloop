// const { Kafka } = require('kafkajs');
// require('dotenv').config();

// const kafka = new Kafka({
//   clientId: process.env.KAFKA_CLIENT_ID || 'r-switch-portal',
//   brokers: [process.env.KAFKA_BROKER || '194.163.167.247:31289'],
//   retry: {
//     initialRetryTime: 300,
//     retries: 10,
//   },
// });

// const consumer = kafka.consumer({
//   groupId: process.env.KAFKA_GROUP_ID || 'r-switch-db-saver',
//   sessionTimeout: 30000,
//   heartbeatInterval: 3000,
//   allowAutoTopicCreation: true, // ← add this
// });

// // ─── সব Mojaloop Kafka Topics ────────────────────────────────
// const TOPICS = {
//   TRANSFER_PREPARE: 'topic-transfer-prepare', // DFSP transfer শুরু করেছে
//   TRANSFER_POSITION: 'topic-transfer-position', // Fund reserve হচ্ছে
//   TRANSFER_FULFIL: 'topic-transfer-fulfil', // Transfer সম্পন্ন
//   TRANSFER_REJECT: 'topic-transfer-reject', // Transfer ব্যর্থ
//   TRANSFER_GET: 'topic-transfer-get', // Transfer lookup
//   TIMEOUT: 'topic-timeout-consumer', // Transfer expire হয়েছে
//   NOTIFICATION: 'topic-notification-event', // DFSP-কে জানানো হচ্ছে
//   SETTLEMENT_CLOSE: 'topic-deferredsettlement-close', // Settlement window বন্ধ
//   ADMIN_TRANSFER: 'topic-admin-transfer', // Admin operations
// };

// module.exports = { kafka, consumer, TOPICS };

const { Kafka } = require('kafkajs');
require('dotenv').config();

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'r-switch-portal',
  brokers: [process.env.KAFKA_BROKER || '194.163.167.247:31289'], // ✅ correct fallback
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});

const consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID || 'r-switch-db-saver',
  sessionTimeout: 30000,
  heartbeatInterval: 3000,
  allowAutoTopicCreation: false, // ← false is safer, prevents silent typo topics
});

// ─── Only topics that ACTUALLY EXIST on your Kafka ───────────
const TOPICS = {
  TRANSFER_PREPARE: 'topic-transfer-prepare',
  TRANSFER_POSITION: 'topic-transfer-position',
  TRANSFER_POSITION_BATCH: 'topic-transfer-position-batch',
  TRANSFER_FULFIL: 'topic-transfer-fulfil',
  TRANSFER_GET: 'topic-transfer-get',
  NOTIFICATION: 'topic-notification-event',
  SETTLEMENT_CLOSE: 'topic-deferredsettlement-close',
  ADMIN_TRANSFER: 'topic-admin-transfer',
  QUOTES_POST: 'topic-quotes-post',
  QUOTES_PUT: 'topic-quotes-put',
  QUOTES_GET: 'topic-quotes-get',
  FX_QUOTES_POST: 'topic-fx-quotes-post',
  FX_QUOTES_PUT: 'topic-fx-quotes-put',
  FX_QUOTES_GET: 'topic-fx-quotes-get',
  BULKQUOTES_POST: 'topic-bulkquotes-post',
  BULKQUOTES_PUT: 'topic-bulkquotes-put',
  BULKQUOTES_GET: 'topic-bulkquotes-get',
};

// ❌ REMOVED - these don't exist on your Kafka:
// TRANSFER_REJECT: 'topic-transfer-reject'
// TIMEOUT: 'topic-timeout-consumer'

module.exports = { kafka, consumer, TOPICS };
