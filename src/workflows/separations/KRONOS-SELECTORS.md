# Separations Workflow — Full Selector Map

Mapped via playwright-cli on 2026-04-01.

## Old Kronos (UKG Workforce Central)

### Dashboard → Genies Grid (widgetFrame804)
- **QuickFind search**: `locator('#searchQuery')` in widgetFrame804
- **QuickFind button**: `getByTitle('Find', { exact: true })` in widgetFrame804
- **Employee row**: `getByRole('row', { name: 'Lee, Brooklyn 10598634...' })` — click to select
- **Go To button**: `getByTitle('Selected, Current Pay Period')` — inside iframe, only appears when row selected
- **Timecards in Go To**: `getByText('Timecards', { exact: true })` — MUST be exact to avoid "Approve Timecards"

### Timecard View (widgetFrame808)
- **Employee name**: readonly combobox at top — NOT fillable, employee carried from Genies
- **Pay Period textbox**: `getByRole('textbox', { name: 'Current Pay Period' })` — click to open dropdown
- **Previous Pay Period**: `getByRole('link', { name: 'Previous Pay Period' })` — visible AFTER textbox clicked
- **Grid columns**: [chk] [chk] Date | Schedule | In | Out | Transfer | PayCode | Amount | Shift | Daily | Period
- **Grid structure**: All columns in ONE row. `cells[2]=Date, cells[4]=In, cells[5]=Out`
- **Date format**: `"Sun 3/15"`, `"Mon 3/16"` (short, no year)
- **Time detection**: Check if `cells[4]` (In) or `cells[5]` (Out) is non-empty

### Critical Flow
1. Search employee in Genies grid (QuickFind)
2. Click employee row to select
3. Click "Go To" button → click "Timecards" (exact match)
4. Timecard loads in widgetFrame808
5. Click pay period textbox → click "Previous Pay Period" link
6. Check grid for In/Out values per date row

### Gotchas
- Sidebar "Timecards" opens BLANK view — must use Go To from Genies
- Pay period textbox is readonly — but clickable via `getByRole('textbox', { name: 'Current Pay Period' })`
- "Timecards" text match must be exact — `getByText('Timecards', { exact: true })` — otherwise matches "Approve Timecards"
- Genies iframe may show "A network change was detected" — need page reload
- `force: true` may be needed for readonly inputs in some frames

## New Kronos (WFD - Workforce Dayforce)

### Employee Search (portal-frame-* iframe)
- **Employee Search button**: `getByRole('button', { name: 'Employee Search' })` on main page
- **Search input**: `getByRole('textbox', { name: 'Search by Employee Name or ID' })` in portal-frame iframe
- **Search button**: `getByRole('button', { name: 'Search', exact: true })` in portal-frame iframe
- **Checkbox**: `getByRole('checkbox', { name: 'Select Item' })` — check to enable Go To
- **Go To button**: `getByRole('button', { name: 'Go To' })` — disabled until checkbox checked
- **Timecard option**: `getByRole('option', { name: 'Timecard' })` — already selected by default, click to navigate

### Timecard View (main page, after Go To → Timecard)
- **Pay Period button**: `getByRole('button', { name: 'Current Pay Period' }).first()` — click to open dropdown
- **Previous Pay Period**: `getByRole('option', { name: 'Previous Pay Period' })` — in dropdown
- **Grid structure**: Split grid — dates in `ui-grid-pinned-container`, data in `ui-grid-viewport` (last one)
- **Date rows**: `[role='row']` in pinned container, text like `"Mon 3/16"`
- **Data rows**: `[role='row']` in viewport, parallel index to date rows
- **Time detection**: Check if data row has AM/PM timestamps (`/\d+:\d+\s*(AM|PM)/`)

### Critical Flow
1. Click "Employee Search" button
2. Fill search input, click "Search"
3. Check checkbox "Select Item"
4. Click "Go To" button → click "Timecard" option
5. Page navigates to /timekeeping#/timecard
6. Click "Current Pay Period" button → click "Previous Pay Period" option
7. Match date rows (pinned) with data rows (viewport) by index
8. Last date with AM/PM timestamps = last working date

### Gotchas
- Search sidebar stays open between docs — call `closeEmployeeSearch()` before re-searching
- "Employee Search" button resolves to 2 elements if sidebar already open — need `.first()`
- Grid is SPLIT: dates and data in different DOM containers, matched by row index
- AM/PM timestamps (e.g., "8:33 AM") indicate actual punches; decimal values (e.g., "4.00") are totals

## UCPath Smart HR Transaction (Termination)

### Smart HR Transactions Page (iframe `#main_target_win0` or `iframe[title="Main Content"]`)
- **Select Template**: `getByRole('textbox', { name: 'Select Template' })`
- **Effective Date**: `getByRole('textbox', { name: 'Effective Date' })`
- **Create Transaction**: `getByRole('button', { name: 'Create Transaction' })`

### Enter Transaction Details
- **Empl ID**: `getByRole('textbox', { name: 'Empl ID' })`
- **Reason Code**: `getByLabel('Reason Code').selectOption(['Resign - Accept Another Job'])`
- **Continue**: `getByRole('button', { name: 'Continue' })`

### Enter Transaction Information (after Continue)
- **Position Number**: textbox (disabled) — auto-filled
- **Business Unit**: textbox (disabled) — auto-filled (e.g., "SDCMP")
- **Department**: textbox (disabled) — auto-filled (e.g., "000412")
- **Last Date Worked**: `getByRole('textbox', { name: 'Last Date Worked' })`
- **Comments**: `getByRole('textbox', { name: 'Comments' })`
- **Initiator Comments**: `getByRole('textbox', { name: 'Initiator Comments:' })`
- **Transaction ID**: label `"Transaction ID:"` followed by value element (shows `NEW` before submit, `T002XXXXXX` after)
- **Save and Submit**: `getByRole('button', { name: 'Save and Submit' })` — TWO exist, use `.first()`
- **Save for Later**: `getByRole('button', { name: 'Save for Later' })`

### Submit Confirmation
- **OK button**: `getByRole('button', { name: 'OK' })`

### Transaction Number Extraction Flow
1. Click Save and Submit (`.first()`)
2. Wait for Submit Confirmation page
3. Click OK → returns to Smart HR Transactions list
4. Click employee name link in Transactions in Progress
5. Click Continue
6. Transaction ID field now shows actual number (e.g., `T002114817`)
7. Extract via: `body.innerText().match(/Transaction ID:\s*(T\d+)/)`
8. **Or** via awThreadBoxTitle: `body.innerText().match(/Transaction:\s*(T\d+)/i)`

## Kuali Separation Form

### Form Fields (mapped via playwright-cli)
- **Employee Name**: `textbox "Employee Last Name, First Name*"` (readonly)
- **EID**: `textbox "EID*"` (readonly)
- **Last Day Worked**: `textbox "Last Day Worked*"`
- **Separation Date**: `textbox "Separation Date (Last day actively employed)*"` — matches `/Separation Date/`
- **Type of Termination**: `combobox "Type of Termination*"` — use `.evaluate()` to get selected text
- **Location**: `textbox "Location *"` (optional, 3s timeout)
- **Termination Effective Date**: `textbox "Termination Effective Date*"`
- **Request Acknowledged**: `checkbox "Request Acknowledged - In Progress"`
- **Timekeeper Name**: `textbox "Timekeeper Name:*"`
- **Department**: `combobox "Department*"` — best-match substring selection
- **Payroll Title Code**: `textbox "Payroll Title Code*"`
- **Payroll Title**: `textbox "Payroll Title*"`
- **Submitted Termination Template**: `checkbox "Submitted Termination Template"`
- **Transaction Number**: `textbox "Transaction Number:*"`
- **Final Pay - Student**: `radio "Does not need Final Pay (student employee)"`
- **Timekeeper/Approver Comments**: `textbox "Timekeeper/Approver Comments:"`
- **Save**: `button "Save"`
- **Action List**: `menuitem "Action List"`
