# R Switch - Mojaloop Payment Switch Server

A production-grade **National Payment Switch** built on [Mojaloop](https://mojaloop.io/) open-source infrastructure. R Switch acts as the central hub connecting multiple DFSPs (Digital Financial Service Providers), consuming real-time Kafka events from the Mojaloop core, managing settlement windows, tracking positions, and exposing a full admin portal API for switch operators.

> **Project Context:** R Switch is designed as the interoperability layer for a national payment network (BDT / Bangladesh), coordinating FSPIOP flows between participant banks and mobile money operators.

---

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Environment Setup](#environment-setup)
- [Installation](#installation)
- [Authentication](#authentication)
- [DFSP Management](#dfsp-management)
- [Hub Administration](#hub-administration)
- [Transfer Lifecycle](#transfer-lifecycle)
  - [Kafka Consumer Pipeline](#kafka-consumer-pipeline)
  - [Transfer State Machine](#transfer-state-machine)
  - [Position Tracking](#position-tracking)
- [Settlement](#settlement)
  - [Settlement Window Flow](#settlement-window-flow)
  - [Finalize by Window](#finalize-by-window)
- [Reconciliation](#reconciliation)
- [Notifications Log](#notifications-log)
- [Reports & Excel Export](#reports--excel-export)
- [Dashboard](#dashboard)
- [Activity Logs](#activity-logs)
- [Database Schema Overview](#database-schema-overview)
- [Kafka Topics](#kafka-topics)
- [API Reference](#api-reference)
- [Security](#security)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      R Switch Server                            │
│                                                                 │
│  ┌─────────────────┐   ┌──────────────────┐  ┌─────────────┐   │
│  │   REST API      │   │  Kafka Consumer  │  │  Scheduler  │   │
│  │  (Express.js)   │   │  (KafkaJS)       │  │  (Cron)     │   │
│  └────────┬────────┘   └────────┬─────────┘  └──────┬──────┘   │
│           │                     │                    │          │
│           └─────────────────────▼────────────────────┘          │
│                          MySQL Database                          │
│     transfers · dfsp_positions · reconciliation                  │
│     settlement_windows · notifications_log · activity_logs       │
└───────────────────────────────────────────────────────┬─────────┘
              │                         │               │
              ▼                         ▼               ▼
       Mojaloop Hub             Central Ledger    Settlement
       (FSPIOP API)             (REST Admin)      Service
              │
      ┌───────┴────────┐
      │                │
   DFSP A           DFSP B
 (A Bank)         (B Bank)
```

---

## Tech Stack

| Layer         | Technology                                     |
| ------------- | ---------------------------------------------- |
| Runtime       | Node.js                                        |
| Framework     | Express.js                                     |
| Message Queue | Apache Kafka (KafkaJS)                         |
| Database      | MySQL (mysql2 with connection pool)            |
| Auth          | JWT (OTP-based two-factor login)               |
| Password      | bcryptjs                                       |
| HTTP Client   | Axios                                          |
| Excel Export  | ExcelJS                                        |
| Geo IP        | geoip-lite                                     |
| Protocol      | Mojaloop FSPIOP API + Central Ledger Admin API |

---

## Environment Setup

Create `.env` in the project root:

```dotenv
# ── Server ────────────────────────────────────────────────────
PORT=4000
NODE_ENV=production

# ── MySQL ─────────────────────────────────────────────────────
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_db_password
DB_NAME=r_switch

# ── Kafka ─────────────────────────────────────────────────────
KAFKA_BROKER=your-vm-ip:9092
KAFKA_GROUP_ID=r-switch-db-saver
KAFKA_CLIENT_ID=r-switch-portal

# ── JWT ───────────────────────────────────────────────────────
JWT_SECRET=your_switch_jwt_secret
DFSP_PORTAL_SECRET=your_dfsp_portal_secret
JWT_EXPIRES_IN=365d

# ── Mojaloop Services ─────────────────────────────────────────
CENTRAL_LEDGER_URL=https://your-ledger.domain.com
SETTLEMENT_URL=https://your-settlement.domain.com/version
ALS_URL=https://your-als.domain.com
ALS_ADMIN_URL=https://your-als-admin.domain.com

# ── Email (SMTP) ──────────────────────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=your_smtp_password
SMTP_FROM="R Switch Portal" <noreply@example.com>

# ── Portal ────────────────────────────────────────────────────
DFSP_PORTAL_URL=https://your.dfsp-portal.com
```

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/bangladeshisoftware/nbs-switch-server-mojaloop.git
cd r-switch

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your values

# 4. Initialize database
# mysql -u root -p r_switch < schema.sql

# 5. Start the server (starts API + Kafka consumer together)
npm start

# Development with hot reload
npm run dev
```

The server starts on `PORT` (default `4000`) and automatically connects the Kafka consumer on startup.

---

## Authentication

R Switch uses **OTP-based two-factor authentication** for switch operators. DFSP portals use a separate token flow.

### Switch Operator Login (2-step)

**Step 1 — Submit credentials:**

```
POST /api/auth/login
Body: { username, password }
```

Validates credentials, generates a 6-digit OTP, stores it with a 10-minute expiry, and sends it to the user's registered email. Returns a masked email hint.

```json
{
  "otp_status": true,
  "email_sent": true,
  "email_hint": "ad****@example.com",
  "expires_in": "10 minutes"
}
```

**Step 2 — Verify OTP:**

```
POST /api/auth/verify-otp
Body: { username, otp }
```

Validates OTP against the database (not expired). On success: clears OTP, records login activity (IP + geo-location via `geoip-lite`), returns a signed JWT.

```json
{
  "token": "<jwt>",
  "user": { "id", "username", "email", "role" }
}
```

### DFSP Portal Token

```
POST /api/auth/dfsp-token
Body: { dfsp_id }
```

Issues a long-lived JWT for DFSP portal systems, signed with `DFSP_PORTAL_SECRET`. Stored in `dfsp_users.token` for reference.

### User Management

| Method | Endpoint              | Description                  |
| ------ | --------------------- | ---------------------------- |
| `GET`  | `/api/auth/users`     | List all switch users        |
| `POST` | `/api/auth/users`     | Create switch user           |
| `PUT`  | `/api/auth/users/:id` | Update role or active status |

**Roles:** `ADMIN`, `OPERATOR`, `VIEWER`

---

## DFSP Management

Full lifecycle management of participant DFSPs, including automatic provisioning in the Mojaloop Central Ledger.

### Create DFSP

```
POST /api/dfsps
```

**Body:**

```json
{
  "dfsp_id": "DFSP001",
  "name": "A Bank",
  "short_name": "ABANK",
  "email": "ops@abank.com",
  "callback_url": "https://abank.dfsp.com",
  "currency": "BDT",
  "net_debit_cap": "50000",
  "admin_username": "abank_admin",
  "admin_email": "admin@abank.com",
  "admin_password": "tempPass123"
}
```

**Provisioning steps (automatic, in order):**

| Step             | Action                               | Service                                                          |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `cl_participant` | Register DFSP as participant         | Central Ledger `POST /participants`                              |
| `cl_position`    | Create SETTLEMENT account            | Central Ledger `POST /participants/:id/accounts`                 |
| `cl_endpoints`   | Register all 13 FSPIOP callback URLs | Central Ledger `POST /participants/:id/endpoints`                |
| `cl_ndc`         | Set Net Debit Cap                    | Central Ledger `POST /participants/:id/initialPositionAndLimits` |
| `db_save`        | Save DFSP record locally             | MySQL `dfsps` table                                              |
| `admin_user`     | Create admin user in `dfsp_users`    | MySQL                                                            |
| `welcome_email`  | Send portal credentials email        | SMTP                                                             |

Each step result is returned in the response — failures are non-fatal (already-exists errors are skipped gracefully).

**Registered callback endpoints (per DFSP):**

| Type                                     | URL Pattern                                                       |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `FSPIOP_CALLBACK_URL_TRANSFER_POST`      | `{callback_url}/transfers`                                        |
| `FSPIOP_CALLBACK_URL_TRANSFER_PUT`       | `{callback_url}/transfers/{{transferId}}`                         |
| `FSPIOP_CALLBACK_URL_TRANSFER_ERROR`     | `{callback_url}/transfers/{{transferId}}/error`                   |
| `FSPIOP_CALLBACK_URL_QUOTES`             | `{callback_url}`                                                  |
| `FSPIOP_CALLBACK_URL_BULK_QUOTES`        | `{callback_url}/bulkQuotes`                                       |
| `FSPIOP_CALLBACK_URL_BULK_TRANSFER_POST` | `{callback_url}/bulkTransfers`                                    |
| `FSPIOP_CALLBACK_URL_BULK_TRANSFER_PUT`  | `{callback_url}/bulkTransfers/{{id}}`                             |
| `FSPIOP_CALLBACK_URL_PARTIES_GET`        | `{callback_url}/parties/{{partyIdType}}/{{partyIdentifier}}`      |
| `FSPIOP_CALLBACK_URL_PARTIES_PUT`        | `{callback_url}/parties/{{partyIdType}}/{{partyIdentifier}}`      |
| `FSPIOP_CALLBACK_URL_PARTICIPANT_PUT`    | `{callback_url}/participants/{{partyIdType}}/{{partyIdentifier}}` |
| ... and more                             |                                                                   |

### Other DFSP Endpoints

| Method | Endpoint                       | Description                                                    |
| ------ | ------------------------------ | -------------------------------------------------------------- |
| `GET`  | `/api/dfsps`                   | List all DFSPs                                                 |
| `GET`  | `/api/dfsps/mini`              | Dropdown data (value/label pairs)                              |
| `GET`  | `/api/dfsps/:dfspId`           | DFSP detail with live CL endpoints, limits, and transfer stats |
| `PUT`  | `/api/dfsps/:dfspId`           | Update DFSP info + re-register endpoints                       |
| `GET`  | `/api/dfsps/:dfspId/endpoints` | Live endpoints from Central Ledger                             |
| `POST` | `/api/dfsps/:dfspId/endpoints` | Re-register all callback endpoints                             |
| `GET`  | `/api/dfsps/:dfspId/accounts`  | Live accounts from Central Ledger                              |

---

## Hub Administration

Manage the Mojaloop Hub participant accounts, settlement models, and ALS oracles.

### Hub Accounts

| Method | Endpoint            | Description                               |
| ------ | ------------------- | ----------------------------------------- |
| `GET`  | `/api/hub/accounts` | List Hub accounts from Central Ledger     |
| `POST` | `/api/hub/accounts` | Create Hub account (`{ currency, type }`) |

### Settlement Models

| Method | Endpoint                     | Description                                  |
| ------ | ---------------------------- | -------------------------------------------- |
| `GET`  | `/api/hub/settlement-models` | List settlement models                       |
| `POST` | `/api/hub/settlement-models` | Create settlement model (e.g. `DEFERREDNET`) |

### ALS Oracles

| Method   | Endpoint               | Description                 |
| -------- | ---------------------- | --------------------------- |
| `GET`    | `/api/hub/oracles`     | List oracles from ALS Admin |
| `POST`   | `/api/hub/oracles`     | Register new oracle         |
| `DELETE` | `/api/hub/oracles/:id` | Remove oracle               |

---

## Transfer Lifecycle

### Kafka Consumer Pipeline

R Switch subscribes to **8 Mojaloop Kafka topics** and processes each message transactionally in MySQL. The consumer starts automatically with the server.

```
Mojaloop Core → Kafka Topics → R Switch Consumer → MySQL
```

**Subscribed topics:**

| Topic                            | Handler                 | Description                          |
| -------------------------------- | ----------------------- | ------------------------------------ |
| `topic-transfer-prepare`         | `handlePrepare`         | New transfer initiated by payer DFSP |
| `topic-transfer-position`        | `handlePosition`        | Hub reserved funds in payer position |
| `topic-transfer-fulfil`          | `handleFulfil`          | Payee DFSP confirmed transfer        |
| `topic-transfer-reject`          | `handleReject`          | Transfer rejected/aborted            |
| `topic-timeout-consumer`         | `handleTimeout`         | Transfer expired before fulfil       |
| `topic-notification-event`       | `handleNotification`    | Hub notified DFSPs of outcome        |
| `topic-deferredsettlement-close` | `handleSettlementClose` | Settlement window closed             |
| `topic-admin-transfer`           | `handleAdminTransfer`   | Hub admin operations                 |

All handlers use **database transactions** (`BEGIN` / `COMMIT` / `ROLLBACK`) to ensure atomicity. Payload decoding handles both raw JSON and base64-encoded Mojaloop message formats.

---

### Transfer State Machine

Each Kafka event drives a transfer through the following state progression:

```
[NEW]
  │
  ▼  topic-transfer-prepare
RECEIVED          ← Transfer request arrived, ILP data stored
  │
  ▼  topic-transfer-position
RESERVED          ← Payer's funds reserved, position updated
  │
  ├──▶ TIMEOUT    ← topic-timeout-consumer (position rolled back)
  │
  ├──▶ FAILED     ← topic-transfer-reject  (position rolled back)
  │
  ▼  topic-transfer-fulfil
COMMITTED         ← Fulfilment accepted, position committed,
                     reconciliation records created
```

**State transition details:**

| Transition    | Handler          | Position Effect                                           | Recon Created        |
| ------------- | ---------------- | --------------------------------------------------------- | -------------------- |
| → `RECEIVED`  | `handlePrepare`  | None                                                      | No                   |
| → `RESERVED`  | `handlePosition` | `reserved_amount += amount`                               | No                   |
| → `COMMITTED` | `handleFulfil`   | `current_position += amount`, `reserved_amount -= amount` | Yes (SEND + RECEIVE) |
| → `FAILED`    | `handleReject`   | `reserved_amount -= amount` (rollback)                    | No                   |
| → `TIMEOUT`   | `handleTimeout`  | `reserved_amount -= amount` (rollback)                    | No                   |

---

### Position Tracking

Every position change is written to `position_changes` with `RESERVE`, `COMMIT`, or `ROLLBACK` type for full audit trail.

**Live position endpoint** (proxies directly to Central Ledger):

```
GET /api/positions/live/:dfspId
```

Returns:

```json
{
  "dfspId": "DFSP001",
  "position": 12500.0,
  "ndc": 50000.0,
  "settlement": 48000.0,
  "available": 37500.0,
  "usedPct": "25.00",
  "status": "HEALTHY"
}
```

Status thresholds: `HEALTHY` (>30% NDC available) → `LOW` (>0%) → `CRITICAL` (≤0%)

**Other position endpoints:**

| Method | Endpoint                      | Description                               |
| ------ | ----------------------------- | ----------------------------------------- |
| `GET`  | `/api/positions`              | All DFSP positions with available balance |
| `GET`  | `/api/positions/changes`      | Position change audit log                 |
| `GET`  | `/api/positions/limits`       | NDC limits per DFSP                       |
| `POST` | `/api/positions/limits`       | Set initial NDC (POST to CL + DB)         |
| `PUT`  | `/api/positions/limits`       | Update NDC (PUT to CL + DB transaction)   |
| `GET`  | `/api/positions/participants` | Active participants from Central Ledger   |
| `POST` | `/api/positions/deposit`      | Deposit funds to SETTLEMENT account       |
| `GET`  | `/api/positions/deposits`     | Deposit history with pagination           |

**Deposit funds:**

```
POST /api/positions/deposit
Body: { dfsp_id, account_id, currency, amount, reason }
```

Validates that the target account is `SETTLEMENT` (not `POSITION`) before calling Central Ledger `recordFundsIn`.

---

## Settlement

R Switch implements **Deferred Net Settlement (DNS)** using the Mojaloop Settlement Service.

### Settlement Window Flow

```
OPEN → CLOSED → SETTLED
```

| Endpoint                                       | Description                                    |
| ---------------------------------------------- | ---------------------------------------------- |
| `GET /api/settlement/windows`                  | List windows (live from service + DB fallback) |
| `GET /api/settlement/windows/open`             | Open windows only                              |
| `POST /api/settlement/windows/open`            | Open a new settlement window                   |
| `POST /api/settlement/windows/:windowId/close` | Close a specific window                        |
| `GET /api/settlement/positions`                | Net positions per DFSP for a date              |

### Complete Settlement

```
POST /api/settlement/complete
Body: { reason, window_id? }
```

Executes the full **6-step settlement pipeline** against the Mojaloop Settlement Service:

| Step | API Call                                          | State                     |
| ---- | ------------------------------------------------- | ------------------------- |
| 1    | `POST /settlementWindows/:id` `{ state: CLOSED }` | Window closed             |
| 2    | `POST /settlements` with `DEFERREDNET` model      | Settlement object created |
| 3    | `PUT /settlements/:id`                            | `PS_TRANSFERS_RECORDED`   |
| 4    | `PUT /settlements/:id`                            | `PS_TRANSFERS_RESERVED`   |
| 5    | `PUT /settlements/:id`                            | `PS_TRANSFERS_COMMITTED`  |
| 6    | `PUT /settlements/:id`                            | `SETTLED`                 |

After `SETTLED`:

- Saves per-DFSP `settlement_completed_records` with before/after positions
- Marks reconciliation records as `MATCHED`
- Resets all `dfsp_positions.current_position` to `0`
- Updates `settlement_windows` status to `SETTLED`

Each step result is returned in the response for full auditability. Graceful error handling — if step 2 has no transfers, a clear `3100` error message is returned.

### Finalize by Window

```
POST /api/settlement/finalize/:windowId
Body: { reason }
```

Performs **physical fund movements** for each active DFSP based on their net position:

- **Positive position** (net receiver) → `recordFundsIn` to SETTLEMENT account (credit)
- **Negative position** (net sender) → `recordFundsOutPrepareReserve` then `recordFundsOutCommit` (2-step debit)
- **Zero position** → skipped
- If commit fails → automatic `recordFundsOutAbort` to reverse the reserve

All movements are saved to `settlement_finalize_records` with `before_amount` and `after_amount` fetched live from Central Ledger.

**Settlement record endpoints:**

| Method | Endpoint                            | Description                               |
| ------ | ----------------------------------- | ----------------------------------------- |
| `GET`  | `/api/settlement/finalize-records`  | Finalize records with filters and summary |
| `GET`  | `/api/settlement/completed-records` | Completed settlement records              |

---

## Reconciliation

Automatic dual-entry reconciliation: every `COMMITTED` transfer generates two reconciliation rows — one `SEND` for the payer FSP and one `RECEIVE` for the payee FSP.

Auto-matching runs after `runReconciliation`: transfers with both SEND and RECEIVE rows in `PENDING` are promoted to `MATCHED` in a single SQL `JOIN UPDATE`.

| Method | Endpoint                     | Description                                              |
| ------ | ---------------------------- | -------------------------------------------------------- |
| `GET`  | `/api/reconciliation`        | List with filters: `dfsp_id`, `recon_status`, date range |
| `POST` | `/api/reconciliation/run`    | Run reconciliation for a settlement date                 |
| `GET`  | `/api/reconciliation/report` | Net position report per DFSP grouped by currency         |

**Reconciliation statuses:** `PENDING` → `MATCHED` / `UNMATCHED` / `DISPUTED`

**`GET /api/reconciliation` response includes summary:**

```json
{
  "summary": { "matched": 120, "unmatched": 3, "pending": 5, "disputed": 0 },
  "data": [...]
}
```

---

## Notifications Log

R Switch records every Mojaloop notification event consumed from Kafka (`topic-notification-event`) into `notifications_log`, tracking which DFSP received which outcome.

| Method | Endpoint                                  | Description                                                                            |
| ------ | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET`  | `/api/notifications`                      | List with filters: `to_fsp`, `from_fsp`, `transfer_state`, `event_type`, `transfer_id` |
| `GET`  | `/api/notifications/:id`                  | Single notification detail                                                             |
| `GET`  | `/api/notifications/transfer/:transferId` | All notifications for a transfer (ordered ASC)                                         |
| `GET`  | `/api/notifications/stats`                | Summary counts + per-FSP breakdown + 10 most recent                                    |

---

## Reports & Excel Export

### JSON Report

```
GET /api/reports
```

Supports flexible filtering:

| Param         | Values                            | Description          |
| ------------- | --------------------------------- | -------------------- |
| `date_preset` | `today`, `yesterday`, `this_week` | Quick date shortcuts |
| `from` / `to` | `YYYY-MM-DD`                      | Custom date range    |
| `dfsp`        | FSP ID                            | Filter by DFSP       |
| `direction`   | `SEND`, `RECEIVE`                 | Combined with `dfsp` |
| `status`      | `COMMITTED`, `FAILED`, etc.       | Filter by status     |

Returns up to 5,000 transfers with a full summary block (total, committed, failed, reserved, prepared, timeout, total volume, currency count).

### Excel Export

```
GET /api/reports/export
```

Same filters as JSON report. Generates a styled `.xlsx` workbook with:

- **Summary sheet** — dark-themed stats table with success/failure rates, total volume, average processing time
- **Transactions sheet** — up to 50,000 rows with frozen header, auto-filter, status-colored rows (`COMMITTED` = green, `FAILED` = red, `RESERVED` = yellow), total formula row
- Named `r-switch-report-YYYY-MM-DD.xlsx`

---

## Dashboard

```
GET /api/dashboard/summary
Query params: from, to, currency
```

Returns a comprehensive switch-wide overview:

| Field      | Description                                                                       |
| ---------- | --------------------------------------------------------------------------------- |
| `summary`  | Total, committed, failed, timeout, received, reserved, cancelled + success rate % |
| `volumes`  | Total committed volume grouped by currency                                        |
| `hourly`   | Last 24 hours: total / success / failed per hour                                  |
| `topDfsps` | Top 5 DFSPs by committed transfer volume                                          |

---

## Activity Logs

Every successful login (switch operator or DFSP portal) is recorded with IP address and geo-location.

| Method | Endpoint              | Description                                                               |
| ------ | --------------------- | ------------------------------------------------------------------------- |
| `GET`  | `/api/activity`       | Paginated logs with filters: `type`, `username`, `ip_address`, date range |
| `GET`  | `/api/activity/stats` | Summary stats + last 7 days daily chart + top 10 users                    |

**Log fields:** `username`, `email`, `login_time`, `ip_address`, `location` (City, Country via geoip), `type` (`switch` or `dfsp`)

---

## Database Schema Overview

| Table                          | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `users`                        | Switch portal operators                                    |
| `dfsp_users`                   | DFSP portal admin accounts                                 |
| `dfsps`                        | Registered participant FSPs                                |
| `transfers`                    | Full transfer records (from Kafka)                         |
| `transfer_state_log`           | State transition history per transfer                      |
| `dfsp_positions`               | Current position and NDC per DFSP                          |
| `dfsp_limits`                  | NDC limit change history                                   |
| `position_changes`             | Per-transfer position deltas (RESERVE / COMMIT / ROLLBACK) |
| `dfsp_deposits`                | Settlement account deposit records                         |
| `reconciliation`               | Dual-entry recon records (SEND + RECEIVE)                  |
| `notifications_log`            | Kafka notification events per transfer                     |
| `settlement_windows`           | Settlement window lifecycle                                |
| `settlement_completed_records` | Per-DFSP position snapshots after settlement               |
| `settlement_finalize_records`  | Physical fund movement logs (credit/debit actions)         |
| `activity_logs`                | Login audit trail                                          |

---

## Kafka Topics

```javascript
const TOPICS = {
  TRANSFER_PREPARE: 'topic-transfer-prepare',
  TRANSFER_POSITION: 'topic-transfer-position',
  TRANSFER_FULFIL: 'topic-transfer-fulfil',
  TRANSFER_REJECT: 'topic-transfer-reject',
  TRANSFER_GET: 'topic-transfer-get',
  TIMEOUT: 'topic-timeout-consumer',
  NOTIFICATION: 'topic-notification-event',
  SETTLEMENT_CLOSE: 'topic-deferredsettlement-close',
  ADMIN_TRANSFER: 'topic-admin-transfer',
};
```

Consumer config: `groupId: r-switch-db-saver`, `sessionTimeout: 30s`, `heartbeatInterval: 3s`, retry with 10 attempts.

Payload decoding handles both raw JSON and `base64,<data>` encoded Mojaloop message formats automatically.

---

## API Reference

### Auth

| Method | Endpoint               | Auth | Description                             |
| ------ | ---------------------- | ---- | --------------------------------------- |
| `POST` | `/api/auth/login`      | —    | Step 1: Submit credentials, receive OTP |
| `POST` | `/api/auth/verify-otp` | —    | Step 2: Verify OTP, receive JWT         |
| `POST` | `/api/auth/dfsp-token` | —    | Issue DFSP portal token                 |
| `GET`  | `/api/auth/users`      | JWT  | List switch users                       |
| `POST` | `/api/auth/users`      | JWT  | Create switch user                      |
| `PUT`  | `/api/auth/users/:id`  | JWT  | Update user role/status                 |

### DFSPs

| Method | Endpoint                       | Description             |
| ------ | ------------------------------ | ----------------------- |
| `GET`  | `/api/dfsps`                   | All DFSPs               |
| `GET`  | `/api/dfsps/mini`              | Dropdown data           |
| `POST` | `/api/dfsps`                   | Create + provision DFSP |
| `GET`  | `/api/dfsps/:dfspId`           | DFSP detail             |
| `PUT`  | `/api/dfsps/:dfspId`           | Update DFSP             |
| `GET`  | `/api/dfsps/:dfspId/endpoints` | CL endpoints            |
| `POST` | `/api/dfsps/:dfspId/endpoints` | Re-register endpoints   |
| `GET`  | `/api/dfsps/:dfspId/accounts`  | CL accounts             |

### Transfers

| Method | Endpoint                     | Description                    |
| ------ | ---------------------------- | ------------------------------ |
| `GET`  | `/api/transfers`             | List with filters + pagination |
| `GET`  | `/api/transfers/:transferId` | Detail + full state history    |
| `GET`  | `/api/transfers/stats`       | Aggregated stats               |

### Positions & Limits

| Method | Endpoint                      | Description                   |
| ------ | ----------------------------- | ----------------------------- |
| `GET`  | `/api/positions`              | All DFSP positions            |
| `GET`  | `/api/positions/live/:dfspId` | Live position from CL         |
| `GET`  | `/api/positions/changes`      | Position change log           |
| `GET`  | `/api/positions/limits`       | NDC limits                    |
| `POST` | `/api/positions/limits`       | Set NDC                       |
| `PUT`  | `/api/positions/limits`       | Update NDC                    |
| `POST` | `/api/positions/deposit`      | Deposit to settlement account |
| `GET`  | `/api/positions/deposits`     | Deposit history               |
| `GET`  | `/api/positions/participants` | Active CL participants        |

### Settlement

| Method | Endpoint                                  | Description                  |
| ------ | ----------------------------------------- | ---------------------------- |
| `GET`  | `/api/settlement/windows`                 | List windows                 |
| `GET`  | `/api/settlement/windows/open`            | Open windows                 |
| `POST` | `/api/settlement/windows/open`            | Open window                  |
| `POST` | `/api/settlement/windows/:windowId/close` | Close window                 |
| `POST` | `/api/settlement/complete`                | Run full 6-step settlement   |
| `POST` | `/api/settlement/finalize/:windowId`      | Physical fund movements      |
| `GET`  | `/api/settlement/positions`               | Net positions by date        |
| `GET`  | `/api/settlement/finalize-records`        | Finalize movement records    |
| `GET`  | `/api/settlement/completed-records`       | Completed settlement records |

### Reconciliation

| Method | Endpoint                     | Description               |
| ------ | ---------------------------- | ------------------------- |
| `GET`  | `/api/reconciliation`        | List recon records        |
| `POST` | `/api/reconciliation/run`    | Run for a settlement date |
| `GET`  | `/api/reconciliation/report` | Net position report       |

### Hub

| Method   | Endpoint                     | Description             |
| -------- | ---------------------------- | ----------------------- |
| `GET`    | `/api/hub/accounts`          | Hub accounts            |
| `POST`   | `/api/hub/accounts`          | Create Hub account      |
| `GET`    | `/api/hub/settlement-models` | Settlement models       |
| `POST`   | `/api/hub/settlement-models` | Create settlement model |
| `GET`    | `/api/hub/oracles`           | ALS oracles             |
| `POST`   | `/api/hub/oracles`           | Create oracle           |
| `DELETE` | `/api/hub/oracles/:id`       | Delete oracle           |

### Notifications

| Method | Endpoint                                  | Description         |
| ------ | ----------------------------------------- | ------------------- |
| `GET`  | `/api/notifications`                      | List notifications  |
| `GET`  | `/api/notifications/:id`                  | Single notification |
| `GET`  | `/api/notifications/transfer/:transferId` | By transfer ID      |
| `GET`  | `/api/notifications/stats`                | Summary stats       |

### Reports

| Method | Endpoint              | Description            |
| ------ | --------------------- | ---------------------- |
| `GET`  | `/api/reports`        | JSON report data       |
| `GET`  | `/api/reports/export` | Excel `.xlsx` download |

### Dashboard & Activity

| Method | Endpoint                 | Description                  |
| ------ | ------------------------ | ---------------------------- |
| `GET`  | `/api/dashboard/summary` | Switch-wide summary          |
| `GET`  | `/api/activity`          | Login activity logs          |
| `GET`  | `/api/activity/stats`    | Activity stats + daily chart |

---

## Security

- **OTP login** — switch operators must verify a time-limited email OTP before receiving a JWT; no direct credential-to-token flow
- **Dual JWT secrets** — switch portal (`JWT_SECRET`) and DFSP portals (`DFSP_PORTAL_SECRET`) use separate signing keys
- **bcryptjs** — all passwords hashed with salt rounds of 10
- **Parameterized queries** — all MySQL queries use `?` placeholders, no string interpolation
- **IP + geo logging** — every login records IP address and physical location for audit
- **Non-fatal CL failures** — Central Ledger step failures on DFSP creation return detailed step results without masking errors

---

## License

Private - R Switch / Bangladeshi Software LTD. All rights reserved.
