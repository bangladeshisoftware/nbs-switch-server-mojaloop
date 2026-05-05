const { pool } = require('../config/db');

exports.getLogs = async (req, res) => {
  try {
    const {
      type,
      username,
      ip_address,
      page  = 1,
      limit = 50,
      from,
      to,
    } = req.query;

    const conditions = [];
    const values     = [];

    if (type)       { conditions.push(`type = ?`);                    values.push(type); }
    if (username)   { conditions.push(`username LIKE ?`);             values.push(`%${username}%`); }
    if (ip_address) { conditions.push(`ip_address LIKE ?`);           values.push(`%${ip_address}%`); }
    if (from)       { conditions.push(`login_time >= ?`);             values.push(from); }
    if (to)         { conditions.push(`login_time <= ?`);             values.push(to); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM activity_logs ${where}`, values
    );

    const [rows] = await pool.execute(
      `SELECT * FROM activity_logs ${where}
       ORDER BY login_time DESC
       LIMIT ? OFFSET ?`,
      [...values, parseInt(limit), offset]
    );

    res.json({
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
      data:  rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


exports.getStats = async (req, res) => {
  try {
    const [[stats]] = await pool.execute(`
      SELECT
        COUNT(*)                                              AS total,
        SUM(CASE WHEN type = 'switch' THEN 1 ELSE 0 END)    AS switch_logins,
        SUM(CASE WHEN type = 'dfsp'   THEN 1 ELSE 0 END)    AS dfsp_logins,
        COUNT(DISTINCT username)                             AS unique_users,
        COUNT(DISTINCT ip_address)                           AS unique_ips,
        SUM(CASE WHEN DATE(login_time) = CURDATE() THEN 1 ELSE 0 END) AS today
    FROM activity_logs`);

    // Last 7 days
    const [daily] = await pool.execute(`
      SELECT
        DATE(login_time)                                    AS date,
        COUNT(*)                                            AS total,
        SUM(CASE WHEN type = 'switch' THEN 1 ELSE 0 END)  AS switch_count,
        SUM(CASE WHEN type = 'dfsp'   THEN 1 ELSE 0 END)  AS dfsp_count
      FROM activity_logs
      WHERE login_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(login_time)
      ORDER BY date DESC`);

    // Top users
    const [topUsers] = await pool.execute(`
      SELECT username, email, type, COUNT(*) AS login_count,
             MAX(login_time) AS last_login, location
      FROM activity_logs
      GROUP BY username, email, type, location
      ORDER BY login_count DESC
      LIMIT 10`);

    res.json({ stats, daily, top_users: topUsers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
