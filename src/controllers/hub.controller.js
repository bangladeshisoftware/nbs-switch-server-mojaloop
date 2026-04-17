
const axios = require('axios');

const CENTRAL_LEDGER  = process.env.CENTRAL_LEDGER_URL  || 'http://ledger.mojaloop.xyz';
const ALS_ADMIN       = process.env.ALS_ADMIN_URL        || 'http://als-admin.mojaloop.xyz';

const clHeaders  = { 'Content-Type': 'application/json', 'fspiop-source': 'switch' };
const alsHeaders = {
  'Content-Type': 'application/vnd.interoperability.participants+json;version=1.0',
  'Accept':       'application/vnd.interoperability.participants+json;version=1',
  'Date':         new Date().toUTCString(),
};

// ================================================================
//  HUB ACCOUNTS
// ================================================================

// GET /hub/accounts
exports.getHubAccounts = async (req, res) => {
  try {
    const response = await axios.get(
      `${CENTRAL_LEDGER}/participants/Hub/accounts`,
      { headers: clHeaders }
    );
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// POST /hub/accounts
exports.createHubAccount = async (req, res) => {
  try {
    const { currency, type } = req.body;
    if (!currency || !type)
      return res.status(400).json({ error: 'currency and type required' });

    const response = await axios.post(
      `${CENTRAL_LEDGER}/participants/Hub/accounts`,
      { currency, type },
      { headers: clHeaders }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// ================================================================
//  SETTLEMENT MODELS
// ================================================================

// GET /hub/settlement-models
exports.getSettlementModels = async (req, res) => {
  try {
    const response = await axios.get(
      `${CENTRAL_LEDGER}/settlementModels`,
      { headers: clHeaders }
    );
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// POST /hub/settlement-models
exports.createSettlementModel = async (req, res) => {
  try {
    const response = await axios.post(
      `${CENTRAL_LEDGER}/settlementModels`,
      req.body,
      { headers: clHeaders }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// ================================================================
//  ORACLES
// ================================================================

// GET /hub/oracles
exports.getOracles = async (req, res) => {
  try {
    const response = await axios.get(
      `${ALS_ADMIN}/oracles`,
      { headers: alsHeaders }
    );
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// POST /hub/oracles
exports.createOracle = async (req, res) => {
  try {
    const response = await axios.post(
      `${ALS_ADMIN}/oracles`,
      req.body,
      { headers: alsHeaders }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// DELETE /hub/oracles/:id
exports.deleteOracle = async (req, res) => {
  try {
    const response = await axios.delete(
      `${ALS_ADMIN}/oracles/${req.params.id}`,
      { headers: alsHeaders }
    );
    res.status(response.status).json(response.data || { message: 'Oracle deleted' });
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};
