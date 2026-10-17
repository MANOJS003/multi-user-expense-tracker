var SHEET_NAME = "Transactions";
var AUTH_SHEET_NAME = "Auth";

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var authSheet = ss.getSheetByName(AUTH_SHEET_NAME);
  
  if (!authSheet) {
    authSheet = ss.insertSheet(AUTH_SHEET_NAME);
    authSheet.appendRow(["email", "password", "created_at"]);
  }

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["id", "user_email", "date", "type", "category", "amount", "description"]);
  }

  var callback = e.parameter.callback;
  var action = e.parameter.action;
  var email = (e.parameter.email || "").toString().trim().toLowerCase();
  var pass = (e.parameter.password || "").toString().trim();

  var output = {};

  if (action === "signup") {
    var authRows = authSheet.getDataRange().getValues();
    var exists = false;
    for (var k = 1; k < authRows.length; k++) {
      if (authRows[k][0].toString().trim().toLowerCase() === email) {
        exists = true;
        break;
      }
    }
    if (exists) {
      output = { success: false, message: "Email already registered" };
    } else {
      authSheet.appendRow([email, pass, new Date().toISOString()]);
      output = { success: true, message: "Account created successfully" };
    }
  } 
  else if (action === "auth") {
    var authRows = authSheet.getDataRange().getValues();
    var isValid = false;

    for (var k = 1; k < authRows.length; k++) {
      var dbEmail = authRows[k][0].toString().trim().toLowerCase();
      var dbPass = authRows[k][1].toString().trim();
      if (dbEmail === email && dbPass === pass) {
        isValid = true;
        break;
      }
    }
    output = { success: isValid };
  } 
  else if (action === "get") {
    var rows = sheet.getDataRange().getValues();
    if (!rows || rows.length <= 1) {
      output = [];
    } else {
      var resData = [];
      for (var i = 1; i < rows.length; i++) {
        if (!rows[i][0]) continue;
        // User-specific data filter! Only fetch current logged in user's rows
        if (rows[i][1].toString().trim().toLowerCase() === email) {
          resData.push({
            id: rows[i][0],
            user_email: rows[i][1],
            date: rows[i][2],
            type: rows[i][3],
            category: rows[i][4],
            amount: rows[i][5],
            description: rows[i][6]
          });
        }
      }
      output = resData;
    }
  }

  if (callback) {
    var jsonp = callback + "(" + JSON.stringify(output) + ")";
    return ContentService.createTextOutput(jsonp).setMimeType(ContentService.MimeType.JAVASCRIPT);
  } else {
    return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  var authSheet = ss.getSheetByName(AUTH_SHEET_NAME) || ss.insertSheet(AUTH_SHEET_NAME);
  
  var data = JSON.parse(e.postData.contents);
  var action = data.action;

  if (action === "change_password") {
    var authRows = authSheet.getDataRange().getValues();
    var email = (data.email || "").toString().trim().toLowerCase();
    var currPass = (data.currentPassword || "").toString().trim();
    var newPass = (data.newPassword || "").toString().trim();
    var updated = false;

    for (var i = 1; i < authRows.length; i++) {
      var dbEmail = authRows[i][0].toString().trim().toLowerCase();
      var dbPass = authRows[i][1].toString().trim();
      if (dbEmail === email && dbPass === currPass) {
        authSheet.getRange(i + 1, 2).setValue(newPass);
        updated = true;
        break;
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ success: updated })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "add") {
    sheet.appendRow([data.id, data.email, data.date, data.type, data.category, data.amount, data.description]);
    return ContentService.createTextOutput(JSON.stringify({status: "success"})).setMimeType(ContentService.MimeType.JSON);
  } 
  else if (action === "delete") {
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0].toString() === data.id.toString() && rows[i][1].toString().trim().toLowerCase() === data.email.toString().trim().toLowerCase()) {
        sheet.deleteRow(i + 1);
        break;
      }
    }
    return ContentService.createTextOutput(JSON.stringify({status: "success"})).setMimeType(ContentService.MimeType.JSON);
  }
  else if (action === "edit") {
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0].toString() === data.id.toString() && rows[i][1].toString().trim().toLowerCase() === data.email.toString().trim().toLowerCase()) {
        sheet.getRange(i + 1, 1, 1, 7).setValues([[data.id, data.email, data.date, data.type, data.category, data.amount, data.description]]);
        break;
      }
    }
    return ContentService.createTextOutput(JSON.stringify({status: "success"})).setMimeType(ContentService.MimeType.JSON);
  }
}