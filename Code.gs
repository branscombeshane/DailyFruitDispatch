/**
 * Daily Fruit - Dispatch
 * Google Apps Script backend.
 *
 * Data lives in the Spreadsheet this script is bound to (the "Dispatch" sheet).
 * Orders are READ-ONLY from the separate Packing & Production spreadsheet -
 * configure the connection in Admin > Data Source once this is deployed.
 *
 * Run setupSpreadsheet() once from the Apps Script editor (Run menu) after
 * binding this script to a new Google Sheet, before deploying as a Web App.
 */

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

var SHEET_NAMES = {
  CHECKERS: 'Checkers',
  TRUCKS: 'Trucks',
  DRIVERS: 'Drivers',
  SESSIONS: 'TruckSessions',
  ORDER_CHECKS: 'OrderChecks',
  ITEM_CHECKS: 'ItemChecks',
  SETTINGS: 'Settings',
  COLLECTED_ORDERS: 'CollectedOrders',
  JOBS: 'Jobs',
  PACKING_ISSUES: 'PackingIssues',
  TRUCK_ISSUES: 'TruckIssues',
  LATE_REASONS: 'LateReasons',
  DRIVER_LOGS: 'DriverLogs',
  TRAY_STOPS: 'TrayStops'
};

var SESSION_STATUS = { IN_PROGRESS: 'In Progress', DISPATCHED: 'Dispatched' };
var ORDER_STATUS = { PENDING: 'Pending', IN_PROGRESS: 'In Progress', COMPLETE: 'Complete' };
// Jobs are deliberately simpler than orders - no item-by-item packing, just
// one instruction to carry out - so they only need two states, not three.
var JOB_STATUS = { PENDING: 'Pending', DONE: 'Done' };
var ITEM_STATUS = { PENDING: 'Pending', PACKED: 'Packed', NO_STOCK: 'No Stock' };
// Shared by PackingIssues and TruckIssues (see those sections further down) -
// both are non-blocking checklist entries (Shane's explicit call, 2026-09-16:
// unlike Jobs, neither of these should stop a truck dispatching), so all
// either one needs is "still needs following up" vs "sorted", not the
// richer per-item status ItemChecks uses.
var ISSUE_STATUS = { OPEN: 'Open', RESOLVED: 'Resolved' };

// Every login (Checkers sheet - see below) has exactly one of these roles,
// which decides what they can access after signing in with name + PIN: a
// Checker gets the truck-checking flow, a Dispatch Manager gets Admin's
// Dashboard tab only (plus the truck-checking flow), an Admin gets the full
// Admin area (plus the truck-checking flow), and Customer Care gets only
// the order lookup (which truck an order is on, and its driver) - nothing
// else. There's no longer a separate PIN-only Admin/Dispatch Manager gate -
// one login, role decides access.
var ROLES = { ADMIN: 'Admin', DISPATCH_MANAGER: 'Dispatch Manager', CHECKER: 'Checker', CUSTOMER_CARE: 'Customer Care', DRIVER: 'Driver' };
// Drivers (build-2026-11-10-01) are NOT on the Checkers/Users sheet - they
// sign in with the name + PIN on their own row of the Drivers list (Admin >
// Drivers), and always get the Driver role: today's trips they're named
// on, and logging deliveries/problems from the road. See verifyCredentials_.

// What a driver can log from the road (DriverLogs.Type). Delivered is a
// plain record; the other two are raised on the Dashboard as open items
// for managers to resolve, same as Truck Issues.
var DRIVER_LOG_TYPES = { DELIVERED: 'Delivered', CUSTOMER_PROBLEM: 'Customer problem', ROAD_INCIDENT: 'Road incident' };
var DRIVER_PROBLEM_CATEGORIES = {
  'Customer problem': ['Customer closed / not available', 'Items rejected or returned', 'Short or missing items', 'Damaged items', 'Wrong address / access problem', 'Other'],
  'Road incident': ['Breakdown', 'Accident', 'Traffic delay', 'Fuel', 'Police / roadblock', 'Other']
};

// The signed-in user for the request being handled, set by
// handleApiRequest_ after the credential check. Each web-app request runs
// in its own fresh script execution, so this never leaks between users.
var CURRENT_USER_ = null;

var SHEET_HEADERS = {
  // Role is appended at the end (non-destructive migration, same as every
  // other column added to an already-deployed sheet elsewhere in this
  // file) - see setupSpreadsheet, which backfills any blank Role to
  // 'Checker' and seeds a default Admin login if none exists yet.
  Checkers: ['ID', 'Name', 'PIN', 'Active', 'CreatedAt', 'Role'],
  // Driver and Route used to live here, fixed per truck. In practice both
  // rotate day to day (drivers aren't tied to one truck, and a truck's
  // route can change trip to trip), so both are now captured per truck
  // SESSION instead (see TruckSessions below) - the Driver/Route columns
  // here are kept only so an already-deployed sheet doesn't need a
  // destructive column removal; neither is read or written by truck-admin
  // code any more. Registration/Type are appended at the end (not
  // inserted) so existing rows in a live sheet don't shift columns.
  // ZohoVehicleID (appended build-2026-11-10-02): which Zoho Creator
  // delivery vehicle - e.g. "(1) - Ntwanano" - this truck carries, set in
  // Admin > Trucks. That's how fruit-tray clients from Zoho's Delivery
  // Schedule end up on the right Dispatch truck (see TrayStops).
  Trucks: ['ID', 'Name', 'Driver', 'Route', 'Active', 'CreatedAt', 'Registration', 'Type', 'ZohoVehicleID'],
  // The pre-set driver list (Admin > Drivers) a trip's driver dropdowns are
  // populated from - separate from the freeform Driver/DriverContacts
  // columns on TruckSessions below, which still store whatever ended up
  // selected/typed for that specific trip either way.
  // PIN appended build-2026-11-10-01 (driver sign-in - see ROLES.DRIVER).
  // Never sent to the browser: listDrivers strips it.
  Drivers: ['ID', 'Name', 'Contact', 'Active', 'CreatedAt', 'PIN'],
  // Driver, DispatchedWithWarnings, DispatchWarningsText, Route and the
  // TraySmall/Medium/Large/Other columns are appended at the end for the
  // same non-destructive-migration reason. Driver can hold up to 4 names,
  // comma-separated ("Sipho, Thabo"), rather than needing separate columns -
  // 3 chosen from the Drivers list plus one freeform slot for someone not
  // on it yet (see updateSessionTrip).
  // TrayCount (the old single tally) is kept as an unused legacy column,
  // superseded by the per-size TraySmall/TrayMedium/TrayLarge/TrayOther columns.
  // DriverContacts holds each driver's phone number, comma-separated in the
  // SAME order as Driver ("082 123 4567, 083 234 5678") so index i in one
  // lines up with index i in the other - also appended at the end.
  // NoTraysOnTrip (appended at the end, same reason as above) is the
  // checker's own explicit "this dispatch genuinely carries no fruit
  // trays" flag - some trips (especially a truck's 2nd dispatch of the
  // day) never carry trays at all, and until this existed there was no way
  // to say so: the tray counts just stayed blank, which markTruckDispatched
  // read as "not entered" and flagged as a dispatched-with-warnings issue
  // indistinguishable from someone genuinely forgetting to count. See
  // updateTrayCounts/markTruckDispatched below.
  // TruckIssuesPrompted (appended at the end, same non-destructive-migration
  // reason) tracks whether the mandatory "any truck issues?" prompt has
  // already been shown for THIS trip - set false only when a brand-new
  // session is created (createTruckSession_) and flipped true by
  // reportTruckIssues once the checker answers it, so the prompt fires
  // once per new trip, not every time the truck is opened/resumed (Shane's
  // request, 2026-09-16 - see the TRUCK ISSUES section further down).
  TruckSessions: ['ID', 'Date', 'TruckID', 'TruckName', 'CheckerID', 'CheckerName', 'StartedAt', 'TrayCount', 'TrayCountUpdatedAt', 'Status', 'DispatchedAt', 'DispatchedBy', 'Driver', 'DispatchedWithWarnings', 'DispatchWarningsText', 'Route', 'TraySmall', 'TrayMedium', 'TrayLarge', 'TrayOther', 'DriverContacts', 'NoTraysOnTrip', 'TruckIssuesPrompted', 'LateReason', 'LateReasonOrders'],
  // RequiresCoa/CoaConfirmed(By/At) appended at the end (see the comment on
  // TruckSessions above re: column order never shifting on a live sheet) -
  // RequiresCoa is a snapshot of the order's Packing & Production flag at
  // allocation time (same pattern as OrderNumber/Customer/DeliveryDate
  // above, not read live thereafter); CoaConfirmed is the checker's own
  // on-screen tick, separate from RequiresCoa so "does this order need one"
  // and "has someone actually confirmed it's attached" can never be
  // conflated.
  OrderChecks: ['ID', 'TruckSessionID', 'Date', 'OrderID', 'OrderNumber', 'Customer', 'DeliveryDate', 'Status', 'StartedAt', 'CompletedAt', 'RequiresCoa', 'CoaConfirmed', 'CoaConfirmedBy', 'CoaConfirmedAt'],
  // NoStockReasonID/NoStockReason are vestigial - the admin-managed
  // No-Stock Reasons feature they served was removed (No Stock is now a
  // single tap, no reason picker), but the columns are kept rather than
  // removed so a live sheet's column order never shifts (see the
  // non-destructive-migration comments elsewhere in this file - the same
  // rule applies to removing a column as to inserting one out of order:
  // updateRowById_ writes back positionally by this array's index, so it
  // must always match the physical sheet's column layout). Nothing reads
  // or writes them going forward. PackedQty is appended at the end for the
  // same reason: blank means "packed the full ordered Qty", a value means
  // the checker recorded packing less (or more) via the Edit Qty button.
  ItemChecks: ['ID', 'OrderCheckID', 'TruckSessionID', 'OrderID', 'ItemKey', 'ProductDescription', 'Qty', 'Unit', 'Status', 'NoStockReasonID', 'NoStockReason', 'CheckedBy', 'CheckedAt', 'PackedQty'],
  Settings: ['Key', 'Value'],
  // Orders the customer collected directly instead of going out on a truck -
  // tracked so the end-of-day dispatch overview doesn't flag them as
  // outstanding/overdue just because no truck ever carried them.
  CollectedOrders: ['OrderID', 'OrderNumber', 'Customer', 'CollectedAt', 'CollectedBy'],
  // A non-order instruction added to a truck's CURRENT trip - "collect
  // crates from ABC Farms", "drop off pallets at the depot", and so on -
  // for something that isn't a real Packing & Production order but still
  // needs doing on that run. Replaces the old standalone Non-Order Dispatch
  // feature (Dispatch Manager/Admin only, logged separately from any real
  // trip, per Shane's request 2026-09-16): a Job is added from INSIDE the
  // truck's own workspace (any checker on that truck, right alongside
  // "+ Add Order"), is tied to that specific TruckSessionID like a real
  // order is, and - also per Shane's explicit call - blocks dispatch until
  // marked Done, the same hard rule that already applies to orders. See
  // addJobToTruck/setJobStatus/removeJob below.
  Jobs: ['ID', 'TruckSessionID', 'Date', 'Subject', 'Instructions', 'Status', 'CreatedByID', 'CreatedByName', 'CreatedAt', 'DoneBy', 'DoneAt'],
  // A checker flags a specific item on an order as a packer-quality problem
  // (poor quality, wrong weight, etc.) while checking stock, with a short
  // free-text note - Shane's request (2026-09-16). Deliberately NOT tied to
  // the item's own Status and does NOT block dispatch (unlike Jobs) - it's
  // purely a checklist for someone to follow up on afterward, so
  // OrderNumber/Customer/ProductDescription/TruckName are all snapshotted
  // here at flag time (same denormalization pattern as OrderChecks/Jobs
  // elsewhere in this file) so the Admin Dashboard checklist never needs to
  // join back across three sheets just to show what was flagged and where.
  PackingIssues: ['ID', 'TruckSessionID', 'OrderCheckID', 'ItemCheckID', 'Date', 'TruckName', 'OrderNumber', 'Customer', 'ProductDescription', 'Note', 'Status', 'FlaggedByID', 'FlaggedByName', 'FlaggedAt', 'ResolvedByName', 'ResolvedAt'],
  // A checker reports truck issues (mechanical problems, cleanliness, etc.)
  // via the mandatory prompt shown once at the start of a brand-new trip
  // (see TruckSessions.TruckIssuesPrompted above) - Shane's request
  // (2026-09-16). Also non-blocking, same reasoning as PackingIssues above -
  // just a checklist for Dispatch Managers to work through on the Dashboard.
  TruckIssues: ['ID', 'TruckSessionID', 'TruckID', 'TruckName', 'Date', 'Note', 'Status', 'ReportedByID', 'ReportedByName', 'ReportedAt', 'ResolvedByName', 'ResolvedAt'],
  // The list a checker picks from when a truck's first trip of the day is
  // dispatched late (build-2026-11-09-01, Shane's request) - managed in
  // Admin > Settings > Late Reasons, same shape as the Drivers list. The
  // chosen reason's text is snapshotted onto TruckSessions.LateReason
  // (appended at the end of that sheet, same non-destructive-migration
  // rule as every other added column), so renaming or deleting a reason
  // here later never rewrites what was recorded against a past dispatch.
  //
  // RequiresOrder (appended build-2026-11-09-02, Shane's request): a reason
  // like "Order not packed by night shift" is only useful if management
  // knows WHICH order, so with this ticked the checker must also pick the
  // order(s) on the truck it applies to. Those are saved on
  // TruckSessions.LateReasonOrders (order numbers) and each one is raised
  // as an open item on the Dashboard's Flagged Packing Issues checklist,
  // for management to resolve with night shift.
  LateReasons: ['ID', 'Name', 'Active', 'CreatedAt', 'RequiresOrder'],
  // Everything drivers log from the road (build-2026-11-10-01): one row per
  // delivered stop, customer problem or road incident. TruckName/
  // OrderNumber/Customer are snapshotted at log time, same pattern as
  // PackingIssues. Status is Open/Resolved for problems and incidents
  // (managers resolve them on the Dashboard) and blank for Delivered.
  DriverLogs: ['ID', 'Date', 'TruckSessionID', 'TruckName', 'DriverID', 'DriverName', 'Type', 'OrderCheckID', 'OrderNumber', 'Customer', 'Category', 'Note', 'LoggedAt', 'Status', 'ResolvedByName', 'ResolvedAt', 'TrayStopID'],
  // Fruit-tray deliveries copied from Zoho Creator's Delivery Schedule
  // (build-2026-11-10-02) by dzPullTrayStops_ in ZohoCreator.gs - one row
  // per Zoho order per delivery date (a "tray stop"), replaced on every
  // pull. ID is "<Zoho order ID>_<date>", so it stays the same across
  // pulls and a driver's Delivered tick (DriverLogs.TrayStopID) survives.
  // Read-only copy: Zoho stays the place to change tray orders.
  TrayStops: ['ID', 'Date', 'ZohoOrderID', 'OrderNo', 'Customer', 'ZohoVehicleID', 'ZohoVehicle', 'Products', 'TotalQty', 'PulledAt']
};

// ---------------------------------------------------------------------------
// WEB APP ENTRY POINT
//
// The real frontend is the static index.html hosted on GitHub Pages
// (dispatch.dailyfruit.co.za), which calls this Web App as a JSON API over
// fetch() - it does NOT use google.script.run, because that only works when
// Apps Script itself serves the page. This doGet also serves index.html
// directly when there's no ?action=, purely so you can test the app straight
// against the Web App URL before GitHub Pages/DNS is wired up.
// ---------------------------------------------------------------------------

function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApiRequest_(e.parameter.action, safeJsonParse_(e.parameter.params) || [], safeJsonParse_(e.parameter.auth));
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Daily Fruit - Dispatch')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

function doPost(e) {
  var body = safeJsonParse_(e && e.postData && e.postData.contents) || {};
  return handleApiRequest_(body.action, body.params || [], body.auth);
}

function safeJsonParse_(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}

// Whitelist of functions callable from the frontend, keyed by action name.
var API_ACTIONS = {
  authenticateUser: authenticateUser,
  listCheckers: listCheckers,
  addChecker: addChecker,
  updateChecker: updateChecker,
  deleteChecker: deleteChecker,
  listTrucks: listTrucks,
  getTrucksForSelection: getTrucksForSelection,
  addTruck: addTruck,
  updateTruck: updateTruck,
  deleteTruck: deleteTruck,
  listDrivers: listDrivers,
  addDriver: addDriver,
  updateDriver: updateDriver,
  deleteDriver: deleteDriver,
  getAdminSettings: getAdminSettings,
  probeSpreadsheet: probeSpreadsheet,
  saveDataSourceConfig: saveDataSourceConfig,
  searchOrders: searchOrders,
  findOrderAcrossTrucks: findOrderAcrossTrucks,
  getOrdersForSession: getOrdersForSession,
  startTruckSession: startTruckSession,
  startNewTruckSession: startNewTruckSession,
  getTruckSessionsForTruckToday: getTruckSessionsForTruckToday,
  getTruckSessionState: getTruckSessionState,
  updateTrayCounts: updateTrayCounts,
  updateSessionTrip: updateSessionTrip,
  allocateOrderToTruck: allocateOrderToTruck,
  assignOrderToTruck: assignOrderToTruck,
  getTruckAssignmentBoard: getTruckAssignmentBoard,
  getTruckPackTimerInfo: getTruckPackTimerInfo,
  getOrderForChecking: getOrderForChecking,
  unallocateOrder: unallocateOrder,
  setItemStatus: setItemStatus,
  setOrderCoaConfirmed: setOrderCoaConfirmed,
  markTruckDispatched: markTruckDispatched,
  getTodaysTruckOverview: getTodaysTruckOverview,
  getDashboardForDate: getDashboardForDate,
  getLateTruckLeaderboard: getLateTruckLeaderboard,
  getOrderFulfillmentOverview: getOrderFulfillmentOverview,
  markOrderCollected: markOrderCollected,
  unmarkOrderCollected: unmarkOrderCollected,
  getJobsForSession: getJobsForSession,
  addJobToTruck: addJobToTruck,
  setJobStatus: setJobStatus,
  removeJob: removeJob,
  listJobsForDate: listJobsForDate,
  flagPackingIssue: flagPackingIssue,
  listPackingIssuesForDate: listPackingIssuesForDate,
  listOpenPackingIssues: listOpenPackingIssues,
  setPackingIssueStatus: setPackingIssueStatus,
  reportTruckIssues: reportTruckIssues,
  listTruckIssuesForDate: listTruckIssuesForDate,
  listOpenTruckIssues: listOpenTruckIssues,
  setTruckIssueStatus: setTruckIssueStatus,
  listLateReasons: listLateReasons,
  addLateReason: addLateReason,
  updateLateReason: updateLateReason,
  deleteLateReason: deleteLateReason,
  getTrayStopsForTruck: getTrayStopsForTruck,
  getZohoTraySettings: getZohoTraySettings,
  refreshTrayStops: refreshTrayStops,
  driverMarkTrayDelivered: driverMarkTrayDelivered,
  getMyDriverTrips: getMyDriverTrips,
  driverMarkDelivered: driverMarkDelivered,
  driverReport: driverReport,
  listOpenDriverReports: listOpenDriverReports,
  listDriverReportsForDate: listDriverReportsForDate,
  setDriverReportStatus: setDriverReportStatus
};

// ---------------------------------------------------------------------------
// API ACCESS CONTROL (build-2026-11-06-01)
//
// Before this, handleApiRequest_ ran any action above for anyone who called
// the Web App URL - the PIN was only ever checked once, by authenticateUser,
// and the frontend's role-based screens were the only thing standing
// between a caller and e.g. listCheckers (every PIN) or saveDataSourceConfig.
// The Web App URL is public (it's in index.html on GitHub Pages), so that
// was no protection at all.
//
// Now every request except authenticateUser must carry auth = { name, pin },
// which is re-checked against the Checkers sheet (via a ~60s cache - see
// getAuthUsers_) before the action runs, and the matched user's Role must be
// allowed that action by ACTION_ROLES below. Anything not listed in
// ACTION_ROLES is refused outright, so a new action added to API_ACTIONS
// without a matching entry here fails closed rather than open.
// ---------------------------------------------------------------------------

// Actions that skip the credential check. authenticateUser checks the
// credentials itself (and counts failed attempts the same way).
var PUBLIC_ACTIONS = { authenticateUser: true };

var ACTION_ROLES = buildActionRoles_();

function buildActionRoles_() {
  var ALL = [ROLES.ADMIN, ROLES.DISPATCH_MANAGER, ROLES.CHECKER, ROLES.CUSTOMER_CARE];
  var TRUCK_FLOW = [ROLES.ADMIN, ROLES.DISPATCH_MANAGER, ROLES.CHECKER];
  var MANAGERS = [ROLES.ADMIN, ROLES.DISPATCH_MANAGER];
  var ADMIN_ONLY = [ROLES.ADMIN];
  var DRIVERS_ONLY = [ROLES.DRIVER];
  var groups = [
    // Drivers only ever see their own trips today (see getMyDriverTrips).
    [DRIVERS_ONLY, ['getMyDriverTrips', 'driverMarkDelivered', 'driverReport', 'driverMarkTrayDelivered']],
    // Customer Care's order lookup - also used by the Dashboard's own
    // order search, so every role gets it.
    [ALL, ['findOrderAcrossTrucks']],
    // Truck-checking flow. Includes the Trucks Board (getTruckAssignmentBoard/
    // assignOrderToTruck): since 2026-10-26 Checkers land on the board and
    // drag orders onto trucks themselves (see goToTrucks in index.html), so
    // taking it away from Checkers would break their login. listDrivers
    // feeds the trip's driver dropdowns.
    [TRUCK_FLOW, [
      'getTrucksForSelection', 'listDrivers', 'searchOrders', 'getOrdersForSession',
      'startTruckSession', 'startNewTruckSession', 'getTruckSessionsForTruckToday',
      'getTruckSessionState', 'updateTrayCounts', 'updateSessionTrip',
      'allocateOrderToTruck', 'assignOrderToTruck', 'getTruckAssignmentBoard',
      'getTruckPackTimerInfo', 'getOrderForChecking', 'unallocateOrder',
      'setItemStatus', 'setOrderCoaConfirmed', 'markTruckDispatched',
      'getJobsForSession', 'addJobToTruck', 'setJobStatus', 'removeJob',
      'flagPackingIssue', 'reportTruckIssues', 'getTrayStopsForTruck'
    ]],
    // Dashboard / History / issues checklists / collected orders.
    [MANAGERS, [
      'getTodaysTruckOverview', 'getDashboardForDate', 'getLateTruckLeaderboard',
      'getOrderFulfillmentOverview', 'markOrderCollected', 'unmarkOrderCollected',
      'listJobsForDate', 'listPackingIssuesForDate', 'listOpenPackingIssues',
      'setPackingIssueStatus', 'listTruckIssuesForDate', 'listOpenTruckIssues',
      'setTruckIssueStatus', 'listOpenDriverReports', 'listDriverReportsForDate', 'setDriverReportStatus',
      'refreshTrayStops'
    ]],
    // Settings: users, trucks, drivers, data source.
    [ADMIN_ONLY, [
      'listCheckers', 'addChecker', 'updateChecker', 'deleteChecker',
      'listTrucks', 'addTruck', 'updateTruck', 'deleteTruck',
      'addDriver', 'updateDriver', 'deleteDriver',
      'listLateReasons', 'addLateReason', 'updateLateReason', 'deleteLateReason', 'getZohoTraySettings',
      'getAdminSettings', 'probeSpreadsheet', 'saveDataSourceConfig'
    ]]
  ];
  var map = {};
  groups.forEach(function (g) {
    g[1].forEach(function (action) { map[action] = g[0]; });
  });
  return map;
}

// Thrown for a missing/wrong/stale login, so handleApiRequest_ can flag the
// response with authError: true - the frontend uses that to send the user
// back to the login screen (e.g. their PIN was just changed, or they were
// deactivated) instead of showing a generic error.
function AuthError_(message) {
  var err = new Error(message);
  err.isAuthError = true;
  return err;
}

function handleApiRequest_(action, params, auth) {
  var result;
  try {
    var fn = API_ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    if (!PUBLIC_ACTIONS[action]) {
      if (!auth || !auth.name || !auth.pin) throw AuthError_('Please sign in again.');
      var check = verifyCredentials_(auth.name, auth.pin);
      if (!check.ok) throw AuthError_(check.error);
      var allowed = ACTION_ROLES[action];
      if (!allowed || allowed.indexOf(check.user.role) === -1) {
        throw new Error('Your role (' + check.user.role + ') doesn\'t have access to that.');
      }
      CURRENT_USER_ = check.user;
    }
    result = fn.apply(null, Array.isArray(params) ? params : []);
    return jsonResponse_({ success: true, result: result });
  } catch (err) {
    var out = { success: false, error: err.message };
    if (err.isAuthError) out.authError = true;
    return jsonResponse_(out);
  }
}

// ---------------------------------------------------------------------------
// CREDENTIAL CHECKS
// ---------------------------------------------------------------------------

var AUTH_USERS_CACHE_KEY = 'authUsers_v2';
var AUTH_USERS_CACHE_TTL_SECONDS = 60;
// Brute-force guard: a 4-digit PIN is only 10,000 guesses, and with every
// request now carrying a PIN, any action is a guessing endpoint, not just
// the login. After this many wrong PINs for one name, that name is locked
// for AUTH_LOCKOUT_SECONDS (counted per name, so one person's lockout
// doesn't affect anyone else).
var AUTH_MAX_FAILURES = 10;
var AUTH_LOCKOUT_SECONDS = 15 * 60;

function hashPin_(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'dispatch-pin:' + String(pin).trim());
  return Utilities.base64Encode(bytes);
}

// The Checkers sheet, reduced to what auth needs, cached for ~60s so the
// per-request check doesn't cost a full sheet read on every call. PINs are
// stored hashed in the cache. addChecker/updateChecker/deleteChecker clear
// the cache, so changes made in the app apply immediately; an edit typed
// straight into the sheet takes up to 60s.
function getAuthUsers_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(AUTH_USERS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to a fresh read */ }
  }
  var users = sheetToObjects_(getSheet_(SHEET_NAMES.CHECKERS)).map(function (u) {
    return {
      id: u.ID,
      name: String(u.Name).trim(),
      pinHash: hashPin_(u.PIN),
      active: !(u.Active === false || String(u.Active).toUpperCase() === 'FALSE'),
      role: u.Role || ROLES.CHECKER
    };
  });
  // Drivers with a PIN set can sign in too, always as Driver. A driver
  // with no PIN yet simply can't sign in.
  var driversSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.DRIVERS);
  if (driversSheet) {
    sheetToObjects_(driversSheet).forEach(function (d) {
      if (d.PIN === undefined || String(d.PIN).trim() === '') return;
      users.push({
        id: d.ID,
        name: String(d.Name).trim(),
        pinHash: hashPin_(d.PIN),
        active: d.Active === true || String(d.Active).toUpperCase() === 'TRUE',
        role: ROLES.DRIVER
      });
    });
  }
  try { cache.put(AUTH_USERS_CACHE_KEY, JSON.stringify(users), AUTH_USERS_CACHE_TTL_SECONDS); } catch (e) { /* best-effort */ }
  return users;
}

function clearAuthUsersCache_() {
  try { CacheService.getScriptCache().remove(AUTH_USERS_CACHE_KEY); } catch (e) { /* best-effort */ }
}

function verifyCredentials_(name, pin) {
  var key = String(name || '').trim().toLowerCase();
  var pinStr = String(pin == null ? '' : pin).trim();
  if (!key || !pinStr) return { ok: false, error: 'Enter your name and PIN.' };

  var cache = CacheService.getScriptCache();
  var failKey = 'authFail_' + hashPin_(key).slice(0, 40);
  var failures = parseInt(cache.get(failKey), 10) || 0;
  if (failures >= AUTH_MAX_FAILURES) {
    return { ok: false, error: 'Too many wrong PINs for this name. Try again in 15 minutes, or ask an Admin.' };
  }

  // A name can be on both lists (e.g. a checker who also drives) - the
  // PIN typed decides which login it is.
  var pinHash = hashPin_(pinStr);
  var match = getAuthUsers_().filter(function (u) { return u.name.toLowerCase() === key && u.pinHash === pinHash; })[0];
  if (!match) {
    try { cache.put(failKey, String(failures + 1), AUTH_LOCKOUT_SECONDS); } catch (e) { /* best-effort */ }
    // Same message whether the name or the PIN was wrong, so the endpoint
    // can't be used to find out which names exist.
    return { ok: false, error: 'Name or PIN not recognized.' };
  }
  if (!match.active) return { ok: false, error: 'This user is inactive. See an admin.' };
  if (failures) { try { cache.remove(failKey); } catch (e) { /* best-effort */ } }
  return { ok: true, user: { id: match.id, name: match.name, role: match.role } };
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// SETUP (run once from the Apps Script editor)
// ---------------------------------------------------------------------------

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = SHEET_HEADERS[name];
    var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var needsHeaders = headers.some(function (h, i) { return existing[i] !== h; });
    if (needsHeaders) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  });

  // Remove the default "Sheet1" if it's empty and unused
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0) ss.deleteSheet(sheet1);

  // Seed default settings if missing
  var settings = readSettings_();
  var defaults = { PackingSpreadsheetId: '' };
  Object.keys(defaults).forEach(function (key) {
    if (!(key in settings)) writeSetting_(key, defaults[key]);
  });

  // Every login now carries its own Role (Admin/Dispatch Manager/Checker) on
  // the Checkers sheet, instead of a separate PIN-only Admin/Dispatch
  // Manager gate. Role was just appended as a new column above, so any row
  // written before this change has a blank Role - backfill those to
  // Checker (what they always were) rather than leaving them blank and
  // unable to sign in at all.
  var checkersSheet = getSheet_(SHEET_NAMES.CHECKERS);
  var checkerData = checkersSheet.getDataRange().getValues();
  var roleColIdx = SHEET_HEADERS.Checkers.indexOf('Role');
  for (var i = 1; i < checkerData.length; i++) {
    if (!checkerData[i][roleColIdx]) checkersSheet.getRange(i + 1, roleColIdx + 1).setValue(ROLES.CHECKER);
  }

  // Force the whole PIN column to Plain Text formatting, not just new/edited
  // rows going forward (see appendObjectForcingText_/updateRowById_ above) -
  // this also covers a PIN typed directly into the sheet by hand, and
  // covers this column for any row appended after this runs. Safe/cheap to
  // re-run. Note this can't recover a PIN that was ALREADY stripped of its
  // leading zero before this fix existed - that data is already gone, so
  // anyone whose PIN starts with 0 should just re-enter it once via Users.
  var pinColIdx = SHEET_HEADERS.Checkers.indexOf('PIN') + 1;
  checkersSheet.getRange(1, pinColIdx, checkersSheet.getMaxRows(), 1).setNumberFormat('@');

  // Same leading-zero problem, same fix, for every column that holds
  // nothing but a phone number: the Drivers list's Contact column, and
  // TruckSessions' DriverContacts column (a trip's driver contact
  // number(s), comma-joined). A number like "0821234567" is otherwise
  // silently reinterpreted by Sheets as a Number and loses its leading 0 -
  // already-affected rows can't be recovered by this (that data is already
  // gone), so re-enter any driver's number that's already missing its 0
  // once via Admin > Drivers or the trip modal.
  var driversSheet = getSheet_(SHEET_NAMES.DRIVERS);
  var driverContactColIdx = SHEET_HEADERS.Drivers.indexOf('Contact') + 1;
  driversSheet.getRange(1, driverContactColIdx, driversSheet.getMaxRows(), 1).setNumberFormat('@');

  var sessionsSheet = getSheet_(SHEET_NAMES.SESSIONS);
  var driverContactsColIdx = SHEET_HEADERS.TruckSessions.indexOf('DriverContacts') + 1;
  sessionsSheet.getRange(1, driverContactsColIdx, sessionsSheet.getMaxRows(), 1).setNumberFormat('@');

  // Same leading-zero/numeric-coercion problem, same fix, for OrderID -
  // traced 2026-10-30 (a dispatch manager reported an order that had
  // genuinely dispatched on a truck still showing in the Dashboard's
  // Outstanding section). Packing & Production's own internal OrderID
  // (distinct from the human-readable SageRef - see
  // fetchAllOrdersFromPackingUncached_'s comment) can be a purely numeric
  // string; every write of it into Dispatch's own sheets (OrderChecks via
  // allocateOrderToTruck, ItemChecks alongside it) goes through this
  // column unformatted, so a leading-zero OrderID can silently become a
  // Number on write, same as PIN/Contact/DriverContacts above - already
  // flagged as exactly this risk in allocateOrderToTruck's own comment,
  // but only worked around THERE (comparing String(...) on both sides for
  // that function's own just-written-row check), never fixed at the
  // source. getDispatchedOrderIds_ (Code.gs) cross-references OrderChecks.
  // OrderID against Packing's own freshly-read OrderID string to decide
  // whether an order counts as dispatched for the Fulfillment Overview - if
  // the stored value silently lost a leading zero, that comparison
  // silently stops matching FOREVER, even though the SAME order correctly
  // shows up under its truck on the Dashboard's own "Today's trucks" card
  // (which groups by TruckSessionID only, never by OrderID) - exactly the
  // "dispatched on a truck, but still Outstanding" split Shane described.
  // As with PIN above, this can't recover an OrderID that's already been
  // silently converted before this fix ran - any order already stuck this
  // way needs a one-off manual fix (re-entering the OrderChecks/ItemChecks
  // OrderID cell as text, or just marking it Collected), not something
  // this blanket formatting pass can undo after the fact.
  var orderChecksSheet_ = getSheet_(SHEET_NAMES.ORDER_CHECKS);
  var orderChecksOrderIdColIdx = SHEET_HEADERS.OrderChecks.indexOf('OrderID') + 1;
  orderChecksSheet_.getRange(1, orderChecksOrderIdColIdx, orderChecksSheet_.getMaxRows(), 1).setNumberFormat('@');

  var itemChecksSheet_ = getSheet_(SHEET_NAMES.ITEM_CHECKS);
  var itemChecksOrderIdColIdx = SHEET_HEADERS.ItemChecks.indexOf('OrderID') + 1;
  itemChecksSheet_.getRange(1, itemChecksOrderIdColIdx, itemChecksSheet_.getMaxRows(), 1).setNumberFormat('@');

  // Guarantee there is always at least one Admin login, so re-running this
  // (or running it fresh) never locks you out of Admin - matches the old
  // default AdminPin of '1234', just as a named user now instead of an
  // anonymous PIN.
  var hasAdmin = sheetToObjects_(checkersSheet).some(function (c) { return c.Role === ROLES.ADMIN; });
  if (!hasAdmin) {
    appendObjectForcingText_(checkersSheet, SHEET_HEADERS.Checkers, {
      ID: Utilities.getUuid(), Name: 'Admin', PIN: '1234', Active: true, CreatedAt: nowIso_(), Role: ROLES.ADMIN
    }, ['PIN']);
  }

  SpreadsheetApp.flush();
  return 'Setup complete.';
}

// ---------------------------------------------------------------------------
// SHEET HELPERS
// ---------------------------------------------------------------------------

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run setupSpreadsheet() first.');
  return sheet;
}

function sheetToObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = values.slice(1);
  return rows
    .filter(function (row) { return row.some(function (cell) { return cell !== '' && cell !== null; }); })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function findRowIndexById_(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return i + 1; // 1-indexed sheet row
  }
  return -1;
}

function appendObject_(sheet, headers, obj) {
  var row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sheet.appendRow(row);
}

/**
 * Like appendObject_, but for writing several rows at once (e.g. every item
 * on an order being allocated to a truck) - uses ONE getRange/setValues call
 * for the whole batch instead of one sheet.appendRow() per row.
 *
 * This isn't just an efficiency nicety: calling appendRow() back-to-back in
 * a tight loop, once per row, gives Sheets' backend N separate chances to
 * drop a single row without the script ever seeing an error (each call is
 * its own round trip that independently computes "the next empty row" -
 * under load that occasionally loses a race and one write never lands,
 * with nothing thrown for the loop to catch). This is the confirmed cause
 * of products silently missing from individual orders in Dispatch (traced
 * 2026-10-01: order INV0138094 was missing Spinach - Packing & Production's
 * OrderItems had it, Dispatch's own ItemChecks simply never got that one
 * row written when the order was allocated; the ItemKey sequence in
 * ItemChecks jumped straight from _5 to _7, confirming the 7th
 * appendRow() call in that loop silently no-opped while the 21 others
 * succeeded). A single batched write has no such gap to fall into - it's
 * one atomic call that either writes every row or throws.
 *
 * No-ops for an empty/undefined array (getRange rejects a 0-row range).
 */
function appendObjects_(sheet, headers, objs) {
  if (!objs || objs.length === 0) return;
  var rows = objs.map(function (obj) {
    return headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  });
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
}

/**
 * Like appendObject_, but forces specific columns (by header name) to
 * Plain Text format on the new row BEFORE writing the value - otherwise
 * Google Sheets silently reinterprets a numeric-looking value (e.g. a PIN
 * of "0123") as the Number 123, dropping the leading zero. The format has
 * to be set before the value is written; reformatting a cell afterward
 * can't undo a conversion that's already happened. Uses an explicit row
 * index (rather than sheet.appendRow, which picks its own) so the same row
 * is guaranteed to be both the one formatted and the one written to.
 */
function appendObjectForcingText_(sheet, headers, obj, textColumnNames) {
  var rowIndex = sheet.getLastRow() + 1;
  textColumnNames.forEach(function (colName) {
    var colIdx = headers.indexOf(colName);
    if (colIdx !== -1) sheet.getRange(rowIndex, colIdx + 1, 1, 1).setNumberFormat('@');
  });
  var row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
}

/**
 * forceTextColumns (optional): header names that must be Plain Text
 * formatted before this patch's value is written - same leading-zero
 * problem as appendObjectForcingText_ above, but for an edit to an
 * existing row rather than a new one. Only reformats a column that's
 * actually part of this patch, so unrelated edits to the same row don't
 * pay for it.
 */
function updateRowById_(sheet, headers, id, patch, forceTextColumns) {
  var rowIndex = findRowIndexById_(sheet, id);
  if (rowIndex === -1) throw new Error('Row with ID ' + id + ' not found in ' + sheet.getName());
  if (forceTextColumns) {
    forceTextColumns.forEach(function (colName) {
      if (patch[colName] === undefined) return;
      var colIdx = headers.indexOf(colName);
      if (colIdx !== -1) sheet.getRange(rowIndex, colIdx + 1, 1, 1).setNumberFormat('@');
    });
  }
  var current = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var updated = headers.map(function (h, i) { return patch[h] !== undefined ? patch[h] : current[i]; });
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([updated]);
  return updated;
}

function deleteRowById_(sheet, id) {
  var rowIndex = findRowIndexById_(sheet, id);
  if (rowIndex === -1) throw new Error('Row with ID ' + id + ' not found in ' + sheet.getName());
  sheet.deleteRow(rowIndex);
  return true;
}

/**
 * Deletes every row (other than the header) for which matchFn(row, headers)
 * is true - used where a single parent ID (e.g. an OrderCheck) can own
 * several child rows (its ItemChecks) that all need to go together. Walks
 * bottom-to-top so deleting a row doesn't shift the index of rows still to
 * be checked.
 */
function deleteRowsWhere_(sheet, matchFn) {
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  // Deletes in contiguous blocks with ONE deleteRows call per block
  // (build-2026-11-10-04), still bottom-to-top. It used to call deleteRow
  // once per matching row: fine for an order's handful of ItemChecks, but
  // pruneOldRecords can match tens of thousands of old rows (which sit
  // together at the top, oldest first), and one-at-a-time deletes ran into
  // Apps Script's 6-minute limit long before finishing - so the sheets kept
  // growing and the whole app slowed down with them.
  var runEnd = -1; // sheet row number (1-based) of the bottom of the current block
  for (var i = data.length - 1; i >= 1; i--) {
    var match = matchFn(data[i], headers);
    if (match && runEnd === -1) runEnd = i + 1;
    if (!match && runEnd !== -1) { sheet.deleteRows(i + 2, runEnd - (i + 1)); runEnd = -1; }
  }
  if (runEnd !== -1) sheet.deleteRows(2, runEnd - 1);
}

/**
 * Canonical matching key for an OrderID (build-2026-10-30) - closes the
 * same numeric-coercion risk setupSpreadsheet's OrderID Plain-Text fix
 * above addresses at the formatting level, but for the COMPARISON itself:
 * a leading-zero OrderID stored as text in Packing & Production
 * ("007321") can silently become the Number 7321 once written into one of
 * Dispatch's own sheets, so a bare String(...) === String(...) comparison
 * between the two sides can stop matching even though both plainly mean
 * the same order - this was traced back to a dispatch manager report of a
 * genuinely-dispatched order still showing Outstanding on the Dashboard
 * (getDispatchedOrderIds_ cross-references OrderChecks.OrderID against
 * Packing's own OrderID string this exact way). For a value that's purely
 * digits once trimmed, this normalizes through Number() and back (so
 * "007321", 7321, and "7321" all key identically); anything else (a UUID,
 * an alphanumeric ID, a value that isn't purely numeric) is returned as
 * its trimmed string, unaffected - this assumes a real OrderID never
 * relies on a leading zero to mean something different from the same
 * digits without it, which holds for a plain auto-incrementing internal
 * ID. Used everywhere an OrderID gets matched/looked-up across sheets
 * (never for what gets WRITTEN or displayed - that's still the OrderID's
 * own raw value, Plain-Text-formatted by setupSpreadsheet so it doesn't
 * drift in storage either).
 */
function orderIdKey_(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) {
    var n = Number(s);
    if (isFinite(n)) return String(n);
  }
  return s;
}

function readSettings_() {
  var sheet = getSheet_(SHEET_NAMES.SETTINGS);
  var values = sheet.getDataRange().getValues();
  var settings = {};
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) settings[values[i][0]] = values[i][1];
  }
  return settings;
}

function writeSetting_(key, value) {
  var sheet = getSheet_(SHEET_NAMES.SETTINGS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function todayString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Africa/Johannesburg', 'yyyy-MM-dd');
}

/**
 * A "Date" column is always written as a plain 'yyyy-MM-dd' string (see
 * todayString_), but Google Sheets recognizes that pattern as a date and
 * silently stores the cell as a real Date value anyway - reading it back
 * later then gives a JS Date object, not the string that was written. Every
 * "is this row from today" filter compares a sheet's Date column against a
 * plain today-string, so route it through this first to normalize either
 * shape back to 'yyyy-MM-dd' - otherwise a Date-typed cell never matches a
 * bare string with ===, and a row from today silently looks like it isn't.
 */
function normalizeDateStr_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Africa/Johannesburg', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function nowIso_() {
  return new Date().toISOString();
}

/**
 * Parses either a real Date object (what Google Sheets silently converts
 * a date/timestamp-looking cell value to - see normalizeDateStr_ above for
 * the same gotcha) or a date/timestamp string back into a JS Date, for
 * comparing against a cutoff. Returns null for blank/unparseable values
 * rather than throwing, so a stray blank cell can't crash a prune pass.
 */
function parseAnyDate_(value) {
  if (value instanceof Date) return value;
  var s = String(value || '').trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// DATA RETENTION
//
// Shane doesn't need Dispatch's own operational history kept longer than
// RETENTION_DAYS - and letting TruckSessions/OrderChecks/ItemChecks grow
// forever is exactly the "gradually slows down over many months" risk
// flagged in SETUP.md's performance notes. pruneOldRecords() below deletes
// anything older than that window. It does NOT touch Trucks, Checkers,
// Drivers, or Settings - those are the app's persistent configuration, not
// operational history, and were never meant to expire.
// ---------------------------------------------------------------------------

var RETENTION_DAYS = 14;

// Shane's 2026-10-26 target: a truck should be packed and dispatched within
// this many minutes of its first order being dropped onto it. Used by
// getTruckAssignmentBoardUncached_ to flag a truck's card once its OPEN
// (not yet dispatched) trip has been packing longer than this - see
// openTripPackStartAt below. One constant, read by both the "is this truck
// overdue" calc and the number sent to the frontend, so changing the
// target later only means editing this one line.
var PACK_WARNING_THRESHOLD_MINUTES = 30;

/**
 * ONE-TIME (build-2026-11-10-04): installs the nightly pruneOldRecords run
 * at about 02:00, replacing any existing one - instead of setting the
 * trigger up by hand in the Triggers screen. Run from the editor.
 */
function setupDailyPruneTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'pruneOldRecords') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pruneOldRecords').timeBased().everyDays(1).atHour(2).create();
  Logger.log('Installed: pruneOldRecords runs every night around 02:00 and keeps the last ' + RETENTION_DAYS + ' days.');
}

/**
 * Deletes TruckSessions, OrderChecks, ItemChecks, and CollectedOrders rows
 * older than RETENTION_DAYS. Meant to run automatically once a day via an
 * installable time-driven trigger (Apps Script editor > Triggers (clock
 * icon) > Add Trigger > choose this function, Time-driven, Day timer) -
 * see SETUP.md for the one-time setup step, since a trigger can't be
 * installed from code alone. Can also be run manually any time from the
 * Apps Script editor's function dropdown, same as setupSpreadsheet.
 *
 * Order matters here: OrderChecks and TruckSessions are each pruned first,
 * by their own Date column (both are stamped with the same day's date at
 * creation time, so this can't leave one ahead of the other). ItemChecks
 * has no Date column of its own - it's always a child of exactly one
 * OrderChecks row, created together in allocateOrderToTruck - so it's
 * pruned last, by checking which OrderCheckIDs are still alive AFTER
 * OrderChecks has just been pruned. That's driven by referential
 * integrity rather than re-deriving a second cutoff, so it can't drift out
 * of sync with whatever OrderChecks actually kept.
 */
function pruneOldRecords() {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  var isOld = function (dateValue) {
    var d = parseAnyDate_(dateValue);
    return d !== null && d < cutoff;
  };

  var sessionsSheet = getSheet_(SHEET_NAMES.SESSIONS);
  var sessionsDateCol = SHEET_HEADERS.TruckSessions.indexOf('Date');
  var sessionsDeleted = 0;
  deleteRowsWhere_(sessionsSheet, function (row) {
    var old = isOld(row[sessionsDateCol]);
    if (old) sessionsDeleted++;
    return old;
  });

  var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
  var orderChecksDateCol = SHEET_HEADERS.OrderChecks.indexOf('Date');
  var orderChecksDeleted = 0;
  deleteRowsWhere_(orderChecksSheet, function (row) {
    var old = isOld(row[orderChecksDateCol]);
    if (old) orderChecksDeleted++;
    return old;
  });

  var survivingOrderCheckIds = {};
  sheetToObjects_(orderChecksSheet).forEach(function (oc) { survivingOrderCheckIds[String(oc.ID)] = true; });
  var itemChecksSheet = getSheet_(SHEET_NAMES.ITEM_CHECKS);
  var itemChecksOrderCheckIdCol = SHEET_HEADERS.ItemChecks.indexOf('OrderCheckID');
  var itemChecksDeleted = 0;
  deleteRowsWhere_(itemChecksSheet, function (row) {
    var orphaned = !survivingOrderCheckIds[String(row[itemChecksOrderCheckIdCol])];
    if (orphaned) itemChecksDeleted++;
    return orphaned;
  });

  var collectedSheet = getSheet_(SHEET_NAMES.COLLECTED_ORDERS);
  var collectedAtCol = SHEET_HEADERS.CollectedOrders.indexOf('CollectedAt');
  var collectedDeleted = 0;
  deleteRowsWhere_(collectedSheet, function (row) {
    var old = isOld(row[collectedAtCol]);
    if (old) collectedDeleted++;
    return old;
  });

  var jobsSheet = getSheet_(SHEET_NAMES.JOBS);
  var jobsDateCol = SHEET_HEADERS.Jobs.indexOf('Date');
  var jobsDeleted = 0;
  deleteRowsWhere_(jobsSheet, function (row) {
    var old = isOld(row[jobsDateCol]);
    if (old) jobsDeleted++;
    return old;
  });

  // Open PackingIssues/TruckIssues rows are exempt from age-based pruning
  // entirely (Shane's 2026-09-22 request: these should stay on the
  // Dashboard until someone actually resolves them, however long that
  // takes) - only a RESOLVED row is ever pruned once it's past
  // RETENTION_DAYS, same as every other sheet here.
  var packingIssuesSheet = getSheet_(SHEET_NAMES.PACKING_ISSUES);
  var packingIssuesDateCol = SHEET_HEADERS.PackingIssues.indexOf('Date');
  var packingIssuesStatusCol = SHEET_HEADERS.PackingIssues.indexOf('Status');
  var packingIssuesDeleted = 0;
  deleteRowsWhere_(packingIssuesSheet, function (row) {
    if (row[packingIssuesStatusCol] !== ISSUE_STATUS.RESOLVED) return false;
    var old = isOld(row[packingIssuesDateCol]);
    if (old) packingIssuesDeleted++;
    return old;
  });

  var truckIssuesSheet = getSheet_(SHEET_NAMES.TRUCK_ISSUES);
  var truckIssuesDateCol = SHEET_HEADERS.TruckIssues.indexOf('Date');
  var truckIssuesStatusCol = SHEET_HEADERS.TruckIssues.indexOf('Status');
  var truckIssuesDeleted = 0;
  deleteRowsWhere_(truckIssuesSheet, function (row) {
    if (row[truckIssuesStatusCol] !== ISSUE_STATUS.RESOLVED) return false;
    var old = isOld(row[truckIssuesDateCol]);
    if (old) truckIssuesDeleted++;
    return old;
  });

  // DriverLogs: same rule as the issue sheets above - an open problem or
  // incident stays until someone resolves it; everything else goes once
  // it's older than RETENTION_DAYS.
  var driverLogsDeleted = 0;
  var driverLogsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.DRIVER_LOGS);
  if (driverLogsSheet) {
    var dlDateCol = SHEET_HEADERS.DriverLogs.indexOf('Date');
    var dlStatusCol = SHEET_HEADERS.DriverLogs.indexOf('Status');
    deleteRowsWhere_(driverLogsSheet, function (row) {
      if (row[dlStatusCol] === ISSUE_STATUS.OPEN) return false;
      var old = isOld(row[dlDateCol]);
      if (old) driverLogsDeleted++;
      return old;
    });
  }

  var summary = 'Pruned records older than ' + RETENTION_DAYS + ' days: ' +
    sessionsDeleted + ' truck session(s), ' + orderChecksDeleted + ' order check(s), ' +
    itemChecksDeleted + ' item check(s), ' + collectedDeleted + ' collected-order record(s), ' +
    jobsDeleted + ' job(s), ' + packingIssuesDeleted + ' packing issue(s), ' + truckIssuesDeleted + ' truck issue(s), ' +
    driverLogsDeleted + ' driver log(s).';
  Logger.log(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// AUTH - USERS (one login, role decides access)
// ---------------------------------------------------------------------------

/**
 * Single login for everyone - name + PIN, looked up on the Checkers sheet
 * (kept as the underlying sheet/tab name so an already-deployed sheet needs
 * no manual rename; the Admin UI now calls it "Users"). Replaces the old
 * separate authenticateChecker + PIN-only authenticateAdmin/
 * authenticateDispatchManager gates - the frontend routes to the truck flow,
 * the full Admin area, or the Dashboard-only Admin area purely based on the
 * matched user's Role.
 */
function authenticateUser(name, pin) {
  var check = verifyCredentials_(name, pin);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, user: check.user };
}

// ---------------------------------------------------------------------------
// ADMIN - USERS CRUD (Checkers sheet - Admin / Dispatch Manager / Checker)
// ---------------------------------------------------------------------------

// PINs never leave the server (build-2026-11-06-01) - the Users screen
// gets everything else, and editing a PIN sends a new one via updateChecker.
function listCheckers() {
  return sheetToObjects_(getSheet_(SHEET_NAMES.CHECKERS)).map(function (u) {
    var copy = {};
    Object.keys(u).forEach(function (k) { if (k !== 'PIN') copy[k] = u[k]; });
    return copy;
  });
}

function validateNewPin_(pin) {
  var p = String(pin == null ? '' : pin).trim();
  if (!/^[0-9]{4,}$/.test(p)) throw new Error('PIN must be at least 4 digits.');
  return p;
}

function addChecker(name, pin, role) {
  if (!String(name || '').trim()) throw new Error('Name is required.');
  pin = validateNewPin_(pin);
  clearAuthUsersCache_();
  var sheet = getSheet_(SHEET_NAMES.CHECKERS);
  var id = Utilities.getUuid();
  // Force PIN to Plain Text - a PIN like "0123" would otherwise silently
  // become the Number 123 the moment it's written (see
  // appendObjectForcingText_), permanently dropping the leading zero.
  appendObjectForcingText_(sheet, SHEET_HEADERS.Checkers, {
    ID: id, Name: name, PIN: pin, Active: true, CreatedAt: nowIso_(), Role: role || ROLES.CHECKER
  }, ['PIN']);
  return { id: id };
}

// How many OTHER active Admins exist besides the given ID - used to stop
// the last Admin login from being demoted, deactivated, or deleted, which
// would lock everyone out of Admin with no way back in except editing the
// sheet directly. Takes the already-loaded Checkers rows rather than doing
// its own sheetToObjects_ read - both call sites below already have the
// full list in hand a moment before calling this, so having this helper
// re-read the same sheet from scratch would just be a redundant full-sheet
// read on every Admin update/delete.
function countOtherActiveAdmins_(users, excludingId) {
  return users.filter(function (u) {
    return u.ID !== excludingId && (u.Role || ROLES.CHECKER) === ROLES.ADMIN && u.Active !== false;
  }).length;
}

function updateChecker(id, patch) {
  patch = patch || {};
  // A blank PIN field means "leave the PIN alone", never "set it blank".
  if ('PIN' in patch) {
    if (String(patch.PIN == null ? '' : patch.PIN).trim() === '') delete patch.PIN;
    else patch.PIN = validateNewPin_(patch.PIN);
  }
  if ('ID' in patch) delete patch.ID;
  clearAuthUsersCache_();
  var users = sheetToObjects_(getSheet_(SHEET_NAMES.CHECKERS));
  var current = users.filter(function (u) { return u.ID === id; })[0];
  if (current) {
    var isCurrentlyActiveAdmin = (current.Role || ROLES.CHECKER) === ROLES.ADMIN && current.Active !== false;
    var wouldLoseAdmin = (patch.Role !== undefined && patch.Role !== ROLES.ADMIN) ||
      (patch.Active !== undefined && patch.Active === false);
    if (isCurrentlyActiveAdmin && wouldLoseAdmin && countOtherActiveAdmins_(users, id) === 0) {
      throw new Error('Can\'t do that - ' + current.Name + ' is the only active Admin. Make someone else Admin first.');
    }
  }
  // Force PIN to Plain Text before writing, same reason as addChecker above -
  // otherwise editing a PIN to "0123" would silently save as 123.
  updateRowById_(getSheet_(SHEET_NAMES.CHECKERS), SHEET_HEADERS.Checkers, id, patch, ['PIN']);
  clearAuthUsersCache_();
  return { ok: true };
}

function deleteChecker(id) {
  var users = sheetToObjects_(getSheet_(SHEET_NAMES.CHECKERS));
  var current = users.filter(function (u) { return u.ID === id; })[0];
  if (current && (current.Role || ROLES.CHECKER) === ROLES.ADMIN && current.Active !== false && countOtherActiveAdmins_(users, id) === 0) {
    throw new Error('Can\'t delete ' + current.Name + ' - they\'re the only active Admin. Make someone else Admin first.');
  }
  deleteRowById_(getSheet_(SHEET_NAMES.CHECKERS), id);
  clearAuthUsersCache_();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ADMIN - TRUCKS CRUD
// ---------------------------------------------------------------------------

/**
 * Natural/numeric-aware string comparator - so a list of names like "Truck
 * 1", "Truck 2", ..., "Truck 12" sorts in the order a person would expect
 * (2 before 12) instead of plain lexicographic order (which would put
 * "Truck 12" before "Truck 2"). Splits each string into runs of digits vs.
 * non-digits, compares digit runs numerically and everything else
 * case-insensitively. Falls back gracefully (plain text compare) for names
 * with no digits at all, so it's safe to use as a general-purpose "sort
 * these names sensibly" comparator, not just for purely numeric names.
 */
function naturalCompare_(a, b) {
  var chunks = /(\d+)|(\D+)/g;
  var aParts = String(a == null ? '' : a).match(chunks) || [];
  var bParts = String(b == null ? '' : b).match(chunks) || [];
  var len = Math.max(aParts.length, bParts.length);
  for (var i = 0; i < len; i++) {
    var ap = aParts[i] || '';
    var bp = bParts[i] || '';
    if (ap === bp) continue;
    var aIsNum = /^\d+$/.test(ap);
    var bIsNum = /^\d+$/.test(bp);
    if (aIsNum && bIsNum) {
      var diff = parseInt(ap, 10) - parseInt(bp, 10);
      if (diff !== 0) return diff;
    } else {
      var cmp = ap.toLowerCase().localeCompare(bp.toLowerCase());
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/**
 * Sorted in "numerical order" by truck name (Shane's request) - e.g. Truck
 * 1, Truck 2, ... Truck 12, rather than the raw sheet order (creation
 * order) it used to return. This is the single shared source for every
 * truck list in the app (Admin's Trucks tab, the checker's "Select a
 * truck" screen via getTrucksForSelection, and the Trucks Board via
 * getTruckAssignmentBoard), so sorting here keeps truck ordering
 * consistent everywhere instead of just fixing one screen.
 */
function listTrucks(activeOnly) {
  var trucks = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS));
  if (activeOnly) trucks = trucks.filter(function (t) { return t.Active === true; });
  trucks.sort(function (a, b) { return naturalCompare_(a.Name, b.Name); });
  return trucks;
}

/**
 * Active trucks plus today's dispatch status for each, for the checker's
 * "Select a truck" screen - so a truck that's already been dispatched today
 * shows that up front, instead of a checker only finding out after tapping
 * in. A truck can run more than one dispatch a day, so this also reports
 * whether an in-progress (not yet dispatched) session exists right now.
 *
 * Also includes a per-trip breakdown (driver, route, and the orders
 * allocated to that specific trip) - deliberately NOT merged into one flat
 * list, because the driver (and sometimes the route) can be different on a
 * truck's 2nd or 3rd dispatch of the day, so lumping them together would
 * make it look like one driver had every order when really trip 1 and trip
 * 2 each had their own.
 */
function getTrucksForSelection() {
  var trucks = listTrucks(true);
  var today = todayString_();
  var sessionsToday = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS))
    .filter(function (s) { return normalizeDateStr_(s.Date) === today; })
    .sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); });
  var orderChecksToday = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return normalizeDateStr_(c.Date) === today; });

  var ordersBySessionId = {};
  orderChecksToday.forEach(function (c) {
    if (!ordersBySessionId[c.TruckSessionID]) ordersBySessionId[c.TruckSessionID] = [];
    ordersBySessionId[c.TruckSessionID].push({ orderNumber: c.OrderNumber, customer: c.Customer, status: c.Status });
  });

  return trucks.map(function (t) {
    var truckSessions = sessionsToday.filter(function (s) { return s.TruckID === t.ID; });
    var dispatchCountToday = truckSessions.filter(function (s) { return s.Status === SESSION_STATUS.DISPATCHED; }).length;
    var withStatus = {};
    Object.keys(t).forEach(function (k) { withStatus[k] = t[k]; });
    withStatus.dispatchCountToday = dispatchCountToday;
    withStatus.hasActiveSessionToday = truckSessions.some(function (s) { return s.Status === SESSION_STATUS.IN_PROGRESS; });
    withStatus.trips = truckSessions.map(function (s, i) {
      return {
        tripNumber: i + 1,
        status: s.Status,
        driver: s.Driver || '',
        driverContacts: s.DriverContacts || '',
        route: s.Route || '',
        orders: ordersBySessionId[s.ID] || []
      };
    });
    return withStatus;
  });
}

function addTruck(name, registration, type) {
  var sheet = getSheet_(SHEET_NAMES.TRUCKS);
  var id = Utilities.getUuid();
  appendObject_(sheet, SHEET_HEADERS.Trucks, {
    ID: id, Name: name, Driver: '', Route: '', Active: true, CreatedAt: nowIso_(),
    Registration: registration || '', Type: type || ''
  });
  return { id: id };
}

function updateTruck(id, patch) {
  if (patch && 'ZohoVehicleID' in patch) {
    ensureTraySchema_();
    patch.ZohoVehicleID = String(patch.ZohoVehicleID || '').trim();
  }
  updateRowById_(getSheet_(SHEET_NAMES.TRUCKS), SHEET_HEADERS.Trucks, id, patch);
  return { ok: true };
}

function deleteTruck(id) {
  deleteRowById_(getSheet_(SHEET_NAMES.TRUCKS), id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ADMIN - DRIVERS CRUD
//
// A pre-set list of drivers (name + contact number), managed from Admin >
// Drivers, so a truck session's trip modal can offer them as dropdowns
// instead of re-typing a name and number from scratch every trip. A driver
// not yet on this list is still handled - the trip modal has one extra
// freeform slot for that - so this list only needs to be kept roughly up to
// date, not perfectly complete before anyone can dispatch.
// ---------------------------------------------------------------------------

// PINs never leave the server (same as listCheckers) - hasPin tells the
// Drivers screen whether this driver can sign in yet.
function listDrivers(activeOnly) {
  var drivers = sheetToObjects_(getSheet_(SHEET_NAMES.DRIVERS));
  if (activeOnly) drivers = drivers.filter(function (d) { return d.Active === true; });
  drivers.sort(function (a, b) { return String(a.Name).localeCompare(String(b.Name)); });
  return drivers.map(function (d) {
    var copy = {};
    Object.keys(d).forEach(function (k) { if (k !== 'PIN') copy[k] = d[k]; });
    copy.hasPin = d.PIN !== undefined && String(d.PIN).trim() !== '';
    return copy;
  });
}

function addDriver(name, contact) {
  name = String(name || '').trim();
  if (!name) throw new Error('Enter a driver name.');
  var sheet = getSheet_(SHEET_NAMES.DRIVERS);
  var id = Utilities.getUuid();
  // Contact is forced to Plain Text before this write - it's nothing but
  // digits (e.g. "0821234567"), which Sheets otherwise silently
  // reinterprets as a Number and strips the leading 0 from, same as the
  // PIN column bug elsewhere in this file.
  appendObjectForcingText_(sheet, SHEET_HEADERS.Drivers, {
    ID: id, Name: name, Contact: String(contact || '').trim(), Active: true, CreatedAt: nowIso_()
  }, ['Contact']);
  return { id: id };
}

function updateDriver(id, patch) {
  patch = patch || {};
  if ('ID' in patch) delete patch.ID;
  if ('hasPin' in patch) delete patch.hasPin;
  // Same rules as a user's PIN: blank means "leave it alone".
  if ('PIN' in patch) {
    if (String(patch.PIN == null ? '' : patch.PIN).trim() === '') delete patch.PIN;
    else { patch.PIN = validateNewPin_(patch.PIN); ensureDriverSchema_(); }
  }
  updateRowById_(getSheet_(SHEET_NAMES.DRIVERS), SHEET_HEADERS.Drivers, id, patch, ['Contact', 'PIN']);
  clearAuthUsersCache_();
  return { ok: true };
}

function deleteDriver(id) {
  deleteRowById_(getSheet_(SHEET_NAMES.DRIVERS), id);
  clearAuthUsersCache_();
  return { ok: true };
}

/**
 * One-time seed of the truck fleet from Shane's Truck_List.xlsx. Run this
 * once from the Apps Script editor - select seedInitialTrucks from the
 * function dropdown next to Run/Debug, then click Run - the same way
 * setupSpreadsheet was run during initial setup. Safe to re-run: any
 * registration already on file is skipped, not duplicated. Every truck it
 * adds stays fully editable (and deletable) afterwards in Admin > Trucks.
 */
function seedInitialTrucks() {
  var TRUCK_DATA = [
    // [Registration, Type, Number]
    ['JR 53 BZ GP', 'Dyna Toyota', '1'],
    ['JN 60 XY GP', 'Dyna Toyota', '2'],
    ['JR 53 BT GP', 'Dyna Toyota', '3'],
    ['JN 60 XV GP', 'Dyna Toyota', '12'],
    ['JR 53 BH GP', 'Dyna Toyota', '8'],
    ['JD 04 BD GP', 'Hyundai H100', '17'],
    ['JH 07 SP GP', 'Dyna Toyota', '20'],
    ['KY 63 GM GP', 'Hino Toyota', '11'],
    ['KY 63 FJ GP', 'Hino Toyota', '4'],
    ['LB 05 FM GP', 'Hino Toyota', '14'],
    ['LG 74 ZW GP', 'Hino Toyota', '7'],
    ['LG 74 ZY GP', 'Hino Toyota', '5'],
    ['LN 08 GB GP', 'Hino Toyota', '16'],
    ['LS 27 WK GP', 'Hino Toyota', '13'],
    ['LS 27 WH GP', 'Hino Toyota', '6'],
    ['LT 75 SH GP', 'Hino Toyota', '18'],
    ['LV 95 YZ GP', 'Hino Toyota', '19'],
    ['LW 14 BZ GP', 'Hino Toyota', '21'],
    ['LY 39 WT GP', 'Hino Toyota', '22'],
    ['LY 47 FM GP', 'Hino Toyota', '23'],
    ['MP 76 VP GP', 'Hino Toyota', '10'],
    ['MZ 25 KK GP', 'Eicher 4 Ton', '15'],
    ['NB 33 VB GP', 'Eicher 4 Ton', '24'],
    ['ND 00 CG GP', 'Eicher 4 Ton', '9'],
    ['YDX 847 GP', 'F-Series Isuzu', 'BT 1'],
    ['HP 80 FJ GP', 'F-Series Isuzu', 'BT 2']
  ];

  var existing = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS));
  var existingRegs = {};
  existing.forEach(function (t) {
    if (t.Registration) existingRegs[String(t.Registration).trim().toLowerCase()] = true;
  });

  var sheet = getSheet_(SHEET_NAMES.TRUCKS);
  var added = [], skipped = [];

  TRUCK_DATA.forEach(function (row) {
    var registration = row[0], type = row[1], number = row[2];
    var key = registration.toLowerCase();
    if (existingRegs[key]) { skipped.push(registration); return; }

    var id = Utilities.getUuid();
    appendObject_(sheet, SHEET_HEADERS.Trucks, {
      ID: id, Name: 'Truck ' + number, Driver: '', Route: '', Active: true, CreatedAt: nowIso_(),
      Registration: registration, Type: type
    });
    existingRegs[key] = true;
    added.push(registration);
  });

  Logger.log('seedInitialTrucks: added ' + added.length + ', skipped (already existed) ' + skipped.length +
    (skipped.length ? ': ' + skipped.join(', ') : ''));
  return { added: added.length, skipped: skipped };
}

/**
 * One-time bulk-add of Shane's driver list, with contact numbers not yet on
 * hand at seed time - run this once from the Apps Script editor (select
 * seedInitialDrivers from the function dropdown next to Run/Debug, then
 * click Run), same way as seedInitialTrucks above. Every driver goes in
 * Active with Contact set to '0' as a placeholder, editable (name, contact,
 * or active flag) afterwards in Admin > Drivers exactly like a driver added
 * one at a time through that screen - update each Contact there as Shane
 * gets the real numbers. Safe to re-run: any name already on file (matched
 * case-insensitively, trimmed) is skipped, not duplicated - so it's also
 * safe to run again later with a longer list if more names get added before
 * everyone's contact numbers are in.
 */
function seedInitialDrivers() {
  var DRIVER_NAMES = [
    'Rodney Mkhari', 'Shane Malungana', 'Parfait Bakala', 'Lucas Kau', 'Matimu Maluleke',
    'Abed Mathonsi', 'Henneck Nukeri', 'Mavin Ngobeni', 'Posh Maluleke', 'Phumlani Mathonsi',
    'Selby Ndzovela', 'Therents Makoma', 'Mzwandile Ndlovu', 'Innocent Ngwenya', 'Robert Letshedi',
    'Welsh Shisinge', 'Irvin Hlongwane', 'Erick Sedibane', 'Chris Baloyi', 'Godfrey Pilusa',
    'Matimba Nobela', 'Joseph Molise', 'Jerry Matlala', 'Thembani Maluleke', 'Tiyane Ngobeni',
    'Sandile Thwala', 'Tshepo Ranku', 'Reason Ngoveni', 'Sthembiso Ndlovu', 'Nyiko Maluleke',
    'Ntwanano Mabaso', 'Kgatla Basco', 'Lungelo Maphumulo', 'Mpho Griffith', 'Tiyani Mathebula',
    'Neverdi Mkensi', 'Ariel Mabunda', 'Lunga Hlongwane', 'Mudzhedzi Mulaudzi', 'Phillip Mokgethi',
    'Johannes Semono', 'Lelethu Maselana', 'Mduduzi Mabele', 'Levy Lekganyane', 'Lungile Shuba',
    'Mashangu Khoza'
  ];

  var existing = sheetToObjects_(getSheet_(SHEET_NAMES.DRIVERS));
  var existingNames = {};
  existing.forEach(function (d) {
    if (d.Name) existingNames[String(d.Name).trim().toLowerCase()] = true;
  });

  var sheet = getSheet_(SHEET_NAMES.DRIVERS);
  var added = [], skipped = [];

  DRIVER_NAMES.forEach(function (rawName) {
    var name = String(rawName).trim();
    var key = name.toLowerCase();
    if (existingNames[key]) { skipped.push(name); return; }

    var id = Utilities.getUuid();
    // Contact forced to Plain Text same as addDriver() above, so a later
    // real number typed in over this '0' placeholder (e.g. "0821234567")
    // doesn't lose its leading zero to Sheets' auto-Number conversion.
    appendObjectForcingText_(sheet, SHEET_HEADERS.Drivers, {
      ID: id, Name: name, Contact: '0', Active: true, CreatedAt: nowIso_()
    }, ['Contact']);
    existingNames[key] = true;
    added.push(name);
  });

  Logger.log('seedInitialDrivers: added ' + added.length + ', skipped (already existed) ' + skipped.length +
    (skipped.length ? ': ' + skipped.join(', ') : ''));
  return { added: added.length, skipped: skipped };
}

// ---------------------------------------------------------------------------
// ADMIN - SETTINGS
// ---------------------------------------------------------------------------
//
// Admin/Dispatch Manager PINs used to live here as global settings; each is
// now just the PIN on that person's own row on the Checkers ("Users") sheet
// instead, edited from Admin > Users like anyone else's.

function getAdminSettings() {
  var s = readSettings_();
  return {
    packingSpreadsheetId: s.PackingSpreadsheetId || ''
  };
}

// ---------------------------------------------------------------------------
// ADMIN - DATA SOURCE (Packing & Production sheet connection)
//
// Hardwired to Packing & Production's actual sheet structure: one Google
// Sheet with two tabs, "Orders" (order header info) and "OrderItems" (line
// items, joined back to Orders by OrderID). Only the spreadsheet itself is
// configurable here - the tab names and column names below are fixed,
// matching Packing & Production's real layout as confirmed by Shane. If
// that layout ever changes, update the column name constants below rather
// than the admin UI.
// ---------------------------------------------------------------------------

var ORDERS_TAB_NAME = 'Orders';
var ORDER_ITEMS_TAB_NAME = 'OrderItems';

var ORDERS_COLUMNS = { orderId: 'OrderID', sageRef: 'SageRef', customer: 'CustomerName', deliveryDate: 'DeliveryDate' };
var ORDER_ITEMS_COLUMNS = { orderId: 'OrderID', description: 'Description', department: 'Department', qty: 'Qty', unit: 'Unit' };
// RequiresCoa (Packing & Production's new "does this order need a Certificate
// of Analysis" flag, added on the Orders tab) is looked up OPTIONALLY, unlike
// every column above - a sheet that hasn't been redeployed with this column
// yet (or has it under a slightly different name for a moment) should still
// let every order through checking as normal, just without the COA
// checkbox/gate, rather than requiredColIndex_'s hard failure taking down
// order fetching entirely for something this non-critical.
//
// ProductionCompletedAt (Shane's 2026-09-16 request: "show the pack and
// production status of an order in the dispatch system so if an order is in
// dispatch for today but production hasn't completed the work yet that it
// shows that on the order") is the same order-level flag Packing &
// Production's own board stamps the moment every Production line on an
// order is done - blank means still outstanding. Also optional, for the
// same reason: an order fetch should never fail just because this column
// isn't on the sheet yet. See deriveProductionStatus_ below for how this
// combines with QtyCompleted (ORDER_ITEMS_OPTIONAL_COLUMNS) into what the
// frontend actually shows.
var ORDERS_OPTIONAL_COLUMNS = { coa: 'RequiresCoa', productionCompletedAt: 'ProductionCompletedAt' };
// QtyCompleted (Packing & Production's per-item running total for a
// partially-completed Production line, e.g. "200 of 400kg done") - optional
// for the same reason as the columns above. Only meaningful on Production
// department lines; Packing lines never set it.
var ORDER_ITEMS_OPTIONAL_COLUMNS = { qtyCompleted: 'QtyCompleted' };

/** Extracts a Spreadsheet ID from either a raw ID or a full Google Sheets URL. */
function extractSpreadsheetId_(idOrUrl) {
  var m = String(idOrUrl).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(idOrUrl).trim();
}

/** Opens the given spreadsheet and confirms both expected tabs exist, for the Admin config UI. */
function probeSpreadsheet(idOrUrl) {
  var id = extractSpreadsheetId_(idOrUrl);
  try {
    var ss = SpreadsheetApp.openById(id);
    var sheetNames = ss.getSheets().map(function (sh) { return sh.getName(); });
    var missing = [ORDERS_TAB_NAME, ORDER_ITEMS_TAB_NAME].filter(function (name) { return sheetNames.indexOf(name) === -1; });
    if (missing.length > 0) {
      return { ok: false, error: 'Could not find tab(s) "' + missing.join('", "') + '" in that spreadsheet. Tabs found: ' + sheetNames.join(', ') };
    }
    return { ok: true, spreadsheetId: id, spreadsheetName: ss.getName() };
  } catch (err) {
    return { ok: false, error: 'Could not open that spreadsheet: ' + err.message };
  }
}

function saveDataSourceConfig(idOrUrl) {
  var id = extractSpreadsheetId_(idOrUrl);
  var previousId = readSettings_().PackingSpreadsheetId;
  writeSetting_('PackingSpreadsheetId', id);
  // The cached Packing & Production read (see fetchAllOrdersFromPacking_)
  // is keyed by spreadsheet ID, so switching data sources already reads
  // fresh on its own - this just tidies up the old entry immediately
  // instead of letting it sit until its TTL expires.
  if (previousId && previousId !== id) {
    try { CacheService.getScriptCache().remove('packingOrders_' + previousId); } catch (err) { /* best-effort */ }
  }
  return { ok: true };
}

/** Finds a required column by exact header name; throws a clear error if the sheet's layout has changed. */
function requiredColIndex_(headers, tabName, columnName) {
  var idx = headers.indexOf(columnName);
  if (idx === -1) throw new Error('Expected column "' + columnName + '" not found in the "' + tabName + '" tab. Found columns: ' + headers.join(', '));
  return idx;
}

/**
 * Reads a checkbox-ish cell value as a real boolean. Packing & Production's
 * RequiresCoa column is a Sheets checkbox in the normal case (Apps Script
 * hands that back as a genuine boolean already), but EmailImport.gs over
 * there writes it as plain TRUE/FALSE, so this also accepts the handful of
 * other spellings a cell like that could reasonably hold (text "TRUE"/"Yes"/
 * "Y"/"1", case-insensitive) rather than assuming one exact representation.
 * Blank/missing/anything else reads as false.
 */
function parseBoolCell_(value) {
  if (value === true) return true;
  if (value === false || value === '' || value === null || value === undefined) return false;
  var s = String(value).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === 'Y' || s === '1';
}

/**
 * Derives an order's Production status from its own OrderItems (only
 * 'Production' department lines count - Packing lines never factor in) plus
 * Packing & Production's order-level ProductionCompletedAt flag. Built for
 * Shane's 2026-09-16 request to show, right on a dispatch order, whether
 * Production has actually finished the work yet - not just whether the
 * order has been packed/checked here in Dispatch.
 *
 * An order with no Production lines at all (a pure Packing order) is never
 * flagged - there's nothing for Production to finish, so productionDone is
 * always true and productionStatus is 'none'.
 *
 * hasQtyCompletedColumn is whether Packing & Production's OrderItems tab has
 * picked up the QtyCompleted column yet (see ORDER_ITEMS_OPTIONAL_COLUMNS) -
 * until it has, this can only tell done vs not-done, not how far along a
 * partially-completed line is, so productionNote stays a generic message
 * instead of claiming a false "0 done" for every not-yet-finished order.
 */
function deriveProductionStatus_(items, productionCompletedAtRaw, hasQtyCompletedColumn) {
  var productionItems = items.filter(function (i) { return i.department === 'Production'; });
  if (productionItems.length === 0) {
    return { hasProductionItems: false, productionDone: true, productionStatus: 'none', productionNote: '' };
  }
  if (productionCompletedAtRaw) {
    return { hasProductionItems: true, productionDone: true, productionStatus: 'done', productionNote: '' };
  }
  if (!hasQtyCompletedColumn) {
    return { hasProductionItems: true, productionDone: false, productionStatus: 'not_started', productionNote: 'Production not yet complete' };
  }
  var anyProgress = productionItems.some(function (i) { return (i.qtyCompleted || 0) > 0; });
  if (!anyProgress) {
    return { hasProductionItems: true, productionDone: false, productionStatus: 'not_started', productionNote: 'Production not started' };
  }
  var outstanding = productionItems
    .filter(function (i) { return (i.qtyCompleted || 0) < Number(i.qty); })
    .map(function (i) { return i.description + ': ' + i.qtyCompleted + '/' + i.qty + ' ' + (i.unit || ''); });
  return { hasProductionItems: true, productionDone: false, productionStatus: 'in_progress', productionNote: outstanding.join(', ') };
}

// How long a Packing & Production read is reused before fetchAllOrdersFromPacking_
// goes back to the sheet for a fresh one. See fetchAllOrdersFromPacking_'s
// comment for why this exists and what it trades away.
var PACKING_ORDERS_CACHE_TTL_SECONDS = 45;

// How long a getTruckAssignmentBoard() response is reused before going back
// to the sheet for a fresh one - see getTruckAssignmentBoard's own comment.
// Deliberately shorter than BOARD_POLL_INTERVAL_MS (15s, index.html) rather
// than some fraction of it - this only needs to collapse concurrent pollers
// hitting the SAME tick together, not survive across ticks, so the added
// staleness this can introduce is always well under one poll interval.
var TRUCK_BOARD_CACHE_TTL_SECONDS = 5;

/**
 * Fetches EVERY order (with its items) from the Packing & Production
 * sheet, joining the Orders and OrderItems tabs on OrderID - unfiltered by
 * date. readOrdersFromPacking_ below applies the actual date filter
 * in-memory, so this is the one place that actually touches the sheet -
 * opening a different spreadsheet and pulling two full tabs from it is the
 * single most expensive thing this app does. getOrderFulfillmentOverview
 * needs BOTH "due today" and "overdue" at once, so it calls this itself
 * ONCE and passes the result into readTodaysOrdersFromPacking_/
 * readOverdueOrdersFromPacking_ (their optional preloadedOrders param)
 * rather than letting each of them independently re-fetch it - that used
 * to mean paying for this read twice on every single Dashboard load.
 * Order "number" shown to checkers is SageRef (the human-readable invoice
 * ref), falling back to the internal OrderID if that's blank.
 *
 * On top of that, the result is cached for PACKING_ORDERS_CACHE_TTL_SECONDS
 * via CacheService - on a large/growing Packing & Production sheet, this
 * read alone was slow enough to blow through the app's 20s API timeout
 * (seen live as "Request timed out ... getOrderFulfillmentOverview"). This
 * trades a little staleness (an order added or edited directly in Packing
 * can take up to PACKING_ORDERS_CACHE_TTL_SECONDS to show up here) for a
 * Dashboard that reliably loads fast - exactly the tradeoff SETUP.md's
 * "Making the app faster" section flagged and deferred until it was
 * actually needed. The cache key includes the configured
 * PackingSpreadsheetId, so switching data sources (Admin > Data Source)
 * always reads fresh instead of serving another sheet's cached orders.
 */
function fetchAllOrdersFromPacking_() {
  var s = readSettings_();
  if (!s.PackingSpreadsheetId) throw new Error('Data source not configured yet. Go to Admin > Data Source.');

  var cache = CacheService.getScriptCache();
  var cacheKey = packingOrdersCacheKey_(s.PackingSpreadsheetId);
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      // Corrupt/unexpected cache value - fall through and re-fetch for real.
    }
  }

  var orders = fetchAllOrdersFromPackingUncached_(s.PackingSpreadsheetId);
  cachePackingOrders_(s.PackingSpreadsheetId, orders);
  return orders;
}

function packingOrdersCacheKey_(spreadsheetId) {
  return 'packingOrders_' + spreadsheetId;
}

/**
 * Writes an already-fetched Packing & Production order list into the same
 * cache fetchAllOrdersFromPacking_ reads from. Pulled out of
 * fetchAllOrdersFromPacking_ so markTruckDispatched (build-2026-10-30) can
 * also "warm" this cache with the fresh, uncached read it already pays for
 * on its own - see markTruckDispatched's own comment for why that matters
 * (its force=true confirm call reuses this instead of re-paying for the
 * exact same scan a few seconds later).
 */
function cachePackingOrders_(spreadsheetId, orders) {
  try {
    CacheService.getScriptCache().put(packingOrdersCacheKey_(spreadsheetId), JSON.stringify(orders), PACKING_ORDERS_CACHE_TTL_SECONDS);
  } catch (err) {
    // CacheService rejects values over ~100KB - on a big enough orders
    // list this can throw. Caching is a speed optimization, not a
    // correctness requirement, so just skip caching this time rather than
    // let that break the actual fetch.
  }
}

// Minimum fragment length for a Hidden Customers entry to count as a match -
// mirrors Packing & Production's own Admin > Hidden Customers rule exactly
// (contains, case-insensitive, names under 3 letters ignored) so the two
// systems can never disagree about who's hidden.
var HIDDEN_CUSTOMER_MIN_FRAGMENT_LENGTH = 3;

/**
 * Customer-name fragments to hide, read from the Packing & Production
 * spreadsheet's own "HiddenCustomers" tab (column A, one name/fragment per
 * row, header in row 1) - Shane's Nov 2026 request: internal/own-company
 * Sage invoices (e.g. Rental Blendid) should never surface in Dispatch
 * either, matching the hide-list he already maintains in Packing's own
 * Admin > Hidden Customers. Gracefully returns [] (nothing hidden) if the
 * tab doesn't exist yet rather than throwing - this must never be the
 * reason Dispatch can't see today's orders.
 */
function readHiddenCustomerFragments_(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName('HiddenCustomers');
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var fragments = [];
  for (var i = 1; i < values.length; i++) { // row 1 is the header
    var name = String(values[i][0] || '').trim().toLowerCase();
    if (name.length >= HIDDEN_CUSTOMER_MIN_FRAGMENT_LENGTH) fragments.push(name);
  }
  return fragments;
}

/** True if customerName contains any of the (already-lowercased) hiddenFragments. */
function customerIsHidden_(customerName, hiddenFragments) {
  if (hiddenFragments.length === 0) return false;
  var haystack = String(customerName || '').toLowerCase();
  return hiddenFragments.some(function (fragment) { return haystack.indexOf(fragment) !== -1; });
}

/** The real (uncached) Packing & Production read - see fetchAllOrdersFromPacking_ above. */
function fetchAllOrdersFromPackingUncached_(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);

  var ordersSheet = ss.getSheetByName(ORDERS_TAB_NAME);
  if (!ordersSheet) throw new Error('Tab "' + ORDERS_TAB_NAME + '" not found in the Packing & Production sheet.');
  var itemsSheet = ss.getSheetByName(ORDER_ITEMS_TAB_NAME);
  if (!itemsSheet) throw new Error('Tab "' + ORDER_ITEMS_TAB_NAME + '" not found in the Packing & Production sheet.');

  // --- Orders tab: order header info ---
  var orderValues = ordersSheet.getDataRange().getValues();
  var oHeaders = orderValues[0];
  var oCol = {
    orderId: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.orderId),
    sageRef: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.sageRef),
    customer: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.customer),
    deliveryDate: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.deliveryDate),
    coa: oHeaders.indexOf(ORDERS_OPTIONAL_COLUMNS.coa), // -1 until Packing & Production's sheet has this column
    productionCompletedAt: oHeaders.indexOf(ORDERS_OPTIONAL_COLUMNS.productionCompletedAt) // -1 until Packing & Production's sheet has this column
  };

  var ordersById = {};
  for (var i = 1; i < orderValues.length; i++) {
    var row = orderValues[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;

    var orderId = String(row[oCol.orderId]).trim();
    if (!orderId) continue;

    var rawDate = row[oCol.deliveryDate];
    var deliveryDateStr = rawDate instanceof Date
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone() || 'Africa/Johannesburg', 'yyyy-MM-dd')
      : String(rawDate || '').trim();

    // A blank DeliveryDate is never a match for any caller - it used to
    // fall through and get treated as "today's delivery" forever, which is
    // exactly how old orders (added back before delivery dates were
    // reliably set) kept surfacing no matter how old they got.
    if (!deliveryDateStr) continue;

    var sageRef = String(row[oCol.sageRef] || '').trim();
    ordersById[orderId] = {
      orderId: orderId,
      orderNumber: sageRef || orderId,
      customer: row[oCol.customer],
      deliveryDate: deliveryDateStr,
      requiresCoa: oCol.coa !== -1 ? parseBoolCell_(row[oCol.coa]) : false,
      // Raw cell, kept only long enough for deriveProductionStatus_ to turn
      // it into the productionDone/productionStatus/productionNote fields
      // added onto this same order object in the final pass below, once
      // items (needed to know if this order even HAS Production lines) are
      // in hand.
      productionCompletedAt: oCol.productionCompletedAt !== -1 ? row[oCol.productionCompletedAt] : '',
      items: []
    };
  }

  // --- OrderItems tab: line items, attached to their order by OrderID ---
  var itemValues = itemsSheet.getDataRange().getValues();
  var iHeaders = itemValues[0];
  var iCol = {
    orderId: requiredColIndex_(iHeaders, ORDER_ITEMS_TAB_NAME, ORDER_ITEMS_COLUMNS.orderId),
    description: requiredColIndex_(iHeaders, ORDER_ITEMS_TAB_NAME, ORDER_ITEMS_COLUMNS.description),
    department: requiredColIndex_(iHeaders, ORDER_ITEMS_TAB_NAME, ORDER_ITEMS_COLUMNS.department),
    qty: requiredColIndex_(iHeaders, ORDER_ITEMS_TAB_NAME, ORDER_ITEMS_COLUMNS.qty),
    unit: requiredColIndex_(iHeaders, ORDER_ITEMS_TAB_NAME, ORDER_ITEMS_COLUMNS.unit),
    qtyCompleted: iHeaders.indexOf(ORDER_ITEMS_OPTIONAL_COLUMNS.qtyCompleted) // -1 until Packing & Production's sheet has this column
  };

  for (var j = 1; j < itemValues.length; j++) {
    var irow = itemValues[j];
    if (irow.every(function (c) { return c === '' || c === null; })) continue;

    var itemOrderId = String(irow[iCol.orderId]).trim();
    var order = ordersById[itemOrderId];
    if (!order) continue; // not a Packing order with a valid DeliveryDate

    order.items.push({
      itemKey: itemOrderId + '_' + order.items.length,
      description: irow[iCol.description],
      qty: irow[iCol.qty],
      unit: irow[iCol.unit],
      department: irow[iCol.department],
      qtyCompleted: iCol.qtyCompleted !== -1 ? (Number(irow[iCol.qtyCompleted]) || 0) : 0
    });
  }

  // Now that every order has its full item list, derive each order's
  // Production status (see deriveProductionStatus_) and fold it onto the
  // same order object the frontend already gets orderId/orderNumber/etc.
  // from - one read-only pass, not a second shape callers have to know
  // about.
  var hasQtyCompletedColumn = iCol.qtyCompleted !== -1;
  // Hidden Customers (Nov 2026, see readHiddenCustomerFragments_'s own
  // comment) - filtered out here, in the shared uncached read, rather than
  // only in the cached fetchAllOrdersFromPacking_ wrapper above, so every
  // caller agrees including markTruckDispatched's own direct uncached call
  // (which also WARMS that same shared cache - see cachePackingOrders_ -
  // filtering only in the wrapper would let an unfiltered warm-up leak a
  // hidden customer back into the cache for up to
  // PACKING_ORDERS_CACHE_TTL_SECONDS).
  var hiddenFragments = readHiddenCustomerFragments_(spreadsheetId);
  return Object.keys(ordersById)
    .map(function (id) { return ordersById[id]; })
    .filter(function (order) { return !customerIsHidden_(order.customer, hiddenFragments); })
    .map(function (order) {
      var status = deriveProductionStatus_(order.items, order.productionCompletedAt, hasQtyCompletedColumn);
      order.hasProductionItems = status.hasProductionItems;
      order.productionDone = status.productionDone;
      order.productionStatus = status.productionStatus;
      order.productionNote = status.productionNote;
      return order;
    });
}

/**
 * Every order from Packing & Production whose DeliveryDate satisfies
 * isMatch(deliveryDateStr, referenceDate). Shared engine behind
 * readTodaysOrdersFromPacking_ (today's deliveries) and
 * readOverdueOrdersFromPacking_ (past deliveries still outstanding).
 * referenceDate defaults to the real current day, but the Admin
 * dashboard's date picker passes in whatever day it's viewing, so
 * "today's orders"/overdue are evaluated as of THAT date instead of always
 * meaning right now. preloadedOrders (optional) skips the actual sheet
 * read and filters that array instead - see fetchAllOrdersFromPacking_.
 */
function readOrdersFromPacking_(isMatch, referenceDate, preloadedOrders) {
  var today = referenceDate || todayString_();
  var allOrders = preloadedOrders || fetchAllOrdersFromPacking_();
  return allOrders.filter(function (o) { return isMatch(o.deliveryDate, today); });
}

/**
 * Deliveries due on referenceDate (defaults to the real current day) -
 * matches the assumption that dispatch happens on the delivery day. The
 * Admin dashboard's date picker passes in the day it's viewing so this
 * means "orders due that day", not always "orders due right now".
 * preloadedOrders: see fetchAllOrdersFromPacking_/readOrdersFromPacking_.
 */
function readTodaysOrdersFromPacking_(referenceDate, preloadedOrders) {
  return readOrdersFromPacking_(function (deliveryDateStr, today) { return deliveryDateStr === today; }, referenceDate, preloadedOrders);
}

// How far back (from whichever date is being viewed) to look for orders
// that were due on a past day and still haven't been dispatched or
// collected. Bounded so this query doesn't get slower and slower forever
// as the Packing & Production sheet grows - nothing this app can act on
// should realistically be older than this.
var OVERDUE_LOOKBACK_DAYS = 30;

/**
 * Deliveries due on a day before referenceDate (within the lookback
 * window before it), for the "overdue" warnings on the dashboard.
 * referenceDate defaults to the real current day - pass in a date to see
 * what was overdue as of THAT day instead of as of right now.
 * preloadedOrders: see fetchAllOrdersFromPacking_/readOrdersFromPacking_.
 */
function readOverdueOrdersFromPacking_(referenceDate, preloadedOrders) {
  var today = referenceDate || todayString_();
  var todayParts = today.split('-').map(Number);
  var cutoffDate = new Date(todayParts[0], todayParts[1] - 1, todayParts[2] - OVERDUE_LOOKBACK_DAYS);
  var cutoffStr = Utilities.formatDate(cutoffDate, Session.getScriptTimeZone() || 'Africa/Johannesburg', 'yyyy-MM-dd');
  // 'yyyy-MM-dd' strings sort lexicographically the same as chronologically,
  // so plain string comparison is enough here.
  return readOrdersFromPacking_(function (deliveryDateStr, refDate) {
    return deliveryDateStr < refDate && deliveryDateStr >= cutoffStr;
  }, today, preloadedOrders);
}

/** Search today's orders by order number or customer name (case-insensitive substring). */
function searchOrders(sessionId, query) {
  var orders = readTodaysOrdersFromPacking_();
  var q = String(query || '').trim().toLowerCase();
  var checksBySheet = getAllOrderChecksToday_();

  var filtered = q
    ? orders.filter(function (o) {
        return String(o.orderNumber).toLowerCase().indexOf(q) !== -1 ||
               String(o.customer).toLowerCase().indexOf(q) !== -1;
      })
    : orders;

  // Built lazily, at most once per call, the first time a result actually
  // needs a truck name - not via getTruckNameForSession_ per match, which
  // would re-read the whole TruckSessions sheet from scratch for every
  // single order in the results that happens to be allocated to another
  // truck (findOrderAcrossTrucks below builds this same map once up front
  // for the same reason).
  var sessionsById = null;
  function truckNameForSession_(id) {
    if (!sessionsById) {
      sessionsById = {};
      sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).forEach(function (s) { sessionsById[s.ID] = s; });
    }
    return sessionsById[id] ? sessionsById[id].TruckName : null;
  }

  return filtered.map(function (o) {
    var existingCheck = checksBySheet[o.orderId];
    var allocatedToOtherTruck = existingCheck && existingCheck.TruckSessionID !== sessionId;
    return {
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      customer: o.customer,
      deliveryDate: o.deliveryDate,
      itemCount: o.items.length,
      allocated: !!existingCheck,
      // status is null when the order hasn't been allocated to any truck yet
      status: existingCheck ? existingCheck.Status : null,
      checkedOnOtherTruck: allocatedToOtherTruck ? truckNameForSession_(existingCheck.TruckSessionID) : null,
      productionDone: o.productionDone,
      productionStatus: o.productionStatus,
      productionNote: o.productionNote
    };
  });
}

/**
 * Orders already allocated to one specific truck session - what the
 * checker's main Orders tab shows by default, instead of every order in
 * today's Packing & Production data (that full list is only surfaced via
 * the separate "Add Order" search, see searchOrders above).
 *
 * Joins in each order's live Production status (productionDone/
 * productionStatus/productionNote - see deriveProductionStatus_) from
 * today's Packing & Production read, since this list is exactly what
 * Shane's 2026-09-16 request meant by "an order in dispatch" - orders
 * already sitting on this truck are precisely where he wants to see
 * Production still hasn't finished. That read is best-effort here: this
 * list's whole reason to exist is OrderChecks/ItemChecks (this app's own
 * data), so a Packing & Production hiccup shouldn't take it down - it just
 * means every order shows as if Production were done until the next
 * successful read.
 */
function getOrdersForSession(sessionId) {
  var orderChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return c.TruckSessionID === sessionId; });
  var itemChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS));

  var packingOrdersById = {};
  try {
    fetchAllOrdersFromPacking_().forEach(function (o) { packingOrdersById[orderIdKey_(o.orderId)] = o; });
  } catch (err) {
    // best-effort - see this function's own comment above
  }

  return orderChecks.map(function (c) {
    var siblingItems = itemChecks.filter(function (i) { return i.OrderCheckID === c.ID; });
    var packingOrder = packingOrdersById[orderIdKey_(c.OrderID)];
    // Self-heal a snapshot Packing & Production has since outgrown - see
    // reconcileOrderItemsAgainstPacking_'s own comment for why this can
    // happen.
    siblingItems = reconcileOrderItemsAgainstPacking_(c, siblingItems, packingOrder ? packingOrder.items : null);
    return {
      orderId: c.OrderID,
      orderNumber: c.OrderNumber,
      customer: c.Customer,
      itemCount: siblingItems.length,
      // Self-heal a drifted Status before showing it - see
      // reconcileOrderCheckStatus_'s own comment for why this can happen.
      status: reconcileOrderCheckStatus_(c, siblingItems),
      productionDone: packingOrder ? packingOrder.productionDone : true,
      productionStatus: packingOrder ? packingOrder.productionStatus : 'none',
      productionNote: packingOrder ? packingOrder.productionNote : ''
    };
  });
}

/**
 * Admin-facing lookup: "which truck did this order go out on?" - unlike
 * searchOrders above (today's Packing & Production data only, for putting
 * an order onto a truck), this searches OrderChecks directly across EVERY
 * day on record, since the whole point is tracing an order that may have
 * gone out days ago. Only orders that were actually allocated to some
 * truck can show up here at all - an order never allocated has no truck to
 * report. Returns most-recent-first, capped at 50 so a very broad query
 * (e.g. a common customer name) doesn't dump the entire sheet into the UI.
 */
/**
 * Cross-day order lookup for Customer Care and Admin's "Find an order"
 * search - matches by order number or customer name substring (either can
 * be blank if the other narrows things down). An optional dateStr
 * ('yyyy-MM-dd') restricts to just that one day - Shane's request
 * (2026-09-28): Customer Care needed a way to check a PREVIOUS day's
 * deliveries when a customer calls with a query but no order number handy,
 * not just a free-text search across all history. At least one of
 * query/dateStr must be given, or nothing is returned (browsing the ENTIRE
 * order history with no filter at all would be both slow and useless).
 * With a date picked, the 50-result cap below (there to keep an unscoped
 * text search across ALL history from dumping huge unrelated results) is
 * lifted, since a single day's order volume is naturally bounded already;
 * results are sorted by customer name instead of by date in that case (every
 * row already shares the same date, so sorting by it would do nothing) -
 * easier to scan a whole day's list for one customer than a date-sorted one.
 */
function findOrderAcrossTrucks(query, dateStr) {
  var q = String(query || '').trim().toLowerCase();
  var targetDate = String(dateStr || '').trim();
  if (!q && !targetDate) return [];

  var checks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) {
    if (targetDate && normalizeDateStr_(c.Date) !== targetDate) return false;
    if (!q) return true;
    return String(c.OrderNumber).toLowerCase().indexOf(q) !== -1 ||
           String(c.Customer).toLowerCase().indexOf(q) !== -1;
  });

  var sessionsById = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).forEach(function (s) { sessionsById[s.ID] = s; });
  var deliveredAt = deliveredAtByOrderCheckId_(null);

  var results = checks.map(function (c) {
    var session = sessionsById[c.TruckSessionID];
    return {
      deliveredAt: deliveredAt[c.ID] || '',
      orderId: c.OrderID,
      orderNumber: c.OrderNumber,
      customer: c.Customer,
      date: normalizeDateStr_(c.Date),
      status: c.Status,
      truckName: session ? session.TruckName : null,
      truckStatus: session ? session.Status : null,
      dispatchedAt: session ? session.DispatchedAt : null,
      driver: session ? session.Driver : null,
      driverContacts: session ? session.DriverContacts : null,
      route: session ? session.Route : null
    };
  });

  if (targetDate) {
    return results.sort(function (a, b) { return String(a.customer).localeCompare(String(b.customer)); });
  }
  return results.sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 50);
}

function getAllOrderChecksToday_() {
  var today = todayString_();
  var checks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return normalizeDateStr_(c.Date) === today; });
  var byOrderId = {};
  checks.forEach(function (c) { byOrderId[c.OrderID] = c; });
  return byOrderId;
}

function getTruckNameForSession_(sessionId) {
  var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS));
  var session = sessions.filter(function (s) { return s.ID === sessionId; })[0];
  return session ? session.TruckName : null;
}

// ---------------------------------------------------------------------------
// TRUCK SESSIONS
// ---------------------------------------------------------------------------

/**
 * Starts a new truck session for today, or resumes today's IN-PROGRESS one
 * for that truck, if there is one. Deliberately does NOT resume a session
 * that's already been marked Dispatched - some trucks run more than one
 * dispatch a day, so reopening an already-dispatched trip has to be an
 * explicit choice (see getTruckSessionsForTruckToday + startNewTruckSession
 * below), not something this silently does on its own.
 */
function startTruckSession(truckId, checkerId, checkerName) {
  return getTruckSessionState(getOrCreateTodaysOpenSessionId_(truckId, checkerId, checkerName));
}

/**
 * The bare session ID for today's open session on this truck (creating one
 * if it doesn't have one yet) - the lean subset of what startTruckSession
 * above does. Traced 2026-10-22 (Shane: dispatch staff finding the Trucks
 * board slow to assign orders on): assignOrderToTruck used to call
 * startTruckSession for this, which - on the hot path (truck already has an
 * open session, true for every drop after the truck's FIRST one each day) -
 * calls getTruckSessionState, which re-reads the ENTIRE SESSIONS sheet a
 * SECOND time (startTruckSession had just read it once already, to find
 * this exact session) plus the entire OrderChecks and Jobs sheets, all of
 * it immediately discarded since assignOrderToTruck only ever wanted the
 * session's own ID. Combined with assignOrderToTruck's own OrderChecks read
 * (checking whether the order is on a DIFFERENT truck already) and
 * allocateOrderToTruck's own safety-critical OrderChecks re-read (done
 * under its lock specifically to catch a racing concurrent call - see its
 * own comment, this one can't be removed), a single drag-and-drop was
 * reading OrderChecks three times and TruckSessions twice from scratch,
 * every single time. This cuts that to OrderChecks twice (one avoidable,
 * one load-bearing) and TruckSessions once, with Jobs not read at all on
 * this path - startTruckSession itself is untouched, for its other callers
 * (the checker's own "select a truck" screen) that genuinely need the full
 * session state this trims away.
 */
function findOrCreateTruckSessionId_(truckId, checkerId, checkerName) {
  return getOrCreateTodaysOpenSessionId_(truckId, checkerId, checkerName);
}

/**
 * The actual find-or-create, shared by startTruckSession and
 * findOrCreateTruckSessionId_ above, wrapped in a per-truck+day lock
 * (build-2026-10-30 - Shane: a truck ended up with 2 open trips, Trip 2
 * sitting empty forever, after apparently 2 checkers/dispatchers tapped the
 * same truck at close to the same moment). Before this, BOTH callers did
 * their own unlocked "is there already an open session for this truck
 * today" read-then-append - if two calls for the SAME truck land close
 * enough together, each one's read can land before either's write, so both
 * independently conclude "no session yet" and each creates its own row.
 * Every order dropped afterward lands on whichever row happened to get
 * created first (findOrCreateTruckSessionId_'s own filter always returns
 * the first match), leaving the second, later row permanently open with
 * nothing on it - exactly Truck 4's Trip 2 in Shane's screenshot. Same
 * shape of bug as the one already fixed for allocateOrderToTruck's own
 * duplicate-row risk (see its comment) and setItemStatus's order-status
 * recompute (see its comment) - just never applied to session creation
 * itself until now. Scoped per truck+day via withTruckSessionCreateLock_,
 * not script-wide, for the same reason withOrderStatusLock_ is scoped per
 * order rather than using LockService.getScriptLock() - see setItemStatus's
 * comment for the live "Request timed out" incident that was traced back to
 * a script-wide lock serializing every unrelated request behind it.
 */
function getOrCreateTodaysOpenSessionId_(truckId, checkerId, checkerName) {
  return withTruckSessionCreateLock_(truckId, function () {
    var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS));
    var today = todayString_();
    var existing = sessions.filter(function (s) {
      return s.TruckID === truckId && normalizeDateStr_(s.Date) === today && s.Status === SESSION_STATUS.IN_PROGRESS;
    })[0];
    if (existing) return existing.ID;

    return createTruckSession_(truckId, checkerId, checkerName).session.ID;
  });
}

/** Always starts a brand-new session, even if this truck already has one (or several) today - used for a truck's 2nd/3rd dispatch of the day. */
function startNewTruckSession(truckId, checkerId, checkerName) {
  return createTruckSession_(truckId, checkerId, checkerName);
}

function createTruckSession_(truckId, checkerId, checkerName) {
  var trucks = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS));
  var truck = trucks.filter(function (t) { return t.ID === truckId; })[0];
  if (!truck) throw new Error('Truck not found.');

  var id = Utilities.getUuid();
  appendObject_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, {
    ID: id, Date: todayString_(), TruckID: truckId, TruckName: truck.Name, CheckerID: checkerId,
    CheckerName: checkerName, StartedAt: nowIso_(), TrayCount: '', TrayCountUpdatedAt: '',
    Status: SESSION_STATUS.IN_PROGRESS, DispatchedAt: '', DispatchedBy: '', Driver: '', Route: '',
    TraySmall: '', TrayMedium: '', TrayLarge: '', TrayOther: '', DriverContacts: '', NoTraysOnTrip: false,
    // false (not '') specifically - this is what makes a BRAND-NEW trip
    // trigger the truck-issues prompt exactly once: startTruckSession only
    // ever calls createTruckSession_ when there's no existing in-progress
    // session to resume, so this only ever runs at the true start of a trip.
    TruckIssuesPrompted: false
  });
  return getTruckSessionState(id);
}

/**
 * All of today's sessions for one truck (could be none, one, or several if
 * it's done more than one dispatch today), oldest first, each tagged with
 * its trip number (1st, 2nd, ...) computed on the fly rather than stored -
 * lets the checker's truck-selection screen decide whether to resume,
 * offer a choice, or start fresh.
 */
function getTruckSessionsForTruckToday(truckId) {
  var today = todayString_();
  var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS))
    .filter(function (s) { return s.TruckID === truckId && normalizeDateStr_(s.Date) === today; })
    .sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); });
  return sessions.map(function (s, i) {
    var withTripNumber = {};
    Object.keys(s).forEach(function (k) { withTripNumber[k] = s[k]; });
    withTripNumber.tripNumber = i + 1;
    return withTripNumber;
  });
}

/**
 * Sets/updates the driver(s), their contact numbers, and the route for
 * today's truck session in ONE call - a truck can carry up to 4 drivers on
 * a given trip (the frontend's trip modal offers 3 dropdown slots sourced
 * from the pre-set Drivers list, plus one freeform slot for a driver who
 * isn't on that list yet - but this function itself doesn't care which
 * slot a name/contact pair came from, it just stores whatever it's given,
 * up to that cap). Names and contacts are two parallel arrays (same index =
 * same driver) and are stored joined into single columns ("Sipho, Thabo" /
 * "082 123 4567, 083 234 5678") so the sheet schema doesn't need extra
 * per-driver columns - keeps the values easy to read directly in the
 * spreadsheet too.
 *
 * This used to be two separate API calls (updateSessionDriver and
 * updateSessionRoute) that the frontend fired in parallel with
 * Promise.all. Each did its own unlocked read-modify-write on the same
 * session row, which is a lost-update race: if both calls read the row
 * before either had written back, whichever call's write landed LAST would
 * overwrite the other's field with the stale blank value it had read - so
 * a driver name that was clearly saved (and shown right there in the UI)
 * could still be blank in the sheet a moment later. That's how
 * markTruckDispatched could come back with "Driver name has not been
 * entered" immediately after the checker entered and saved one. Combining
 * both fields into one locked read-modify-write closes that race.
 *
 * Lock scoped per SESSION (build-2026-10-30; was LockService.getScriptLock(),
 * one lock for the entire script - see allocateOrderToTruck's comment below
 * for why that's a problem on a hot/frequent path, and setItemStatus's
 * comment for the live incident it already caused once). This one isn't as
 * frequent as allocateOrderToTruck, but it shared the SAME global lock, so
 * while one checker's trip-details save held it, every unrelated
 * allocateOrderToTruck call elsewhere queued behind it too - rescoping this
 * one closes that cross-contention, not just this function's own.
 */
function updateSessionTrip(sessionId, driverNames, driverContacts, route) {
  var namesIn = Array.isArray(driverNames) ? driverNames : [driverNames];
  var contactsIn = Array.isArray(driverContacts) ? driverContacts : [driverContacts];

  // Pair each name with the contact at the SAME original index (before
  // dropping blanks), so a blank driver 2 slot doesn't shift driver 3's
  // number onto driver 2's name.
  var names = [];
  var contacts = [];
  for (var i = 0; i < namesIn.length && names.length < 4; i++) {
    var name = String(namesIn[i] || '').trim();
    if (!name) continue;
    names.push(name);
    contacts.push(String(contactsIn[i] || '').trim());
  }

  return withNamedLock_('sessionTripLock_' + sessionId, function () {
    // DriverContacts is forced to Plain Text before this write - a single
    // driver's cell here is nothing but digits (e.g. "0821234567"), which
    // Sheets otherwise silently reinterprets as a Number and strips the
    // leading 0 from, same as the PIN column bug elsewhere in this file.
    updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
      Driver: names.join(', '),
      DriverContacts: contacts.join(', '),
      Route: String(route || '').trim()
    }, ['DriverContacts']);
    return { ok: true };
  });
}

function getTruckSessionState(sessionId) {
  var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS));
  var session = sessions.filter(function (s) { return s.ID === sessionId; })[0];
  if (!session) throw new Error('Session not found.');

  var orderChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return c.TruckSessionID === sessionId; });

  // Included alongside orderChecks so markTruckDispatched's incomplete-work
  // check covers both in one place - a Job blocks dispatch until Done, the
  // same hard rule as an order (see the Jobs section further down).
  var jobs = sheetToObjects_(getSheet_(SHEET_NAMES.JOBS))
    .filter(function (j) { return j.TruckSessionID === sessionId; });

  return {
    session: session,
    orderChecks: orderChecks,
    jobs: jobs
  };
}

/**
 * Updates the fruit tray tally for today's truck session, split by size
 * since trays come in Small/Medium/Large, plus an Other catch-all. Replaces the old single TrayCount
 * total - that column is kept as unused legacy for the same
 * non-destructive-migration reason used elsewhere.
 *
 * noTrays is the checker's own "this dispatch genuinely carries no fruit
 * trays" flag (see the SHEET_HEADERS.TruckSessions comment above) - when
 * true, the four counts are force-blanked regardless of whatever was typed
 * into them beforehand, so a stale number from before the box was ticked
 * can never linger and contradict the flag. markTruckDispatched reads this
 * flag to skip its "tray counts not entered" warning for a trip marked
 * this way.
 */
function updateTrayCounts(sessionId, small, medium, large, other, noTrays) {
  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
    TraySmall: noTrays ? '' : small, TrayMedium: noTrays ? '' : medium,
    TrayLarge: noTrays ? '' : large, TrayOther: noTrays ? '' : other,
    NoTraysOnTrip: !!noTrays, TrayCountUpdatedAt: nowIso_()
  });
  return { ok: true };
}

/**
 * Explicitly allocates an order to a truck - the ONLY place that creates the
 * OrderCheck + ItemChecks rows (a snapshot of the order's items at
 * allocation time). This is a deliberate step the checker takes before
 * checking items, separate from just opening/viewing the order. Wrapped in
 * a lock so two near-simultaneous calls (a double-tap, or a slow request
 * retried) can't create duplicate rows for the same order - it's safe to
 * call again on an order that's already allocated (no-op).
 *
 * Lock scoped per ORDER+day (build-2026-10-30; was
 * LockService.getScriptLock(), ONE lock for the entire script) - this is
 * the single busiest write in the app (every drag-and-drop on the Trucks
 * board ends up here, via assignOrderToTruck below), so a script-wide lock
 * here means every checker/dispatcher allocating ANY order to ANY truck,
 * anywhere, queues behind every other one doing the same, however
 * unrelated - exactly the "Request timed out" shape already traced and
 * fixed once for setItemStatus (see its own comment for that incident).
 * That fix was never carried over here even though the same risk applied,
 * which is almost certainly what a checker meant by the app being "stuck
 * on loading for a long time" during a busy morning (Shane, 2026-10-30) -
 * the frontend's own EXTENDED_TIMEOUT_ACTIONS comment already names this
 * exact lock as the reason this action gets a longer timeout than most.
 * Scoped per orderId+day via withOrderAllocationLock_ instead, same
 * CacheService-mutex mechanism as withOrderStatusLock_, so two DIFFERENT
 * orders never wait on each other - only two calls for the SAME order
 * (the actual race this exists to prevent) still serialize.
 */
function allocateOrderToTruck(sessionId, orderId) {
  return withOrderAllocationLock_(orderId, function () {
    var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
    var today = todayString_();
    var existingChecks = sheetToObjects_(orderChecksSheet);
    // orderIdKey_(...) on both sides (build-2026-10-30, was a bare
    // String(...) === String(...)): OrderID round-trips through this sheet
    // as a raw cell value, and Sheets can silently store a numeric-looking
    // value (e.g. an OrderID that's just digits, possibly with a leading
    // zero) as a real Number once it's been appended - a bare String(...)
    // comparison against the always-string orderId param could then never
    // match, even for the row this exact call just wrote, risking a
    // duplicate allocation of the same order. See orderIdKey_'s own
    // comment for the full story (traced from a Dashboard "Outstanding"
    // display bug that turned out to be this same root cause).
    var existing = existingChecks.filter(function (c) { return orderIdKey_(c.OrderID) === orderIdKey_(orderId) && normalizeDateStr_(c.Date) === today; })[0];
    if (existing) return { ok: true, alreadyAllocated: true };

    var orders = readTodaysOrdersFromPacking_();
    var order = orders.filter(function (o) { return o.orderId === orderId; })[0];
    if (!order) throw new Error('Order not found in today\'s Packing & Production data.');

    var orderCheckId = Utilities.getUuid();
    appendObject_(orderChecksSheet, SHEET_HEADERS.OrderChecks, {
      ID: orderCheckId, TruckSessionID: sessionId, Date: today, OrderID: order.orderId,
      OrderNumber: order.orderNumber, Customer: order.customer, DeliveryDate: order.deliveryDate,
      Status: ORDER_STATUS.PENDING, StartedAt: nowIso_(), CompletedAt: '',
      RequiresCoa: !!order.requiresCoa, CoaConfirmed: false, CoaConfirmedBy: '', CoaConfirmedAt: ''
    });

    var itemChecksSheet = getSheet_(SHEET_NAMES.ITEM_CHECKS);
    try {
      appendObjects_(itemChecksSheet, SHEET_HEADERS.ItemChecks, order.items.map(function (item) {
        return {
          ID: Utilities.getUuid(), OrderCheckID: orderCheckId, TruckSessionID: sessionId, OrderID: order.orderId,
          ItemKey: item.itemKey, ProductDescription: item.description, Qty: item.qty, Unit: item.unit,
          Status: ITEM_STATUS.PENDING, NoStockReasonID: '', NoStockReason: '', CheckedBy: '', CheckedAt: '', PackedQty: ''
        };
      }));
    } catch (e) {
      // The OrderCheck row above already exists at this point - if the items
      // write throws, roll it back rather than leaving an OrderCheck with
      // zero items sitting in the sheet. Without this, the "already
      // allocated" check at the top of this function would treat that
      // half-finished row as done and permanently refuse to ever write its
      // items, since items are only ever written once, right here.
      deleteRowById_(orderChecksSheet, orderCheckId);
      throw e;
    }

    return { ok: true, alreadyAllocated: false };
  });
}

/**
 * The Trucks board's drag-and-drop entry point (Dispatch Manager/Admin
 * only, enforced in the frontend nav same as every other role split in
 * this app - see the comment on API_ACTIONS). Assigns an order onto a
 * truck's currently open trip today, creating that trip first if the
 * truck doesn't have one yet - including the case where the truck's only
 * trip(s) today have already dispatched, which starts a fresh trip, same
 * as "Start a new dispatch" elsewhere in the app.
 *
 * If the order is currently sitting on a DIFFERENT truck's open trip, this
 * MOVES it: unallocates it from there first (its checking starts over from
 * Pending on the new truck, same as the existing manual Unallocate flow),
 * then allocates it fresh here. Refuses to move an order off a truck
 * that's already dispatched - that truck has physically left with it -
 * mirroring unallocateOrder's own guard. Dropping an order back onto the
 * SAME truck it's already on is a harmless no-op.
 */
function assignOrderToTruck(truckId, orderId, checkerId, checkerName) {
  var today = todayString_();
  var existing = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return orderIdKey_(c.OrderID) === orderIdKey_(orderId) && normalizeDateStr_(c.Date) === today; })[0];

  if (existing) {
    var existingSession = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS))
      .filter(function (s) { return s.ID === existing.TruckSessionID; })[0];
    if (existingSession && String(existingSession.TruckID) === String(truckId)) {
      return { ok: true, alreadyAssigned: true };
    }
    if (existingSession && existingSession.Status === SESSION_STATUS.DISPATCHED) {
      throw new Error('Can\'t move this order - truck "' + existingSession.TruckName + '" has already dispatched with it.');
    }
    // existing/existingSession were already looked up just above to decide
    // whether this move is even allowed - reuse them here instead of
    // calling unallocateOrder(orderId), which would redundantly re-read
    // OrderChecks+TruckSessions from scratch to rediscover the exact same
    // check/session this function already has in hand.
    unallocateOrderCheck_(existing, existingSession);
  }

  // findOrCreateTruckSessionId_, not the heavier startTruckSession - see its
  // own comment for why: this call only ever needs the session's bare ID,
  // and it runs on every single drag-and-drop, not just occasionally.
  var sessionId = findOrCreateTruckSessionId_(truckId, checkerId, checkerName);
  return allocateOrderToTruck(sessionId, orderId);
}

/**
 * Everything the Trucks board needs in one call: every active truck (with
 * whatever's already assigned to its open trip today, plus a read-only
 * look at anything on an already-dispatched trip so the board isn't
 * misleadingly empty for a truck that's already gone out) on one side, and
 * every one of today's Packing & Production orders that isn't assigned to
 * ANY truck yet on the other, PLUS (2026-10-26) today's dispatch timeline
 * and per-dispatcher scorecard - see buildDispatchTimelineAndScorecard_'s
 * own comment - and each truck's live openTripPackStartAt/the board-wide
 * packWarningThresholdMinutes, so the frontend can flag a truck that's
 * been packing past target before it even dispatches (see the comment on
 * openTripPackStartAt in the boardTrucks.map below). Folded into this
 * same call/cache rather than a separate API
 * action since it's shown on this same screen - no point paying for a 2nd
 * round trip (and a 2nd Apps Script redirect) just to show it. This only
 * reads the current state - dragging an order calls assignOrderToTruck
 * (onto a truck) or unallocateOrder (back to Unassigned), then the board is
 * simply reloaded.
 *
 * Cached for TRUCK_BOARD_CACHE_TTL_SECONDS via CacheService - added
 * 2026-09-16 since several Dispatch Managers/checkers can have the board
 * open at once, each polling it every 15s (see BOARD_POLL_INTERVAL_MS in
 * index.html). Without this, every one of those polls independently
 * re-reads the full OrderChecks and TruckSessions sheets, so 5 people
 * watching the board is 5x the Sheets reads for what's overwhelmingly the
 * same answer within any given 15s window. Same tradeoff-and-pattern as
 * fetchAllOrdersFromPacking_ above (a short-lived cached read, corrupt/
 * oversized values just fall through to a real fetch rather than erroring)
 * - a drag-and-drop's own optimistic client-side update (see the board's
 * assignOrderToTruck/renderTruckBoard handling in index.html) is what
 * makes the ACTING checker's own screen feel instant regardless of this
 * cache; this only affects how quickly a DIFFERENT viewer's next poll
 * picks up someone else's change.
 */
function getTruckAssignmentBoard() {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'truckBoard';
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      // Corrupt/unexpected cache value - fall through and rebuild for real.
    }
  }

  var board = getTruckAssignmentBoardUncached_();

  try {
    cache.put(cacheKey, JSON.stringify(board), TRUCK_BOARD_CACHE_TTL_SECONDS);
  } catch (err) {
    // CacheService rejects values over ~100KB - on a big enough board this
    // can throw (a single truck with 100+ orders allocated has already
    // happened live). Caching is a speed optimization, not a correctness
    // requirement, so just skip caching this time rather than let that
    // break the actual read.
  }

  return board;
}

/**
 * Builds today's dispatch timeline (every truck session actually dispatched
 * today, newest first) and the per-dispatcher scorecard built from it -
 * Shane's 2026-10-26 request, to encourage dispatchers to get a truck out
 * quickly. The score is the "pack-to-dispatch" gap: the time between a
 * truck's trip actually starting and the moment it was marked Dispatched.
 * "Started" is the FIRST order being dropped onto the truck (OrderChecks.
 * StartedAt, set the instant allocateOrderToTruck creates that row) when it
 * has any orders at all; for a trip with NO orders on it - a trays-only or
 * Jobs-only run, which Shane confirmed is a real, common case (the two
 * trucks showing no gap on 2026-10-26 turned out to be exactly this, not a
 * bug) - there's no "first order" to measure from, so it falls back to the
 * truck session's own StartedAt (when the trip itself was opened) instead.
 * Every dispatched trip always has a session StartedAt, so this fallback
 * means every trip gets a real, countable gap - never a silent null just
 * for having no orders. Changed 2026-10-26 per Shane, twice the same day:
 * first from the truck's LAST order/job finishing (the "ready" moment) to
 * its FIRST order starting (time the whole pack-and-dispatch process, not
 * just the tail end), then this session-StartedAt fallback once he pointed
 * out trays-only trucks were being left out entirely. (Jobs themselves are
 * still never part of the start time when orders DO exist on the trip -
 * only the no-orders-at-all fallback reaches for the session's own
 * StartedAt.)
 *
 * Split out as its own pure function (sessionsToday/orderChecksToday/
 * jobsToday/tripNumberBySessionId are exactly what
 * getTruckAssignmentBoardUncached_ already has in hand, no extra sheet
 * reads needed beyond the one new Jobs read added there) so it's unit-
 * testable on its own, same pattern as deriveOrderStatus_/
 * deriveProductionStatus_ elsewhere in this file. jobsToday is still
 * accepted (and still read upstream) even though it's unused here now, so
 * the call site/signature doesn't need to change again if a future ask
 * brings jobs back into the calculation.
 */
function buildDispatchTimelineAndScorecard_(sessionsToday, orderChecksToday, jobsToday, tripNumberBySessionId) {
  var orderChecksBySessionId = {};
  orderChecksToday.forEach(function (c) {
    if (!orderChecksBySessionId[c.TruckSessionID]) orderChecksBySessionId[c.TruckSessionID] = [];
    orderChecksBySessionId[c.TruckSessionID].push(c);
  });

  function firstOrderStartAtMsForSession_(sessionId) {
    var timestamps = [];
    (orderChecksBySessionId[sessionId] || []).forEach(function (c) { if (c.StartedAt) timestamps.push(new Date(c.StartedAt).getTime()); });
    if (timestamps.length === 0) return null;
    return Math.min.apply(null, timestamps);
  }

  var dispatchTimeline = sessionsToday
    .filter(function (s) { return s.Status === SESSION_STATUS.DISPATCHED && s.DispatchedAt; })
    .map(function (s) {
      // No orders on this trip at all (trays-only/Jobs-only) - fall back to
      // the session's own StartedAt so it still gets a real, timed gap
      // instead of a silent "-".
      var startAtMs = firstOrderStartAtMsForSession_(s.ID);
      if (startAtMs === null && s.StartedAt) startAtMs = new Date(s.StartedAt).getTime();
      var dispatchedAtMs = new Date(s.DispatchedAt).getTime();
      // Floored at 0 - clock skew between two near-simultaneous writes
      // shows as instant rather than a confusing negative number.
      var packToDispatchSeconds = startAtMs !== null ? Math.max(0, Math.round((dispatchedAtMs - startAtMs) / 1000)) : null;
      return {
        truckSessionId: s.ID, truckId: s.TruckID, truckName: s.TruckName,
        tripNumber: tripNumberBySessionId[s.ID] || 1,
        dispatchedAt: s.DispatchedAt, dispatchedBy: s.DispatchedBy || '',
        lateReason: s.LateReason || '',
        lateReasonOrders: s.LateReasonOrders || '',
        packToDispatchSeconds: packToDispatchSeconds
      };
    })
    .sort(function (a, b) { return new Date(b.dispatchedAt) - new Date(a.dispatchedAt); });

  var byDispatcher = {};
  dispatchTimeline.forEach(function (entry) {
    var name = entry.dispatchedBy || 'Unknown';
    if (!byDispatcher[name]) byDispatcher[name] = { dispatcherName: name, trucksDispatched: 0, gapSecondsTotal: 0, gapSecondsCount: 0, trucks: [] };
    byDispatcher[name].trucksDispatched++;
    if (entry.packToDispatchSeconds !== null) {
      byDispatcher[name].gapSecondsTotal += entry.packToDispatchSeconds;
      byDispatcher[name].gapSecondsCount++;
    }
    // Kept so the Scorecard can drill down into exactly which trucks make
    // up a dispatcher's average, not just the number itself - same
    // dispatchTimeline entry shape the Dashboard's own timeline card uses,
    // minus dispatchedBy (redundant once it's already grouped by name).
    // dispatchTimeline is already sorted newest-first, so each
    // dispatcher's own trucks list comes out newest-first too.
    byDispatcher[name].trucks.push({
      truckSessionId: entry.truckSessionId, truckName: entry.truckName, tripNumber: entry.tripNumber,
      dispatchedAt: entry.dispatchedAt, packToDispatchSeconds: entry.packToDispatchSeconds
    });
  });
  var scorecard = Object.keys(byDispatcher).map(function (name) {
    var d = byDispatcher[name];
    return {
      dispatcherName: d.dispatcherName,
      trucksDispatched: d.trucksDispatched,
      avgPackToDispatchSeconds: d.gapSecondsCount > 0 ? Math.round(d.gapSecondsTotal / d.gapSecondsCount) : null,
      trucks: d.trucks
    };
  }).sort(function (a, b) {
    // Ranked fastest average first. A dispatcher with no computable average
    // (every truck they sent out had no orders to time against) sorts
    // LAST, not first - an undefined average is not "infinitely fast", and
    // showing them at the top would misrepresent a data gap as a win.
    // Among two such dispatchers, more trucks dispatched ranks higher.
    if (a.avgPackToDispatchSeconds === null && b.avgPackToDispatchSeconds === null) return b.trucksDispatched - a.trucksDispatched;
    if (a.avgPackToDispatchSeconds === null) return 1;
    if (b.avgPackToDispatchSeconds === null) return -1;
    return a.avgPackToDispatchSeconds - b.avgPackToDispatchSeconds;
  });

  return { dispatchTimeline: dispatchTimeline, scorecard: scorecard };
}

/** The real (uncached) Trucks board read - see getTruckAssignmentBoard above. */
function getTruckAssignmentBoardUncached_() {
  var trucks = listTrucks(true);
  var today = todayString_();
  var todaysOrders = readTodaysOrdersFromPacking_();
  // Keyed lookup so orders already allocated to a truck (built from
  // OrderChecks below, which doesn't carry Production status of its own)
  // can still show the same live productionDone/productionStatus/
  // productionNote Shane asked for - see the ordersByTruckId.push below.
  var todaysOrdersById = {};
  todaysOrders.forEach(function (o) { todaysOrdersById[orderIdKey_(o.orderId)] = o; });

  var orderChecksToday = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return normalizeDateStr_(c.Date) === today; });
  var checksByOrderId = {};
  orderChecksToday.forEach(function (c) { checksByOrderId[orderIdKey_(c.OrderID)] = c; });

  // Only read for the dispatch timeline/scorecard below (buildDispatchTimelineAndScorecard_) -
  // a Job's DoneAt can be the thing that actually makes a truck "ready" to
  // dispatch, same as an order's CompletedAt.
  var jobsToday = sheetToObjects_(getSheet_(SHEET_NAMES.JOBS))
    .filter(function (j) { return normalizeDateStr_(j.Date) === today; });

  var sessionsToday = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS))
    .filter(function (s) { return normalizeDateStr_(s.Date) === today; })
    // Chronological, same as getTrucksForSelection - so "Trip 1"/"Trip 2"
    // numbering matches between the checker's truck list and this board.
    .sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); });
  var sessionsById = {};
  sessionsToday.forEach(function (s) { sessionsById[s.ID] = s; });

  // Which trip (1st, 2nd, ...) each session is, per truck - same ordinal a
  // truck's own `trips` array below numbers them, computed once here so
  // each order can be tagged with it too (see ordersByTruckId just below).
  // sessionsToday is already sorted chronologically, so counting sessions
  // per truck in order as they're walked gives the same numbering as the
  // truckSessionsToday.map(...,tripNumber: i+1) done per-truck further down.
  var tripNumberBySessionId = {};
  var tripCountByTruckId = {};
  sessionsToday.forEach(function (s) {
    tripCountByTruckId[s.TruckID] = (tripCountByTruckId[s.TruckID] || 0) + 1;
    tripNumberBySessionId[s.ID] = tripCountByTruckId[s.TruckID];
  });

  var ordersByTruckId = {};
  orderChecksToday.forEach(function (c) {
    var session = sessionsById[c.TruckSessionID];
    if (!session) return;
    if (!ordersByTruckId[session.TruckID]) ordersByTruckId[session.TruckID] = [];
    var packingOrder = todaysOrdersById[orderIdKey_(c.OrderID)];
    ordersByTruckId[session.TruckID].push({
      orderId: c.OrderID, orderNumber: c.OrderNumber, customer: c.Customer, status: c.Status,
      truckDispatched: session.Status === SESSION_STATUS.DISPATCHED,
      // Which of the truck's trips today this order was actually checked
      // against - lets the board show trip 1's orders separately from trip
      // 2's, instead of pooling everything under one truck. Kept as a plain
      // field on the existing flat order object (not nested under `trips`)
      // so the drag-and-drop code, which reads/mutates this same array
      // directly, needs no changes at all.
      tripNumber: tripNumberBySessionId[session.ID],
      // Live Production status (see deriveProductionStatus_) - an order
      // already on a truck is exactly where Shane wants to see Production
      // still hasn't finished, per his 2026-09-16 request. Defaults to
      // "done" if this order has somehow dropped out of today's Packing &
      // Production read (e.g. its DeliveryDate changed) - never invent a
      // false warning for an order this board can't currently see.
      productionDone: packingOrder ? packingOrder.productionDone : true,
      productionStatus: packingOrder ? packingOrder.productionStatus : 'none',
      productionNote: packingOrder ? packingOrder.productionNote : ''
    });
  });

  var trayStopsByVehicle = trayStopsByVehicle_(today);
  var boardTrucks = trucks.map(function (t) {
    var truckSessionsToday = sessionsToday.filter(function (s) { return s.TruckID === t.ID; });
    var allDispatchedToday = truckSessionsToday.length > 0 && truckSessionsToday.every(function (s) { return s.Status === SESSION_STATUS.DISPATCHED; });
    // dispatchedAt/dispatchedBy below is still just the MOST RECENT dispatch
    // (kept for anything that only wants the one-line summary), but `trips`
    // now carries every trip today individually so the board can show trip 1
    // vs trip 2 separately instead of collapsing them - see the matching
    // `trips` array on getTrucksForSelection. Deliberately NOT nesting
    // `orders` under each trip here (unlike getTrucksForSelection) - the
    // existing drag-and-drop code reads and mutates the flat `orders` list
    // below directly, and re-keying that by trip isn't worth the risk of
    // breaking a drag/drop flow that already works.
    var latestDispatchedSession = null;
    if (allDispatchedToday) {
      latestDispatchedSession = truckSessionsToday.reduce(function (latest, s) {
        return (!latest || new Date(s.DispatchedAt) > new Date(latest.DispatchedAt)) ? s : latest;
      }, null);
    }
    // Live 30-minute pack-time warning (Shane, 2026-10-26): the earliest
    // StartedAt among the CURRENT open trip's orders - i.e. when the first
    // order was actually dropped onto the truck this trip, same moment
    // buildDispatchTimelineAndScorecard_ measures from once the truck
    // dispatches. Only looks at the open (In Progress) session, never an
    // already-dispatched earlier trip today. If that open trip has no
    // orders on it at all - a trays-only or Jobs-only run, same real case
    // buildDispatchTimelineAndScorecard_ falls back for - falls back to the
    // session's own StartedAt, so a trays-only truck still gets a live
    // timer (Shane confirmed this is common, not an edge case to skip).
    var openSession = truckSessionsToday.filter(function (s) { return s.Status === SESSION_STATUS.IN_PROGRESS; })[0];
    var openTripPackStartAt = '';
    if (openSession) {
      var openSessionOrderStartMs = orderChecksToday
        .filter(function (c) { return c.TruckSessionID === openSession.ID && c.StartedAt; })
        .map(function (c) { return new Date(c.StartedAt).getTime(); });
      if (openSessionOrderStartMs.length > 0) {
        openTripPackStartAt = new Date(Math.min.apply(null, openSessionOrderStartMs)).toISOString();
      } else if (openSession.StartedAt) {
        openTripPackStartAt = openSession.StartedAt;
      }
    }
    return {
      truckId: t.ID, name: t.Name, registration: t.Registration, type: t.Type,
      hasOpenTrip: truckSessionsToday.some(function (s) { return s.Status === SESSION_STATUS.IN_PROGRESS; }),
      allDispatchedToday: allDispatchedToday,
      dispatchedAt: latestDispatchedSession ? latestDispatchedSession.DispatchedAt : '',
      dispatchedBy: latestDispatchedSession ? latestDispatchedSession.DispatchedBy : '',
      openTripPackStartAt: openTripPackStartAt,
      trips: truckSessionsToday.map(function (s, i) {
        return {
          tripNumber: i + 1, status: s.Status, driver: s.Driver || '',
          driverContacts: s.DriverContacts || '', route: s.Route || '',
          // Who's actually checking/dispatching this trip (the signed-in
          // Checker/Dispatch Manager who started it, TruckSessions.
          // CheckerName) - NOT the truck's own driver. Shane noticed the
          // Trucks board showed driver but no checker/dispatcher name at
          // all, especially awkward on an overdue card where knowing WHO
          // to go check on matters.
          checkerName: s.CheckerName || '',
          dispatchedAt: s.DispatchedAt || '', dispatchedBy: s.DispatchedBy || ''
        };
      }),
      orders: ordersByTruckId[t.ID] || [],
      trayStopCount: t.ZohoVehicleID ? (trayStopsByVehicle[String(t.ZohoVehicleID)] || []).length : 0
    };
  });

  // Order NUMBERS (not IDs) belonging to a check already DISPATCHED today -
  // used below so an order that got amended in Sage AFTER it was already
  // checked and dispatched doesn't reappear as a plain, draggable
  // Unassigned chip under a brand-new OrderID. Reported 2026-10-31
  // (INV0141104, Truck 19): Packing & Production's Sage importer
  // deliberately "auto-replaces" an amended invoice with a fresh OrderID
  // (Shane's own 2026-10-29 Sage go-live decision), same order number -
  // Dispatch's OrderID-based matching has no way to know the old and new
  // IDs are the same real-world order, so the order looked simultaneously
  // dispatched (under the old ID, correctly) and unassigned (under the
  // new one). Deliberately scoped to DISPATCHED checks only, never an
  // order still on an open (In Progress) trip - silently hiding THAT
  // would risk a checker finishing a stale checklist with no way to
  // notice Sage already changed the order out from under them; only a
  // truck that's already gone gets this "assume it's handled" treatment.
  var dispatchedOrderNumbersToday = {};
  orderChecksToday.forEach(function (c) {
    var session = sessionsById[c.TruckSessionID];
    if (session && session.Status === SESSION_STATUS.DISPATCHED) {
      dispatchedOrderNumbersToday[String(c.OrderNumber || '').trim()] = true;
    }
  });

  var unassignedOrders = todaysOrders
    .filter(function (o) { return !checksByOrderId[orderIdKey_(o.orderId)]; })
    .filter(function (o) { return !dispatchedOrderNumbersToday[String(o.orderNumber || '').trim()]; })
    .map(function (o) {
      return {
        orderId: o.orderId, orderNumber: o.orderNumber, customer: o.customer, itemCount: o.items.length,
        productionDone: o.productionDone, productionStatus: o.productionStatus, productionNote: o.productionNote
      };
    });

  // Only `scorecard` is actually used from this - the Dispatch Timeline
  // itself moved to the Dashboard (build-2026-10-26-04, Shane's request),
  // which computes its own copy of it from getDashboardForDate instead (see
  // that function's own comment). Still calling this same helper here for
  // its scorecard half costs nothing extra to compute either part.
  var timelineAndScorecard = buildDispatchTimelineAndScorecard_(sessionsToday, orderChecksToday, jobsToday, tripNumberBySessionId);

  return {
    trucks: boardTrucks, unassignedOrders: unassignedOrders,
    scorecard: timelineAndScorecard.scorecard,
    packWarningThresholdMinutes: PACK_WARNING_THRESHOLD_MINUTES
  };
}

/**
 * Lightweight poll target for the workspace screen's own 30-minute pack
 * warning badge (Shane, 2026-10-27: "if the checker is already clicked on
 * the truck... is there any visual notification" - there wasn't; the
 * warning only ever lived on the Trucks board, which stops polling the
 * instant a checker navigates into a truck's workspace - see showScreen's
 * own comment in index.html). Deliberately NOT the full
 * getTruckAssignmentBoard (every truck + Unassigned Orders) - a checker
 * sitting inside one truck's workspace only ever needs THIS session's own
 * timer, polled independently while that screen is open. Mirrors the exact
 * same openTripPackStartAt logic as getTruckAssignmentBoardUncached_
 * (earliest order StartedAt on the current open trip, falling back to the
 * session's own StartedAt for a trays-only/Jobs-only run) so the two
 * screens can never disagree, and returns an empty openTripPackStartAt
 * whenever the session isn't actually open (e.g. editing an already-
 * dispatched trip) - same as the board does for any non-open trip.
 */
function getTruckPackTimerInfo(sessionId) {
  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return s.ID === sessionId; })[0];
  if (!session || session.Status !== SESSION_STATUS.IN_PROGRESS) {
    return { openTripPackStartAt: '', packWarningThresholdMinutes: PACK_WARNING_THRESHOLD_MINUTES };
  }
  var orderStartMs = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return c.TruckSessionID === sessionId && c.StartedAt; })
    .map(function (c) { return new Date(c.StartedAt).getTime(); });
  var openTripPackStartAt = '';
  if (orderStartMs.length > 0) {
    openTripPackStartAt = new Date(Math.min.apply(null, orderStartMs)).toISOString();
  } else if (session.StartedAt) {
    openTripPackStartAt = session.StartedAt;
  }
  return { openTripPackStartAt: openTripPackStartAt, packWarningThresholdMinutes: PACK_WARNING_THRESHOLD_MINUTES };
}

/**
 * Reads an order's checking state. Does NOT create anything - if the order
 * hasn't been allocated to a truck yet (see allocateOrderToTruck above),
 * returns { allocated: false, orderSummary } so the UI can show an
 * "Allocate to This Truck" step before any items can be checked.
 *
 * If the order is already allocated to a DIFFERENT truck's session, this
 * deliberately does NOT hand back its items/orderCheck - only the read-only
 * orderSummary plus allocatedElsewhere/truckName - so a checker on this
 * truck can see who has it but can't tick off items that actually belong to
 * the other truck's checklist. The only way forward is to unallocate it
 * first (see unallocateOrder below), which clears its checking progress, and
 * then allocate it fresh on this truck - the check process starts over.
 */
function getOrderForChecking(sessionId, orderId) {
  var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
  var today = todayString_();
  var existingChecks = sheetToObjects_(orderChecksSheet);
  // See the matching comment in allocateOrderToTruck - OrderID can come back
  // from the sheet as a Number even though orderId here is always a string.
  var orderCheck = existingChecks.filter(function (c) { return orderIdKey_(c.OrderID) === orderIdKey_(orderId) && normalizeDateStr_(c.Date) === today; })[0];

  // Production status is read live off today's Packing & Production data on
  // every call, never snapshotted the way RequiresCoa is onto the
  // OrderChecks row at allocation time - the whole point of Shane's
  // 2026-09-16 request is seeing Production finish WHILE an order already
  // sits allocated on a truck, so a one-time snapshot from allocation would
  // go stale the moment Production made more progress. Best-effort: this
  // screen's real job is order checking, not Production status, so a
  // Packing & Production hiccup shouldn't block it either.
  var packingOrder = null;
  try {
    packingOrder = readTodaysOrdersFromPacking_().filter(function (o) { return o.orderId === orderId; })[0] || null;
  } catch (err) {
    // best-effort - see comment above
  }
  var productionFields = packingOrder
    ? { productionDone: packingOrder.productionDone, productionStatus: packingOrder.productionStatus, productionNote: packingOrder.productionNote }
    : { productionDone: true, productionStatus: 'none', productionNote: '' };

  if (!orderCheck) {
    var order = packingOrder;
    if (!order) throw new Error('Order not found in today\'s Packing & Production data.');
    return {
      allocated: false, allocatedElsewhere: false, truckName: null,
      orderSummary: {
        orderId: order.orderId, orderNumber: order.orderNumber, customer: order.customer, itemCount: order.items.length,
        productionDone: productionFields.productionDone, productionStatus: productionFields.productionStatus, productionNote: productionFields.productionNote
      },
      orderCheck: null, items: [], warning: null
    };
  }

  var allocatedElsewhere = orderCheck.TruckSessionID !== sessionId;
  var truckName = allocatedElsewhere ? getTruckNameForSession_(orderCheck.TruckSessionID) : null;
  var warning = allocatedElsewhere ? 'This order was already allocated to truck "' + truckName + '".' : null;

  if (allocatedElsewhere) {
    return {
      allocated: true, allocatedElsewhere: true, truckName: truckName,
      orderSummary: {
        orderId: orderCheck.OrderID, orderNumber: orderCheck.OrderNumber, customer: orderCheck.Customer, itemCount: null,
        productionDone: productionFields.productionDone, productionStatus: productionFields.productionStatus, productionNote: productionFields.productionNote
      },
      orderCheck: null, items: [], warning: warning
    };
  }

  var items = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS))
    .filter(function (i) { return i.OrderCheckID === orderCheck.ID; });

  // Self-heal a snapshot Packing & Production has since outgrown - see
  // reconcileOrderItemsAgainstPacking_'s own comment for why this can
  // happen. packingOrder was already read live, just above, for the
  // productionStatus fields - reused here rather than reading it twice.
  items = reconcileOrderItemsAgainstPacking_(orderCheck, items, packingOrder ? packingOrder.items : null);

  // Self-heal a drifted Status before showing it - see
  // reconcileOrderCheckStatus_'s own comment for why this can happen. The
  // Done button's own enabled state is derived client-side straight from
  // these same items (so it was never actually affected by the drift), but
  // orderCheck.Status itself still needs correcting here since it's what
  // the checker's Orders list and markTruckDispatched's dispatch-block
  // check both go by.
  orderCheck.Status = reconcileOrderCheckStatus_(orderCheck, items);

  return {
    allocated: true, allocatedElsewhere: false, truckName: null, orderSummary: null, orderCheck: orderCheck, items: items, warning: null,
    productionDone: productionFields.productionDone, productionStatus: productionFields.productionStatus, productionNote: productionFields.productionNote
  };
}

/**
 * Records the checker's own on-screen tick confirming a physical COA
 * (Certificate of Analysis) is attached to an order that Packing &
 * Production flagged as requiring one (RequiresCoa, snapshotted onto this
 * OrderChecks row at allocation time - see allocateOrderToTruck). Separate
 * from RequiresCoa itself so "does this order need one" and "has someone
 * actually confirmed it's attached" can never be conflated. Overwrites by
 * ID like every other single-field update in this file (setItemStatus,
 * updateTruck, ...), so it's safe to call again with the same values - a
 * retried/duplicate call is a no-op change, not a duplicate record.
 * Un-ticking (confirmed=false) clears who/when, so a stale name+time can't
 * linger against an order that's no longer actually confirmed.
 */
function setOrderCoaConfirmed(orderCheckId, confirmed, checkerName) {
  // Shares withOrderStatusLock_ with setItemStatus's own recompute below -
  // both read-modify-write the SAME OrderChecks row (Status/CompletedAt vs
  // CoaConfirmed/CoaConfirmedBy/CoaConfirmedAt), so without this a COA tick
  // landing at the same moment as an item tap on the same order could
  // silently lose one of the two writes.
  return withOrderStatusLock_(orderCheckId, function () {
    updateRowById_(getSheet_(SHEET_NAMES.ORDER_CHECKS), SHEET_HEADERS.OrderChecks, orderCheckId, {
      CoaConfirmed: !!confirmed,
      CoaConfirmedBy: confirmed ? String(checkerName || '') : '',
      CoaConfirmedAt: confirmed ? nowIso_() : ''
    });
    return { ok: true };
  });
}

/**
 * The actual deletion step of "unallocate" - given an OrderCheck (and its
 * session, for the return value's previousTruckName) ALREADY looked up by
 * the caller, deletes it and every ItemChecks row under it. Split out of
 * unallocateOrder (2026-09-16, efficiency pass) so assignOrderToTruck can
 * reuse a check/session it already read moments earlier while deciding
 * whether a move is even allowed, instead of unallocateOrder redoing that
 * exact same lookup (2 more full-sheet reads of OrderChecks+TruckSessions)
 * for data the caller already has in hand - measured effect on the "move
 * to a different truck" path: 4 reads of each sheet down to 3, since
 * startTruckSession's own getTruckSessionState call still re-reads both on
 * its own account regardless of this fix. unallocateOrder below is still
 * the one place that does its
 * own lookup - for its other caller (a direct "Remove from truck"/drag-to-
 * Unassigned action), nothing has looked this up yet.
 */
function unallocateOrderCheck_(check, session) {
  deleteRowsWhere_(getSheet_(SHEET_NAMES.ITEM_CHECKS), function (row, headers) {
    return String(row[headers.indexOf('OrderCheckID')]) === String(check.ID);
  });
  deleteRowById_(getSheet_(SHEET_NAMES.ORDER_CHECKS), check.ID);
  return { ok: true, wasAllocated: true, previousTruckName: session ? session.TruckName : null };
}

/**
 * Unallocates an order from whichever truck it's currently on - deletes its
 * OrderCheck row and every ItemChecks row under it, so if/when it's
 * allocated again (on this truck or another), allocateOrderToTruck creates
 * a brand-new checklist from scratch rather than resuming stale progress.
 * Used when an order was put on the wrong truck and needs to move: refuses
 * to touch an order whose truck has already dispatched, since that truck
 * has physically left with it and unallocating would just corrupt an
 * already-final record. A no-op (not an error) if the order isn't
 * allocated to anything today.
 */
function unallocateOrder(orderId) {
  var today = todayString_();
  var check = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return orderIdKey_(c.OrderID) === orderIdKey_(orderId) && normalizeDateStr_(c.Date) === today; })[0];
  if (!check) return { ok: true, wasAllocated: false };

  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS))
    .filter(function (s) { return s.ID === check.TruckSessionID; })[0];
  if (session && session.Status === SESSION_STATUS.DISPATCHED) {
    throw new Error('Can\'t unallocate - truck "' + session.TruckName + '" has already dispatched with this order.');
  }

  return unallocateOrderCheck_(check, session);
}

// packedQty is only meaningful when status is Packed, and only needs to be
// passed at all when the checker used the Edit Qty button to record packing
// something other than the full ordered Qty (see the ItemChecks.PackedQty
// comment above) - omit it (or pass '') for the plain "Packed" tap, which
// leaves PackedQty blank and means "packed as ordered". No-Stock no longer
// carries a reason - that whole admin-managed feature was removed, so this
// only ever writes the item's Status/CheckedBy/CheckedAt/PackedQty now.
function setItemStatus(itemCheckId, status, checkerName, packedQty) {
  var itemSheet = getSheet_(SHEET_NAMES.ITEM_CHECKS);

  // updateRowById_ already has to scan ItemChecks once to find this row
  // (see findRowIndexById_) and hands back its full updated contents - so
  // reading which order this item belongs to (OrderCheckID, needed below to
  // scope the lock) from THAT return value is free, instead of a separate
  // upfront lookup that would scan this same sheet a second time before
  // even getting to the recompute's own read. That distinction matters
  // because ItemChecks only grows over the life of the app (pruneOldRecords
  // aside) - an extra full-sheet scan on every single tap is exactly the
  // kind of per-call cost that compounds on a busy day and was very nearly
  // reintroduced here.
  var updatedItemRow = updateRowById_(itemSheet, SHEET_HEADERS.ItemChecks, itemCheckId, {
    Status: status, CheckedBy: checkerName, CheckedAt: nowIso_(),
    PackedQty: (status === ITEM_STATUS.PACKED && packedQty !== undefined && packedQty !== null && packedQty !== '') ? packedQty : ''
  });
  var orderCheckId = updatedItemRow[SHEET_HEADERS.ItemChecks.indexOf('OrderCheckID')];

  // Recomputing the parent order's status below reads every sibling item
  // and writes ONE order-status value derived from them all - if two items
  // on the SAME order are ticked at nearly the same instant, both
  // recomputes could race and whichever writes last could overwrite the
  // other with a stale-derived status. Two DIFFERENT orders never conflict
  // with each other this way, so this used to be over-protected with
  // LockService.getScriptLock() - ONE lock for the entire script, meaning
  // every checker checking any item on any truck queued behind every other
  // one doing the same, however unrelated, and that queue only grew as
  // more people tapped items at once. That's what a live "Request timed
  // out after 20s (setItemStatus)" report traced back to. Scoped instead to
  // a CacheService-based mutex keyed by this one order (LockService itself
  // has no per-key granularity - only whole script/user/document locks) -
  // see withOrderStatusLock_ below, shared with setOrderCoaConfirmed since
  // both read-modify-write this same OrderChecks row.
  // Note this does NOT speed up several items on the SAME order being
  // ticked in a rapid burst by one checker - those still serialize against
  // each other here, correctly - it only stops UNRELATED orders/trucks from
  // needlessly queuing behind each other.
  return withOrderStatusLock_(orderCheckId, function () {
    var items = sheetToObjects_(itemSheet);
    var siblingItems = items.filter(function (i) { return i.OrderCheckID === orderCheckId; });
    var newOrderStatus = deriveOrderStatus_(siblingItems);

    var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
    updateRowById_(orderChecksSheet, SHEET_HEADERS.OrderChecks, orderCheckId, {
      Status: newOrderStatus,
      CompletedAt: newOrderStatus === ORDER_STATUS.COMPLETE ? nowIso_() : ''
    });

    return { ok: true, orderStatus: newOrderStatus };
  });
}

/**
 * Acquires the per-order CacheService mutex keyed to one OrderCheckID (see
 * setItemStatus's comment above for why this exists and why it's scoped to
 * just one order, not the whole script/document) around fn(), then releases
 * it. Shared by setItemStatus's own order-status recompute and
 * setOrderCoaConfirmed, since both read-modify-write the SAME OrderChecks
 * row (Status/CompletedAt vs CoaConfirmed/CoaConfirmedBy/CoaConfirmedAt) -
 * without this, a COA tick landing at the same moment as an item tap on the
 * same order could silently lose one of the two writes (the exact
 * "lost update" bug documented elsewhere in this file for TruckSessions).
 * Proceeds even if the lock was never acquired (40 retries x 250ms used up,
 * or a CacheService outage) rather than failing the request outright -
 * worst case is the same rare stale-overwrite risk the lock exists to
 * reduce, not a hard failure, and the very next write to this order
 * re-derives/re-applies its own fields fresh regardless.
 */
/**
 * Pure derivation of an order's own Status from its items' Status values -
 * shared by setItemStatus's own recompute and reconcileOrderCheckStatus_'s
 * self-heal below, so there's exactly one place that decides what "done"
 * means. An order with zero items is vacuously Complete (nothing left to
 * resolve) - same as items.every() on an empty array always being true,
 * which is what the original inline version of this logic already did.
 */
function deriveOrderStatus_(items) {
  var allResolved = items.every(function (i) { return i.Status !== ITEM_STATUS.PENDING; });
  if (allResolved) return ORDER_STATUS.COMPLETE;
  var anyResolved = items.some(function (i) { return i.Status !== ITEM_STATUS.PENDING; });
  return anyResolved ? ORDER_STATUS.IN_PROGRESS : ORDER_STATUS.PENDING;
}

/**
 * Self-heals an OrderCheck row whose stored Status has drifted from what
 * its own items actually say - traced 2026-10-12 (Shane reported order
 * INV0139035 stuck showing "In Progress" in the checker's Orders list with
 * every one of its 4 items already individually Packed). Root cause: two
 * setItemStatus calls for the SAME order can race on the server (the
 * per-order CacheService mutex in withOrderStatusLock_ is advisory, not a
 * hard guarantee - it proceeds anyway after 40 failed retries rather than
 * erroring out, by design) - whichever call's own OrderChecks write lands
 * LAST wins, even if ITS computed status was derived from an earlier,
 * now-stale read of the other items. The client-side orderSaveChain queue
 * in index.html is meant to keep calls for one order fully serialized so
 * this never actually races in practice, but reopening the SAME order
 * before its previous taps finished saving used to reset that queue
 * unconditionally, breaking the guarantee - fixed alongside this (see
 * openOrder's comment in index.html) - this function is the safety net for
 * whenever it still happens anyway (a retried request, a flaky connection,
 * or anything else that produces two genuinely concurrent calls).
 *
 * Only writes when something's actually wrong (re-checked fresh, under the
 * same per-order lock, right before writing - the drift this is fixing may
 * already have been fixed by another call between the caller's read and
 * this one), so in the normal/healthy case this costs one extra array scan
 * and no write at all. Returns the correct (possibly just-healed) status
 * string, for the caller to use immediately rather than needing a 2nd
 * round trip to see its own fix take effect.
 */
function reconcileOrderCheckStatus_(orderCheck, siblingItems) {
  var correctStatus = deriveOrderStatus_(siblingItems);
  if (correctStatus === orderCheck.Status) return orderCheck.Status;
  return withOrderStatusLock_(orderCheck.ID, function () {
    var freshItems = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS))
      .filter(function (i) { return i.OrderCheckID === orderCheck.ID; });
    var freshStatus = deriveOrderStatus_(freshItems);
    if (freshStatus !== orderCheck.Status) {
      updateRowById_(getSheet_(SHEET_NAMES.ORDER_CHECKS), SHEET_HEADERS.OrderChecks, orderCheck.ID, {
        Status: freshStatus,
        CompletedAt: freshStatus === ORDER_STATUS.COMPLETE ? nowIso_() : ''
      });
    }
    return freshStatus;
  });
}

/**
 * Self-heals an OrderCheck's ItemChecks snapshot when Packing & Production's
 * OWN item list for that order now has items Dispatch never captured -
 * traced 2026-10-21 (Shane reported order DFV0013963/SageRef showing only 1
 * of 3 items in Dispatch's order-detail screen, while Packing & Production's
 * own view of the same order showed all 3). Root cause: allocateOrderToTruck
 * snapshots an order's items from Packing & Production exactly ONCE, at the
 * instant it's dropped onto a truck (by design - see its own comment, so a
 * checker part-way through ticking items doesn't have the list shift under
 * them). For DFV0013963, Dispatch's own ItemChecks data shows exactly ONE
 * row was ever written (ItemKey "..._0", the FIRST line in Packing's
 * OrderItems sheet by LineNo) - not zero, and not a partial multi-row write
 * (the 2026-10-01 Spinach fix already made that batch atomic, all-or-
 * nothing) - meaning Packing's own OrderItems tab itself only had 1 of this
 * order's 3 lines at the exact instant Dispatch read it for allocation; the
 * clean, un-mangled OrderID join (confirmed directly against both sides'
 * raw exports) rules out the kind of join bug a prior Packing & Production
 * incident had trained us to suspect first. The other 2 lines showed up in
 * Packing's sheet sometime AFTER that one read - whether a genuine race
 * (Packing's own write isn't necessarily atomic either) or a later edit
 * Dispatch has no visibility into, the fix is the same either way.
 *
 * Rather than trying to eliminate a race on a system Dispatch doesn't own,
 * this closes the gap from Dispatch's side: wherever an order's current
 * state is shown or acted on, re-check its snapshot against whatever
 * Packing & Production says RIGHT NOW and append any item the snapshot is
 * missing (as a brand-new Pending ItemChecks row) before the order's Status
 * gets (re)computed - so a newly-discovered item shows up for the checker to
 * actually tick, and correctly reopens an order that had wrongly looked
 * Complete. packingItems is the current order.items array for this OrderID
 * from Packing & Production (every call site already has this in hand, or
 * can get it, from its own Packing read) - null/undefined (Packing read
 * failed, or no matching order) is a safe no-op, same as every other
 * best-effort Packing read in this file. Matches on ItemKey, the same
 * "<orderId>_<index-into-Packing's-list>" scheme allocateOrderToTruck
 * already snapshots - never on Description/Qty, which a genuine edit in
 * Packing could legitimately change for an item Dispatch already has.
 */
function reconcileOrderItemsAgainstPacking_(orderCheck, siblingItems, packingItems) {
  if (!packingItems || packingItems.length === 0) return siblingItems;

  var knownKeys = {};
  siblingItems.forEach(function (i) { knownKeys[i.ItemKey] = true; });
  var missing = packingItems.filter(function (pi) { return !knownKeys[pi.itemKey]; });
  if (missing.length === 0) return siblingItems;

  var newRows = missing.map(function (pi) {
    return {
      ID: Utilities.getUuid(), OrderCheckID: orderCheck.ID, TruckSessionID: orderCheck.TruckSessionID, OrderID: orderCheck.OrderID,
      ItemKey: pi.itemKey, ProductDescription: pi.description, Qty: pi.qty, Unit: pi.unit,
      Status: ITEM_STATUS.PENDING, NoStockReasonID: '', NoStockReason: '', CheckedBy: '', CheckedAt: '', PackedQty: ''
    };
  });

  try {
    appendObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS), SHEET_HEADERS.ItemChecks, newRows);
  } catch (err) {
    // Best-effort healing, same spirit as every other best-effort Packing
    // read in this file - if the write fails, just show what was already
    // there rather than erroring out an otherwise-working screen.
    return siblingItems;
  }

  return siblingItems.concat(newRows);
}

/**
 * Generic CacheService-based advisory mutex, keyed by an arbitrary string -
 * the mechanism this file already used just for setItemStatus/
 * setOrderCoaConfirmed's shared per-order lock (withOrderStatusLock_ below),
 * generalized (build-2026-10-30) so allocateOrderToTruck, updateSessionTrip,
 * and truck-session creation can each get their own correctly-SCOPED lock
 * (per order, per session, per truck+day) instead of sharing ONE
 * script-wide LockService lock between completely unrelated trucks/orders -
 * see setItemStatus's own comment for the "Request timed out" incident a
 * script-wide lock already caused once, which is exactly what allocating
 * orders (the busiest write in the app) and starting truck sessions were
 * both still exposed to until this round. Proceeds even if the lock was
 * never acquired (40 retries x 250ms used up, or a CacheService outage)
 * rather than failing the request outright - worst case is the same rare
 * race this exists to reduce, not a hard failure.
 */
function withNamedLock_(lockKey, fn) {
  var cache = CacheService.getScriptCache();
  var acquired = false;
  for (var attempt = 0; attempt < 40 && !acquired; attempt++) {
    if (cache.get(lockKey) === null) {
      try { cache.put(lockKey, '1', 20); acquired = true; } catch (err) { /* CacheService hiccup - retry */ }
    }
    if (!acquired) Utilities.sleep(250);
  }
  try {
    return fn();
  } finally {
    if (acquired) { try { cache.remove(lockKey); } catch (err) { /* best-effort */ } }
  }
}

/** Per-order (for today) mutex - see allocateOrderToTruck's own comment. */
function withOrderAllocationLock_(orderId, fn) {
  return withNamedLock_('orderAllocLock_' + orderId + '_' + todayString_(), fn);
}

/** Per-truck (for today) mutex - see getOrCreateTodaysOpenSessionId_'s own comment. */
function withTruckSessionCreateLock_(truckId, fn) {
  return withNamedLock_('truckSessionCreateLock_' + truckId + '_' + todayString_(), fn);
}

/** Per-order (OrderCheckID) mutex shared by setItemStatus's order-status recompute and setOrderCoaConfirmed - see setItemStatus's own comment for why this exists and why it's scoped to just one order, not the whole script/document. */
function withOrderStatusLock_(orderCheckId, fn) {
  return withNamedLock_('orderStatusLock_' + orderCheckId, fn);
}

/**
 * Marks a truck as dispatched.
 *
 * Incomplete orders are a HARD block, never overridable - Shane's rule:
 * "the truck can only be dispatched once all orders have been checked".
 * There's no force-past-it path for this one; the only way to unstick a
 * truck that's blocked on a problem order is for the Dispatch Manager to
 * drag that order off it on the Trucks board (see assignOrderToTruck /
 * unallocateOrder below), which removes it from THIS truck's checklist so
 * the rest can go out on time.
 *
 * Driver/route/tray-count warnings are unchanged from before - still
 * overridable with force=true, still flagged afterward on the Admin
 * Dashboard as dispatched-with-warnings, since those are judgment calls a
 * checker can reasonably make in a genuine rush.
 */
function markTruckDispatched(sessionId, checkerName, force, lateReason, lateReasonOrderIds) {
  // Makes sure the LateReasons tab and TruckSessions.LateReason header
  // exist before anything below reads or writes them - see
  // ensureLateReasonSchema_ for why this isn't left to setupSpreadsheet.
  ensureLateReasonSchema_();
  var state = getTruckSessionState(sessionId);

  // A retry of an already-successful dispatch - the frontend's own
  // timeout-triggered automatic retry (markTruckDispatched is in
  // RETRYABLE_ACTIONS), or a checker double-tapping - should resolve
  // instantly, not silently redo the expensive Packing & Production
  // reconciliation below and push DispatchedAt later with every repeat.
  // Reported 2026-10-30 as "the loading window stays for long after
  // marking dispatched": without this guard, a single slow-but-actually-
  // successful call whose response the frontend gave up waiting for (see
  // EXTENDED_TIMEOUT_ACTIONS in index.html) could repeat this whole
  // function's cost two or three times back-to-back before the checker
  // ever sees it resolve.
  if (state.session.Status === SESSION_STATUS.DISPATCHED) {
    return { ok: true, alreadyDispatched: true };
  }

  // Self-heal any order whose stored Status has drifted from what its own
  // items actually say, BEFORE deciding whether dispatch is blocked - see
  // reconcileOrderCheckStatus_'s own comment for how this drift can
  // happen. Without this, a truck whose every single item is genuinely
  // packed could be stuck un-dispatchable indefinitely over a stale Status
  // value with nothing on screen to explain why - this is the one place
  // that actually matters operationally, not just cosmetically, so it's
  // worth the extra ItemChecks read here even though getTruckSessionState
  // itself deliberately doesn't carry one for its other (more frequent)
  // call sites.
  if (state.orderChecks.length > 0) {
    var itemChecksForDispatch = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS));

    // Best-effort: also catch an order whose Packing & Production item list
    // has grown since it was allocated (see
    // reconcileOrderItemsAgainstPacking_'s own comment - this is how
    // DFV0013963 slipped through on 2026-10-21) BEFORE deciding whether
    // this truck is clear to dispatch. This is the one place that actually
    // stops a truck physically leaving without an item Packing & Production
    // says belongs on one of its orders, so - unlike the other two call
    // sites, which are happy reusing whatever's already cached - the FIRST
    // (force=false) call for a given dispatch pays for a fresh, uncached
    // Packing & Production read, not the up-to-45-second-stale one
    // fetchAllOrdersFromPacking_ would otherwise serve.
    //
    // The checker's confirm tap after a driver/route/tray-count warning
    // (force=true) calls this function a SECOND time for the same
    // dispatch, seconds later - until build-2026-10-30 that redid this
    // exact same full uncached scan again from scratch, doubling the cost
    // of every warning-involving dispatch for no real safety gain (nothing
    // about order/Packing readiness changes in the few seconds a checker
    // spends reading a confirm modal). Now the force=false call warms the
    // shared cache with what it just read, and the force=true call reuses
    // it via the normal cached fetchAllOrdersFromPacking_ - still far
    // fresher in practice than the 45-second staleness every other caller
    // already accepts, at a small fraction of the cost.
    var packingOrdersForDispatch = {};
    try {
      var dispatchSettings = readSettings_();
      if (dispatchSettings.PackingSpreadsheetId) {
        var packingOrdersForReconcile = force
          ? fetchAllOrdersFromPacking_()
          : fetchAllOrdersFromPackingUncached_(dispatchSettings.PackingSpreadsheetId);
        if (!force) cachePackingOrders_(dispatchSettings.PackingSpreadsheetId, packingOrdersForReconcile);
        packingOrdersForReconcile.forEach(function (o) { packingOrdersForDispatch[orderIdKey_(o.orderId)] = o; });
      }
    } catch (err) {
      // best-effort - a Packing & Production hiccup here shouldn't itself
      // block dispatch; the existing Status-based completeness check below
      // still runs on whatever Dispatch already has.
    }

    state.orderChecks.forEach(function (c) {
      var siblingItems = itemChecksForDispatch.filter(function (i) { return i.OrderCheckID === c.ID; });
      var packingOrder = packingOrdersForDispatch[orderIdKey_(c.OrderID)];
      siblingItems = reconcileOrderItemsAgainstPacking_(c, siblingItems, packingOrder ? packingOrder.items : null);
      c.Status = reconcileOrderCheckStatus_(c, siblingItems);
    });
  }

  var incomplete = state.orderChecks.filter(function (c) { return c.Status !== ORDER_STATUS.COMPLETE; });
  // A Job blocks dispatch until Done, the same hard rule as an order (see
  // the Jobs section further down) - Shane's explicit call, treating it as
  // a lightweight order (no items to pack, just one instruction to carry
  // out) rather than a side note that could be silently left undone.
  var incompleteJobs = state.jobs.filter(function (j) { return j.Status !== JOB_STATUS.DONE; });
  if (incomplete.length > 0 || incompleteJobs.length > 0) {
    var parts = [];
    if (incomplete.length > 0) parts.push(incomplete.length + ' order(s)');
    if (incompleteJobs.length > 0) parts.push(incompleteJobs.length + ' job(s)');
    return {
      ok: false,
      blocked: true,
      blockedReason: parts.join(' and ') + ' on this truck ' + ((incomplete.length + incompleteJobs.length) === 1 ? 'is' : 'are') + ' not yet complete.',
      incompleteOrders: incomplete.map(function (c) { return { orderId: c.OrderID, orderNumber: c.OrderNumber, customer: c.Customer, status: c.Status }; }),
      incompleteJobs: incompleteJobs.map(function (j) { return { jobId: j.ID, subject: j.Subject, status: j.Status }; })
    };
  }

  // Late dispatch (build-2026-11-09-01, Shane's request): a truck's FIRST
  // trip of the day leaving after 07:00 must have a reason picked from
  // Admin > Settings > Late Reasons before it can be marked dispatched.
  // Same "late" rule as the Dashboard's red "Late leaving" badge and the
  // Trucks Leaving Late card (see isLateDispatchNow_). Asked BEFORE the
  // driver/route/tray warnings, so the frontend can collect the reason
  // first and then pass it along on every later call for this dispatch,
  // including the force=true confirm. If no reasons have been set up yet,
  // this step is skipped rather than blocking every late truck.
  var recordedLateReason = '';
  var lateReasonOrders = []; // OrderChecks rows picked for a RequiresOrder reason
  if (isLateDispatchNow_(state.session)) {
    var activeReasons = listLateReasons(true).filter(function (r) { return String(r.Name).trim(); });
    if (activeReasons.length > 0) {
      var chosen = String(lateReason || '').trim().toLowerCase();
      var match = activeReasons.filter(function (r) { return String(r.Name).trim().toLowerCase() === chosen; })[0];
      // Orders the checker can pick from: everything on this trip. A trip
      // with no orders at all (trays/Jobs only) can't name one, so a
      // RequiresOrder reason is accepted without any there.
      var tripOrders = state.orderChecks.map(function (c) {
        return { orderId: String(c.OrderID), orderNumber: c.OrderNumber, customer: c.Customer };
      });
      var pickedKeys = {};
      (Array.isArray(lateReasonOrderIds) ? lateReasonOrderIds : []).forEach(function (id) { pickedKeys[orderIdKey_(id)] = true; });
      var picked = state.orderChecks.filter(function (c) { return pickedKeys[orderIdKey_(c.OrderID)]; });
      var needsOrders = match && isTrueCell_(match.RequiresOrder) && tripOrders.length > 0;
      if (!match || (needsOrders && picked.length === 0)) {
        return {
          ok: false,
          lateReasonRequired: true,
          cutoff: formatMinutesOfDay_(LATE_TRUCK_CUTOFF_MINUTES),
          lateReasons: activeReasons.map(function (r) {
            return { name: String(r.Name).trim(), requiresOrder: isTrueCell_(r.RequiresOrder) };
          }),
          orders: tripOrders,
          error: match ? 'Pick the order(s) this applies to.' : ''
        };
      }
      recordedLateReason = String(match.Name).trim();
      if (needsOrders) lateReasonOrders = picked;
    }
  }

  var warnings = [];
  if (!state.session.Driver) warnings.push('Driver name has not been entered.');
  if (!state.session.Route) warnings.push('Route has not been entered.');
  var noTraysEntered = ['TraySmall', 'TrayMedium', 'TrayLarge', 'TrayOther'].every(function (key) {
    return state.session[key] === '' || state.session[key] === undefined || state.session[key] === null;
  });
  // A trip explicitly marked "no fruit trays" (NoTraysOnTrip) is blank on
  // purpose, not forgotten - skip the warning entirely for it rather than
  // making the checker force-dispatch past a warning that doesn't apply.
  if (noTraysEntered && !state.session.NoTraysOnTrip) warnings.push('Fruit tray counts have not been entered.');

  if (warnings.length > 0 && !force) {
    return { ok: false, warnings: warnings };
  }

  // Each order named for a RequiresOrder late reason becomes an open item
  // on the Dashboard's Flagged Packing Issues checklist, which management
  // already works through and resolves. Written BEFORE the session is
  // marked dispatched: if the dispatch write then fails, a retry could add
  // a duplicate item, which is better than a dispatched truck whose
  // follow-up was silently lost.
  if (lateReasonOrders.length > 0) {
    appendObjects_(getSheet_(SHEET_NAMES.PACKING_ISSUES), SHEET_HEADERS.PackingIssues, lateReasonOrders.map(function (c) {
      return {
        ID: Utilities.getUuid(), TruckSessionID: sessionId, OrderCheckID: c.ID, ItemCheckID: '',
        Date: todayString_(), TruckName: state.session.TruckName,
        OrderNumber: c.OrderNumber, Customer: c.Customer,
        ProductDescription: 'Whole order - truck left late',
        Note: 'Late reason: ' + recordedLateReason, Status: ISSUE_STATUS.OPEN,
        FlaggedByID: '', FlaggedByName: checkerName || '', FlaggedAt: nowIso_(),
        ResolvedByName: '', ResolvedAt: ''
      };
    }));
  }

  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
    Status: SESSION_STATUS.DISPATCHED, DispatchedAt: nowIso_(), DispatchedBy: checkerName,
    DispatchedWithWarnings: warnings.length > 0, DispatchWarningsText: warnings.join('; '),
    LateReason: recordedLateReason,
    LateReasonOrders: lateReasonOrders.map(function (c) { return c.OrderNumber; }).join(', ')
  });
  return { ok: true };
}

// Sheets checkbox cells come back as real booleans, but a value typed by
// hand may be the text "TRUE".
function isTrueCell_(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * True if dispatching this session RIGHT NOW counts as late: it's the
 * truck's first trip today (trip 2+ has no leave-by target, same rule as
 * getLateTruckLeaderboard and the frontend's onTimeBadge_) and the current
 * time in the script's timezone is past LATE_TRUCK_CUTOFF_MINUTES (07:00).
 * Uses the server's clock, not the phone's, so a checker's device clock
 * can't decide whether a reason is needed.
 */
function isLateDispatchNow_(session) {
  var tz = Session.getScriptTimeZone() || 'Africa/Johannesburg';
  var hm = Utilities.formatDate(new Date(), tz, 'HH:mm').split(':');
  var minutesOfDay = Number(hm[0]) * 60 + Number(hm[1]);
  if (minutesOfDay <= LATE_TRUCK_CUTOFF_MINUTES) return false;

  var day = normalizeDateStr_(session.Date);
  var earlierTripToday = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).some(function (s) {
    return s.TruckID === session.TruckID && s.ID !== session.ID && normalizeDateStr_(s.Date) === day &&
      String(s.StartedAt) < String(session.StartedAt);
  });
  return !earlierTripToday;
}

function formatMinutesOfDay_(minutes) {
  var h = Math.floor(minutes / 60), m = minutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

// ---------------------------------------------------------------------------
// LATE REASONS (Admin > Settings > Late Reasons)
// ---------------------------------------------------------------------------

/**
 * Creates the LateReasons tab and adds the LateReason header to
 * TruckSessions if either is missing, so this feature works on the live
 * sheet straight after a new deployment, without anyone having to re-run
 * setupSpreadsheet() first (which would also work, and is still safe to
 * run). Only checks once every 6 hours (CacheService flag), so it costs
 * nothing on normal calls.
 */
function ensureLateReasonSchema_() {
  var cache = CacheService.getScriptCache();
  var flagKey = 'lateReasonSchemaOk_v2';
  if (cache.get(flagKey)) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var reasonsSheet = ss.getSheetByName(SHEET_NAMES.LATE_REASONS);
  if (!reasonsSheet) {
    reasonsSheet = ss.insertSheet(SHEET_NAMES.LATE_REASONS);
    reasonsSheet.setFrozenRows(1);
  }
  ensureHeaderCells_(reasonsSheet, SHEET_HEADERS.LateReasons, ['ID', 'Name', 'Active', 'CreatedAt', 'RequiresOrder']);
  ensureHeaderCells_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, ['LateReason', 'LateReasonOrders']);

  try { cache.put(flagKey, '1', 6 * 60 * 60); } catch (e) { /* best-effort */ }
}

// Writes any of the named header cells that are missing from row 1, at the
// position SHEET_HEADERS says they belong (adding columns if the sheet is
// too narrow). Never moves or overwrites a header that's already right.
function ensureHeaderCells_(sheet, headers, names) {
  names.forEach(function (name) {
    var colIdx = headers.indexOf(name) + 1;
    if (sheet.getMaxColumns() < colIdx) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), colIdx - sheet.getMaxColumns());
    }
    var cell = sheet.getRange(1, colIdx);
    if (cell.getValue() !== name) cell.setValue(name);
  });
}

function listLateReasons(activeOnly) {
  ensureLateReasonSchema_();
  var reasons = sheetToObjects_(getSheet_(SHEET_NAMES.LATE_REASONS));
  if (activeOnly) reasons = reasons.filter(function (r) { return r.Active === true; });
  reasons.sort(function (a, b) { return String(a.Name).localeCompare(String(b.Name)); });
  return reasons;
}

function addLateReason(name) {
  ensureLateReasonSchema_();
  name = String(name || '').trim();
  if (!name) throw new Error('Enter a reason.');
  var exists = listLateReasons(false).some(function (r) { return String(r.Name).trim().toLowerCase() === name.toLowerCase(); });
  if (exists) throw new Error('"' + name + '" is already on the list.');
  var id = Utilities.getUuid();
  appendObject_(getSheet_(SHEET_NAMES.LATE_REASONS), SHEET_HEADERS.LateReasons, {
    ID: id, Name: name, Active: true, CreatedAt: nowIso_(), RequiresOrder: false
  });
  return { id: id };
}

function updateLateReason(id, patch) {
  ensureLateReasonSchema_();
  patch = patch || {};
  if ('ID' in patch) delete patch.ID;
  if ('Name' in patch) {
    patch.Name = String(patch.Name || '').trim();
    if (!patch.Name) throw new Error('A reason can\'t be blank.');
  }
  updateRowById_(getSheet_(SHEET_NAMES.LATE_REASONS), SHEET_HEADERS.LateReasons, id, patch);
  return { ok: true };
}

function deleteLateReason(id) {
  ensureLateReasonSchema_();
  deleteRowById_(getSheet_(SHEET_NAMES.LATE_REASONS), id);
  return { ok: true };
}

/** Read-only overview of today's truck sessions, for Admin. */
function getTodaysTruckOverview() {
  var today = todayString_();
  return sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return normalizeDateStr_(s.Date) === today; });
}

/**
 * Full admin dashboard for a given day: every truck session, the orders
 * checked under it (with packed/no-stock breakdowns), and a summary row
 * with quality signals - most importantly trucks that got dispatched
 * despite open warnings (incomplete orders, missing driver/tray count),
 * since that's the clearest "something was rushed" signal available.
 * Defaults to today when no date is given, but any past 'yyyy-MM-dd' date
 * works too - lets Admin/Dispatch Manager look back at a previous day's
 * dispatch record (who checked what, tray counts, driver, route, no-stock
 * items, timing) without having to dig through the raw Sheet.
 *
 * Also returns dispatchTimeline (build-2026-10-26-04) - the Dispatch
 * Timeline card that originally lived on the Trucks board (2026-10-26) but
 * Shane asked to have moved here instead, so it sits alongside the rest of
 * the day's dispatch record rather than the morning order-assignment
 * screen. Reuses buildDispatchTimelineAndScorecard_ (see its own comment
 * for what the gap actually measures) - this function already has
 * sessions/allOrderChecks for the target date in hand, so computing it
 * costs one more trip-numbering pass, no extra sheet reads. jobsToday is
 * passed as [] since buildDispatchTimelineAndScorecard_ no longer reads it
 * anyway (see its own comment) - no point reading Jobs here just to hand
 * it an array it won't use. Only the Scorecard half (not returned here)
 * stayed on the Trucks board, computed separately by
 * getTruckAssignmentBoardUncached_ for that screen's own cached payload.
 */
function getDashboardForDate(dateStr) {
  var targetDate = dateStr || todayString_();
  var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return normalizeDateStr_(s.Date) === targetDate; });
  // Driver deliveries (build-2026-11-10-01) - when each order was marked
  // delivered from the road, keyed by OrderCheckID.
  // DriverLogs read ONCE for both lookups below (build-2026-11-10-03 -
  // this call was timing out; every extra full-sheet read here adds up).
  var dayDriverLogs = driverLogsForDate_(targetDate);
  var deliveredAtByOrderCheckId = deliveredAtByOrderCheckId_(targetDate, dayDriverLogs);
  // Fruit-tray stops (build-2026-11-10-02) - counted on each truck's first
  // trip of the day, same as the driver's list.
  var trayByVehicle = trayStopsByVehicle_(targetDate);
  var trayDelivered = trayDeliveredMap_(targetDate, dayDriverLogs);
  var zohoVehicleByTruckId = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS)).forEach(function (t) { zohoVehicleByTruckId[t.ID] = String(t.ZohoVehicleID || ''); });
  var firstSessionByTruck = {};
  sessions.slice().sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); })
    .forEach(function (s) { if (!firstSessionByTruck[s.TruckID]) firstSessionByTruck[s.TruckID] = s.ID; });
  var allOrderChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return normalizeDateStr_(c.Date) === targetDate; });
  // Indexed by OrderCheckID up front (build-2026-11-10-03). This used to
  // run allItemChecks.filter(...) once PER ORDER - every order on the day
  // scanning every ItemChecks row on record (up to 14 days of them), which
  // is millions of comparisons on a busy day and the main reason this
  // call could pass the app's 20s timeout. Only this day's orders are kept.
  var dayOrderCheckIds = {};
  allOrderChecks.forEach(function (c) { dayOrderCheckIds[c.ID] = true; });
  var itemChecksByOrderCheckId = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS)).forEach(function (i) {
    if (!dayOrderCheckIds[i.OrderCheckID]) return;
    (itemChecksByOrderCheckId[i.OrderCheckID] = itemChecksByOrderCheckId[i.OrderCheckID] || []).push(i);
  });

  var trucks = sessions.map(function (session) {
    var orderChecks = allOrderChecks.filter(function (c) { return c.TruckSessionID === session.ID; });

    var orders = orderChecks.map(function (oc) {
      var items = itemChecksByOrderCheckId[oc.ID] || [];
      var noStockItems = items.filter(function (i) { return i.Status === ITEM_STATUS.NO_STOCK; });
      // "Short-packed" = marked Packed but the checker used Edit Qty to
      // record packing something other than the full ordered Qty (a blank
      // PackedQty means "packed as ordered" - see the ItemChecks.PackedQty
      // comment above). Kept as its own rollup, parallel to no-stock, since
      // it's a different signal: the order still went out, just not at the
      // full quantity, whereas no-stock is nothing going out at all.
      var shortPackedItems = items.filter(function (i) {
        return i.Status === ITEM_STATUS.PACKED && i.PackedQty !== '' && i.PackedQty !== null && i.PackedQty !== undefined &&
          Number(i.PackedQty) !== Number(i.Qty);
      });
      return {
        orderNumber: oc.OrderNumber,
        customer: oc.Customer,
        status: oc.Status,
        deliveredAt: deliveredAtByOrderCheckId[oc.ID] || '',
        itemCount: items.length,
        packedCount: items.filter(function (i) { return i.Status === ITEM_STATUS.PACKED; }).length,
        noStockCount: noStockItems.length,
        noStockDetails: noStockItems.map(function (i) { return { description: i.ProductDescription, reason: i.NoStockReason || '' }; }),
        shortPackedCount: shortPackedItems.length,
        shortPackedDetails: shortPackedItems.map(function (i) {
          return { description: i.ProductDescription, orderedQty: i.Qty, packedQty: i.PackedQty, unit: i.Unit };
        })
      };
    });

    var durationMinutes = null;
    if (session.Status === SESSION_STATUS.DISPATCHED && session.StartedAt && session.DispatchedAt) {
      durationMinutes = Math.round((new Date(session.DispatchedAt) - new Date(session.StartedAt)) / 60000);
    }

    return {
      // sessionId (build-2026-10-26-05) - a stable per-truck-trip key the
      // frontend uses to remember which card is expanded/collapsed across
      // re-renders (tile clicks, search) without needing anything keyed
      // off truckName, which isn't unique across a truck's multiple trips
      // today.
      sessionId: session.ID,
      truckName: session.TruckName,
      checkerName: session.CheckerName,
      driver: session.Driver || '',
      driverContacts: session.DriverContacts || '',
      route: session.Route || '',
      status: session.Status,
      startedAt: session.StartedAt,
      dispatchedAt: session.DispatchedAt || '',
      dispatchedBy: session.DispatchedBy || '',
      traySmall: session.TraySmall,
      trayMedium: session.TrayMedium,
      trayLarge: session.TrayLarge,
      trayOther: session.TrayOther,
      noTraysOnTrip: session.NoTraysOnTrip === true,
      durationMinutes: durationMinutes,
      dispatchedWithWarnings: session.DispatchedWithWarnings === true,
      dispatchWarningsText: session.DispatchWarningsText || '',
      lateReason: session.LateReason || '',
      lateReasonOrders: session.LateReasonOrders || '',
      orderCount: orders.length,
      deliveredCount: orders.filter(function (o) { return o.deliveredAt; }).length,
      trayStopCount: (firstSessionByTruck[session.TruckID] === session.ID && zohoVehicleByTruckId[session.TruckID])
        ? (trayByVehicle[zohoVehicleByTruckId[session.TruckID]] || []).length : 0,
      trayDeliveredCount: (firstSessionByTruck[session.TruckID] === session.ID && zohoVehicleByTruckId[session.TruckID])
        ? (trayByVehicle[zohoVehicleByTruckId[session.TruckID]] || []).filter(function (st) { return trayDelivered[st.ID]; }).length : 0,
      lastDeliveredAt: orders.reduce(function (latest, o) { return o.deliveredAt && o.deliveredAt > latest ? o.deliveredAt : latest; }, ''),
      noStockTotal: orders.reduce(function (sum, o) { return sum + o.noStockCount; }, 0),
      shortPackedTotal: orders.reduce(function (sum, o) { return sum + o.shortPackedCount; }, 0),
      orders: orders
    };
  });

  // Most recently started truck first
  trucks.sort(function (a, b) { return new Date(b.startedAt) - new Date(a.startedAt); });

  var summary = {
    totalTrucks: trucks.length,
    dispatchedCount: trucks.filter(function (t) { return t.status === SESSION_STATUS.DISPATCHED; }).length,
    inProgressCount: trucks.filter(function (t) { return t.status === SESSION_STATUS.IN_PROGRESS; }).length,
    totalOrders: trucks.reduce(function (sum, t) { return sum + t.orderCount; }, 0),
    totalNoStockItems: trucks.reduce(function (sum, t) { return sum + t.noStockTotal; }, 0),
    totalShortPackedItems: trucks.reduce(function (sum, t) { return sum + t.shortPackedTotal; }, 0),
    forcedDispatchCount: trucks.filter(function (t) { return t.dispatchedWithWarnings; }).length
  };

  // Same ordinal-per-truck trip numbering as getTruckAssignmentBoardUncached_
  // (chronological by StartedAt, counted per TruckID) - only used so
  // dispatchTimeline can label a truck's 2nd+ trip today, same as it did on
  // the Trucks board.
  var sessionsForTripNumbering = sessions.slice().sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); });
  var tripNumberBySessionId = {};
  var tripCountByTruckId = {};
  sessionsForTripNumbering.forEach(function (s) {
    tripCountByTruckId[s.TruckID] = (tripCountByTruckId[s.TruckID] || 0) + 1;
    tripNumberBySessionId[s.ID] = tripCountByTruckId[s.TruckID];
  });
  var dispatchTimeline = buildDispatchTimelineAndScorecard_(sessions, allOrderChecks, [], tripNumberBySessionId).dispatchTimeline;

  return { date: targetDate, summary: summary, trucks: trucks, dispatchTimeline: dispatchTimeline };
}

/**
 * "Trucks consistently leaving late" (build-2026-10-27-05) - Shane asked
 * for a Dashboard data point surfacing trucks whose first trip of the day
 * keeps missing the leave-by target, not just a one-off bad morning.
 * "Late" uses the same 07:00 cutoff as the Dispatch Timeline's own
 * on-time badge (see onTimeBadge_ in index.html - kept in sync by eye,
 * since this is backend-only data with no shared constant to import), and
 * "trip 2 excluded" applies here exactly as it does there - a truck's 2nd+
 * trip of the day has no fixed leave-by target, so only each day's trip 1
 * counts toward a truck's tally.
 *
 * Looks back LATE_TRUCK_WINDOW_DAYS days (including today) and flags any
 * truck with LATE_TRUCK_MIN_LATE_COUNT or more late trip-1 dispatches in
 * that window. One pass over TruckSessions, pre-filtered to the window,
 * rather than calling getDashboardForDate once per day in the window -
 * that would be 30 separate full-sheet reads for data this one read
 * already has.
 */
var LATE_TRUCK_WINDOW_DAYS = 30;
var LATE_TRUCK_MIN_LATE_COUNT = 3;
var LATE_TRUCK_CUTOFF_MINUTES = 7 * 60; // 07:00 - matches onTimeBadge_'s amber/red boundary in index.html

function getLateTruckLeaderboard() {
  var tz = Session.getScriptTimeZone() || 'Africa/Johannesburg';
  var windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - (LATE_TRUCK_WINDOW_DAYS - 1));
  var windowStartStr = Utilities.formatDate(windowStart, tz, 'yyyy-MM-dd');

  var sessionsInWindow = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) {
    return s.Status === SESSION_STATUS.DISPATCHED && s.DispatchedAt && normalizeDateStr_(s.Date) >= windowStartStr;
  });

  // Trip numbering is per truck PER DAY (same rule used everywhere else in
  // this file, e.g. getTruckAssignmentBoardUncached_/getDashboardForDate) -
  // group by truck+day first, then number chronologically within each group.
  var byTruckAndDay = {};
  sessionsInWindow.forEach(function (s) {
    var key = s.TruckID + '|' + normalizeDateStr_(s.Date);
    (byTruckAndDay[key] = byTruckAndDay[key] || []).push(s);
  });
  var tripNumberBySessionId = {};
  Object.keys(byTruckAndDay).forEach(function (key) {
    var group = byTruckAndDay[key].slice().sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); });
    group.forEach(function (s, i) { tripNumberBySessionId[s.ID] = i + 1; });
  });

  var statsByTruck = {}; // truckName -> { lateCount, trip1Count, reasonCounts }
  sessionsInWindow.forEach(function (s) {
    if (tripNumberBySessionId[s.ID] !== 1) return; // only trip 1 is held to the leave-by target
    var hm = Utilities.formatDate(new Date(s.DispatchedAt), tz, 'HH:mm').split(':');
    var minutesOfDay = Number(hm[0]) * 60 + Number(hm[1]);
    var truckName = s.TruckName;
    if (!statsByTruck[truckName]) statsByTruck[truckName] = { lateCount: 0, trip1Count: 0, reasonCounts: {} };
    statsByTruck[truckName].trip1Count++;
    if (minutesOfDay > LATE_TRUCK_CUTOFF_MINUTES) {
      statsByTruck[truckName].lateCount++;
      var reason = String(s.LateReason || '').trim() || 'No reason recorded';
      statsByTruck[truckName].reasonCounts[reason] = (statsByTruck[truckName].reasonCounts[reason] || 0) + 1;
    }
  });

  var trucks = Object.keys(statsByTruck)
    .map(function (truckName) {
      var counts = statsByTruck[truckName].reasonCounts;
      return {
        truckName: truckName, lateCount: statsByTruck[truckName].lateCount, trip1Count: statsByTruck[truckName].trip1Count,
        // Most common reason first - what Shane needs to see to act on a
        // truck that keeps leaving late.
        reasons: Object.keys(counts).map(function (r) { return { reason: r, count: counts[r] }; })
          .sort(function (a, b) { return b.count - a.count; })
      };
    })
    .filter(function (row) { return row.lateCount >= LATE_TRUCK_MIN_LATE_COUNT; })
    .sort(function (a, b) { return b.lateCount - a.lateCount; });

  return { windowDays: LATE_TRUCK_WINDOW_DAYS, minLateCount: LATE_TRUCK_MIN_LATE_COUNT, trucks: trucks };
}

// ---------------------------------------------------------------------------
// DISPATCH MANAGER - end-of-day order fulfillment overview
//
// A separate view from getTodaysDashboard above: that one is organized by
// TRUCK (what happened on each truck's run). This is organized by ORDER -
// of everything that was due today (or overdue from a previous day), did it
// actually leave, and if not, why not. An order counts as "dispatched" if
// it was allocated to a truck session that has since been marked Dispatched;
// "collected" if the customer picked it up directly (see CollectedOrders,
// markOrderCollected below) - anything else is outstanding.
// ---------------------------------------------------------------------------

function getCollectedOrderIds_() {
  var ids = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.COLLECTED_ORDERS)).forEach(function (r) { ids[orderIdKey_(r.OrderID)] = true; });
  return ids;
}

/** Marks an order as collected by the customer directly, instead of going out on a truck. Safe to call twice - no duplicate rows. */
function markOrderCollected(orderId, orderNumber, customer, collectedBy) {
  var sheet = getSheet_(SHEET_NAMES.COLLECTED_ORDERS);
  var alreadyCollected = sheetToObjects_(sheet).some(function (r) { return orderIdKey_(r.OrderID) === orderIdKey_(orderId); });
  if (alreadyCollected) return { ok: true };
  appendObject_(sheet, SHEET_HEADERS.CollectedOrders, {
    OrderID: orderId, OrderNumber: orderNumber, Customer: customer, CollectedAt: nowIso_(), CollectedBy: collectedBy
  });
  return { ok: true };
}

/** Undoes markOrderCollected - e.g. it was marked by mistake. */
function unmarkOrderCollected(orderId) {
  var sheet = getSheet_(SHEET_NAMES.COLLECTED_ORDERS);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (orderIdKey_(data[i][0]) === orderIdKey_(orderId)) sheet.deleteRow(i + 1);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// JOBS (non-order instructions on a truck's trip)
//
// A checker can add a plain-language instruction to their truck's CURRENT
// trip for something that isn't a real Packing & Production order - "collect
// crates from ABC Farms", "drop pallets at the depot" - from right inside
// the truck's own workspace, alongside "+ Add Order". Unlike the old
// Non-Order Dispatch feature this replaces (Dispatch Manager/Admin only, a
// separate logged record untouched by the dispatch checklist), a Job IS
// tied to a real TruckSessionID and DOES block dispatch until marked Done -
// Shane's explicit call (2026-09-16): treat it as a lightweight order
// (no items to pack, just one thing to do) rather than a side note.
// ---------------------------------------------------------------------------

/**
 * Adds a Job to a truck's CURRENT trip. Refuses on an already-dispatched
 * session (that truck has physically left - same reasoning as
 * unallocateOrder's guard below) so a Job can never be added somewhere it
 * would never be seen. Deliberately NOT in RETRYABLE_ACTIONS on the
 * frontend: unlike setItemStatus/setJobStatus (idempotent overwrites-by-ID),
 * this always appends a brand-new row, so blindly retrying a lost response
 * could create a duplicate Job.
 */
function addJobToTruck(sessionId, subject, instructions, checkerId, checkerName) {
  subject = String(subject || '').trim();
  instructions = String(instructions || '').trim();
  if (!subject) throw new Error('Enter an order number or subject line.');
  if (!instructions) throw new Error('Enter the instructions for this job.');

  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return s.ID === sessionId; })[0];
  if (!session) throw new Error('Truck session not found.');
  if (session.Status === SESSION_STATUS.DISPATCHED) {
    throw new Error('Can\'t add a job - truck "' + session.TruckName + '" has already dispatched.');
  }

  var id = Utilities.getUuid();
  appendObject_(getSheet_(SHEET_NAMES.JOBS), SHEET_HEADERS.Jobs, {
    ID: id, TruckSessionID: sessionId, Date: todayString_(), Subject: subject, Instructions: instructions,
    Status: JOB_STATUS.PENDING, CreatedByID: checkerId || '', CreatedByName: checkerName || '',
    CreatedAt: nowIso_(), DoneBy: '', DoneAt: ''
  });
  return { id: id };
}

/** Jobs on one truck session, for the truck's own Orders pane (merged there with real orders - see getOrdersForSession). */
function getJobsForSession(sessionId) {
  return sheetToObjects_(getSheet_(SHEET_NAMES.JOBS)).filter(function (j) { return j.TruckSessionID === sessionId; });
}

/**
 * Marks a Job Done or back to Pending. Overwrites by ID like every other
 * single-field update in this file (setItemStatus, setOrderCoaConfirmed,
 * ...), so a retried/duplicate call is a safe no-op, not a duplicate
 * record - unlike addJobToTruck above. Un-marking (status back to Pending)
 * clears DoneBy/At, same reasoning as CoaConfirmed's clear-on-un-tick.
 */
function setJobStatus(jobId, status, checkerName) {
  var done = status === JOB_STATUS.DONE;
  updateRowById_(getSheet_(SHEET_NAMES.JOBS), SHEET_HEADERS.Jobs, jobId, {
    Status: done ? JOB_STATUS.DONE : JOB_STATUS.PENDING,
    DoneBy: done ? String(checkerName || '') : '',
    DoneAt: done ? nowIso_() : ''
  });
  return { ok: true };
}

/**
 * Removes a Job added by mistake - mirrors unallocateOrder's "undo" role
 * for orders. Refuses once the truck has dispatched (can't retroactively
 * pull an instruction off a run that's already left), and is itself a
 * safe no-op if the Job is already gone (a genuinely retried call after a
 * lost response, same pattern as unallocateOrder's own early return) -
 * unlike addJobToTruck, this one's fine to mark RETRYABLE on the frontend.
 */
function removeJob(jobId) {
  var job = sheetToObjects_(getSheet_(SHEET_NAMES.JOBS)).filter(function (j) { return j.ID === jobId; })[0];
  if (!job) return { ok: true, wasRemoved: false };

  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return s.ID === job.TruckSessionID; })[0];
  if (session && session.Status === SESSION_STATUS.DISPATCHED) {
    throw new Error('Can\'t remove - truck "' + session.TruckName + '" has already dispatched.');
  }

  deleteRowById_(getSheet_(SHEET_NAMES.JOBS), jobId);
  return { ok: true, wasRemoved: true };
}

/**
 * For the Admin Dashboard's Viewing date - every Job added that day, across
 * all trucks, most recent first, with the truck name it belongs to (a Job
 * itself only stores TruckSessionID, so this joins against TruckSessions
 * to resolve it - same join getTruckAssignmentBoard already does for
 * orders-by-truck).
 */
function listJobsForDate(dateStr) {
  var targetDate = dateStr || todayString_();
  var sessionsById = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).forEach(function (s) { sessionsById[s.ID] = s; });

  return sheetToObjects_(getSheet_(SHEET_NAMES.JOBS))
    .filter(function (j) { return normalizeDateStr_(j.Date) === targetDate; })
    .map(function (j) {
      var session = sessionsById[j.TruckSessionID];
      return {
        id: j.ID, truckName: session ? session.TruckName : '(truck no longer on record)',
        subject: j.Subject, instructions: j.Instructions, status: j.Status,
        createdByName: j.CreatedByName, createdAt: j.CreatedAt, doneBy: j.DoneBy, doneAt: j.DoneAt
      };
    })
    .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
}

// ---------------------------------------------------------------------------
// PACKING QUALITY FLAGS (checker-reported packer mistakes)
//
// While checking stock, a checker can flag a specific item as a packer
// having done a poor job on it - poor quality, wrong weight, etc. - with a
// short free-text note (Shane's request, 2026-09-16). Deliberately NOT the
// Jobs model: this does NOT block dispatch and does NOT change the item's
// own Status (Pending/Packed/No Stock) - it's purely a side note that
// surfaces as a checklist on the Admin Dashboard for someone to follow up
// on, the same non-blocking spirit as the dispatched-with-warnings signals
// elsewhere in this file.
// ---------------------------------------------------------------------------

/**
 * Flags one item with a short quality note. Can be raised regardless of the
 * item's current Status - a packer's mistake is often only noticed after
 * the item's already been marked Packed, so this deliberately doesn't
 * require (or change) any particular status. TruckName/OrderNumber/Customer/
 * ProductDescription are all snapshotted onto the new row at flag time (the
 * same denormalization already used for Jobs/OrderChecks elsewhere in this
 * file) so the Dashboard checklist can render straight from PackingIssues
 * without joining back across ItemChecks/OrderChecks/TruckSessions again.
 */
function flagPackingIssue(itemCheckId, note, checkerId, checkerName) {
  note = String(note || '').trim();
  if (!note) throw new Error('Enter a short explanation of the issue.');

  var item = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS)).filter(function (i) { return i.ID === itemCheckId; })[0];
  if (!item) throw new Error('Item not found.');

  var orderCheck = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return c.ID === item.OrderCheckID; })[0];
  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return s.ID === item.TruckSessionID; })[0];

  var id = Utilities.getUuid();
  appendObject_(getSheet_(SHEET_NAMES.PACKING_ISSUES), SHEET_HEADERS.PackingIssues, {
    ID: id, TruckSessionID: item.TruckSessionID, OrderCheckID: item.OrderCheckID, ItemCheckID: itemCheckId,
    Date: todayString_(), TruckName: session ? session.TruckName : '',
    OrderNumber: orderCheck ? orderCheck.OrderNumber : '', Customer: orderCheck ? orderCheck.Customer : '',
    ProductDescription: item.ProductDescription, Note: note, Status: ISSUE_STATUS.OPEN,
    FlaggedByID: checkerId || '', FlaggedByName: checkerName || '', FlaggedAt: nowIso_(),
    ResolvedByName: '', ResolvedAt: ''
  });
  return { id: id };
}

/** For History's "Flagged Packing Issues" checklist - every flag raised on the picked day, across all trucks, most recently flagged first, regardless of whether it's since been resolved (a historical record of that specific day). The Admin Dashboard itself uses listOpenPackingIssues below instead - see its own comment for why. */
function listPackingIssuesForDate(dateStr) {
  var targetDate = dateStr || todayString_();
  return sheetToObjects_(getSheet_(SHEET_NAMES.PACKING_ISSUES))
    .filter(function (p) { return normalizeDateStr_(p.Date) === targetDate; })
    // p.Date was already being normalized above to FILTER by day, but the
    // raw (possibly Sheets-auto-converted-to-a-real-Date) value was still
    // what got sent back to the frontend - formatDateForDisplay only
    // handles a plain 'yyyy-MM-dd' string, so a Date object serialized to
    // JSON as a full ISO timestamp ("2026-09-26T00:00:00.000Z") broke its
    // naive split-by-dash parsing and showed "Invalid Date" (Shane,
    // 2026-09-28). Normalizing here, not just in the filter, fixes it -
    // and does so correctly (same script timezone normalizeDateStr_
    // always uses), unlike a frontend-side String(...).slice(0,10) fix
    // would have (that would read the UTC-shifted ISO string and could
    // land on the wrong calendar day entirely).
    .map(function (p) { p.Date = normalizeDateStr_(p.Date); return p; })
    .sort(function (a, b) { return new Date(b.FlaggedAt) - new Date(a.FlaggedAt); });
}

/**
 * For the Admin Dashboard's "Flagged Packing Issues" checklist - EVERY
 * still-open flag, regardless of which day it was raised (Shane's
 * 2026-09-22 request: unlike Jobs, which always get resolved same-day so
 * staying date-scoped there is fine, a packing issue can linger unresolved
 * past midnight and Shane wants it to stay visible on the Dashboard until
 * someone actually resolves it, not just on the day it was flagged). Most
 * recently flagged first, same ordering as listPackingIssuesForDate above.
 * pruneOldRecords (see above) exempts OPEN rows from its normal
 * age-based cleanup for the same reason - an old unresolved flag should
 * never silently vanish out from under this list.
 */
function listOpenPackingIssues() {
  return sheetToObjects_(getSheet_(SHEET_NAMES.PACKING_ISSUES))
    .filter(function (p) { return p.Status === ISSUE_STATUS.OPEN; })
    // See the matching comment in listPackingIssuesForDate above - same
    // "Invalid Date" fix (Shane, 2026-09-28), needed here too since this is
    // the Dashboard's own path and wasn't normalizing its filter's Date at
    // all (no date filtering happens here, so there was no normalizeDateStr_
    // call anywhere in this function to begin with).
    .map(function (p) { p.Date = normalizeDateStr_(p.Date); return p; })
    .sort(function (a, b) { return new Date(b.FlaggedAt) - new Date(a.FlaggedAt); });
}

/**
 * Marks a flagged packing issue Resolved or back to Open - mirrors
 * setJobStatus's overwrite-by-ID, toggle-back-and-forth pattern, so a
 * Dispatch Manager can tick one off (or undo a mistaken tick) straight from
 * the Dashboard checklist. Un-resolving clears ResolvedByName/At, same
 * reasoning as CoaConfirmed's/Jobs' own clear-on-undo.
 */
function setPackingIssueStatus(issueId, status, checkerName) {
  var resolved = status === ISSUE_STATUS.RESOLVED;
  updateRowById_(getSheet_(SHEET_NAMES.PACKING_ISSUES), SHEET_HEADERS.PackingIssues, issueId, {
    Status: resolved ? ISSUE_STATUS.RESOLVED : ISSUE_STATUS.OPEN,
    ResolvedByName: resolved ? String(checkerName || '') : '',
    ResolvedAt: resolved ? nowIso_() : ''
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// TRUCK ISSUES (checker-reported truck problems)
//
// A mandatory "any truck issues?" prompt (mechanical problems, cleanliness,
// etc.) shown once at the very start of a BRAND-NEW trip - Shane's request
// (2026-09-16): "when clicking on a truck to start loading orders a window
// first comes up to report any truck issues". Once per new trip, not every
// time the truck is opened - see TruckSessions.TruckIssuesPrompted (set
// false only by createTruckSession_, i.e. only when there's genuinely no
// existing in-progress session to resume) and reportTruckIssues below, which
// is the only thing that ever flips it back to true. Also non-blocking, same
// as PackingIssues above - reported issues are a checklist for Dispatch
// Managers on the Dashboard, not a gate on dispatching.
// ---------------------------------------------------------------------------

/**
 * Records the answer to that prompt. issues is an array of short free-text
 * notes - an empty array (or all-blank entries) is exactly what "No truck
 * issues" sends: nothing gets appended to TruckIssues, but the session is
 * still marked prompted so it's never asked again this trip. Always marks
 * TruckIssuesPrompted regardless of whether any real issue text came
 * through, since the point being tracked is "was the checker asked", not
 * "did anything come of it".
 */
function reportTruckIssues(sessionId, issues, checkerId, checkerName) {
  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return s.ID === sessionId; })[0];
  if (!session) throw new Error('Truck session not found.');

  var sheet = getSheet_(SHEET_NAMES.TRUCK_ISSUES);
  var notes = (issues || []).map(function (rawNote) { return String(rawNote || '').trim(); }).filter(Boolean);
  appendObjects_(sheet, SHEET_HEADERS.TruckIssues, notes.map(function (note) {
    return {
      ID: Utilities.getUuid(), TruckSessionID: sessionId, TruckID: session.TruckID, TruckName: session.TruckName,
      Date: todayString_(), Note: note, Status: ISSUE_STATUS.OPEN,
      ReportedByID: checkerId || '', ReportedByName: checkerName || '', ReportedAt: nowIso_(),
      ResolvedByName: '', ResolvedAt: ''
    };
  }));

  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, { TruckIssuesPrompted: true });
  return { ok: true };
}

/** For History's "Truck Issues" checklist - every issue reported on the picked day, across all trucks, most recently reported first, regardless of whether it's since been resolved (a historical record of that specific day). The Admin Dashboard itself uses listOpenTruckIssues below instead - see its own comment for why. */
function listTruckIssuesForDate(dateStr) {
  var targetDate = dateStr || todayString_();
  return sheetToObjects_(getSheet_(SHEET_NAMES.TRUCK_ISSUES))
    .filter(function (t) { return normalizeDateStr_(t.Date) === targetDate; })
    // Same "Invalid Date" fix as listPackingIssuesForDate above (Shane,
    // 2026-09-28) - t.Date was normalized for the day-filter but not for
    // what actually gets sent back to the frontend.
    .map(function (t) { t.Date = normalizeDateStr_(t.Date); return t; })
    .sort(function (a, b) { return new Date(b.ReportedAt) - new Date(a.ReportedAt); });
}

/**
 * For the Admin Dashboard's "Truck Issues" checklist - EVERY still-open
 * report, regardless of which day it was made (same reasoning, and same
 * pruneOldRecords exemption for OPEN rows, as listOpenPackingIssues above -
 * Shane's 2026-09-22 request). Most recently reported first, same ordering
 * as listTruckIssuesForDate above.
 */
function listOpenTruckIssues() {
  return sheetToObjects_(getSheet_(SHEET_NAMES.TRUCK_ISSUES))
    .filter(function (t) { return t.Status === ISSUE_STATUS.OPEN; })
    // Same "Invalid Date" fix as listOpenPackingIssues above (Shane, 2026-09-28).
    .map(function (t) { t.Date = normalizeDateStr_(t.Date); return t; })
    .sort(function (a, b) { return new Date(b.ReportedAt) - new Date(a.ReportedAt); });
}

/** Marks a reported truck issue Resolved or back to Open - same toggle pattern as setPackingIssueStatus above, for the Dispatch Manager's Dashboard checklist. */
function setTruckIssueStatus(issueId, status, checkerName) {
  var resolved = status === ISSUE_STATUS.RESOLVED;
  updateRowById_(getSheet_(SHEET_NAMES.TRUCK_ISSUES), SHEET_HEADERS.TruckIssues, issueId, {
    Status: resolved ? ISSUE_STATUS.RESOLVED : ISSUE_STATUS.OPEN,
    ResolvedByName: resolved ? String(checkerName || '') : '',
    ResolvedAt: resolved ? nowIso_() : ''
  });
  return { ok: true };
}

/**
 * Works out which OrderIDs are dispatched, by cross-referencing
 * OrderChecks against TruckSessions - an order counts as dispatched if ANY
 * of its OrderChecks rows belongs to a truck session that has since been
 * marked Dispatched. Not scoped to today's OrderChecks only, since an
 * overdue order may have been allocated/dispatched on a day after its
 * delivery date.
 *
 * Keyed by orderIdKey_ (build-2026-10-30, was a bare String(...)) - traced
 * from a dispatch manager's report of an order that had genuinely
 * dispatched on a truck still showing in the Dashboard's Outstanding
 * section. buildOrderFulfillmentSummary_ below cross-references this
 * lookup against Packing & Production's OWN freshly-read OrderID string -
 * if Dispatch's own stored OrderID had silently lost a leading zero to
 * Sheets' numeric coercion (see orderIdKey_'s own comment, and
 * setupSpreadsheet's matching Plain-Text fix), a bare string comparison
 * here would silently and PERMANENTLY stop matching that order as
 * dispatched, even though it correctly shows up under its truck on the
 * Dashboard's own "Today's trucks" card (which groups by TruckSessionID
 * only, never by OrderID) - exactly that split symptom.
 */
function getDispatchedOrderIds_() {
  var sessionsById = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).forEach(function (s) { sessionsById[s.ID] = s; });

  var dispatchedOrderIds = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).forEach(function (c) {
    var session = sessionsById[c.TruckSessionID];
    if (session && session.Status === SESSION_STATUS.DISPATCHED) dispatchedOrderIds[orderIdKey_(c.OrderID)] = true;
  });
  return dispatchedOrderIds;
}

/**
 * Cross-references a list of Packing & Production orders (from
 * readTodaysOrdersFromPacking_/readOverdueOrdersFromPacking_) against
 * already-computed dispatched/collected OrderID lookups to work out which
 * are still outstanding. Takes those lookups rather than deriving them
 * itself, since getOrderFulfillmentOverview below calls this twice (today +
 * overdue) per Dashboard load - each call rebuilding TruckSessions,
 * OrderChecks and CollectedOrders from scratch would double 3 full-sheet
 * reads on every single load for identical answers both times.
 */
function buildOrderFulfillmentSummary_(orders, dispatchedOrderIds, collectedOrderIds) {
  var withStatus = orders.map(function (o) {
    var dispatched = !!dispatchedOrderIds[orderIdKey_(o.orderId)];
    var collected = !!collectedOrderIds[orderIdKey_(o.orderId)];
    return {
      orderId: o.orderId, orderNumber: o.orderNumber, customer: o.customer, deliveryDate: o.deliveryDate,
      dispatched: dispatched, collected: collected, outstanding: !dispatched && !collected
    };
  });

  // Itemized alongside each count (not just outstanding, which is all the
  // frontend used to need) so the Dashboard's "Orders due/Dispatched/
  // Collected/Outstanding" tiles can each show their own underlying order
  // list on demand instead of just a number.
  return {
    total: withStatus.length,
    all: withStatus,
    dispatchedCount: withStatus.filter(function (o) { return o.dispatched; }).length,
    dispatched: withStatus.filter(function (o) { return o.dispatched; }),
    collectedCount: withStatus.filter(function (o) { return o.collected; }).length,
    collected: withStatus.filter(function (o) { return o.collected; }),
    outstandingCount: withStatus.filter(function (o) { return o.outstanding; }).length,
    outstanding: withStatus.filter(function (o) { return o.outstanding; })
  };
}

/**
 * The Dispatch Manager's main screen: orders due on referenceDate
 * (total/dispatched/collected/outstanding, with the outstanding ones
 * listed so they can be chased or marked collected) plus a warning list of
 * orders due before referenceDate that still haven't gone out or been
 * collected. referenceDate defaults to the real current day; the Admin
 * dashboard's date picker passes in the day it's viewing so this section
 * moves together with the rest of the page instead of always meaning
 * "right now" regardless of what's selected.
 */
function getOrderFulfillmentOverview(referenceDate) {
  var date = referenceDate || todayString_();
  // Fetch the Packing & Production data ONCE and share it between the
  // "today" and "overdue" calculations - this used to be the single most
  // expensive thing a Dashboard load did, and it was doing it twice.
  var allOrders = fetchAllOrdersFromPacking_();
  // Same sharing principle as allOrders above, one level down: both summary
  // calls below need the same dispatched/collected lookups, so compute each
  // once here instead of having buildOrderFulfillmentSummary_ redo it twice.
  var dispatchedOrderIds = getDispatchedOrderIds_();
  var collectedOrderIds = getCollectedOrderIds_();
  var todaySummary = buildOrderFulfillmentSummary_(readTodaysOrdersFromPacking_(date, allOrders), dispatchedOrderIds, collectedOrderIds);
  var overdue = buildOrderFulfillmentSummary_(readOverdueOrdersFromPacking_(date, allOrders), dispatchedOrderIds, collectedOrderIds);
  return {
    date: date,
    today: todaySummary,
    // Only the still-outstanding overdue orders are a warning - "overdue
    // but dispatched/collected" isn't something anyone needs to act on.
    overdueWarnings: overdue.outstanding
  };
}

// ---------------------------------------------------------------------------
// DRIVERS ON THE ROAD (build-2026-11-10-01)
//
// Drivers sign in with the name + PIN on their Drivers-list row (see
// verifyCredentials_) and only ever see TODAY's trips they're named on -
// a trip's Driver field (set by the checker in the trip modal) holds up to
// 4 comma-separated names. From there they mark each order delivered and
// report problems at a customer or on the road. Every driver action works
// out who the driver is from the checked login (CURRENT_USER_), never from
// anything the phone sends, and refuses a trip the driver isn't on.
// ---------------------------------------------------------------------------

/** Creates the DriverLogs tab and the Drivers.PIN header if missing - no need to re-run setupSpreadsheet(). */
function ensureDriverSchema_() {
  var cache = CacheService.getScriptCache();
  var flagKey = 'driverSchemaOk_v2';
  if (cache.get(flagKey)) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logs = ss.getSheetByName(SHEET_NAMES.DRIVER_LOGS);
  if (!logs) { logs = ss.insertSheet(SHEET_NAMES.DRIVER_LOGS); logs.setFrozenRows(1); }
  ensureHeaderCells_(logs, SHEET_HEADERS.DriverLogs, SHEET_HEADERS.DriverLogs);
  var drivers = getSheet_(SHEET_NAMES.DRIVERS);
  ensureHeaderCells_(drivers, SHEET_HEADERS.Drivers, ['PIN']);
  // PINs like "0123" must stay text (same leading-zero problem as Checkers.PIN).
  drivers.getRange(1, SHEET_HEADERS.Drivers.indexOf('PIN') + 1, drivers.getMaxRows(), 1).setNumberFormat('@');
  try { cache.put(flagKey, '1', 6 * 60 * 60); } catch (e) { /* best-effort */ }
}

function driverLogs_() {
  ensureDriverSchema_();
  return sheetToObjects_(getSheet_(SHEET_NAMES.DRIVER_LOGS));
}

/** { OrderCheckID: deliveredAt ISO } for one day ('yyyy-MM-dd'), or every day on record if dateStr is null. */
// DriverLogs rows for one day ([] if the tab doesn't exist yet).
function driverLogsForDate_(dateStr) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.DRIVER_LOGS);
  if (!sheet) return [];
  return sheetToObjects_(sheet).filter(function (l) { return normalizeDateStr_(l.Date) === dateStr; });
}

// preloadedLogs (optional): DriverLogs rows already read by the caller.
function deliveredAtByOrderCheckId_(dateStr, preloadedLogs) {
  var map = {};
  var logs = preloadedLogs;
  if (!logs) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.DRIVER_LOGS);
    if (!sheet) return map;
    logs = sheetToObjects_(sheet);
  }
  logs.forEach(function (l) {
    if (l.Type !== DRIVER_LOG_TYPES.DELIVERED || !l.OrderCheckID) return;
    if (dateStr && normalizeDateStr_(l.Date) !== dateStr) return;
    map[l.OrderCheckID] = l.LoggedAt;
  });
  return map;
}

function currentDriver_() {
  if (!CURRENT_USER_ || CURRENT_USER_.role !== ROLES.DRIVER) throw new Error('Only drivers can do this.');
  return CURRENT_USER_;
}

/** True if driverName is one of the (comma-separated) names on this trip. */
function driverIsOnSession_(session, driverName) {
  var me = String(driverName || '').trim().toLowerCase();
  return String(session.Driver || '').split(',').some(function (n) { return n.trim().toLowerCase() === me; });
}

/** Today's session, if this driver is on it - throws otherwise. */
function driverSessionOrThrow_(sessionId, driver) {
  var session = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return s.ID === sessionId; })[0];
  if (!session || normalizeDateStr_(session.Date) !== todayString_() || !driverIsOnSession_(session, driver.name)) {
    throw new Error('That trip isn\'t one of yours today. Ask the checker to add you as a driver on it.');
  }
  return session;
}

/**
 * The driver's screen: every trip today with this driver on it, oldest
 * first, each with its stops (the orders on that trip, with delivered
 * time if logged) and the problems/incidents already reported on it.
 */
function getMyDriverTrips() {
  var driver = currentDriver_();
  var today = todayString_();
  var allToday = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS))
    .filter(function (s) { return normalizeDateStr_(s.Date) === today; })
    .sort(function (a, b) { return String(a.StartedAt).localeCompare(String(b.StartedAt)); });
  var tripNumber = {}, perTruck = {};
  allToday.forEach(function (s) { perTruck[s.TruckID] = (perTruck[s.TruckID] || 0) + 1; tripNumber[s.ID] = perTruck[s.TruckID]; });
  var mine = allToday.filter(function (s) { return driverIsOnSession_(s, driver.name); });
  if (mine.length === 0) return { driverName: driver.name, trips: [], categories: DRIVER_PROBLEM_CATEGORIES };

  var mineIds = {};
  mine.forEach(function (s) { mineIds[s.ID] = true; });
  var orderChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return mineIds[c.TruckSessionID]; });
  var logs = driverLogs_().filter(function (l) { return mineIds[l.TruckSessionID]; });

  // Fruit-tray stops from Zoho: shown on the driver's FIRST trip today on
  // each truck (tray clients are one run a day), via the truck's Zoho
  // vehicle (Admin > Trucks). Delivered ticks are keyed by tray stop, so
  // they show whichever of the truck's drivers ticked them.
  var trucksById = {};
  sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS)).forEach(function (t) { trucksById[t.ID] = t; });
  var trayByVehicle = trayStopsByVehicle_(today);
  var trayDelivered = trayDeliveredMap_(today);
  var trayShownForTruck = {};

  return {
    driverName: driver.name,
    categories: DRIVER_PROBLEM_CATEGORIES,
    trips: mine.map(function (s) {
      var truck = trucksById[s.TruckID];
      var trayStops = [];
      if (truck && truck.ZohoVehicleID && !trayShownForTruck[s.TruckID]) {
        trayShownForTruck[s.TruckID] = true;
        trayStops = (trayByVehicle[String(truck.ZohoVehicleID)] || []).map(function (st) {
          var d = trayDelivered[st.ID];
          return { trayStopId: st.ID, customer: st.Customer, orderNo: st.OrderNo, products: st.Products,
            deliveredAt: d ? d.at : '', deliveredBy: d ? d.by : '' };
        });
      }
      var sessionLogs = logs.filter(function (l) { return l.TruckSessionID === s.ID; });
      var delivered = {};
      sessionLogs.forEach(function (l) {
        if (l.Type === DRIVER_LOG_TYPES.DELIVERED && l.OrderCheckID) delivered[l.OrderCheckID] = { at: l.LoggedAt, by: l.DriverName };
      });
      return {
        sessionId: s.ID, truckName: s.TruckName, tripNumber: tripNumber[s.ID], status: s.Status,
        route: s.Route || '', drivers: s.Driver || '', dispatchedAt: s.DispatchedAt || '',
        trayStops: trayStops,
        stops: orderChecks.filter(function (c) { return c.TruckSessionID === s.ID; }).map(function (c) {
          return {
            orderCheckId: c.ID, orderNumber: c.OrderNumber, customer: c.Customer,
            deliveredAt: delivered[c.ID] ? delivered[c.ID].at : '', deliveredBy: delivered[c.ID] ? delivered[c.ID].by : ''
          };
        }).sort(function (a, b) { return String(a.customer).localeCompare(String(b.customer)); }),
        reports: sessionLogs.filter(function (l) { return l.Type !== DRIVER_LOG_TYPES.DELIVERED; }).map(function (l) {
          return { type: l.Type, category: l.Category, note: l.Note, orderNumber: l.OrderNumber, customer: l.Customer,
            trayStopId: l.TrayStopID || '',
            loggedAt: l.LoggedAt, by: l.DriverName, status: l.Status };
        }).sort(function (a, b) { return String(b.loggedAt).localeCompare(String(a.loggedAt)); })
      };
    })
  };
}

/**
 * Marks one stop delivered (delivered=true) or undoes it (false). Safe to
 * repeat: marking an already-delivered stop keeps the first time, undoing
 * a stop that isn't delivered does nothing.
 */
function driverMarkDelivered(orderCheckId, delivered) {
  var driver = currentDriver_();
  var check = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return c.ID === orderCheckId; })[0];
  if (!check) throw new Error('That order is no longer on the truck. Refresh and try again.');
  var session = driverSessionOrThrow_(check.TruckSessionID, driver);
  var sheet = getSheet_(SHEET_NAMES.DRIVER_LOGS);

  return withNamedLock_('driverDelivered_' + orderCheckId, function () {
    var existing = driverLogs_().filter(function (l) { return l.Type === DRIVER_LOG_TYPES.DELIVERED && l.OrderCheckID === orderCheckId; });
    if (delivered) {
      if (existing.length > 0) return { ok: true, deliveredAt: existing[0].LoggedAt };
      var at = nowIso_();
      appendObject_(sheet, SHEET_HEADERS.DriverLogs, {
        ID: Utilities.getUuid(), Date: todayString_(), TruckSessionID: session.ID, TruckName: session.TruckName,
        DriverID: driver.id, DriverName: driver.name, Type: DRIVER_LOG_TYPES.DELIVERED,
        OrderCheckID: check.ID, OrderNumber: check.OrderNumber, Customer: check.Customer,
        Category: '', Note: '', LoggedAt: at, Status: '', ResolvedByName: '', ResolvedAt: ''
      });
      return { ok: true, deliveredAt: at };
    }
    existing.forEach(function (l) { deleteRowById_(sheet, l.ID); });
    return { ok: true, deliveredAt: '' };
  });
}

/**
 * A problem at a customer (orderCheckId given) or a road/vehicle incident
 * (orderCheckId blank) on one of the driver's trips today. category must
 * be one of DRIVER_PROBLEM_CATEGORIES for that type; a note is required
 * for "Other". Raised as an Open item on the Dashboard's Driver Reports.
 */
function driverReport(sessionId, orderCheckId, category, note, trayStopId) {
  var driver = currentDriver_();
  var session = driverSessionOrThrow_(sessionId, driver);
  // A problem at a fruit-tray stop (build-2026-11-10-02) counts as a
  // customer problem, same as one at an order.
  var trayStop = trayStopId ? trayStopForSessionOrThrow_(trayStopId, session) : null;
  var type = (orderCheckId || trayStop) ? DRIVER_LOG_TYPES.CUSTOMER_PROBLEM : DRIVER_LOG_TYPES.ROAD_INCIDENT;
  category = String(category || '').trim();
  note = String(note || '').trim();
  if (DRIVER_PROBLEM_CATEGORIES[type].indexOf(category) === -1) throw new Error('Pick what happened.');
  if (category === 'Other' && !note) throw new Error('Add a short note saying what happened.');
  if (note.length > 1000) note = note.slice(0, 1000);

  var check = null;
  if (orderCheckId) {
    check = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return c.ID === orderCheckId && c.TruckSessionID === session.ID; })[0];
    if (!check) throw new Error('That order isn\'t on this trip. Refresh and try again.');
  }
  ensureDriverSchema_();
  var id = Utilities.getUuid();
  appendObject_(getSheet_(SHEET_NAMES.DRIVER_LOGS), SHEET_HEADERS.DriverLogs, {
    ID: id, Date: todayString_(), TruckSessionID: session.ID, TruckName: session.TruckName,
    DriverID: driver.id, DriverName: driver.name, Type: type,
    OrderCheckID: check ? check.ID : '',
    OrderNumber: check ? check.OrderNumber : (trayStop ? 'Fruit trays (Zoho order ' + trayStop.OrderNo + ')' : ''),
    Customer: check ? check.Customer : (trayStop ? trayStop.Customer : ''),
    Category: category, Note: note, LoggedAt: nowIso_(), Status: ISSUE_STATUS.OPEN, ResolvedByName: '', ResolvedAt: '',
    TrayStopID: trayStop ? trayStop.ID : ''
  });
  return { id: id };
}

// ---------------------------------------------------------------------------
// FRUIT TRAYS FROM ZOHO CREATOR (build-2026-11-10-02)
//
// ZohoCreator.gs (a separate file in this Apps Script project, kept out of
// the public repo) copies today's and tomorrow's fruit-tray deliveries from
// Zoho Creator's All_Fruit_Statistics report into the TrayStops tab every
// 30 minutes. Each Dispatch truck is linked to one Zoho vehicle in Admin >
// Trucks, and that link decides which tray stops show on which truck: in
// the checker's workspace, as a count on the Trucks board, and as stops in
// the driver's list.
// ---------------------------------------------------------------------------

/** Creates the TrayStops tab and the new Trucks/DriverLogs headers if missing. */
function ensureTraySchema_() {
  var cache = CacheService.getScriptCache();
  var flagKey = 'traySchemaOk_v1';
  if (cache.get(flagKey)) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stops = ss.getSheetByName(SHEET_NAMES.TRAY_STOPS);
  if (!stops) { stops = ss.insertSheet(SHEET_NAMES.TRAY_STOPS); stops.setFrozenRows(1); }
  ensureHeaderCells_(stops, SHEET_HEADERS.TrayStops, SHEET_HEADERS.TrayStops);
  ensureHeaderCells_(getSheet_(SHEET_NAMES.TRUCKS), SHEET_HEADERS.Trucks, ['ZohoVehicleID']);
  ensureDriverSchema_();
  ensureHeaderCells_(getSheet_(SHEET_NAMES.DRIVER_LOGS), SHEET_HEADERS.DriverLogs, ['TrayStopID']);
  try { cache.put(flagKey, '1', 6 * 60 * 60); } catch (e) { /* best-effort */ }
}

/** Tray stops for one day ('yyyy-MM-dd'), keyed by Zoho vehicle ID, each list sorted by customer. */
function trayStopsByVehicle_(dateStr) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.TRAY_STOPS);
  var map = {};
  if (!sheet) return map;
  sheetToObjects_(sheet).forEach(function (st) {
    if (normalizeDateStr_(st.Date) !== dateStr) return;
    var key = String(st.ZohoVehicleID || '');
    (map[key] = map[key] || []).push(st);
  });
  Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return String(a.Customer).localeCompare(String(b.Customer)); }); });
  return map;
}

/** { TrayStopID: { at, by } } for the day's tray stops marked delivered. */
function trayDeliveredMap_(dateStr, preloadedLogs) {
  var map = {};
  var logs = preloadedLogs;
  if (!logs) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.DRIVER_LOGS);
    if (!sheet) return map;
    logs = sheetToObjects_(sheet);
  }
  logs.forEach(function (l) {
    if (l.Type === DRIVER_LOG_TYPES.DELIVERED && l.TrayStopID && normalizeDateStr_(l.Date) === dateStr) {
      map[l.TrayStopID] = { at: l.LoggedAt, by: l.DriverName };
    }
  });
  return map;
}

function trayPulledInfo_() {
  try { return JSON.parse(readSettings_().TrayStopsPulled || 'null'); } catch (e) { return null; }
}

/** Checker's workspace: today's tray stops for this truck, plus product totals for loading. */
function getTrayStopsForTruck(truckId) {
  var truck = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS)).filter(function (t) { return t.ID === truckId; })[0];
  var info = trayPulledInfo_();
  if (!truck || !truck.ZohoVehicleID) return { linked: false, pulledAt: info ? info.at : '', stops: [], productTotals: [] };
  var stops = trayStopsByVehicle_(todayString_())[String(truck.ZohoVehicleID)] || [];
  var totals = {};
  stops.forEach(function (st) {
    String(st.Products || '').split(/,\s*/).forEach(function (part) {
      var m = part.match(/^(.*) x(\d+)$/);
      if (m) totals[m[1]] = (totals[m[1]] || 0) + Number(m[2]);
    });
  });
  var delivered = trayDeliveredMap_(todayString_());
  return {
    linked: true,
    zohoVehicle: stops.length ? stops[0].ZohoVehicle : '',
    pulledAt: info ? info.at : '',
    stops: stops.map(function (st) {
      return { customer: st.Customer, orderNo: st.OrderNo, products: st.Products, totalQty: st.TotalQty,
        deliveredAt: delivered[st.ID] ? delivered[st.ID].at : '' };
    }),
    productTotals: Object.keys(totals).sort().map(function (k) { return { product: k, qty: totals[k] }; })
  };
}

/** Admin > Trucks: the Zoho vehicles to pick from, and when Zoho was last read. */
function getZohoTraySettings() {
  var s = readSettings_();
  var vehicles = [];
  try { vehicles = JSON.parse(s.ZohoVehicles || '[]'); } catch (e) { vehicles = []; }
  return { vehicles: vehicles, pulled: trayPulledInfo_(), zohoFileInstalled: typeof dzPullTrayStops_ === 'function' };
}

/** "Refresh from Zoho" button (Admin > Trucks, and the checker's tray list for managers). */
function refreshTrayStops() {
  if (typeof dzPullTrayStops_ !== 'function') {
    throw new Error('The ZohoCreator file isn\'t in the Dispatch Apps Script project yet - add it first (see SETUP.md).');
  }
  return dzPullTrayStops_();
}

/** The tray stop, if it's today's and on this session's truck's Zoho vehicle - throws otherwise. */
function trayStopForSessionOrThrow_(trayStopId, session) {
  var truck = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS)).filter(function (t) { return t.ID === session.TruckID; })[0];
  var stop = (trayStopsByVehicle_(todayString_())[String((truck && truck.ZohoVehicleID) || '')] || [])
    .filter(function (st) { return st.ID === trayStopId; })[0];
  if (!truck || !truck.ZohoVehicleID || !stop) throw new Error('That tray stop isn\'t on this truck today. Tap Refresh.');
  return stop;
}

/** Driver ticks a fruit-tray stop delivered (or undoes it). Same rules as driverMarkDelivered. */
function driverMarkTrayDelivered(sessionId, trayStopId, delivered) {
  var driver = currentDriver_();
  var session = driverSessionOrThrow_(sessionId, driver);
  var stop = trayStopForSessionOrThrow_(trayStopId, session);
  ensureTraySchema_();
  var sheet = getSheet_(SHEET_NAMES.DRIVER_LOGS);
  return withNamedLock_('trayDelivered_' + trayStopId, function () {
    var existing = driverLogs_().filter(function (l) { return l.Type === DRIVER_LOG_TYPES.DELIVERED && l.TrayStopID === trayStopId; });
    if (delivered) {
      if (existing.length > 0) return { ok: true, deliveredAt: existing[0].LoggedAt };
      var at = nowIso_();
      appendObject_(sheet, SHEET_HEADERS.DriverLogs, {
        ID: Utilities.getUuid(), Date: todayString_(), TruckSessionID: session.ID, TruckName: session.TruckName,
        DriverID: driver.id, DriverName: driver.name, Type: DRIVER_LOG_TYPES.DELIVERED,
        OrderCheckID: '', OrderNumber: 'Fruit trays (Zoho order ' + stop.OrderNo + ')', Customer: stop.Customer,
        Category: '', Note: '', LoggedAt: at, Status: '', ResolvedByName: '', ResolvedAt: '', TrayStopID: stop.ID
      });
      return { ok: true, deliveredAt: at };
    }
    existing.forEach(function (l) { deleteRowById_(sheet, l.ID); });
    return { ok: true, deliveredAt: '' };
  });
}

function driverReportsWhere_(fn) {
  return driverLogs_()
    .filter(function (l) { return l.Type !== DRIVER_LOG_TYPES.DELIVERED && fn(l); })
    .map(function (l) { l.Date = normalizeDateStr_(l.Date); return l; })
    .sort(function (a, b) { return String(b.LoggedAt).localeCompare(String(a.LoggedAt)); });
}

/** Dashboard: every still-open driver report, whatever day it was raised (same rule as Truck Issues). */
function listOpenDriverReports() {
  return driverReportsWhere_(function (l) { return l.Status === ISSUE_STATUS.OPEN; });
}

/** History: every driver report raised on the picked day, resolved or not. */
function listDriverReportsForDate(dateStr) {
  var target = dateStr || todayString_();
  return driverReportsWhere_(function (l) { return normalizeDateStr_(l.Date) === target; });
}

function setDriverReportStatus(reportId, status) {
  var resolved = status === ISSUE_STATUS.RESOLVED;
  updateRowById_(getSheet_(SHEET_NAMES.DRIVER_LOGS), SHEET_HEADERS.DriverLogs, reportId, {
    Status: resolved ? ISSUE_STATUS.RESOLVED : ISSUE_STATUS.OPEN,
    ResolvedByName: resolved ? String((CURRENT_USER_ && CURRENT_USER_.name) || '') : '',
    ResolvedAt: resolved ? nowIso_() : ''
  });
  return { ok: true };
}

/**
 * Run from the Apps Script editor when the Dashboard is slow
 * (build-2026-11-10-03): logs how many rows each sheet has, how long
 * reading it takes, and how long a full getDashboardForDate(today) takes.
 * Reads only - changes nothing.
 */
function diagnoseDashboardSpeed() {
  Object.keys(SHEET_NAMES).forEach(function (k) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES[k]);
    if (!sheet) { Logger.log(SHEET_NAMES[k] + ': (no tab)'); return; }
    var t0 = Date.now();
    var rows = sheet.getDataRange().getValues().length - 1;
    Logger.log(SHEET_NAMES[k] + ': ' + rows + ' rows, read in ' + (Date.now() - t0) + ' ms');
  });
  var t1 = Date.now();
  var d = getDashboardForDate(todayString_());
  Logger.log('getDashboardForDate(today): ' + (Date.now() - t1) + ' ms for ' + d.trucks.length + ' truck trip(s), ' +
    d.summary.totalOrders + ' order(s). Paste this log back.');
}
