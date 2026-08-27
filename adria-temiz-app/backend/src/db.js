const Database = require('better-sqlite3');
const path = require('path');

// ONEMLI: veritabani dosyasi artik Railway'deki KALICI Volume'a yaziliyor.
// Railway, bir servise Volume baglandigi an RAILWAY_VOLUME_MOUNT_PATH adli
// ortam degiskenini OTOMATIK olarak tanimliyor (manuel eklemene gerek yok) -
// oncelikle onu kullaniyoruz. DATA_DIR, istersen elle override etmek icin
// yedek olarak duruyor. Hicbiri yoksa (orn. yerel gelistirme ortaminda),
// eskisi gibi proje klasorunun icine yazar - geriye donuk uyumluluk icin.
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '..');
const db = new Database(path.join(dataDir, 'data.sqlite'));
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

db.exec(`
-- Hizmet fiyatlandırma parametreleri - MICISTOMan > Hizmetler & Fiyatlandırma
-- ekranından admin tarafından düzenlenebilir. key formatı: "{hizmet}.{alan}"
-- (örn. "checkin_checkout.base", "staircase.ratePerFloor"). catalog.js bu
-- tabloyu her fiyat hesaplamasında canlı okur - sabit kod değeri değil.
CREATE TABLE IF NOT EXISTS pricing_settings (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Her hizmet türü için personelin takip edeceği görev listesi (checklist).
-- service_key: 'checkin_checkout' | 'deep_clean' | 'office' | 'staircase' | 'corridor' | 'elevator'
CREATE TABLE IF NOT EXISTS service_checklists (
  id TEXT PRIMARY KEY,
  service_key TEXT NOT NULL,
  item_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personele 15 günde bir yapılan ödemelerin "ödendi" işaretlemesi. Dönemler
-- kendisi burada saklanmıyor - personelin ilk tamamladığı işten itibaren
-- 15 günlük pencereler halinde CANLI hesaplanıyor (bkz. admin.js). Bu tablo
-- sadece "şu dönem ödendi" bilgisini tutuyor.
CREATE TABLE IF NOT EXISTS staff_payment_marks (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(staff_id, period_start)
);
`);

db.exec(`
-- Reklam kampanyası verileri - hangi platforma verilirse verilsin, admin
-- kendi reklam panelinden (Meta, Google Ads, TikTok vb.) gördüğü rakamları
-- buraya elle giriyor. Gerçek zamanlı API entegrasyonu yok - hangi platform
-- kullanılacağı netleşince ayrıca konuşulmalı.
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  signups INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Promosyon/indirim kodları - tarih, saat aralığı, şehir ve hizmet türüne
-- göre kısıtlanabilir. allowed_customer_ids doluysa (sadakat/referans
-- promosyonları) sadece o listedeki müşteriler kullanabilir.
CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value REAL NOT NULL,
  start_date TEXT,
  end_date TEXT,
  start_hour INTEGER,
  end_hour INTEGER,
  city TEXT,
  service_key TEXT,
  max_uses INTEGER,
  max_uses_per_customer INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  allowed_customer_ids TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','loyalty','referral')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_code_redemptions (
  id TEXT PRIMARY KEY,
  promo_code_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  job_id TEXT,
  discount_amount REAL NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Coverage: hizmet verdiğimiz şehirler/bölgeler listesi. is_active=0 olan
-- bir şehir "artık hizmet vermiyoruz" anlamına gelir (kayıt silinmez,
-- geçmiş için durum korunur).
CREATE TABLE IF NOT EXISTS service_areas (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
ensureColumn('cleaning_jobs', 'cancelled_at', 'TEXT');
ensureColumn('cleaning_jobs', 'cancel_reason', 'TEXT');
ensureColumn('users', 'referral_code', 'TEXT');
ensureColumn('users', 'referred_by_user_id', 'TEXT');
ensureColumn('cleaning_jobs', 'promo_code_id', 'TEXT');
ensureColumn('cleaning_jobs', 'discount_amount', 'REAL');
ensureColumn('properties', 'bedroom_count', 'INTEGER');
ensureColumn('properties', 'bathroom_count', 'INTEGER');
ensureColumn('staff_applications', 'nationality', 'TEXT');
ensureColumn('staff_applications', 'gender', 'TEXT');
ensureColumn('staff_applications', 'birth_date', 'TEXT');
ensureColumn('staff_applications', 'has_experience', 'INTEGER');
ensureColumn('staff_applications', 'experience_years', 'INTEGER');
ensureColumn('staff_applications', 'languages', 'TEXT');
ensureColumn('staff_applications', 'activation_code', 'TEXT');
ensureColumn('staff_applications', 'activation_used_at', 'TEXT');
// Eski beğen/beğenme (like/dislike) yerine 1-10 puanlama sistemine geçildi.
// Eski service_rating/staff_rating (TEXT) sütunları geçmiş veri için
// duruyor ama artık yazılmıyor - yeni skorlar bu sütunlarda tutuluyor.
ensureColumn('cleaning_jobs', 'service_score', 'INTEGER');
ensureColumn('cleaning_jobs', 'staff_score', 'INTEGER');
// Personel "Yola Çık" dediğinde işaretleniyor - müşteri uygulamasında canlı
// harita/ETA/iletişim butonunun görünmesi bu alana bağlı.
ensureColumn('cleaning_jobs', 'headed_out_at', 'TEXT');

// --- Checklist maddelerine dil bazli sutunlar (migration) ---------------
// Eskiden "item_text" tek dildeydi (Turkce varsayilan). Artik 3 ayri
// sutun var. Mevcut veriler otomatik olarak Turkce sutununa tasinir.
// ONEMLI: bu fonksiyon her sunucu baslangicinda calisir (idempotent) -
// sutunlar zaten varsa ensureColumn (yukarida tanimli) sessizce atlar.
function ensureChecklistLangColumns() {
  ensureColumn('service_checklists', 'item_text_tr', 'TEXT');
  ensureColumn('service_checklists', 'item_text_en', 'TEXT');
  ensureColumn('service_checklists', 'item_text_me', 'TEXT');
  ensureColumn('service_checklists', 'item_text_ru', 'TEXT');
  // Eski "item_text" sutunundaki mevcut veriyi Turkce sutununa tasi
  // (sadece henuz tasinmamis satirlar icin).
  db.exec(`
    UPDATE service_checklists
    SET item_text_tr = item_text
    WHERE item_text_tr IS NULL AND item_text IS NOT NULL
  `);
}
ensureChecklistLangColumns();

// --- Fiyatlandırma varsayımlarını bir kez tohumla ---------------------------
// Tablo boşsa (ilk kurulum) kod içindeki başlangıç değerlerini ekler - admin
// panelinde "boş" değil, mevcut gerçek değerlerle karşılaşır. Zaten bir
// değer varsa (admin daha önce değiştirmişse) dokunulmaz.
const DEFAULT_PRICING = {
  // Yeni model: "X m²'ye kadar" sabit fiyat (flatPrice), üstü için m²
  // başına ek ücret (extraRate).
  'checkin_checkout.thresholdSqm': 50, 'checkin_checkout.flatPrice': 35, 'checkin_checkout.extraRate': 0.30, 'checkin_checkout.min': 30, 'checkin_checkout.estimatedMinutes': 60,
  'deep_clean.thresholdSqm': 60, 'deep_clean.flatPrice': 55, 'deep_clean.extraRate': 0.50, 'deep_clean.min': 45, 'deep_clean.estimatedMinutes': 150,
  'office.thresholdSqm': 50, 'office.flatPrice': 35, 'office.extraRate': 0.25, 'office.min': 40, 'office.estimatedMinutes': 90,
  'staircase.base': 15, 'staircase.ratePerFloor': 4, 'staircase.min': 25, 'staircase.estimatedMinutes': 40,
  'corridor.base': 12, 'corridor.ratePerSqm': 0.3, 'corridor.ratePerFloor': 3, 'corridor.min': 30, 'corridor.estimatedMinutes': 35,
  'elevator.base': 12, 'elevator.ratePerCapacity': 1.4, 'elevator.min': 20, 'elevator.estimatedMinutes': 20,
  'carpet.rate': 18, 'upholstery.rate': 22,
  'supplies.noEquipment': 15, 'supplies.noChemicals': 10,
  'system.commissionRate': 0.20, 'system.payoutCycleDays': 15,
  'marketing.dormantThresholdDays': 45,
};
const seedPricing = db.prepare('INSERT OR IGNORE INTO pricing_settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_PRICING)) {
  seedPricing.run(key, value);
}

// --- Tekne (yelkenli) mulk kategorisi icin sema guncellemesi -------------
// ONEMLI: 'category' sutununda bir CHECK constraint var, bu da SQLite'da
// basit bir ALTER TABLE ADD COLUMN ile degistirilemez (SQLite CHECK
// constraint'leri dogrudan degistirmeyi desteklemiyor). Bu yuzden tabloyu
// guvenle yeniden olusturup mevcut veriyi tasiyoruz. IDEMPOTENT'tir -
// constraint zaten 'boat' iceriyorsa (yeni kurulan bir veritabaninda oldugu
// gibi) hicbir sey yapmadan gecer.
//
// KRITIK DUZELTME: Ilk yazilan surumde, orijinal 'properties' tablosu
// dogrudan RENAME ediliyordu (properties -> properties_old). SQLite'in
// DOKUMANTE EDILMIS ama az bilinen bir davranisi var: bir tablo RENAME
// edildiginde, SQLite o tabloya FOREIGN KEY ile referans veren TUM DIGER
// tablolarin (bizim durumumuzda cleaning_jobs, property_delegates)
// semasindaki REFERENCES ifadesini de OTOMATIK OLARAK yeni isme guncelliyor.
// Yani cleaning_jobs.property_id'nin "REFERENCES properties(id)" ifadesi
// sessizce "REFERENCES properties_old(id)" oluveriyor - biz properties_old'u
// silince bu referans askida kaliyor ve cleaning_jobs'a INSERT yapilamaz hale
// geliyordu ("no such table: main.properties_old" hatasi). Gercek bir
// veritabaniyla (property_delegates FK'li) test ederken bu hatayi yakaladik.
//
// DUZELTME: Orijinal 'properties' tablosunu HIC RENAME ETMIYORUZ. Onun
// yerine yeni semali tabloyu FARKLI bir gecici isimle (properties_new)
// olusturup veriyi orijinal isimden (hala 'properties') kopyaliyoruz,
// orijinali DROP ediyoruz (DROP, RENAME'in aksine baska tablolarin FK
// referanslarini degistirmiyor), sonra yeni tabloyu doğru isme tasiyoruz.
// Bu son adimdaki RENAME hicbir tabloyu etkilemiyor cunku hicbir tablo
// 'properties_new' adina referans vermiyor - cleaning_jobs'un referansi
// (hic degismeden hep "properties" yazan) bu son adimdan sonra otomatik
// olarak gecerli hale geliyor. Gercek veri + FK'li tablolarla test edildi.
function migratePropertiesForBoatCategory() {
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='properties'`).get();
  if (!tableInfo || (tableInfo.sql && tableInfo.sql.includes("'boat'"))) {
    return; // tablo yok (ilk kurulum, CREATE TABLE zaten guncel) ya da constraint zaten guncel
  }
  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE properties_new (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'apartment' CHECK (category IN ('apartment','house','office','common_area','boat')),
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
        bedroom_count INTEGER,
        bathroom_count INTEGER,
        boat_class TEXT,
        boat_type TEXT,
        cabin_count INTEGER,
        length_ft REAL,
        has_canvas INTEGER,
        berth_number TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO properties_new
        (id, owner_id, name, category, building_name, address, city, latitude, longitude,
         size_sqm, floor_count, sqm_per_floor, elevator_capacity, ical_url,
         bedroom_count, bathroom_count, created_at)
      SELECT id, owner_id, name, category, building_name, address, city, latitude, longitude,
             size_sqm, floor_count, sqm_per_floor, elevator_capacity, ical_url,
             bedroom_count, bathroom_count, created_at
      FROM properties;
    `);
    db.exec(`DROP TABLE properties;`);
    db.exec(`ALTER TABLE properties_new RENAME TO properties;`);
  });
  migrate();
  db.pragma('foreign_keys = ON');
}
migratePropertiesForBoatCategory();

// --- Super Admin sistemi -----------------------------------------------
// Sadece TEK bir admin, "her seye gucu yeten" (musteri/siparis silme, diger
// adminleri silme/sifresini sifirlama) yetkisine sahip olmali. Bu, Railway'de
// SUPER_ADMIN_USERNAME environment variable'i ile belirleniyor - kod
// icinde SABIT/hardcoded degil, boylece kim oldugu istenirse Railway
// panelinden degistirilebilir, kod degisikligi gerekmez.
// ONEMLI: Bu fonksiyon her sunucu baslangicinda calisir (idempotent) -
// belirtilen kullanici adina sahip admin varsa ONA is_super_admin=1 verir,
// DIGER TUM adminlerin is_super_admin'ini 0'a ceker (aynı anda birden
// fazla super admin olmasi engellenir). SUPER_ADMIN_USERNAME hic
// tanimlanmamissa ya da eslesen bir admin yoksa, HICBIR admin super admin
// olmaz (sessizce atlanir) - bu, yanlislikla herkesin yetkisiz kalmasindan
// iyidir, hatali/bos bir env var yuzunden yanlis kisiye yetki verilmesindense.
function ensureSuperAdmin() {
  ensureColumn('users', 'is_super_admin', 'INTEGER NOT NULL DEFAULT 0');
  const targetUsername = (process.env.SUPER_ADMIN_USERNAME || '').trim();
  db.exec(`UPDATE users SET is_super_admin = 0 WHERE account_type = 'admin'`);
  if (targetUsername) {
    const result = db
      .prepare(`UPDATE users SET is_super_admin = 1 WHERE account_type = 'admin' AND username = ?`)
      .run(targetUsername);
    if (result.changes === 0) {
      console.warn(`[UYARI] SUPER_ADMIN_USERNAME="${targetUsername}" ile eslesen bir admin hesabi bulunamadi - hicbir admin super admin degil.`);
    }
  } else {
    console.warn('[UYARI] SUPER_ADMIN_USERNAME environment variable tanimlanmamis - hicbir admin super admin degil.');
  }
}
ensureSuperAdmin();

// --- Tekne fiyat teklifi icin ayri chat kanali ---------------------------
// chat_messages tablosu simdiye kadar tek bir "genel destek" akisi
// tutuyordu. Tekne temizligi >=50ft icin "Fiyat Teklifi Al" butonunun genel
// destek kutusuna DEGIL, ayri bir gelen kutusuna dusmesi icin bir "channel"
// sutunu ekliyoruz. Mevcut TUM eski mesajlar (kolon eklenmeden once
// yazilmis) varsayilan olarak 'support' kanalina ait sayilir - bu, geriye
// donuk uyumlulugu bozmaz, eski destek gecmisi oldugu gibi "Destek"
// sekmesinde gorunmeye devam eder.
ensureColumn('chat_messages', 'channel', "TEXT NOT NULL DEFAULT 'support'");

// --- Eski kayitlarda "gizlice cevrilmis" mulk isimlerini temizleme -------
// GECMISTE (bu dosyadaki mevcut duzeltmelerden ONCE), musteri kayit
// sirasinda mulk ismi bos birakirsa, o anki dilde CEVRILMIS kategori adi
// (orn. "Apartman Dairesi") dogrudan 'name' sutununa YAZILIYORDU. Bu,
// musteri sonradan dili degistirdiginde mulk basligi hep ilk kayit dilinde
// KALICI kalmasina yol aciyordu (kategori metni dogru cevriliyor olsa bile,
// baslik cevrilmiyordu). Frontend'de bu artik duzeltildi (yeni kayitlarda
// isim bos birakilirsa 'name' bos string olarak kaydediliyor, ekranda ANLIK
// olarak dile gore cevrilen kategori adi gosteriliyor) - ama ESKI kayitlarda
// hala bu "donmus" ceviri metni duruyor olabilir. Bu migration, name alani
// TAM OLARAK bilinen 4 dildeki (TR/EN/ME/RU) kategori etiketlerinden birine
// esit olan satirlari bulup bos stringe cevirir - boylece onlar da artik
// ANLIK/dinamik cevrilen kategori adini gosterir. IDEMPOTENT'tir (bir kez
// temizlenen bir satir ikinci calistirmada zaten eslesmez).
function clearBakedInTranslatedPropertyNames() {
  const knownCategoryLabels = [
    // Turkce
    'Apartman Dairesi', 'Müstakil Ev / Villa', 'Ofis / İşyeri', 'Ortak Alan (Bina geneli)', 'Tekne (Yelkenli)',
    // Ingilizce
    'Apartment', 'House/Villa', 'Office/Shop', 'Common Area (Whole Building)', 'Boat (Sailboat)',
    // Karadagca
    'Stan', 'Kuća/Villa', 'Poslovni prostor', 'Zajednički prostor (cijela zgrada)', 'Brod (Jedrilica)',
    // Rusca
    'Квартира', 'Дом / Вилла', 'Офис / Рабочее место', 'Общая зона (всё здание)', 'Лодка (Парусная)',
  ];
  const placeholders = knownCategoryLabels.map(() => '?').join(',');
  const result = db
    .prepare(`UPDATE properties SET name = '' WHERE name IN (${placeholders})`)
    .run(...knownCategoryLabels);
  if (result.changes > 0) {
    console.log(`[BILGI] ${result.changes} eski mulk kaydinda donmus/baked-in kategori adi temizlendi (artik dinamik cevrilecek).`);
  }
}
clearBakedInTranslatedPropertyNames();

// --- Push kampanyalari (pazarlama/promosyon anlik gonderimleri) ---------
// Admin panelinden secilen bir kitleye (tumu/bireysel/sirket/sehir) anlik
// push bildirimi gonderildiginde, gecmis/kayit amacli buraya yaziliyor.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_campaigns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'all' CHECK (target_type IN ('all','individual','company')),
    target_city TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0,
    created_by_admin_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Bir musteriye EN SON ne zaman "kullanmayan musteri" hatirlatma push'u
// gonderdigimizi tutar - ayni kisiye her gun/her kontrolde tekrar tekrar
// gondermemek icin (bkz. services/reengagement.js).
ensureColumn('users', 'last_reengagement_push_at', 'TEXT');

// Bir siparisin ADMIN tarafindan (musteri adina, orn. telefonla gelen bir
// talep icin) olusturulup olusturulmadigini izlemek icin. NULL ise siparis
// musterinin kendisi tarafindan olusturulmustur (normal akis).
ensureColumn('cleaning_jobs', 'created_by_admin_id', 'TEXT');

// --- ONARIM: eski (hatali) migration'in birakip gittigi bozuk FK'lar -----
// GECMISTE (bu dosyanin daha eski bir surumunde), tekne kategorisi icin
// yazilan migration 'properties' tablosunu DOGRUDAN RENAME ediyordu
// (properties -> properties_old). SQLite'in az bilinen bir davranisi geregi,
// bu RENAME islemi, properties'e FOREIGN KEY ile referans veren DIGER
// tablolarin (cleaning_jobs, property_delegates) sema metnini de OTOMATIK
// OLARAK "properties_old" olarak GUNCELLIYORDU. O migration duzeltildi
// (artik boyle bir sorun YARATMIYOR) ama DAHA ONCE bu hatali surumle
// calismis olan veritabanlarinda, cleaning_jobs/property_delegates HALA
// var olmayan "properties_old" tablosuna isaret ediyor olabilir - bu da
// o tablolara INSERT/UPDATE yapan HER ISLEMDE "no such table:
// main.properties_old" hatasina yol aciyordu (musteri/siparis silme,
// yeni siparis olusturma vb.).
//
// Bu onarim, HANGI tablolarin etkilendigini OTOMATIK bulup (sqlite_master
// taramasi), o tablolarin MEVCUT tam semasini (tum kolonlar/kisitlar/
// varsayilanlar OLDUGU GIBI) koruyarak, SADECE bozuk referansi duzeltip
// yeniden olusturuyor - hicbir veri kaybi olmuyor. IDEMPOTENT'tir (zaten
// saglikli bir veritabaninda hicbir sey yapmadan gecer). Gercek veri +
// FK'li kayitlarla test edildi.
function repairDanglingPropertiesOldReferences() {
  const affected = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%properties_old%'`)
    .all();
  if (affected.length === 0) return;

  console.log(`[ONARIM] ${affected.length} tabloda bozuk 'properties_old' referansi bulundu, onariliyor:`, affected.map((a) => a.name).join(', '));
  db.pragma('foreign_keys = OFF');
  const repair = db.transaction(() => {
    for (const { name, sql } of affected) {
      const tempName = `${name}_repaired_tmp`;
      const fixedSql = sql
        .replace(new RegExp(`CREATE TABLE\\s+"?${name}"?`, 'i'), `CREATE TABLE "${tempName}"`)
        .replace(/properties_old/g, 'properties');
      db.exec(fixedSql);
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => `"${c.name}"`).join(', ');
      db.exec(`INSERT INTO "${tempName}" (${columns}) SELECT ${columns} FROM "${name}"`);
      db.exec(`DROP TABLE "${name}"`);
      db.exec(`ALTER TABLE "${tempName}" RENAME TO "${name}"`);
      console.log(`[ONARIM] ${name} tablosu onarildi.`);
    }
  });
  repair();
  db.pragma('foreign_keys = ON');
}
repairDanglingPropertiesOldReferences();
