# R Switch Portal — Backend API

Node.js backend for Mojaloop R Switch Hub Management Portal.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your MySQL and Kafka details
```

## Database

```bash
mysql -u root -p < src/config/schema.sql
```

## Run

```bash
# Development
npm run dev

# Production
npm start
```

## Deploy to Kubernetes

```bash
# 1. Build and push Docker image
docker build -t your-registry/r-switch-backend:latest .
docker push your-registry/r-switch-backend:latest

# 2. Update secrets in k8s/deployment.yaml

# 3. Apply to cluster
kubectl apply -f k8s/deployment.yaml

# 4. Check status
kubectl get pods -n bscao | grep r-switch
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/auth/login | Login |
| GET | /api/v1/dashboard/summary | Dashboard KPIs |
| GET | /api/v1/transfers | List transfers |
| GET | /api/v1/transfers/:id | Transfer detail |
| GET | /api/v1/reconciliation | Reconciliation list |
| POST | /api/v1/reconciliation/run | Run reconciliation |
| GET | /api/v1/reconciliation/report | Recon report |
| GET | /api/v1/dfsps | List DFSPs |
| GET | /api/v1/settlement/positions | Net positions |

## How Kafka Consumer Works

The backend automatically listens to these Mojaloop Kafka topics:
- `topic-transfer-prepare` → saves status = RECEIVED
- `topic-transfer-fulfil`  → updates status = COMMITTED
- `topic-transfer-reject`  → updates status = FAILED
- `topic-timeout-consumer` → updates status = TIMEOUT
- `topic-notification-event` → logs notification
# nbs-switch-server-mojaloop
