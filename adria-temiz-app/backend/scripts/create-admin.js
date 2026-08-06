// İlk MICISTOMan (admin) hesabını oluşturur. Elle, bir kereye mahsus
// çalıştırılır - admin hesapları self-servis açılmıyor (güvenlik).
//
// Kullanım (backend klasöründen):
//   node scripts/create-admin.js "Ad Soyad" "kullaniciadi" "sifre"
//
// Örnek:
//   node scripts/create-admin.js "Ana Yönetici" "ana.admin" "GucluBirSifre123"
//
// Railway'de çalıştırmak için: Railway dashboard -> servis -> "Shell" sekmesi
// -> yukarıdaki komutu orada çalıştır (canlı veritabanına yazar).

const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../src/db');

const [, , name, username, password] = process.argv;

if (!name || !username || !password) {
  console.error('Kullanım: node scripts/create-admin.js "Ad Soyad" "kullaniciadi" "sifre"');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  console.error(`"${username}" kullanıcı adı zaten alınmış.`);
  process.exit(1);
}

const id = uuid();
const passwordHash = bcrypt.hashSync(password, 10);
// Admin hesabının da bir telefon numarası olması şart (users.phone UNIQUE
// NOT NULL) - gerçek bir numara değilse bile benzersiz bir yer tutucu veriyoruz.
const placeholderPhone = `admin-${id.slice(0, 8)}`;

db.prepare(
  `INSERT INTO users (id, phone, name, account_type, username, password_hash, profile_completed)
   VALUES (?, ?, ?, 'admin', ?, ?, 1)`
).run(id, placeholderPhone, name, username, passwordHash);

console.log('Admin hesabı oluşturuldu:');
console.log('  Kullanıcı adı:', username);
console.log('  Şifre:', password);
console.log('Bu bilgilerle MICISTOMan üzerinden giriş yapabilirsin.');
