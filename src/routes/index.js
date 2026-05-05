const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');

const authCtrl = require('../controllers/auth.controller');
const dashCtrl = require('../controllers/dashboard.controller');
const txCtrl = require('../controllers/transfer.controller');
const reconCtrl = require('../controllers/reconciliation.controller');
const dfspCtrl = require('../controllers/dfsp.controller');
const settlCtrl = require('../controllers/settlement.controller');
const notifCtrl = require('../controllers/notification.controller');
const posCtrl = require('../controllers/position.controller');
const reportCtrl = require('../controllers/reports.controller');
const activityCtrl = require('../controllers/activity.controller');
const pispCtrl = require('../controllers/pisp.controller');
const hubCtrl = require('../controllers/hub.controller');

//  AUTH (public)
router.post('/auth/login', authCtrl.login);
router.post('/auth/verify-otp', authCtrl.verify_otp);
router.post('/auth/login-dfsp', authCtrl.getDFSPToken);

// AUTH (protected)
router.get('/auth/users', auth, authCtrl.getUsers);
router.post('/auth/users', auth, authCtrl.createUser);
router.put('/auth/users/:id', auth, authCtrl.updateUser);

// Hub

// HUB CONFIGURATION
router.get ('/hub/accounts',           auth, hubCtrl.getHubAccounts);
router.post('/hub/accounts',           auth, hubCtrl.createHubAccount);
router.get ('/hub/settlement-models',  auth, hubCtrl.getSettlementModels);
router.post('/hub/settlement-models',  auth, hubCtrl.createSettlementModel);
router.get ('/hub/oracles',            auth, hubCtrl.getOracles);
router.post('/hub/oracles',            auth, hubCtrl.createOracle);
router.delete('/hub/oracles/:id',      auth, hubCtrl.deleteOracle);

// DASHBOARD
router.get('/dashboard/summary', auth, dashCtrl.getSummary);

// TRANSFERS
router.get('/transfers', auth, txCtrl.getTransfers);
router.get('/transfers/stats', auth, txCtrl.getStats);
router.get('/transfers/:transferId', auth, txCtrl.getTransferById);

// RECONCILIATION
router.get('/reconciliation', auth, reconCtrl.getReconciliation);
router.post('/reconciliation/run', auth, reconCtrl.runReconciliation);
router.get('/reconciliation/report', auth, reconCtrl.getReport);

// NOTIFICATION
router.get('/notifications/stats', auth, notifCtrl.getStats);
router.get(
  '/notifications/transfer/:transferId',
  auth,
  notifCtrl.getByTransferId,
);
router.get('/notifications/:id', auth, notifCtrl.getNotificationById);
router.get('/notifications', auth, notifCtrl.getNotifications);

// DFSP MANAGEMENT
router.get('/dfsps', auth, dfspCtrl.getDfsps);
router.get('/dfsps-mini', auth, dfspCtrl.getMiniDfspsData);

router.post('/dfsps', auth, dfspCtrl.createDfsp);
router.get('/dfsps/:dfspId', auth, dfspCtrl.getDfspById);
router.put('/dfsps/:dfspId', auth, dfspCtrl.updateDfsp);
router.get('/dfsps/:dfspId/endpoints', auth, dfspCtrl.getDfspEndpoints);
router.post('/dfsps/:dfspId/endpoints', auth, dfspCtrl.registerEndpoints);

// PISP MANAGEMENT
router.get ('/pisps',                               auth, pispCtrl.getPisps);
router.post('/pisps',                               auth, pispCtrl.createPisp);
router.get ('/pisps/:pispId',                       auth, pispCtrl.getPispById);
router.put ('/pisps/:pispId',                       auth, pispCtrl.updatePisp);
router.delete('/pisps/:pispId',                     auth, pispCtrl.deletePisp);
router.get ('/pisps/:pispId/endpoints',             auth, pispCtrl.getPispEndpoints);
router.post('/pisps/:pispId/endpoints',             auth, pispCtrl.registerEndpoints);


// SETTLEMENT
router.get('/settlement/windows', auth, settlCtrl.getWindows);
router.get('/settlement/windows/open', auth, settlCtrl.getOpenWindows);
router.get('/settlement/positions', auth, settlCtrl.getPositions);
router.get('/settlement/deposits-records', auth, settlCtrl.getDepositsRecords);
router.post('/settlement/windows', auth, settlCtrl.openWindow);
router.put('/settlement/windows/:windowId/close', auth, settlCtrl.closeWindow);
router.post('/settlement/complete', auth, settlCtrl.completeSettlement);
router.get('/settlement/finalize-records',  auth, settlCtrl.getFinalizeRecords);
router.get('/settlement/completed-records', auth, settlCtrl.getCompletedRecords);
router.post('/settlement/:windowId/finalize', auth, settlCtrl.finalizeByWindow);


// DFSP POSITIONS (Liquidity)
router.get('/positions', auth, posCtrl.getPositions);
router.get('/positions/changes', auth, posCtrl.getPositionChanges);
router.get('/positions/limits', auth, posCtrl.getLimits);
router.post('/positions/limits', auth, posCtrl.setLimit);
router.put('/positions/update-limits', auth, posCtrl.updateLimit);
router.get('/positions/participants',  auth, posCtrl.getParticipants);
router.get('/positions/:dfspId/live', auth, posCtrl.getLivePosition);
router.post('/positions/deposit', auth, posCtrl.depositFunds);
router.get('/positions/:dfspId/accounts', auth, posCtrl.getDfspAccounts);

// ACTIVITY LOGS
router.get('/activity-logs',                        auth, activityCtrl.getLogs);
router.get('/activity-logs/stats',                  auth, activityCtrl.getStats);

// REPORTS
router.get('/reports/data', auth, reportCtrl.getReportData);
router.get('/reports/export', auth, reportCtrl.exportExcel);



module.exports = router;
