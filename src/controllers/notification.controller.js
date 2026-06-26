/**************************************************************************
 * Copyright © 2026 Bangladeshi Software Ltd. All rights reserved.
 * Distributed under the license terms specified in this repository.
 *
 * ORIGINAL AUTHOR: Muhammad Nasim (Developer)
 **************************************************************************/

const { pool } = require('../config/db');

exports.getNotifications = async (req, res) => {
  try {
    const {
      to_fsp,
      from_fsp,
      transfer_state,
      event_type,
      transfer_id,
      page = 1,
      limit = 20,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const values = [];

    if (to_fsp) {
      conditions.push(`to_fsp = ?`);
      values.push(to_fsp);
    }
    if (from_fsp) {
      conditions.push(`from_fsp = ?`);
      values.push(from_fsp);
    }
    if (transfer_state) {
      conditions.push(`transfer_state = ?`);
      values.push(transfer_state);
    }
    if (event_type) {
      conditions.push(`event_type = ?`);
      values.push(event_type);
    }
    if (transfer_id) {
      conditions.push(`transfer_id = ?`);
      values.push(transfer_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        transfer_id,
        to_fsp,
        from_fsp,
        event_type,
        transfer_state,
        payload,
        created_at
      FROM notifications_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
      [...values, parseInt(limit), offset],
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM notifications_log ${where}`,
      values,
    );

    res.json({
      total: parseInt(total),
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
      data: rows,
    });
  } catch (err) {
    console.error('getNotifications error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getNotificationById = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT * FROM notifications_log WHERE id = ?`,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('getNotificationById error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getByTransferId = async (req, res) => {
  try {
    const { transferId } = req.params;

    const [rows] = await pool.execute(
      `
      SELECT * FROM notifications_log
      WHERE transfer_id = ?
      ORDER BY created_at ASC`,
      [transferId],
    );

    res.json({ total: rows.length, data: rows });
  } catch (err) {
    console.error('getByTransferId error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getStats = async (req, res) => {
  try {
    const [[summary]] = await pool.execute(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(CASE WHEN transfer_state = 'COMMITTED' THEN 1 END) AS committed,
        COUNT(CASE WHEN transfer_state = 'FAILED'    THEN 1 END) AS failed,
        COUNT(CASE WHEN transfer_state = 'prepare'   THEN 1 END) AS prepare,
        COUNT(CASE WHEN transfer_state = 'commit'    THEN 1 END) AS commit_count,
        COUNT(DISTINCT to_fsp)                           AS unique_recipients,
        COUNT(DISTINCT transfer_id)                      AS unique_transfers
      FROM notifications_log
    `);

    const [byFsp] = await pool.execute(`
      SELECT
        to_fsp,
        COUNT(*) AS total,
        COUNT(CASE WHEN transfer_state = 'COMMITTED' THEN 1 END) AS committed,
        COUNT(CASE WHEN transfer_state = 'FAILED'    THEN 1 END) AS failed
      FROM notifications_log
      WHERE to_fsp IS NOT NULL
      GROUP BY to_fsp
      ORDER BY total DESC
    `);

    const [recent] = await pool.execute(`
      SELECT * FROM notifications_log
      ORDER BY created_at DESC
      LIMIT 10
    `);

    res.json({
      summary,
      by_fsp: byFsp,
      recent,
    });
  } catch (err) {
    console.error('getStats error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
