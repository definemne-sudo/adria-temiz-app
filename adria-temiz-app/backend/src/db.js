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
  tax_number TEXT,
  billing_address TEXT,
  username TEXT UNIQUE,
  password_hash TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  current_lat REAL,
  current_lng REAL,
  current_city TEXT,
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
-- Acil/destek chat mesajları. Şu an tek yönlü çalışıyor (müşteri yazıyor,
-- kayıt altına alınıyor) - personel paneli yazıldığında admin buradan
-- görüp yanıtlayabilecek (sender='admin' ile).
-- Personel başvuruları: MICISTO'da çalışmak isteyenlerin, hesap açmadan
-- doldurduğu ön başvuru formu. Admin paneli yazıldığında buradan
-- onaylanıp gerçek 'staff' hesabına dönüştürülecek (personel app'i o zaman verilir).
-- Personelin tarayıcısından alınan push abonelikleri - sipariş bildirimleri
-- bunlar üzerinden gönderiliyor. Bir personelin birden fazla cihazı/tarayıcısı
-- olabilir, hepsi ayrı satır.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_applications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  category TEXT NOT NULL DEFAULT 'apartment' CHECK (category IN ('apartment','house','office','common_area')),
  building_name TEXT,
  address TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  size_sqm REAL,
  floor_count INTEGER,
  sqm_per_floor REAL,
  elevator_capacity INTEGER,
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
  service_params TEXT,
  building_name TEXT,
  has_equipment INTEGER NOT NULL DEFAULT 1,
  has_chemicals INTEGER NOT NULL DEFAULT 1,
  urgency TEXT NOT NULL DEFAULT 'scheduled' CHECK (urgency IN ('now','urgent','scheduled')),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('cash','card','invoice')),
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
  notified_staff_ids TEXT NOT NULL DEFAULT '[]',
  current_candidate_id TEXT REFERENCES users(id),
  notification_sent_at TEXT,
  accepted_at TEXT,
  notes TEXT,
  service_rating TEXT CHECK (service_rating IS NULL OR service_rating IN ('like','dislike')),
  service_feedback TEXT,
  staff_rating TEXT CHECK (staff_rating IS NULL OR staff_rating IN ('like','dislike')),
  staff_feedback TEXT,
  rated_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, ical_uid)
);
`);

module.exports = db;

// --- Güvenli sütun ekleme (migrasyon) ---------------------------------------
// CREATE TABLE IF NOT EXISTS, tablo zaten varsa (canlıda olduğu gibi) yeni
// eklenen sütunları eklemez. Bu blok, daha önce eklenmemiş olabilecek
// sütunları var olan tabloya güvenle ekler - sütun zaten varsa SQLite hata
// verir, o hata yakalanıp yok sayılır (idempotent, defalarca çalıştırılabilir).
function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

ensureColumn('users', 'current_lat', 'REAL');
ensureColumn('users', 'current_lng', 'REAL');
ensureColumn('users', 'current_city', 'TEXT');
ensureColumn('cleaning_jobs', 'notified_staff_ids', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('cleaning_jobs', 'current_candidate_id', 'TEXT');
ensureColumn('cleaning_jobs', 'notification_sent_at', 'TEXT');
ensureColumn('cleaning_jobs', 'accepted_at', 'TEXT');
