const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

// GET /reconciliation?dfsp_id=&recon_status=&from=&to=
exports.getReconciliation = async (req, res) => {
  try {
    const { dfsp_id, recon_status, from, to, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const values = [];

    if (dfsp_id)      { conditions.push(`r.dfsp_id = ?`);       values.push(dfsp_id); }
    if (recon_status) { conditions.push(`r.recon_status = ?`);  values.push(recon_status); }
    if (from)         { conditions.push(`r.created_at >= ?`);   values.push(from); }
    if (to)           { conditions.push(`r.created_at <= ?`);   values.push(to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.execute(`
      SELECT r.*, t.payer_fsp, t.payee_fsp, t.status as transfer_status
      FROM reconciliation r
      LEFT JOIN transfers t ON t.transfer_id = r.transfer_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
      [...values, parseInt(limit), offset]
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM reconciliation r ${where}`, values
    );

    // Summary counts
    const [[summary]] = await pool.execute(`
      SELECT
        SUM(CASE WHEN recon_status = 'MATCHED'   THEN 1 ELSE 0 END) as matched,
        SUM(CASE WHEN recon_status = 'UNMATCHED' THEN 1 ELSE 0 END) as unmatched,
        SUM(CASE WHEN recon_status = 'PENDING'   THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN recon_status = 'DISPUTED'  THEN 1 ELSE 0 END) as disputed
      FROM reconciliation r ${where}`, values
    );

    res.json({ total, page: parseInt(page), limit: parseInt(limit), summary, data: rows });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /reconciliation/run - manual reconciliation trigger
exports.runReconciliation = async (req, res) => {
  try {
    const { settlement_date } = req.body;
    const date = settlement_date || new Date().toISOString().split('T')[0];

    // Find COMMITTED transfers not yet reconciled
    const [transfers] = await pool.execute(`
      SELECT t.transfer_id, t.payer_fsp, t.payee_fsp, t.amount, t.currency
      FROM transfers t
      LEFT JOIN reconciliation r ON r.transfer_id = t.transfer_id
      WHERE t.status = 'COMMITTED'
        AND DATE(t.completed_at) = ?
        AND r.id IS NULL`,
      [date]
    );

    let created = 0;
    for (const t of transfers) {
      await pool.execute(`
        INSERT INTO reconciliation
          (id, transfer_id, dfsp_id, transfer_type, amount, currency, recon_status, settlement_date)
        VALUES (?, ?, ?, 'SEND', ?, ?, 'PENDING', ?)`,
        [uuidv4(), t.transfer_id, t.payer_fsp, t.amount, t.currency, date]
      );
      await pool.execute(`
        INSERT INTO reconciliation
          (id, transfer_id, dfsp_id, transfer_type, amount, currency, recon_status, settlement_date)
        VALUES (?, ?, ?, 'RECEIVE', ?, ?, 'PENDING', ?)`,
        [uuidv4(), t.transfer_id, t.payee_fsp, t.amount, t.currency, date]
      );
      created += 2;
    }

    // Auto-match: mark as MATCHED where both SEND and RECEIVE exist
    await pool.execute(`
      UPDATE reconciliation r1
      JOIN reconciliation r2 ON r1.transfer_id = r2.transfer_id
        AND r1.transfer_type = 'SEND' AND r2.transfer_type = 'RECEIVE'
      SET r1.recon_status = 'MATCHED', r2.recon_status = 'MATCHED'
      WHERE r1.recon_status = 'PENDING' AND r2.recon_status = 'PENDING'
        AND r1.settlement_date = ?`, [date]
    );

    res.json({
      message: 'Reconciliation completed',
      date,
      records_created: created,
      transfers_processed: transfers.length
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /reconciliation/report
exports.getReport = async (req, res) => {
  try {
    const { from, to } = req.query;
    const values = [];
    let dateFilter = '';

    if (from && to) {
      dateFilter = `WHERE settlement_date BETWEEN ? AND ?`;
      values.push(from, to);
    }

    const [report] = await pool.execute(`
      SELECT 
        dfsp_id,
        currency,
        SUM(CASE WHEN transfer_type = 'SEND'    THEN amount ELSE 0 END) as total_sent,
        SUM(CASE WHEN transfer_type = 'RECEIVE' THEN amount ELSE 0 END) as total_received,
        SUM(CASE WHEN transfer_type = 'SEND'    THEN amount ELSE 0 END) -
        SUM(CASE WHEN transfer_type = 'RECEIVE' THEN amount ELSE 0 END) as net_position,
        SUM(CASE WHEN recon_status = 'MATCHED'   THEN 1 ELSE 0 END) as matched,
        SUM(CASE WHEN recon_status = 'UNMATCHED' THEN 1 ELSE 0 END) as unmatched,
        COUNT(*) as total
      FROM reconciliation ${dateFilter}
      GROUP BY dfsp_id, currency
      ORDER BY dfsp_id`, values
    );

    res.json({ data: report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
