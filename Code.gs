/**
 * Dapoer Asri Ummiku Sayang — Google Apps Script backend
 *
 * Keamanan:
 *  - Password disimpan sebagai hash SHA-256 ber-salt (password plaintext lama otomatis
 *    di-upgrade saat login berhasil).
 *  - Login menghasilkan token sesi (CacheService, 6 jam). Semua fungsi tulis & data
 *    pesanan WAJIB menyertakan token.
 *  - Data user/password tidak pernah dikirim ke browser.
 *  - Penulisan sheet memakai LockService untuk mencegah race condition.
 */

var SESSION_TTL_SECONDS = 6 * 60 * 60;
var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_LOCK_SECONDS = 15 * 60;
var HASH_ITERATIONS = 200;
var DEFAULT_PASSWORD = 'ummiku';
var ORDER_STATUSES = ['Pre-Order', 'Diproses', 'Siap Kirim', 'Selesai', 'Dibatalkan'];
var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

var SHEET_HEADERS = {
  Products: ['id', 'name', 'price', 'hpp', 'category', 'image', 'description'],
  // Kolom baru (productId, unitHpp) ditaruh di akhir agar sheet lama tetap kompatibel
  Orders: ['id', 'customerName', 'productName', 'qty', 'totalPrice', 'date', 'status', 'notes', 'productId', 'unitHpp'],
  Users: ['username', 'password', 'ummiName', 'role'],
  Settings: ['key', 'value']
};

var DEFAULT_SETTINGS = {
  storeName: 'Dapoer Asri',
  storeSubtitle: 'Ummiku Sayang',
  waNumber: '6282226479060',
  logoUrl: '',
  bgImageUrl: '',
  landingLayout: 'immersive', // 'immersive' | 'story' | 'quick_order'
  heroBadge: 'Sistem Pre-Order • Dimasak Segar Setiap Hari',
  heroTitle: 'Cita Rasa Masakan Rumah Penuh Cinta.',
  heroDesc: 'Kering kentang balado renyah, salad buah segar kaya vitamin, dan rice bowl hangat khas Dapoer Asri. Olahan bersih, higienis, dan 100% halal khusus untuk keluarga Anda.',
  aboutTitle: 'Kenapa Memilih Dapoer Asri?',
  aboutDesc: 'Dapur rumahan higienis yang mengutamakan kualitas rasa dan kesehatan keluarga Anda.'
};
var SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

// ============================================================================
// ENTRY POINT
// ============================================================================

function doGet(e) {
  // Tidak memakai XFrameOptionsMode.ALLOWALL agar halaman tidak bisa di-embed situs lain (clickjacking).
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Dapoer Asri Ummiku Sayang - Pre-Order & Dashboard UMKM')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================================
// DATA PUBLIK & ADMIN
// ============================================================================

/**
 * Data untuk halaman publik: menu & pengaturan toko.
 * Jika token admin valid, data pesanan ikut dikirim.
 */
function getDatabase(token) {
  var ss = getSpreadsheet_();
  ensureSeedData_(ss);

  var result = {
    products: sheetToObjects_(getSheet_(ss, 'Products')),
    settings: getSettings_(ss)
  };

  if (token && getSessionUser_(token)) {
    result.orders = sheetToObjects_(getSheet_(ss, 'Orders'));
  }
  return result;
}

function ensureSeedData_(ss) {
  var productsSheet = getSheet_(ss, 'Products');
  var usersSheet = getSheet_(ss, 'Users');
  var settingsSheet = getSheet_(ss, 'Settings');
  getSheet_(ss, 'Orders');

  if (usersSheet.getLastRow() <= 1) {
    usersSheet.appendRow(['ummi', hashPassword_(DEFAULT_PASSWORD), 'Dapoer Asri Ummiku Sayang', 'admin']);
  }

  if (productsSheet.getLastRow() <= 1) {
    productsSheet.appendRow(['PRD-1', 'Kering Kentang Crispy Balado', 25000, 15000, 'Snack', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=600&q=80', 'Kering kentang renyah premium dengan racikan bumbu balado gurih pedas manis khas dapur rumah.']);
    productsSheet.appendRow(['PRD-2', 'Salad Buah Segar', 30000, 18000, 'Dessert', 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=600&q=80', 'Kombinasi aneka buah segar pilihan dengan topping parutan keju melimpah dan saus mayo creamy homemade.']);
    productsSheet.appendRow(['PRD-3', 'Rice Bowl Chicken Mentai', 35000, 20000, 'Main Course', 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80', 'Nasi hangat pulen berpadu chicken katsu renyah dilapisi saus mentai gurih yang di-torch sempurna.']);
  }

  if (settingsSheet.getLastRow() <= 1) {
    SETTINGS_KEYS.forEach(function(k) { settingsSheet.appendRow([k, DEFAULT_SETTINGS[k]]); });
  }
}

function getSettings_(ss) {
  var rows = getSheet_(ss, 'Settings').getDataRange().getValues();
  var settings = {};
  SETTINGS_KEYS.forEach(function(k) { settings[k] = DEFAULT_SETTINGS[k]; });
  for (var i = 1; i < rows.length; i++) {
    var key = String(rows[i][0] || '').trim();
    if (key && SETTINGS_KEYS.indexOf(key) !== -1) {
      settings[key] = rows[i][1] === null || rows[i][1] === undefined ? '' : String(rows[i][1]);
    }
  }
  return settings;
}

// ============================================================================
// SETTINGS
// ============================================================================

function saveStoreSettings(token, settings) {
  requireSession_(token);
  settings = settings || {};
  return withLock_(function() {
    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss, 'Settings');
    var rows = sheet.getDataRange().getValues();

    SETTINGS_KEYS.forEach(function(key) {
      if (settings[key] === undefined) return;
      var value = String(settings[key] || '');
      if (key === 'waNumber') value = normalizeWa_(value);
      if ((key === 'logoUrl' || key === 'bgImageUrl') && value.indexOf('data:') === 0) {
        throw new Error('Gambar harus diunggah terlebih dahulu (bukan base64).');
      }
      var found = false;
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).trim() === key) {
          sheet.getRange(i + 1, 2).setValue(value);
          found = true;
          break;
        }
      }
      if (!found) sheet.appendRow([key, value]);
    });
    return { success: true, settings: getSettings_(ss) };
  });
}

// ============================================================================
// PRODUCTS
// ============================================================================

function saveProductData(token, product) {
  requireSession_(token);
  product = product || {};
  var name = String(product.name || '').trim();
  if (!name) throw new Error('Nama produk wajib diisi.');
  var price = Number(product.price);
  var hpp = Number(product.hpp);
  if (!isFinite(price) || price < 0) throw new Error('Harga tidak valid.');
  if (!isFinite(hpp) || hpp < 0) throw new Error('HPP tidak valid.');
  var image = String(product.image || '');
  if (image.indexOf('data:') === 0) throw new Error('Foto harus diunggah terlebih dahulu (bukan base64).');

  var record = {
    id: product.id ? String(product.id) : newId_('PRD'),
    name: name,
    price: price,
    hpp: hpp,
    category: String(product.category || 'Umum').trim() || 'Umum',
    image: image,
    description: String(product.description || '')
  };

  return withLock_(function() {
    upsertById_(getSheet_(getSpreadsheet_(), 'Products'), record);
    return { success: true, product: record };
  });
}

function deleteProductData(token, id) {
  requireSession_(token);
  return withLock_(function() {
    deleteById_(getSheet_(getSpreadsheet_(), 'Products'), id);
    return { success: true };
  });
}

// ============================================================================
// ORDERS
// ============================================================================

function saveOrderData(token, order) {
  requireSession_(token);
  order = order || {};
  var ss = getSpreadsheet_();

  var customerName = String(order.customerName || '').trim();
  if (!customerName) throw new Error('Nama pemesan wajib diisi.');
  var qty = parseInt(order.qty, 10);
  if (!isFinite(qty) || qty < 1) throw new Error('Jumlah minimal 1.');
  var status = ORDER_STATUSES.indexOf(order.status) !== -1 ? order.status : 'Pre-Order';

  // Cari produk berdasarkan id (fallback: nama) untuk snapshot nama, harga & HPP
  var products = sheetToObjects_(getSheet_(ss, 'Products'));
  var product = null;
  for (var i = 0; i < products.length; i++) {
    if (order.productId && String(products[i].id) === String(order.productId)) { product = products[i]; break; }
  }
  if (!product && order.productName) {
    for (var j = 0; j < products.length; j++) {
      if (products[j].name === order.productName) { product = products[j]; break; }
    }
  }

  var productName = product ? product.name : String(order.productName || '').trim();
  if (!productName) throw new Error('Menu wajib dipilih.');
  var totalPrice = Number(order.totalPrice);
  if (!isFinite(totalPrice) || totalPrice < 0) totalPrice = product ? Number(product.price) * qty : 0;
  var unitHpp = order.unitHpp !== undefined && order.unitHpp !== null && order.unitHpp !== ''
    ? Number(order.unitHpp)
    : (product ? Number(product.hpp) || 0 : '');

  var dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(order.date || ''))
    ? String(order.date)
    : Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM-dd');

  var record = {
    id: order.id ? String(order.id) : newId_('ORD'),
    customerName: customerName,
    productId: product ? String(product.id) : (order.productId || ''),
    productName: productName,
    qty: qty,
    totalPrice: totalPrice,
    unitHpp: unitHpp,
    date: dateStr,
    status: status,
    notes: String(order.notes || '')
  };

  return withLock_(function() {
    upsertById_(getSheet_(ss, 'Orders'), record);
    return { success: true, order: record };
  });
}

function deleteOrderData(token, id) {
  requireSession_(token);
  return withLock_(function() {
    deleteById_(getSheet_(getSpreadsheet_(), 'Orders'), id);
    return { success: true };
  });
}

// ============================================================================
// UPLOAD GAMBAR (Google Drive) — menggantikan penyimpanan base64 di sheet
// ============================================================================

function uploadImage(token, dataUrl, fileName) {
  requireSession_(token);
  var match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('Format gambar tidak didukung.');
  var bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('Ukuran gambar maksimal 5 MB.');

  var safeName = String(fileName || 'image').replace(/[^\w.\-]/g, '_').slice(0, 80);
  var blob = Utilities.newBlob(bytes, match[1], Date.now() + '_' + safeName);
  var file = getUploadFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { success: true, url: 'https://lh3.googleusercontent.com/d/' + file.getId() };
}

function getUploadFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('UPLOAD_FOLDER_ID');
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (e) {}
  }
  var folder = DriveApp.createFolder('Dapoer Asri - Uploads');
  props.setProperty('UPLOAD_FOLDER_ID', folder.getId());
  return folder;
}

// ============================================================================
// AUTH
// ============================================================================

function checkLoginCredentials(username, password) {
  var cleanUser = String(username || '').trim().toLowerCase();
  var cleanPass = String(password || '');
  if (!cleanUser || !cleanPass) return { success: false, message: 'Username dan password wajib diisi.' };

  var cache = CacheService.getScriptCache();
  var failKey = 'loginfail_' + cleanUser;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_ATTEMPTS) {
    return { success: false, message: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' };
  }

  var ss = getSpreadsheet_();
  ensureSeedData_(ss);
  var sheet = getSheet_(ss, 'Users');
  var rows = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() !== cleanUser) continue;
    var check = verifyPassword_(String(rows[i][1]), cleanPass);
    if (!check.ok) break;

    if (check.needsUpgrade) {
      sheet.getRange(i + 1, 2).setValue(hashPassword_(cleanPass));
    }
    cache.remove(failKey);

    var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    cache.put('sess_' + token, String(rows[i][0]), SESSION_TTL_SECONDS);

    return {
      success: true,
      token: token,
      mustChangePassword: cleanPass === DEFAULT_PASSWORD,
      user: {
        username: rows[i][0],
        ummiName: rows[i][2],
        role: rows[i][3]
      }
    };
  }

  cache.put(failKey, String(fails + 1), LOGIN_LOCK_SECONDS);
  return { success: false, message: 'Username atau Password salah!' };
}

/** Validasi token sesi (dipakai frontend saat reload halaman). */
function validateSession(token) {
  var username = getSessionUser_(token);
  if (!username) return { success: false };
  var rows = getSheet_(getSpreadsheet_(), 'Users').getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === username) {
      return { success: true, user: { username: rows[i][0], ummiName: rows[i][2], role: rows[i][3] } };
    }
  }
  return { success: false };
}

function logoutSession(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return { success: true };
}

function changePassword(token, oldPassword, newPassword) {
  var username = requireSession_(token);
  newPassword = String(newPassword || '');
  if (newPassword.length < 8) throw new Error('Password baru minimal 8 karakter.');

  return withLock_(function() {
    var sheet = getSheet_(getSpreadsheet_(), 'Users');
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) !== username) continue;
      if (!verifyPassword_(String(rows[i][1]), String(oldPassword || '')).ok) {
        throw new Error('Password lama salah.');
      }
      sheet.getRange(i + 1, 2).setValue(hashPassword_(newPassword));
      return { success: true };
    }
    throw new Error('User tidak ditemukan.');
  });
}

function saveUserData(token, user) {
  requireSession_(token);
  user = user || {};
  var username = String(user.username || '').trim();
  var password = String(user.password || '');
  if (!username) throw new Error('Username wajib diisi.');
  if (password.length < 8) throw new Error('Password minimal 8 karakter.');

  return withLock_(function() {
    var sheet = getSheet_(getSpreadsheet_(), 'Users');
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim().toLowerCase() === username.toLowerCase()) {
        throw new Error('Username sudah dipakai.');
      }
    }
    sheet.appendRow([username, hashPassword_(password), user.ummiName || '', user.role || 'admin']);
    return { success: true };
  });
}

function getSessionUser_(token) {
  if (!token || typeof token !== 'string') return null;
  return CacheService.getScriptCache().get('sess_' + token);
}

function requireSession_(token) {
  var username = getSessionUser_(token);
  if (!username) throw new Error('Sesi berakhir. Silakan login ulang.');
  return username;
}

function hashPassword_(password, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + password, Utilities.Charset.UTF_8);
  for (var i = 1; i < HASH_ITERATIONS; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest);
  }
  return 'sha256$' + salt + '$' + Utilities.base64Encode(digest);
}

function verifyPassword_(stored, input) {
  if (stored.indexOf('sha256$') === 0) {
    var salt = stored.split('$')[1];
    return { ok: safeEqual_(hashPassword_(input, salt), stored), needsUpgrade: false };
  }
  // Password plaintext lama -> cocokkan lalu upgrade ke hash
  return { ok: stored.trim() !== '' && safeEqual_(stored.trim(), input.trim()), needsUpgrade: true };
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================================
// HELPERS SHEET
// ============================================================================

function getSpreadsheet_() {
  try {
    var activeSs = SpreadsheetApp.getActiveSpreadsheet();
    if (activeSs) return activeSs;
  } catch (e) {}

  var scriptProperties = PropertiesService.getScriptProperties();
  var ssId = scriptProperties.getProperty('SPREADSHEET_ID');
  var ss = null;
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Dapoer Asri Ummiku Sayang - Database');
    scriptProperties.setProperty('SPREADSHEET_ID', ss.getId());
  }
  return ss;
}

/** Ambil sheet; buat jika belum ada; tambahkan kolom header yang belum ada (migrasi). */
function getSheet_(ss, name) {
  var headers = SHEET_HEADERS[name];
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    return sheet;
  }
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = headers.filter(function(h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    var startCol = existing.filter(String).length + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function getHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function sheetToObjects_(sheet) {
  var rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return [];
  var headers = rows[0];
  var tz = getTz_();
  var data = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i].join('') === '') continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      if (!headers[j]) continue;
      var val = rows[i][j];
      if (val instanceof Date) val = Utilities.formatDate(val, tz, 'yyyy-MM-dd');
      obj[headers[j]] = val;
    }
    data.push(obj);
  }
  return data;
}

/** Insert / update baris berdasarkan kolom "id", memetakan nilai sesuai header sheet. */
function upsertById_(sheet, record) {
  var headers = getHeaders_(sheet);
  var row = headers.map(function(h) { return record[h] !== undefined ? record[h] : ''; });
  var idCol = headers.indexOf('id');
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(record.id)) {
        sheet.getRange(i + 2, 1, 1, headers.length).setValues([row]);
        return;
      }
    }
  }
  sheet.appendRow(row);
}

function deleteById_(sheet, id) {
  var headers = getHeaders_(sheet);
  var idCol = headers.indexOf('id');
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  // Hapus dari bawah agar index baris tidak bergeser
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(id)) sheet.deleteRow(i + 2);
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Server sedang sibuk, coba lagi.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function newId_(prefix) {
  return prefix + '-' + Date.now() + '-' + Utilities.getUuid().slice(0, 4);
}

function normalizeWa_(num) {
  var n = String(num || '').replace(/\D/g, '');
  if (n.indexOf('0') === 0) n = '62' + n.substring(1);
  return n;
}

function getTz_() {
  return Session.getScriptTimeZone() || 'Asia/Jakarta';
}