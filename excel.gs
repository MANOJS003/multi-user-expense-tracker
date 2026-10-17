var SHEET_NAME = "Transactions";
var AUTH_SHEET_NAME = "Auth";
var BUDGET_SHEET = "Budgets";
var GOAL_SHEET = "Goals";
var REC_SHEET = "Recurring";
var CAT_SHEET = "Categories";
var SETTINGS_SHEET = "Settings";
var MAX_EMAILS_PER_DAY = 3;

/* ---------------- helpers ---------------- */
function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
  }
  return sh;
}
function norm_(v) { return (v || "").toString().trim().toLowerCase(); }
function rowsOf_(sheet) { var v = sheet.getDataRange().getValues(); v.shift(); return v; }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function formatDateValue(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return (v || "").toString().slice(0, 10);
}
function formatMonthValue_(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM");
  }
  return (v || "").toString().slice(0, 7);
}

function sha256_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var h = (b < 0 ? b + 256 : b).toString(16);
    return h.length === 1 ? "0" + h : h;
  }).join("");
}
function isHash_(s) { return /^[a-f0-9]{64}$/.test(s); }

function authErrorMessage_(err) {
  var raw = err && err.message ? err.message : String(err);
  if (/do not have permission/i.test(raw)) {
    return "The script has not been authorized yet (" + raw + "). " +
      "Open the Apps Script editor, select authorizeAllScopes in the function dropdown, click Run, " +
      "and approve every permission Google asks for (Sheets + Mail). Then redeploy the web app " +
      "(Deploy > Manage deployments > Edit the active deployment > New version) so it runs with the newly granted scopes.";
  }
  return raw;
}

function mailErrorMessage_(err) {
  return "Email could not be sent: " + authErrorMessage_(err);
}
function toHash_(s) { return isHash_(s) ? s : sha256_(s); }

function passwordMatches_(stored, sent) {
  stored = (stored || "").toString().trim();
  sent = (sent || "").toString().trim();
  if (!stored || !sent) return false;
  return stored === sent || sha256_(stored) === sent || sha256_(sent) === stored;
}

function upsertRow_(sheet, matchFn, rowArr, textCols) {
  var rows = sheet.getDataRange().getValues();
  var rowNum = 0;
  for (var i = 1; i < rows.length; i++) {
    if (matchFn(rows[i])) { rowNum = i + 1; break; }
  }
  if (!rowNum) rowNum = sheet.getLastRow() + 1;
  (textCols || []).forEach(function (c) { sheet.getRange(rowNum, c).setNumberFormat("@"); });
  sheet.getRange(rowNum, 1, 1, rowArr.length).setValues([rowArr]);
}

function deleteWhere_(sheet, matchFn) {
  var rows = sheet.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (matchFn(rows[i])) sheet.deleteRow(i + 1);
  }
}

/* ---------------- GET ---------------- */
function doGet(e) {
  var callback = e && e.parameter && e.parameter.callback;
  try {
    return doGet_(e);
  } catch (err) {
    var message = authErrorMessage_(err);
    console.error("doGet error: " + message);
    var output = { error: true, message: message };
    if (callback) {
      return ContentService.createTextOutput(callback + "(" + JSON.stringify(output) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json_(output);
  }
}

function doGet_(e) {
  var sheet = getSheet_(SHEET_NAME, ["id", "user_email", "date", "type", "category", "amount", "description"]);
  var authSheet = getSheet_(AUTH_SHEET_NAME, ["email", "password", "created_at"]);

  var callback = e.parameter.callback;
  var action = e.parameter.action;
  var email = norm_(e.parameter.email);
  var pass = (e.parameter.password || "").toString().trim();
  var output = {};

  if (action === "test_email") {
    var testTo = norm_(e.parameter.to);
    var mySettings = {};
    rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(function (r) {
      if (norm_(r[0]) === email) mySettings[r[1]] = (r[2] === null || r[2] === undefined) ? "" : r[2].toString();
    });
    var allowedTo = [email, norm_(mySettings.rem_email_to)];
    if (!email || !testTo || allowedTo.indexOf(testTo) === -1) {
      output = { success: false, message: "Save the reminder email first, then send the test." };
    } else {
      try {
        MailApp.sendEmail({
          to: testTo,
          subject: "Expense Tracker: test email",
          htmlBody: "<p>Email reminders are working. You will get a reminder here when you have not added today's entries.</p>"
        });
        output = { success: true };
      } catch (err) {
        output = { success: false, message: mailErrorMessage_(err) };
      }
    }
    return ContentService.createTextOutput((callback || "") + "(" + JSON.stringify(output) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  if (action === "signup") {
    var authRows = authSheet.getDataRange().getValues();
    var exists = false;
    for (var k = 1; k < authRows.length; k++) {
      if (norm_(authRows[k][0]) === email) { exists = true; break; }
    }
    if (exists) {
      output = { success: false, message: "Email already registered" };
    } else if (!pass) {
      output = { success: false, message: "Password is required" };
    } else {
      authSheet.appendRow([email, toHash_(pass), new Date().toISOString()]);
      output = { success: true, message: "Account created successfully" };
    }
  }
  else if (action === "auth") {
    var rows2 = authSheet.getDataRange().getValues();
    var isValid = false;
    for (var j = 1; j < rows2.length; j++) {
      if (norm_(rows2[j][0]) === email && passwordMatches_(rows2[j][1], pass)) {
        isValid = true;
        var stored = rows2[j][1].toString().trim();
        if (!isHash_(stored)) authSheet.getRange(j + 1, 2).setValue(toHash_(pass));
        break;
      }
    }
    output = { success: isValid };
  }
  else if (action === "get") {
    var rows = sheet.getDataRange().getValues();
    var resData = [];
    for (var i = 1; i < rows.length; i++) {
      if (!rows[i][0]) continue;
      if (norm_(rows[i][1]) === email) {
        resData.push({
          id: rows[i][0],
          user_email: rows[i][1],
          date: formatDateValue(rows[i][2]),
          type: rows[i][3],
          category: rows[i][4],
          amount: rows[i][5],
          description: rows[i][6]
        });
      }
    }
    output = resData;
  }
  else if (action === "get_extras") {
    var budgets = [], goals = [], recurring = [], categories = [];
    rowsOf_(getSheet_(BUDGET_SHEET, ["email", "category", "limit", "month"])).forEach(function (r) {
      if (norm_(r[0]) === email) budgets.push({ category: r[1], limit: Number(r[2]), month: formatMonthValue_(r[3]) });
    });
    rowsOf_(getSheet_(GOAL_SHEET, ["id", "email", "name", "target", "saved", "deadline", "created", "monthly"])).forEach(function (r) {
      if (norm_(r[1]) === email) goals.push({ id: r[0], name: r[2], target: Number(r[3]), saved: Number(r[4]), deadline: formatDateValue(r[5]), created: formatDateValue(r[6]), monthly: Number(r[7] || 0) });
    });
    rowsOf_(getSheet_(REC_SHEET, ["id", "email", "type", "category", "amount", "description", "day", "last_run", "active"])).forEach(function (r) {
      if (norm_(r[1]) === email) recurring.push({ id: r[0], type: r[2], category: r[3], amount: Number(r[4]), description: r[5], day: Number(r[6]), last_run: formatMonthValue_(r[7]), active: r[8] });
    });
    rowsOf_(getSheet_(CAT_SHEET, ["email", "type", "name"])).forEach(function (r) {
      if (norm_(r[0]) === email) categories.push({ type: r[1], name: r[2] });
    });
    var settings = {};
    rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(function (r) {
      if (norm_(r[0]) === email) settings[r[1]] = (r[2] === null || r[2] === undefined) ? "" : r[2].toString();
    });
    output = { budgets: budgets, goals: goals, recurring: recurring, categories: categories, settings: settings };
  }

  if (callback) {
    return ContentService.createTextOutput(callback + "(" + JSON.stringify(output) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json_(output);
}

/* ---------------- POST ---------------- */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return handlePost_(e);
  } catch (err) {
    var message = authErrorMessage_(err);
    console.error("doPost error: " + message);
    return json_({ status: "error", message: message });
  } finally {
    lock.releaseLock();
  }
}

function handlePost_(e) {
  var sheet = getSheet_(SHEET_NAME, ["id", "user_email", "date", "type", "category", "amount", "description"]);
  var authSheet = getSheet_(AUTH_SHEET_NAME, ["email", "password", "created_at"]);

  var data = JSON.parse(e.postData.contents);
  var action = data.action;
  var email = norm_(data.email);

  if (action === "change_password") {
    var authRows = authSheet.getDataRange().getValues();
    var currPass = (data.currentPassword || "").toString().trim();
    var newPass = (data.newPassword || "").toString().trim();
    var updated = false;
    for (var i = 1; i < authRows.length; i++) {
      if (norm_(authRows[i][0]) === email && passwordMatches_(authRows[i][1], currPass) && newPass) {
        authSheet.getRange(i + 1, 2).setValue(toHash_(newPass));
        updated = true;
        break;
      }
    }
    return json_({ success: updated });
  }

  if (action === "bulk_add") {
    var newRows = (data.rows || []).map(function (r) {
      return [r.id, email, r.date, r.type, r.category, r.amount, r.description];
    });
    if (newRows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 7).setValues(newRows);
    }
    return json_({ status: "success", count: newRows.length });
  }

  if (action === "add") {
    sheet.appendRow([data.id, email, data.date, data.type, data.category, data.amount, data.description]);
    return json_({ status: "success" });
  }

  if (action === "delete") {
    var rows = sheet.getDataRange().getValues();
    for (var d = 1; d < rows.length; d++) {
      if (rows[d][0].toString() === data.id.toString() && norm_(rows[d][1]) === email) { sheet.deleteRow(d + 1); break; }
    }
    return json_({ status: "success" });
  }

  if (action === "edit") {
    var rows2 = sheet.getDataRange().getValues();
    for (var x = 1; x < rows2.length; x++) {
      if (rows2[x][0].toString() === data.id.toString() && norm_(rows2[x][1]) === email) {
        sheet.getRange(x + 1, 1, 1, 7).setValues([[data.id, email, data.date, data.type, data.category, data.amount, data.description]]);
        break;
      }
    }
    return json_({ status: "success" });
  }

  /* ----- budgets ----- */
  if (action === "set_budget") {
    var bs = getSheet_(BUDGET_SHEET, ["email", "category", "limit", "month"]);
    var budgetMonth = (data.month || "").toString();
    var match = function (r) {
      return norm_(r[0]) === email && r[1].toString() === data.category.toString() && formatMonthValue_(r[3]) === budgetMonth;
    };
    if (Number(data.limit) > 0) upsertRow_(bs, match, [email, data.category, Number(data.limit), budgetMonth], [4]);
    else deleteWhere_(bs, match);
    return json_({ status: "success" });
  }

  /* ----- savings goals ----- */
  if (action === "goal_save") {
    var gs = getSheet_(GOAL_SHEET, ["id", "email", "name", "target", "saved", "deadline", "created", "monthly"]);
    upsertRow_(gs,
      function (r) { return r[0].toString() === data.id.toString() && norm_(r[1]) === email; },
      [data.id, email, data.name, Number(data.target), Number(data.saved), data.deadline || "", data.created || "", Number(data.monthly || 0)],
      [6, 7]);
    return json_({ status: "success" });
  }
  if (action === "goal_delete") {
    deleteWhere_(getSheet_(GOAL_SHEET, ["id", "email", "name", "target", "saved", "deadline", "created"]),
      function (r) { return r[0].toString() === data.id.toString() && norm_(r[1]) === email; });
    return json_({ status: "success" });
  }

  /* ----- recurring ----- */
  if (action === "rec_save") {
    var rs = getSheet_(REC_SHEET, ["id", "email", "type", "category", "amount", "description", "day", "last_run", "active"]);
    upsertRow_(rs,
      function (r) { return r[0].toString() === data.id.toString() && norm_(r[1]) === email; },
      [data.id, email, data.type, data.category, Number(data.amount), data.description || "", Number(data.day), data.last_run || "", data.active || "yes"],
      [8]);
    return json_({ status: "success" });
  }
  if (action === "rec_delete") {
    deleteWhere_(getSheet_(REC_SHEET, ["id", "email", "type", "category", "amount", "description", "day", "last_run", "active"]),
      function (r) { return r[0].toString() === data.id.toString() && norm_(r[1]) === email; });
    return json_({ status: "success" });
  }

  /* ----- custom categories ----- */
  if (action === "cat_add") {
    var cs = getSheet_(CAT_SHEET, ["email", "type", "name"]);
    upsertRow_(cs,
      function (r) { return norm_(r[0]) === email && r[1] === data.type && norm_(r[2]) === norm_(data.name); },
      [email, data.type, data.name], []);
    return json_({ status: "success" });
  }
  if (action === "cat_delete") {
    deleteWhere_(getSheet_(CAT_SHEET, ["email", "type", "name"]),
      function (r) { return norm_(r[0]) === email && r[1] === data.type && norm_(r[2]) === norm_(data.name); });
    return json_({ status: "success" });
  }

  /* ----- settings ----- */
  if (action === "set_setting") {
    setSettingValue_(email, data.key, data.value);
    return json_({ status: "success" });
  }

  return json_({ status: "unknown_action" });
}

function reminderRecipient_(email, settings) {
  var custom = (settings.rem_email_to || "").toString().trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(custom) ? custom : email;
}

function setSettingValue_(email, key, value) {
  var ss = getSheet_(SETTINGS_SHEET, ["email", "key", "value"]);
  upsertRow_(ss,
    function (r) { return norm_(r[0]) === email && r[1].toString() === key.toString(); },
    [email, key, (value === null || value === undefined) ? "" : value.toString()],
    [3]);
}

function authorizeAllScopes() {
  var sh = getSheet_(SETTINGS_SHEET, ["email", "key", "value"]);
  sh.getDataRange().getValues();

  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(),
    subject: "Expense Tracker: authorization check",
    htmlBody: "<p>If you received this, the script is fully authorized (Sheets + Mail) and the web app + reminders will work.</p>"
  });

  ScriptApp.getProjectTriggers();
}

function setupReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "reminderTick") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("reminderTick").timeBased().everyHours(1).create();
}

function reminderTick() {
  var byUser = {};
  rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(function (r) {
    var em = norm_(r[0]);
    if (!em) return;
    if (!byUser[em]) byUser[em] = {};
    byUser[em][r[1]] = (r[2] === null || r[2] === undefined) ? "" : r[2].toString();
  });

  var datesByUser = {};
  rowsOf_(getSheet_(SHEET_NAME, ["id", "user_email", "date", "type", "category", "amount", "description"])).forEach(function (r) {
    if (!r[0]) return;
    var em = norm_(r[1]);
    if (!datesByUser[em]) datesByUser[em] = {};
    datesByUser[em][formatDateValue(r[2])] = true;
  });

  var now = new Date();
  Object.keys(byUser).forEach(function (em) {
    var s = byUser[em];
    if (s.rem_email !== "yes" || s.rem_enabled === "no") return;

    var tz = s.tz || Session.getScriptTimeZone();
    var today = Utilities.formatDate(now, tz, "yyyy-MM-dd");
    if (s.ack_date === today) return;
    if (datesByUser[em] && datesByUser[em][today]) return;

    var parts = (s.rem_time || "21:00").split(":");
    var startMin = Number(parts[0]) * 60 + Number(parts[1] || 0);
    var nowMin = Number(Utilities.formatDate(now, tz, "H")) * 60 + Number(Utilities.formatDate(now, tz, "m"));
    if (nowMin < startMin) return;

    if (s.last_email && (now - new Date(s.last_email)) < 50 * 60 * 1000) return;
    var sentToday = s.email_day === today ? Number(s.email_cnt || 0) : 0;
    if (sentToday >= MAX_EMAILS_PER_DAY) return;

    var link = (s.app_url || "").indexOf("http") === 0 ? '<p><a href="' + s.app_url + '">Open Expense Tracker</a></p>' : "";
    try {
      MailApp.sendEmail({
        to: reminderRecipient_(em, s),
        subject: "Reminder: did you add today's expenses?",
        htmlBody: "<p>Hi,</p><p>You have not added any income or expense for today yet.</p>" + link +
                  "<p>If there is nothing to add today, open the app and tap <b>All done for today</b> to stop reminders.</p>"
      });
      setSettingValue_(em, "last_email", now.toISOString());
      setSettingValue_(em, "email_day", today);
      setSettingValue_(em, "email_cnt", sentToday + 1);
    } catch (err) {
      console.error("Reminder email failed for " + em + ": " + mailErrorMessage_(err));
    }
  });
}