/**************************************************************************
 * Copyright © 2026 Bangladeshi Software Ltd. All rights reserved.
 * Distributed under the license terms specified in this repository.
 *
 * ORIGINAL AUTHOR: Muhammad Nasim (Developer)
 **************************************************************************/

const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { sendSettlementEmailsToAll } = require('../services/email.service');

const SETTLEMENT_URL =
  process.env.SETTLEMENT_URL || 'https://your-settlement.domain.com/version';
const CENTRAL_LEDGER =
  process.env.CENTRAL_LEDGER_URL || 'https://your-ledger.domain.com';

// Helper function.
async function getOpenWindowsFromService() {
  const res = await axios.get(
    `${SETTLEMENT_URL}/settlementWindows?state=OPEN`,
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return res.data || [];
}

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
    // skip.
  }
}

exports.getWindows = async (req, res) => {
  try {
    let serviceWindows = [];
    try {
      serviceWindows = await getWindowsFromService('OPEN');

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
        serviceWindowId = String(
          openWindows[0].settlementWindowId || openWindows[0].id,
        );
        serviceData = openWindows[0];
      } else {
        serviceWindowId = uuidv4();
      }
    } catch (e) {
      serviceWindowId = uuidv4();
    }

    // save
    await pool.execute(
      `
      INSERT INTO settlement_windows (id, window_id, status, opened_at)
      VALUES (?, ?, 'OPEN', NOW())
      ON DUPLICATE KEY UPDATE status = 'OPEN', updated_at = NOW()`,
      [uuidv4(), serviceWindowId],
    );

    res.status(201).json({
      message: 'Settlement window opened',
      window_id: serviceWindowId,
      service_data: serviceData,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

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
    let windowId = window_id;

    if (!windowId) {
      const openWindows = await getOpenWindowsFromService();
      if (!openWindows || openWindows.length === 0) {
        return res
          .status(400)
          .json({ error: 'No open settlement windows found' });
      }
      windowId = openWindows[0].settlementWindowId || openWindows[0].id;
    }

    const closingWindowId = Number(windowId);

    const closeRes = await axios.post(
      `${SETTLEMENT_URL}/settlementWindows/${closingWindowId}`,
      { state: 'CLOSED', reason },
      { headers: { 'Content-Type': 'application/json' } },
    );

    results.step1_windowClosed = {
      closedWindowId: closingWindowId,
      newWindowId: closeRes.data?.settlementWindowId,
      newWindowState: closeRes.data?.state,
    };

    // update db.
    await pool.execute(
      `UPDATE settlement_windows
       SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
       WHERE window_id = ?`,
      [String(closingWindowId)],
    );

    // Wait for Mojaloop to finalize window state
    await new Promise((r) => setTimeout(r, 1000));

    // step 02: create settlement window

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
      const errCode = step2Err.response?.data?.errorInformation?.errorCode;
      const errDesc =
        step2Err.response?.data?.errorInformation?.errorDescription;

      if (errCode === '3100' && errDesc?.includes('Inapplicable')) {
        return res.status(400).json({
          error: 'Settlement window has no transfers to settle',
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
        error: 'Settlement created but has no participants',
        details: 'No DFSP positions to settle',
        results,
      });
    }

    // Helper body
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

    //  Step 03: PS_TRANSFERS_RECORDED
    await new Promise((r) => setTimeout(r, 500));
    const step3Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RECORDED', 'Recording settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step3_recorded = step3Res.data;

    // Step 04: PS_TRANSFERS_RESERVED
    await new Promise((r) => setTimeout(r, 500));
    const step4Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_RESERVED', 'Reserving settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step4_reserved = step4Res.data;

    // Step 05: PS_TRANSFERS_COMMITTED
    await new Promise((r) => setTimeout(r, 500));
    const step5Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('PS_TRANSFERS_COMMITTED', 'Committing settlement transfers'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step5_committed = step5Res.data;

    // STEP 06: SETTLED
    await new Promise((r) => setTimeout(r, 500));
    const step6Res = await axios.put(
      `${SETTLEMENT_URL}/settlements/${settlementId}`,
      makeBody('SETTLED', 'Settlement completed by Central Bank'),
      { headers: { 'Content-Type': 'application/json' } },
    );
    results.step6_settled = step6Res.data;

    const participantNameMap = {};

    try {
      const clParticipants = await axios.get(`${CENTRAL_LEDGER}/participants`, {
        headers: { 'fspiop-source': 'switch' },
      });

      for (const p of clParticipants.data || []) {
        if (['Hub', 'hub', 'HUB'].includes(p.name)) continue;
        try {
          const accRes = await axios.get(
            `${CENTRAL_LEDGER}/participants/${p.name}/accounts`,
            { headers: { 'fspiop-source': 'switch' } },
          );
          for (const acc of accRes.data || []) {
            participantNameMap[acc.id] = p.name;
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn(
        '[SETTLEMENT] Could not build participantNameMap:',
        e.message,
      );
    }

    // ── Step 07: Save to settlement_completed_records
    for (const participant of participants) {
      const account = participant.accounts?.[0];
      const netAmount = parseFloat(account?.netSettlementAmount?.amount || 0);
      const currency = account?.netSettlementAmount?.currency || 'BDT';

      const dfspName =
        participantNameMap[account?.id] || `participant_${participant.id}`;

      // before_position = fetch from CL positions
      let beforePosition = netAmount; // fallback
      try {
        const posRes = await axios.get(
          `${CENTRAL_LEDGER}/participants/${dfspName}/positions`,
          { headers: { 'fspiop-source': 'switch' } },
        );
        const posData = posRes.data;
        beforePosition = parseFloat(
          (Array.isArray(posData) ? posData[0]?.value : posData?.value) || 0,
        );
      } catch (_) {}

      await pool
        .execute(
          `INSERT INTO settlement_completed_records
       (id, window_id, settlement_id, dfsp_name,
        before_position, after_position, net_amount, currency, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
          [
            require('uuid').v4(),
            String(closingWindowId),
            String(settlementId),
            dfspName,
            beforePosition,
            netAmount,
            currency,
          ],
        )
        .catch((e) =>
          console.warn('SETTLEMENT completed_records save failed:', e.message),
        );
    }

    // Cleanup DB.
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
        [String(settlementId), String(settlementId)],
      );

      // Reset local dfsp positions to 0 - matches Mojaloop after SETTLED
      await conn.execute(
        `UPDATE dfsp_positions
         SET current_position = 0, reserved_amount = 0, updated_at = NOW()`,
      );

      // Mark settlement window as SETTLED
      await conn.execute(
        `UPDATE settlement_windows
         SET status = 'SETTLED', settled_at = NOW(), updated_at = NOW()
         WHERE window_id = ?`,
        [String(closingWindowId)],
      );

      await conn.commit();
    } catch (dbErr) {
      await conn.rollback();
      console.error(`[SETTLEMENT] DB cleanup failed: ${dbErr.message}`);
    } finally {
      conn.release();
    }

    //  Send settlement emails
    /*
    await sendSettlementEmailsToAll({
      pool,
      settlementId,
      windowId:    closingWindowId,
      participants,
    }).catch(e => {
      console.error(`SETTLEMENT Email failed: ${e.message}`);
    }); */

    return res.json({
      success: true,
      message: 'Settlement completed successfully through all 6 steps',
      settlement_id: settlementId,
      window_id: closingWindowId,
      results,
      participants: participants,
    });
  } catch (err) {
    const failedStep =
      Object.entries(results).find(([, v]) => v === null)?.[0] || 'unknown';
    return res.status(err.response?.status || 500).json({
      error: `Failed at ${failedStep}`,
      details: err.response?.data || err.message,
      results,
    });
  }
};

exports.finalizeByWindow = async (req, res) => {
  const { windowId } = req.params;
  const {
    reason = 'Post-settlement physical transfer confirmed by Central Bank',
  } = req.body;

  if (!windowId) return res.status(400).json({ error: 'windowId required' });

  const { randomUUID } = require('crypto');

  const results = {
    window_id: windowId,
    funds_movements: [],
  };

  //  Helper function: fetch real SETTLEMENT account value from CL
  const getSettlementValue = async (dfspId, currency) => {
    try {
      const accRes = await axios.get(
        `${CENTRAL_LEDGER}/participants/${dfspId}/accounts`,
        { headers: { 'fspiop-source': 'switch' } },
      );
      const settAcc = (accRes.data || []).find(
        (a) => a.ledgerAccountType === 'SETTLEMENT' && a.currency === currency,
      );
      return settAcc ? parseFloat(settAcc.value) : null;
    } catch (e) {
      return null;
    }
  };

  try {
    const clRes = await axios.get(`${CENTRAL_LEDGER}/participants`, {
      headers: { 'fspiop-source': 'switch' },
    });
    const allParticipants = (clRes.data || []).filter(
      (p) => p.isActive === 1 && !['Hub', 'hub', 'HUB'].includes(p.name),
    );

    if (allParticipants.length === 0)
      return res.status(400).json({ error: 'No active participants found' });

    for (const participant of allParticipants) {
      const dfspId = participant.name;

      const [posRes, accRes] = await Promise.allSettled([
        axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/positions`, {
          headers: { 'fspiop-source': 'switch' },
        }),
        axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/accounts`, {
          headers: { 'fspiop-source': 'switch' },
        }),
      ]);

      // Get position value
      let positionValue = 0;
      let currency = 'BDT';

      if (posRes.status === 'fulfilled') {
        const posData = posRes.value.data;
        const posEntry = Array.isArray(posData) ? posData[0] : posData;
        positionValue = parseFloat(posEntry?.value || 0);
        currency = posEntry?.currency || 'BDT';
      } else {
        const errMsg = `Could not fetch position: ${posRes.reason?.message}`;
        results.funds_movements.push({
          participantName: dfspId,
          status: 'failed',
          reason: errMsg,
        });
        await _saveRecord({
          pool,
          randomUUID,
          windowId,
          dfspName: dfspId,
          type: 'credit',
          action: 'recordFundsIn',
          status: 'failed',
          amount: 0,
          beforeAmount: null,
          afterAmount: null,
          currency,
          positionValue: 0,
          error: errMsg,
          reason,
        });
        continue;
      }

      // Get accounts
      let accounts = [];
      if (accRes.status === 'fulfilled') {
        accounts = accRes.value.data || [];
      } else {
        results.funds_movements.push({
          participantName: dfspId,
          status: 'failed',
          reason: `Could not fetch accounts: ${accRes.reason?.message}`,
        });
        continue;
      }

      // Find SETTLEMENT account
      const settlementAcct = accounts.find(
        (a) => a.ledgerAccountType === 'SETTLEMENT' && a.currency === currency,
      );

      if (!settlementAcct) {
        const errMsg = `No SETTLEMENT account for ${dfspId} ${currency}`;
        results.funds_movements.push({
          participantName: dfspId,
          status: 'failed',
          reason: errMsg,
        });
        await _saveRecord({
          pool,
          randomUUID,
          windowId,
          dfspName: dfspId,
          type: 'credit',
          action: 'recordFundsIn',
          status: 'failed',
          amount: 0,
          beforeAmount: null,
          afterAmount: null,
          currency,
          positionValue,
          error: errMsg,
          reason,
        });
        continue;
      }

      const absAmount = Math.abs(positionValue);
      const clAcctId = settlementAcct.id;
      const clUrl = `${CENTRAL_LEDGER}/participants/${dfspId}/accounts/${clAcctId}`;
      const clHeaders = {
        'Content-Type':
          'application/vnd.interoperability.participants+json;version=1.1',
        'fspiop-source': 'switch',
        Date: new Date().toUTCString(),
      };

      // FIX: fetch real beforeAmount from CL (not from accounts list)
      // accounts list value may be stale fetch fresh value
      const beforeAmount = await getSettlementValue(dfspId, currency);

      // Skip zero position
      if (positionValue === 0) {
        results.funds_movements.push({
          participantName: dfspId,
          positionValue: 0,
          settlementValue: beforeAmount,
          currency,
          status: 'skipped',
          reason: 'position is 0 — no net obligation',
        });
        continue;
      }

      //  POSITIVE POSITION => recordFundsIn (credit, 1 step)
      if (positionValue > 0) {
        const transferId = randomUUID();
        try {
          await axios.post(
            clUrl,
            {
              transferId,
              externalReference: `window-${windowId}-${dfspId}-credit`,
              action: 'recordFundsIn',
              reason: `${reason} — window ${windowId}`,
              amount: { amount: absAmount.toFixed(4), currency },
            },
            { headers: clHeaders },
          );

          // FIX: fetch real afterAmount from CL after API call
          const afterAmount = await getSettlementValue(dfspId, currency);

          await _saveRecord({
            pool,
            randomUUID,
            windowId,
            settlementId: clAcctId || null,
            dfspName: dfspId,
            type: 'credit',
            action: 'recordFundsIn',
            status: 'ok',
            amount: absAmount,
            beforeAmount,
            afterAmount,
            currency,
            positionValue,
            reason,
          });

          results.funds_movements.push({
            participantName: dfspId,
            accountId: clAcctId,
            type: 'credit',
            action: 'recordFundsIn',
            positionValue,
            absAmount,
            beforeAmount,
            afterAmount,
            currency,
            status: 'ok',
            effect: `SETTLEMENT ${beforeAmount} → ${afterAmount} (+${absAmount})`,
          });
        } catch (err) {
          const errMsg = err.response?.data
            ? JSON.stringify(err.response.data)
            : err.message;

          await _saveRecord({
            pool,
            randomUUID,
            windowId,
            settlementId: clAcctId || null,
            dfspName: dfspId,
            type: 'credit',
            action: 'recordFundsIn',
            status: 'failed',
            amount: absAmount,
            beforeAmount,
            afterAmount: null,
            currency,
            positionValue,
            error: errMsg,
            reason,
          });
          results.funds_movements.push({
            participantName: dfspId,
            accountId: clAcctId,
            type: 'credit',
            action: 'recordFundsIn',
            positionValue,
            absAmount,
            beforeAmount,
            currency,
            status: 'failed',
            error: errMsg,
          });
        }
      } else {
        const transferId = randomUUID();

        // ── Step A: recordFundsOutPrepareReserve
        let stepAOk = false;
        try {
          await axios.post(
            clUrl,
            {
              transferId,
              externalReference: `window-${windowId}-${dfspId}-debit-prepare`,
              action: 'recordFundsOutPrepareReserve',
              reason: `${reason} — window ${windowId}`,
              amount: { amount: absAmount.toFixed(4), currency },
            },
            { headers: clHeaders },
          );

          // Fetch real value after Step A
          const afterStepA = await getSettlementValue(dfspId, currency);

          stepAOk = true;

          await _saveRecord({
            pool,
            randomUUID,
            windowId,
            settlementId: clAcctId || null,
            dfspName: dfspId,
            type: 'debit',
            action: 'recordFundsOutPrepareReserve',
            status: 'prepare',
            amount: absAmount,
            beforeAmount,
            afterAmount: afterStepA,
            currency,
            positionValue,
            reason,
          });
        } catch (err) {
          const errMsg = err.response?.data
            ? JSON.stringify(err.response.data)
            : err.message;

          await _saveRecord({
            pool,
            randomUUID,
            windowId,
            settlementId: clAcctId || null,
            dfspName: dfspId,
            type: 'debit',
            action: 'recordFundsOutPrepareReserve',
            status: 'failed',
            amount: absAmount,
            beforeAmount,
            afterAmount: null,
            currency,
            positionValue,
            error: errMsg,
            reason,
          });
          results.funds_movements.push({
            participantName: dfspId,
            accountId: clAcctId,
            type: 'debit',
            action: 'recordFundsOutPrepareReserve',
            positionValue,
            absAmount,
            beforeAmount,
            currency,
            status: 'failed',
            error: `Step A (PrepareReserve) failed: ${errMsg}`,
          });
          continue;
        }

        // Step B: recordFundsOutCommit
        // FIX: POST to same URL - NOT PUT, NOT /transfers/:id
        // Same transferId as Step A, same URL, no amount needed

        if (stepAOk) {
          try {
            await axios.put(
              `${clUrl}/transfers/${transferId}`,
              {
                action: 'recordFundsOutCommit',
                reason: `${reason} — window ${windowId}`,
              },
              { headers: clHeaders },
            );

            // Fetch real value after Step B
            const afterAmount = await getSettlementValue(dfspId, currency);

            await _saveRecord({
              pool,
              randomUUID,
              windowId,
              settlementId: clAcctId || null,
              dfspName: dfspId,
              type: 'debit',
              action: 'recordFundsOutCommit',
              status: 'commit',
              amount: absAmount,
              beforeAmount,
              afterAmount,
              currency,
              positionValue,
              reason,
            });

            results.funds_movements.push({
              participantName: dfspId,
              accountId: clAcctId,
              type: 'debit',
              action: 'recordFundsOutCommit',
              positionValue,
              absAmount,
              beforeAmount,
              afterAmount,
              currency,
              status: 'ok',
              effect: `SETTLEMENT ${beforeAmount} → ${afterAmount} (-${absAmount})`,
            });
          } catch (err) {
            const errMsg = err.response?.data
              ? JSON.stringify(err.response.data)
              : err.message;

            // Step B failed => abort Step A
            try {
              await axios.post(
                clUrl,
                {
                  transferId,
                  externalReference: `window-${windowId}-${dfspId}-debit-abort`,
                  action: 'recordFundsOutAbort',
                  reason: `Commit failed, aborting — window ${windowId}`,
                  amount: { amount: absAmount.toFixed(4), currency },
                },
                { headers: clHeaders },
              );

              const afterAbort = await getSettlementValue(dfspId, currency);

              await _saveRecord({
                pool,
                randomUUID,
                windowId,
                settlementId: clAcctId || null,
                dfspName: dfspId,
                type: 'debit',
                action: 'recordFundsOutAbort',
                status: 'abort',
                amount: absAmount,
                beforeAmount,
                afterAmount: afterAbort,
                currency,
                positionValue,
                error: `Commit failed: ${errMsg}`,
                reason,
              });
            } catch (abortErr) {
              // skip
            }

            await _saveRecord({
              pool,
              randomUUID,
              windowId,
              settlementId: clAcctId || null,
              dfspName: dfspId,
              type: 'debit',
              action: 'recordFundsOutCommit',
              status: 'failed',
              amount: absAmount,
              beforeAmount,
              afterAmount: null,
              currency,
              positionValue,
              error: errMsg,
              reason,
            });

            results.funds_movements.push({
              participantName: dfspId,
              accountId: clAcctId,
              type: 'debit',
              action: 'recordFundsOut',
              positionValue,
              absAmount,
              beforeAmount,
              currency,
              status: 'failed',
              error: `Step B (Commit) failed: ${errMsg}`,
            });
          }
        }
      }
    }

    // Summary
    const succeeded = results.funds_movements.filter(
      (r) => r.status === 'ok',
    ).length;
    const failed = results.funds_movements.filter(
      (r) => r.status === 'failed',
    ).length;
    const skipped = results.funds_movements.filter(
      (r) => r.status === 'skipped',
    ).length;

    return res.json({
      success: failed === 0,
      message:
        failed === 0
          ? `Window ${windowId} finalized — ${succeeded} SETTLEMENT accounts updated`
          : `Partial finalization — ${succeeded} ok, ${failed} failed`,
      window_id: windowId,
      next_step:
        'Now run completeSettlement to close window, reset positions and send emails',
      summary: {
        total: results.funds_movements.length,
        succeeded,
        failed,
        skipped,
      },
      results,
    });
  } catch (err) {
    console.error(`[FINALIZE] Error: ${err.message}`);
    return res.status(500).json({ error: err.message, results });
  }
};

// Helper function.
async function _saveRecord({
  pool,
  randomUUID,
  windowId,
  settlementId = null,
  dfspName,
  type,
  action,
  status,
  amount,
  beforeAmount = null,
  afterAmount = null,
  currency,
  positionValue = null,
  error = null,
  reason = null,
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
        settlementId || null,
        dfspName,
        type,
        action,
        status,
        amount,
        beforeAmount,
        afterAmount,
        currency,
        positionValue,
        error || null,
        reason || null,
      ],
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
      page = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params = [];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (window_id) {
      conditions.push('window_id = ?');
      params.push(String(window_id));
    }
    if (settlement_id) {
      conditions.push('settlement_id = ?');
      params.push(String(settlement_id));
    }
    if (dfsp_name) {
      conditions.push('dfsp_name LIKE ?');
      params.push(`%${dfsp_name}%`);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (date_from) {
      conditions.push('DATE(created_at) >= ?');
      params.push(date_from);
    }
    if (date_to) {
      conditions.push('DATE(created_at) <= ?');
      params.push(date_to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    // count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM settlement_finalize_records ${where}`,
      params,
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
      [...params, limit, offset],
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
      params,
    );

    return res.json({
      data: rows,
      summary: {
        total_credit: parseFloat(summary.total_credit || 0),
        total_debit: parseFloat(summary.total_debit || 0),
        total_records: parseInt(summary.total_records || 0),
        total_windows: parseInt(summary.total_windows || 0),
        total_dfsps: parseInt(summary.total_dfsps || 0),
      },
      pagination: {
        total,
        total_pages: Math.ceil(total / limit),
        current_page: parseInt(page),
        per_page: limit,
      },
    });
  } catch (err) {
    console.error('[SETTLEMENT] getFinalizeRecords error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getCompletedRecords = async (req, res) => {
  try {
    const {
      window_id,
      settlement_id,
      dfsp_name,
      date_from,
      date_to,
      page = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params = [];

    if (window_id) {
      conditions.push('window_id = ?');
      params.push(String(window_id));
    }
    if (settlement_id) {
      conditions.push('settlement_id = ?');
      params.push(String(settlement_id));
    }
    if (dfsp_name) {
      conditions.push('dfsp_name LIKE ?');
      params.push(`%${dfsp_name}%`);
    }
    if (date_from) {
      conditions.push('DATE(created_at) >= ?');
      params.push(date_from);
    }
    if (date_to) {
      conditions.push('DATE(created_at) <= ?');
      params.push(date_to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    // count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM settlement_completed_records ${where}`,
      params,
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
      [...params, limit, offset],
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
      params,
    );

    return res.json({
      data: rows,
      summary: {
        total_windows: parseInt(summary.total_windows || 0),
        total_dfsps: parseInt(summary.total_dfsps || 0),
        total_volume: parseFloat(summary.total_volume || 0),
        total_records: parseInt(summary.total_records || 0),
      },
      pagination: {
        total,
        total_pages: Math.ceil(total / limit),
        current_page: parseInt(page),
        per_page: limit,
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
      page = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params = [];

    if (dfsp_name) {
      conditions.push('dfsp_id LIKE ?');
      params.push(`%${dfsp_name}%`);
    }
    if (date_from) {
      conditions.push('DATE(created_at) >= ?');
      params.push(date_from);
    }
    if (date_to) {
      conditions.push('DATE(created_at) <= ?');
      params.push(date_to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    // count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM dfsp_deposits ${where}`,
      params,
    );

    // Records
    const [rows] = await pool.execute(
      `SELECT *
       FROM dfsp_deposits
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
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
      params,
    );

    return res.json({
      data: rows,
      summary: {
        total_windows: parseInt(summary.total_windows || 0),
        total_dfsps: parseInt(summary.total_dfsps || 0),
        total_volume: parseFloat(summary.total_volume || 0),
        total_records: parseInt(summary.total_records || 0),
      },
      pagination: {
        total,
        total_pages: Math.ceil(total / limit),
        current_page: parseInt(page),
        per_page: limit,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.closeWindow = async (req, res) => {
  try {
    const { windowId } = req.params;
    const { reason = 'Manual close' } = req.body;

    // close settlement window
    try {
      await axios.post(
        `${SETTLEMENT_URL}/settlementWindows/${windowId}`,
        { state: 'CLOSED', reason },
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (e) {
      // skip
    }

    // update physical db.
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
