#!/usr/bin/env bash
#
# ISS-005 — looped first-attempt Duo WebAuthn soak (repro harness).
#
# The hands-off WebAuthn ceremony INTERMITTENTLY fails on the FIRST attempt of a
# system: "Duo WebAuthn factor not found at the prompt — falling back to manual
# Duo" → a ~180s manual-Duo timeout (no phone push is ever sent on a WebAuthn
# prompt) → attempt 2 then recovers hands-off. It is rare and non-deterministic,
# so a single run almost never reproduces it. This loops `test-login` over ONE
# system N times — each iteration a FRESH browser, i.e. a fresh FIRST attempt —
# and tallies how many hit the flake.
#
# When an iteration DOES flake, the `selectDuoFactor` diagnostic added for ISS-005
# ("Duo WebAuthn factor-detection diagnostic — …") records the prompt's actual
# state at the give-up moment (url + which known screens are visible + the literal
# link labels present) in that iteration's log — so the cause (label/transport
# mismatch? screen not rendered? wrong sub-screen?) is finally diagnosable.
#
# Usage:  scripts/duo-firstattempt-soak.sh [SYSTEM] [ITERATIONS]
#   SYSTEM      one of: ucpath crm ukg kuali newkronos servicenow   (default: crm)
#   ITERATIONS  number of fresh first-attempts                       (default: 10)
#
# SERIAL by construction — never parallelize (Duo signCount is global server
# state; concurrent ceremonies collide). Requires .env creds + the enrolled
# .auth/duo-webauthn.json (hands-off Duo). Per-iteration logs land under
# generated/.duo-soak/<timestamp>/ (gitignored).
#
set -uo pipefail

SYSTEM="${1:-crm}"
ITERATIONS="${2:-10}"
TS="$(date '+%Y%m%d-%H%M%S')"
OUTDIR="generated/.duo-soak/${TS}"
mkdir -p "$OUTDIR"

FLAKE_MARK="factor not found at the prompt"
DIAG_MARK="Duo WebAuthn factor-detection diagnostic"

echo "ISS-005 first-attempt Duo soak — system=${SYSTEM} iterations=${ITERATIONS}"
echo "logs: ${OUTDIR}"
echo

flakes=0
fails=0
for i in $(seq 1 "$ITERATIONS"); do
  LOG="${OUTDIR}/iter-$(printf '%02d' "$i").log"
  printf 'iter %2d/%s ... ' "$i" "$ITERATIONS"
  HR_AUTOMATION_DUO_WEBAUTHN=1 npm run test-login -- --systems "$SYSTEM" >"$LOG" 2>&1
  rc=$?
  if grep -q "$FLAKE_MARK" "$LOG"; then
    flakes=$((flakes + 1))
    echo "FIRST-ATTEMPT FLAKE (rc=${rc}) — see ${LOG}"
    grep -n "$DIAG_MARK" "$LOG" | head -2 | sed 's/^/      /'
  elif [ "$rc" != 0 ]; then
    fails=$((fails + 1))
    echo "FAIL rc=${rc} (no factor-not-found marker) — see ${LOG}"
  else
    echo "ok (clean first attempt)"
  fi
done

echo
echo "── summary ──"
echo "  iterations:            ${ITERATIONS}"
echo "  first-attempt flakes:  ${flakes}"
echo "  other failures:        ${fails}"
echo "  logs:                  ${OUTDIR}"
if [ "$flakes" -gt 0 ]; then
  echo
  echo "Flake reproduced — inspect the prompt-state diagnostic at each failure:"
  echo "  grep '${DIAG_MARK}' ${OUTDIR}/iter-*.log"
fi
