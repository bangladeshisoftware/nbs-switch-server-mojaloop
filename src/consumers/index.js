/**************************************************************************
 * Copyright © 2026 Bangladeshi Software Ltd. All rights reserved.
 * Distributed under the license terms specified in this repository.
 *
 * ORIGINAL AUTHOR: Muhammad Nasim (Developer)
 **************************************************************************/

const { consumer, TOPICS } = require('../config/kafka');
const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

function decodePayload(payload) {
  if (!payload) return {};

  if (typeof payload === 'object') return payload;

  if (typeof payload === 'string') {
    try {
      const base64Match = payload.match(/base64,(.+)$/);
      if (base64Match) {
        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
        return JSON.parse(decoded);
      }

      return JSON.parse(payload);
    } catch (e) {
      console.warn(`payload decode failed: ${e.message}`);
      return {};
    }
  }

  return {};
}

//  MOJALOOP PAYLOAD EXTRACTOR
function extractPayload(raw) {
  const inner = decodePayload(raw?.content?.payload);

  const transferId =
    inner?.transferId || raw?.content?.uriParams?.id || raw?.id || null;

  const payerFsp =
    inner?.payerFsp ||
    raw?.content?.headers?.['fspiop-source'] ||
    raw?.from ||
    null;

  const payeeFsp =
    inner?.payeeFsp ||
    raw?.content?.headers?.['fspiop-destination'] ||
    raw?.to ||
    null;

  const amount = inner?.amount?.amount || null;
  const currency = inner?.amount?.currency || null;

  return {
    transferId,
    payerFsp,
    payeeFsp,
    amount,
    currency,
    transactionId: inner?.transactionId || null,
    quoteId: inner?.quoteId || null,
    ilpPacket: inner?.ilpPacket || null,
    condition: inner?.condition || null,
    expiration: inner?.expiration || null,
    fulfilment: inner?.fulfilment || null,
    transferState: inner?.transferState || raw?.metadata?.event?.action || null,
    errorCode: inner?.errorInformation?.errorCode || null,
    errorMessage: inner?.errorInformation?.errorDescription || null,
    // notification
    toFsp: raw?.to || null,
    fromFsp: raw?.from || 'hub',
    eventType:
      raw?.metadata?.event?.type || raw?.metadata?.event?.action || 'unknown',
    _inner: inner,
  };
}

//  Helper
async function saveStateLog(
  conn,
  transferId,
  prevStatus,
  newStatus,
  eventType,
  direction,
  fromDfsp,
  toDfsp,
  payload,
) {
  if (!transferId) return;
  try {
    await conn.execute(
      `
      INSERT INTO transfer_state_log
        (id, transfer_id, previous_status, new_status, event_type, direction, from_dfsp, to_dfsp, raw_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        transferId,
        prevStatus || null,
        newStatus || null,
        eventType || null,
        direction || null,
        fromDfsp || null,
        toDfsp || null,
        JSON.stringify(payload),
      ],
    );
  } catch (e) {
    console.error(`saveStateLog: ${e.message}`);
  }
}

async function getTransfer(conn, transferId) {
  if (!transferId) return null;
  const [rows] = await conn.execute(
    `SELECT * FROM transfers WHERE transfer_id = ?`,
    [transferId],
  );
  return rows[0] || null;
}

//  1. PREPARE -> RECEIVED
async function handlePrepare(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);

    if (!p.transferId) {
      console.warn(`[PREPARE] transferId পাওয়া যায়নি, skip`);
      await conn.rollback();
      return;
    }

    await conn.execute(
      `
      INSERT INTO transfers
        (id, transfer_id, transaction_id, quote_id, payer_fsp, payee_fsp,
         amount, currency, ilp_packet, condition_value, expiration, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED')
      ON DUPLICATE KEY UPDATE
        payer_fsp  = COALESCE(VALUES(payer_fsp),  payer_fsp),
        payee_fsp  = COALESCE(VALUES(payee_fsp),  payee_fsp),
        amount     = COALESCE(VALUES(amount),     amount),
        currency   = COALESCE(VALUES(currency),   currency),
        ilp_packet = COALESCE(VALUES(ilp_packet), ilp_packet),
        status     = 'RECEIVED',
        updated_at = NOW()`,
      [
        uuidv4(),
        p.transferId,
        p.transactionId,
        p.quoteId,
        p.payerFsp,
        p.payeeFsp,
        p.amount,
        p.currency,
        p.ilpPacket,
        p.condition,
        p.expiration,
      ],
    );

    await saveStateLog(
      conn,
      p.transferId,
      null,
      'RECEIVED',
      'prepare',
      'INBOUND',
      p.payerFsp,
      p.payeeFsp,
      raw,
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

//  2. POSITION -> RESERVED
async function handlePosition(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!transfer) {
      await conn.rollback();
      return;
    }

    await conn.execute(
      `
      UPDATE transfers SET status = 'RESERVED', updated_at = NOW()
      WHERE transfer_id = ? AND status = 'RECEIVED'`,
      [p.transferId],
    );

    if (transfer.payer_fsp && transfer.amount && transfer.currency) {
      const [posRows] = await conn.execute(
        `
        SELECT current_position FROM dfsp_positions
        WHERE dfsp_id = ? AND currency = ?`,
        [transfer.payer_fsp, transfer.currency],
      );
      const posBefore = parseFloat(posRows[0]?.current_position || 0);
      const posAfter = posBefore + parseFloat(transfer.amount);

      await conn.execute(
        `
        INSERT INTO dfsp_positions (id, dfsp_id, currency, current_position, reserved_amount)
        VALUES (?, ?, ?, 0, ?)
        ON DUPLICATE KEY UPDATE
          reserved_amount = reserved_amount + ?, updated_at = NOW()`,
        [
          uuidv4(),
          transfer.payer_fsp,
          transfer.currency,
          transfer.amount,
          transfer.amount,
        ],
      );

      await conn.execute(
        `
        INSERT INTO position_changes
          (id, transfer_id, dfsp_id, currency, change_type, amount, position_before, position_after)
        VALUES (?, ?, ?, ?, 'RESERVE', ?, ?, ?)`,
        [
          uuidv4(),
          p.transferId,
          transfer.payer_fsp,
          transfer.currency,
          transfer.amount,
          posBefore,
          posAfter,
        ],
      );
    }

    await saveStateLog(
      conn,
      p.transferId,
      'RECEIVED',
      'RESERVED',
      'position',
      'INTERNAL',
      transfer.payer_fsp,
      transfer.payee_fsp,
      raw,
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

//  3. FULFIL -> COMMITTED
async function handleFulfil(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!p.transferId) {
      await conn.rollback();
      return;
    }

    const transferState =
      p.transferState || p._inner?.transferState || 'COMMITTED';
    const fulfilment = p.fulfilment || p._inner?.fulfilment || null;
    const completedAt = p._inner?.completedTimestamp || null;

    await conn.execute(
      `
      UPDATE transfers
      SET status = 'COMMITTED',
          fulfilment   = ?,
          completed_at = COALESCE(?, NOW()),
          updated_at   = NOW()
      WHERE transfer_id = ?`,
      [fulfilment, completedAt, p.transferId],
    );

    await saveStateLog(
      conn,
      p.transferId,
      transfer?.status,
      'COMMITTED',
      'fulfil',
      'INBOUND',
      transfer?.payee_fsp,
      transfer?.payer_fsp,
      raw,
    );

    // Reconciliation — transfers table get amount and currency.
    if (transfer) {
      await conn.execute(
        `
        INSERT INTO reconciliation
          (id, transfer_id, dfsp_id, transfer_type, amount, currency, recon_status, settlement_date)
        VALUES (?, ?, ?, 'SEND', ?, ?, 'PENDING', CURDATE())`,
        [
          uuidv4(),
          p.transferId,
          transfer.payer_fsp,
          transfer.amount,
          transfer.currency,
        ],
      );
      await conn.execute(
        `
        INSERT INTO reconciliation
          (id, transfer_id, dfsp_id, transfer_type, amount, currency, recon_status, settlement_date)
        VALUES (?, ?, ?, 'RECEIVE', ?, ?, 'PENDING', CURDATE())`,
        [
          uuidv4(),
          p.transferId,
          transfer.payee_fsp,
          transfer.amount,
          transfer.currency,
        ],
      );

      // Position commit
      if (transfer.payer_fsp && transfer.amount && transfer.currency) {
        const [posRows] = await conn.execute(
          `
          SELECT current_position FROM dfsp_positions
          WHERE dfsp_id = ? AND currency = ?`,
          [transfer.payer_fsp, transfer.currency],
        );
        const posBefore = parseFloat(posRows[0]?.current_position || 0);
        const posAfter = posBefore + parseFloat(transfer.amount);

        await conn.execute(
          `
          INSERT INTO dfsp_positions (id, dfsp_id, currency, current_position, reserved_amount)
          VALUES (?, ?, ?, ?, 0)
          ON DUPLICATE KEY UPDATE
            current_position = current_position + ?,
            reserved_amount  = GREATEST(0, reserved_amount - ?),
            updated_at       = NOW()`,
          [
            uuidv4(),
            transfer.payer_fsp,
            transfer.currency,
            transfer.amount,
            transfer.amount,
            transfer.amount,
          ],
        );

        await conn.execute(
          `
          INSERT INTO position_changes
            (id, transfer_id, dfsp_id, currency, change_type, amount, position_before, position_after)
          VALUES (?, ?, ?, ?, 'COMMIT', ?, ?, ?)`,
          [
            uuidv4(),
            p.transferId,
            transfer.payer_fsp,
            transfer.currency,
            transfer.amount,
            posBefore,
            posAfter,
          ],
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

//  4. REJECT -> FAILED
async function handleReject(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!p.transferId) {
      await conn.rollback();
      return;
    }

    await conn.execute(
      `
      UPDATE transfers
      SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = NOW()
      WHERE transfer_id = ?`,
      [p.errorCode, p.errorMessage, p.transferId],
    );

    await saveStateLog(
      conn,
      p.transferId,
      transfer?.status,
      'FAILED',
      'reject',
      'INBOUND',
      null,
      null,
      raw,
    );

    if (transfer?.payer_fsp && transfer?.amount && transfer?.currency) {
      await conn.execute(
        `
        UPDATE dfsp_positions
        SET reserved_amount = GREATEST(0, reserved_amount - ?), updated_at = NOW()
        WHERE dfsp_id = ? AND currency = ?`,
        [transfer.amount, transfer.payer_fsp, transfer.currency],
      );
      await conn.execute(
        `
        INSERT INTO position_changes
          (id, transfer_id, dfsp_id, currency, change_type, amount, position_before, position_after)
        VALUES (?, ?, ?, ?, 'ROLLBACK', ?, 0, 0)`,
        [
          uuidv4(),
          p.transferId,
          transfer.payer_fsp,
          transfer.currency,
          transfer.amount,
        ],
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

//  5. TIMEOUT
async function handleTimeout(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!p.transferId) {
      await conn.rollback();
      return;
    }

    await conn.execute(
      `
      UPDATE transfers SET status = 'TIMEOUT', updated_at = NOW()
      WHERE transfer_id = ? AND status IN ('RECEIVED','RESERVED')`,
      [p.transferId],
    );

    await saveStateLog(
      conn,
      p.transferId,
      transfer?.status,
      'TIMEOUT',
      'timeout',
      'INTERNAL',
      null,
      null,
      raw,
    );

    if (transfer?.payer_fsp && transfer?.amount && transfer?.currency) {
      await conn.execute(
        `
        UPDATE dfsp_positions
        SET reserved_amount = GREATEST(0, reserved_amount - ?), updated_at = NOW()
        WHERE dfsp_id = ? AND currency = ?`,
        [transfer.amount, transfer.payer_fsp, transfer.currency],
      );
      await conn.execute(
        `
        INSERT INTO position_changes
          (id, transfer_id, dfsp_id, currency, change_type, amount, position_before, position_after)
        VALUES (?, ?, ?, ?, 'ROLLBACK', ?, 0, 0)`,
        [
          uuidv4(),
          p.transferId,
          transfer.payer_fsp,
          transfer.currency,
          transfer.amount,
        ],
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

//  6. NOTIFICATION
async function handleNotification(raw) {
  const conn = await pool.getConnection();
  try {
    const inner = decodePayload(raw?.content?.payload);

    const transferId =
      raw?.content?.uriParams?.id || inner?.transferId || raw?.id || null;

    const transferState =
      inner?.transferState || raw?.metadata?.event?.action || null;

    const toFsp = raw?.to || null;
    const fromFsp = raw?.from || 'hub';
    const eventType =
      raw?.metadata?.event?.type ||
      raw?.metadata?.event?.action ||
      'notification';

    await conn.execute(
      `
      INSERT INTO notifications_log
        (id, transfer_id, to_fsp, from_fsp, event_type, transfer_state, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        transferId,
        toFsp,
        fromFsp,
        eventType,
        transferState,
        JSON.stringify(raw),
      ],
    );

    if (transferId) {
      await saveStateLog(
        conn,
        transferId,
        null,
        transferState,
        'notification',
        'OUTBOUND',
        fromFsp,
        toFsp,
        raw,
      );
    }
  } catch (err) {
    null;
  } finally {
    conn.release();
  }
}

//  7. SETTLEMENT CLOSE
async function handleSettlementClose(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const windowId = raw?.settlementWindowId || raw?.id || uuidv4();

    await conn.execute(
      `
      INSERT INTO settlement_windows (id, window_id, status, opened_at, closed_at)
      VALUES (?, ?, 'CLOSED', ?, NOW())
      ON DUPLICATE KEY UPDATE status = 'CLOSED', closed_at = NOW(), updated_at = NOW()`,
      [uuidv4(), windowId, raw?.createdDate || null],
    );

    await conn.execute(
      `
      UPDATE reconciliation r1
      JOIN reconciliation r2
        ON r1.transfer_id = r2.transfer_id
        AND r1.transfer_type = 'SEND'
        AND r2.transfer_type = 'RECEIVE'
      SET r1.recon_status = 'MATCHED', r2.recon_status = 'MATCHED',
          r1.settlement_id = ?, r2.settlement_id = ?
      WHERE r1.recon_status = 'PENDING' AND r2.recon_status = 'PENDING'`,
      [windowId, windowId],
    );

    await conn.execute(
      `UPDATE dfsp_positions SET current_position = 0, reserved_amount = 0, updated_at = NOW()`,
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

//  8. ADMIN TRANSFER
async function handleAdminTransfer(raw) {
  const conn = await pool.getConnection();
  try {
    const p = extractPayload(raw);
    if (!p.transferId) return;
    await saveStateLog(
      conn,
      p.transferId,
      null,
      p.transferState || 'ADMIN',
      'admin',
      'INTERNAL',
      null,
      null,
      raw,
    );
  } catch (err) {
  } finally {
    conn.release();
  }
}

//  START CONSUMER
async function startConsumer() {
  await consumer.connect();
  console.log('Kafka consumer connected');

  const topics = [
    TOPICS.TRANSFER_PREPARE,
    TOPICS.TRANSFER_POSITION,
    TOPICS.TRANSFER_FULFIL,
    TOPICS.TRANSFER_REJECT,
    TOPICS.TIMEOUT,
    TOPICS.NOTIFICATION,
    TOPICS.SETTLEMENT_CLOSE,
    TOPICS.ADMIN_TRANSFER,
  ];

  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  console.log('Subscribed to Mojaloop Kafka topics:');
  topics.forEach((t) => console.log(`   → ${t}`));

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      let raw;
      try {
        raw = JSON.parse(message.value.toString());
        const id = raw?.id || raw?.content?.uriParams?.id || 'unknown';
        console.log(`${topic} ID: ${id}`);

        switch (topic) {
          case TOPICS.TRANSFER_PREPARE:
            await handlePrepare(raw);
            break;
          case TOPICS.TRANSFER_POSITION:
            await handlePosition(raw);
            break;
          case TOPICS.TRANSFER_FULFIL:
            await handleFulfil(raw);
            break;
          case TOPICS.TRANSFER_REJECT:
            await handleReject(raw);
            break;
          case TOPICS.TIMEOUT:
            await handleTimeout(raw);
            break;
          case TOPICS.NOTIFICATION:
            await handleNotification(raw);
            break;
          case TOPICS.SETTLEMENT_CLOSE:
            await handleSettlementClose(raw);
            break;
          case TOPICS.ADMIN_TRANSFER:
            await handleAdminTransfer(raw);
            break;
        }
      } catch (err) {
        console.error(`[${topic}] ${err.message}`);
        if (raw) console.error(`raw: ${JSON.stringify(raw).slice(0, 300)}`);
      }
    },
  });
}

module.exports = { startConsumer };
