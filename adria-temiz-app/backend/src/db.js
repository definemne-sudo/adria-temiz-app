const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Şema ---
// users: hem bireysel ev sahibi hem yönetim şirketi burada, account_type ile ayrılıyor.
// account_type: 'individual' | 'company' | 'staff' | 'admin'
// Kimlik doğrulama artık e-posta/şifre değil, telefon + SMS kod (OTP) ile.
// profile_completed = 0: kullanıcı telefonunu doğruladı ama henüz adını/hesap
// tipini girmedi (Glovo/Ablan Temizler tarzı "önce gir, sonra tamamla" akışı).
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  account_type TEXT NOT NULL DEFAULT 'individual' CHECK (
    account_type IN ('individual','company','staff','admin')
  ),
  company_name TEXT,
  profile_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telefon numarasına gönderilen tek kullanımlık doğrulama kodları.
-- Aynı numara tekrar kod istediğinde eski kayıt üzerine yazılır (UNIQUE phone).
CREATE TABLE IF NOT EXISTS otp_requests (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  ical_url TEXT,
  base_price REAL NOT NULL DEFAULT 40,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bir yönetim şirketinin, kendisine ait olmayan bir mülke davetle erişim
-- kazanması için delege erişim tablosu (bkz. şablon Bölüm 7.1)
CREATE TABLE IF NOT EXISTS property_delegates (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  delegate_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, delegate_user_id)
);

CREATE TABLE IF NOT EXISTS cleaning_jobs (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  checkout_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','assigned','in_progress','done','confirmed','cancelled')
  ),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ical_auto')),
  ical_uid TEXT,
  price REAL NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (
    payment_status IN ('unpaid','held','released','refunded')
  ),
  assigned_staff_id TEXT REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, ical_uid)
);
`);

module.exports = db;
