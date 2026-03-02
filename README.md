# Multi-Region Incident Management System with Vector Clocks

A distributed backend that guarantees **causal ordering** of events across three geographic regions (`us`, `eu`, `apac`) using **vector clocks** and eventual consistency.

## Architecture

Three independent region services (`region-us`, `region-eu`, `region-apac`), each with its own PostgreSQL database, communicating via async HTTP replication every 5 seconds.
```
region-us (:3001) ←──async──→ region-eu (:3002)
      ↕                              ↕
   db-us                          db-eu
      
region-apac (:3003) ←──async──→ (peers)
      ↕
   db-apac
```

## Quick Start

### Prerequisites
- Docker Desktop
- curl + jq (for simulation script)

### Run the system
```bash
cp .env.example .env
docker-compose up --build
```

All 6 containers start automatically. Allow ~60 seconds to become healthy.

### Verify health
```bash
curl http://localhost:3001/health   # {"status":"ok","region":"us"}
curl http://localhost:3002/health   # {"status":"ok","region":"eu"}
curl http://localhost:3003/health   # {"status":"ok","region":"apac"}
```

## API Reference

### Create Incident
```
POST /incidents
```
```json
{ "title": "DB Outage", "description": "Primary DB down", "severity": "HIGH" }
```
Response `201` — vector clock initialized:
```json
{ "vector_clock": { "us": 1, "eu": 0, "apac": 0 } }
```

### Update Incident
```
PUT /incidents/:id
```
Must include `vector_clock`. Returns `409` if clock is stale.
```json
{ "status": "ACKNOWLEDGED", "vector_clock": { "us": 1, "eu": 0, "apac": 0 } }
```

### Resolve Conflict
```
POST /incidents/:id/resolve
```
Clears `version_conflict`, increments local clock.

### Internal Replication
```
POST /internal/replicate
```
Used by peer regions. Compares clocks and handles BEFORE / AFTER / CONCURRENT cases.

## Vector Clock Logic

| Operation | Description |
|-----------|-------------|
| **Increment** | On write: `clock[localRegion]++` |
| **Merge** | On receive: `merged[r] = max(local[r], incoming[r])` |
| **BEFORE** | Incoming is stale → ignore |
| **AFTER** | Incoming is newer → overwrite |
| **CONCURRENT** | Neither before nor after → `version_conflict = true` |

## Database Schema
```sql
CREATE TABLE incidents (
  id               UUID         PRIMARY KEY NOT NULL,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  status           VARCHAR(50)  NOT NULL DEFAULT 'OPEN',
  severity         VARCHAR(50)  NOT NULL,
  assigned_team    VARCHAR(100),
  vector_clock     JSONB        NOT NULL DEFAULT '{}',
  version_conflict BOOLEAN      NOT NULL DEFAULT false,
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);
```

## Partition Simulation
```bash
chmod +x simulate_partition.sh
./simulate_partition.sh
```

The script:
1. Creates incident in region-us → `{us:1, eu:0, apac:0}`
2. Waits for replication to region-eu
3. Sends concurrent update to region-us → `{us:2, eu:0, apac:0}`
4. Sends concurrent update to region-eu → `{us:1, eu:1, apac:0}`
5. Replicates region-us update to region-eu
6. Verifies `version_conflict: true` ✅
7. Resolves conflict → `version_conflict: false` ✅

## Environment Variables

See `.env.example`:

| Variable | Description |
|----------|-------------|
| `DB_USER` | PostgreSQL username |
| `DB_PASS` | PostgreSQL password |
| `DB_NAME_US/EU/APAC` | Per-region database names |
| `PORT_US/EU/APAC` | Host port mappings |

## Project Structure
```
incident-mgmt/
├── docker-compose.yml       # Orchestrates all 6 services
├── Dockerfile               # Builds the Node.js region service
├── package.json
├── .env.example             # Environment variable template
├── init.sql                 # DB schema (auto-applied on first start)
├── simulate_partition.sh    # Partition demo script
└── src/
    └── server.js            # Region service with vector clock logic
```

## Stopping
```bash
docker-compose down -v
```