const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { sendSettlementEmailsToAll } = require('../services/email.service');

const SETTLEMENT_URL =
  process.env.SETTLEMENT_URL || 'https://settlement.mojaloop.xyz/v2';
const CENTRAL_LEDGER = process.env.CENTRAL_LEDGER_URL || 'https://ledger.mojaloop.xyz';

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

/*
exports.completeSettlement = async (req, res) => {
  const { reason = 'End of day settlement', window_id } = req.body;

  if (!reason || reason.trim() === '') {
    return res.status(400).json({ error: 'reason is required' });
  }

  const results = {
    step1_windowClosed:      null,
    step2_settlementCreated: null,
    step3_recorded:          null,
    step4_reserved:          null,
    step5_committed:         null,
    step6_settled:           null,
    step7_positionsReset:    null,  // ← NEW: recordFundsIn for each DFSP
  };

  try {
    // ── STEP 1: Find and close OPEN window ────────────────────
    let windowId = window_id;

    if (!windowId) {
      const openWindows = await getOpenWindowsFromService();
      if (!openWindows || openWindows.length === 0) {
        return res.status(400).json({ error: 'No open settlement windows found' });
      }
      windowId = openWindows[0].settlementWindowId || openWindows[0].id;
    }

    const closingWindowId = Number(windowId);
    console.log(`[SETTLEMENT] Step 1: Closing window ${closingWindowId}`);

    const closeRes = await axios.post(
      `${SETTLEMENT_URL}/settlementWindows/${closingWindowId}`,
      { state: 'CLOSED', reason },
      { headers: { 'Content-Type': 'application/json' } }
    );

    // closeRes.data = newly auto-created OPEN window (NOT the closed one)
    results.step1_windowClosed = {
      closedWindowId: closingWindowId,
      newWindowId:    closeRes.data?.settlementWindowId,
      newWindowState: closeRes.data?.state,
    };

    console.log(`[SETTLEMENT] Step 1: Window ${closingWindowId} closed`);
    console.log(`[SETTLEMENT] New auto-window: ${closeRes.data?.settlementWindowId}`);

    // Update local DB
    await pool.execute(
      `UPDATE settlement_windows
       SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
       WHERE window_id = ?`,
      [String(closingWindowId)]
    );

    // Wait for Mojaloop to finalize window state
    await new Promise(r => setTimeout(r, 1000));

    // ── STEP 2: Create settlement ─────────────────────────────
    console.log(`[SETTLEMENT] Step 2: Creating settlement for window ${closingWindowId}`);

    let createRes;
    try {
      createRes = await axios.post(
        `${SETTLEMENT_URL}/settlements`,
        {
          reason,
          settlementModel:   'DEFERREDNET',
          settlementWindows: [{ id: closingWindowId }],
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (step2Err) {
      const errCode = step2Err.response?.data?.errorInformation?.errorCode;
      const errDesc = step2Err.response?.data?.errorInformation?.errorDescription;

      if (errCode === '3100' && errDesc?.includes('Inapplicable')) {
        return res.status(400).json({
          error:   'Settlement window has no transfers to settle',
          details: `Window ${closingWindowId} has no committed transfers. Make transfers first.`,
          results,
        });
      }

      console.error(`[SETTLEMENT] Step 2 failed: ${errCode} — ${errDesc}`);
      throw step2Err;
    }

    results.step2_settlementCreated = createRes.data;
    const settlementId = createRes.data.id;
    const participants = createRes.data.participants || [];

    console.log(`[SETTLEMENT] Step 2: Settlement ID=${settlementId} | Participants=${participants.length}`);

    if (participants.length === 0) {
      return res.status(400).json({
        error:   'Settlement created but has no participants',
        details: 'No DFSP positions to settle',
        results,
      });
    }

    // ── Helper: build state change body ───────────────────────
    const makeBody = (state, stateReason) => ({
      participants: participants.map(p => ({
        id:       p.id,
        accounts: (p.accounts || []).map(a => ({
          id:     a.id,
          state,
          reason: stateReason,
        })),
      })),
    });

    // ── STEP 3: PS_TRANSFERS_RECORDED ─────────────────────────
    console.log(`[SETTLEMENT] Step 3: PS_TRANSFERS_RECORDED`);
    await new Promise(r => setTimeout(r, 500));
    const step3Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RECORDED', 'Recording settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step3_recorded = step3Res.data;
    console.log(`[SETTLEMENT] Step 3 done`);

    // ── STEP 4: PS_TRANSFERS_RESERVED ─────────────────────────
    console.log(`[SETTLEMENT] Step 4: PS_TRANSFERS_RESERVED`);
    await new Promise(r => setTimeout(r, 500));
    const step4Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RESERVED', 'Reserving settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step4_reserved = step4Res.data;
    console.log(`[SETTLEMENT] Step 4 done`);

    // ── STEP 5: PS_TRANSFERS_COMMITTED ────────────────────────
    console.log(`[SETTLEMENT] Step 5: PS_TRANSFERS_COMMITTED`);
    await new Promise(r => setTimeout(r, 500));
    const step5Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_COMMITTED', 'Committing settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step5_committed = step5Res.data;
    console.log(`[SETTLEMENT] Step 5 done`);

    // ── STEP 6: SETTLED ───────────────────────────────────────
    console.log(`[SETTLEMENT] Step 6: SETTLED`);
    await new Promise(r => setTimeout(r, 500));
    const step6Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('SETTLED', 'Settlement completed by Central Bank'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step6_settled = step6Res.data;
    console.log(`[SETTLEMENT] Step 6 done — Settlement COMPLETE ✅`);

    // ── STEP 7: Reset positions in Mojaloop Central Ledger ────
    // For each participant — fetch their name from CL, get their
    // SETTLEMENT account, then call recordFundsIn to restore liquidity
    console.log(`[SETTLEMENT] Step 7: Resetting positions via recordFundsIn`);
    await new Promise(r => setTimeout(r, 500));

    const positionResetResults = [];

    for (const participant of participants) {
      const netAmount    = participant.accounts?.[0]?.netSettlementAmount?.amount;
      const currency     = participant.accounts?.[0]?.netSettlementAmount?.currency || 'BDT';
      const absAmount    = Math.abs(parseFloat(netAmount || '0'));
      const participantId = participant.id;

      if (absAmount === 0) {
        positionResetResults.push({ participantId, status: 'skipped', reason: 'zero amount' });
        continue;
      }

      try {
        // ── Get participant name from Central Ledger ───────────
        const participantRes = await axios.get(
          `${CENTRAL_LEDGER}/participants`,
          { headers: { 'fspiop-source': 'switch', 'Content-Type': 'application/json' } }
        );

        // Central Ledger returns array — match by internal ID
        // We match via accounts endpoint
        const allParticipants = participantRes.data || [];

        // Find participant name by fetching their accounts and matching
        // participant.id in settlement response = participantCurrencyId in CL
        let participantName = null;
        for (const p of allParticipants) {
          if (['Hub', 'hub'].includes(p.name)) continue;
          try {
            const accRes = await axios.get(
              `${CENTRAL_LEDGER}/participants/${p.name}/accounts`,
              { headers: { 'fspiop-source': 'switch' } }
            );
            const hasAccount = (accRes.data || []).some(
              a => a.id === participant.accounts?.[0]?.id
            );
            if (hasAccount) {
              participantName = p.name;
              break;
            }
          } catch (_) {}
        }

        if (!participantName) {
          console.warn(`[SETTLEMENT] Could not find name for participant ID ${participantId}`);
          positionResetResults.push({ participantId, status: 'failed', reason: 'participant name not found' });
          continue;
        }

        // ── Get SETTLEMENT account for this participant ────────
        const accRes = await axios.get(
          `${CENTRAL_LEDGER}/participants/${participantName}/accounts`,
          { headers: { 'fspiop-source': 'switch' } }
        );

        const settlementAccount = (accRes.data || []).find(
          a => a.ledgerAccountType === 'SETTLEMENT' && a.currency === currency
        );

        if (!settlementAccount) {
          console.warn(`[SETTLEMENT] No SETTLEMENT account for ${participantName}`);
          positionResetResults.push({ participantName, status: 'failed', reason: 'no settlement account' });
          continue;
        }

        // ── Call recordFundsIn → resets Mojaloop position ─────
        // recordFundsIn adds liquidity back — restores position to 0
        await axios.post(
          `${CENTRAL_LEDGER}/participants/${participantName}/accounts/${settlementAccount.id}`,
          {
            transferId:        uuidv4(),
            externalReference: `settlement-${settlementId}-reset`,
            action:            'recordFundsIn',
            reason:            `Post-settlement position reset — settlement ID ${settlementId}`,
            amount: {
              amount:   String(absAmount.toFixed(4)),
              currency,
            },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'fspiop-source': 'switch',
            },
          }
        );

        console.log(`[SETTLEMENT] ✅ recordFundsIn: ${participantName} +${absAmount} ${currency}`);
        positionResetResults.push({
          participantName,
          participantId,
          amount:   absAmount,
          currency,
          status:   'ok',
          action:   'recordFundsIn',
        });

      } catch (fundErr) {
        console.error(`[SETTLEMENT] ❌ recordFundsIn failed for participant ${participantId}: ${fundErr.message}`);
        positionResetResults.push({
          participantId,
          status: 'failed',
          error:  fundErr.response?.data || fundErr.message,
        });
      }
    }

    results.step7_positionsReset = positionResetResults;
    console.log(`[SETTLEMENT] Step 7 done — ${positionResetResults.filter(r => r.status === 'ok').length}/${positionResetResults.length} positions reset`);

    // ── DB Cleanup — update local R Switch DB to match ────────
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Mark reconciliation records as MATCHED
      await conn.execute(
        `UPDATE reconciliation r1
         JOIN reconciliation r2
           ON r1.transfer_id = r2.transfer_id
           AND r1.transfer_type = 'SEND'
           AND r2.transfer_type = 'RECEIVE'
         SET r1.recon_status = 'MATCHED', r2.recon_status = 'MATCHED',
             r1.settlement_id = ?,        r2.settlement_id = ?
         WHERE r1.recon_status = 'PENDING' AND r2.recon_status = 'PENDING'`,
        [String(settlementId), String(settlementId)]
      );

      // Reset local dfsp_positions to match Mojaloop (now 0 after recordFundsIn)
      await conn.execute(
        `UPDATE dfsp_positions
         SET current_position = 0, reserved_amount = 0, updated_at = NOW()`
      );

      // Mark settlement window as SETTLED
      await conn.execute(
        `UPDATE settlement_windows
         SET status = 'SETTLED', settled_at = NOW(), updated_at = NOW()
         WHERE window_id = ?`,
        [String(closingWindowId)]
      );

      await conn.commit();
      console.log(`[SETTLEMENT] DB cleanup done`);
    } catch (dbErr) {
      await conn.rollback();
      console.error(`[SETTLEMENT] DB cleanup failed: ${dbErr.message}`);
    } finally {
      conn.release();
    }

    // ── Send settlement emails ────────────────────────────────
    await sendSettlementEmailsToAll({
      pool,
      settlementId,
      windowId:    closingWindowId,
      participants,
    }).catch(e => {
      console.error(`[SETTLEMENT] Email failed: ${e.message}`);
    });

    return res.json({
      success:       true,
      message:       'Settlement completed successfully through all 7 steps',
      settlement_id: settlementId,
      window_id:     closingWindowId,
      positions_reset: positionResetResults.filter(r => r.status === 'ok').length,
      results,
    });

  } catch (err) {
    const failedStep = Object.entries(results).find(([, v]) => v === null)?.[0] || 'unknown';
    console.error(`[SETTLEMENT] Failed at ${failedStep}: ${err.message}`);
    return res.status(err.response?.status || 500).json({
      error:   `Failed at ${failedStep}`,
      details: err.response?.data || err.message,
      results,
    });
  }
};
*/

exports.completeSettlement = async (req, res) => {
  const { reason = 'End of day settlement', window_id } = req.body;

  if (!reason || reason.trim() === '') {
    return res.status(400).json({ error: 'reason is required' });
  }

  const results = {
    step1_windowClosed:      null,
    step2_settlementCreated: null,
    step3_recorded:          null,
    step4_reserved:          null,
    step5_committed:         null,
    step6_settled:           null,
  };

  try {
    // ── STEP 1: Find and close OPEN window ────────────────────
    let windowId = window_id;

    if (!windowId) {
      const openWindows = await getOpenWindowsFromService();
      if (!openWindows || openWindows.length === 0) {
        return res.status(400).json({ error: 'No open settlement windows found' });
      }
      windowId = openWindows[0].settlementWindowId || openWindows[0].id;
    }

    const closingWindowId = Number(windowId);

    const closeRes = await axios.post(
      `${SETTLEMENT_URL}/settlementWindows/${closingWindowId}`,
      { state: 'CLOSED', reason },
      { headers: { 'Content-Type': 'application/json' } }
    );

    // closeRes.data = newly auto-created OPEN window (NOT the closed one)
    results.step1_windowClosed = {
      closedWindowId: closingWindowId,
      newWindowId:    closeRes.data?.settlementWindowId,
      newWindowState: closeRes.data?.state,
    };

    // Update local DB
    await pool.execute(
      `UPDATE settlement_windows
       SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
       WHERE window_id = ?`,
      [String(closingWindowId)]
    );

    // Wait for Mojaloop to finalize window state
    await new Promise(r => setTimeout(r, 1000));

    // ── STEP 2: Create settlement ─────────────────────────────

    let createRes;
    try {
      createRes = await axios.post(
        `${SETTLEMENT_URL}/settlements`,
        {
          reason,
          settlementModel:   'DEFERREDNET',
          settlementWindows: [{ id: closingWindowId }],
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (step2Err) {
      const errCode = step2Err.response?.data?.errorInformation?.errorCode;
      const errDesc = step2Err.response?.data?.errorInformation?.errorDescription;

      if (errCode === '3100' && errDesc?.includes('Inapplicable')) {
        return res.status(400).json({
          error:   'Settlement window has no transfers to settle',
          details: `Window ${closingWindowId} has no committed transfers. Make transfers first.`,
          results,
        });
      }

      throw step2Err;
    }

    results.step2_settlementCreated = createRes.data;
    const settlementId = createRes.data.id;
    const participants = createRes.data.participants || [];

    if (participants.length === 0) {
      return res.status(400).json({
        error:   'Settlement created but has no participants',
        details: 'No DFSP positions to settle',
        results,
      });
    }

    // ── Helper: build state change body ───────────────────────
    const makeBody = (state, stateReason) => ({
      participants: participants.map(p => ({
        id:       p.id,
        accounts: (p.accounts || []).map(a => ({
          id:     a.id,
          state,
          reason: stateReason,
        })),
      })),
    });

    // ── STEP 3: PS_TRANSFERS_RECORDED ─────────────────────────
    await new Promise(r => setTimeout(r, 500));
    const step3Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RECORDED', 'Recording settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step3_recorded = step3Res.data;

    // ── STEP 4: PS_TRANSFERS_RESERVED ─────────────────────────
    await new Promise(r => setTimeout(r, 500));
    const step4Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RESERVED', 'Reserving settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step4_reserved = step4Res.data;

    // ── STEP 5: PS_TRANSFERS_COMMITTED ────────────────────────
    await new Promise(r => setTimeout(r, 500));
    const step5Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_COMMITTED', 'Committing settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step5_committed = step5Res.data;

    // ── STEP 6: SETTLED ───────────────────────────────────────
    await new Promise(r => setTimeout(r, 500));
    const step6Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('SETTLED', 'Settlement completed by Central Bank'),
      { headers: { 'Content-Type': 'application/json' } }
    );
    results.step6_settled = step6Res.data;

    // STEP 7: Save to settlement_completed_records
    /*
    for (const participant of participants) {
      const netAmount  = parseFloat(participant.accounts?.[0]?.netSettlementAmount?.amount || 0);
      const currency   = participant.accounts?.[0]?.netSettlementAmount?.currency || 'BDT';
    
      await pool.execute(
        `INSERT INTO settlement_completed_records
           (id, window_id, settlement_id, dfsp_name,
            before_position, after_position, net_amount, currency, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
        [
          require('uuid').v4(),
          String(closingWindowId),
          String(settlementId),
          `participant_${participant.id}`,  // replace with real name if available
          netAmount,                         // before_position = net amount
          netAmount,                         // net_amount
          currency,
        ]
      ).catch(e => console.warn('[SETTLEMENT] completed_records save failed:', e.message));
    } */
    
    const participantNameMap = {};  // { participantCurrencyId: 'ABank' }

try {
  const clParticipants = await axios.get(
    `${CENTRAL_LEDGER}/participants`,
    { headers: { 'fspiop-source': 'switch' } }
  );

  for (const p of (clParticipants.data || [])) {
    if (['Hub', 'hub', 'HUB'].includes(p.name)) continue;
    try {
      const accRes = await axios.get(
        `${CENTRAL_LEDGER}/participants/${p.name}/accounts`,
        { headers: { 'fspiop-source': 'switch' } }
      );
      for (const acc of (accRes.data || [])) {
        participantNameMap[acc.id] = p.name;  // accountId → dfspName
      }
    } catch (_) {}
  }
} catch (e) {
  console.warn('[SETTLEMENT] Could not build participantNameMap:', e.message);
}

// ── STEP 7: Save to settlement_completed_records ──────────────
for (const participant of participants) {
  const account    = participant.accounts?.[0];
  const netAmount  = parseFloat(account?.netSettlementAmount?.amount || 0);
  const currency   = account?.netSettlementAmount?.currency || 'BDT';

  const dfspName   = participantNameMap[account?.id] || `participant_${participant.id}`;

  // before_position = fetch from CL positions
  let beforePosition = netAmount; // fallback
  try {
    const posRes = await axios.get(
      `${CENTRAL_LEDGER}/participants/${dfspName}/positions`,
      { headers: { 'fspiop-source': 'switch' } }
    );
    const posData = posRes.data;
    beforePosition = parseFloat(
      (Array.isArray(posData) ? posData[0]?.value : posData?.value) || 0
    );
  } catch (_) {}

  await pool.execute(
    `INSERT INTO settlement_completed_records
       (id, window_id, settlement_id, dfsp_name,
        before_position, after_position, net_amount, currency, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
    [
      require('uuid').v4(),
      String(closingWindowId),
      String(settlementId),
      dfspName,        // ✅ real DFSP name
      beforePosition,  // ✅ real position before reset
      netAmount,
      currency,
    ]
  ).catch(e => console.warn('[SETTLEMENT] completed_records save failed:', e.message));
}

    // ── DB Cleanup ────────────────────────────────────────────
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Mark reconciliation records as MATCHED
      await conn.execute(
        `UPDATE reconciliation r1
         JOIN reconciliation r2
           ON r1.transfer_id = r2.transfer_id
           AND r1.transfer_type = 'SEND'
           AND r2.transfer_type = 'RECEIVE'
         SET r1.recon_status = 'MATCHED', r2.recon_status = 'MATCHED',
             r1.settlement_id = ?,        r2.settlement_id = ?
         WHERE r1.recon_status = 'PENDING' AND r2.recon_status = 'PENDING'`,
        [String(settlementId), String(settlementId)]
      );

      // Reset local dfsp_positions to 0 — matches Mojaloop after SETTLED
      await conn.execute(
        `UPDATE dfsp_positions
         SET current_position = 0, reserved_amount = 0, updated_at = NOW()`
      );

      // Mark settlement window as SETTLED
      await conn.execute(
        `UPDATE settlement_windows
         SET status = 'SETTLED', settled_at = NOW(), updated_at = NOW()
         WHERE window_id = ?`,
        [String(closingWindowId)]
      );

      await conn.commit();
    } catch (dbErr) {
      await conn.rollback();
      console.error(`[SETTLEMENT] DB cleanup failed: ${dbErr.message}`);
    } finally {
      conn.release();
    }

    // ── Send settlement emails ────────────────────────────────
    /*
    await sendSettlementEmailsToAll({
      pool,
      settlementId,
      windowId:    closingWindowId,
      participants,
    }).catch(e => {
      console.error(`[SETTLEMENT] Email failed: ${e.message}`);
    }); */

    return res.json({
      success:       true,
      message:       'Settlement completed successfully through all 6 steps',
      settlement_id: settlementId,
      window_id:     closingWindowId,
      results,
      participants: participants
    });

  } catch (err) {
    const failedStep = Object.entries(results).find(([, v]) => v === null)?.[0] || 'unknown';
    console.error(`[SETTLEMENT] Failed at ${failedStep}: ${err.message}`);
    return res.status(err.response?.status || 500).json({
      error:   `Failed at ${failedStep}`,
      details: err.response?.data || err.message,
      results,
    });
  }
};

exports.finalizeByWindow = async (req, res) => {
  const { windowId } = req.params;
  const { reason = 'Post-settlement physical transfer confirmed by Central Bank' } = req.body;

  if (!windowId)
    return res.status(400).json({ error: 'windowId required' });

  const { randomUUID } = require('crypto');

  const results = {
    window_id:       windowId,
    funds_movements: [],
  };

  // ── Helper: fetch real SETTLEMENT account value from CL ────
  const getSettlementValue = async (dfspId, currency) => {
    try {
      const accRes = await axios.get(
        `${CENTRAL_LEDGER}/participants/${dfspId}/accounts`,
        { headers: { 'fspiop-source': 'switch' } }
      );
      const settAcc = (accRes.data || []).find(
        a => a.ledgerAccountType === 'SETTLEMENT' && a.currency === currency
      );
      return settAcc ? parseFloat(settAcc.value) : null;
    } catch (e) {
      console.warn(`[FINALIZE] getSettlementValue failed for ${dfspId}: ${e.message}`);
      return null;
    }
  };

  try {
    // ── Get all active participants ────────────────────────────
    const clRes = await axios.get(
      `${CENTRAL_LEDGER}/participants`,
      { headers: { 'fspiop-source': 'switch' } }
    );
    const allParticipants = (clRes.data || [])
      .filter(p => p.isActive === 1 && !['Hub', 'hub', 'HUB'].includes(p.name));

    if (allParticipants.length === 0)
      return res.status(400).json({ error: 'No active participants found' });

    console.log(`[FINALIZE] Window ${windowId} | ${allParticipants.length} participants`);

    // ── Process each DFSP ─────────────────────────────────────
    for (const participant of allParticipants) {
      const dfspId = participant.name;

      // Fetch position + accounts in parallel
      // posRes.status === 'fulfilled' is Promise.allSettled status — not axios status
      const [posRes, accRes] = await Promise.allSettled([
        axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/positions`,
          { headers: { 'fspiop-source': 'switch' } }),
        axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/accounts`,
          { headers: { 'fspiop-source': 'switch' } }),
      ]);

      // ── Get position value ────────────────────────────────────
      let positionValue = 0;
      let currency      = 'BDT';

      if (posRes.status === 'fulfilled') {
        const posData  = posRes.value.data;
        const posEntry = Array.isArray(posData) ? posData[0] : posData;
        positionValue  = parseFloat(posEntry?.value    || 0);
        currency       = posEntry?.currency || 'BDT';
      } else {
        const errMsg = `Could not fetch position: ${posRes.reason?.message}`;
        results.funds_movements.push({ participantName: dfspId, status: 'failed', reason: errMsg });
        await _saveRecord({ pool, randomUUID, windowId, dfspName: dfspId,
          type: 'credit', action: 'recordFundsIn', status: 'failed',
          amount: 0, beforeAmount: null, afterAmount: null,
          currency, positionValue: 0, error: errMsg, reason });
        continue;
      }

      // ── Get accounts ──────────────────────────────────────────
      let accounts = [];
      if (accRes.status === 'fulfilled') {
        accounts = accRes.value.data || [];
      } else {
        results.funds_movements.push({
          participantName: dfspId, status: 'failed',
          reason: `Could not fetch accounts: ${accRes.reason?.message}`,
        });
        continue;
      }

      // ── Find SETTLEMENT account ───────────────────────────────
      const settlementAcct = accounts.find(
        a => a.ledgerAccountType === 'SETTLEMENT' && a.currency === currency
      );

      if (!settlementAcct) {
        const errMsg = `No SETTLEMENT account for ${dfspId} ${currency}`;
        results.funds_movements.push({ participantName: dfspId, status: 'failed', reason: errMsg });
        await _saveRecord({ pool, randomUUID, windowId, dfspName: dfspId,
          type: 'credit', action: 'recordFundsIn', status: 'failed',
          amount: 0, beforeAmount: null, afterAmount: null,
          currency, positionValue, error: errMsg, reason });
        continue;
      }

      const absAmount = Math.abs(positionValue);
      const clAcctId  = settlementAcct.id;
      const clUrl     = `${CENTRAL_LEDGER}/participants/${dfspId}/accounts/${clAcctId}`;
      const clHeaders = {
        'Content-Type':  'application/vnd.interoperability.participants+json;version=1.1',
        'fspiop-source': 'switch',
        'Date':          new Date().toUTCString(),
      };

      // ── FIX: fetch real beforeAmount from CL (not from accounts list)
      // accounts list value may be stale — fetch fresh value
      const beforeAmount = await getSettlementValue(dfspId, currency);

      console.log(`[FINALIZE] ${dfspId} | position=${positionValue} | settlement_before=${beforeAmount} | currency=${currency}`);

      // ── Skip zero position ────────────────────────────────────
      if (positionValue === 0) {
        results.funds_movements.push({
          participantName: dfspId, positionValue: 0,
          settlementValue: beforeAmount, currency,
          status: 'skipped', reason: 'position is 0 — no net obligation',
        });
        continue;
      }

      // ════════════════════════════════════════════════════════
      //  POSITIVE POSITION → recordFundsIn (credit, 1 step)
      // ════════════════════════════════════════════════════════
      if (positionValue > 0) {
        const transferId = randomUUID();
        try {
          await axios.post(clUrl, {
            transferId,
            externalReference: `window-${windowId}-${dfspId}-credit`,
            action:            'recordFundsIn',
            reason:            `${reason} — window ${windowId}`,
            amount:            { amount: absAmount.toFixed(4), currency },
          }, { headers: clHeaders });

          // ── FIX: fetch real afterAmount from CL after API call
          const afterAmount = await getSettlementValue(dfspId, currency);
          console.log(`[FINALIZE] ✅ recordFundsIn: ${dfspId} | before=${beforeAmount} after=${afterAmount}`);

          await _saveRecord({ pool, randomUUID, windowId, settlementId:clAcctId || null, dfspName: dfspId,
            type: 'credit', action: 'recordFundsIn', status: 'ok',
            amount: absAmount, beforeAmount, afterAmount,
            currency, positionValue, reason });

          results.funds_movements.push({
            participantName: dfspId, accountId: clAcctId,
            type: 'credit', action: 'recordFundsIn',
            positionValue, absAmount, beforeAmount, afterAmount,
            currency, status: 'ok',
            effect: `SETTLEMENT ${beforeAmount} → ${afterAmount} (+${absAmount})`,
          });

        } catch (err) {
          const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          console.error(`[FINALIZE] ❌ recordFundsIn failed: ${dfspId}: ${errMsg}`);
          await _saveRecord({ pool, randomUUID, windowId, settlementId:clAcctId || null, dfspName: dfspId,
            type: 'credit', action: 'recordFundsIn', status: 'failed',
            amount: absAmount, beforeAmount, afterAmount: null,
            currency, positionValue, error: errMsg, reason });
          results.funds_movements.push({
            participantName: dfspId, accountId: clAcctId,
            type: 'credit', action: 'recordFundsIn',
            positionValue, absAmount, beforeAmount,
            currency, status: 'failed', error: errMsg,
          });
        }

      // ════════════════════════════════════════════════════════
      //  NEGATIVE POSITION → recordFundsOut (debit, 2 steps)
      //  Step A: POST recordFundsOutPrepareReserve
      //  Step B: POST recordFundsOutCommit (same transferId)
      //          if fail → POST recordFundsOutAbort
      // ════════════════════════════════════════════════════════
      } else {
        const transferId = randomUUID();

        // ── Step A: recordFundsOutPrepareReserve ──────────────
        let stepAOk = false;
        try {
          await axios.post(clUrl, {
            transferId,
            externalReference: `window-${windowId}-${dfspId}-debit-prepare`,
            action:            'recordFundsOutPrepareReserve',
            reason:            `${reason} — window ${windowId}`,
            amount:            { amount: absAmount.toFixed(4), currency },
          }, { headers: clHeaders });

          // Fetch real value after Step A
          const afterStepA = await getSettlementValue(dfspId, currency);
          console.log(`[FINALIZE] ✅ Step A PrepareReserve: ${dfspId} | before=${beforeAmount} after=${afterStepA}`);
          stepAOk = true;

          await _saveRecord({ pool, randomUUID, windowId, settlementId:clAcctId || null, dfspName: dfspId,
            type: 'debit', action: 'recordFundsOutPrepareReserve', status: 'prepare',
            amount: absAmount, beforeAmount, afterAmount: afterStepA,
            currency, positionValue, reason });

        } catch (err) {
          const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          console.error(`[FINALIZE] ❌ Step A PrepareReserve failed: ${dfspId}: ${errMsg}`);
          await _saveRecord({ pool, randomUUID, windowId, settlementId:clAcctId || null, dfspName: dfspId,
            type: 'debit', action: 'recordFundsOutPrepareReserve', status: 'failed',
            amount: absAmount, beforeAmount, afterAmount: null,
            currency, positionValue, error: errMsg, reason });
          results.funds_movements.push({
            participantName: dfspId, accountId: clAcctId,
            type: 'debit', action: 'recordFundsOutPrepareReserve',
            positionValue, absAmount, beforeAmount,
            currency, status: 'failed',
            error: `Step A (PrepareReserve) failed: ${errMsg}`,
          });
          continue;
        }

        // ── Step B: recordFundsOutCommit ──────────────────────
        // FIX: POST to same URL — NOT PUT, NOT /transfers/:id
        // Same transferId as Step A, same URL, no amount needed
        if (stepAOk) {
          try {
            await axios.put(`${clUrl}/transfers/${transferId}`, {
              action:            'recordFundsOutCommit',
              reason:            `${reason} — window ${windowId}`,
            }, { headers: clHeaders });

            // Fetch real value after Step B
            const afterAmount = await getSettlementValue(dfspId, currency);
            console.log(`[FINALIZE] ✅ Step B Commit: ${dfspId} | before=${beforeAmount} after=${afterAmount}`);

            await _saveRecord({ pool, randomUUID, windowId, settlementId:clAcctId || null, dfspName: dfspId,
              type: 'debit', action: 'recordFundsOutCommit', status: 'commit',
              amount: absAmount, beforeAmount, afterAmount,
              currency, positionValue, reason });

            results.funds_movements.push({
              participantName: dfspId, accountId: clAcctId,
              type: 'debit', action: 'recordFundsOutCommit',
              positionValue, absAmount, beforeAmount, afterAmount,
              currency, status: 'ok',
              effect: `SETTLEMENT ${beforeAmount} → ${afterAmount} (-${absAmount})`,
            });

          } catch (err) {
            const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            console.error(`[FINALIZE] ❌ Step B Commit failed: ${dfspId}: ${errMsg}`);

            // Step B failed → abort Step A
            try {
              await axios.post(clUrl, {
                transferId,
                externalReference: `window-${windowId}-${dfspId}-debit-abort`,
                action:            'recordFundsOutAbort',
                reason:            `Commit failed, aborting — window ${windowId}`,
                amount:            { amount: absAmount.toFixed(4), currency },
              }, { headers: clHeaders });

              const afterAbort = await getSettlementValue(dfspId, currency);
              console.log(`[FINALIZE] ⚠️ Aborted: ${dfspId} | settlement restored to ${afterAbort}`);

              await _saveRecord({ pool, randomUUID, windowId, settlementId:clAcctId || null, dfspName: dfspId,
                type: 'debit', action: 'recordFundsOutAbort', status: 'abort',
                amount: absAmount, beforeAmount, afterAmount: afterAbort,
                currency, positionValue,
                error: `Commit failed: ${errMsg}`, reason });

            } catch (abortErr) {
              console.error(`[FINALIZE] ❌ Abort also failed for ${dfspId}: ${abortErr.message}`);
            }

            await _saveRecord({ pool, randomUUID, windowId,settlementId:clAcctId || null, dfspName: dfspId,
              type: 'debit', action: 'recordFundsOutCommit', status: 'failed',
              amount: absAmount, beforeAmount, afterAmount: null,
              currency, positionValue, error: errMsg, reason });

            results.funds_movements.push({
              participantName: dfspId, accountId: clAcctId,
              type: 'debit', action: 'recordFundsOut',
              positionValue, absAmount, beforeAmount,
              currency, status: 'failed',
              error: `Step B (Commit) failed: ${errMsg}`,
            });
          }
        }
      }
    }

    // ── Summary ───────────────────────────────────────────────
    const succeeded = results.funds_movements.filter(r => r.status === 'ok').length;
    const failed    = results.funds_movements.filter(r => r.status === 'failed').length;
    const skipped   = results.funds_movements.filter(r => r.status === 'skipped').length;

    console.log(`[FINALIZE] Done — ${succeeded} ok, ${failed} failed, ${skipped} skipped`);

    return res.json({
      success:   failed === 0,
      message:   failed === 0
        ? `Window ${windowId} finalized — ${succeeded} SETTLEMENT accounts updated`
        : `Partial finalization — ${succeeded} ok, ${failed} failed`,
      window_id: windowId,
      next_step: 'Now run completeSettlement to close window, reset positions and send emails',
      summary:   { total: results.funds_movements.length, succeeded, failed, skipped },
      results,
    });

  } catch (err) {
    console.error(`[FINALIZE] Error: ${err.message}`);
    return res.status(500).json({ error: err.message, results });
  }
};


// ================================================================
//  Helper: save record to settlement_finalize_records
// ================================================================
async function _saveRecord({
  pool, randomUUID,
  windowId, settlementId = null,
  dfspName, type, action, status,
  amount, beforeAmount = null, afterAmount = null,
  currency, positionValue = null,
  error = null, reason = null,
}) {
  try {
    await pool.execute(
      `INSERT INTO settlement_finalize_records
         (id, window_id, settlement_id, dfsp_name, type, action, status,
          amount, before_amount, after_amount, currency, position_value,
          error, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        randomUUID(),
        String(windowId),
        settlementId    || null,
        dfspName,
        type,
        action,
        status,
        amount,
        beforeAmount,
        afterAmount,
        currency,
        positionValue,
        error  || null,
        reason || null,
      ]
    );
  } catch (e) {
    console.warn(`[FINALIZE] DB save failed: ${e.message}`);
  }
}


exports.getFinalizeRecords = async (req, res) => {
  try {
    const {
      type,
      window_id,
      settlement_id,
      dfsp_name,
      date_from,
      date_to,
      status,
      page     = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params     = [];

    if (type)          { conditions.push('type = ?');           params.push(type); }
    if (window_id)     { conditions.push('window_id = ?');      params.push(String(window_id)); }
    if (settlement_id) { conditions.push('settlement_id = ?');  params.push(String(settlement_id)); }
    if (dfsp_name)     { conditions.push('dfsp_name LIKE ?');   params.push(`%${dfsp_name}%`); }
    if (status)        { conditions.push('status = ?');         params.push(status); }
    if (date_from)     { conditions.push('DATE(created_at) >= ?'); params.push(date_from); }
    if (date_to)       { conditions.push('DATE(created_at) <= ?'); params.push(date_to); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit  = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    // Total count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM settlement_finalize_records ${where}`,
      params
    );

    // Records
    const [rows] = await pool.execute(
      `SELECT
         id, window_id, settlement_id, dfsp_name,
         type, action, status,
         amount, before_amount, after_amount,
         currency, position_value,
         error, reason, created_at
       FROM settlement_finalize_records
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Summary totals
    const [[summary]] = await pool.execute(
      `SELECT
         SUM(CASE WHEN type = 'credit' AND status NOT IN ('failed') THEN amount ELSE 0 END) AS total_credit,
         SUM(CASE WHEN type = 'debit'  AND status IN ('commit','ok') THEN amount ELSE 0 END) AS total_debit,
         COUNT(*) AS total_records,
         COUNT(DISTINCT window_id) AS total_windows,
         COUNT(DISTINCT dfsp_name) AS total_dfsps
       FROM settlement_finalize_records
       ${where}`,
      params
    );

    return res.json({
      data: rows,
      summary: {
        total_credit:  parseFloat(summary.total_credit  || 0),
        total_debit:   parseFloat(summary.total_debit   || 0),
        total_records: parseInt(summary.total_records   || 0),
        total_windows: parseInt(summary.total_windows   || 0),
        total_dfsps:   parseInt(summary.total_dfsps     || 0),
      },
      pagination: {
        total,
        total_pages:  Math.ceil(total / limit),
        current_page: parseInt(page),
        per_page:     limit,
      },
    });
  } catch (err) {
    console.error('[SETTLEMENT] getFinalizeRecords error:', err.message);
    res.status(500).json({ error: err.message });
  }
};


// ── GET /settlement/completed-records ────────────────────────
// Page 02: Settlement Completed Records
// Filters: window_id, settlement_id, dfsp_name, date_from, date_to
exports.getCompletedRecords = async (req, res) => {
  try {
    const {
      window_id,
      settlement_id,
      dfsp_name,
      date_from,
      date_to,
      page     = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params     = [];

    if (window_id)     { conditions.push('window_id = ?');      params.push(String(window_id)); }
    if (settlement_id) { conditions.push('settlement_id = ?');  params.push(String(settlement_id)); }
    if (dfsp_name)     { conditions.push('dfsp_name LIKE ?');   params.push(`%${dfsp_name}%`); }
    if (date_from)     { conditions.push('DATE(created_at) >= ?'); params.push(date_from); }
    if (date_to)       { conditions.push('DATE(created_at) <= ?'); params.push(date_to); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit  = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    // Total count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM settlement_completed_records ${where}`,
      params
    );

    // Records
    const [rows] = await pool.execute(
      `SELECT
         id, window_id, settlement_id, dfsp_name,
         before_position, after_position,
         net_amount, currency, created_at
       FROM settlement_completed_records
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Summary
    const [[summary]] = await pool.execute(
      `SELECT
         COUNT(DISTINCT window_id)    AS total_windows,
         COUNT(DISTINCT dfsp_name)    AS total_dfsps,
         SUM(ABS(net_amount))         AS total_volume,
         COUNT(*)                     AS total_records
       FROM settlement_completed_records
       ${where}`,
      params
    );

    return res.json({
      data: rows,
      summary: {
        total_windows: parseInt(summary.total_windows || 0),
        total_dfsps:   parseInt(summary.total_dfsps   || 0),
        total_volume:  parseFloat(summary.total_volume || 0),
        total_records: parseInt(summary.total_records  || 0),
      },
      pagination: {
        total,
        total_pages:  Math.ceil(total / limit),
        current_page: parseInt(page),
        per_page:     limit,
      },
    });
  } catch (err) {
    console.error('[SETTLEMENT] getCompletedRecords error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getDepositsRecords = async (req, res) => {
  try {
    const {
      dfsp_name,
      date_from,
      date_to,
      page     = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params     = [];

    if (dfsp_name)     { conditions.push('dfsp_id LIKE ?');   params.push(`%${dfsp_name}%`); }
    if (date_from)     { conditions.push('DATE(created_at) >= ?'); params.push(date_from); }
    if (date_to)       { conditions.push('DATE(created_at) <= ?'); params.push(date_to); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit  = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    // Total count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM dfsp_deposits ${where}`,
      params
    );

    // Records
    const [rows] = await pool.execute(
      `SELECT *
       FROM dfsp_deposits
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Summary
    const [[summary]] = await pool.execute(
      `SELECT
         COUNT(DISTINCT id)    AS total_windows,
         COUNT(DISTINCT dfsp_id)    AS total_dfsps,
         SUM(ABS(amount))         AS total_volume,
         COUNT(*)                     AS total_records
       FROM dfsp_deposits
       ${where}`,
      params
    );

    return res.json({
      data: rows,
      summary: {
        total_windows: parseInt(summary.total_windows || 0),
        total_dfsps:   parseInt(summary.total_dfsps   || 0),
        total_volume:  parseFloat(summary.total_volume || 0),
        total_records: parseInt(summary.total_records  || 0),
      },
      pagination: {
        total,
        total_pages:  Math.ceil(total / limit),
        current_page: parseInt(page),
        per_page:     limit,
      },
    });
  } catch (err) {
    console.error('[SETTLEMENT] getCompletedRecords error:', err.message);
    res.status(500).json({ error: err.message });
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
