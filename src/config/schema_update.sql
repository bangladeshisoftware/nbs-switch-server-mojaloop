-- R Switch Portal — Complete Database Schema (Updated)
-- Run this to add new tables to existing database

USE rswitch;

-- ─── DFSP POSITIONS (Liquidity) ──────────────────────────────
CREATE TABLE IF NOT EXISTS dfsp_positions (
  id               CHAR(36)      PRIMARY KEY,
  dfsp_id          VARCHAR(100)  NOT NULL,
  currency         CHAR(3)       NOT NULL,
  current_position DECIMAL(18,4) DEFAULT 0,
  net_debit_cap    DECIMAL(18,4) DEFAULT 0,
  reserved_amount  DECIMAL(18,4) DEFAULT 0,
  updated_at       DATETIME      DEFAULT NOW() ON UPDATE NOW(),
  UNIQUE KEY uq_dfsp_currency (dfsp_id, currency),
  INDEX idx_dfsp_id (dfsp_id)
);

-- ─── DFSP LIMITS LOG ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dfsp_limits (
  id          CHAR(36)     PRIMARY KEY,
  dfsp_id     VARCHAR(100) NOT NULL,
  limit_type  ENUM('NET_DEBIT_CAP','DEPOSIT') DEFAULT 'NET_DEBIT_CAP',
  currency    CHAR(3),
  value       DECIMAL(18,4),
  previous_value DECIMAL(18,4),
  changed_by  VARCHAR(100),
  created_at  DATETIME     DEFAULT NOW(),
  INDEX idx_dfsp_id (dfsp_id)
);

-- ─── NOTIFICATIONS LOG ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications_log (
  id          CHAR(36)     PRIMARY KEY,
  transfer_id VARCHAR(36),
  to_fsp      VARCHAR(100),
  from_fsp    VARCHAR(100),
  event_type  VARCHAR(50),
  transfer_state VARCHAR(30),
  payload     JSON,
  created_at  DATETIME     DEFAULT NOW(),
  INDEX idx_transfer_id (transfer_id),
  INDEX idx_to_fsp      (to_fsp),
  INDEX idx_created_at  (created_at)
);

-- ─── SETTLEMENT WINDOWS (updated) ───────────────────────────
-- Already exists, just making sure
CREATE TABLE IF NOT EXISTS settlement_windows (
  id          CHAR(36)    PRIMARY KEY,
  window_id   VARCHAR(36) NOT NULL UNIQUE,
  status      ENUM('OPEN','CLOSED','PENDING_SETTLEMENT','SETTLED','ABORTED') DEFAULT 'OPEN',
  opened_at   DATETIME,
  closed_at   DATETIME,
  settled_at  DATETIME,
  reason      TEXT,
  created_at  DATETIME    DEFAULT NOW(),
  updated_at  DATETIME    DEFAULT NOW() ON UPDATE NOW()
);

-- ─── POSITION CHANGES LOG ────────────────────────────────────
CREATE TABLE IF NOT EXISTS position_changes (
  id               CHAR(36)      PRIMARY KEY,
  transfer_id      VARCHAR(36),
  dfsp_id          VARCHAR(100),
  currency         CHAR(3),
  change_type      ENUM('RESERVE','COMMIT','ROLLBACK','DEPOSIT','SETTLEMENT'),
  amount           DECIMAL(18,4),
  position_before  DECIMAL(18,4),
  position_after   DECIMAL(18,4),
  created_at       DATETIME      DEFAULT NOW(),
  INDEX idx_transfer_id (transfer_id),
  INDEX idx_dfsp_id     (dfsp_id)
);
