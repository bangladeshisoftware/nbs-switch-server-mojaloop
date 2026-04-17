const { consumer, TOPICS } = require('../config/kafka');
const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

// ════════════════════════════════════════════════════════════
//  BASE64 PAYLOAD DECODER
//  Mojaloop Kafka এ payload কখনো base64 encoded string হিসেবে আসে:
//  "data:application/vnd...;base64,eyJ0cmFuc2Zlcklk..."
// ════════════════════════════════════════════════════════════
function decodePayload(payload) {
  if (!payload) return {};

  // Already a plain object — সরাসরি return করো
  if (typeof payload === 'object') return payload;

  // base64 encoded string — decode করো
  if (typeof payload === 'string') {
    try {
      // "data:...;base64,XXXX" format
      const base64Match = payload.match(/base64,(.+)$/);
      if (base64Match) {
        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
        return JSON.parse(decoded);
      }
      // Plain JSON string
      return JSON.parse(payload);
    } catch (e) {
      console.warn(`⚠️ payload decode failed: ${e.message}`);
      return {};
    }
  }

  return {};
}

// ════════════════════════════════════════════════════════════
//  MOJALOOP PAYLOAD EXTRACTOR
// ════════════════════════════════════════════════════════════
function extractPayload(raw) {
  // content.payload decode করো (base64 অথবা object)
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
    // raw inner for debugging
    _inner: inner,
  };
}

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
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
    console.error(`⚠️ saveStateLog: ${e.message}`);
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

// ════════════════════════════════════════════════════════════
//  ১. PREPARE → RECEIVED
// ════════════════════════════════════════════════════════════
async function handlePrepare(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);

    if (!p.transferId) {
      console.warn(`⚠️ [PREPARE] transferId পাওয়া যায়নি, skip`);
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
    console.log(
      `✅ [PREPARE] ${p.transferId} | ${p.payerFsp} → ${p.payeeFsp} | ${p.amount} ${p.currency}`,
    );
  } catch (err) {
    await conn.rollback();
    console.error(`❌ [PREPARE] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ২. POSITION → RESERVED
// ════════════════════════════════════════════════════════════
async function handlePosition(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!transfer) {
      console.warn(`⚠️ [POSITION] Transfer not found: ${p.transferId}`);
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
    console.log(
      `✅ [POSITION] Reserved: ${p.transferId} | ${transfer.payer_fsp} | ${transfer.amount} ${transfer.currency}`,
    );
  } catch (err) {
    await conn.rollback();
    console.error(`❌ [POSITION] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ৩. FULFIL → COMMITTED
//  NOTE: FULFIL payload এ amount নেই, transfers table থেকে নিতে হয়
// ════════════════════════════════════════════════════════════
async function handleFulfil(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!p.transferId) {
      console.warn(`⚠️ [FULFIL] transferId পাওয়া যায়নি`);
      await conn.rollback();
      return;
    }

    // fulfilment ও transferState inner payload থেকে আসে
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

    // Reconciliation — transfers table থেকে amount/currency নাও
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
    console.log(
      `✅ [FULFIL] Committed: ${p.transferId} | ${transfer?.amount} ${transfer?.currency}`,
    );
  } catch (err) {
    await conn.rollback();
    console.error(`❌ [FULFIL] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ৪. REJECT → FAILED
// ════════════════════════════════════════════════════════════
async function handleReject(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!p.transferId) {
      console.warn(`⚠️ [REJECT] transferId পাওয়া যায়নি`);
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
    console.log(`✅ [REJECT] Failed: ${p.transferId} | Error: ${p.errorCode}`);
  } catch (err) {
    await conn.rollback();
    console.error(`❌ [REJECT] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ৫. TIMEOUT
// ════════════════════════════════════════════════════════════
async function handleTimeout(raw) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const p = extractPayload(raw);
    const transfer = await getTransfer(conn, p.transferId);

    if (!p.transferId) {
      console.warn(`⚠️ [TIMEOUT] transferId পাওয়া যায়নি`);
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
    console.log(`✅ [TIMEOUT] Expired: ${p.transferId}`);
  } catch (err) {
    await conn.rollback();
    console.error(`❌ [TIMEOUT] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ৬. NOTIFICATION
// ════════════════════════════════════════════════════════════
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

    console.log(`✅ [NOTIFICATION] → to: ${toFsp} | state: ${transferState}`);
  } catch (err) {
    console.error(`❌ [NOTIFICATION] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ৭. SETTLEMENT CLOSE
// ════════════════════════════════════════════════════════════
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
    console.log(`✅ [SETTLEMENT] Window closed: ${windowId}`);
  } catch (err) {
    await conn.rollback();
    console.error(`❌ [SETTLEMENT] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  ৮. ADMIN TRANSFER
// ════════════════════════════════════════════════════════════
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
    console.log(`✅ [ADMIN] Logged: ${p.transferId}`);
  } catch (err) {
    console.error(`❌ [ADMIN] ${err.message}`);
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════
//  START CONSUMER
// ════════════════════════════════════════════════════════════
async function startConsumer() {
  await consumer.connect();

  await consumer.subscribe({
    topics: [
      TOPICS.TRANSFER_PREPARE,
      TOPICS.TRANSFER_FULFIL,
      TOPICS.TRANSFER_POSITION,
      TOPICS.TRANSFER_POSITION_BATCH,
      TOPICS.NOTIFICATION,
      TOPICS.QUOTES_POST,
      TOPICS.QUOTES_PUT,
      TOPICS.QUOTES_GET,
      TOPICS.SETTLEMENT_CLOSE,
      TOPICS.ADMIN_TRANSFER,
    ],
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let raw;
      try {
        raw = JSON.parse(message.value.toString());
        const id = raw?.id || raw?.content?.uriParams?.id || 'unknown';
        console.log(`\n📨 [${topic}] ID: ${id}`);

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
          case TOPICS.NOTIFICATION:
            await handleNotification(raw);
            break;
          case TOPICS.SETTLEMENT_CLOSE:
            await handleSettlementClose(raw);
            break;
          case TOPICS.ADMIN_TRANSFER:
            await handleAdminTransfer(raw);
            break;
          // QUOTES and POSITION_BATCH — log only for now, no handler yet
          default:
            console.log(
              `📋 [${topic}] No handler yet, raw:`,
              JSON.stringify(raw).slice(0, 200),
            );
        }
      } catch (err) {
        console.error(`❌ [${topic}] ${err.message}`);
        if (raw) console.error(`   raw: ${JSON.stringify(raw).slice(0, 300)}`);
      }
    },
  });

  console.log('✅ Kafka consumer listening on all topics');
}

module.exports = { startConsumer };
