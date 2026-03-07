-- R Switch Portal Database Schema
CREATE DATABASE IF NOT EXISTS rswitch;
USE rswitch;

-- ─── DFSPS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dfsps (
  id            CHAR(36)      PRIMARY KEY,
  dfsp_id       VARCHAR(100)  NOT NULL UNIQUE,
  name          VARCHAR(200)  NOT NULL,
  short_name    VARCHAR(50),
  endpoint_url  VARCHAR(500),
  callback_url  VARCHAR(500),
  status        ENUM('ACTIVE','INACTIVE','SUSPENDED') DEFAULT 'ACTIVE',
  currency      CHAR(3),
  created_at    DATETIME      DEFAULT NOW(),
  updated_at    DATETIME      DEFAULT NOW() ON UPDATE NOW()
);

-- ─── TRANSFERS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfers (
  id              CHAR(36)      PRIMARY KEY,
  transfer_id     VARCHAR(36)   NOT NULL UNIQUE,
  transaction_id  VARCHAR(36),
  quote_id        VARCHAR(36),
  payer_fsp       VARCHAR(100),
  payee_fsp       VARCHAR(100),
  amount          DECIMAL(18,4),
  currency        CHAR(3),
  status          ENUM(
                    'RECEIVED',
                    'RESERVED',
                    'COMMITTED',
                    'FAILED',
                    'TIMEOUT',
                    'ABORTED',
                    'CANCELLED'
                  ) DEFAULT 'RECEIVED',
  error_code      VARCHAR(10),
  error_message   TEXT,
  ilp_packet      TEXT,
  condition_value VARCHAR(256),
  fulfilment      VARCHAR(256),
  expiration      DATETIME,
  completed_at    DATETIME,
  created_at      DATETIME      DEFAULT NOW(),
  updated_at      DATETIME      DEFAULT NOW() ON UPDATE NOW(),
  INDEX idx_payer_fsp  (payer_fsp),
  INDEX idx_payee_fsp  (payee_fsp),
  INDEX idx_status     (status),
  INDEX idx_created_at (created_at),
  INDEX idx_currency   (currency)
);

-- ─── TRANSFER STATE LOG (audit trail) ────────────────────────
CREATE TABLE IF NOT EXISTS transfer_state_log (
  id              CHAR(36)     PRIMARY KEY,
  transfer_id     VARCHAR(36)  NOT NULL,
  previous_status VARCHAR(20),
  new_status      VARCHAR(20),
  event_type      VARCHAR(50),
  direction       ENUM('INBOUND','OUTBOUND','INTERNAL') DEFAULT 'INBOUND',
  from_dfsp       VARCHAR(100),
  to_dfsp         VARCHAR(100),
  raw_payload     JSON,
  created_at      DATETIME     DEFAULT NOW(),
  INDEX idx_transfer_id (transfer_id),
  INDEX idx_created_at  (created_at)
);

-- ─── RECONCILIATION ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation (
  id               CHAR(36)     PRIMARY KEY,
  settlement_id    VARCHAR(36),
  window_id        VARCHAR(36),
  dfsp_id          VARCHAR(100),
  transfer_id      VARCHAR(36),
  transfer_type    ENUM('SEND','RECEIVE'),
  amount           DECIMAL(18,4),
  currency         CHAR(3),
  net_position     DECIMAL(18,4),
  recon_status     ENUM('PENDING','MATCHED','UNMATCHED','DISPUTED') DEFAULT 'PENDING',
  settlement_date  DATE,
  created_at       DATETIME     DEFAULT NOW(),
  updated_at       DATETIME     DEFAULT NOW() ON UPDATE NOW(),
  INDEX idx_dfsp_id       (dfsp_id),
  INDEX idx_recon_status  (recon_status),
  INDEX idx_settlement_id (settlement_id)
);

-- ─── SETTLEMENT WINDOWS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlement_windows (
  id          CHAR(36)    PRIMARY KEY,
  window_id   VARCHAR(36) NOT NULL UNIQUE,
  status      ENUM('OPEN','CLOSED','PENDING_SETTLEMENT','SETTLED','ABORTED') DEFAULT 'OPEN',
  opened_at   DATETIME,
  closed_at   DATETIME,
  settled_at  DATETIME,
  created_at  DATETIME    DEFAULT NOW(),
  updated_at  DATETIME    DEFAULT NOW() ON UPDATE NOW()
);

-- ─── USERS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           CHAR(36)     PRIMARY KEY,
  username     VARCHAR(100) NOT NULL UNIQUE,
  email        VARCHAR(200) NOT NULL UNIQUE,
  password     VARCHAR(256) NOT NULL,
  role         ENUM('ADMIN','OPERATOR','VIEWER') DEFAULT 'VIEWER',
  is_active    TINYINT(1)   DEFAULT 1,
  last_login   DATETIME,
  created_at   DATETIME     DEFAULT NOW(),
  updated_at   DATETIME     DEFAULT NOW() ON UPDATE NOW()
);

-- Default admin user (password: Admin@123 - change immediately)
INSERT IGNORE INTO users (id, username, email, password, role)
VALUES (
  UUID(),
  'admin',
  'admin@mojaloop.xyz',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'ADMIN'
);
