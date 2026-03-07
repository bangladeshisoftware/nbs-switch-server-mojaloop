const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { sendSettlementEmailsToAll } = require('../services/email.service');

const SETTLEMENT_URL =
  process.env.SETTLEMENT_URL || 'https://settlement.mojaloop.xyz/v2';

// get open window from settlement service
async function getOpenWindowsFromService() {
  const res = await axios.get(
    `${SETTLEMENT_URL}/settlementWindows?state=OPEN`,
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return res.data || [];
}

// get all window from settlement service
async function getWindowsFromService(state = null) {
  const url = state
    ? `${SETTLEMENT_URL}/settlementWindows?state=${state}`
    : `${SETTLEMENT_URL}/settlementWindows`;
  const res = await axios.get(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  return res.data || [];
}

// window sync in db.
async function syncWindowToDB(win) {
  const windowId = String(win.settlementWindowId || win.id);
  const status = win.state || win.status || 'OPEN';
  try {
    await pool.execute(
      `
      INSERT INTO settlement_windows (id, window_id, status, opened_at, closed_at)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status     = VALUES(status),
        closed_at  = VALUES(closed_at),
        updated_at = NOW()`,
      [
        uuidv4(),
        windowId,
        status,
        win.createdDate || win.opened_at || null,
        win.changedDate || win.closed_at || null,
      ],
    );
  } catch (e) {
    console.error(`⚠️ syncWindowToDB: ${e.message}`);
  }
}

//settlement/windows

exports.getWindows = async (req, res) => {
  try {
    // get live window
    let serviceWindows = [];
    try {
      serviceWindows = await getWindowsFromService('OPEN');

      // db sync
      for (const win of serviceWindows) {
        await syncWindowToDB(win);
      }
    } catch (e) {
      console.warn(
        `Settlement Service unavailable: ${e.message} — showing DB data`,
      );
    }

    // db sync data
    const [rows] = await pool.execute(`
      SELECT * FROM settlement_windows
      ORDER BY created_at DESC LIMIT 50`);

    res.json({
      data: rows,
      live_from_service: serviceWindows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

//  settlement window open
exports.getOpenWindows = async (req, res) => {
  try {
    const openWindows = await getOpenWindowsFromService();
    res.json({ data: openWindows, count: openWindows.length });
  } catch (err) {
    // if service unavailable then show db record.
    try {
      const [rows] = await pool.execute(
        `SELECT * FROM settlement_windows WHERE status = 'OPEN' ORDER BY created_at DESC`,
      );
      res.json({ data: rows, count: rows.length, source: 'db_fallback' });
    } catch (dbErr) {
      res.status(500).json({ error: err.message });
    }
  }
};

// get position
exports.getPositions = async (req, res) => {
  try {
    const { currency, date } = req.query;

    const conditions = [`t.status = 'COMMITTED'`];
    const values = [];

    if (currency) {
      conditions.push(`t.currency = ?`);
      values.push(currency);
    }

    if (date) {
      conditions.push(`DATE(t.completed_at) = ?`);
      values.push(date);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [positions] = await pool.execute(
      `
      SELECT
        dfsp,
        currency,
        SUM(sent) AS total_sent,
        SUM(received) AS total_received,
        SUM(received) - SUM(sent) AS net_position
      FROM (
        SELECT 
          t.payer_fsp AS dfsp, 
          t.currency,
          SUM(t.amount) AS sent, 
          0 AS received
        FROM transfers t
        ${where}
        GROUP BY t.payer_fsp, t.currency

        UNION ALL

        SELECT 
          t.payee_fsp AS dfsp, 
          t.currency,
          0 AS sent, 
          SUM(t.amount) AS received
        FROM transfers t
        ${where}
        GROUP BY t.payee_fsp, t.currency
      ) positions
      GROUP BY dfsp, currency
      ORDER BY dfsp
      `,
      [...values, ...values], // duplicated twice.
    );

    res.json({ data: positions });
  } catch (err) {
    console.error('Error in getPositions:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.openWindow = async (req, res) => {
  try {
    // settlement service open
    let serviceWindowId = null;
    let serviceData = null;

    try {
      const openWindows = await getOpenWindowsFromService();

      if (openWindows.length > 0) {
        // Already Presented OPEN window
        serviceWindowId = String(
          openWindows[0].settlementWindowId || openWindows[0].id,
        );
        serviceData = openWindows[0];
        console.log(`[SETTLEMENT] Already open window: ${serviceWindowId}`);
      } else {
        serviceWindowId = uuidv4();
        console.log(`[SETTLEMENT] No open window in Settlement Service`);
      }
    } catch (e) {
      console.warn(`Settlement Service unavailable: ${e.message}`);
      serviceWindowId = uuidv4();
    }

    // DB save
    await pool.execute(
      `
      INSERT INTO settlement_windows (id, window_id, status, opened_at)
      VALUES (?, ?, 'OPEN', NOW())
      ON DUPLICATE KEY UPDATE status = 'OPEN', updated_at = NOW()`,
      [uuidv4(), serviceWindowId],
    );

    console.log(`[SETTLEMENT] Window opened: ${serviceWindowId}`);

    res.status(201).json({
      message: 'Settlement window opened',
      window_id: serviceWindowId,
      service_data: serviceData,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
// complete settlement.
exports.completeSettlement = async (req, res) => {
  const { reason = 'End of day settlement', window_id } = req.body;

  if (!reason || reason.trim() === '') {
    return res.status(400).json({ error: 'reason is required' });
  }

  const results = {
    step1_windowClosed: null,
    step2_settlementCreated: null,
    step3_recorded: null,
    step4_reserved: null,
    step5_committed: null,
    step6_settled: null,
  };

  try {
    //  STEP 1: OPEN window find to close
    let windowId = window_id;

    if (!windowId) {
      const openWindows = await getOpenWindowsFromService();
      if (!openWindows || openWindows.length === 0) {
        return res
          .status(400)
          .json({ error: 'No open settlement windows found' });
      }
      // numeric settlementWindowId
      windowId = openWindows[0].settlementWindowId || openWindows[0].id;
    }

    const closingWindowId = Number(windowId);

    console.log(`[SETTLEMENT] Step 1: Closing window ${closingWindowId}`);

    const closeRes = await axios.post(
      `${SETTLEMENT_URL}/settlementWindows/${closingWindowId}`,
      { state: 'CLOSED', reason },
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step1_windowClosed = closeRes.data;

    console.log(`[SETTLEMENT] Step 1: Window ${closingWindowId} closed`);
    console.log(
      `   Mojaloop new auto-window:`,
      closeRes.data?.settlementWindowId || 'N/A',
    );

    // DB update
    await pool.execute(
      `
      UPDATE settlement_windows
      SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
      WHERE window_id = ?`,
      [String(closingWindowId)],
    );

    // step 2 creating settlement.

    console.log(
      `[SETTLEMENT] Step 2: Creating settlement for window ${closingWindowId}`,
    );

    let createRes;
    try {
      createRes = await axios.post(
        `${SETTLEMENT_URL}/settlements`,
        {
          reason,
          settlementModel: 'DEFERREDNET',
          settlementWindows: [{ id: closingWindowId }],
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (step2Err) {
      console.error(`Step 2 failed:`);
      console.error(`   Status:`, step2Err.response?.status);
      console.error(
        `   Error:`,
        JSON.stringify(step2Err.response?.data, null, 2),
      );
      console.error(
        `   Request body:`,
        JSON.stringify({
          reason,
          settlementModel: 'DEFERREDNET',
          settlementWindows: [{ id: closingWindowId }],
        }),
      );
      throw step2Err;
    }

    results.step2_settlementCreated = createRes.data;
    const settlementId = createRes.data.id;
    const participants = createRes.data.participants || [];
    console.log(
      `[SETTLEMENT] Step 2: Settlement created | ID: ${settlementId} | Participants: ${participants.length}`,
    );

    // helper
    const makeBody = (state, stateReason) => ({
      participants: participants.map((p) => ({
        id: p.id,
        accounts: (p.accounts || []).map((a) => ({
          id: a.id,
          state,
          reason: stateReason,
        })),
      })),
    });

    //  STEP 3: PS_TRANSFERS_RECORDED
    console.log(`[SETTLEMENT] Step 3: PS_TRANSFERS_RECORDED`);
    await new Promise((r) => setTimeout(r, 500));
    const step3Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RECORDED', 'Recording settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step3_recorded = step3Res.data;
    console.log(`[SETTLEMENT] Step 3 done`);

    //  STEP 4: PS_TRANSFERS_RESERVED
    console.log(`[SETTLEMENT] Step 4: PS_TRANSFERS_RESERVED`);
    await new Promise((r) => setTimeout(r, 500));
    const step4Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RESERVED', 'Reserving settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step4_reserved = step4Res.data;
    console.log(`[SETTLEMENT] Step 4 done`);

    //  STEP 5: PS_TRANSFERS_COMMITTED
    console.log(`[SETTLEMENT] Step 5: PS_TRANSFERS_COMMITTED`);
    await new Promise((r) => setTimeout(r, 500));
    const step5Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_COMMITTED', 'Committing settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step5_committed = step5Res.data;
    console.log(`[SETTLEMENT] Step 5 done`);

    //  STEP 6: SETTLED
    console.log(`[SETTLEMENT] Step 6: SETTLED`);
    await new Promise((r) => setTimeout(r, 500));
    const step6Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('SETTLED', 'Settlement completed by Central Bank'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step6_settled = step6Res.data;
    console.log(`[SETTLEMENT] Step 6 done — Settlement COMPLETE`);

    //  DB CLEANUP
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(
        `
        UPDATE reconciliation r1
        JOIN reconciliation r2
          ON r1.transfer_id = r2.transfer_id
          AND r1.transfer_type = 'SEND'
          AND r2.transfer_type = 'RECEIVE'
        SET r1.recon_status = 'MATCHED', r2.recon_status = 'MATCHED',
            r1.settlement_id = ?,         r2.settlement_id = ?
        WHERE r1.recon_status = 'PENDING' AND r2.recon_status = 'PENDING'`,
        [String(settlementId), String(settlementId)],
      );

      await conn.execute(
        `UPDATE dfsp_positions SET current_position = 0, reserved_amount = 0, updated_at = NOW()`,
      );

      await conn.execute(
        `
        UPDATE settlement_windows
        SET status = 'SETTLED', settled_at = NOW(), updated_at = NOW()
        WHERE window_id = ?`,
        [String(closingWindowId)],
      );

      await conn.commit();
      console.log(`[SETTLEMENT] DB cleanup done`);
    } catch (dbErr) {
      await conn.rollback();
      console.error(`[SETTLEMENT] DB cleanup failed: ${dbErr.message}`);
    } finally {
      conn.release();
    }

    // send email
     const emailResults = await sendSettlementEmailsToAll({
      pool,
      settlementId,
      windowId:    closingWindowId,
      participants,
    }).catch(e => {
      console.error(`[SETTLEMENT] Email sending failed: ${e.message}`);
      return [];
    });
    // send email

    return res.json({
      success: true,
      message: 'Settlement completed successfully through all 6 steps',
      settlement_id: settlementId,
      window_id: closingWindowId,
      results,
    });
  } catch (err) {
    const step =
      Object.entries(results).find(([, v]) => v === null)?.[0] || 'unknown';
    console.error(`[SETTLEMENT] Failed at ${step}: ${err.message}`);
    return res.status(err.response?.status || 500).json({
      error: `Failed at ${step}`,
      details: err.response?.data || err.message,
      results,
    });
  }
};


exports.closeWindow = async (req, res) => {
  try {
    const { windowId } = req.params;
    const { reason = 'Manual close' } = req.body;

    // Settlement Service এ close করো
    try {
      await axios.post(
        `${SETTLEMENT_URL}/settlementWindows/${windowId}`,
        { state: 'CLOSED', reason },
        { headers: { 'Content-Type': 'application/json' } },
      );
      console.log(`[SETTLEMENT] Window closed in service: ${windowId}`);
    } catch (e) {
      console.warn(`Settlement Service close failed: ${e.message}`);
    }

    // DB update
    await pool.execute(
      `
      UPDATE settlement_windows
      SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
      WHERE window_id = ? AND status = 'OPEN'`,
      [windowId],
    );

    res.json({ message: 'Settlement window closed', window_id: windowId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
