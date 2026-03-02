#!/usr/bin/env bash
set -euo pipefail

US="http://localhost:3001"
EU="http://localhost:3002"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
section() { echo -e "\n${YELLOW}══════════════════════════════════════${NC}\n${YELLOW} $*${NC}\n${YELLOW}══════════════════════════════════════${NC}"; }

wait_healthy() {
  local url="$1/health"; local name="$2"
  info "Waiting for $name..."
  for i in $(seq 1 30); do
    if curl -sf "$url" > /dev/null 2>&1; then info "$name is up"; return; fi
    sleep 2
  done
  echo -e "${RED}[ERROR] $name not healthy${NC}"; exit 1
}

section "Step 0: Verify services"
wait_healthy "$US" "region-us"
wait_healthy "$EU" "region-eu"

section "Step 1: Create incident in region-us"
INCIDENT=$(curl -sf -X POST "$US/incidents" \
  -H "Content-Type: application/json" \
  -d '{"title":"Database Outage","description":"Primary DB unreachable","severity":"HIGH"}')
echo "$INCIDENT" | jq .
ID=$(echo "$INCIDENT" | jq -r '.id')
info "Incident ID: $ID"

section "Step 2: Wait for replication to region-eu (~12s)"
sleep 12
EU_INC=$(curl -sf "$EU/incidents/$ID" 2>/dev/null || echo "null")
if [ "$EU_INC" = "null" ]; then info "Waiting 8 more seconds..."; sleep 8; fi
EU_INC=$(curl -sf "$EU/incidents/$ID")
echo "$EU_INC" | jq '{id,vector_clock,status}'

section "Step 3: Simulate partition - concurrent updates using same base clock"
VC_BASE=$(echo "$EU_INC" | jq -c '.vector_clock')

section "Step 4: Update region-us (status=CRITICAL)"
US_UPDATE=$(curl -sf -X PUT "$US/incidents/$ID" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"CRITICAL\",\"assigned_team\":\"SRE-US\",\"vector_clock\":$VC_BASE}")
echo "$US_UPDATE" | jq '{status,assigned_team,vector_clock}'

section "Step 5: Update region-eu with same base clock (concurrent!)"
EU_UPDATE=$(curl -sf -X PUT "$EU/incidents/$ID" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"ACKNOWLEDGED\",\"assigned_team\":\"SRE-EU\",\"vector_clock\":$VC_BASE}")
echo "$EU_UPDATE" | jq '{status,assigned_team,vector_clock}'

section "Step 6: Restore partition - replicate US update to EU"
US_INC_FULL=$(curl -sf "$US/incidents/$ID")
curl -sf -X POST "$EU/internal/replicate" \
  -H "Content-Type: application/json" \
  -d "$US_INC_FULL" > /dev/null
info "Replication sent"

section "Step 7: Check for conflict in region-eu"
sleep 1
FINAL=$(curl -sf "$EU/incidents/$ID")
echo "$FINAL" | jq .
CONFLICT=$(echo "$FINAL" | jq '.version_conflict')
if [ "$CONFLICT" = "true" ]; then
  echo -e "\n${GREEN}SUCCESS: version_conflict=true${NC}"
else
  echo -e "\n${RED}FAIL: version_conflict=$CONFLICT${NC}"; exit 1
fi

section "Step 8: Resolve conflict"
RESOLVED=$(curl -sf -X POST "$EU/incidents/$ID/resolve" \
  -H "Content-Type: application/json" \
  -d '{"status":"RESOLVED","assigned_team":"SRE-Managers"}')
echo "$RESOLVED" | jq .
echo -e "\n${GREEN}Done! Conflict resolved.${NC}"
