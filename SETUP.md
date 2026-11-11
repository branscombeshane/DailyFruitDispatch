# Daily Fruit - Dispatch: Setup Guide

This follows the same pattern as the Procure and Packing & Production systems:
a static frontend on GitHub Pages, backed by a Google Apps Script Web App and
a Google Sheet as the database.

## 1. Create the Dispatch Google Sheet + Apps Script project

1. Create a new Google Sheet (e.g. "Daily Fruit - Dispatch Data").
2. Extensions > Apps Script, to open a bound Apps Script project.
3. Delete the default `Code.gs` content and paste in this repo's `Code.gs`.
4. Create a new HTML file named exactly `index` (Apps Script strips the
   extension) and paste in this repo's `index.html`.
5. Open Project Settings (gear icon) and paste this repo's `appsscript.json`
   content into the manifest (enable "Show appsscript.json" first if hidden).
6. In the Apps Script editor, select the `setupSpreadsheet` function from the
   function dropdown and click **Run** once. Approve the permission prompts.
   This creates all the tabs (Checkers - shown as "Users" in the app, Trucks,
   Drivers, TruckSessions, OrderChecks, ItemChecks, Settings,
   CollectedOrders), and creates a default Admin login
   (Name **Admin**, PIN **1234**) so you can sign in and set everything else
   up.

## 2. Deploy as a Web App

1. Deploy > New deployment > type: **Web app**.
2. Execute as: **Me** (so it can always read the Packing sheet regardless of
   who's using Dispatch on the floor).
3. Who has access: **Anyone**.
4. Deploy, and copy the Web App URL - this is what GitHub Pages will
   redirect/embed to, same as the other two systems.

Any time you change `Code.gs` in the Apps Script editor, you need to create
a **new deployment version** (Deploy > Manage deployments > edit > new
version) for changes to go live - the Web App URL stays the same across
versions.

**Important:** this app's `index.html` is the copy that lives on GitHub
Pages, not the one served by Apps Script - open `index.html` and set
`CONFIG.API_URL` near the top of the `<script>` block to the Web App URL
from step 2 above (it ends in `/exec`), then push that change to GitHub.
Until that's set, the app can't reach its backend.

## 3. Connect it to Packing & Production's orders

Once deployed, open the app and sign in with the default Admin login (Name
**Admin**, PIN **1234** - see step 1 above), then go to **Data Source**:

1. Paste the Packing & Production Google Sheet's URL or ID (the Sheet
   itself, not its Apps Script Web App URL).
2. Click **Connect & Save**.

That's it - unlike the first version of this build, the tab names and
column names are hardwired into `Code.gs` to match Packing & Production's
actual layout (confirmed with Shane): a Google Sheet with two tabs,
**Orders** (OrderID, SageRef, CustomerName, DeliveryDate, plus other order
header fields) and **OrderItems** (OrderID, Description, Department, Qty,
Unit, plus others), joined on `OrderID`. "Today's orders" means rows in
`Orders` whose `DeliveryDate` is today; the order number shown to checkers
is `SageRef` (the human-readable invoice ref), since `OrderID` itself is an
internal identifier not meant for searching by.

Dispatch only ever *reads* from that sheet - it never writes back to it.

If Packing & Production's sheet layout ever changes (a renamed tab or
column), update the `ORDERS_TAB_NAME`, `ORDER_ITEMS_TAB_NAME`,
`ORDERS_COLUMNS`, and `ORDER_ITEMS_COLUMNS` constants near the top of the
Data Source section in `Code.gs` to match - Connect & Save will report
exactly which tab or column it can't find if that ever drifts out of sync.

One column is read differently from the rest: `RequiresCoa` on `Orders`
(Packing & Production's "does this order need a Certificate of Analysis"
flag - see **Checking an order** below for what it drives) is looked up
*optionally*, via `ORDERS_OPTIONAL_COLUMNS`. If that column is missing -
mid-rollout on Packing's side, or renamed - Dispatch doesn't error out the
way it would for any column above; every order just comes through with no
COA gate applied, same as if none of them required one.

**Hidden Customers (build-2026-11-01-01):** an optional **`HiddenCustomers`**
tab on the same Packing & Production spreadsheet - column A, one customer
name or fragment per row, no header needed - lets you keep certain customers
out of Dispatch entirely. This is for orders that technically pass through
Sage but should never actually be checked or dispatched as a real delivery -
an internal/own-company invoice, for example. Any order whose `CustomerName`
*contains* a listed name (case-insensitive; a listed fragment under 3
characters is ignored outright, so a short entry can't accidentally match
everything) is left out of Dispatch completely - it never shows up on the
Trucks board, in search results, on the Dashboard, or anywhere else, exactly
as if Packing & Production didn't have it at all. This mirrors Packing &
Production's own Hidden Customers feature (same matching rule, deliberately,
so the two systems can't disagree about who's hidden) and reads that exact
same tab - add a name there once and it's hidden from both systems at once.
If the `HiddenCustomers` tab doesn't exist yet, nothing is hidden and every
order shows normally; this is opt-in, not something you need to set up to
use Dispatch at all.

## 4. Set up users, trucks, and drivers

Still in Admin:

- **Users**: one sign-in screen (name + PIN) for everyone - Checkers,
  Dispatch Managers, Customer Care, and Admins alike. Add each person's name
  and a PIN, and pick their role from the dropdown; that role is the only
  thing that decides what they see after signing in:
  - **Checker** - the Trucks board (as of build-2026-10-26-06, the exact
    same board a Dispatch Manager or Admin gets - Scorecard included, full
    drag-and-drop over Unassigned Orders, not a read-only view), plus truck
    checking. No Dashboard, History, or Settings access.
  - **Dispatch Manager** - the restricted Dashboard, plus truck checking
    (see below).
  - **Customer Care** - only the order lookup ("which truck is this order
    on, and who's driving") - nothing else at all, not even a truck list.
    Meant for whoever answers "where's my order" calls, without handing
    them any ability to check, dispatch, or edit anything.
  - **Admin** - everything, including truck checking (see below).

  Every field - name, PIN, role, active - is editable directly in the
  table, same as Trucks below, and a user can be removed with the Delete
  button next to them. There must always be at least one active Admin -
  demoting, deactivating, or deleting the last one is blocked, so promote
  someone else to Admin first if you need to step back from that role
  yourself. A brand-new Dispatch sheet gets a default Admin login seeded
  automatically (Name: `Admin`, PIN: `1234`) - sign in with that once, then
  either use it going forward or add your own named Admin user and
  demote/retire the default one (once a second Admin exists, you can). A PIN
  starting with 0 (e.g. `0456`) is stored exactly as typed - the PIN column
  is forced to Plain Text so Sheets can't quietly reinterpret it as a Number
  and drop the leading zero. **One-time step:** re-run `setupSpreadsheet`
  after pasting in this version of `Code.gs` so it applies that Plain Text
  formatting to the column; if anyone's PIN already lost its leading zero
  before this fix, that specific PIN needs to be re-typed once via Users
  (the zero is already gone from the sheet - reformatting can't bring it
  back, only prevent it happening again).
- **Trucks**: your fleet (from Truck_List.xlsx) is pre-loaded - run
  `seedInitialTrucks` once from the Apps Script editor's function dropdown
  (same way you ran `setupSpreadsheet`) and all 26 trucks are added in one
  go. It's safe to run more than once - trucks already on file (matched by
  registration) are skipped, not duplicated. After that, every field
  (name, registration, type, active) is editable directly in the Trucks
  table - click a field to change it, changes save automatically - and a
  truck can be removed with the Delete button next to it. Use the "Add
  truck" form for anything added one at a time later. Driver(s) and Route
  are *not* set here - each is entered by the checker every time they load
  a truck (drivers rotate between trucks and a truck's route can change
  trip to trip, so both are captured per trip rather than fixed to the
  truck). A truck can have up to 4 drivers on a given trip (see **Drivers**
  below), and a contact number is required for each driver entered - it's
  shown right next to that driver's name everywhere a driver shows up (the
  truck workspace, Select a Truck, Customer Care's order search, and the
  Admin dashboard), so whoever's reading it knows exactly which number
  reaches which driver.
  **One-time step:** re-run `setupSpreadsheet` after pasting in this
  version of `Code.gs` so the new DriverContacts column gets its header
  added to the sheet.
- **Drivers**: a pre-set-up list of drivers with their contact numbers, so a
  checker doesn't have to re-type the same name and number every time the
  same driver goes out. Add a driver's name and contact number here once;
  every field is editable directly in the table (click to change, saves
  automatically) and a driver can be removed with the Delete button next to
  them, same as Trucks and Users. Shane's initial driver list (46 names, real
  contact numbers not yet on hand) is pre-loaded the same way the truck
  fleet is - run `seedInitialDrivers` once from the Apps Script editor's
  function dropdown (same way you ran `seedInitialTrucks`/`setupSpreadsheet`)
  and every driver is added in one go, each with a placeholder Contact of
  `0` and marked Active. Update each Contact directly in the Drivers table
  as the real numbers come in - editing a seeded driver works exactly like
  editing one added by hand. It's safe to run more than once - a name
  already on file (matched case-insensitively) is skipped, not duplicated -
  so re-running it later with more names added is fine too. Marking a driver **Active** off (instead
  of deleting them) keeps their trip history intact but drops them from the
  dropdown for new trips - use that for someone who's left rather than
  deleting them outright if they've driven trips on record before. A
  contact number starting with 0 is stored exactly as typed here too, same
  fix and same reason as the PIN column above (Sheets would otherwise
  quietly read it as a Number and drop the leading zero) - this also covers
  the contact number typed directly into a trip's driver entry (the
  `DriverContacts` column on `TruckSessions`), not just this Drivers list.
  **One-time step:** re-run `setupSpreadsheet` so both columns get that
  Plain Text formatting; a number that already lost its leading zero before
  this fix needs to be re-typed once (the zero is already gone from the
  sheet - reformatting can't bring it back, only prevent it happening
  again).
  When starting or editing a truck's trip, the driver screen now offers
  **3 dropdowns** pre-populated from this list - picking a name
  auto-fills their contact number (still editable, in case it's changed for
  that trip) - **plus one extra manual name/number field** for a driver who
  hasn't been added to the list yet (a new starter, or a once-off relief
  driver). That manual entry doesn't get added to the Drivers list
  automatically; add them here afterwards if they'll be driving regularly.
  **One-time step:** re-run `setupSpreadsheet` after pasting in this
  version of `Code.gs` so the new `Drivers` sheet gets created.
  These driver dropdowns (and the couple of other dropdowns elsewhere in
  the app, like the user-role picker) used to be left in the browser's own
  default look - square corners, a heavier black border - while every text
  field next to them got the app's usual rounded, light-border style,
  reported as "looks odd". Fixed to match everywhere at once.

There used to be a **No-Stock Reasons** tab here too (a pre-seeded,
editable list of reasons a checker picked from when marking an item No
Stock). It's been removed entirely, per Shane's request - "No Stock" is now
a single tap with no reason step (see **Checking an order** below), so
there was nothing left to manage. The `NoStockReasons` sheet itself is left
alone if it already existed (nothing deletes it), it just isn't read from
or written to any more.

(There's now a direct **Settings** shortcut button on the Trucks board too
- see **Dispatch Manager role, and Admin's access to Trucks** below.)

## Admin Dashboard, and History

Admin's navigation is split into three top-level buttons - **Dashboard**,
**History**, and **Settings** - sitting right in the dark green top bar
next to Trucks/Log out, not inside the scrollable page content below, so
they're always in the same place regardless of which section you're in.
Settings then opens a second row of its own tabs (Users, Trucks, Drivers,
Data Source) at the top of the content area under it, and remembers
whichever of those you were last looking at, so switching back to Dashboard
(or History) and then back to Settings again returns you to the same tab
instead of always resetting to Users. A Dispatch Manager only ever sees the
Dashboard button - no History and no Settings (see **Dispatch Manager
role** below).

**Dashboard** (what you land on by default) always shows *today* - it has
no date picker of its own any more and never shows any other day, same
split as the Packing & Production board's live view being kept separate
from a past-day lookup. It gives a view of today's trucks: how many
started, how many are dispatched vs. still in progress, total orders
checked, total no-stock items, total **short-packed items** (see below),
and how many trucks were dispatched with unresolved warnings overridden.
Below that, every truck active today gets a card showing its checker,
driver(s), route, tray counts by size (Small/Medium/Large/Other), timing,
and a breakdown of each order it checked (packed vs. no-stock vs.
short-packed). A truck that was dispatched despite open warnings (no
driver, no route, or no tray counts entered) is highlighted so you can spot
it at a glance - that's the main "something was rushed" signal to watch
for. Dispatching with an order still unchecked isn't one of these any more
- see **Dispatch is blocked until every order (and Job) is checked** below,
that one's a hard stop with no override at all. It also shows today's
**Jobs** for the day, across all trucks (see **Jobs: a non-order task
added to a truck's own trip** below), and today's "orders due" vs.
dispatched/collected/outstanding/overdue breakdown as a row of tappable
tiles (see **Clickable stat tiles** below and **Dispatch Manager role**
below) - nothing from that breakdown sits permanently on the page any more,
so the Dashboard stays short and scannable until you actually tap into
something.

**"No fruit trays on this trip" (2026-09-16):** a checkbox in a truck's
Fruit Trays tab, for trips - often a truck's 2nd dispatch of the day - that
genuinely carry none. Ticking it greys out and disables the four numeric
tray fields (clearing any values already entered), and the dashboard shows
**"Trays: none (marked)"** for that trip instead of "Trays: not entered" -
so a deliberately-empty trip is never flagged the same way a genuinely
forgotten tray count is, and doesn't count toward "dispatched with
warnings" either.

**History** is a separate tab for everything that isn't today. It shows
the exact same layout as Dashboard - trucks, and the orders due/dispatched/
collected/outstanding/overdue tile row - but for whichever day you pick
with its own **Viewing** date picker (defaults to yesterday when you first
open it, since today already has its own tab, but you can pick any day
including today for comparison). Picking a date there updates the *whole*
History tab together: the truck-by-truck section and the orders-due tile
row both move to that same date at once. Viewing a past day reframes
"overdue" as "overdue as of that day" too - an order due exactly on the day
you're viewing shows up as that day's own order, not as overdue relative to
itself. Use this for a customer calling about a delivery from last week, or
checking how a previous day went - Dashboard itself never changes to show
it.

**Find an order:** on the Dashboard tab, a search box lets you type an
order number or customer name to find which truck (and which day) an order
actually went out on - not limited to today, since it's a lookup across all
history, not a snapshot of one day. Handy for tracing a specific delivery
without switching to History and paging through the Viewing picker day by
day. Only orders that were actually allocated to a truck at some point will
show up here - it's a lookup of dispatch history, not a search of Packing &
Production's full order list (that's what **+ Add Order** on the truck side
is for). It stayed on Dashboard rather than moving to History since it
isn't tied to "today" or to any one day at all. Each result also shows the
**driver** and **route** for that trip, when there is one to show (fixed
2026-09-26 - the lookup always had this data, but the result card never
displayed it; Customer Care's own search, further down, already did).

**Search this day's orders (2026-09-22):** a second, different search box,
this one on the History tab itself, right above the truck list. Unlike
Dashboard's "Find an order" above - which searches *every* day at once from
the server - this one is a quick filter over whatever day you've already
picked: type an order number or customer and the truck-card list below
narrows, as you type, to just the trucks with a matching order, trimming
each shown truck down to only its matching order(s) too (the same way the
No-stock items/Short-packed items tiles below already narrow a truck's
orders). Nothing to load - it's filtering data already on the page, so
there's no delay. A **Clear** button (or just emptying the box) brings
everything back, and picking a different day in the **Viewing** picker
above automatically clears the search too, so a query typed for one day
never silently carries over and hides everything on the next. Can be
combined with the stat tiles below it - e.g. filter to "Dispatched" trucks
first, then search within those - since the two are independent filters
that both narrow the same list together. Use Dashboard's "Find an order"
instead when you don't already know which day to look on.

**Clickable stat tiles (build-2026-09-16-03; Outstanding/Overdue folded in
2026-09-19):** every number tile across Dashboard and History -
Trucks/Dispatched/In progress/Orders checked/No-stock items/Short-packed
items/Dispatched with warnings, and separately Orders due/Dispatched/
Collected/Outstanding/Overdue - can now be tapped to drill into exactly
what it's counting, instead of being a plain number you'd otherwise have to
scroll the truck list to make sense of. This applies on both Dashboard and
History independently (tapping a tile on one never affects the other), and
it's all done from data already on the page - no extra loading or server
round trip per tap.

- Tapping **Trucks/Dispatched/In progress/Orders checked/Dispatched with
  warnings** filters the truck-card list below down to just the trucks
  that tile is counting - e.g. "Dispatched" shows only dispatched trucks,
  hiding the rest. A bar above the (now shorter) list names which filter is
  active and how many trucks matched, with a **Show all trucks** button to
  clear it. Tapping the same tile again also clears it.
- Tapping **No-stock items** or **Short-packed items** does the same
  truck-level filtering, but goes one step further: within each truck card
  that's still shown, only the specific order(s) actually causing that
  count are listed - a truck flagged for 1 no-stock item out of 10 orders
  checked won't dump all 10 into view, just the 1 that matters.
- Tapping **Orders due/Dispatched/Collected** (the second row of tiles)
  opens a read-only panel right below the tiles listing that tile's own
  orders (order number, customer, and a status badge), with a **Close**
  button.
- Tapping **Outstanding** or **Overdue** opens that same panel, but with
  each order's own **Mark Collected** button right there instead of a
  read-only badge - this is now the *only* place those two lists appear.
  They used to sit permanently on the page below the tiles (Outstanding)
  and as their own red card further down (Overdue), which Shane asked to
  have decluttered (2026-09-19); folding both into the tile row they were
  already sitting next to means the Dashboard shows nothing extra until you
  actually tap into it, and outstanding orders are never listed in two
  places at once the way they briefly were. The Overdue tile (and its
  panel's heading) turns red/alert-styled when there's anything to chase,
  same as Outstanding already did.
- Selected state is per-tile-row and per-tab - switching between Dashboard
  and History, or between the two tile rows, keeps each one's own last
  selection until you change it or reload the page.

**Flagged Packing Issues, and Truck Issues (2026-09-16, updated
2026-09-22):** two more checklist cards, sitting right below the existing
**Jobs** card on both Dashboard and History, each idSuffix-aware the same
way every other Dashboard/History pair in this app is (picking a date on
History never touches what Dashboard is showing, and vice versa). Neither
card appears at all when there's nothing to show - no empty "(0)" card
cluttering the page.

- **Flagged Packing Issues** lists every item a checker flagged (see **Flag
  Issue** under **Checking an order** above) - which product, which
  truck/order/customer it was on, the checker's note, and when and by whom
  it was flagged.
- **Truck Issues** lists every issue reported through the mandatory
  truck-issues prompt (see **Truck issues: a mandatory check before
  loading orders** below) - which truck, the note, and when and by whom it
  was reported. This one's specifically meant for Dispatch Managers to work
  through, though anyone who can see the Dashboard sees the card.

**These two cards behave differently from every other Dashboard/History
pair in the app:** the **Dashboard** version of each card shows *every
still-open flag or issue, regardless of which day it was raised* - it
stays on the Dashboard until someone actually resolves it, even if that
takes several days, rather than quietly disappearing at midnight. Because
an entry can now be from any day, each line shows a date alongside the
time ("Flagged 18 Sep, 14:32" rather than just "14:32" - fixed 2026-09-28
after this date showed as "Invalid Date" on both cards; the backend was
sending back whatever raw value the sheet's Date column already held
instead of the plain day it always writes there). The **History**
version keeps its old behavior unchanged - pick a day and see exactly
what was flagged/reported on that specific day, resolved or not, as an
accurate record of that day. The **Jobs** card is deliberately not part of
this change and still works the old date-scoped way on both Dashboard and
History, since a Job always gets resolved the same day it's added.

Both checklists are **non-blocking, not hard blocks** - flagging a packing
issue or reporting a truck issue never affected whether that truck could
dispatch (see **Dispatch is blocked until every order (and Job) is
checked** below for the one feature that IS a hard block). Each entry has
its own **Resolve** button that ticks it off (and an **Undo** button once
resolved, in case it was ticked by mistake) - purely bookkeeping for
whoever's working through the list, the same "toggle it back and forth"
pattern Jobs' Mark Done/Undo already uses. Resolving one immediately drops
it off the Dashboard's checklist, no matter how old it was.

**One-time step:** re-run `setupSpreadsheet` after pasting in this version
of `Code.gs` so the new `PackingIssues` and `TruckIssues` sheets get
created, and the `TruckSessions` sheet picks up its new
`TruckIssuesPrompted` column (see below) - safe to re-run any time, it only
adds what's missing.

## Dispatch Manager role, and Admin's access to Trucks

There's no separate login for this any more - see **Users** in step 4
above. Give someone the **Dispatch Manager** role there and they sign in on
the exact same name+PIN screen as everyone else. A Dispatch Manager can do
both of the following:

- **Assign orders to trucks each morning** on the Trucks board (see
  **Assigning orders: the Trucks board** below) - signing in takes them
  straight there instead of the plain truck list a Checker gets.
- **Dispatch trucks themselves** too, exactly like a Checker - tapping a
  truck's name on the board opens the same workspace (Fruit Trays, Orders,
  Mark truck as Dispatched) a Checker uses. A **Dashboard** button on the
  board (and a matching **Trucks** button on the Dashboard itself) lets
  them jump back and forth between assigning/running trucks and checking
  the Dashboard, without logging out and back in.
- **See the Dashboard** (today only), with no History and no Settings
  button at all - so no past-day lookups, and no Users, Trucks, Drivers, or
  Data Source either. Use this role for whoever is responsible for
  confirming everything went out at the end of the day (and can pitch in on
  assigning/dispatching when needed), without handing them the rest of
  Admin.

**A Checker's access to this same board (build-2026-10-26-06):** signing in
as a Checker now also goes straight to the Trucks board, not a separate,
plainer truck list - the same Scorecard, and the same full drag-and-drop
over Unassigned Orders, that a Dispatch Manager or Admin gets. The only
difference is what stays hidden: a Checker never sees a Dashboard button,
a Trucks/Settings button pair, or any of Users/Trucks/Drivers/Data Source -
they can assign orders to trucks and check/dispatch them, but can't see
Dashboard metrics, History, or reach Settings. Shane's call (via
AskUserQuestion) was full drag-and-drop rather than a read-only board, on
the reasoning that a checker who spots an obviously wrong assignment
shouldn't have to track down a Dispatch Manager just to move it.

A full **Admin** login gets the same **Trucks** button on the Admin
screen's topbar, next to Log out - tapping it goes to the same Trucks board
a Dispatch Manager gets (not the plain Checker list), with a **Dashboard**
button there to switch back into Admin. So an Admin can assign orders or
jump in and check/dispatch a truck themselves whenever needed, without
needing a separate Dispatch Manager or Checker login for it. An Admin also
gets a **Settings** button right there on the Trucks board (Dispatch
Manager doesn't - they have no Settings access at all, per above), so
Users/Trucks/Drivers/Data Source are one tap away from the board instead of
needing a detour through Dashboard first; it opens straight to whichever
Settings tab was last open.

**One-time setup step:** the `Role` column on the Users sheet and the new
`CollectedOrders` sheet (see below) are added by `setupSpreadsheet()` - if
you're updating an already-deployed Dispatch sheet rather than starting
fresh, re-run `setupSpreadsheet` once from the Apps Script editor's function
dropdown after pasting in the new `Code.gs`. It's safe to re-run any time -
it only fills in what's missing (existing checkers are automatically kept
as the Checker role), it never touches existing data.

On the Dashboard (and on History, for a past day), above the truck-by-truck
summary, there's an **"Orders due - dispatched vs outstanding"** card: a
count of every order due for delivery on that tab's date (today on
Dashboard, whichever date is picked on History) from Packing & Production,
how many have actually gone out on a dispatched truck, how many were
collected by the customer directly (see below), how many are still
outstanding, and how many are overdue - each as its own tappable tile (see
**Clickable stat tiles** above). Overdue means any order due *before* that
date that still hasn't gone out or been collected - tapping its tile lists
them by name, going back up to 30 days before the viewed date, so nothing
from weeks ago quietly falls off the radar, but the check doesn't scan the
entire order history forever either. The Overdue tile turns red the moment
there's anything on it, so it's visible at a glance even collapsed.

**Collected orders:** some customers collect their order directly instead
of it going out on a truck. Tapping **Outstanding** or **Overdue** lists
those orders by name, each with its own **"Mark Collected"** button right
there - tapping it records the collection, and that order then counts as
accounted for and drops off both lists, instead of sitting there looking
like something was missed.

## Assigning orders: the Trucks board

This replaced the old "everyone self-serves via + Add Order" approach with
an explicit step: whoever assigns orders - a Dispatch Manager, an Admin, or
(as of build-2026-10-26-06) a Checker too - opens the **Trucks** board and
drags each of today's orders onto the truck it should go out on. Signing in
as any of those three roles goes straight to this board (tapping **Trucks**
from the Admin Dashboard gets there too) - there's no separate, plainer
truck list left for anyone to fall back to; everyone who checks trucks sees
the same board, with Dashboard/History/Settings still hidden for a Checker
exactly as before (see **Dispatch Manager role, and Admin's access to
Trucks** above for exactly what each role can and can't see here).

The board has two columns: every truck on the left, and every one of
today's orders that isn't on a truck yet ("Unassigned") on the right.
Dragging an order onto a truck assigns it there - if that truck has no trip
started yet today, one is created automatically, the same as if a checker
had just tapped into it. Dragging an order onto a *different* truck moves
it (its checking starts over from Pending on the new truck, same as the
existing Unallocate flow always did). Dragging it back onto Unassigned
removes it from whichever truck it was on. Tapping a truck's name (rather
than dragging) opens it for checking, exactly like tapping it on the plain
truck list would.

A truck that's already dispatched today still shows its orders on the
board, greyed out and unmovable - they're there so the board isn't
misleadingly empty for a truck that's already gone, but an order can't be
dragged off a truck that's physically left with it already. Its card also
shows **when** it dispatched and **who** dispatched it (e.g. "Dispatched
14:32 by Thabo"), alongside its **driver** (e.g. "Driver: Lucas (082 000
1111) &middot; Dispatched 14:32 by Thabo") - handy for confirming a truck
actually left when it was supposed to, and who was driving it, without
having to open it. (Fixed 2026-09-26 - a truck with only one trip today
used to show nothing but the dispatch time/checker once dispatched, with
the driver silently dropping off the card; the same fix already covered a
truck with more than one trip today, see below.)

If a truck has **more than one trip today**, its card shows each trip as
its own numbered "Trip 1"/"Trip 2" block instead of collapsing them into a
single line - each with its own status and driver, AND (once Dispatched)
who/when it dispatched shown alongside the driver, not instead of it -
fixed 2026-09-16 after a live report that a 2-dispatch truck's driver
details disappeared entirely once both trips were marked Dispatched; each
trip's own orders are nested underneath it too, so it's clear which order
actually went out on trip 1 versus trip 2, not just that there were two
trips. This
originally only existed on the plain **Select a truck** screen a Checker
sees; the board's card used to only ever show the single most-recent
dispatch with every order pooled together regardless of which trip it was
on, which made an earlier trip's own orders effectively invisible from the
board (a live report that "the trip separation update isn't showing"
turned out to be exactly this - the fix had gone to the checker's list but
not the board that's actually used each morning; a follow-up report then
asked specifically to see which orders went with which trip). Both screens
now show the same per-trip breakdown, just laid out to fit their own card
size - the board's version keeps its normal draggable order chips inside
each trip's block rather than the checker list's read-only rows.

Checkers still have **+ Add Order** inside a truck's own workspace, for an
order that prints in Packing & Production *after* the morning round - they
don't need to track down the Dispatch Manager for a genuine straggler. The
board and + Add Order both end up calling the same underlying
assignment, so an order assigned either way behaves identically; it's just
two different ways to reach it depending on when it shows up.

This also substantially addresses the old "nothing tells a checker which
orders belong on their truck" gap (see the note under **Checking an order**
below) - a checker opening their truck now normally finds its orders
already there, rather than having to search and self-allocate every one of
them.

Two more things make the board easier to use on a busy morning with a lot
of trucks or a lot of orders:

- **Search boxes above each column.** The one above Trucks filters by
  truck name, registration, or type; the one above Unassigned Orders
  filters by order number or customer. Both filter instantly as you type,
  purely on what's already loaded - no extra server round trip - and
  clearing a box brings everything back.
- **The page auto-scrolls while you're holding an order**, if the truck
  you want is scrolled out of view. Drag an order near the top or bottom
  edge of the screen and the page scrolls that way on its own, even if you
  hold your finger/mouse still right at the edge - keep holding until the
  right truck comes into view, then drop.

**Auto-refresh (build-2026-09-15-01):** with several Dispatch
Managers/checkers likely to have this same board open at once, it now
quietly refetches itself every 15 seconds for as long as the screen stays
open - so one person's drag-and-drop, or a checker finishing an order
elsewhere, shows up for everyone else without anyone needing to leave the
screen and come back. It stops the instant you navigate anywhere else in
the app (Dashboard, a truck, Settings, ...), so it's never running
somewhere you can't see it or racing a screen that's since moved on. A
refresh is skipped outright (not attempted at all) while you're
mid-drag or while a chip you just dropped is still saving, so it can
never yank an order out from under your cursor or overwrite a "saving..."
chip before its own save finishes - it just resumes on the very next tick
once you're done. If a refresh fails (a dropped connection, say) it fails
silently and simply tries again 15 seconds later, rather than popping an
error every time - your own explicit actions (opening the board, dragging
an order) still show a normal error if something genuinely goes wrong.

**Quiet refresh (build-2026-09-16-04):** that same every-15-seconds refresh
used to pop up the app's global "Loading..." overlay each time, the exact
same dimmed pill-with-spinner you see after tapping a real button - which
meant it flashed on screen every 15 seconds whether or not anything had
actually changed, reported as distracting. The refresh itself still runs
exactly the same as before (still every 15s, still skipped mid-drag/mid-
save, still fails silently) - it just no longer shows that overlay for
itself. Opening the board for the first time (or navigating back to it)
still shows the overlay normally, since that really is a moment you're
waiting on something; it's only the recurring background tick that's now
quiet.

## Dispatch Timeline, Scorecard, and on-time tracking

Two related features, both built from the same underlying "how long did
this truck take to load" measurement (`buildDispatchTimelineAndScorecard_`
in `Code.gs`), plus a live warning for a trip that's taking too long and a
small addition to the truck cards themselves:

**Today's Scorecard (build-2026-10-26-01/02, moved here 2026-10-26-04)**
sits in the banner at the top of the Trucks board itself - it started out as
a column at the bottom of the Dashboard, but moved here since it's most
useful right where orders are being assigned each morning. It ranks
everyone who's dispatched a truck today by their average pack-to-dispatch
time, fastest first - timed from the moment the *first* order was dropped
onto the truck, through to the moment it was actually marked Dispatched. A
trip carrying only trays or a Job, with no real order on it at all, still
gets a genuine timed gap rather than a blank "-" (build-2026-10-26-04) - it
falls back to the truck session's own start time instead. Tapping a name on
the Scorecard (build-2026-10-27-01) opens a small modal listing exactly
which trucks and times sit behind that person's average, so the ranking is
never just a number to take on faith.

**Dispatch Timeline** is the same underlying data shown per-truck instead of
per-dispatcher, and it lives on the Dashboard (and, as of build-2026-10-27-04,
on History too, so a past day's timeline can be reviewed the same way)
rather than on the Trucks board. Each entry carries two independent badges:
a speed badge for the pack-to-dispatch gap itself (green at 5 minutes or
under, amber up to 15 minutes, red beyond that - Shane's own call, explicitly
a starting point to tune later rather than a fixed target), and a separate
on-time clock-time badge (green by 06:15, amber up to 07:00, red after that -
build-2026-10-27-04/05). A truck's 2nd or later trip of the day deliberately
gets no on-time badge at all, since "on time" only means something for the
first trip out. A **Trucks Leaving Late** card on the Dashboard
(build-2026-10-27-05) separately flags any truck with 3 or more late
first-trip dispatches in the last 30 days, so a repeating pattern surfaces on
its own instead of needing someone to notice it by eye, day after day.

**The 30-minute pack-overdue warning (build-2026-10-26-03, extended to the
truck workspace 2026-10-27-03):** a trip that's been open more than 30
minutes without being dispatched shows a warning - originally only on the
Trucks board, now also as a badge in the truck's own checking workspace
topbar, so whoever's actually checking that truck sees it too, not only
someone watching the board. The workspace badge polls independently of the
board's own refresh, since the workspace keeps running after you've
navigated away from the board entirely. Like the driver/route/tray-count
warnings, this is purely a heads-up - it never blocks or changes anything
about dispatching.

**"Checker: &lt;name&gt;" on truck cards (build-2026-10-27-02):** every truck
card - on the board and on the Dashboard - now also names who's actually
checking it, right alongside the existing driver line. That name was already
being recorded the moment a truck session starts; it simply wasn't shown
anywhere until this round.

## Jobs: a non-order task added to a truck's own trip

Sometimes a truck needs to do something that isn't one of today's
deliveries - collect crates from a supplier, drop pallets at the depot, and
so on. This used to be a separate **Non-Order Dispatch** feature (Dispatch
Manager/Admin only, logged from the Trucks board, untied to any real trip);
as of 2026-09-16 it's been replaced with **Jobs**, added directly inside
the truck's own workspace instead.

Any checker on the truck taps **+ Add Job** (right next to **+ Add Order**
in the Orders pane) and fills in an order number or subject line plus a
short instruction. Unlike the old Non-Order Dispatch, a Job:

- **Shows up in the truck's own Orders list**, alongside its real orders,
  with a **Mark Done** action instead of item-by-item packing (there's
  nothing to pack - just one instruction to carry out).
- **Blocks dispatch until marked Done**, the exact same hard rule as an
  unfinished order (see **Dispatch is blocked until every order is
  checked** below) - it's treated as a lightweight order, not a side note
  that could be silently left undone.
- Can be **removed** if it was added by mistake, the same "Remove" button
  pattern as an order, both from the Orders list and from the "Can't
  dispatch yet" screen if it's what's blocking dispatch.

Every Job added for a day still shows up on the Admin Dashboard (today) or
History (a past day), under a **"Jobs"** card - which truck, the subject
and instructions, when it was added and by whom, and whether it's been
marked Done yet - same purpose as the old Non-Order Dispatch card, just
sourced from real per-truck Jobs instead of a separate log.

**One-time step:** re-run `setupSpreadsheet` after pasting in this version
of `Code.gs` so the new `Jobs` sheet gets created (the old
`NonOrderDispatches` sheet is no longer used and can be deleted manually if
you want to tidy it up - nothing in the app reads from it any more).

## Truck issues: a mandatory check before loading orders

Added 2026-09-16, per Shane's request: "when clicking on a truck to start
loading orders a window first comes up to report any truck issues, if no
truck issues just click no truck issues otherwise add issues." Mechanical
problems, cleanliness, anything else worth flagging about the truck itself
(as opposed to an order or an item, which is what **Flag Issue** under
**Checking an order** above is for) - reported once, right at the start of
a trip, instead of relying on someone remembering to mention it later.

**A window pops up automatically the first time a checker enters a
brand-new trip on a truck** - before the driver/route prompt, before
anything else. There are exactly two ways to dismiss it:

- **No Truck Issues** - a single tap for the common case where there's
  genuinely nothing to report.
- **Type one or more issues and Submit** - one issue per line if there's
  more than one ("Cracked windscreen" on one line, "Left tail light out" on
  the next, for example); blank lines are ignored. Submitting with nothing
  typed is refused with an inline reminder to use "No Truck Issues" instead
  - the prompt won't quietly accept an empty answer as if it meant nothing
  to report.

Either way, once answered, the prompt is gone for the rest of that trip -
it does **not** ask again every time the truck is reopened. It's genuinely
**once per new trip**: resuming an already-started, still-in-progress trip
never shows it again, but a truck's 2nd (or 3rd) dispatch of the day - a
brand-new trip in its own right - gets its own fresh prompt, since a
different problem could easily turn up between one trip and the next. This
is tracked with a new `TruckIssuesPrompted` column on `TruckSessions`,
set `false` only when a genuinely new trip is created and flipped to `true`
the moment the checker answers the prompt (whichever way they answer it).

Just like **Flag Issue**, this is **deliberately non-blocking**: whatever's
reported here never stops the truck from dispatching. Reported issues show
up in a new **Truck Issues** checklist card on the Admin Dashboard (and
History), for a Dispatch Manager to work through and resolve - see
**Flagged Packing Issues, and Truck Issues** above.

**One-time step:** re-run `setupSpreadsheet` after pasting in this version
of `Code.gs` so the new `TruckIssues` sheet gets created and the
`TruckIssuesPrompted` column gets added to `TruckSessions` - safe to re-run
any time.

## Dispatch is blocked until every order (and Job) is checked

**A truck cannot be dispatched while any order on it is still Pending or
In Progress, or any Job on it is still not marked Done - there is no
"dispatch anyway" override for this, full stop.** Tapping "Mark truck as
Dispatched" with an unfinished order or an open Job just refuses, naming
which order(s) and/or job(s) are still open. This is different from the
driver/route/tray-count warnings (see the Admin Dashboard section above),
which can still be confirmed past in a genuine rush and get flagged
afterward - incomplete orders and jobs can't be forced past at all.

If a truck is genuinely stuck on a problem order (out of stock on
everything, a duplicate, one that needs to go on a different run) or a Job
that turns out not to apply, there are now two ways to get it off the
truck so the rest can still go out on time:

- **Right from the "Can't dispatch yet" screen** - every listed order has
  its own **Remove** button, and every listed Job has both **Mark Done**
  and **Remove** buttons. Tapping one unallocates that order (or resolves
  that job) and immediately re-checks whether dispatch can go ahead, so a
  Checker can clear a stuck order or job themselves without needing to find
  a Dispatch Manager or Admin.
- **From the main Orders list** in the truck workspace - every order tile
  there also has a **Remove** button, and every Job tile has its own
  **Mark Done**/**Remove**, so a stuck or wrongly-added order or job can be
  resolved before dispatch is even attempted.
- **On the Trucks board** (Dispatch Manager/Admin only) - dragging the order
  off this truck, back to Unassigned or onto a different truck, still works
  exactly as before (Jobs aren't dragged - they're removed or marked Done
  from inside the truck workspace only).

Any of these clears the order's checking progress on this truck (a
confirmation prompt says so) - the order itself isn't lost, and can be
allocated fresh to any truck afterwards. Removing a Job is permanent (a
confirmation prompt says so too) - there's no "unremove", since a Job has
no checking progress to preserve.

## Customer Care role

Give someone the **Customer Care** role in Users and signing in takes them
straight to a single screen: search by order number or customer name, get
back which truck it's on, whether that truck has dispatched yet (and when),
who's driving, and the route - exactly what's needed to answer a "where's
my order" phone call, and nothing else. There's no truck list, no Dashboard,
no Users/Trucks/Data Source - just the search box and Log out.

The search looks across every day on record, not just today, so it can
answer about a delivery from earlier in the week too. It only finds orders
that were actually allocated to a truck at some point - an order Packing &
Production hasn't handed off to a truck yet won't show up (there's nothing
to report on it yet).

**Browse a day (2026-09-28):** below the search box, a **Or browse a day**
date picker lets the operator see everything delivered on a specific day
without needing an order number or exact customer name at all - handy when
a customer calls with a vague query ("did anything of ours go out on
Tuesday?"). Picking a date alone lists every order checked that day, sorted
by customer name; typing a search term at the same time narrows that day's
list further, the same way the search and date work together. Clearing
either the text or the date (or tapping **Clear**) goes back to searching
every day at once, same as before this was added.

## Dashboard layout and Live deliveries (build-2026-11-11-04)

The Dashboard is split into tabs instead of one long page. Tab labels show
live counts: red for things needing action, grey for information.

- **Overview:**
  - *Needs attention* boxes: orders outstanding, trucks out delivering,
    trucks still loading, open issues, customers not returning trays,
    trucks often late. Each opens its tab.
  - Today's orders tiles.
  - Find an order.
- **Live deliveries** (new): every truck today as its driver sees it.
  Shows drivers, route, a progress bar, delivered x of y and last
  delivery time. Tap a truck for its orders and fruit-tray clients with
  delivered times, empty trays collected, and problems reported. Refreshes
  every minute while open. Server: `getLiveDeliveries`.
- **Trucks:** today's truck tiles and truck cards (tiles filter the cards).
- **Timeline:** Dispatch Timeline (newest 8, then "Show all") and Trucks
  Leaving Late.
- **Issues:** driver reports, packing issues, truck issues and jobs.
- **Trays:** the wooden tray roster.

History is unchanged apart from its timeline also showing 8 at a time.

## Wooden tray roster (build-2026-11-11-02)

Fruit trays go out in wooden trays, and the empty tray from the previous
delivery is picked up at the next one.

- **Driver prompt:** when a driver marks a fruit-tray client **Delivered**,
  they're asked how many empty trays they collected (Small / Medium /
  Large, default 0). The prompt also shows what they're dropping off.
- **Trays dropped off:** worked out from the Zoho product names, by the
  piece count (build-2026-11-11-03): 0-15pc small, 16-35pc medium, 36-70pc
  large, more than 70pc goes in boxes (no tray). Only the "NNpc" number
  counts ("45pc + 15sp" = 45). Names with no piece count fall back to
  Small/Medium/Large in the name ("Seasonal Variety Medium x1" = 1 medium).
  Products with neither (nuts, biltong) aren't trays. The limits are
  `TRAY_SIZE_MAX_PIECES` in Code.gs.
- **Roster:** the Dashboard's **Wooden Trays at Customers** card shows, per
  customer, trays out (dropped off minus collected), last delivery, when
  trays last came back, and how many deliveries in a row had nothing
  collected. Customers with 2+ such deliveries are listed first, in red.
- **Opening balance:** trays already at customers before tracking started
  aren't known. In the first weeks a customer can show fewer out than
  they really have (even below 0 when they return an older tray).
- **Storage:** the `TrayLedger` tab is created automatically and kept for
  365 days, not the usual 14. Undoing a delivery removes its row.
- **Customer names:** Zoho tray customers ("Company | Contact | Address")
  show with the company in bold and the rest underneath.

## Customer collections with an item checklist (build-2026-11-10-07)

- **Collect button:** every order in the Trucks board's **Unassigned**
  list has a **Collect** button (checkers, Dispatch Managers and Admins).
  It shows the order's items from Packing & Production. Tap **Handed
  over** or **Not available** on each item; **Mark collected** unlocks
  when every item is done. At least one item must be handed over.
- **What's saved:** `CollectedOrders` gets who did it (from their login)
  and which items were and weren't handed over. The two new columns are
  added to the sheet automatically. The Dashboard's Collected list shows
  who collected it, when, and anything not handed over.
- **Orders on a truck:** an order already on a truck can't be collected.
  Drag it back to Unassigned first.
- **Unassigned list:** collected orders now leave it straight away.
  Before, they stayed there all day.
- **Dashboard Outstanding list:** each order now says where it is: "On
  Truck 5 - not dispatched yet" or "Not on a truck". That's why
  Outstanding can be bigger than Unassigned: it also counts orders on
  trucks that haven't been dispatched yet. The quick **Mark Collected**
  there stays for end-of-day tidying, and now records the person's name.
- **Never on a truck** (build-2026-11-10-08): a tile next to Outstanding
  counts outstanding orders that were never put on any truck. That's the
  orders left unassigned on a past day; on today's Dashboard it reads "Not
  on a truck". On **History**, the Orders due card now sits above the
  Dispatch Timeline so it isn't buried below a long list.
- **Amended orders:** an order amended in Sage after it was dispatched or
  collected (new OrderID, same order number) no longer shows as
  Outstanding.

## Fruit trays from Zoho Creator (build-2026-11-10-02)

Tray clients from Zoho Creator's Delivery Schedule ("Orders Due" page, Jhb
app) are copied into Dispatch so each truck shows its tray clients.

- **Source:** Zoho's `All_Fruit_Statistics` report: one row per order line
  per delivery date, with the order's vehicle (e.g. "(1) - Ntwanano").
  Rows of deleted orders are left out, which is how Creator's own schedule
  works. Customer names come from the `Orders` report.
- **Copy:** `ZohoCreator.gs` (a second file in the Dispatch Apps Script
  project) writes today's and tomorrow's tray stops to the `TrayStops` tab
  every 30 minutes, 05:00-21:59, and on **Settings > Trucks > Refresh from
  Zoho now**. It's read-only on Zoho; change tray orders in Zoho as before.
- **`ZohoCreator.gs` is not in this repo.** The Zoho connection code comes
  from the private Procurement repo, whose rules keep `.gs` files out of
  public repos. Keep its master copy in Apps Script (or a private repo).
- **Linking trucks:** Zoho's vehicles are named by driver/area, not by
  Dispatch truck, so each truck needs its **Zoho vehicle** picked once in
  **Settings > Trucks**. Unlinked trucks show no tray clients.
- **Where it shows:**
  - Checker's workspace, Fruit Trays tab: "Tray clients today", with
    product totals to load.
  - Trucks board: "N tray clients" per truck.
  - Driver's stops on their first trip of the day on that truck: Delivered
    / Problem, same as orders.
  - Dashboard truck card: "Tray clients delivered x/y".
- **One-time setup** in the Apps Script editor: add Script properties
  `ZC_CLIENT_ID`, `ZC_CLIENT_SECRET`, `ZC_DC`, `ZC_REFRESH_TOKEN` (copied
  from Procurement's), `ZOHO_CREATOR_OWNER` = `shane_dailyfruit`,
  `ZOHO_CREATOR_APP` = `dailyfruit`. Run `trayPullNow` once, then
  `setupTrayPullTrigger` once.

## Drivers on the road (build-2026-11-10-01)

Drivers can sign in and log what happens on their deliveries.

- **Sign-in:** give a driver an **App PIN** in **Admin > Drivers**. They
  sign in on the normal login screen with their name exactly as on the
  Drivers list plus that PIN. A driver with no PIN can't sign in;
  unticking Active blocks them. PINs are never shown again after saving.
- **What they see:** only today's trips where the checker put them in the
  trip's Driver fields (the trip modal's driver dropdowns). A driver typed
  into the freeform 4th slot instead of picked from the list won't match
  unless the name is spelled exactly the same.
- **What they log:**
  - **Delivered** per stop (each order on the trip), with Undo.
  - **Problem** at a stop: customer closed, items rejected/returned, short
    or missing, damaged, wrong address/access, or Other (note required).
  - **Road / vehicle incident**: breakdown, accident, traffic delay, fuel,
    police/roadblock, or Other.
- **Where it shows:**
  - Problems and incidents go to the **Driver Reports** card on the
    Dashboard and stay until resolved (History shows the picked day).
  - Delivered progress shows on each Dashboard truck card
    ("Delivered 3/5 (last 10:42)") and per order.
  - Customer Care sees the delivered time when they look an order up.
- Data lives on the `DriverLogs` tab (created automatically). Open reports
  are never pruned; everything else follows the 14-day retention.
- The server works out who the driver is from their login, never from
  what the phone sends, and refuses trips they aren't on.
- Like everyone else, a driver signs in again whenever the app is fully
  closed and reopened (the PIN is only kept in memory).

## Late dispatch reasons (build-2026-11-09-01)

When a truck's **first trip of the day** is marked dispatched **after
07:00**, the checker has to pick a reason before it goes. This is the same
"late" rule as the red "Late leaving" badge and the Trucks Leaving Late
card. Trip 2+ is never asked. The time is the server's clock, not the
phone's.

- Admins manage the list in **Admin > Settings > Late Reasons** (add,
  rename, untick Active, delete).
- If there are no active reasons, nobody is asked. Set the list up first.
- The chosen reason is saved on the trip (`TruckSessions.LateReason`) as
  text, so renaming or deleting a reason later doesn't change past records.
- It shows on the Dashboard truck card, in the Dispatch Timeline, and as a
  per-reason count on the Trucks Leaving Late card.
- **Pick order(s)** (build-2026-11-09-02): tick this on a reason (e.g. the
  night-shift ones) and the checker must also tick which order(s) on the
  truck it applies to. The order numbers are saved on the trip
  (`TruckSessions.LateReasonOrders`), shown next to the reason, and each
  order is added to the Dashboard's **Flagged Packing Issues** list as
  "Whole order - truck left late", where management resolves it. A trip
  with no orders on it isn't asked to pick one.
- The `LateReasons` tab and the `LateReason` column are created
  automatically the first time they're needed; no need to re-run
  `setupSpreadsheet()`.

## Access control: every request is checked (build-2026-11-06-01)

The Web App URL is public (it's in `index.html`), so the server can't trust
anything the screens hide. Every API call except `authenticateUser` now
carries the signed-in user's name + PIN, and `handleApiRequest_` in
`Code.gs` re-checks them against the Checkers ("Users") sheet and then
checks the user's Role against `ACTION_ROLES` before running the action:

| Role | Allowed actions |
|---|---|
| Customer Care | `findOrderAcrossTrucks` only |
| Checker | truck flow, including the Trucks board (Checkers drag orders onto trucks) |
| Dispatch Manager | truck flow + Dashboard, History, issues, collected orders |
| Admin | everything, including Users, Trucks, Drivers, Data Source |

- An action missing from `ACTION_ROLES` is refused. **When you add a new
  action to `API_ACTIONS`, also add it to `buildActionRoles_`**, or nobody
  can call it.
- The user list is cached for 60 seconds. Changes made in Admin > Users
  apply straight away; a change typed directly into the sheet can take up
  to a minute.
- PINs are never sent to the browser. The Users screen has a blank
  "New PIN" box per user. Leave it blank to keep the current PIN. New PINs
  must be at least 4 digits.
- 10 wrong PINs for one name locks that name for 15 minutes.
- If the server stops accepting a login mid-session (PIN changed, user
  deactivated or deleted), the app goes back to the login screen and shows
  the reason.

## 5. GitHub repo + Pages + domain

Same as the other two systems:

1. Create a new GitHub repo (e.g. `DailyFruitDispatch`).
2. Push this repo's files to it (`index.html`, `Code.gs`, `appsscript.json`,
   `manifest.json`, `sw.js`, the `icons/` folder, this `SETUP.md`) - keep the
   `icons/` folder as a folder, since `manifest.json` and `index.html` both
   reference the files inside it by that path.
3. The **published** `index.html` on GitHub Pages should redirect (or embed
   via iframe, matching whichever approach Procure/Packing use) to the Apps
   Script Web App URL from step 2.
4. Enable GitHub Pages on the repo.
5. Point `dispatch.dailyfruit.co.za` at GitHub Pages the same way
   `procure.` and `pckprd.` are set up (CNAME file in the repo + DNS record
   with your domain host).

A `CNAME` file with `dispatch.dailyfruit.co.za` is already included in this
package for GitHub Pages.

I don't have push access to your GitHub account from here, so I've packaged
the files for you to add to a new repo - let me know if you'd like help with
any of these steps.

## 6. Install it on a phone like a real app

Once it's live on `dispatch.dailyfruit.co.za`, checkers can add it to their
home screen so it opens full-screen, with its own icon, like an installed
app - no app store involved.

**Android (Chrome):** open the site, tap the **⋮** menu, then **Install
app** (or **Add to Home screen** - wording varies slightly by Chrome
version). Chrome may also show an "Install" banner on its own after the
site's been visited a couple of times.

**iPhone/iPad (Safari):** open the site, tap the **Share** icon (the square
with an arrow), then **Add to Home Screen**. This has to be done in Safari
specifically - Chrome on iOS can't add a home-screen app the same way.

Either way, launching it from the home screen icon opens it in its own
window without the browser's address bar, and it remembers the login same
as any browser tab would. If a new `index.html` is ever pushed live, the app
picks it up the next time it's opened with a signal - it isn't stuck on
whatever version was installed originally.

### Orientation on a mounted tablet

The app's layout works in either orientation, so there's no code-level
"default orientation" to set - `manifest.json`'s `orientation` field used
to say `"portrait"` (left over from when this was only ever installed on
phones); it's now `"any"` so it doesn't fight a tablet mounted in
landscape. That said, neither Android nor iOS/iPadOS actually lets an
installed web app force a specific orientation - only the device's own
rotation lock decides, and there's no code fix for that (the web
platform's `screen.orientation.lock()` API isn't supported in Safari at
all, on iPadOS or otherwise). **On an iPad specifically, rotation lock
freezes whatever orientation the screen is in AT THE MOMENT you turn it
on** - it doesn't mean "portrait" or "landscape" on its own. So to get a
tablet to stay in landscape: turn rotation lock **off**, physically rotate
the iPad to landscape, open the app, then turn rotation lock back **on**
while it's still in landscape. From then on it'll stay in landscape
through reboots/reopens, until rotation lock is turned off and the device
gets rotated again.

## Checking an order

A truck's **Orders** tab only shows orders already on that truck - not
every order in today's Packing & Production data, which would be far too
much to scroll through for a truck carrying a handful of orders. Normally
these are already there by the time a checker opens the truck, assigned
that morning by the Dispatch Manager on the Trucks board (see **Assigning
orders: the Trucks board** above).

For a straggler that prints after the morning round, **+ Add Order** still
works exactly as before: search by order number or customer, tap the
result. The list loads once when the search box opens and typing just
filters it instantly on the phone - it doesn't wait on the network for
every letter typed.

Tapping a result **allocates it to this truck automatically** and opens
straight into checking - there's no separate "Allocate to This Truck"
confirmation any more, since picking the order from the search results is
already the decision to put it on this truck. It also then shows up back
on the main Orders tab, same as before.

Once an order is allocated to a truck, it stays "claimed" by that truck for
the day. It still shows up in **+ Add Order** searches from any other
truck too (so nothing looks like it's vanished), but tapping it from a
different truck opens a locked screen that just says which truck it's
actually on - there are no Packed/No Stock controls there, so it can't be
double-checked or ticked off from the wrong truck by mistake.

If an order really was put on the wrong truck and needs to move, that same
locked screen has an **Unallocate** button. Unallocating it clears its
checking progress entirely - it goes back to "not allocated to anything" -
so it can then be allocated fresh on the correct truck, with every item
starting over at Pending rather than carrying over whatever was already
ticked on the truck it came from. An order can't be unallocated once its
truck has already been marked Dispatched, since that truck has physically
left with it by then.

Every item on an allocated order must be marked Packed or No Stock before
the checker can tap **Done** at the bottom of the order screen - it stays
disabled until then, so it's a clear go/no-go rather than something to
guess at.

Tapping Packed/No Stock/Undo updates the screen immediately rather than
waiting for the save to finish - the save to the sheet still happens right
away in the background, so nothing is lost if the phone loses signal or
the app is closed mid-order, it just no longer feels laggy on every tap.
If a save does fail (no signal, sheet unreachable), an error banner shows
and the screen re-syncs with whatever's actually on record.

**No Stock** is a single tap - there's no reason-picker step any more (that
whole admin-managed Reasons feature was removed, see **4. Set up users,
trucks, and drivers** above).

**Edit Qty - packing less (or more) than ordered:** every pending or packed
item now has an **Edit Qty** button alongside Packed/No Stock, for the case
where the order says e.g. 5kg of tomatoes but only 4kg is actually
available to pack. Entering a quantity there marks the item **Packed**
(same as the plain Packed button - this is deliberately not a separate
status, per Shane's call) but records the amount actually packed, and shows
a **"Qty adjusted"** line under it (packed amount vs. the amount ordered)
so it's easy to spot at a glance, both here and on the Admin Dashboard (see
above) and in a truck's own order breakdown there. Using the plain
**Packed** button (no Edit Qty) always means "packed exactly as ordered" -
no flag, nothing extra recorded.

**Flag Issue - reporting a packer's mistake (2026-09-16):** every item, in
any status (Pending, Packed, or No Stock), now has a **Flag Issue** button
alongside its other actions. Sometimes a packer does a bad job - poor
quality, wrong weight, and so on - and the checker is the one who notices
it while checking stock. Tapping Flag Issue opens a small note field; typing
a short explanation and confirming raises the flag. This is **deliberately
non-blocking**: flagging an item does not change its own Packed/No
Stock/Pending status, does not affect the "Qty adjusted" tracking Edit Qty
uses, and does not stop the truck from dispatching - it's purely a side
note for someone to follow up on afterward, the same non-blocking spirit as
the driver/route/tray-count warnings (see the Admin Dashboard section
above), not the hard-block model Jobs uses. Once flagged, the item shows a
"Flagged: ..." confirmation line on screen (just a same-session echo - it
clears if you leave and reopen the order, since the real, persistent record
lives in a new **Flagged Packing Issues** checklist on the Admin Dashboard,
see below). An item can be flagged more than once and regardless of its
status - a packer's mistake is very often only noticed after the item is
already marked Packed.

**COA (Certificate of Analysis) required orders:** Packing & Production
flags certain orders as requiring a COA - this comes from a `RequiresCoa`
column on ITS Orders sheet (populated from a "REQUIRES COA:" field on the
invoice PDF; Dispatch has no say in which orders need one, it only reads
the flag). When an order requires a COA, a **COA attached** checkbox
appears on its checking screen, above the Done button, with a reminder to
confirm the physical certificate is actually attached to the order. **Done
stays disabled until that box is ticked**, even once every item is Packed
or No Stock - both conditions are required, independently. Ticking or
un-ticking it saves immediately in the background, the same way item taps
do. Most orders don't require a COA at all, in which case this checkbox
never appears and Done works exactly as it always has.

Because Dispatch reads `RequiresCoa` as an *optional* column (unlike every
other Orders column it depends on), a Packing & Production sheet that
hasn't yet been redeployed with this column - or has it under a
momentarily different name - doesn't break order fetching for anything;
every order just comes through with no COA gate applied until that column
shows up. If the COA checkbox isn't appearing on orders you expect it to,
first check that Packing & Production's `RequiresCoa` column has actually
landed on the live sheet (running `setupSpreadsheet()` on the Dispatch
side isn't what's needed here - the column has to exist on the *Packing &
Production* sheet, since that's the one Dispatch reads from).

On Dispatch's own sheet, four new columns were added to **OrderChecks**:
`RequiresCoa` (a snapshot of the flag taken the moment the order is
allocated to a truck - it won't change mid-check even if Packing's sheet
is edited afterward), and `CoaConfirmed` / `CoaConfirmedBy` /
`CoaConfirmedAt` (who ticked the box and when, separate from whether the
order needed one in the first place). **Unlike Packing & Production's own
sheet, Dispatch's OrderChecks header row does NOT self-heal on its own** -
`setupSpreadsheet()` only runs when manually triggered (from the Apps
Script editor's Run menu), not on every request. Run it once after
deploying this update, or these four columns won't be readable back
(the data is still written to the right cells regardless, but without a
header label in row 1 to name them, nothing can read them by name) and
every order will simply behave as if it never requires a COA - safe, but
silently not the feature you're expecting.

**Production status (2026-09-16):** Shane's request was to "show the pack
and production status of an order in the dispatch system so if an order is
in dispatch for today but production hasn't completed the work yet that it
shows that on the order". Some orders have line items that Packing &
Production routes to its own **Production** department (a cut/prepped item,
for example) rather than straight to Packing - those lines can still be
outstanding even once everything Packing-side is ready to go. Wherever such
an order appears in Dispatch - the Orders tab, **+ Add Order** search
results, the Trucks board, and the order-checking screen itself - it now
shows an amber **⏳ Production** badge or line if Packing & Production
hasn't yet marked that order's Production work complete, with a short note
naming which line(s) are still outstanding when that detail is available
(e.g. "Potato - CUT: 200/400 kg"). Opening the order itself shows a fuller
amber banner with the same information front and center.

This is **purely informational, exactly like the COA reminder above -
it never blocks Done or Dispatch**. A checker can still tick every item
Packed/No Stock and dispatch the truck normally even while this badge is
showing; it's there so nobody is surprised that an order shipped with
outstanding Production work, not to gate anything. Unlike `RequiresCoa`
(snapshotted once, at allocation time), Production status is read live on
every screen load, since the whole point is catching Production finishing
the work *while* an order already sits allocated on a truck.

Two more optional columns on Packing & Production's own sheet make this
work, read the same defensive way as `RequiresCoa` (missing entirely = no
warning ever shown, never a broken order fetch): `ProductionCompletedAt` on
its **Orders** tab (blank until every Production line on that order is
done) and `QtyCompleted` on its **OrderItems** tab (a running total for a
partially-completed Production line, e.g. "200 of 400kg done" - only
meaningful on Production department lines; Packing lines never set it). If
`QtyCompleted` hasn't landed on the sheet yet, the badge still appears (from
`ProductionCompletedAt` alone) but with a generic "Production not yet
complete" note rather than naming specific quantities - nothing breaks
either way, it's just a less detailed note until that column exists. As
with the COA column, this is Packing & Production's own sheet, not
Dispatch's - no `setupSpreadsheet()` run is needed on the Dispatch side for
this one.

### Known limitation: an order the Dispatch Manager never assigns is invisible to the dispatch check

The Trucks board (see above) covers most of what used to be a real gap
here - a checker opening their truck now normally finds its orders already
assigned, rather than self-serving every one via search. But there's still
no data anywhere (Sage or the Packing & Production sheet) that says "these
orders go on this truck" independent of Dispatch's own records - if the
Dispatch Manager simply never drags a particular order onto any truck (and
no checker adds it via + Add Order either), nothing in the app knows it was
supposed to go out at all, so it can't be flagged as missing. The "orders
due today" card and its Outstanding/Overdue tiles on the Admin Dashboard
(see above) are the main safety net for exactly this - they're driven
directly from Packing & Production's own order list, not from what's been
assigned to a truck, so an order sitting unassigned all day will show up
there as outstanding. If that turns out not to be enough of a safety net in
practice, a next step could be an explicit manifest/checklist per truck
(e.g. loaded from Sage) - happy to build that once you've seen how the
board plays out day to day.

## Trucks that dispatch more than once a day

This section describes the plain **Select a truck** screen a Checker
signs into. Dispatch Manager/Admin get the Trucks board instead (see
**Assigning orders: the Trucks board** above) - tapping a truck's name
there opens it via this same underlying logic, it's just reached from a
different screen. The board's own card shows the same per-trip breakdown
described below too (see the note in that section), just in a more
condensed form to fit the board's smaller cards.

The **Select a truck** screen shows, per truck, whether it's already been
dispatched today (and how many times, if more than once) and whether it
currently has an in-progress trip. Tapping a truck that still has an
in-progress trip goes straight back into it, same as always.

Each truck's tile also breaks down every trip it's had today - status,
driver(s), route, and that trip's own orders (with a small dot showing
whether each one is still pending, in progress, or fully checked) - so
it's clear what's actually loaded on a truck, and who's driving it, before
tapping in rather than only after. This is shown per trip rather than
merged into one list specifically because the driver (and sometimes the
route) can be different between a truck's 1st and 2nd dispatch of the day -
merging them would make it look like one driver had everything.

Once a truck has more than one trip today, each trip gets its own shaded,
bordered block with a "Trip 1"/"Trip 2" tag and a colored left edge
(green once dispatched, amber while still in progress) - separating them
clearly used to rely on just a thin line between trips, which was easy to
miss once both said "Dispatched" and looked almost identical at a glance.
A truck with only one trip today keeps the plain, unboxed layout - there's
nothing to separate yet.

A search box above the list filters it instantly as you type, matching a
truck's name/registration/type, a driver's name, or an order's number or
customer - handy for jumping straight to "which truck is Sipho driving" or
"which truck has order INV0135915" without scanning the whole list by eye.
It filters what's already on screen (no extra tap needed) and shows the
whole matching truck's tile, not just the part that matched, so its other
trips/orders stay visible for context.

Tapping a truck whose only trip(s) today are already Dispatched brings up a
choice instead of silently reopening the last one:

- **Edit current dispatch** - reopens that trip exactly as it was (its
  orders, trays, driver, route), so a mistake can be fixed after the fact.
  Tapping "Mark truck as Dispatched" again on it just re-saves the dispatch
  with whatever's changed.
- **Start a new dispatch** - begins a completely fresh trip for that truck:
  empty Orders tab, empty tray counts, no driver/route set. Both trips stay
  on record independently and both show up on the admin Dashboard.

## Troubleshooting the API connection

**A one-off "Request timed out after 20s (action: authenticateUser)" right
after signing in, that then works fine on retry**, is almost always Apps
Script's Web App "waking up" rather than anything actually wrong. The very
first request to a freshly-created deployment (e.g. right after Deploy >
Manage deployments > New version) has to spin up a fresh execution
container behind the scenes, which can occasionally take longer than the
app's 20-second client-side timeout - `authenticateUser` itself is about
the simplest, fastest call in the whole app (one sheet read, no locks, no
external spreadsheet), so it's not the bottleneck. If it only happens once,
right after a redeploy, and signing in again immediately works, there's
nothing to fix. It's only worth digging further if it happens repeatedly or
on an ordinary (non-redeploy) sign-in - in that case, check the Apps Script
editor's **Executions** panel (left sidebar) for the actual
`authenticateUser` call to see its real duration and whether it errored
server-side, since that's the only place actual timing/error detail from
Google's side is visible.

If the app loads but nothing happens on login (a network error, or a blank
failure), test it two ways to narrow it down:

1. **Open the Web App URL directly** (the one ending in `/exec`) in a
   browser. That serves `index.html` straight from Apps Script itself, so
   it works even before `CONFIG.API_URL` or GitHub Pages are set up -
   `fetch()` calls from that page go to the same origin, no CORS involved.
   If login/trucks/orders all work there, the backend logic is fine and any
   remaining issue is specifically about GitHub Pages calling a different
   origin.
2. **On the GitHub Pages version**, open the browser dev tools console. A
   CORS or network error there usually means `CONFIG.API_URL` is missing,
   wrong, or still using the placeholder text.

## Troubleshooting "I tapped a button and nothing happened"

Every tappable thing that triggers an action in the app - not just buttons,
but an order tile, a truck's name/header, an admin tab - now blocks itself and shows its own loading spinner (a `.btn` gets a
visible spinner; a tile or header just dims and stops responding to taps)
the moment it's tapped, for as long as its own request is in flight. This
is deliberately **per item**: tapping several different items' Packed
buttons one after another blocks each independently for its own save,
rather than only protecting the last one tapped and leaving the earlier
ones - whose saves are still in flight - open to a second, accidental tap.
A thin amber bar also sweeps across the very top of the screen for as long
as ANY request anywhere is in flight, including things that aren't a tap at
all (search-as-you-type, an inline edit saving in Users/Trucks/Drivers).
(It used to be green, but that blended into the dark-green topbar right
below it and was easy to miss - amber stands out against it instead.)
None of this existed before, so if nothing visibly happens at all when you
tap something (no dimming, no spinner, no top bar), that's itself a sign
one of the two causes below is in play, rather than the request just being
slow - a genuinely slow request now still SHOWS as loading, it just takes a
moment to finish.

Two common causes, in the order to check them:

1. **A new deployment version wasn't created.** Pasting an updated
   `Code.gs` into the Apps Script editor does not, by itself, change what
   the live `/exec` URL runs - you also need Deploy > Manage deployments >
   edit the existing deployment > **New version**. If you skip this, the
   app is still calling old backend code, and a button whose action doesn't
   exist yet there will silently fail. This is why it's worth doing after
   every `Code.gs` update, and running `setupSpreadsheet` again alongside
   it (see the section above on blank/unsaved fields).
2. **A cached response.** Because every request from the app is a GET (the
   `/exec` redirect drops a POST body - see the architecture note in
   Section 2), a browser or a mobile carrier's proxy can occasionally serve
   a stale cached response for a URL that was just requested, instead of
   hitting Apps Script again - so an action that changed something on the
   server can look like it did nothing when the app immediately re-checks
   state. `Code.gs`/`index.html` now send `cache: 'no-store'` plus a unique
   value on every request specifically to prevent this; make sure you're on
   the latest `index.html` if a button ever seems to silently do nothing.

If neither explains it, open the browser dev tools console right when you
tap the button - a request that failed will show up there (and usually
pops an alert with the error message too).

### Resolved: "Allocate to This Truck" silently did nothing

This did turn out to be a real bug, not caching or a stale deployment -
found via a build-version tag, an on-screen error banner, and a request
timeout added to `index.html` to make the failure visible (worth knowing
about if a similarly silent bug ever shows up again: the tag confirms
which file is actually loaded, the banner is a backup in case `alert()`
is ever suppressed, and the timeout turns a hang into a visible error
instead of nothing at all).

The actual cause: order IDs from Packing & Production get treated as text
throughout `Code.gs`, but Google Sheets silently stores a purely-numeric
value (many order IDs are just digits) as a real number once it's written
into a cell - unlike Dispatch's own IDs, which are UUIDs and never look
numeric, so this never affected trucks, checkers, or sessions. The
allocate step and the order-checking screen compared that number against
the text version of the same ID and never matched, even for the row that
had just been created a moment earlier - so allocating an order appeared
to succeed (no error) but immediately reported the order as still
unallocated. Fixed in `Code.gs` by comparing both sides as text.

That fix alone didn't fully resolve it, though - a second, near-identical
bug was hiding behind the first. Every "is this from today" check in
`Code.gs` compares a sheet's Date column against a plain `yyyy-MM-dd`
text value, but that exact format is one Google Sheets recognizes as a
date and silently converts to a real date value once written - same
underlying issue as the OrderID one, just on a different column. That
made an order-check row look like it wasn't from today even seconds
after being created, and (more importantly for day-to-day use) could
have made a checker reopening the same truck later in the day get a
brand-new session instead of resuming their existing one. Fixed the same
way: every Date-column comparison now normalizes a real date value back
to text before comparing.

### Resolved: a product was occasionally missing from an order in Dispatch, even though Packing & Production had it correctly

Reported by Shane (2026-10-01): products were silently dropping off
individual orders here and there - not a pattern tied to any one product
or customer, and confirmed NOT to be a case of a product being added to
the order in Packing & Production *after* it had already been allocated
to a truck here (that's a separate, known limitation - see the "Known
limitation" note under "Assigning orders: the Trucks board" above - but
it wasn't what was happening here).

Traced using a concrete example Shane gave (Spinach missing from order
INV0138094) by comparing the two systems' own spreadsheets directly:
Packing & Production's OrderItems tab had all 22 line items for that
order, Spinach included, in a perfectly ordinary row - identical in every
way to the other 21. Dispatch's own ItemChecks sheet, though, only had 21
of them. The giveaway was the ItemKey column: each item's key encodes its
position in the order (`..._0`, `..._1`, and so on), and the sequence for
this order jumped straight from `..._5` to `..._7` - item `..._6`
(Spinach) was never written at all.

The cause: `allocateOrderToTruck` copies an order's item list from
Packing & Production into Dispatch's own ItemChecks sheet once, at the
moment it's dropped onto a truck (see the architecture note under
"Assigning orders: the Trucks board"). That copy used to write the list
one row at a time, in a loop, calling Google Sheets' `appendRow()` once
per item - for a 22-item order, 22 separate round trips to the Sheets
backend. Each of those calls independently figures out "the next empty
row" and writes to it; under enough load, one of those calls can
silently not take effect, with nothing thrown for the loop to notice or
retry. With no error to catch, the order looked completely normal
afterward - just one row quietly short.

Fixed by writing the whole item list in a single batched call instead
(`getRange(...).setValues(...)` over all the rows at once, rather than
`appendRow()` per row) - one atomic write that either lands completely
or throws, with no way for a single row in the middle to go missing
unnoticed. Applied the same fix to the only other place in the app that
wrote several rows in a per-item loop (`reportTruckIssues`, for a
truck's reported issues), since it had the identical latent risk even
though it had not been reported as a problem. If the batched write does
throw, the order-check row already created for that allocation is now
rolled back rather than left behind as a stuck "allocated but empty"
order - see `allocateOrderToTruck`'s comment in `Code.gs`.

This fix only prevents the gap going forward. Order INV0138094 itself was
already dispatched by the time this was diagnosed, so whether that
particular truck actually left with spinach or not couldn't be
recovered from the data alone - worth checking with the driver/Reef
Hotel directly if it matters for that specific delivery.

### Resolved: dispatch warned "Driver name has not been entered" right after a driver was entered and saved

The driver/route entry screen used to save the driver name(s) and the
route as two separate requests fired at the same time (`Promise.all`),
each of which read the truck session's row, changed its own field, and
wrote the whole row back. If both requests read the row before either had
written back - entirely possible with two requests in flight together -
whichever one finished writing LAST would overwrite the other's field
with the blank value it had originally read, even though the UI had
already shown both as saved. So a driver name could be saved, shown on
screen, and still come back blank the moment `Mark truck as Dispatched`
re-read it from the sheet a moment later. Fixed by combining the driver
names, their contact numbers, and the route into a single locked
read-modify-write (`updateSessionTrip`) - there's no longer a second
in-flight request that can land in between reading and writing.

### Resolved: no way to back out of the driver/route screen

The driver(s) & route screen used to hide its Cancel button entirely
whenever driver/route were still unset (its first prompt, right after
opening a truck) - the idea being that there was nothing valid yet to
cancel back to. In practice this meant a checker who opened the screen by
mistake, or wanted to come back to it later, had no way out of it at all.
Since driver/route were never actually a hard requirement anywhere else
(a truck can dispatch without them, it just gets flagged afterward as
"dispatched with warnings" - see the Admin Dashboard section above), the
button is now always shown - just labeled **"Skip for now"** instead of
**"Cancel"** when nothing's set yet, since there's nothing valid to cancel
back to, but closing it is always an option.

### Fixing "Request timed out after 20s" on rapid item-checking

If several items get tapped Packed/No Stock in quick succession, each tap
fires its own save request. That save locks briefly while it recomputes
the parent order's overall status (Pending/In Progress/Complete) from all
of that order's items - needed so two items ticked at almost the same
instant on the SAME order can't race and leave a stale status behind. The
per-item tap-blocking described above (each item disables itself the
instant it's tapped) reduces the most common way a queue builds up - an
impatient repeat-tap on something that hasn't visibly responded yet - but
a live report of `Request timed out after 20s (action: setItemStatus)`
showed it wasn't enough on its own: the lock being used was Apps Script's
single script-wide lock, meaning it wasn't just protecting one order from
itself - it made EVERY checker, checking items on EVERY truck, queue up
behind every other one doing the same, however unrelated. On a busy
morning with several checkers all working at once, that queue could grow
long enough for someone near the back to hit the 20-second timeout even
though nothing was actually wrong with their own tap. Fixed by scoping the
lock to just the one order being touched (a short-lived cache entry keyed
to that order, since Apps Script has no built-in per-item lock) - checking
items on different trucks, or even different orders on the same truck,
no longer wait on each other at all; only two taps on the exact same
order at nearly the same instant still briefly serialize, which is the
only case that ever needed it.

Important: this doesn't speed up several items on the SAME order being
ticked one after another by one checker - those still wait their turn
behind each other, correctly, since they share the one thing the lock
protects. If 20-second timeouts are still showing up specifically on that
pattern (one person, one order, several taps in a row), the next thing to
check is whether the daily cleanup (`pruneOldRecords`, see **Data
retention** above) is actually running - every item-check tap reads the
whole ItemChecks sheet, so the bigger that sheet is allowed to grow, the
slower every single tap gets, independent of any locking. This is also
backend-only - unlike the other fixes in this document, nothing here
changes what's in `index.html`, so the build-tag check described elsewhere
in this file won't confirm it's live; only re-pasting `Code.gs` and
deploying a new version in the Apps Script editor does.

### Resolved: "Request timed out" and "...is not valid JSON" still showing up often when packing items

The per-order lock scoping described just above cut down the queueing a lot,
but it didn't fully explain a report of `Request timed out after 20s
(action: setItemStatus)` - and later a more telling one, an alert reading
`Unexpected token '<', "<!DOCTYPE "... is not valid JSON` - coming up often
while marking items as packed, not just occasionally. That second message
is the real clue: `Code.gs` always answers every request with real JSON,
even for its own errors (see its `handleApiRequest_`), so a response that
isn't valid JSON at all never came from this app's code - something IN
FRONT of it answered instead. That's almost always Apps Script's own
per-second request-rate/concurrency limit being briefly tripped, which
answers with a plain HTML error page. The most likely way to trip it here:
the app was sending one save request per item, so ticking several items in
a quick burst (which checkers naturally do while working through a crate)
fired that many fully concurrent requests, all also converging on the same
per-order lock at once. Two fixes went in together:

- **Fewer concurrent requests in the first place.** Saves for the
  currently-open order now go out one at a time, in the order they were
  tapped, instead of all at once - tapping five items quickly sends the
  first item's save immediately and queues the rest right behind it,
  each starting as soon as the one before it finishes. Nothing about
  tapping feels different (an item still shows as Packed/No Stock the
  instant it's tapped, exactly as before) - only the timing of the
  background save changed. This is the main fix; it's what actually
  reduces how often Apps Script's rate limit gets tripped to begin with.
- **A calmer response on the rare times a save is still slow.** If a save
  genuinely does time out, or Apps Script's front door is briefly too busy
  to answer, the app now quietly retries it a couple of times on its own
  (about 1 second, then 2 seconds later) before bothering anyone - this
  only happens for saves that are safe to repeat (overwriting the same
  item's status again is harmless; the app never auto-retries anything
  that could create a duplicate, like adding a new truck or driver). Items
  being checked/packed also get a longer allowance before timing out at
  all (35 seconds instead of 20), since a brief wait for the per-order lock
  is expected there. If it's still slow after the automatic retries, the
  message now reads as a calm heads-up in an amber banner ("Still waiting
  to hear back from the server... this can happen when a few things save
  at once and doesn't always mean something is wrong") rather than a red
  "Something went wrong" alert popup - and the screen quietly re-syncs
  itself from the server right after, so a checker doesn't need to guess
  whether their tap actually saved. A genuine error (the server itself
  rejecting the request, or any other real bug) still shows the original
  red banner and alert popup exactly as before - only the rare, self-
  resolving slow-save case reads more calmly now.

If this message still shows up often after updating, it's worth checking
the Apps Script project's Executions panel (see **Troubleshooting the API
connection** above) for the actual pattern of failures - and, as with the
lock-scoping fix above, whether `pruneOldRecords` is keeping the sheets
small, since a bigger ItemChecks sheet makes every single save slower and
easier to pile up behind each other regardless of any of this.

### Resolved: orders getting stuck on screen while dragging on the Trucks board

A live report of order tiles "getting stuck on screen" during drag-and-drop
traced back to a race: dropping an order shows it on its new truck
immediately and fires the save to the server in the background (see
**Assigning orders: the Trucks board** above - this is deliberate, it's
what makes a drop feel instant instead of taking ~15s). If a Dispatch
Manager picked up and started dragging a SECOND order before that first
save had actually finished, and the first save's confirmation then arrived
while the second order was still being dragged, the board's refresh (to
reflect the first order's confirmed move) rebuilt the whole order list out
from under the second, still-in-progress drag. The floating copy of that
second order being dragged (its "ghost") was never told the drag had been
cut short, so it stayed floating on screen permanently - exactly the
"stuck" symptom, and it could happen again on every subsequent drag,
leaving more than one stuck tile behind. Fixed by having the board's
refresh always cancel any drag still in progress first, so a drag either
finishes normally or is cleanly cancelled - it can no longer be
orphaned on screen. If a stuck tile from before this fix is still showing,
a page reload clears it.

### Resolved: trucks weren't listed in numerical order

The Trucks tab (and the checker's "Select a truck" screen, and the Trucks
board) used to list trucks in whatever order they were originally added in
the sheet, which usually wasn't numerical at all. Trucks are now always
sorted by the number in their name - "Truck 2" before "Truck 9" before
"Truck 10", not the old plain alphabetical order that would have put
"Truck 10" before "Truck 2". A truck with no number in its name (or a
custom name like "BT 1") just sorts alphabetically after the numbered
ones. This is one shared sort used everywhere trucks are listed, so
renaming a truck (e.g. in the Trucks tab) also reorders it everywhere else
automatically - no separate "sort order" field to manage.

### Resolved: a truck's second trip could sit open forever with no orders on it

Reported 2026-10-30, from a screenshot of Truck 4 showing two open trips,
the second one sitting empty. Starting a truck session works by reading
"does an open session already exist for this truck today," and creating one
if not - with no lock around that read-then-create pair. Two checkers
tapping the very same truck close enough together could both read "no open
session yet" before either had finished creating one, so both created their
own - the second one permanently orphaned, with nothing ever allocated to
it. Fixed by wrapping truck-session creation in a lock scoped to that truck
and day (see the next entry for the lock mechanism itself), so a second
near-simultaneous tap now correctly finds and reuses the first request's
session instead of creating a duplicate.

### Resolved: an iPad stuck "loading" for a long time during a busy morning

Reported 2026-10-30, and traced to a locking problem - a different one from
the per-order lock already fixed earlier for item-checking (see **Fixing
"Request timed out after 20s" on rapid item-checking** above). Allocating an
order to a truck, and saving a truck's driver/route/trays, were both still
using Apps Script's single script-wide lock - the exact same mistake already
fixed once for item-checking, just never carried over to these two writes.
On a busy morning, every checker or dispatcher doing either of those things
on *any* truck queued up behind every other one doing the same, however
unrelated - exactly the shape of a long, otherwise-unexplained "stuck
loading." Fixed by generalizing the per-order lock into a reusable, named
lock keyed to whatever actually needs protecting (one order, one truck
session, one truck+day), and used consistently everywhere a lock is needed
in `Code.gs` - a script-wide lock is not used anywhere in this app any more.

### Resolved: a dispatched order still showing as Outstanding on the Dashboard

Reported 2026-10-30 by a dispatch manager: an order that had genuinely
already gone out on a truck still showed up in the Dashboard's Outstanding
list. The cause was the same Google Sheets numeric-coercion issue already
described under **Resolved: "Allocate to This Truck" silently did
nothing** above, this time affecting Packing & Production's internal
`OrderID`. When an `OrderID` happens to be a purely-numeric string, Sheets
can silently store it as a real Number once written into a Dispatch sheet
cell, and from then on a comparison against the text version of that same
ID never matches again - in this case, specifically the comparison that
decides whether an order has actually been dispatched. Fixed two ways:
`OrderID` columns are now forced to Plain Text on write (the same fix
pattern as the PIN/Contact columns), and - because that alone can't recover
an ID already mis-stored before this fix - every `OrderID` comparison
anywhere in `Code.gs` now goes through one shared, canonical matching helper
instead of a bare string comparison, so even an already-affected legacy row
still matches correctly going forward. **One-time step:** re-run
`setupSpreadsheet` after pasting in this version of `Code.gs` so the Plain
Text formatting actually gets applied.

### Resolved: "After marking a truck dispatched the loading window stays for long"

Reported 2026-10-30. Two separate, provable costs inside
`markTruckDispatched`: (1) whenever a checker overrides a driver/route/
tray-count warning, the app calls `markTruckDispatched` twice in a row for
the very same dispatch - once to show the warning, again moments later to
confirm past it - and each call independently paid for a full, deliberately
*uncached* scan of both Packing & Production tabs (that scan exists on
purpose, to catch an order whose item list grew after allocation - see the
DFV0013963 note under **Making the app faster** below), so a warned dispatch
paid for that expensive scan twice for no extra safety. (2) There was no
"this session is already dispatched" short-circuit, so a frontend
timeout-triggered automatic retry of an already-successful dispatch silently
redid that same expensive work all over again, and pushed the recorded
dispatch time later with every repeat. Fixed by having the first call warm
the normal 45-second Packing cache with its own fresh read, so the confirm
call reuses that instead of re-scanning, and by returning immediately - with
no Packing read at all - for any call against a session that's already
marked Dispatched.

### Resolved: an order showing as both dispatched and unassigned at the same time

Reported 2026-11-01, from a screenshot of order INV0141104 showing
"(dispatched)" under Truck 19 and also as a plain, draggable chip in
Unassigned Orders. Diagnosed from Shane's own exported Packing & Production
and Dispatch sheets rather than guessing: Packing & Production's Sage-direct
importer (live since 2026-10-29) deliberately gives an order a brand-new
internal `OrderID` whenever its Sage invoice is amended after import,
keeping the same order number and customer - a decision made on Packing &
Production's own terms (see that system's own setup guide). Dispatch's
whole allocation model assumes an order's `OrderID` stays fixed for the day
once it's allocated to a truck, so once Packing & Production replaced this
order's ID, Dispatch's Unassigned list - built fresh from Packing &
Production's current order list - started showing what looked like a
brand-new order, even though the truck that had dispatched the *old* ID was
correctly showing that same order as already delivered.

Three ways of handling this were on the table; Shane picked the simplest: if
an Unassigned order's **number** matches one already **dispatched** today
under a different ID, it's left out of Unassigned entirely. An order still
sitting on a truck that hasn't dispatched yet is deliberately *not* hidden
if the same thing happens to it, so a checker still gets a chance to notice
Sage changed something mid-check, rather than quietly finishing a checklist
that's gone stale underneath them.

**Known residual risk:** this only guards against the order disappearing
*after* it's already dispatched. If a future Sage amendment instead *adds*
an item to an order, and that happens after the truck has already left,
nothing currently catches it - the existing safety check that would
normally catch a late-arriving item (the DFV0013963 fix, see **Making the
app faster** below) is also keyed to the old `OrderID`, which no longer
exists in Packing & Production's data by then, so it has nothing left to
compare against. Worth revisiting (comparing by order number instead of
hiding outright) if a future report turns out to be a genuinely missed item,
rather than a harmless case like this one.

## Making the app faster

A few things were changed under the hood to make the app feel snappier,
with no change to how anything works or looks:

- **The Admin Dashboard used to read the whole Packing & Production sheet
  twice** every time it loaded (once for "today's orders", once for
  "overdue") - now it reads it once and reuses that data for both.
- **The "+ Add Order" search used to hit the server on every single
  keystroke** (with a short delay to soften it). It now fetches the day's
  order list once, the moment the search box opens, and every keystroke
  after that just filters that list on the phone instantly.
- **The "No Stock" reasons list used to be fetched from the server every
  time "No Stock" was tapped**, cached for up to 5 minutes as a fix. Moot
  now - the whole No-Stock Reasons feature was later removed (see **4. Set
  up users, trucks, and drivers** above), so "No Stock" is just a single
  tap with nothing to fetch at all any more.
- **Dragging an order onto a truck on the Trucks board used to take up to
  ~15 seconds.** Every drop used to re-load the entire board afterwards,
  which re-read all of today's orders from Packing & Production a *second*
  time - on top of the read the drop itself had just done to allocate the
  order. The board now updates itself immediately on drop instead of
  waiting on that reload, and the dropped order shows a "saving..." spinner
  on its own chip until the server confirms it (and can't be dragged again
  until it does) - so there's now visible feedback for the wait as well as
  less of a wait. If a drop fails (e.g. someone else just dispatched that
  truck), the board reloads for real at that point, to make sure it's
  showing what actually happened.
- **The Packing & Production read itself is now cached for 45 seconds**,
  shared across everyone using the app at once (Google's `CacheService`),
  after a live Admin Dashboard load actually timed out on this exact read
  (`Request timed out after 20s (action: getOrderFulfillmentOverview)`) -
  on a large enough Packing & Production sheet, opening it and reading both
  tabs in full was slow enough on its own to blow through the app's 20-second
  timeout, and that's true no matter how much the rest of the app avoids
  re-reading it. This is the CacheService change flagged as a future
  possibility in an earlier version of this section - it's now switched on.
  The tradeoff mentioned there is real: for up to 45 seconds after an order
  is added or edited directly in the Packing & Production sheet, the
  Dashboard/board/order search here can be that far behind. Switching the
  connected spreadsheet (Admin > Data Source) always reads fresh rather than
  serving another sheet's cached data, since the cache key includes which
  spreadsheet is configured.

**A second efficiency pass (build-2026-09-16-02)** went looking specifically
for redundant Google Sheets reads and general bloat, the same kind of
exercise already done for Packing & Production - the app was already
working correctly, this was purely about trimming waste, not fixing bugs:

- **The Trucks board (`getTruckAssignmentBoard`) had no caching at all**,
  despite being polled every 15 seconds by every Dispatch Manager/checker
  who has it open (see the auto-refresh note above) - 5 people watching the
  board at once meant 5x the Sheets reads for what's overwhelmingly the
  same answer within any given 15-second window. It's now cached for 5
  seconds (deliberately much shorter than the 15-second poll - this only
  needs to collapse several people's polls landing in the same instant, not
  survive between polls), the same `CacheService` pattern already used for
  the Packing & Production read above. A drag-and-drop's own on-screen
  update is unaffected either way, since that's always been fully
  optimistic and never waited on a re-read of the board to begin with.
- **Dragging an order from one truck straight onto a different truck** used
  to look up that order's existing allocation twice - once to check whether
  the move was even allowed, then a second time (from scratch) to actually
  remove it - for data already sitting in memory from the first lookup.
  Fixed by having the removal step take that already-loaded data directly
  instead of re-deriving it.
- **The Admin Dashboard's order-fulfillment summary** (separately from the
  "reads Packing & Production twice" fix above) also worked out which
  orders were dispatched/collected twice per load - once for "today", once
  for "overdue" - re-reading `TruckSessions`, `OrderChecks`, and
  `CollectedOrders` in full both times for the same answer. Now computed
  once and shared between both.
- **Adding an order to the "Add Order" search results that's already
  allocated to a different truck** used to look up that truck's name with
  its own full `TruckSessions` read, separately for every such order in the
  results. A day with several orders already spread across other trucks
  meant that many extra reads on every keystroke-triggered search. Now
  looked up from one shared read, built at most once per search.
- **Promoting/demoting/deactivating/deleting a user in Admin > Users**
  re-read the entire Checkers sheet a second time purely to check "is this
  the last active Admin?", on top of the read Admin > Users had already
  just done to find that user. Now reuses that same already-loaded list.
- A handful of leftover, never-applied CSS rules (from an earlier item-row
  styling approach that was replaced by the current status-line colors)
  were removed.

None of the above change what anything looks like or how it behaves -
they're all covered by the app's existing automated test suite, which
still passes unchanged after every one of these.

One thing left deliberately alone, worth knowing about if the app still
feels slow after all this: **every request the app makes is fundamentally a
two-step round trip** - it hits the Apps Script `/exec` URL, which redirects
to a second `googleusercontent.com` URL that actually returns the data (see
the Section 2 architecture note). That redirect is baked into how Apps
Script Web Apps work and can't be removed without hosting the backend
somewhere else entirely - it's the main reason the app will never feel
quite as instant as a native app talking to its own server, no matter how
much is optimized elsewhere.

One thing that used to be a long-run risk here - `OrderChecks` and
`ItemChecks` growing forever - is now handled automatically; see **Data
retention** below.

## Data retention

Shane asked that Dispatch not keep its own operational history longer than
2 weeks, to keep the underlying sheets from growing without bound. A new
function, `pruneOldRecords()`, deletes anything older than that from
`TruckSessions`, `OrderChecks`, `ItemChecks`, `CollectedOrders`, `Jobs`,
`PackingIssues`, and `TruckIssues` - the 2-week window is the
`RETENTION_DAYS` constant near the top of `Code.gs`, change it there if
that number ever needs to be different. It
does **not** touch `Trucks`, `Users` (the Checkers sheet), `Drivers`, or
`Settings` - those are ongoing configuration, not day-to-day operational
history, and are never pruned.

Two practical effects worth knowing: the Admin Dashboard's date picker and
Customer Care's "find an order" search can only ever show what's still
within that 2-week window - anything older has genuinely been deleted, not
just hidden. And once deleted, a record cannot be recovered from within the
app - if you'd rather keep a longer paper trail than 2 weeks, say so and
the window can be widened (or the deleted rows archived to a second sheet
instead of being removed outright).

**One exception (2026-09-22):** a `PackingIssues` or `TruckIssues` row that
is still **Open** is never deleted by this 2-week cleanup, however old it
gets - this matches the Dashboard now keeping flagged/reported issues
visible until someone actually resolves them (see **Flagged Packing
Issues, and Truck Issues** above), so an old unresolved one is never
silently swept away out from under that checklist. Only once a row is
marked **Resolved** does the normal 2-week clock start counting against
it, same as everything else on this list.

**One-time setup step:** this only deletes anything when it's actually run,
and it needs to run automatically for the 2-week limit to actually hold -
otherwise it just sits there unused. In the Apps Script editor: click the
function dropdown > `setupDailyPruneTrigger` > **Run** (build-2026-11-10-04;
it installs a nightly run around 02:00 and replaces any older one, so it's
safe to run again). It then keeps running on its own every day. Check it's
there under the clock icon (**Triggers**) in the left sidebar.

Since build-2026-11-10-04 old rows are deleted in blocks rather than one at
a time. One-at-a-time deletes could hit Apps Script's 6-minute limit on a
big backlog, which is how the sheets grew to ~6 weeks of data in Nov 2026
and slowed the whole app. Run a big catch-up prune when nobody is using the
app: deleting rows shifts the rows below them, and a save landing at that
exact moment could hit the wrong row.
You can also run `pruneOldRecords` manually any time from the function
dropdown at the top of the Apps Script editor, the same way `setupSpreadsheet`
is run - it's safe to run as often as you like, since it only ever deletes
rows older than the window, never anything current.

## Troubleshooting a field that "won't save" or shows blank

Whenever an update to `Code.gs` adds a new column (as several updates have -
Registration/Type on Trucks, Driver/Route/etc. on TruckSessions), the very
first thing to do after pasting in the new `Code.gs` is to re-run
`setupSpreadsheet` once from the Apps Script editor's function dropdown -
the same function you ran during initial setup. It's safe to run any time:
it only adds missing column headers to row 1 of each tab (never touches
existing rows), but if you skip it, new columns exist in the sheet with
data being written into them yet no header labeling them - which looks
exactly like "this field is blank" or "this field won't save" in the app,
even though the data is actually sitting in the sheet a column or two over.
If a field looks empty right after an update, re-run `setupSpreadsheet`
first before troubleshooting anything else.
