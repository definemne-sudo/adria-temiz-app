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

-- Kayıtlı kart bilgisi. ÖNEMLİ: burada asla tam kart numarası veya CVC
-- saklanmaz — gerçek bir ödeme sağlayıcısının (Stripe vb.) döndüreceği
-- token'ı simüle ediyoruz: yalnızca son 4 hane, marka ve son kullanma
-- tarihi. Gerçek entegrasyonda bu tablo, sağlayıcının payment_method_id'sini
-- tutar; kart verisi hiçbir zaman bizim sunucumuza uğramaz.
CREATE TABLE IF NOT EXISTS saved_cards (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  holder_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'apartment' CHECK (category IN ('apartment','house','office')),
  address TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  size_sqm REAL,
  ical_url TEXT,
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
  service_key TEXT NOT NULL DEFAULT 'checkin_checkout',
  quantity INTEGER,
  addons TEXT,
  has_equipment INTEGER NOT NULL DEFAULT 1,
  has_chemicals INTEGER NOT NULL DEFAULT 1,
  urgency TEXT NOT NULL DEFAULT 'scheduled' CHECK (urgency IN ('now','urgent','scheduled')),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('cash','card')),
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
