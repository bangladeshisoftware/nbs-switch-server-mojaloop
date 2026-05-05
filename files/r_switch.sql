-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: May 05, 2026 at 10:46 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `r_switch`
--

-- --------------------------------------------------------

--
-- Table structure for table `dfsps`
--

CREATE TABLE `dfsps` (
  `id` char(36) NOT NULL,
  `dfsp_id` varchar(100) NOT NULL,
  `name` varchar(200) NOT NULL,
  `short_name` varchar(50) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `endpoint_url` varchar(500) DEFAULT NULL,
  `callback_url` varchar(500) DEFAULT NULL,
  `status` enum('ACTIVE','INACTIVE','SUSPENDED') DEFAULT 'ACTIVE',
  `currency` char(3) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `contact_person` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `address` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `dfsp_limits`
--

CREATE TABLE `dfsp_limits` (
  `id` char(36) NOT NULL,
  `dfsp_id` varchar(100) DEFAULT NULL,
  `limit_type` enum('NET_DEBIT_CAP','DEPOSIT') DEFAULT 'NET_DEBIT_CAP',
  `currency` char(3) DEFAULT NULL,
  `value` decimal(18,4) DEFAULT NULL,
  `created_by` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `dfsp_positions`
--

CREATE TABLE `dfsp_positions` (
  `id` char(36) NOT NULL,
  `dfsp_id` varchar(100) NOT NULL,
  `currency` char(3) DEFAULT NULL,
  `current_position` decimal(18,4) DEFAULT 0.0000,
  `net_debit_cap` decimal(18,4) DEFAULT 0.0000,
  `reserved_amount` decimal(18,4) DEFAULT 0.0000,
  `available` decimal(18,4) GENERATED ALWAYS AS (`net_debit_cap` - `current_position` - `reserved_amount`) STORED,
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `dfsp_users`
--

CREATE TABLE `dfsp_users` (
  `id` varchar(36) NOT NULL,
  `dfsp_id` varchar(50) NOT NULL,
  `username` varchar(100) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `full_name` varchar(255) DEFAULT NULL,
  `role` enum('ADMIN','OPERATOR','VIEWER') DEFAULT 'VIEWER',
  `is_active` tinyint(1) DEFAULT 1,
  `otp` varchar(10) DEFAULT NULL,
  `otp_expires_at` datetime DEFAULT NULL,
  `last_login` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `merchants`
--

CREATE TABLE `merchants` (
  `id` varchar(36) NOT NULL,
  `dfsp_id` varchar(50) NOT NULL,
  `merchant_id` varchar(100) NOT NULL,
  `business_name` varchar(255) NOT NULL,
  `business_type` varchar(100) DEFAULT NULL,
  `owner_name` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `nid` varchar(50) DEFAULT NULL,
  `tin` varchar(50) DEFAULT NULL,
  `account_number` varchar(100) DEFAULT NULL,
  `status` enum('PENDING','ACTIVE','SUSPENDED','REJECTED') DEFAULT 'PENDING',
  `category` varchar(100) DEFAULT NULL,
  `daily_limit` decimal(18,2) DEFAULT 0.00,
  `monthly_limit` decimal(18,2) DEFAULT 0.00,
  `approved_by` varchar(36) DEFAULT NULL,
  `approved_at` datetime DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `id_type` varchar(50) DEFAULT 'MSISDN',
  `id_value` varchar(100) DEFAULT NULL,
  `first_name` varchar(100) DEFAULT NULL,
  `middle_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `dob` date DEFAULT NULL,
  `als_status` enum('pending','registered','failed') DEFAULT 'pending',
  `currency` varchar(10) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notifications_log`
--

CREATE TABLE `notifications_log` (
  `id` char(36) NOT NULL,
  `transfer_id` varchar(36) DEFAULT NULL,
  `to_fsp` varchar(100) DEFAULT NULL,
  `from_fsp` varchar(100) DEFAULT NULL,
  `event_type` varchar(50) DEFAULT NULL,
  `transfer_state` varchar(30) DEFAULT NULL,
  `status` varchar(20) DEFAULT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `position_changes`
--

CREATE TABLE `position_changes` (
  `id` char(36) NOT NULL,
  `transfer_id` varchar(36) DEFAULT NULL,
  `dfsp_id` varchar(100) DEFAULT NULL,
  `currency` char(3) DEFAULT NULL,
  `change_type` enum('RESERVE','COMMIT','ROLLBACK','DEPOSIT','SETTLEMENT') DEFAULT NULL,
  `amount` decimal(18,4) DEFAULT NULL,
  `position_before` decimal(18,4) DEFAULT NULL,
  `position_after` decimal(18,4) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `quotes`
--

CREATE TABLE `quotes` (
  `id` char(36) NOT NULL,
  `quote_id` varchar(36) NOT NULL,
  `transaction_id` varchar(36) DEFAULT NULL,
  `payer_fsp` varchar(100) DEFAULT NULL,
  `payee_fsp` varchar(100) DEFAULT NULL,
  `payer_msisdn` varchar(50) DEFAULT NULL,
  `payee_msisdn` varchar(50) DEFAULT NULL,
  `amount` decimal(18,4) DEFAULT NULL,
  `currency` char(3) DEFAULT NULL,
  `fees` decimal(18,4) DEFAULT NULL,
  `ilp_packet` text DEFAULT NULL,
  `condition_value` varchar(256) DEFAULT NULL,
  `expiration` datetime DEFAULT NULL,
  `status` enum('REQUESTED','RESPONDED','EXPIRED','REJECTED') DEFAULT 'REQUESTED',
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reconciliation`
--

CREATE TABLE `reconciliation` (
  `id` char(36) NOT NULL,
  `settlement_id` varchar(36) DEFAULT NULL,
  `window_id` varchar(36) DEFAULT NULL,
  `dfsp_id` varchar(100) DEFAULT NULL,
  `transfer_id` varchar(36) DEFAULT NULL,
  `transfer_type` enum('SEND','RECEIVE') DEFAULT NULL,
  `amount` decimal(18,4) DEFAULT NULL,
  `currency` char(3) DEFAULT NULL,
  `net_position` decimal(18,4) DEFAULT NULL,
  `recon_status` enum('PENDING','MATCHED','UNMATCHED','DISPUTED') DEFAULT 'PENDING',
  `settlement_date` date DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `settlement_windows`
--

CREATE TABLE `settlement_windows` (
  `id` char(36) NOT NULL,
  `window_id` varchar(36) NOT NULL,
  `status` enum('OPEN','CLOSED','PENDING_SETTLEMENT','SETTLED','ABORTED') DEFAULT 'OPEN',
  `opened_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `settled_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `simulate_transfers`
--

CREATE TABLE `simulate_transfers` (
  `id` varchar(36) NOT NULL,
  `transfer_id` varchar(36) NOT NULL,
  `quote_id` varchar(36) DEFAULT NULL,
  `transaction_id` varchar(36) DEFAULT NULL,
  `payment_type` enum('P2P','INSTANT') NOT NULL DEFAULT 'P2P',
  `payer_fsp` varchar(100) NOT NULL,
  `payer_merchant_id` varchar(36) DEFAULT NULL,
  `payer_id_type` varchar(50) DEFAULT NULL,
  `payer_id_value` varchar(100) DEFAULT NULL,
  `payer_name` varchar(200) DEFAULT NULL,
  `payee_fsp` varchar(100) NOT NULL,
  `payee_merchant_id` varchar(36) DEFAULT NULL,
  `payee_id_type` varchar(50) DEFAULT NULL,
  `payee_id_value` varchar(100) DEFAULT NULL,
  `payee_name` varchar(200) DEFAULT NULL,
  `amount` decimal(18,2) NOT NULL DEFAULT 0.00,
  `currency` varchar(10) NOT NULL DEFAULT 'BDT',
  `fee` decimal(18,2) DEFAULT 0.00,
  `status` enum('INITIATED','LOOKUP','QUOTED','COMMITTED','FAILED','TIMEOUT') NOT NULL DEFAULT 'INITIATED',
  `error_code` varchar(10) DEFAULT NULL,
  `error_description` text DEFAULT NULL,
  `ilp_packet` text DEFAULT NULL,
  `condition_value` varchar(500) DEFAULT NULL,
  `expiration` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transfers`
--

CREATE TABLE `transfers` (
  `id` char(36) NOT NULL,
  `transfer_id` varchar(36) NOT NULL,
  `transaction_id` varchar(36) DEFAULT NULL,
  `quote_id` varchar(36) DEFAULT NULL,
  `payer_fsp` varchar(100) DEFAULT NULL,
  `payee_fsp` varchar(100) DEFAULT NULL,
  `amount` decimal(18,4) DEFAULT NULL,
  `currency` char(3) DEFAULT NULL,
  `status` enum('RECEIVED','RESERVED','COMMITTED','FAILED','TIMEOUT','ABORTED','CANCELLED') DEFAULT 'RECEIVED',
  `error_code` varchar(10) DEFAULT NULL,
  `error_message` text DEFAULT NULL,
  `ilp_packet` text DEFAULT NULL,
  `condition_value` varchar(256) DEFAULT NULL,
  `fulfilment` varchar(256) DEFAULT NULL,
  `expiration` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transfer_state_log`
--

CREATE TABLE `transfer_state_log` (
  `id` char(36) NOT NULL,
  `transfer_id` varchar(36) NOT NULL,
  `previous_status` varchar(20) DEFAULT NULL,
  `new_status` varchar(20) DEFAULT NULL,
  `event_type` varchar(50) DEFAULT NULL,
  `direction` enum('INBOUND','OUTBOUND','INTERNAL') DEFAULT 'INBOUND',
  `from_dfsp` varchar(100) DEFAULT NULL,
  `to_dfsp` varchar(100) DEFAULT NULL,
  `raw_payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`raw_payload`)),
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` char(36) NOT NULL,
  `username` varchar(100) NOT NULL,
  `email` varchar(200) NOT NULL,
  `password` varchar(256) NOT NULL,
  `role` enum('ADMIN','OPERATOR','VIEWER') DEFAULT 'VIEWER',
  `is_active` tinyint(1) DEFAULT 1,
  `otp` varchar(6) DEFAULT NULL,
  `otp_expires_at` varchar(60) DEFAULT NULL,
  `last_login` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `username`, `email`, `password`, `role`, `is_active`, `otp`, `otp_expires_at`, `last_login`, `created_at`, `updated_at`) VALUES
('9ebf56b6-5b40-4df3-a0e1-d64f8f2a8b4f', 'newuser', 'your-email@gmail.com', '$2a$10$7dVOkhlaIg/4pAjvZ0j7Ret5K9JPKqh5GWVoHze3izQpH4TKe7ANK', 'ADMIN', 1, NULL, NULL, '2026-02-24 18:59:23', '2026-02-22 09:23:58', '2026-05-05 14:43:46');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `dfsps`
--
ALTER TABLE `dfsps`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `dfsp_id` (`dfsp_id`);

--
-- Indexes for table `dfsp_limits`
--
ALTER TABLE `dfsp_limits`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `dfsp_positions`
--
ALTER TABLE `dfsp_positions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `dfsp_id` (`dfsp_id`,`currency`);

--
-- Indexes for table `dfsp_users`
--
ALTER TABLE `dfsp_users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD UNIQUE KEY `email` (`email`),
  ADD KEY `dfsp_id` (`dfsp_id`);

--
-- Indexes for table `merchants`
--
ALTER TABLE `merchants`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `merchant_id` (`merchant_id`),
  ADD KEY `dfsp_id` (`dfsp_id`);

--
-- Indexes for table `notifications_log`
--
ALTER TABLE `notifications_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_transfer_id` (`transfer_id`);

--
-- Indexes for table `position_changes`
--
ALTER TABLE `position_changes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_transfer_id` (`transfer_id`),
  ADD KEY `idx_dfsp_id` (`dfsp_id`);

--
-- Indexes for table `quotes`
--
ALTER TABLE `quotes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `quote_id` (`quote_id`);

--
-- Indexes for table `reconciliation`
--
ALTER TABLE `reconciliation`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_dfsp_id` (`dfsp_id`),
  ADD KEY `idx_recon_status` (`recon_status`),
  ADD KEY `idx_settlement_id` (`settlement_id`);

--
-- Indexes for table `settlement_windows`
--
ALTER TABLE `settlement_windows`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `window_id` (`window_id`);

--
-- Indexes for table `simulate_transfers`
--
ALTER TABLE `simulate_transfers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `transfer_id` (`transfer_id`),
  ADD KEY `idx_sim_transfer_payer` (`payer_fsp`,`created_at`),
  ADD KEY `idx_sim_transfer_payee` (`payee_fsp`,`created_at`),
  ADD KEY `idx_sim_transfer_status` (`status`);

--
-- Indexes for table `transfers`
--
ALTER TABLE `transfers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `transfer_id` (`transfer_id`),
  ADD KEY `idx_payer_fsp` (`payer_fsp`),
  ADD KEY `idx_payee_fsp` (`payee_fsp`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_created_at` (`created_at`),
  ADD KEY `idx_currency` (`currency`);

--
-- Indexes for table `transfer_state_log`
--
ALTER TABLE `transfer_state_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_transfer_id` (`transfer_id`),
  ADD KEY `idx_created_at` (`created_at`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Constraints for dumped tables
--

--
-- Constraints for table `dfsp_users`
--
ALTER TABLE `dfsp_users`
  ADD CONSTRAINT `dfsp_users_ibfk_1` FOREIGN KEY (`dfsp_id`) REFERENCES `dfsps` (`dfsp_id`) ON DELETE CASCADE;

--
-- Constraints for table `merchants`
--
ALTER TABLE `merchants`
  ADD CONSTRAINT `merchants_ibfk_1` FOREIGN KEY (`dfsp_id`) REFERENCES `dfsps` (`dfsp_id`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
