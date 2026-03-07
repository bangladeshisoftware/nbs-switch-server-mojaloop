const { pool } = require('../config/db')
const { v4: uuidv4 } = require('uuid')
const axios = require('axios')
const bcrypt = require('bcryptjs') // FIX Bug 5: top-level import করতে হবে
const { sendEmail } = require('../services/email.service')

const CENTRAL_LEDGER = process.env.CENTRAL_LEDGER_URL || 'http://ledger.mojaloop.xyz'
const ALS_URL = process.env.ALS_URL || 'http://als.mojaloop.xyz'

// ════════════════════════════════════════════════════════════
//  CENTRAL LEDGER API HELPERS
// ════════════════════════════════════════════════════════════

// Step 1: Participant create করো Central Ledger এ
async function clCreateParticipant(dfspId, currency) {
  const res = await axios.post(
    `${CENTRAL_LEDGER}/participants`,
    { name: dfspId, currency },
    {
      headers: { 'Content-Type': 'application/json', 'fspiop-source': 'NOT_APPLICABLE' }
    }
  )
  return res.data
}

// Step 2: Settlement Account create করো
// FIX Bug 1: { currency, initialPosition } allowed নয়
//            → { type: 'SETTLEMENT', currency } দিতে হবে
async function clSetInitialPosition(dfspId, currency) {
  const res = await axios.post(
    `${CENTRAL_LEDGER}/participants/${dfspId}/accounts`,
    { type: 'SETTLEMENT', currency },
    {
      headers: { 'Content-Type': 'application/json', 'FSPIOP-Source': dfspId }
    }
  )
  return res.data
}

// Step 3: Callback endpoints register করো
async function clRegisterEndpoints(dfspId, callbackUrl) {
  const endpoints = [
    {
      type: 'FSPIOP_CALLBACK_URL_TRANSFER_POST',
      value: `${callbackUrl}/transfers`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_TRANSFER_PUT',
      value: `${callbackUrl}/transfers/{{transferId}}`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_TRANSFER_ERROR',
      value: `${callbackUrl}/transfers/{{transferId}}/error`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_QUOTES',
      value: `${callbackUrl}` // FIX Bug 6: /quotes path ছিল না
    },
    {
      type: 'FSPIOP_CALLBACK_URL_BULK_QUOTES',
      value: `${callbackUrl}/bulkQuotes`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_BULK_TRANSFER_POST',
      value: `${callbackUrl}/bulkTransfers`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_BULK_TRANSFER_PUT',
      value: `${callbackUrl}/bulkTransfers/{{id}}`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_BULK_TRANSFER_ERROR',
      value: `${callbackUrl}/bulkTransfers/{{id}}/error`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_PARTIES_GET',
      value: `${callbackUrl}/parties/{{partyIdType}}/{{partyIdentifier}}`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_PARTIES_PUT',
      value: `${callbackUrl}/parties/{{partyIdType}}/{{partyIdentifier}}`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_PARTIES_PUT_ERROR',
      value: `${callbackUrl}/parties/{{partyIdType}}/{{partyIdentifier}}/error`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_PARTICIPANT_PUT',
      value: `${callbackUrl}/participants/{{partyIdType}}/{{partyIdentifier}}`
    },
    {
      type: 'FSPIOP_CALLBACK_URL_PARTICIPANT_PUT_ERROR',
      value: `${callbackUrl}/participants/{{partyIdType}}/{{partyIdentifier}}/error`
    }
  ]

  const results = []
  for (const ep of endpoints) {
    try {
      await axios.post(`${CENTRAL_LEDGER}/participants/${dfspId}/endpoints`, ep, {
        headers: {
          'Content-Type': 'application/json',
          'fspiop-source': 'switch'
        }
      })
      results.push({ type: ep.type, status: 'ok' })
    } catch (e) {
      results.push({
        type: ep.type,
        status: 'failed',
        error: e.response?.data || e.message
      })
    }
  }
  return results
}

// Step 4: Net Debit Cap set করো
// FIX Bug 2: axios.post → axios.put (Central Ledger এ PUT method লাগে)
async function clSetNetDebitCap(dfspId, currency, limit = '10000') {
  const res = await axios.post(
    `${CENTRAL_LEDGER}/participants/${dfspId}/initialPositionAndLimits`,
    { currency:currency || 'BDT', limit: { type: 'NET_DEBIT_CAP', value: parseFloat(limit) }, initialPosition: 0 },
    {
      headers: {
        'Content-Type': 'application/json',
        'fspiop-source': dfspId
      }
    }
  )
  return res.data
}

// ════════════════════════════════════════════════════════════
//  GET /dfsps
// ════════════════════════════════════════════════════════════
exports.getDfsps = async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT * FROM dfsps ORDER BY name ASC`)
    res.json({ data: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// ════════════════════════════════════════════════════════════
//  GET /dfsps/:dfspId
// ════════════════════════════════════════════════════════════
exports.getDfspById = async (req, res) => {
  try {
    const { dfspId } = req.params
    const [[dfsp]] = await pool.execute(`SELECT * FROM dfsps WHERE dfsp_id = ?`, [dfspId])
    if (!dfsp) return res.status(404).json({ error: 'DFSP not found' })

    const [[stats]] = await pool.execute(
      `SELECT
        COUNT(*) as total_transfers,
        SUM(CASE WHEN status = 'COMMITTED' THEN 1 ELSE 0 END) as committed,
        SUM(CASE WHEN status = 'FAILED'    THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'COMMITTED' THEN amount ELSE 0 END) as total_volume
       FROM transfers
       WHERE payer_fsp = ? OR payee_fsp = ?`,
      [dfspId, dfspId]
    )

    let clEndpoints = []
    let clLimits = []
    try {
      const epRes = await axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/endpoints`, {
        headers: { 'fspiop-source': 'switch' }
      })
      clEndpoints = epRes.data

      const limRes = await axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/limits`, {
        headers: { 'fspiop-source': 'switch' }
      })
      clLimits = limRes.data
    } catch (_) {
      // Central Ledger unavailable হলেও local data দেখাবে
    }

    res.json({
      data: { ...dfsp, stats, cl_endpoints: clEndpoints, cl_limits: clLimits }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// ════════════════════════════════════════════════════════════
//  POST /dfsps
//  ১. Central Ledger এ participant create
//  ২. Settlement account create
//  ৩. Callback endpoints register
//  ৪. Net Debit Cap set (PUT)
//  ৫. R Switch DB তে save
// ════════════════════════════════════════════════════════════
exports.createDfsp = async (req, res) => {
  const {
    dfsp_id,
    name,
    short_name,
    email,
    endpoint_url,
    callback_url,
    currency,
    initial_position = '0',
    net_debit_cap = '10000',
    admin_username,
    admin_email,
    admin_password,
    admin_full_name
  } = req.body

  if (!dfsp_id || !name || !currency) {
    return res.status(400).json({ error: 'dfsp_id, name, currency required' })
  }

  const steps = {
    cl_participant: null,
    cl_position: true,
    cl_endpoints: null,
    cl_ndc: null,
    db_save: null
  }

  try {
    // ── Step 1: Central Ledger এ participant create ────────
    try {
      steps.cl_participant = await clCreateParticipant(dfsp_id, currency)
      console.log(`[DFSP] CL participant created: ${dfsp_id}`)
    } catch (e) {
      const status = e.response?.status
      if (status === 400 || status === 409) {
        steps.cl_participant = { skipped: true, reason: 'already exists' }
        console.log(`[DFSP] CL participant already exists: ${dfsp_id}`)
      } else {
        steps.cl_participant = { error: e.response?.data || e.message }
        console.error(`[DFSP] CL participant error: ${e.message}`)
      }
    }

    // ── Step 2: Settlement Account ─────────────────────────
    // try {
    //   steps.cl_position = await clSetInitialPosition(dfsp_id, currency);
    //   console.log(`[DFSP] Settlement account created: ${dfsp_id}`);
    // } catch (e) {
    //   const errDesc =
    //     e.response?.data?.errorInformation?.errorDescription || '';
    //   if (errDesc.toLowerCase().includes('already') || e.response?.status === 409) {
    //     steps.cl_position = { skipped: true, reason: 'account already exists' };
    //     console.log(`[DFSP] Settlement account already exists: ${dfsp_id}`);
    //   } else {
    //     steps.cl_position = { error: e.response?.data || e.message };
    //     console.error(`[DFSP] Position error: ${e.message}`);
    //   }
    // }

    // ── Step 3: Callback Endpoints ─────────────────────────
    if (callback_url || endpoint_url) {
      try {
        steps.cl_endpoints = await clRegisterEndpoints(dfsp_id, callback_url || endpoint_url)
        console.log(`[DFSP] Endpoints registered: ${dfsp_id}`)
      } catch (e) {
        steps.cl_endpoints = { error: e.response?.data || e.message }
        console.error(`[DFSP] Endpoints error: ${e.message}`)
      }
    }

    // ── Step 4: Net Debit Cap ──────────────────────────────
    try {
      steps.cl_ndc = await clSetNetDebitCap(dfsp_id, currency, net_debit_cap)
      console.log(`[DFSP] NDC set: ${dfsp_id} | ${net_debit_cap} ${currency}`)
    } catch (e) {
      steps.cl_ndc = { error: e.response?.data || e.message }
      console.error(`[DFSP] NDC error: ${e.message}`)
    }

    await pool.execute(
      `INSERT INTO dfsps (id, dfsp_id, name, short_name, email, endpoint_url, callback_url, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        dfsp_id,
        name,
        short_name || dfsp_id,
        email || null, // email — সঠিক position এ
        endpoint_url || null,
        callback_url || null,
        currency
      ]
    )
    steps.db_save = 'ok'
    console.log(`[DFSP] Saved to R Switch DB: ${dfsp_id}`)

    // dfsp_positions initial row
    await pool.execute(
      `INSERT INTO dfsp_positions (id, dfsp_id, currency, current_position, net_debit_cap, reserved_amount)
       VALUES (?, ?, ?, 0, ?, 0)
       ON DUPLICATE KEY UPDATE net_debit_cap = VALUES(net_debit_cap), updated_at = NOW()`,
      [uuidv4(), dfsp_id, currency, parseFloat(net_debit_cap)]
    )

    // ── Step 6: DFSP Admin User ────────────────────────────
    let admin_user = null
    if (admin_username && admin_email && admin_password) {
      try {
        const hashed = await bcrypt.hash(admin_password, 10)
        const adminId = uuidv4()
        await pool.execute(
          `INSERT INTO dfsp_users (id, dfsp_id, username, email, password, full_name, role)
           VALUES (?, ?, ?, ?, ?, ?, 'ADMIN')`,
          [adminId, dfsp_id, admin_username, admin_email, hashed, admin_full_name || admin_username]
        )
        steps.admin_user = 'created'
        admin_user = { username: admin_username, email: admin_email }
        console.log(`[DFSP] Admin user created: ${admin_username} for ${dfsp_id}`)

        // Welcome email
        try {
          await sendEmail({
            to: admin_email,
            subject: `[R Switch] DFSP Portal Access — ${name}`,
            html: `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { background:#0a0a0a; font-family:Arial,sans-serif; margin:0; padding:0; }
  .wrap { max-width:480px; margin:30px auto; padding:16px; }
  .card { background:#111; border:1px solid #1e1e1e; border-radius:12px; overflow:hidden; }
  .hdr  { background:#0d0d0d; border-bottom:2px solid #00ff00; padding:20px 28px; }
  .hdr h1 { margin:0; font-size:15px; color:#fff; font-weight:700; }
  .hdr p  { margin:4px 0 0; font-size:10px; color:#666; }
  .body { padding:24px 28px; }
  .row  { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #1a1a1a; }
  .row:last-child { border:none; }
  .lbl  { font-size:11px; color:#666; }
  .val  { font-size:11px; color:#ccc; font-family:'Courier New',monospace; font-weight:700; }
  .warn { background:#1a1a00; border:1px solid #2a2000; border-radius:6px; padding:10px 14px; margin-top:16px; }
  .warn p { font-size:10px; color:#888; margin:0; line-height:1.6; }
  .footer { border-top:1px solid #1a1a1a; padding:14px 28px; text-align:center; color:#333; font-size:9px; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="hdr">
    <h1>⬡ DFSP Portal Access Created</h1>
    <p>R Switch Portal — Mojaloop Financial Switch</p>
  </div>
  <div class="body">
    <p style="color:#999;font-size:12px;margin-bottom:18px">
      Dear <strong style="color:#fff">${admin_full_name || admin_username}</strong>,<br>
      Your DFSP Portal admin account has been created by R Switch.
    </p>
    <div class="row"><span class="lbl">DFSP ID</span><span class="val">${dfsp_id}</span></div>
    <div class="row"><span class="lbl">DFSP Name</span><span class="val">${name}</span></div>
    <div class="row"><span class="lbl">Portal URL</span><span class="val">${process.env.DFSP_PORTAL_URL || 'http://portal.mojaloop.xyz'}</span></div>
    <div class="row"><span class="lbl">Username</span><span class="val">${admin_username}</span></div>
    <div class="row"><span class="lbl">Password</span><span class="val">${admin_password}</span></div>
    <div class="row"><span class="lbl">Role</span><span class="val" style="color:#00ff00">ADMIN</span></div>
    <div class="warn">
      <p>⚠️ Please login and change your password immediately.<br>
      You can create additional users (OPERATOR, VIEWER) from the portal.<br>
      Keep your credentials secure and do not share.</p>
    </div>
  </div>
  <div class="footer">R Switch Portal · Automated Access Email · Do not reply</div>
</div></div>
</body></html>`
          })
          steps.welcome_email = 'sent'
          console.log(`[DFSP] Welcome email sent to ${admin_email}`)
        } catch (emailErr) {
          steps.welcome_email = 'failed'
          console.error(`[DFSP] Welcome email failed: ${emailErr.message}`)
        }
      } catch (userErr) {
        steps.admin_user = { error: userErr.message }
        console.error(`[DFSP] Admin user creation failed: ${userErr.message}`)
      }
    }

    res.status(201).json({
      message: 'DFSP created successfully',
      dfsp_id,
      steps,
      admin_user
    })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'DFSP already exists in R Switch DB', steps })
    res.status(500).json({ error: err.message, steps })
  }
}

exports.updateDfsp = async (req, res) => {
  try {
    const { dfspId } = req.params
    const { name, short_name, email, endpoint_url, callback_url, status, currency } = req.body

    await pool.execute(
      `UPDATE dfsps
       SET name = ?, short_name = ?, email = ?,
           endpoint_url = ?, callback_url = ?, status = ?, currency = ?, updated_at = NOW()
       WHERE dfsp_id = ?`,
      [name, short_name, email, endpoint_url, callback_url, status, currency, dfspId]
    )

    if (callback_url || endpoint_url) {
      try {
        await clRegisterEndpoints(dfspId, callback_url || endpoint_url)
        console.log(`[DFSP] Endpoints updated in CL: ${dfspId}`)
      } catch (e) {
        console.error(`[DFSP] CL endpoint update failed: ${e.message}`)
      }
    }

    res.json({ message: 'DFSP updated successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

exports.getDfspEndpoints = async (req, res) => {
  try {
    const { dfspId } = req.params
    const response = await axios.get(`${CENTRAL_LEDGER}/participants/${dfspId}/endpoints`, {
      headers: { 'fspiop-source': 'switch' }
    })
    res.json({ data: response.data })
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message })
  }
}

exports.registerEndpoints = async (req, res) => {
  try {
    const { dfspId } = req.params
    const { callback_url } = req.body

    if (!callback_url) return res.status(400).json({ error: 'callback_url required' })

    const results = await clRegisterEndpoints(dfspId, callback_url)

    await pool.execute(`UPDATE dfsps SET callback_url = ?, updated_at = NOW() WHERE dfsp_id = ?`, [
      callback_url,
      dfspId
    ])

    res.json({ message: 'Endpoints registered', results })
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message })
  }
}
