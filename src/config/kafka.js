/**************************************************************************
 * Copyright © 2026 Bangladeshi Software Ltd. All rights reserved.
 * Distributed under the license terms specified in this repository.
 *
 * ORIGINAL AUTHOR: Muhammad Nasim (Developer)
 **************************************************************************/

const { Kafka } = require('kafkajs');
require('dotenv').config();

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'r-switch-portal',
  brokers: [process.env.KAFKA_BROKER],
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});

const consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID || 'r-switch-db-saver',
  sessionTimeout: 30000,
  heartbeatInterval: 3000,
});

// topics
const TOPICS = {
  TRANSFER_PREPARE: 'topic-transfer-prepare',
  TRANSFER_POSITION: 'topic-transfer-position',
  TRANSFER_FULFIL: 'topic-transfer-fulfil',
  TRANSFER_REJECT: 'topic-transfer-reject',
  TRANSFER_GET: 'topic-transfer-get',
  TIMEOUT: 'topic-timeout-consumer',
  NOTIFICATION: 'topic-notification-event',
  SETTLEMENT_CLOSE: 'topic-deferredsettlement-close',
  ADMIN_TRANSFER: 'topic-admin-transfer',
};

module.exports = { kafka, consumer, TOPICS };
