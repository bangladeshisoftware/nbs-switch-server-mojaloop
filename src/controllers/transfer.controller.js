const { pool } = require('../config/db');

exports.getTransfers = async (req, res) => {
  try {
    const {
      status, page = 1, limit = 20,
      from, to, payer_fsp, payee_fsp,
      currency, search
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const values = [];

    if (status)    { conditions.push(`status = ?`);          values.push(status); }
    if (from)      { conditions.push(`created_at >= ?`);     values.push(from); }
    if (to)        { conditions.push(`created_at <= ?`);     values.push(to); }
    if (payer_fsp) { conditions.push(`payer_fsp = ?`);       values.push(payer_fsp); }
    if (payee_fsp) { conditions.push(`payee_fsp = ?`);       values.push(payee_fsp); }
    if (currency)  { conditions.push(`currency = ?`);        values.push(currency); }
    if (search)    { conditions.push(`transfer_id LIKE ?`);  values.push(`%${search}%`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.execute(`
      SELECT id, transfer_id, transaction_id, payer_fsp, payee_fsp,
             amount, currency, status, error_code, expiration,
             completed_at, created_at, updated_at
      FROM transfers ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
      [...values, parseInt(limit), offset]
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM transfers ${where}`, values
    );

    res.json({
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
      data:  rows
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getTransferById = async (req, res) => {
  try {
    const { transferId } = req.params;

    const [[transfer]] = await pool.execute(
      `SELECT * FROM transfers WHERE transfer_id = ?`, [transferId]
    );

    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    const [stateLog] = await pool.execute(`
      SELECT * FROM transfer_state_log
      WHERE transfer_id = ?
      ORDER BY created_at ASC`, [transferId]
    );

    res.json({ ...transfer, state_history: stateLog });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getStats = async (req, res) => {
  try {
    const { currency, from, to } = req.query;
    const conditions = [];
    const values = [];

    if (currency) { conditions.push(`currency = ?`);    values.push(currency); }
    if (from)     { conditions.push(`created_at >= ?`); values.push(from); }
    if (to)       { conditions.push(`created_at <= ?`); values.push(to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[stats]] = await pool.execute(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMMITTED' THEN 1 ELSE 0 END) as committed,
        SUM(CASE WHEN status = 'FAILED'    THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'TIMEOUT'   THEN 1 ELSE 0 END) as timeout,
        SUM(CASE WHEN status = 'COMMITTED' THEN amount ELSE 0 END) as total_volume,
        AVG(CASE WHEN status = 'COMMITTED' THEN TIMESTAMPDIFF(SECOND, created_at, completed_at) END) as avg_processing_secs
      FROM transfers ${where}`, values
    );

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
