# R-Switch Server Documentation

Overvie​w
R-Switch Server is a Mojaloop-based backend service designed to manage core National Payment Switch operations for interoperable real-time payment infrastructure.

The server acts as an administrative and orchestration layer between Mojaloop services such as:

Central Ledger

Account Lookup Service (ALS)

Settlement Service

Kafka Consumer Services

DFSP Management

The project provides APIs and operational services required for:

Settlement Management

DFSP Onboarding

Hub Account Management

Settlement Model Configuration

Oracle Configuration

Liquidity Monitoring

Callback Endpoint Configuration

Kafka Event Processing

Core Features
1. Settlement Management
The system provides APIs and operational tools to manage Mojaloop settlement workflows.

Features include:

Settlement model creation

Settlement position monitoring

Settlement configuration

Deferred net settlement support

Settlement account management

Integrated with:

Mojaloop Central Ledger

Settlement Service

2. DFSP Onboarding
The platform supports onboarding and management of DFSPs (Digital Financial Service Providers).

Capabilities:

DFSP registration

DFSP configuration

Endpoint setup

Callback URL management

Liquidity account provisioning

3. Hub Account Management
R-Switch provides APIs for managing Hub accounts inside Mojaloop Central Ledger.

Supported operations:

Create Hub accounts

Retrieve Hub accounts

Configure settlement accounts

Manage reconciliation accounts

4. Settlement Models
The system supports dynamic settlement model configuration.

Examples:

Deferred Net Settlement

Gross Settlement

Multilateral Settlement

Capabilities:

Create settlement models

Retrieve settlement models

Configure settlement behavior

5. Oracle Configuration
The platform integrates with Mojaloop ALS Oracle services for party resolution.

Supported operations:

Add Oracle endpoints

Retrieve configured oracles

Delete Oracle configurations

Use cases:

MSISDN lookup

Party resolution

Cross-DFSP routing

6. Kafka Consumer Services
The server includes Kafka consumer services for processing Mojaloop events in real time.

Supported event streams:

Transfer Prepare

Transfer Fulfil

Position Events

Notifications

Settlement Events

Benefits:

Real-time monitoring

Event-driven architecture

Async transaction processing

7. Callback Endpoint Configuration
The system supports dynamic callback endpoint configuration for DFSP integrations.

Examples:

Quotes callback

Transfers callback

Parties callback

Transaction notifications

8. Liquidity Management
Liquidity management APIs allow monitoring and administration of DFSP liquidity positions.

Features:

Account balances

Position monitoring

Liquidity tracking

Settlement liquidity operations

Technology Stack
Component	Technology
Backend Framework	Node.js + Express.js
HTTP Client	Axios
Messaging	Kafka
Core Payment Platform	Mojaloop
Ledger System	Central Ledger
Lookup Service	ALS (Account Lookup Service)


Hub Controller Documentation
The hub.controller.js file is responsible for handling core Hub administration APIs.

It communicates directly with:

Central Ledger APIs
ALS Admin APIs
using Axios HTTP requests.

Headers Configuration
Central Ledger Headers
Used for requests sent to Mojaloop Central Ledger.

const clHeaders = {  'Content-Type': 'application/json',  'fspiop-source': 'switch'};
Purpose

Defines request content type

Identifies the source DFSP as switch

ALS Headers
Used for Oracle and ALS-related APIs.

const alsHeaders = 
{  'Content-Type': 'application/vnd.interoperability.participants+json;version=1.0', 
'Accept': 'application/vnd.interoperability.participants+json;version=1',
'Date': new Date().toUTCString(),};
Purpose

Uses Mojaloop interoperability media types

Ensures FSPIOP compatibility

Provides proper ALS request formatting

Hub Account APIs
Get Hub Accounts
Endpoint
GET /hub/accounts
Description

Retrieves all Hub accounts configured in Central Ledger.

Central Ledger API
GET /participants/Hub/accounts
Function

exports.getHubAccounts
Response

[  {    "id": 1,    "currency": "USD",    "type": "HUB_RECONCILIATION"  }]
Create Hub Account

Endpoint
POST /hub/accounts
Description

Creates a new Hub account in Central Ledger.

Required Fields
Field	Type
currency	string
type	string
Request Example
{  "currency": "USD",  "type": "HUB_MULTILATERAL_SETTLEMENT"}
Function

exports.createHubAccount
Settlement Model APIs

Get Settlement Models
Endpoint
GET /hub/settlement-models
Description

Returns all configured settlement models.

Central Ledger API
GET /settlementModels
Function

exports.getSettlementModels
Create Settlement Model

Endpoint
POST /hub/settlement-models
Description

Creates a new settlement model configuration.

Function
exports.createSettlementModel
Example Request

{  "name": "DEFERREDNET",  "settlementDelay": 60}
Oracle APIs

Get Oracles
Endpoint
GET /hub/oracles
Description

Retrieves all configured ALS Oracles.

ALS API
GET /oracles
Function

exports.getOracles
Create Oracle

Endpoint
POST /hub/oracles
Description

Registers a new Oracle configuration.

Function
exports.createOracle
Example Request

{  "endpoint": "http://oracle.domain.com",  "type": "MSISDN"}
Delete Oracle

Endpoint
DELETE /hub/oracles/:id
Description

Deletes an existing Oracle configuration.

Function
exports.deleteOracle
Example

DELETE /hub/oracles/1
Error Handling

All controller methods implement standardized error handling.

Example:

res.status(err.response?.status || 500).json(  err.response?.data || {    error: err.message  });
Benefits:

Consistent API responses

Proper HTTP status propagation

Easier debugging

Mojaloop error visibility

Architecture Flow
Client Request      │      ▼R-Switch Server (Express API)      │      ├── Central Ledger APIs      │      ├── ALS Admin APIs      │      ├── Settlement Services      │      └── Kafka Event Consumers

Conclusion

R-Switch Server provides a centralized orchestration and administration layer for Mojaloop-based payment infrastructure.

The platform simplifies:

Hub management

Settlement operations

Oracle administration

DFSP onboarding

Liquidity monitoring

Event processing

while maintaining compatibility with Mojaloop interoperability standards and real-time payment workflows.

DFSP Controller Documentation
Overview
The dfsp.controller.js module is responsible for managing DFSP (Digital Financial Service Provider) lifecycle operations inside the R-Switch platform.

The controller integrates with:

Mojaloop Central Ledger

ALS (Account Lookup Service)

MySQL Database

Email Notification Service

This controller automates the entire DFSP onboarding and operational setup process.

Main Responsibilities
The controller handles:

DFSP registration

Central Ledger participant creation

Settlement account provisioning

Callback endpoint registration

Net Debit Cap configuration

DFSP admin user creation

Welcome email delivery

DFSP information retrieval

Endpoint synchronization

Imported Dependencies
const { pool } =
 require('../config/db')
const { v4: uuidv4 } = 
require('uuid')
const axios = 
require('axios')
const bcrypt = 
require('bcryptjs')
const { sendEmail } = 
require('../services/email.service')
External Services

Central Ledger
CENTRAL_LEDGER_URL=http://ledger.domain.com
Used for:

Participant management

Endpoint registration

Settlement configuration

Limits management

ALS Service
ALS_URL=http://als.domain.com
Used for:

Account lookup

Party resolution

Interoperability services

DFSP Onboarding Flow
The DFSP onboarding process is fully automated.

Workflow
Create DFSP Request

⬇

Central Ledger Participant Creation

⬇

Settlement Account Setup

⬇

Callback Endpoint Registration

⬇

Net Debit Cap Configuration

⬇

Save DFSP in Database

⬇

Create DFSP Admin User

⬇

Send Welcome Email

Central Ledger Helper Functions

The controller contains multiple helper functions for interacting with Mojaloop Central Ledger APIs.

1. Create Participant
Function
clCreateParticipant(dfspId, currency)
Purpose

Creates a DFSP participant in Mojaloop Central Ledger.

Central Ledger API
POST /participants
Request Example

{  "name": "a_bank",  "currency": "BDT"}
Headers

{  'Content-Type': 'application/json',  
'fspiop-source': 'NOT_APPLICABLE'}
2. Settlement Account Creation

Function
clSetInitialPosition(dfspId, currency)
Purpose

Creates a settlement account for a DFSP participant.

Central Ledger API
POST /participants/{dfspId}/accounts
Request Example

{  "type": "SETTLEMENT",  "currency": "BDT"}
Important Note

The implementation fixes a Mojaloop compatibility issue.

Unsupported payload:

{  "currency": "BDT",  "initialPosition": 0}
Supported payload:

{  "type": "SETTLEMENT",  "currency": "BDT"}
3. Callback Endpoint Registration

Function
clRegisterEndpoints(dfspId, callbackUrl)
Purpose

Registers all required Mojaloop callback endpoints for a DFSP.

Supported Endpoints
Endpoint Type	Description
FSPIOP_CALLBACK_URL_TRANSFER_POST	Transfer POST callback
FSPIOP_CALLBACK_URL_TRANSFER_PUT	Transfer PUT callback
FSPIOP_CALLBACK_URL_TRANSFER_ERROR	Transfer error callback
FSPIOP_CALLBACK_URL_QUOTES	Quotes callback
FSPIOP_CALLBACK_URL_BULK_QUOTES	Bulk quote callback
FSPIOP_CALLBACK_URL_BULK_TRANSFER_POST	Bulk transfer POST
FSPIOP_CALLBACK_URL_BULK_TRANSFER_PUT	Bulk transfer PUT
FSPIOP_CALLBACK_URL_BULK_TRANSFER_ERROR	Bulk transfer errors
FSPIOP_CALLBACK_URL_PARTIES_GET	Party lookup GET
FSPIOP_CALLBACK_URL_PARTIES_PUT	Party PUT callback
FSPIOP_CALLBACK_URL_PARTIES_PUT_ERROR	Party error callback
FSPIOP_CALLBACK_URL_PARTICIPANT_PUT	Participant callback
FSPIOP_CALLBACK_URL_PARTICIPANT_PUT_ERROR	Participant error callback
Endpoint Registration Flow
DFSP

⬇

R-Switch API

⬇

Central Ledger Endpoint Registration

⬇

Mojaloop Callback Routing

4. Net Debit Cap Configuration

Function
clSetNetDebitCap(dfspId, currency, limit)
Purpose

Configures liquidity limits for a DFSP.

Central Ledger API
POST /participants/{dfspId}/initialPositionAndLimits
Request Example

{  "currency": "BDT",  "limit": {    "type": "NET_DEBIT_CAP",    "value": 10000  },  "initialPosition": 0}
Important Mojaloop Compatibility Fix

Previous implementation used:

axios.put(...)
Updated implementation:

axios.post(...)
This change resolves compatibility issues with newer Mojaloop Central Ledger implementations.

API Endpoints
GET /dfsps
Purpose
Returns all registered DFSPs from the R-Switch database.

Function
exports.getDfsps
SQL Query

SELECT * FROM dfsps ORDER BY name ASC
GET /dfsps/mini

Purpose
Returns lightweight DFSP data for dropdowns and selectors.

Function
exports.getMiniDfspsData
Response Example

{  "data": [    {      "value": "a_bank",      "label": "A Bank"    }  ]}
GET /dfsps/:dfspId

Purpose
Returns detailed DFSP information including:

DFSP profile

Transaction statistics

Central Ledger endpoints

Liquidity limits

Function
exports.getDfspById
Statistics Returned

Field	Description
total_transfers	Total transaction count
committed	Successful transfers
failed	Failed transfers
total_volume	Total committed volume
Central Ledger Synchronization
The API also retrieves:

Registered endpoints

Liquidity limits

from Mojaloop Central Ledger.

If Central Ledger becomes unavailable, the API still returns local database information.

This ensures:

High availability

Partial fault tolerance

Operational continuity

POST /dfsps
Purpose
Creates and provisions a new DFSP.

Function
exports.createDfsp
Full Provisioning Process

Step 1 — Create Central Ledger Participant
Creates the DFSP in Mojaloop Central Ledger.

Step 2 — Settlement Account Provisioning
Creates settlement accounts for liquidity operations.

Step 3 — Callback Endpoint Registration
Registers all Mojaloop interoperability callbacks.

Step 4 — Net Debit Cap Setup
Configures liquidity and risk management limits.

Step 5 — Save DFSP in R-Switch Database
Stores:

DFSP metadata

Endpoint URLs

Currency configuration

Step 6 — Create DFSP Position Record
Creates initial liquidity tracking row in:

dfsp_positions
Step 7 — Create DFSP Admin User

Creates a secure DFSP portal administrator account.

Security Features
Password hashing using bcrypt

Role-based access

Unique UUID identifiers

User Roles
Role	Permissions
ADMIN	Full access
OPERATOR	Transaction operations
VIEWER	Read-only access
Welcome Email Service
After successful onboarding, the system sends an automated welcome email containing:

Portal URL

Username

Temporary password

Security instructions

Email Features
Feature	Description
HTML Template	Professional styled email
Dynamic Branding	DFSP-specific content
Credential Delivery	Secure onboarding
Security Warning	Password change recommendation
Example Response
{  "message": "DFSP created successfully",  
"dfsp_id": "a_bank",  
"steps": {    "cl_participant": "ok",    "cl_endpoints": "ok",
 "cl_ndc": "ok",    "db_save": "ok",    "admin_user": "created",    
"welcome_email": "sent"  }}

DFSP Update API

Endpoint
PUT /dfsps/:dfspId
Purpose

Updates DFSP information and synchronizes callback endpoints.

Function
exports.updateDfsp
Endpoint Synchronization

When callback URLs are updated:

Database records are updated

Central Ledger endpoints are re-registered

This ensures Mojaloop routing consistency.

Get DFSP Endpoints
Endpoint
GET /dfsps/:dfspId/endpoints
Purpose

Retrieves all registered callback endpoints from Central Ledger.

Function
exports.getDfspEndpoints
Register Endpoints API

Endpoint
POST /dfsps/:dfspId/endpoints
Purpose

Registers or updates DFSP callback endpoints.

Function
exports.registerEndpoints
Database Tables Used

Table	Purpose
dfsps	DFSP master data
dfsp_positions	Liquidity tracking
dfsp_users	DFSP portal users
transfers	Transaction statistics
Security Features
Password Security
Passwords are hashed using:

bcrypt.hash(password, 10)
UUID-Based Identifiers

All internal records use UUID v4 identifiers for:

Security

Scalability

Distributed compatibility

Fault Tolerance Design
The controller is designed with resilient provisioning logic.

Features include:

Partial failure handling

Step-by-step execution tracking

Retry-safe onboarding

Existing participant detection

Graceful Central Ledger failure handling

Logging
The controller includes operational logging for:

DFSP creation

Endpoint registration

Email delivery

Central Ledger synchronization

Error tracking

Example:

console.log(`[DFSP] Endpoints registered: ${dfsp_id}`)
Architecture Overview

DFSP Portal Request        │        ▼R-Switch DFSP Controller        │        ├── MySQL Database        │        ├── Central Ledger        │        ├── ALS Service        │        ├── Email Service        │        └── Liquidity Services

Conclusion

The dfsp.controller.js module provides a complete DFSP lifecycle management system for Mojaloop-based payment infrastructure.

It automates:

DFSP onboarding

Liquidity provisioning

Callback registration

User management

Security setup

Operational synchronization

while maintaining compatibility with Mojaloop interoperability standards and real-time payment workflows.

Legacy Settlement Flow Documentation
Overview
This legacy settlement flow performs:

Settlement window close

Settlement creation

Settlement state transitions

Liquidity restoration using recordFundsIn

Position reset

Reconciliation cleanup

Email notification

This flow was designed to automatically restore DFSP liquidity after settlement completion.

Settlement Lifecycle
OPEN WINDOW
⬇
TRANSFERS EXECUTED
⬇
CLOSE WINDOW
⬇
CREATE SETTLEMENT
⬇
PS_TRANSFERS_RECORDED
⬇
PS_TRANSFERS_RESERVED
⬇
PS_TRANSFERS_COMMITTED
⬇
SETTLED
⬇
recordFundsIn (Liquidity Reset)
⬇
DFSP POSITIONS RESET TO ZERO
⬇
RECONCILIATION COMPLETE

Endpoint

POST /settlement/complete
Request Body

{  "window_id": "12345",  "reason": "End of day settlement"}
Field
Type
Required
Description


window_id
string
NO
Settlement window ID

reason
string
YES
Settlement reason




Settlement Processing Steps
STEP 1 — Close Settlement Window
Description
Finds OPEN settlement window and closes it.

Mojaloop API
POST /settlementWindows/{windowId}
Payload

{  "state": "CLOSED",  "reason": "End of day settlement"}
Local DB Update

UPDATE settlement_windowsSET status = 'CLOSED'
STEP 2 — Create Settlement

Description
Creates deferred net settlement.

Mojaloop API
POST /settlements
Payload

{  "reason": "End of day settlement",  "settlementModel": "DEFERREDNET",  "settlementWindows": [    {      "id": 12345    }  ]}
Output

Returns:

settlementId

participants

accounts

net settlement positions

STEP 3 — PS_TRANSFERS_RECORDED
Description
Marks settlement transfers as RECORDED.

API
PUT /settlements/{settlementId}
State

PS_TRANSFERS_RECORDED
STEP 4 — PS_TRANSFERS_RESERVED

Description
Reserves settlement liquidity.

State
PS_TRANSFERS_RESERVED
STEP 5 — PS_TRANSFERS_COMMITTED

Description
Commits reserved settlement transfers.

State
PS_TRANSFERS_COMMITTED
STEP 6 — SETTLED

Description
Marks settlement as completed by Central Bank.

State
SETTLED
STEP 7 — Liquidity Restoration (recordFundsIn)

Description
Restores DFSP settlement liquidity after settlement completion.

Each participant:

Fetch participant name

Find SETTLEMENT account

Execute recordFundsIn

Central Ledger Flow
Fetch Participants
GET /participants
Fetch Accounts

GET /participants/{name}/accounts
Execute recordFundsIn

POST /participants/{name}/accounts/{accountId}
Payload

{  "transferId": "uuid",  "externalReference": "settlement-reset",  "action": "recordFundsIn",  "reason": "Post-settlement reset",  "amount": {    "amount": "1000",    "currency": "BDT"  }}
Liquidity Reset Logic

Positive Settlement Position
DFSP receives liquidity
Negative Settlement Position

Absolute amount restored after settlement
Local Database Cleanup

Reconciliation Update
UPDATE reconciliationSET recon_status = 'MATCHED'
Reset DFSP Positions

UPDATE dfsp_positionsSET current_position = 0,    reserved_amount = 0
Update Settlement Window

UPDATE settlement_windowsSET status = 'SETTLED'
Email Notifications

Description
Sends settlement completion emails to all participants.

Service
sendSettlementEmailsToAll()
Success Response

{  "success": true,  "message": "Settlement completed successfully through all 7 steps",  "settlement_id": "abc123",  "window_id": 12345,  "positions_reset": 4}
Failure Response

{  "error": "Failed at step4_reserved",  "details": {}}
Database Tables

settlement_windows
Stores settlement lifecycle.

reconciliation
Tracks SEND/RECEIVE reconciliation.

dfsp_positions
Tracks DFSP positions.

settlement_finalize_records
Stores liquidity movement audit logs.

Important Notes
Automatic Liquidity Restoration
This legacy flow automatically restored settlement liquidity after settlement completion.

Position Reset
All DFSP positions were reset to zero after settlement.

Settlement Model
DEFERREDNET
Known Limitations

Uses sleep() delays

Large number of Central Ledger API calls

No distributed locking

No idempotency protection

Global position reset risk

Potential race conditions

Recommended Improvements
Add Redis lock

Add retry mechanism

Replace sleep() with polling

Optimize participant lookup

Add transaction consistency

Add structured logging

Add monitoring and metrics

Mojaloop Kafka Consumer Documentation
Overview
This consumer file listens to Mojaloop Kafka topics and processes transfer lifecycle events.
It manages transfer states, DFSP positions, reconciliation records, settlement windows, and notification logs.

The consumer performs the following responsibilities:

Connect to Kafka

Subscribe to Mojaloop topics

Decode Mojaloop payloads

Extract transfer information

Handle transfer lifecycle events

Update database records

Maintain audit/state logs

Manage liquidity positions

Process settlement reconciliation

File Imports
const { consumer, TOPICS } = require('../config/kafka');const { pool } = require('../config/db');const { v4: uuidv4 } = require('uuid');
Dependencies

Dependency	Description
consumer	Kafka consumer instance
TOPICS	Kafka topic constants
pool	MySQL connection pool
uuidv4	UUID generator for unique IDs
Consumer Architecture
Kafka Topic    ↓Consumer Receives Message    ↓Decode Payload    ↓Extract Transfer Data    ↓Route to Event Handler    ↓Update Database    ↓Save State Logs
Payload Decoder

decodePayload(payload)
This function decodes Mojaloop payloads.

Mojaloop payloads may arrive in different formats:

Plain JavaScript object

JSON string

Base64 encoded payload

Supported Payload Formats
Plain Object
{  transferId: '123'}
JSON String

'{"transferId":"123"}'
Base64 Encoded Payload

data:application/json;base64,XXXXX
Features

Automatically detects payload type

Decodes base64 payloads

Parses JSON strings

Returns normalized object

Prevents parsing failures

Return Structure
{  transferId,  payerFsp,  payeeFsp}
Payload Extractor

extractPayload(raw)
This function extracts important Mojaloop transfer information from raw Kafka messages.

Extracted Fields
Field	Description
transferId	Unique transfer ID
payerFsp	Sender DFSP
payeeFsp	Receiver DFSP
amount	Transfer amount
currency	Currency code
transactionId	Transaction ID
quoteId	Quote ID
ilpPacket	ILP packet
condition	Transfer condition
expiration	Expiration timestamp
fulfilment	Fulfilment value
transferState	Current transfer state
errorCode	Error code
errorMessage	Error message
eventType	Kafka event type
Helper Functions
saveStateLog()
Stores transfer lifecycle audit logs.

Purpose
Tracks every transfer state transition for audit and monitoring purposes.

Database Table
transfer_state_log
Stored Fields

Field	Description
transfer_id	Transfer identifier
previous_status	Previous transfer state
new_status	New transfer state
event_type	Event type
direction	INBOUND / OUTBOUND / INTERNAL
from_dfsp	Source DFSP
to_dfsp	Destination DFSP
raw_payload	Original Kafka payload
getTransfer()
Retrieves a transfer from the database.

SQL Query
SELECT * FROM transfers WHERE transfer_id = ?
Transfer Lifecycle Event Handlers

1. handlePrepare()
Purpose
Handles TRANSFER_PREPARE events.

This is the initial stage of a transfer.

Transfer State
RECEIVED
Workflow

Kafka PREPARE Event
⬇
Extract Payload
⬇
Insert Transfer Record
⬇
Set Status = RECEIVED
⬇
Save State Log


Database Operations

Insert Transfer
INSERT INTO transfers (...)
Updated Tables

Table	Action
transfers	Insert or update transfer
transfer_state_log	Save state transition
Key Features
Uses ON DUPLICATE KEY UPDATE for idempotency

Stores ILP packet and transfer condition

Saves payer and payee DFSP information

2. handlePosition()
Purpose
Handles liquidity reservation events.

Transfer State Transition
RECEIVED → RESERVED
Workflow

Find Transfer    ↓Reserve DFSP Position    ↓Update Reserved Amount    ↓Insert Position Change    ↓Save State Log
Database Operations

Table	Purpose
transfers	Update transfer status
dfsp_positions	Reserve liquidity
position_changes	Save audit records
transfer_state_log	Track state changes
Position Change Type
RESERVE
Position Logic

The payer DFSP reserved amount increases when funds are reserved.

3. handleFulfil()
Purpose
Handles transfer fulfilment events.

Transfer State Transition
RESERVED → COMMITTED
Workflow

Receive Fulfil Event        ↓Update Transfer Status        ↓Save Fulfilment        ↓Create Reconciliation Records        ↓Commit DFSP Position        ↓Save State Log
Updated Tables

Table	Purpose
transfers	Commit transfer
reconciliation	Create settlement records
dfsp_positions	Commit liquidity
position_changes	Save audit trail
transfer_state_log	Track lifecycle
Reconciliation Entries
Two reconciliation rows are created.

SEND Entry
transfer_type = SEND
RECEIVE Entry

transfer_type = RECEIVE
Position Change Type

COMMIT
Important Note

FULFIL payloads may not contain amount or currency.
The consumer retrieves them from the transfers table.

4. handleReject()
Purpose
Handles failed transfer events.

Transfer State
FAILED


Workflow

Reject Event

⬇

Update Transfer Status

⬇

Release Reserved Liquidity

⬇

Insert Rollback Position Change

⬇

Save State Log


Updated Tables

Table	Purpose
transfers	Update failed status
dfsp_positions	Release reserved amount
position_changes	Insert rollback log
transfer_state_log	Save audit log
Position Change Type
ROLLBACK


Error Information

Stores:

errorCode

errorMessage

inside the transfers table.

5. handleTimeout()
Purpose
Handles expired transfer events.

Supported Previous States
RECEIVEDRESERVED
Final State

TIMEOUT
Workflow

Timeout Event    ↓Update Status    ↓Release Reserved Amount    ↓Insert Rollback Log
Updated Tables

Table	Purpose
transfers	Update timeout state
dfsp_positions	Release reserved liquidity
position_changes	Rollback audit
transfer_state_log	State tracking
6. handleNotification()
Purpose
Stores outgoing notification events.

Database Table
notifications_log
Stored Data

Field	Description
transfer_id	Transfer ID
to_fsp	Destination DFSP
from_fsp	Source DFSP
event_type	Notification type
transfer_state	Current state
payload	Full Kafka payload
Direction
OUTBOUND
Features

Stores raw notification payload

Tracks transfer notification events

Maintains audit logs

7. handleSettlementClose()
Purpose
Handles settlement window closing.

Workflow
Settlement Window Closed        ↓Update Settlement Window        ↓Match Reconciliation Records        ↓Reset DFSP Positions


Updated Tables

Table	Purpose
settlement_windows	Store settlement lifecycle
reconciliation	Mark records as MATCHED
dfsp_positions	Reset balances
Reconciliation Status
MATCHED


Settlement Logic

SEND and RECEIVE reconciliation records are matched

Settlement ID is assigned

DFSP positions are reset

8. handleAdminTransfer()
Purpose
Handles internal/admin transfer events.

Workflow
Receive Admin Event        ↓Save State Log
Main Functionality

Stores admin transfer lifecycle logs

Tracks internal transfer actions

Kafka Consumer Startup
startConsumer()
Initializes and starts the Kafka consumer.

Workflow
Connect Kafka      ↓Subscribe Topics      ↓Listen for Messages      ↓Parse Payload      ↓Route to Handler
Subscribed Topics

Topic	Handler
TRANSFER_PREPARE	handlePrepare
TRANSFER_POSITION	handlePosition
TRANSFER_FULFIL	handleFulfil
TRANSFER_REJECT	handleReject
TIMEOUT	handleTimeout
NOTIFICATION	handleNotification
SETTLEMENT_CLOSE	handleSettlementClose
ADMIN_TRANSFER	handleAdminTransfer
Kafka Message Processing
consumer.run({  eachMessage: async ({ topic, message }) => {}});
Topic Routing

The consumer routes messages using:

switch (topic)
Transaction Management

Most handlers use database transactions.

Transaction Flow
beginTransaction()      ↓Execute Queries      ↓commit()
If an error occurs:

rollback()
Error Handling

Every handler uses:

try {}catch(err) {}finally {}
Logging

Success Logs
 [PREPARE]  [POSITION] [FULFIL] [REJECT]
Error Logs

 [TIMEOUT] [SETTLEMENT] [NOTIFICATION]
Database Tables Used

Table	Purpose
transfers	Main transfer records
transfer_state_log	Lifecycle tracking
dfsp_positions	Liquidity positions
position_changes	Position audit logs
reconciliation	Settlement reconciliation
settlement_windows	Settlement lifecycle
notifications_log	Notification storage
# Complete Transfer Lifecycle
PREPARE

⬇

RECEIVED

⬇

POSITION

⬇

RESERVED

⬇

FULFIL

⬇

COMMITTED

# Failure Lifecycle

PREPARE

⬇

RECEIVED

⬇

REJECT / TIMEOUT

⬇

FAILED / TIMEOUT

# Important Features

Base64 Payload Support
Supports Mojaloop base64 encoded payloads.

Idempotency
Uses:

ON DUPLICATE KEY UPDATE
to safely handle duplicate transfer events.

Audit Tracking
Every transfer state transition is logged.

Liquidity Management
Tracks:

Reserved liquidity

Current positions

Rollbacks

Commit operations

Reconciliation Support
Automatically creates reconciliation entries during fulfilment.

Settlement Support
Settlement close events automatically:

Match reconciliation rows

Assign settlement IDs

Reset positions

Export
module.exports = { startConsumer };
Usage Example

const { startConsumer } = require('./consumer');startConsumer();
Summary

This Kafka consumer is a production-grade Mojaloop event processing system.

It manages:

Transfer lifecycle processing

Liquidity reservation

Transfer fulfilment

Failure handling

Settlement reconciliation

Notification tracking

Audit logging

Timeout recovery

Position management

The architecture is fully event-driven and designed for scalable payment switch systems.
