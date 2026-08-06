const db = require('../db');

// Personel (ya da admin) hesabı aktive edildiğinde/oluşturulduğunda kalıcı
// bir kullanıcı adı + şifre üretir. Hem auth.js (personelin kendi telefon
// aktivasyonu) hem admin route'ları (admin'in başvuru onaylayıp yeni
// personel hesabı açması) bu modülü kullanır - tek doğru kaynak.
function slugifyName(name) {
  return (name || 'kullanici')
    .toLowerCase()
    .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıİ]/g, 'i')
    .replace(/[öÖ]/g, 'o').replace(/[şŞ]/g, 's').replace(/[üÜ]/g, 'u')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'kullanici';
}

function generateUsername(name) {
  const base = slugifyName(name);
  for (let i = 0; i < 20; i++) {
    const candidate = base + Math.floor(100 + Math.random() * 900);
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(candidate);
    if (!exists) return candidate;
  }
  return base + Date.now();
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = { slugifyName, generateUsername, generatePassword };
