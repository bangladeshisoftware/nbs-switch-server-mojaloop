const { pool } = require('../config/db');

exports.getSummary = async (req, res) => {
  try {
    const { from, to, currency } = req.query;
    let dateFilter = '';
    const values = [];

    if (from && to) {
      dateFilter = `WHERE created_at BETWEEN ? AND ?`;
      values.push(from, to);
    }

    const [statusCounts] = await pool.execute(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMMITTED'  THEN 1 ELSE 0 END) as committed,
        SUM(CASE WHEN status = 'FAILED'     THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'TIMEOUT'    THEN 1 ELSE 0 END) as timeout,
        SUM(CASE WHEN status = 'RECEIVED'   THEN 1 ELSE 0 END) as received,
        SUM(CASE WHEN status = 'RESERVED'   THEN 1 ELSE 0 END) as reserved,
        SUM(CASE WHEN status = 'CANCELLED'  THEN 1 ELSE 0 END) as cancelled
      FROM transfers ${dateFilter}`, values
    );

    const [volumes] = await pool.execute(`
      SELECT currency, 
        SUM(amount) as total_volume,
        COUNT(*) as count
      FROM transfers 
      WHERE status = 'COMMITTED' ${dateFilter ? 'AND created_at BETWEEN ? AND ?' : ''}
      GROUP BY currency`, dateFilter ? values : []
    );

    const [hourly] = await pool.execute(`
      SELECT 
        DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMMITTED' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'FAILED'    THEN 1 ELSE 0 END) as failed
      FROM transfers
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY hour ORDER BY hour ASC`
    );

    const [topDfsps] = await pool.execute(`
      SELECT payer_fsp as dfsp, COUNT(*) as sent, SUM(amount) as volume
      FROM transfers WHERE status = 'COMMITTED'
      GROUP BY payer_fsp ORDER BY volume DESC LIMIT 5`
    );

    const summary = statusCounts[0];
    const successRate = summary.total > 0
      ? ((summary.committed / summary.total) * 100).toFixed(2)
      : 0;

    res.json({
      summary: { ...summary, success_rate: parseFloat(successRate) },
      volumes,
      hourly,
      topDfsps
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
