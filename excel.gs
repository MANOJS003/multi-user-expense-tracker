var SHEET_NAME = "Transactions";
var AUTH_SHEET_NAME = "Auth";
var BUDGET_SHEET = "Budgets";
var GOAL_SHEET = "Goals";
var REC_SHEET = "Recurring";
var CAT_SHEET = "Categories";
var SETTINGS_SHEET = "Settings";
var MAX_EMAILS_PER_DAY = 3;
var ACT_SHEET = "Activities";
var HABIT_SHEET = "Habits";
var TOKEN_TTL_MS = 14 * 24 * 3600 * 1000;
var ACT_HEADERS = [
  "id",
  "email",
  "date",
  "kind",
  "category",
  "type",
  "title",
  "value",
  "unit",
  "duration",
  "done",
  "ref",
  "meta",
  "notes",
  "created_at",
];
var ACT_TEXT_COLS = [1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15];
var HABIT_HEADERS = [
  "id",
  "email",
  "name",
  "icon",
  "color",
  "mode",
  "target",
  "per_week",
  "active",
  "created",
];
var HABIT_TEXT_COLS = [1, 2, 3, 4, 5, 6, 9, 10];

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
function norm_(v) {
  return (v || "").toString().trim().toLowerCase();
}
function rowsOf_(sheet) {
  var v = sheet.getDataRange().getValues();
  v.shift();
  return v;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

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
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    str,
    Utilities.Charset.UTF_8,
  );
  return bytes
    .map(function (b) {
      var h = (b < 0 ? b + 256 : b).toString(16);
      return h.length === 1 ? "0" + h : h;
    })
    .join("");
}
function isHash_(s) {
  return /^[a-f0-9]{64}$/.test(s);
}

function authErrorMessage_(err) {
  var raw = err && err.message ? err.message : String(err);
  if (/do not have permission/i.test(raw)) {
    return (
      "The script has not been authorized yet (" +
      raw +
      "). " +
      "Open the Apps Script editor, select authorizeAllScopes in the function dropdown, click Run, " +
      "and approve every permission Google asks for (Sheets + Mail). Then redeploy the web app " +
      "(Deploy > Manage deployments > Edit the active deployment > New version) so it runs with the newly granted scopes."
    );
  }
  return raw;
}

function mailErrorMessage_(err) {
  return "Email could not be sent: " + authErrorMessage_(err);
}
function toHash_(s) {
  return isHash_(s) ? s : sha256_(s);
}

function passwordMatches_(stored, sent) {
  stored = (stored || "").toString().trim();
  sent = (sent || "").toString().trim();
  if (!stored || !sent) return false;
  return (
    stored === sent || sha256_(stored) === sent || sha256_(sent) === stored
  );
}

function upsertRow_(sheet, matchFn, rowArr, textCols) {
  var rows = sheet.getDataRange().getValues();
  var rowNum = 0;
  for (var i = 1; i < rows.length; i++) {
    if (matchFn(rows[i])) {
      rowNum = i + 1;
      break;
    }
  }
  if (!rowNum) rowNum = sheet.getLastRow() + 1;
  (textCols || []).forEach(function (c) {
    sheet.getRange(rowNum, c).setNumberFormat("@");
  });
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
  var callback = safeCallback_(e && e.parameter && e.parameter.callback);
  try {
    return doGet_(e);
  } catch (err) {
    var message = authErrorMessage_(err);
    console.error("doGet error: " + message);
    var output = { error: true, message: message };
    if (callback) {
      return ContentService.createTextOutput(
        callback + "(" + JSON.stringify(output) + ")",
      ).setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json_(output);
  }
}

function doGet_(e) {
  var sheet = getSheet_(SHEET_NAME, [
    "id",
    "user_email",
    "date",
    "type",
    "category",
    "amount",
    "description",
  ]);
  var authSheet = getSheet_(AUTH_SHEET_NAME, [
    "email",
    "password",
    "created_at",
  ]);

  var callback = safeCallback_(e.parameter.callback);
  var action = e.parameter.action;
  var email = norm_(e.parameter.email);
  var pass = (e.parameter.password || "").toString().trim();
  var output = {};

  /* ---- session gate: every action except signup/auth needs a valid signed token ---- */
  if (action === "auth" && isLocked_(email)) {
    return jsonpOut_(callback, {
      success: false,
      locked: true,
      message: "Too many failed attempts. Try again in 15 minutes.",
    });
  }
  if (action !== "signup" && action !== "auth") {
    var who = verifyToken_(e.parameter.token);
    if (!who || who !== email) {
      return jsonpOut_(callback, {
        error: true,
        code: "AUTH",
        message: "Your session has expired. Please sign in again.",
      });
    }
  }

  if (action === "test_email") {
    var testTo = norm_(e.parameter.to);
    var mySettings = {};
    rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(
      function (r) {
        if (norm_(r[0]) === email)
          mySettings[r[1]] =
            r[2] === null || r[2] === undefined ? "" : r[2].toString();
      },
    );
    var allowedTo = [email, norm_(mySettings.rem_email_to)];
    if (!email || !testTo || allowedTo.indexOf(testTo) === -1) {
      output = {
        success: false,
        message: "Save the reminder email first, then send the test.",
      };
    } else {
      try {
        MailApp.sendEmail({
          to: testTo,
          subject: "Expense Tracker: test email",
          htmlBody:
            "<p>Email reminders are working. You will get a reminder here when you have not added today's entries.</p>",
        });
        output = { success: true };
      } catch (err) {
        output = { success: false, message: mailErrorMessage_(err) };
      }
    }
    return ContentService.createTextOutput(
      (callback || "") + "(" + JSON.stringify(output) + ")",
    ).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  if (action === "signup") {
    var authRows = authSheet.getDataRange().getValues();
    var exists = false;
    for (var k = 1; k < authRows.length; k++) {
      if (norm_(authRows[k][0]) === email) {
        exists = true;
        break;
      }
    }
    if (exists) {
      output = { success: false, message: "Email already registered" };
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      output = { success: false, message: "Enter a valid email address" };
    } else if (!pass) {
      output = { success: false, message: "Password is required" };
    } else {
      authSheet.appendRow([email, toHash_(pass), new Date().toISOString()]);
      output = {
        success: true,
        message: "Account created successfully",
        token: makeToken_(email),
      };
    }
  } else if (action === "auth") {
    var rows2 = authSheet.getDataRange().getValues();
    var isValid = false;
    for (var j = 1; j < rows2.length; j++) {
      if (norm_(rows2[j][0]) === email && passwordMatches_(rows2[j][1], pass)) {
        isValid = true;
        var stored = rows2[j][1].toString().trim();
        if (!isHash_(stored))
          authSheet.getRange(j + 1, 2).setValue(toHash_(pass));
        break;
      }
    }
    if (isValid) {
      clearFails_(email);
      output = { success: true, token: makeToken_(email) };
    } else {
      noteFail_(email);
      output = { success: false };
    }
  } else if (action === "get") {
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
          description: rows[i][6],
        });
      }
    }
    output = resData;
  } else if (action === "get_life") {
    output = {
      activities: actsFor_(email),
      habits: habitsFor_(email),
      today: Utilities.formatDate(
        new Date(),
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      ),
    };
  } else if (action === "get_extras") {
    var budgets = [],
      goals = [],
      recurring = [],
      categories = [];
    rowsOf_(
      getSheet_(BUDGET_SHEET, ["email", "category", "limit", "month"]),
    ).forEach(function (r) {
      if (norm_(r[0]) === email)
        budgets.push({
          category: r[1],
          limit: Number(r[2]),
          month: formatMonthValue_(r[3]),
        });
    });
    rowsOf_(
      getSheet_(GOAL_SHEET, [
        "id",
        "email",
        "name",
        "target",
        "saved",
        "deadline",
        "created",
        "monthly",
      ]),
    ).forEach(function (r) {
      if (norm_(r[1]) === email)
        goals.push({
          id: r[0],
          name: r[2],
          target: Number(r[3]),
          saved: Number(r[4]),
          deadline: formatDateValue(r[5]),
          created: formatDateValue(r[6]),
          monthly: Number(r[7] || 0),
        });
    });
    rowsOf_(
      getSheet_(REC_SHEET, [
        "id",
        "email",
        "type",
        "category",
        "amount",
        "description",
        "day",
        "last_run",
        "active",
      ]),
    ).forEach(function (r) {
      if (norm_(r[1]) === email)
        recurring.push({
          id: r[0],
          type: r[2],
          category: r[3],
          amount: Number(r[4]),
          description: r[5],
          day: Number(r[6]),
          last_run: formatMonthValue_(r[7]),
          active: r[8],
        });
    });
    rowsOf_(getSheet_(CAT_SHEET, ["email", "type", "name"])).forEach(
      function (r) {
        if (norm_(r[0]) === email) categories.push({ type: r[1], name: r[2] });
      },
    );
    var settings = {};
    rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(
      function (r) {
        if (norm_(r[0]) === email)
          settings[r[1]] =
            r[2] === null || r[2] === undefined ? "" : r[2].toString();
      },
    );
    output = {
      budgets: budgets,
      goals: goals,
      recurring: recurring,
      categories: categories,
      settings: settings,
    };
  }

  if (callback) {
    return ContentService.createTextOutput(
      callback + "(" + JSON.stringify(output) + ")",
    ).setMimeType(ContentService.MimeType.JAVASCRIPT);
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
  var sheet = getSheet_(SHEET_NAME, [
    "id",
    "user_email",
    "date",
    "type",
    "category",
    "amount",
    "description",
  ]);
  var authSheet = getSheet_(AUTH_SHEET_NAME, [
    "email",
    "password",
    "created_at",
  ]);

  var data = JSON.parse(e.postData.contents);
  var action = data.action;
  var email = norm_(data.email);
  var who = verifyToken_(data.token);
  if (!who || who !== email) {
    return json_({
      status: "error",
      code: "AUTH",
      message: "Your session has expired. Please sign in again.",
    });
  }

  if (action === "change_password") {
    var authRows = authSheet.getDataRange().getValues();
    var currPass = (data.currentPassword || "").toString().trim();
    var newPass = (data.newPassword || "").toString().trim();
    var updated = false;
    for (var i = 1; i < authRows.length; i++) {
      if (
        norm_(authRows[i][0]) === email &&
        passwordMatches_(authRows[i][1], currPass) &&
        newPass
      ) {
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
      sheet
        .getRange(sheet.getLastRow() + 1, 1, newRows.length, 7)
        .setValues(newRows);
    }
    return json_({ status: "success", count: newRows.length });
  }

  if (action === "add") {
    sheet.appendRow([
      data.id,
      email,
      data.date,
      data.type,
      data.category,
      data.amount,
      data.description,
    ]);
    return json_({ status: "success" });
  }

  if (action === "delete") {
    var rows = sheet.getDataRange().getValues();
    for (var d = 1; d < rows.length; d++) {
      if (
        rows[d][0].toString() === data.id.toString() &&
        norm_(rows[d][1]) === email
      ) {
        sheet.deleteRow(d + 1);
        break;
      }
    }
    return json_({ status: "success" });
  }

  if (action === "edit") {
    var rows2 = sheet.getDataRange().getValues();
    for (var x = 1; x < rows2.length; x++) {
      if (
        rows2[x][0].toString() === data.id.toString() &&
        norm_(rows2[x][1]) === email
      ) {
        sheet
          .getRange(x + 1, 1, 1, 7)
          .setValues([
            [
              data.id,
              email,
              data.date,
              data.type,
              data.category,
              data.amount,
              data.description,
            ],
          ]);
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
      return (
        norm_(r[0]) === email &&
        r[1].toString() === data.category.toString() &&
        formatMonthValue_(r[3]) === budgetMonth
      );
    };
    if (Number(data.limit) > 0)
      upsertRow_(
        bs,
        match,
        [email, data.category, Number(data.limit), budgetMonth],
        [4],
      );
    else deleteWhere_(bs, match);
    return json_({ status: "success" });
  }

  /* ----- savings goals ----- */
  if (action === "goal_save") {
    var gs = getSheet_(GOAL_SHEET, [
      "id",
      "email",
      "name",
      "target",
      "saved",
      "deadline",
      "created",
      "monthly",
    ]);
    upsertRow_(
      gs,
      function (r) {
        return r[0].toString() === data.id.toString() && norm_(r[1]) === email;
      },
      [
        data.id,
        email,
        data.name,
        Number(data.target),
        Number(data.saved),
        data.deadline || "",
        data.created || "",
        Number(data.monthly || 0),
      ],
      [6, 7],
    );
    return json_({ status: "success" });
  }
  if (action === "goal_delete") {
    deleteWhere_(
      getSheet_(GOAL_SHEET, [
        "id",
        "email",
        "name",
        "target",
        "saved",
        "deadline",
        "created",
      ]),
      function (r) {
        return r[0].toString() === data.id.toString() && norm_(r[1]) === email;
      },
    );
    return json_({ status: "success" });
  }

  /* ----- recurring ----- */
  if (action === "rec_save") {
    var rs = getSheet_(REC_SHEET, [
      "id",
      "email",
      "type",
      "category",
      "amount",
      "description",
      "day",
      "last_run",
      "active",
    ]);
    upsertRow_(
      rs,
      function (r) {
        return r[0].toString() === data.id.toString() && norm_(r[1]) === email;
      },
      [
        data.id,
        email,
        data.type,
        data.category,
        Number(data.amount),
        data.description || "",
        Number(data.day),
        data.last_run || "",
        data.active || "yes",
      ],
      [8],
    );
    return json_({ status: "success" });
  }
  if (action === "rec_delete") {
    deleteWhere_(
      getSheet_(REC_SHEET, [
        "id",
        "email",
        "type",
        "category",
        "amount",
        "description",
        "day",
        "last_run",
        "active",
      ]),
      function (r) {
        return r[0].toString() === data.id.toString() && norm_(r[1]) === email;
      },
    );
    return json_({ status: "success" });
  }

  /* ----- custom categories ----- */
  if (action === "cat_add") {
    var cs = getSheet_(CAT_SHEET, ["email", "type", "name"]);
    upsertRow_(
      cs,
      function (r) {
        return (
          norm_(r[0]) === email &&
          r[1] === data.type &&
          norm_(r[2]) === norm_(data.name)
        );
      },
      [email, data.type, data.name],
      [],
    );
    return json_({ status: "success" });
  }
  if (action === "cat_delete") {
    deleteWhere_(getSheet_(CAT_SHEET, ["email", "type", "name"]), function (r) {
      return (
        norm_(r[0]) === email &&
        r[1] === data.type &&
        norm_(r[2]) === norm_(data.name)
      );
    });
    return json_({ status: "success" });
  }

  /* ----- settings ----- */
  if (action === "set_setting") {
    setSettingValue_(email, data.key, data.value);
    return json_({ status: "success" });
  }

  /* ----- activities: unified stream (ACTIVITY rows + HABIT check-ins) ----- */
  if (action === "act_save") {
    var chk = validateActivity_(data, email);
    if (chk.error) return json_({ status: "error", message: chk.error });
    upsertRow_(
      actSheet_(),
      function (r) {
        return r[0].toString() === chk.row[0] && norm_(r[1]) === email;
      },
      chk.row,
      ACT_TEXT_COLS,
    );
    return json_({ status: "success" });
  }
  if (action === "act_delete") {
    deleteWhere_(actSheet_(), function (r) {
      return r[0].toString() === data.id.toString() && norm_(r[1]) === email;
    });
    return json_({ status: "success" });
  }
  if (action === "act_bulk_add") {
    var ok = [];
    (data.rows || []).slice(0, 500).forEach(function (r) {
      var c = validateActivity_(r, email);
      if (!c.error) ok.push(c.row);
    });
    if (ok.length) {
      var ash = actSheet_(),
        start = ash.getLastRow() + 1;
      ACT_TEXT_COLS.forEach(function (c) {
        ash.getRange(start, c, ok.length, 1).setNumberFormat("@");
      });
      ash.getRange(start, 1, ok.length, ACT_HEADERS.length).setValues(ok);
    }
    return json_({ status: "success", count: ok.length });
  }

  /* ----- habits ----- */
  if (action === "habit_save") {
    var name = cleanText_(data.name, 40);
    if (!name)
      return json_({ status: "error", message: "Habit name required" });
    var color = /^#[0-9a-fA-F]{6}$/.test(data.color || "")
      ? data.color
      : "#6366f1";
    upsertRow_(
      habitSheet_(),
      function (r) {
        return r[0].toString() === data.id.toString() && norm_(r[1]) === email;
      },
      [
        cleanText_(data.id, 64),
        email,
        name,
        cleanText_(data.icon || "fa-check", 30),
        color,
        data.mode === "count" ? "count" : "check",
        clampNum_(data.target, 1, 10000) || 1,
        Math.min(7, Math.max(1, clampNum_(data.per_week, 1, 7) || 7)),
        data.active === "no" ? "no" : "yes",
        formatDateValue(data.created) ||
          Utilities.formatDate(
            new Date(),
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          ),
      ],
      HABIT_TEXT_COLS,
    );
    return json_({ status: "success" });
  }
  if (action === "habit_delete") {
    var hid = data.id.toString();
    deleteWhere_(habitSheet_(), function (r) {
      return r[0].toString() === hid && norm_(r[1]) === email;
    });
    deleteWhere_(actSheet_(), function (r) {
      return (
        norm_(r[1]) === email && r[3] === "HABIT" && r[11].toString() === hid
      );
    });
    return json_({ status: "success" });
  }
  if (action === "habit_toggle") {
    var logId =
      "hl_" +
      cleanText_(data.habit_id, 64) +
      "_" +
      (data.date || "").toString().slice(0, 10);
    var val = clampNum_(data.value, 0, 1000000);
    if (val <= 0) {
      deleteWhere_(actSheet_(), function (r) {
        return r[0].toString() === logId && norm_(r[1]) === email;
      });
      return json_({ status: "success" });
    }
    var hchk = validateActivity_(
      {
        id: logId,
        date: data.date,
        kind: "HABIT",
        category: "Habit",
        type: data.name,
        title: data.name,
        value: val,
        unit: data.value > 1 ? "count" : "",
        duration: 0,
        done: data.done,
        ref: data.habit_id,
        meta: {},
      },
      email,
    );
    if (hchk.error) return json_({ status: "error", message: hchk.error });
    upsertRow_(
      actSheet_(),
      function (r) {
        return r[0].toString() === logId && norm_(r[1]) === email;
      },
      hchk.row,
      ACT_TEXT_COLS,
    );
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
  upsertRow_(
    ss,
    function (r) {
      return norm_(r[0]) === email && r[1].toString() === key.toString();
    },
    [email, key, value === null || value === undefined ? "" : value.toString()],
    [3],
  );
}

function authorizeAllScopes() {
  var sh = getSheet_(SETTINGS_SHEET, ["email", "key", "value"]);
  sh.getDataRange().getValues();

  MailApp.sendEmail({
    to:
      Session.getActiveUser().getEmail() ||
      Session.getEffectiveUser().getEmail(),
    subject: "Expense Tracker: authorization check",
    htmlBody:
      "<p>If you received this, the script is fully authorized (Sheets + Mail) and the web app + reminders will work.</p>",
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
  rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(
    function (r) {
      var em = norm_(r[0]);
      if (!em) return;
      if (!byUser[em]) byUser[em] = {};
      byUser[em][r[1]] =
        r[2] === null || r[2] === undefined ? "" : r[2].toString();
    },
  );

  var datesByUser = {};
  rowsOf_(
    getSheet_(SHEET_NAME, [
      "id",
      "user_email",
      "date",
      "type",
      "category",
      "amount",
      "description",
    ]),
  ).forEach(function (r) {
    if (!r[0]) return;
    var em = norm_(r[1]);
    if (!datesByUser[em]) datesByUser[em] = {};
    datesByUser[em][formatDateValue(r[2])] = true;
  });

  rowsOf_(actSheet_()).forEach(function (r) {
    if (!r[0] || r[3] !== "ACTIVITY") return;
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
    var nowMin =
      Number(Utilities.formatDate(now, tz, "H")) * 60 +
      Number(Utilities.formatDate(now, tz, "m"));
    if (nowMin < startMin) return;

    if (s.last_email && now - new Date(s.last_email) < 50 * 60 * 1000) return;
    var sentToday = s.email_day === today ? Number(s.email_cnt || 0) : 0;
    if (sentToday >= MAX_EMAILS_PER_DAY) return;

    var link =
      (s.app_url || "").indexOf("http") === 0
        ? '<p><a href="' + s.app_url + '">Open Expense Tracker</a></p>'
        : "";
    try {
      MailApp.sendEmail({
        to: reminderRecipient_(em, s),
        subject: "Reminder: did you add today's expenses?",
        htmlBody:
          "<p>Hi,</p><p>You have not added any income or expense for today yet.</p>" +
          link +
          "<p>If there is nothing to add today, open the app and tap <b>All done for today</b> to stop reminders.</p>",
      });
      setSettingValue_(em, "last_email", now.toISOString());
      setSettingValue_(em, "email_day", today);
      setSettingValue_(em, "email_cnt", sentToday + 1);
    } catch (err) {
      console.error(
        "Reminder email failed for " + em + ": " + mailErrorMessage_(err),
      );
    }
  });
}

/* =========================================================
   LIFE OS ADDITIONS: tokens, lockout, validation, Activities + Habits
   ========================================================= */
function safeCallback_(cb) {
  cb = (cb || "").toString();
  return /^[A-Za-z0-9_.$]{1,64}$/.test(cb) ? cb : "";
}
function jsonpOut_(cb, obj) {
  if (cb) {
    return ContentService.createTextOutput(
      cb + "(" + JSON.stringify(obj) + ")",
    ).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json_(obj);
}

/* Signed, stateless session token: base64(email|expiry).HMAC-SHA256. The secret is created once
   and kept in Script Properties. To sign everyone out, delete the TOKEN_SECRET property. */
function tokenSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty("TOKEN_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("TOKEN_SECRET", s);
  }
  return s;
}
function signToken_(msg) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(msg, tokenSecret_()),
  );
}
function makeToken_(email) {
  var body = Utilities.base64EncodeWebSafe(
    email + "|" + (Date.now() + TOKEN_TTL_MS),
    Utilities.Charset.UTF_8,
  );
  return body + "." + signToken_(body);
}
function verifyToken_(tok) {
  tok = (tok || "").toString();
  var i = tok.indexOf(".");
  if (i < 1) return "";
  var body = tok.slice(0, i);
  if (signToken_(body) !== tok.slice(i + 1)) return "";
  var txt = Utilities.newBlob(
    Utilities.base64DecodeWebSafe(body),
  ).getDataAsString();
  var cut = txt.lastIndexOf("|");
  if (cut < 1 || Number(txt.slice(cut + 1)) < Date.now()) return "";
  return norm_(txt.slice(0, cut));
}

/* Login lockout: 5 failed attempts per email blocks sign-in for 15 minutes */
function failKey_(email) {
  return "fail_" + sha256_(email).slice(0, 24);
}
function isLocked_(email) {
  return Number(CacheService.getScriptCache().get(failKey_(email)) || 0) >= 5;
}
function noteFail_(email) {
  var c = CacheService.getScriptCache(),
    k = failKey_(email);
  c.put(k, String(Number(c.get(k) || 0) + 1), 900);
}
function clearFails_(email) {
  CacheService.getScriptCache().remove(failKey_(email));
}

function cleanText_(v, max) {
  return (v === null || v === undefined ? "" : v)
    .toString()
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, max);
}
function clampNum_(v, lo, hi) {
  var n = Number(v);
  if (isNaN(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}
function actSheet_() {
  return getSheet_(ACT_SHEET, ACT_HEADERS);
}
function habitSheet_() {
  return getSheet_(HABIT_SHEET, HABIT_HEADERS);
}

function validateActivity_(d, email) {
  var id = cleanText_(d.id, 64);
  var date = (d.date || "").toString().slice(0, 10);
  if (!id) return { error: "Missing id" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Invalid date" };
  var limit = Utilities.formatDate(
    new Date(Date.now() + 864e5),
    Session.getScriptTimeZone(),
    "yyyy-MM-dd",
  );
  if (date > limit) return { error: "Date cannot be in the future" };
  var kind = d.kind === "HABIT" ? "HABIT" : "ACTIVITY";
  var meta =
    d.meta && typeof d.meta === "object" ? JSON.stringify(d.meta) : "{}";
  if (meta.length > 2000) return { error: "Details too long" };
  return {
    row: [
      id,
      email,
      date,
      kind,
      cleanText_(d.category, 30),
      cleanText_(d.type, 40),
      cleanText_(d.title, 120),
      clampNum_(d.value, 0, 1000000),
      cleanText_(d.unit, 20),
      clampNum_(d.duration, 0, 1440),
      d.done === "yes" ? "yes" : kind === "HABIT" ? "no" : "",
      cleanText_(d.ref, 64),
      meta,
      cleanText_(d.notes, 300),
      new Date().toISOString(),
    ],
  };
}

function actsFor_(email) {
  var out = [];
  rowsOf_(actSheet_()).forEach(function (r) {
    if (!r[0] || norm_(r[1]) !== email) return;
    var meta = {};
    try {
      meta = JSON.parse(r[12] || "{}");
    } catch (err) {}
    out.push({
      id: r[0].toString(),
      date: formatDateValue(r[2]),
      kind: r[3],
      category: r[4],
      type: r[5],
      title: r[6],
      value: Number(r[7]) || 0,
      unit: r[8],
      duration: Number(r[9]) || 0,
      done: r[10],
      ref: r[11].toString(),
      meta: meta,
      notes: r[13],
    });
  });
  return out;
}
function habitsFor_(email) {
  var out = [];
  rowsOf_(habitSheet_()).forEach(function (r) {
    if (!r[0] || norm_(r[1]) !== email) return;
    out.push({
      id: r[0].toString(),
      name: r[2],
      icon: r[3],
      color: r[4],
      mode: r[5],
      target: Number(r[6]) || 1,
      per_week: Number(r[7]) || 7,
      active: r[8],
      created: formatDateValue(r[9]),
    });
  });
  return out;
}

/* ---------- optional: weekly digest email (run setupDigestTrigger once) ---------- */
function setupDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "weeklyDigest") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("weeklyDigest")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(19)
    .create();
}
function weeklyDigest() {
  var tz = Session.getScriptTimeZone();
  var from = Utilities.formatDate(
    new Date(Date.now() - 6 * 864e5),
    tz,
    "yyyy-MM-dd",
  );
  var byUser = {};
  rowsOf_(getSheet_(SETTINGS_SHEET, ["email", "key", "value"])).forEach(
    function (r) {
      var em = norm_(r[0]);
      if (!em) return;
      (byUser[em] = byUser[em] || {})[r[1]] =
        r[2] === null || r[2] === undefined ? "" : r[2].toString();
    },
  );
  var stats = {};
  function st(em) {
    return (stats[em] = stats[em] || {
      spent: 0,
      sessions: 0,
      minutes: 0,
      habits: 0,
    });
  }
  rowsOf_(
    getSheet_(SHEET_NAME, [
      "id",
      "user_email",
      "date",
      "type",
      "category",
      "amount",
      "description",
    ]),
  ).forEach(function (r) {
    if (r[3] === "EXPENSE" && formatDateValue(r[2]) >= from)
      st(norm_(r[1])).spent += Number(r[5]) || 0;
  });
  rowsOf_(actSheet_()).forEach(function (r) {
    if (formatDateValue(r[2]) < from) return;
    var s = st(norm_(r[1]));
    if (r[3] === "ACTIVITY") {
      s.sessions++;
      s.minutes += Number(r[9]) || 0;
    } else if (r[10] === "yes") s.habits++;
  });
  Object.keys(byUser).forEach(function (em) {
    if (byUser[em].digest_email !== "yes") return;
    var s = st(em);
    try {
      MailApp.sendEmail({
        to: reminderRecipient_(em, byUser[em]),
        subject:
          "Your Life OS week: " +
          s.sessions +
          " sessions, " +
          s.habits +
          " habit check-ins",
        htmlBody:
          "<p>Here is your last 7 days:</p><ul><li>Spent: Rs. " +
          Math.round(s.spent) +
          "</li><li>Sessions logged: " +
          s.sessions +
          "</li><li>Active minutes: " +
          s.minutes +
          "</li><li>Habit check-ins: " +
          s.habits +
          "</li></ul>",
      });
    } catch (err) {
      console.error("Digest failed for " + em + ": " + mailErrorMessage_(err));
    }
  });
}
