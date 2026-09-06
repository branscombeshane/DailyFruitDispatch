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
  REASONS: 'NoStockReasons',
  SESSIONS: 'TruckSessions',
  ORDER_CHECKS: 'OrderChecks',
  ITEM_CHECKS: 'ItemChecks',
  SETTINGS: 'Settings'
};

var SESSION_STATUS = { IN_PROGRESS: 'In Progress', DISPATCHED: 'Dispatched' };
var ORDER_STATUS = { PENDING: 'Pending', IN_PROGRESS: 'In Progress', COMPLETE: 'Complete' };
var ITEM_STATUS = { PENDING: 'Pending', PACKED: 'Packed', NO_STOCK: 'No Stock' };

var DEFAULT_NO_STOCK_REASONS = [
  'Out of stock',
  'Short-picked (partial quantity only)',
  'Quality reject',
  'Damaged in packing',
  'Wrong item packed',
  'Awaiting production/prep'
];

var SHEET_HEADERS = {
  Checkers: ['ID', 'Name', 'PIN', 'Active', 'CreatedAt'],
  // Driver and Route used to live here, fixed per truck. In practice both
  // rotate day to day (drivers aren't tied to one truck, and a truck's
  // route can change trip to trip), so both are now captured per truck
  // SESSION instead (see TruckSessions below) - the Driver/Route columns
  // here are kept only so an already-deployed sheet doesn't need a
  // destructive column removal; neither is read or written by truck-admin
  // code any more. Registration/Type are appended at the end (not
  // inserted) so existing rows in a live sheet don't shift columns.
  Trucks: ['ID', 'Name', 'Driver', 'Route', 'Active', 'CreatedAt', 'Registration', 'Type'],
  NoStockReasons: ['ID', 'Reason', 'Active', 'SortOrder'],
  // Driver, DispatchedWithWarnings, DispatchWarningsText, Route and the
  // TraySmall/Medium/Large/Other columns are appended at the end for the
  // same non-destructive-migration reason. Driver can hold up to 3 names,
  // comma-separated ("Sipho, Thabo"), rather than needing separate columns.
  // TrayCount (the old single tally) is kept as an unused legacy column,
  // superseded by the per-size TraySmall/TrayMedium/TrayLarge/TrayOther columns.
  TruckSessions: ['ID', 'Date', 'TruckID', 'TruckName', 'CheckerID', 'CheckerName', 'StartedAt', 'TrayCount', 'TrayCountUpdatedAt', 'Status', 'DispatchedAt', 'DispatchedBy', 'Driver', 'DispatchedWithWarnings', 'DispatchWarningsText', 'Route', 'TraySmall', 'TrayMedium', 'TrayLarge', 'TrayOther'],
  OrderChecks: ['ID', 'TruckSessionID', 'Date', 'OrderID', 'OrderNumber', 'Customer', 'DeliveryDate', 'Status', 'StartedAt', 'CompletedAt'],
  ItemChecks: ['ID', 'OrderCheckID', 'TruckSessionID', 'OrderID', 'ItemKey', 'ProductDescription', 'Qty', 'Unit', 'Status', 'NoStockReasonID', 'NoStockReason', 'CheckedBy', 'CheckedAt'],
  Settings: ['Key', 'Value']
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
    return handleApiRequest_(e.parameter.action, safeJsonParse_(e.parameter.params) || []);
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Daily Fruit - Dispatch')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

function doPost(e) {
  var body = safeJsonParse_(e && e.postData && e.postData.contents) || {};
  return handleApiRequest_(body.action, body.params || []);
}

function safeJsonParse_(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}

// Whitelist of functions callable from the frontend, keyed by action name.
var API_ACTIONS = {
  authenticateChecker: authenticateChecker,
  authenticateAdmin: authenticateAdmin,
  listCheckers: listCheckers,
  addChecker: addChecker,
  updateChecker: updateChecker,
  listTrucks: listTrucks,
  addTruck: addTruck,
  updateTruck: updateTruck,
  deleteTruck: deleteTruck,
  listReasons: listReasons,
  addReason: addReason,
  updateReason: updateReason,
  getAdminSettings: getAdminSettings,
  setAdminPin: setAdminPin,
  probeSpreadsheet: probeSpreadsheet,
  saveDataSourceConfig: saveDataSourceConfig,
  searchOrders: searchOrders,
  startTruckSession: startTruckSession,
  getTruckSessionState: getTruckSessionState,
  updateTrayCounts: updateTrayCounts,
  updateSessionDriver: updateSessionDriver,
  updateSessionRoute: updateSessionRoute,
  allocateOrderToTruck: allocateOrderToTruck,
  getOrderForChecking: getOrderForChecking,
  setItemStatus: setItemStatus,
  markTruckDispatched: markTruckDispatched,
  getTodaysTruckOverview: getTodaysTruckOverview,
  getTodaysDashboard: getTodaysDashboard
};

function handleApiRequest_(action, params) {
  var result;
  try {
    var fn = API_ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    result = fn.apply(null, params);
    return jsonResponse_({ success: true, result: result });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
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

  // Seed default no-stock reasons if that sheet is empty
  var reasonsSheet = ss.getSheetByName(SHEET_NAMES.REASONS);
  if (reasonsSheet.getLastRow() < 2) {
    DEFAULT_NO_STOCK_REASONS.forEach(function (reason, i) {
      reasonsSheet.appendRow([Utilities.getUuid(), reason, true, i + 1]);
    });
  }

  // Seed default settings if missing
  var settings = readSettings_();
  var defaults = { AdminPin: '1234', PackingSpreadsheetId: '' };
  Object.keys(defaults).forEach(function (key) {
    if (!(key in settings)) writeSetting_(key, defaults[key]);
  });

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

function updateRowById_(sheet, headers, id, patch) {
  var rowIndex = findRowIndexById_(sheet, id);
  if (rowIndex === -1) throw new Error('Row with ID ' + id + ' not found in ' + sheet.getName());
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

// ---------------------------------------------------------------------------
// AUTH - CHECKERS
// ---------------------------------------------------------------------------

function authenticateChecker(name, pin) {
  var checkers = sheetToObjects_(getSheet_(SHEET_NAMES.CHECKERS));
  var match = checkers.filter(function (c) {
    return String(c.Name).trim().toLowerCase() === String(name).trim().toLowerCase();
  })[0];
  if (!match) return { ok: false, error: 'Name not recognized.' };
  if (match.Active === false) return { ok: false, error: 'This checker is inactive. See an admin.' };
  if (String(match.PIN) !== String(pin).trim()) return { ok: false, error: 'Incorrect PIN.' };
  return { ok: true, checker: { id: match.ID, name: match.Name } };
}

function authenticateAdmin(pin) {
  var settings = readSettings_();
  if (String(settings.AdminPin) === String(pin).trim()) return { ok: true };
  return { ok: false, error: 'Incorrect admin PIN.' };
}

// ---------------------------------------------------------------------------
// ADMIN - CHECKERS CRUD
// ---------------------------------------------------------------------------

function listCheckers() {
  return sheetToObjects_(getSheet_(SHEET_NAMES.CHECKERS));
}

function addChecker(name, pin) {
  var sheet = getSheet_(SHEET_NAMES.CHECKERS);
  var id = Utilities.getUuid();
  appendObject_(sheet, SHEET_HEADERS.Checkers, {
    ID: id, Name: name, PIN: pin, Active: true, CreatedAt: nowIso_()
  });
  return { id: id };
}

function updateChecker(id, patch) {
  updateRowById_(getSheet_(SHEET_NAMES.CHECKERS), SHEET_HEADERS.Checkers, id, patch);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ADMIN - TRUCKS CRUD
// ---------------------------------------------------------------------------

function listTrucks(activeOnly) {
  var trucks = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS));
  if (activeOnly) trucks = trucks.filter(function (t) { return t.Active === true; });
  return trucks;
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
  updateRowById_(getSheet_(SHEET_NAMES.TRUCKS), SHEET_HEADERS.Trucks, id, patch);
  return { ok: true };
}

function deleteTruck(id) {
  deleteRowById_(getSheet_(SHEET_NAMES.TRUCKS), id);
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

// ---------------------------------------------------------------------------
// ADMIN - NO-STOCK REASONS CRUD
// ---------------------------------------------------------------------------

function listReasons(activeOnly) {
  var reasons = sheetToObjects_(getSheet_(SHEET_NAMES.REASONS));
  if (activeOnly) reasons = reasons.filter(function (r) { return r.Active === true; });
  reasons.sort(function (a, b) { return (a.SortOrder || 0) - (b.SortOrder || 0); });
  return reasons;
}

function addReason(text) {
  var sheet = getSheet_(SHEET_NAMES.REASONS);
  var existing = sheetToObjects_(sheet);
  var id = Utilities.getUuid();
  var maxOrder = existing.reduce(function (m, r) { return Math.max(m, r.SortOrder || 0); }, 0);
  appendObject_(sheet, SHEET_HEADERS.NoStockReasons, { ID: id, Reason: text, Active: true, SortOrder: maxOrder + 1 });
  return { id: id };
}

function updateReason(id, patch) {
  updateRowById_(getSheet_(SHEET_NAMES.REASONS), SHEET_HEADERS.NoStockReasons, id, patch);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ADMIN - SETTINGS / ADMIN PIN
// ---------------------------------------------------------------------------

function getAdminSettings() {
  var s = readSettings_();
  return {
    packingSpreadsheetId: s.PackingSpreadsheetId || ''
  };
}

function setAdminPin(newPin) {
  writeSetting_('AdminPin', String(newPin).trim());
  return { ok: true };
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
  writeSetting_('PackingSpreadsheetId', id);
  return { ok: true };
}

/** Finds a required column by exact header name; throws a clear error if the sheet's layout has changed. */
function requiredColIndex_(headers, tabName, columnName) {
  var idx = headers.indexOf(columnName);
  if (idx === -1) throw new Error('Expected column "' + columnName + '" not found in the "' + tabName + '" tab. Found columns: ' + headers.join(', '));
  return idx;
}

/**
 * Reads today's orders by joining the Orders and OrderItems tabs on OrderID.
 * Orders are filtered to DeliveryDate === today, matching the assumption
 * that dispatch happens on the delivery day. Order "number" shown to
 * checkers is SageRef (the human-readable invoice ref), falling back to the
 * internal OrderID if that's blank.
 */
function readTodaysOrdersFromPacking_() {
  var s = readSettings_();
  if (!s.PackingSpreadsheetId) throw new Error('Data source not configured yet. Go to Admin > Data Source.');
  var ss = SpreadsheetApp.openById(s.PackingSpreadsheetId);

  var ordersSheet = ss.getSheetByName(ORDERS_TAB_NAME);
  if (!ordersSheet) throw new Error('Tab "' + ORDERS_TAB_NAME + '" not found in the Packing & Production sheet.');
  var itemsSheet = ss.getSheetByName(ORDER_ITEMS_TAB_NAME);
  if (!itemsSheet) throw new Error('Tab "' + ORDER_ITEMS_TAB_NAME + '" not found in the Packing & Production sheet.');

  var today = todayString_();

  // --- Orders tab: order header info, filtered to today's deliveries ---
  var orderValues = ordersSheet.getDataRange().getValues();
  var oHeaders = orderValues[0];
  var oCol = {
    orderId: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.orderId),
    sageRef: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.sageRef),
    customer: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.customer),
    deliveryDate: requiredColIndex_(oHeaders, ORDERS_TAB_NAME, ORDERS_COLUMNS.deliveryDate)
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

    if (deliveryDateStr && deliveryDateStr !== today) continue; // only today's deliveries

    var sageRef = String(row[oCol.sageRef] || '').trim();
    ordersById[orderId] = {
      orderId: orderId,
      orderNumber: sageRef || orderId,
      customer: row[oCol.customer],
      deliveryDate: deliveryDateStr,
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
    unit: requiredColIndex_(iHeaders, ORDER_ITEMS_TAB_NAME, ORDER_ITEMS_COLUMNS.unit)
  };

  for (var j = 1; j < itemValues.length; j++) {
    var irow = itemValues[j];
    if (irow.every(function (c) { return c === '' || c === null; })) continue;

    var itemOrderId = String(irow[iCol.orderId]).trim();
    var order = ordersById[itemOrderId];
    if (!order) continue; // not one of today's orders (or an order that didn't match the delivery-date filter)

    order.items.push({
      itemKey: itemOrderId + '_' + order.items.length,
      description: irow[iCol.description],
      qty: irow[iCol.qty],
      unit: irow[iCol.unit],
      department: irow[iCol.department]
    });
  }

  return Object.keys(ordersById).map(function (id) { return ordersById[id]; });
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
      checkedOnOtherTruck: allocatedToOtherTruck ? getTruckNameForSession_(existingCheck.TruckSessionID) : null
    };
  });
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

/** Starts a new truck session for today, or resumes today's existing one for that truck. */
function startTruckSession(truckId, checkerId, checkerName) {
  var sheet = getSheet_(SHEET_NAMES.SESSIONS);
  var sessions = sheetToObjects_(sheet);
  var today = todayString_();
  var existing = sessions.filter(function (s) { return s.TruckID === truckId && normalizeDateStr_(s.Date) === today; })[0];
  if (existing) return getTruckSessionState(existing.ID);

  var trucks = sheetToObjects_(getSheet_(SHEET_NAMES.TRUCKS));
  var truck = trucks.filter(function (t) { return t.ID === truckId; })[0];
  if (!truck) throw new Error('Truck not found.');

  var id = Utilities.getUuid();
  appendObject_(sheet, SHEET_HEADERS.TruckSessions, {
    ID: id, Date: today, TruckID: truckId, TruckName: truck.Name, CheckerID: checkerId,
    CheckerName: checkerName, StartedAt: nowIso_(), TrayCount: '', TrayCountUpdatedAt: '',
    Status: SESSION_STATUS.IN_PROGRESS, DispatchedAt: '', DispatchedBy: '', Driver: '', Route: '',
    TraySmall: '', TrayMedium: '', TrayLarge: '', TrayOther: ''
  });
  return getTruckSessionState(id);
}

/** Sets/updates the driver for today's truck session - captured by the checker when loading the truck, since drivers aren't fixed to a particular truck. */
/**
 * Sets/updates the driver(s) for today's truck session - a truck can carry
 * up to 3 drivers on a given trip. Accepts an array of names and stores
 * them joined into the single Driver column ("Sipho, Thabo") so the sheet
 * schema doesn't need to change - keeps the value easy to read directly in
 * the spreadsheet too. Also accepts a plain string for backward
 * compatibility with any existing caller.
 */
function updateSessionDriver(sessionId, driverNames) {
  var names = (Array.isArray(driverNames) ? driverNames : [driverNames])
    .map(function (n) { return String(n || '').trim(); })
    .filter(Boolean)
    .slice(0, 3);
  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
    Driver: names.join(', ')
  });
  return { ok: true };
}

/** Sets/updates the route for today's truck session - captured by the checker when loading the truck, since a truck's route can change trip to trip. */
function updateSessionRoute(sessionId, route) {
  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
    Route: route
  });
  return { ok: true };
}

function getTruckSessionState(sessionId) {
  var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS));
  var session = sessions.filter(function (s) { return s.ID === sessionId; })[0];
  if (!session) throw new Error('Session not found.');

  var orderChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS))
    .filter(function (c) { return c.TruckSessionID === sessionId; });

  return {
    session: session,
    orderChecks: orderChecks
  };
}

/**
 * Updates the fruit tray tally for today's truck session, split by size
 * since trays come in Small/Medium/Large, plus an Other catch-all. Replaces the old single TrayCount
 * total - that column is kept as unused legacy for the same
 * non-destructive-migration reason used elsewhere.
 */
function updateTrayCounts(sessionId, small, medium, large, other) {
  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
    TraySmall: small, TrayMedium: medium, TrayLarge: large, TrayOther: other, TrayCountUpdatedAt: nowIso_()
  });
  return { ok: true };
}

/**
 * Explicitly allocates an order to a truck - the ONLY place that creates the
 * OrderCheck + ItemChecks rows (a snapshot of the order's items at
 * allocation time). This is a deliberate step the checker takes before
 * checking items, separate from just opening/viewing the order. Wrapped in
 * a script lock so two near-simultaneous calls (a double-tap, or a slow
 * request retried) can't create duplicate rows for the same order - it's
 * safe to call again on an order that's already allocated (no-op).
 */
function allocateOrderToTruck(sessionId, orderId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
    var today = todayString_();
    var existingChecks = sheetToObjects_(orderChecksSheet);
    // String(...) on both sides: OrderID round-trips through this sheet as a
    // raw cell value, and Sheets silently stores a numeric-looking value
    // (e.g. an OrderID that's just digits) as a real Number once it's been
    // appended - a bare === against the always-string orderId param would
    // then never match, even for the row this exact call just wrote.
    var existing = existingChecks.filter(function (c) { return String(c.OrderID) === String(orderId) && normalizeDateStr_(c.Date) === today; })[0];
    if (existing) return { ok: true, alreadyAllocated: true };

    var orders = readTodaysOrdersFromPacking_();
    var order = orders.filter(function (o) { return o.orderId === orderId; })[0];
    if (!order) throw new Error('Order not found in today\'s Packing & Production data.');

    var orderCheckId = Utilities.getUuid();
    appendObject_(orderChecksSheet, SHEET_HEADERS.OrderChecks, {
      ID: orderCheckId, TruckSessionID: sessionId, Date: today, OrderID: order.orderId,
      OrderNumber: order.orderNumber, Customer: order.customer, DeliveryDate: order.deliveryDate,
      Status: ORDER_STATUS.PENDING, StartedAt: nowIso_(), CompletedAt: ''
    });

    var itemChecksSheet = getSheet_(SHEET_NAMES.ITEM_CHECKS);
    order.items.forEach(function (item) {
      appendObject_(itemChecksSheet, SHEET_HEADERS.ItemChecks, {
        ID: Utilities.getUuid(), OrderCheckID: orderCheckId, TruckSessionID: sessionId, OrderID: order.orderId,
        ItemKey: item.itemKey, ProductDescription: item.description, Qty: item.qty, Unit: item.unit,
        Status: ITEM_STATUS.PENDING, NoStockReasonID: '', NoStockReason: '', CheckedBy: '', CheckedAt: ''
      });
    });

    return { ok: true, alreadyAllocated: false };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads an order's checking state. Does NOT create anything - if the order
 * hasn't been allocated to a truck yet (see allocateOrderToTruck above),
 * returns { allocated: false, orderSummary } so the UI can show an
 * "Allocate to This Truck" step before any items can be checked.
 */
function getOrderForChecking(sessionId, orderId) {
  var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
  var today = todayString_();
  var existingChecks = sheetToObjects_(orderChecksSheet);
  // See the matching comment in allocateOrderToTruck - OrderID can come back
  // from the sheet as a Number even though orderId here is always a string.
  var orderCheck = existingChecks.filter(function (c) { return String(c.OrderID) === String(orderId) && normalizeDateStr_(c.Date) === today; })[0];

  if (!orderCheck) {
    var orders = readTodaysOrdersFromPacking_();
    var order = orders.filter(function (o) { return o.orderId === orderId; })[0];
    if (!order) throw new Error('Order not found in today\'s Packing & Production data.');
    return {
      allocated: false,
      orderSummary: { orderId: order.orderId, orderNumber: order.orderNumber, customer: order.customer, itemCount: order.items.length },
      orderCheck: null, items: [], warning: null
    };
  }

  var warning = orderCheck.TruckSessionID !== sessionId
    ? 'This order was already allocated to truck "' + getTruckNameForSession_(orderCheck.TruckSessionID) + '".'
    : null;

  var items = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS))
    .filter(function (i) { return i.OrderCheckID === orderCheck.ID; });

  return { allocated: true, orderSummary: null, orderCheck: orderCheck, items: items, warning: warning };
}

function setItemStatus(itemCheckId, status, noStockReasonId, checkerName) {
  // Locked because this reads all sibling items to recompute the parent
  // order's status, then writes it back - two items marked in quick
  // succession (fast taps, or a retried request) could otherwise race and
  // one recompute could overwrite the other with a stale status.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var itemSheet = getSheet_(SHEET_NAMES.ITEM_CHECKS);
    var reasonText = '';
    if (status === ITEM_STATUS.NO_STOCK) {
      var reasons = sheetToObjects_(getSheet_(SHEET_NAMES.REASONS));
      var reason = reasons.filter(function (r) { return r.ID === noStockReasonId; })[0];
      reasonText = reason ? reason.Reason : '';
    }
    updateRowById_(itemSheet, SHEET_HEADERS.ItemChecks, itemCheckId, {
      Status: status, NoStockReasonID: status === ITEM_STATUS.NO_STOCK ? noStockReasonId : '',
      NoStockReason: reasonText, CheckedBy: checkerName, CheckedAt: nowIso_()
    });

    // Recompute the parent order's status
    var items = sheetToObjects_(itemSheet);
    var itemRow = items.filter(function (i) { return i.ID === itemCheckId; })[0];
    var siblingItems = items.filter(function (i) { return i.OrderCheckID === itemRow.OrderCheckID; });
    var allResolved = siblingItems.every(function (i) { return i.Status !== ITEM_STATUS.PENDING; });
    var anyResolved = siblingItems.some(function (i) { return i.Status !== ITEM_STATUS.PENDING; });
    var newOrderStatus = allResolved ? ORDER_STATUS.COMPLETE : (anyResolved ? ORDER_STATUS.IN_PROGRESS : ORDER_STATUS.PENDING);

    var orderChecksSheet = getSheet_(SHEET_NAMES.ORDER_CHECKS);
    updateRowById_(orderChecksSheet, SHEET_HEADERS.OrderChecks, itemRow.OrderCheckID, {
      Status: newOrderStatus,
      CompletedAt: newOrderStatus === ORDER_STATUS.COMPLETE ? nowIso_() : ''
    });

    return { ok: true, orderStatus: newOrderStatus };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Marks a truck as dispatched. Returns warnings (tray count not entered,
 * orders still pending) without dispatching unless force=true, so the UI
 * can show a confirmation first.
 */
function markTruckDispatched(sessionId, checkerName, force) {
  var state = getTruckSessionState(sessionId);
  var warnings = [];
  if (!state.session.Driver) warnings.push('Driver name has not been entered.');
  if (!state.session.Route) warnings.push('Route has not been entered.');
  var noTraysEntered = ['TraySmall', 'TrayMedium', 'TrayLarge', 'TrayOther'].every(function (key) {
    return state.session[key] === '' || state.session[key] === undefined || state.session[key] === null;
  });
  if (noTraysEntered) warnings.push('Fruit tray counts have not been entered.');
  var incomplete = state.orderChecks.filter(function (c) { return c.Status !== ORDER_STATUS.COMPLETE; });
  if (incomplete.length > 0) warnings.push(incomplete.length + ' order(s) on this truck are not fully checked.');

  if (warnings.length > 0 && !force) {
    return { ok: false, warnings: warnings };
  }

  updateRowById_(getSheet_(SHEET_NAMES.SESSIONS), SHEET_HEADERS.TruckSessions, sessionId, {
    Status: SESSION_STATUS.DISPATCHED, DispatchedAt: nowIso_(), DispatchedBy: checkerName,
    DispatchedWithWarnings: warnings.length > 0, DispatchWarningsText: warnings.join('; ')
  });
  return { ok: true };
}

/** Read-only overview of today's truck sessions, for Admin. */
function getTodaysTruckOverview() {
  var today = todayString_();
  return sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return normalizeDateStr_(s.Date) === today; });
}

/**
 * Full admin dashboard for today: every truck session, the orders checked
 * under it (with packed/no-stock breakdowns), and a summary row with
 * quality signals - most importantly trucks that got dispatched despite
 * open warnings (incomplete orders, missing driver/tray count), since
 * that's the clearest "something was rushed" signal available.
 */
function getTodaysDashboard() {
  var today = todayString_();
  var sessions = sheetToObjects_(getSheet_(SHEET_NAMES.SESSIONS)).filter(function (s) { return normalizeDateStr_(s.Date) === today; });
  var allOrderChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ORDER_CHECKS)).filter(function (c) { return normalizeDateStr_(c.Date) === today; });
  var allItemChecks = sheetToObjects_(getSheet_(SHEET_NAMES.ITEM_CHECKS));

  var trucks = sessions.map(function (session) {
    var orderChecks = allOrderChecks.filter(function (c) { return c.TruckSessionID === session.ID; });

    var orders = orderChecks.map(function (oc) {
      var items = allItemChecks.filter(function (i) { return i.OrderCheckID === oc.ID; });
      var noStockItems = items.filter(function (i) { return i.Status === ITEM_STATUS.NO_STOCK; });
      return {
        orderNumber: oc.OrderNumber,
        customer: oc.Customer,
        status: oc.Status,
        itemCount: items.length,
        packedCount: items.filter(function (i) { return i.Status === ITEM_STATUS.PACKED; }).length,
        noStockCount: noStockItems.length,
        noStockDetails: noStockItems.map(function (i) { return { description: i.ProductDescription, reason: i.NoStockReason }; })
      };
    });

    var durationMinutes = null;
    if (session.Status === SESSION_STATUS.DISPATCHED && session.StartedAt && session.DispatchedAt) {
      durationMinutes = Math.round((new Date(session.DispatchedAt) - new Date(session.StartedAt)) / 60000);
    }

    return {
      truckName: session.TruckName,
      checkerName: session.CheckerName,
      driver: session.Driver || '',
      route: session.Route || '',
      status: session.Status,
      startedAt: session.StartedAt,
      dispatchedAt: session.DispatchedAt || '',
      dispatchedBy: session.DispatchedBy || '',
      traySmall: session.TraySmall,
      trayMedium: session.TrayMedium,
      trayLarge: session.TrayLarge,
      trayOther: session.TrayOther,
      durationMinutes: durationMinutes,
      dispatchedWithWarnings: session.DispatchedWithWarnings === true,
      dispatchWarningsText: session.DispatchWarningsText || '',
      orderCount: orders.length,
      noStockTotal: orders.reduce(function (sum, o) { return sum + o.noStockCount; }, 0),
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
    forcedDispatchCount: trucks.filter(function (t) { return t.dispatchedWithWarnings; }).length
  };

  return { summary: summary, trucks: trucks };
}
