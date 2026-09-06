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
   This creates all the tabs (Checkers, Trucks, NoStockReasons,
   TruckSessions, OrderChecks, ItemChecks, Settings), seeds the default
   no-stock reasons, and sets a default Admin PIN of **1234**.

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

Once deployed, open the app, tap **Admin** on the login screen, enter the
Admin PIN (1234 by default - change it in Admin > Settings), and go to
**Data Source**:

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

## 4. Set up checkers, trucks, and (optionally) the no-stock reasons

Still in Admin:

- **Checkers**: add each checker's name and a PIN.
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
  truck). A truck can have up to 3 drivers on a given trip.
- **No-Stock Reasons**: a starter list is pre-seeded (Out of stock,
  Short-picked, Quality reject, Damaged in packing, Wrong item packed,
  Awaiting production/prep) - edit, add, or retire as needed.

## Admin Dashboard

The **Dashboard** tab in Admin (the first tab you land on) gives a live view
of today only: how many trucks have started, how many are dispatched vs.
still in progress, total orders checked, total no-stock items, and how many
trucks were dispatched with unresolved warnings overridden. Below that,
every truck active today gets a card showing its checker, driver(s), route,
tray counts by size (Small/Medium/Large/Other), timing, and a breakdown of each order it checked (packed vs.
no-stock, with the no-stock reasons). A truck that was dispatched despite
open warnings (e.g. no driver or route entered, or an order left
unfinished) is highlighted so you can spot it at a glance - that's the
main "something was rushed" signal to watch for. It refreshes each time
you open the tab.

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

## Checking an order: allocate, then check

Before a checker can tick items on an order, it has to be explicitly
**allocated** to the truck they're on. They search for the order, open it,
and tap "Allocate to This Truck" - only then do the Packed/No Stock
controls for its items appear. This is a deliberate extra step (rather than
allocating it silently the moment it's opened) so it's always clear, on
both the checker's screen and the admin Dashboard, exactly which orders
belong to which truck.

Once an order is allocated to a truck, it stays "claimed" by that truck for
the day - opening it from a different truck shows a warning naming the
truck it's actually on. An order can still be opened for checking from a
second truck if that's genuinely needed (the warning doesn't block it), but
in normal use each order should only ever be allocated once.

Every item on an allocated order must be marked Packed or No Stock before
the checker can tap **Done** at the bottom of the order screen - it stays
disabled until then, so it's a clear go/no-go rather than something to
guess at.

### Known limitation: nothing tells a checker which orders belong on their truck

There's still no data anywhere (Sage or the Packing & Production sheet)
that says "these orders go on this truck" - checkers have to search for
the right orders and allocate them themselves. Because of that, the "Mark
as Dispatched" warning can only catch orders that were allocated to this
truck's session and left unfinished; it has no way to warn about an order
that belongs on the truck but was never searched for and allocated at all.
If that turns out to be a real risk on the floor, a next step could be an
explicit manifest/checklist per truck (e.g. loaded from Sage, or built by
an admin) - happy to build that once this is running and you've seen how
it plays out in practice.

## Troubleshooting the API connection

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
