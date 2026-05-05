
const { pool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const CENTRAL_LEDGER = process.env.CENTRAL_LEDGER_URL || 'http://your-ledger-domain.com';
const clHeaders      = { 'Content-Type': 'application/json', 'fspiop-source': 'switch' };

async function clCreateParticipant(pispId, currency) {
  const res = await axios.post(`${CENTRAL_LEDGER}/participants`,
    { name: pispId, currency },
    { headers: clHeaders }
  );
  return res.data;
}


async function clRegisterPispEndpoints(pispId, callbackUrl) {
  const endpoints = [
    { type: 'FSPIOP_CALLBACK_URL_PARTIES_GET',
      value: `${callbackUrl}/parties/{{partyIdType}}/{{partyIdentifier}}` },
    { type: 'FSPIOP_CALLBACK_URL_PARTIES_PUT',
      value: `${callbackUrl}/parties/{{partyIdType}}/{{partyIdentifier}}` },
    { type: 'FSPIOP_CALLBACK_URL_PARTIES_PUT_ERROR',
      value: `${callbackUrl}/parties/{{partyIdType}}/{{partyIdentifier}}/error` },
    { type: 'FSPIOP_CALLBACK_URL_PARTICIPANT_PUT',
      value: `${callbackUrl}/participants/{{partyIdType}}/{{partyIdentifier}}` },
    { type: 'FSPIOP_CALLBACK_URL_PARTICIPANT_PUT_ERROR',
      value: `${callbackUrl}/participants/{{partyIdType}}/{{partyIdentifier}}/error` },
    { type: 'TP_CB_URL_CONSENT_POST',
      value: `${callbackUrl}/consents` },
    { type: 'TP_CB_URL_CONSENT_PUT',
      value: `${callbackUrl}/consents/{{ID}}` },
    { type: 'TP_CB_URL_CONSENT_PUT_ERROR',
      value: `${callbackUrl}/consents/{{ID}}/error` },
    { type: 'TP_CB_URL_CONSENT_PATCH',
      value: `${callbackUrl}/consents/{{ID}}` },
    { type: 'TP_CB_URL_CONSENT_REQUEST_POST',
      value: `${callbackUrl}/consentRequests` },
    { type: 'TP_CB_URL_CONSENT_REQUEST_PUT',
      value: `${callbackUrl}/consentRequests/{{ID}}` },
    { type: 'TP_CB_URL_CONSENT_REQUEST_PUT_ERROR',
      value: `${callbackUrl}/consentRequests/{{ID}}/error` },
    { type: 'TP_CB_URL_CONSENT_REQUEST_PATCH',
      value: `${callbackUrl}/consentRequests/{{ID}}` },
    { type: 'FSPIOP_CALLBACK_URL_TRX_REQ_SERVICE',
      value: `${callbackUrl}/thirdPartyRequests/transactions` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_POST',
      value: `${callbackUrl}/thirdPartyRequests/transactions` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_PUT',
      value: `${callbackUrl}/thirdPartyRequests/transactions/{{ID}}` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_PUT_ERROR',
      value: `${callbackUrl}/thirdPartyRequests/transactions/{{ID}}/error` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_PATCH',
      value: `${callbackUrl}/thirdPartyRequests/transactions/{{ID}}` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_AUTH_POST',
      value: `${callbackUrl}/thirdPartyRequests/transactions/{{ID}}/authorizations` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_AUTH_PUT',
      value: `${callbackUrl}/thirdPartyRequests/transactions/{{ID}}/authorizations` },
    { type: 'TP_CB_URL_TRANSACTION_REQUEST_AUTH_PUT_ERROR',
      value: `${callbackUrl}/thirdPartyRequests/transactions/{{ID}}/authorizations/error` },
    { type: 'TP_CB_URL_ACCOUNTS_GET',
      value: `${callbackUrl}/accounts/{{ID}}` },
    { type: 'TP_CB_URL_ACCOUNTS_PUT',
      value: `${callbackUrl}/accounts/{{ID}}` },
    { type: 'TP_CB_URL_ACCOUNTS_PUT_ERROR',
      value: `${callbackUrl}/accounts/{{ID}}/error` },
    { type: 'TP_CB_URL_SERVICES_GET',
      value: `${callbackUrl}/services/{{ServiceType}}` },
    { type: 'TP_CB_URL_SERVICES_PUT',
      value: `${callbackUrl}/services/{{ServiceType}}` },
    { type: 'TP_CB_URL_SERVICES_PUT_ERROR',
      value: `${callbackUrl}/services/{{ServiceType}}/error` },
  ];

  const results = [];
  for (const ep of endpoints) {
    try {
      await axios.post(
        `${CENTRAL_LEDGER}/participants/${pispId}/endpoints`,
        ep,
        { headers: clHeaders }
      );
      results.push({ type: ep.type, status: 'ok' });
    } catch (e) {
      results.push({ type: ep.type, status: 'failed', error: e.response?.data || e.message });
    }
  }
  return results;
}


exports.getPisps = async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT * FROM pisps ORDER BY created_at DESC`);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


exports.getPispById = async (req, res) => {
  try {
    const { pispId } = req.params;

    const [[pisp]] = await pool.execute(
      `SELECT * FROM pisps WHERE pisp_id = ?`, [pispId]
    );
    if (!pisp) return res.status(404).json({ error: 'PISP not found' });

    // Fetch endpoints from central ledger
    let clEndpoints = [];
    try {
      const epRes  = await axios.get(
        `${CENTRAL_LEDGER}/participants/${pispId}/endpoints`,
        { headers: clHeaders }
      );
      clEndpoints = epRes.data;
    } catch (_) {}

    res.json({ data: { ...pisp, cl_endpoints: clEndpoints } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


exports.createPisp = async (req, res) => {
  const {
    pisp_id,
    name,
    short_name,
    callback_url,
    currency  = 'BDT',
    note,
  } = req.body;

  if (!pisp_id || !name || !callback_url)
    return res.status(400).json({ error: 'pisp_id, name, callback_url required' });

  const steps = {
    cl_participant: null,
    cl_endpoints:   null,
    db_save:        null,
  };

  try {
    try {
      steps.cl_participant = await clCreateParticipant(pisp_id, currency);
    } catch (e) {
      const status = e.response?.status;
      if (status === 400 || status === 409) {
        steps.cl_participant = { skipped: true, reason: 'already exists' };
      } else {
        steps.cl_participant = { error: e.response?.data || e.message };
      }
    }

    try {
      steps.cl_endpoints = await clRegisterPispEndpoints(pisp_id, callback_url);
    } catch (e) {
      steps.cl_endpoints = { error: e.response?.data || e.message };
    }

    await pool.execute(
      `INSERT INTO pisps (id, pisp_id, name, short_name, callback_url, currency, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [uuidv4(), pisp_id, name, short_name || pisp_id, callback_url, currency, note || null]
    );
    steps.db_save = 'ok';

    res.status(201).json({
      message: 'PISP registered successfully',
      pisp_id,
      steps,
    });

  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'PISP already exists', steps });
    res.status(500).json({ error: err.message, steps });
  }
};

exports.updatePisp = async (req, res) => {
  try {
    const { pispId }   = req.params;
    const { name, short_name, callback_url, status, note } = req.body;

    await pool.execute(
      `UPDATE pisps SET
         name         = COALESCE(?, name),
         short_name   = COALESCE(?, short_name),
         callback_url = COALESCE(?, callback_url),
         status       = COALESCE(?, status),
         note         = COALESCE(?, note),
         updated_at   = NOW()
       WHERE pisp_id = ?`,
      [name, short_name, callback_url, status, note, pispId]
    );

    let endpointUpdate = null;
    if (callback_url) {
      try {
        endpointUpdate = await clRegisterPispEndpoints(pispId, callback_url);
      } catch (e) {
        endpointUpdate = { error: e.message };
      }
    }

    res.json({ message: 'PISP updated', endpointUpdate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


exports.getPispEndpoints = async (req, res) => {
  try {
    const { pispId } = req.params;
    const epRes = await axios.get(
      `${CENTRAL_LEDGER}/participants/${pispId}/endpoints`,
      { headers: clHeaders }
    );
    res.json({ data: epRes.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
};


exports.registerEndpoints = async (req, res) => {
  try {
    const { pispId }      = req.params;
    const { callback_url } = req.body;

    if (!callback_url)
      return res.status(400).json({ error: 'callback_url required' });

    const results = await clRegisterPispEndpoints(pispId, callback_url);

    // Update DB
    await pool.execute(
      `UPDATE pisps SET callback_url = ?, updated_at = NOW() WHERE pisp_id = ?`,
      [callback_url, pispId]
    );

    const failed = results.filter(r => r.status === 'failed');
    res.json({
      message:  failed.length === 0 ? 'All endpoints registered' : `${failed.length} endpoints failed`,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deletePisp = async (req, res) => {
  try {
    const { pispId } = req.params;

    try {
      await axios.put(
        `${CENTRAL_LEDGER}/participants/${pispId}`,
        { isActive: false },
        { headers: clHeaders }
      );
    } catch (_) {}

    await pool.execute(
      `UPDATE pisps SET status = 'INACTIVE', updated_at = NOW() WHERE pisp_id = ?`,
      [pispId]
    );

    res.json({ message: 'PISP deactivated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
