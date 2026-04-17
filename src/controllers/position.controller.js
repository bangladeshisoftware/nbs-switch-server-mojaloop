const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const CENTRAL_LEDGER =
  process.env.CENTRAL_LEDGER_URL || 'http://ledger.mojaloop.xyz';

// ════════════════════════════════════════════════════════════
//  GET /positions — সব DFSP এর current position
// ════════════════════════════════════════════════════════════
exports.getPositions = async (req, res) => {
  try {
    const { dfsp_id, currency } = req.query;
    const conditions = [];
    const values = [];

    if (dfsp_id) {
      conditions.push(`p.dfsp_id = ?`);
      values.push(dfsp_id);
    }
    if (currency) {
      conditions.push(`p.currency = ?`);
      values.push(currency);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.execute(
      `
      SELECT
        p.*,
        d.name AS dfsp_name,
        (p.net_debit_cap - p.current_position - p.reserved_amount) AS available
      FROM dfsp_positions p
      LEFT JOIN dfsps d ON d.dfsp_id = p.dfsp_id
      ${where}
      ORDER BY p.dfsp_id, p.currency`,
      values,
    );

    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ════════════════════════════════════════════════════════════
//  GET /positions/changes — Position change history
// ════════════════════════════════════════════════════════════
exports.getPositionChanges = async (req, res) => {
  try {
    const { dfsp_id, transfer_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const values = [];

    if (dfsp_id) {
      conditions.push(`dfsp_id = ?`);
      values.push(dfsp_id);
    }
    if (transfer_id) {
      conditions.push(`transfer_id = ?`);
      values.push(transfer_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.execute(
      `
      SELECT * FROM position_changes ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...values, parseInt(limit), offset],
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM position_changes ${where}`,
      values,
    );

    res.json({ total, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ════════════════════════════════════════════════════════════
//  GET /positions/limits — DFSP limit history
// ════════════════════════════════════════════════════════════
exports.getLimits = async (req, res) => {
  try {
    const { dfsp_id } = req.query;
    const where = dfsp_id ? `WHERE dfsp_id = ?` : '';
    const values = dfsp_id ? [dfsp_id] : [];

    const [rows] = await pool.execute(
      `SELECT * FROM dfsp_limits ${where} ORDER BY created_at DESC`,
      values,
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ════════════════════════════════════════════════════════════
//  POST /positions/limits — Set DFSP Net Debit Cap
//  ১. Central Ledger → POST /participants/:dfsp/initialPositionAndLimits
//  ২. R Switch DB → dfsp_limits + dfsp_positions update
// ════════════════════════════════════════════════════════════
exports.setLimit = async (req, res) => {
  const {
    dfsp_id,
    limit_type = 'NET_DEBIT_CAP',
    currency,
    value,
    changed_by,
  } = req.body;

  if (!dfsp_id || !currency || !value) {
    return res.status(400).json({ error: 'dfsp_id, currency, value required' });
  }

  const steps = { cl_limit: null, db_limit: null, db_position: null };

  try {
    // ── Step 1: Central Ledger → initialPositionAndLimits ──
    try {
      const clBody = {
        currency,
        limit: {
          type: limit_type, // 'NET_DEBIT_CAP'
          value: parseFloat(value),
        },
        initialPosition: '0',
      };

      const response = await axios.post(
        `${CENTRAL_LEDGER}/participants/${dfsp_id}/initialPositionAndLimits`,
        clBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'FSPIOP-Source': dfsp_id,
          },
        },
      );
      steps.cl_limit = { status: response.status, data: response.data };
      console.log(
        `✅ [LIMIT] CL initialPositionAndLimits set: ${dfsp_id} | ${value} ${currency}`,
      );
    } catch (e) {
      // 400 = limit already set, then use PUT /limits instead
      if (e.response?.status === 400) {
        try {
          const putResponse = await axios.put(
            `${CENTRAL_LEDGER}/participants/${dfsp_id}/limits`,
            { currency, limit: { type: limit_type, value: parseFloat(value) } },
            {
              headers: {
                'Content-Type': 'application/json',
                'FSPIOP-Source': dfsp_id,
              },
            },
          );
          steps.cl_limit = { status: putResponse.status, updated: true };
          console.log(`✅ [LIMIT] CL limit updated: ${dfsp_id}`);
        } catch (putErr) {
          steps.cl_limit = { error: putErr.response?.data || putErr.message };
          console.error(`❌ [LIMIT] CL limit update failed: ${putErr.message}`);
        }
      } else {
        steps.cl_limit = { error: e.response?.data || e.message };
        console.error(
          `❌ [LIMIT] CL initialPositionAndLimits failed: ${e.message}`,
        );
      }
    }

    // ── Step 2: R Switch DB → dfsp_limits log ──────────────
    const [[current]] = await pool.execute(
      `
      SELECT value FROM dfsp_limits
      WHERE dfsp_id = ? AND limit_type = ? AND currency = ?
      ORDER BY created_at DESC LIMIT 1`,
      [dfsp_id, limit_type, currency],
    );

    await pool.execute(
      `
      INSERT INTO dfsp_limits (id, dfsp_id, limit_type, currency, value, previous_value, changed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        dfsp_id,
        limit_type,
        currency,
        value,
        current?.value || 0,
        changed_by || 'admin',
      ],
    );
    steps.db_limit = 'ok';

    // ── Step 3: R Switch DB → dfsp_positions update ────────
    await pool.execute(
      `
      INSERT INTO dfsp_positions (id, dfsp_id, currency, net_debit_cap)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE net_debit_cap = ?, updated_at = NOW()`,
      [uuidv4(), dfsp_id, currency, value, value],
    );
    steps.db_position = 'ok';

    res.json({
      message: 'Limit set successfully',
      dfsp_id,
      currency,
      value,
      steps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
};

exports.updateLimit = async (req, res) => {
  const {
    dfsp_id,
    limit_type = 'NET_DEBIT_CAP',
    currency,
    value,
    alarmPercentage = 80,
    changed_by = 'ADMIN',
  } = req.body;

  // ── Validation ──────────────────────────────────────────
  if (!dfsp_id || !currency || value === undefined) {
    return res.status(400).json({
      error: 'dfsp_id, currency, and value are required',
    });
  }

  const numericValue = Number(value);
  if (isNaN(numericValue) || numericValue < 0) {
    return res.status(400).json({
      error: 'value must be a valid non-negative number',
    });
  }

  const steps = {
    cl_limit: null,
    db_limit: null,
    db_position: null,
  };

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // ── Step 1: Central Ledger (PUT /limits) ───────────────
    try {
      const response = await axios.put(
        `${CENTRAL_LEDGER}/participants/${dfsp_id}/limits`,
        {
          currency,
          limit: {
            type: limit_type,
            value: numericValue,
            alarmPercentage,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'FSPIOP-Source': dfsp_id,
          },
        },
      );

      steps.cl_limit = { status: response.status, success: true };

      console.log(
        `[LIMIT] CL updated → ${dfsp_id} | ${numericValue} ${currency}`,
      );
    } catch (err) {
      steps.cl_limit = {
        success: false,
        error: err.response?.data || err.message,
      };

      throw new Error('Central Ledger update failed');
    }

    // ── Step 2: Update dfsp_limits (ONLY UPDATE) ───────────
    const [limitResult] = await connection.execute(
      `
      UPDATE dfsp_limits
      SET 
        value = ?,
        created_by = ?
      WHERE dfsp_id = ? AND limit_type = ? AND currency = ?
      `,
      [
        numericValue,
        changed_by,
        dfsp_id,
        limit_type,
        currency,
      ],
    );

    steps.db_limit = 'ok';


    const [rows] = await connection.execute(
      `
      SELECT current_position, reserved_amount
      FROM dfsp_positions
      WHERE dfsp_id = ? AND currency = ?
      `,
      [dfsp_id, currency],
    );

    const { current_position, reserved_amount } = rows[0];

    const available =
      numericValue - Number(current_position) - Number(reserved_amount);

    await connection.execute(
      `
      UPDATE dfsp_positions
      SET 
        net_debit_cap = ?,
        available = ?,
        updated_at = NOW()
      WHERE dfsp_id = ? AND currency = ?
      `,
      [numericValue, available, dfsp_id, currency],
    );

    steps.db_position = 'ok';

    // ── Commit ─────────────────────────────────────────────
    await connection.commit();

    return res.json({
      message: 'Limit updated successfully',
      data: {
        dfsp_id,
        currency,
        value: numericValue,
        available,
      },
      steps,
    });
  } catch (error) {
    await connection.rollback();

    console.error('[LIMIT] Failed:', error.message);

    return res.status(500).json({
      error: error.message,
      steps,
    });
  } finally {
    connection.release();
  }
};

// ════════════════════════════════════════════════════════════
//  POST /positions/deposit — DFSP Fund Deposit
//  Central Ledger → POST /participants/:dfsp/accounts/:accountId
//  তারপর R Switch DB → position_changes log
// ════════════════════════════════════════════════════════════
/*
exports.depositFunds = async (req, res) => {
  const { dfsp_id, account_id, currency, amount, reason } = req.body;

  if (!dfsp_id || !account_id || !currency || !amount) {
    return res
      .status(400)
      .json({ error: 'dfsp_id, account_id, currency, amount required' });
  }

  const steps = { cl_deposit: null, db_log: null };

  try {
    // ── Step 1: Central Ledger → DFSP account এ deposit ───
    try {
      const response = await axios.post(
        `${CENTRAL_LEDGER}/participants/${dfsp_id}/accounts/${account_id}`,
        {
          transferId: uuidv4(),
          externalReference: reason || `deposit-${Date.now()}`,
          action: 'recordFundsIn',
          reason: reason || 'Manual deposit from R Switch',
          amount: {
            amount: String(amount),
            currency: currency,
          },
        },
        {
          headers: {
            'Content-Type':
              'application/vnd.interoperability.participants+json;version=1.1',
            'FSPIOP-Source': dfsp_id,
            Date: new Date().toUTCString(),
          },
        },
      );
      steps.cl_deposit = { status: response.status, data: response.data };
      console.log(
        `✅ [DEPOSIT] CL funds deposited: ${dfsp_id} | ${amount} ${currency}`,
      );
    } catch (e) {
      steps.cl_deposit = { error: e.response?.data || e.message };
      console.error(`❌ [DEPOSIT] CL deposit failed: ${e.message}`);
      // CL fail হলেও DB log করো
    }

    // ── Step 2: R Switch DB → position_changes log ─────────
    const [posRows] = await pool.execute(
      `
      SELECT current_position FROM dfsp_positions
      WHERE dfsp_id = ? AND currency = ?`,
      [dfsp_id, currency],
    );
    const posBefore = parseFloat(posRows[0]?.current_position || 0);
    const posAfter = posBefore + parseFloat(amount);

    await pool.execute(
      `
      INSERT INTO position_changes
        (id, transfer_id, dfsp_id, currency, change_type, amount, position_before, position_after)
      VALUES (?, NULL, ?, ?, 'DEPOSIT', ?, ?, ?)`,
      [uuidv4(), dfsp_id, currency, amount, posBefore, posAfter],
    );

    // dfsp_positions current_position update করো
    await pool.execute(
      `
      INSERT INTO dfsp_positions (id, dfsp_id, currency, current_position)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        current_position = current_position + ?, updated_at = NOW()`,
      [uuidv4(), dfsp_id, currency, amount, amount],
    );

    steps.db_log = 'ok';

    res.json({
      message: `Deposit successful: ${amount} ${currency} → ${dfsp_id}`,
      dfsp_id,
      currency,
      amount,
      position_before: posBefore,
      position_after: posAfter,
      steps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
};
*/
exports.getParticipants = async (req, res) => {
  try {
    const response = await axios.get(
      `${CENTRAL_LEDGER}/participants`,
      { headers: { 'fspiop-source': 'switch' } }
    );

    const EXCLUDE = ['hub', 'Hub', 'HUB'];

    const participants = (response.data || [])
      .filter(p => p.isActive === 1 && !EXCLUDE.includes(p.name))
      .map(p => ({ name: p.name, isActive: p.isActive }));

    return res.json({ data: participants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// ================================================================
//  GET /positions/:dfspId/live
//  Fetch live position, NDC, settlement balance from Central Ledger
// ================================================================
exports.getLivePosition = async (req, res) => {
  const { dfspId } = req.params;

  try {
    const [posRes, limRes, accRes] = await Promise.allSettled([
      axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/positions`,
        { headers: { 'fspiop-source': 'switch' } }),
      axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/limits`,
        { headers: { 'fspiop-source': 'switch' } }),
      axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/accounts`,
        { headers: { 'fspiop-source': 'switch' } }),
    ]);

    // Position
    let position = 0;
    if (posRes.status === 'fulfilled') {
      const d = posRes.value.data;
      position = parseFloat((Array.isArray(d) ? d[0]?.value : d?.value) || 0);
    }

    // Net Debit Cap
    let ndc = 0;
    if (limRes.status === 'fulfilled') {
      const d = limRes.value.data;
      const ndcEntry = Array.isArray(d)
        ? d.find(l => l.limit?.type === 'NET_DEBIT_CAP')
        : d;
      ndc = parseFloat(ndcEntry?.limit?.value || ndcEntry?.value || 0);
    }

    // Settlement account balance
    let settlement = 0;
    if (accRes.status === 'fulfilled') {
      const accounts = accRes.value.data || [];
      const settAcc  = Array.isArray(accounts)
        ? accounts.find(a => a.ledgerAccountType === 'SETTLEMENT')
        : null;
      settlement = parseFloat(settAcc?.value || 0);
    }

    const available = ndc - Math.abs(position);

    return res.json({
      dfspId,
      position,
      ndc,
      settlement,
      available,
      usedPct: ndc > 0 ? ((Math.abs(position) / ndc) * 100).toFixed(2) : '0.00',
      status:  available > ndc * 0.3 ? 'HEALTHY' : available > 0 ? 'LOW' : 'CRITICAL',
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.depositFunds = async (req, res) => {
  const { dfsp_id, account_id, currency, amount, reason } = req.body;

  if (!dfsp_id || !account_id || !currency || !amount)
    return res.status(400).json({ error: 'dfsp_id, account_id, currency, amount required' });

  const steps = { cl_deposit: null, db_log: null };

  try {
    // ── Verify account is SETTLEMENT type ─────────────────────
    let accountType = null;
    try {
      const accRes = await axios.get(
        `${CENTRAL_LEDGER}/participants/${dfsp_id}/accounts`,
        { headers: { 'fspiop-source': 'switch', 'Content-Type': 'application/json' } }
      );
      const account = (accRes.data || []).find(a => a.id === Number(account_id));
      if (account) accountType = account.ledgerAccountType;
    } catch (accErr) {
      console.warn(`[DEPOSIT] Could not fetch account type: ${accErr.message}`);
    }

    // Block deposit if POSITION account selected
    if (accountType === 'POSITION') {
      return res.status(400).json({
        error:   'Cannot deposit to POSITION account',
        details: 'Deposits must go to SETTLEMENT account only. Use NDC settings to adjust sending capacity.',
      });
    }

    // ── Step 1: Central Ledger recordFundsIn → SETTLEMENT ─────
    try {
      const response = await axios.post(
        `${CENTRAL_LEDGER}/participants/${dfsp_id}/accounts/${account_id}`,
        {
          transferId:        uuidv4(),
          externalReference: reason || `deposit-${Date.now()}`,
          action:            'recordFundsIn',
          reason:            reason || 'Manual deposit from R Switch',
          amount:            { amount: String(amount), currency },
        },
        {
          headers: {
            'Content-Type':  'application/vnd.interoperability.participants+json;version=1.1',
            'fspiop-source': 'switch',
            'Date':          new Date().toUTCString(),
          },
        }
      );
      steps.cl_deposit = { status: response.status, data: response.data };
      console.log(`✅ [DEPOSIT] recordFundsIn: ${dfsp_id} | SETTLEMENT | +${amount} ${currency}`);
    } catch (e) {
      steps.cl_deposit = { error: e.response?.data || e.message };
      console.error(`❌ [DEPOSIT] CL deposit failed: ${e.message}`);
    }

    // ── Step 2: Log deposit in R Switch DB ────────────────────
    // SETTLEMENT deposit does NOT change position value
    // so we only log it as an audit record — not in position_changes
    await pool.execute(
      `INSERT INTO dfsp_deposits
         (id, dfsp_id, account_id, currency, amount, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [uuidv4(), dfsp_id, account_id, currency, amount, reason || 'Manual deposit from R Switch']
    );
    steps.db_log = 'ok';

    // ── Fetch updated position from CL to confirm ─────────────
    let updatedPosition = null;
    try {
      const posRes = await axios.get(
        `${CENTRAL_LEDGER}/participants/${dfsp_id}/positions`,
        { headers: { 'fspiop-source': 'switch' } }
      );
      updatedPosition = posRes.data;
    } catch (_) {}

    return res.json({
      message:      `Deposit successful: +${amount} ${currency} → ${dfsp_id} (SETTLEMENT)`,
      dfsp_id,
      account_id,
      account_type: 'SETTLEMENT',
      currency,
      amount,
      effect:       'Physical liquidity recorded in settlement account. Position value unchanged.',
      cl_position:  updatedPosition,
      steps,
    });

  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
};
// ════════════════════════════════════════════════════════════
//  GET /positions/:dfspId/accounts — CL থেকে account ID নাও
//  Deposit করার আগে account_id জানতে হবে
// ════════════════════════════════════════════════════════════
exports.getDfspAccounts = async (req, res) => {
  try {
    const { dfspId } = req.params;

    const response = await axios.get(
      `${CENTRAL_LEDGER}/participants/${dfspId}/accounts`,
      { headers: { 'FSPIOP-Source': 'switch' } },
    );

    res.json({ data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
};
