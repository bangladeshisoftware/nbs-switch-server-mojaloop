const { Kafka } = require('kafkajs');
require('dotenv').config();

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'r-switch-portal',
  brokers:  [process.env.KAFKA_BROKER || '95.111.247.250:31207'],
  retry: {
    initialRetryTime: 300,
    retries: 10
  }
});

const consumer = kafka.consumer({
  groupId:           process.env.KAFKA_GROUP_ID || 'r-switch-db-saver',
  sessionTimeout:    30000,
  heartbeatInterval: 3000,
});

// ─── সব Mojaloop Kafka Topics ────────────────────────────────
const TOPICS = {
  TRANSFER_PREPARE:  'topic-transfer-prepare',         // DFSP transfer শুরু করেছে
  TRANSFER_POSITION: 'topic-transfer-position',        // Fund reserve হচ্ছে
  TRANSFER_FULFIL:   'topic-transfer-fulfil',          // Transfer সম্পন্ন
  TRANSFER_REJECT:   'topic-transfer-reject',          // Transfer ব্যর্থ
  TRANSFER_GET:      'topic-transfer-get',             // Transfer lookup
  TIMEOUT:           'topic-timeout-consumer',         // Transfer expire হয়েছে
  NOTIFICATION:      'topic-notification-event',       // DFSP-কে জানানো হচ্ছে
  SETTLEMENT_CLOSE:  'topic-deferredsettlement-close', // Settlement window বন্ধ
  ADMIN_TRANSFER:    'topic-admin-transfer',           // Admin operations
};

module.exports = { kafka, consumer, TOPICS };
