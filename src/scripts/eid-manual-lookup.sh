#!/bin/bash
# Quick EID lookup helper — searches by EID and extracts key fields from snapshot
# Usage: bash src/scripts/eid-manual-lookup.sh <eid>
# Requires an authenticated playwright-cli session named "eid" on the Person Org Summary search page

EID="$1"
if [ -z "$EID" ]; then
  echo "Usage: $0 <eid>"
  exit 1
fi

echo "=== Searching EID: $EID ==="

# Clear form
playwright-cli -s=eid eval "(()=>{ const doc = document.querySelector('#main_target_win0').contentDocument; const btns = doc.querySelectorAll('input[type=button]'); for (const b of btns) { if (b.value === 'Clear') { b.click(); break; } } })()" 2>&1 | head -1

sleep 2

# Fill EID and search
playwright-cli -s=eid eval "(()=>{ const doc = document.querySelector('#main_target_win0').contentDocument; const inputs = doc.querySelectorAll('input[type=text]'); for (const i of inputs) { if (i.id.includes('EMPLID') || i.id.includes('Empl')) { i.value = '$EID'; i.dispatchEvent(new Event('change', {bubbles:true})); break; } } })()" 2>&1 | head -1

# Use playwright fill for proper PeopleSoft event handling
playwright-cli -s=eid eval "(()=>{ const doc = document.querySelector('#main_target_win0').contentDocument; const inputs = doc.querySelectorAll('input[type=text]'); return Array.from(inputs).map(i => i.id + '=' + i.value).join(', '); })()" 2>&1

sleep 1

# Click search
playwright-cli -s=eid eval "(()=>{ document.querySelector('#main_target_win0').contentDocument.querySelector('#PTS_CFG_CL_WRK_PTS_SRCH_BTN').click(); })()" 2>&1 | head -1

sleep 6

# Extract key info from snapshot
playwright-cli -s=eid snapshot 2>&1 | grep -oP "(ORG Instance|Termination|Last Hire|Department Description|Payroll Status|Position Number|Dept ID|Empl Class).*?(?=Assignments|Personalize)" | head -20

echo "=== Done ==="
