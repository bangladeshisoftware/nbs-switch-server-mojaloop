# R-Switch Server

[![Node.js Version](https://shields.io)](https://nodejs.org)
[![Platform](https://shields.io)](https://mojaloop.io)

R-Switch Server is a Mojaloop-based backend service designed to manage core National Payment Switch operations for interoperable real-time payment infrastructure. It acts as an administrative and orchestration layer between core Mojaloop components.

---

## 🚀 Core Features

### 1. Settlement Management
*   Settlement model creation and configuration.
*   Settlement position monitoring and account management.
*   Deferred net settlement support integrated with Mojaloop Central Ledger.

### 2. DFSP Onboarding & Management
*   Automated registration of Digital Financial Service Providers.
*   Endpoint setup, callback URL configuration, and liquidity account provisioning.

### 3. Hub Account Management
*   Creation and retrieval of Hub accounts inside Mojaloop Central Ledger.
*   Administration of reconciliation and settlement accounts.

### 4. Oracle Configuration
*   Integration with Mojaloop ALS Oracle services for MSISDN lookup and party resolution.
*   Dynamic adding, retrieval, and removal of Oracle endpoints.

### 5. Kafka Consumer Services
*   Real-time event processing for Transfer Prepare, Transfer Fulfil, Position Events, Notifications, and Settlement Events.

### 6. Liquidity & Callback Configurations
*   Real-time tracking of account balances and DFSP liquidity positions.
*   Dynamic callbacks for Quotes, Transfers, Parties, and general transaction notifications.

---

## 🛠️ Technology Stack

| Component | Technology |
| :--- | :--- |
| **Backend Framework** | Node.js + Express.js |
| **HTTP Client** | Axios |
| **Messaging Engine** | Apache Kafka |
| **Payment Core** | Mojaloop Platform |
| **Ledger System** | Central Ledger |
| **Lookup Service** | ALS (Account Lookup Service) |
| **Database Engine** | MySQL |

---

## ⚙️ Environment Variables

Create a `.env` file in the root directory and configure the following variables:

```env
# Mojaloop Core Services
CENTRAL_LEDGER_URL=http://mojaloop.xyz
ALS_ADMIN_URL=http://mojaloop.xyz
ALS_URL=http://mojaloop.xyz

# Database Configurations
DB_HOST=localhost
DB_USER=root
DB_PASS=password
DB_NAME=r_switch_db
```

---

## 📐 Architecture Flow

```text
       Client Request
             │
             ▼
R-Switch Server (Express API)
             │
             ├──► Central Ledger APIs
             ├──► ALS Admin APIs
             ├──► Settlement Services
             └──► Kafka Event Consumers (Real-time Streams)
```

---

## 🔌 API Headers Configuration

### Central Ledger Headers
Used for administrative requests sent to the Mojaloop Central Ledger.
```javascript
const clHeaders = {  
  'Content-Type': 'application/json',  
  'fspiop-source': 'switch'
};
```

### ALS Headers
Used for Oracle and Account Lookup Service endpoints to ensure FSPIOP compatibility.
```javascript
const alsHeaders = {  
  'Content-Type': 'application/vnd.interoperability.participants+json;version=1.0', 
  'Accept': 'application/vnd.interoperability.participants+json;version=1',
  'Date': new Date().toUTCString(),
};
```

---

## 📑 API Reference

### Hub Account APIs

#### Get Hub Accounts
*   **Endpoint:** `GET /hub/accounts`
*   **Controller Function:** `exports.getHubAccounts`
*   **Upstream Route:** `GET /participants/Hub/accounts` (Central Ledger)
*   **Success Response (200):**
    ```json
    [
      {
        "id": 1,
        "currency": "USD",
        "type": "HUB_RECONCILIATION"
      }
    ]
    ```

#### Create Hub Account
*   **Endpoint:** `POST /hub/accounts`
*   **Controller Function:** `exports.createHubAccount`
*   **Payload Example:**
    ```json
    {
      "currency": "USD",
      "type": "HUB_MULTILATERAL_SETTLEMENT"
    }
    ```

### Settlement Model APIs

#### Get Settlement Models
*   **Endpoint:** `GET /hub/settlement-models`
*   **Controller Function:** `exports.getSettlementModels`
*   **Upstream Route:** `GET /settlementModels` (Central Ledger)

#### Create Settlement Model
*   **Endpoint:** `POST /hub/settlement-models`
*   **Controller Function:** `exports.createSettlementModel`
*   **Payload Example:**
    ```json
    {
      "name": "DEFERREDNET",
      "settlementDelay": 60
    }
    ```

### Oracle APIs

#### Get Oracles
*   **Endpoint:** `GET /hub/oracles`
*   **Controller Function:** `exports.getOracles`
*   **Upstream Route:** `GET /oracles` (ALS API)

#### Create Oracle
*   **Endpoint:** `POST /hub/oracles`
*   **Controller Function:** `exports.createOracle`
*   **Payload Example:**
    ```json
    {
      "endpoint": "http://mojaloop.xyz",
      "type": "MSISDN"
    }
    ```

#### Delete Oracle
*   **Endpoint:** `DELETE /hub/oracles/:id`
*   **Controller Function:** `exports.deleteOracle`
*   **Example Request:** `DELETE /hub/oracles/1`

---

## 👥 DFSP Onboarding Workflow

The `dfsp.controller.js` orchestrates and automates the complete entry cycle for new financial institutions.

### Core Responsibilities
1. Participant Creation in Central Ledger.
2. Settlement Account Provisioning.
3. Callback Endpoint Registration.
4. Net Debit Cap Configuration.
5. MySQL Local Database Entry & Admin User Creation.
6. Automation of SMTP Welcome Email Delivery.

### Automation Flow Order
```text
1. Create DFSP Request
       │
       ▼
2. Central Ledger Participant Creation
       │
       ▼
3. Settlement Account Setup
       │
       ▼
4. Callback Endpoint Registration
       │
       ▼
5. Net Debit Cap Configuration
       │
       ▼
6. Save DFSP details in MySQL DB
       │
       ▼
7. Create Secure DFSP Admin User (Bcrypt)
       │
       ▼
8. Dispatch Welcome Email Alert
```

### Core Helper Functions

#### 1. Create Participant
*   **Function:** `createParticipant`
*   **Target:** `POST /participants` (Central Ledger)
*   **Description:** Provisions the basic DFSP structural profile identifier inside the payment switch topology.

#### 2. Set Up Callback Endpoints
*   **Function:** `setEndpoints`
*   **Target:** `POST /participants/{name}/endpoints` (Central Ledger)
*   **Description:** Binds the physical destination URLs needed for routing transactional notification events back to the DFSP.

---

## 🛠️ Error Handling

All controller layers use a standardized global formatting fallback to maintain clean API diagnostics and upstream Mojaloop errors:

```javascript
res.status(err.response?.status || 500).json(
  err.response?.data || { error: err.message }
);
```

### Benefits
*   Guarantees consistent JSON API responses.
*   Enforces direct HTTP status propagation from underlying microservices.
*   Preserves deep Mojaloop error trace visibility for debugging.
