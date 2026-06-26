/**************************************************************************
 * Copyright © 2026 Bangladeshi Software Ltd. All rights reserved.
 * Distributed under the license terms specified in this repository.
 *
 * ORIGINAL AUTHOR: Muhammad Nasim (Developer)
 **************************************************************************/

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const { sendOTPEmail } = require('../services/email.service');
const geoip = require('geoip-lite');

const OTP_EXPIRY_MINUTES = 10;

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const [rows] = await pool.execute(
      `SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1`,
      [username, username],
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Generate OTP.
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await pool.execute(
      `UPDATE users SET otp = ?, otp_expires_at = ? WHERE id = ?`,
      [otp, otpExpiry, user.id],
    );

    let emailSent = false;
    if (user.email) {
      try {
        await sendOTPEmail({
          to: user.email,
          username: user.username,
          otp,
        });
        emailSent = true;
      } catch (emailErr) {
        // console.error(`failed: ${emailErr.message}`);
        // if (process.env.NODE_ENV !== 'production') {
        //   console.log(`${otp}`);
        // }
      }
    } else {
      res.status(400).json({ message: 'user not found!' });
    }

    res.json({
      otp_status: true,
      email_sent: emailSent,
      email_hint: user.email ? maskEmail(user.email) : null,
      expires_in: `${OTP_EXPIRY_MINUTES} minutes`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.verify_otp = async (req, res) => {
  try {
    const { username, otp } = req.body;
    if (!username || !otp)
      return res.status(400).json({ error: 'Username and OTP required' });

    // check user with OTP
    const [rows] = await pool.execute(
      `SELECT * FROM users
       WHERE (username = ? OR email = ?) AND is_active = 1 AND otp = ?`,
      [username, username, otp],
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid OTP' });

    // update otp.
    await pool.execute(
      `UPDATE users SET otp = NULL, otp_expires_at = NULL, last_login = NOW() WHERE id = ?`,
      [user.id],
    );

    // activity log
    let ip =
      req.headers['x-forwarded-for'] ||
      req.connection.remoteAddress ||
      'unknown';
    if (ip.includes(',')) ip = ip.split(',')[0].trim();

    const geo = geoip.lookup(ip);
    const location = geo
      ? `${geo.city || 'Unknown City'}, ${geo.country || 'Unknown Country'}`
      : 'Unknown';

    await pool.execute(
      `INSERT INTO activity_logs (username, email, login_time, ip_address, location, type)
       VALUES (?, ?, NOW(), ?, ?, ?)`,
      [user.username, user.email, ip, location, 'switch'],
    );

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' },
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDFSPToken = async (req, res) => {
  try {
    const { dfsp_id } = req.body;
    if (!dfsp_id) {
      return res.status(400).json({ error: 'DFSP id is required' });
    }

    const [rows] = await pool.execute(
      `SELECT * FROM dfsp_users WHERE dfsp_id = ?`,
      [dfsp_id],
    );

    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid DFSP ID' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        dfsp_id: user.dfsp_id,
        username: user.username,
        role: user.role,
      },
      process.env.DFSP_PORTAL_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || '365d',
      },
    );

    await pool.execute(
      `UPDATE dfsp_users SET token = ?, last_login = NOW() WHERE id = ?`,
      [token, user.id],
    );

    return res.status(200).json({
      success: true,
      token,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, username, email, role, is_active, last_login, created_at FROM users ORDER BY created_at DESC`,
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);

    await pool.execute(
      `INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), username, email, hashed, role || 'VIEWER'],
    );

    res.status(201).json({ message: 'User created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res
        .status(409)
        .json({ error: 'Username or email already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, is_active } = req.body;

    await pool.execute(
      `UPDATE users SET role = ?, is_active = ?, updated_at = NOW() WHERE id = ?`,
      [role, is_active, id],
    );
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function maskEmail(email) {
  const [local, domain] = email.split('@');
  const masked = local.slice(0, 2) + '****';
  return `${masked}@${domain}`;
}
