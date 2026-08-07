const webpush = require('web-push');
const db = require('../db');

// NOT: Bu anahtarlar geliştirme için otomatik üretildi. Prod'a çıkarken
// Railway'de VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variable
// olarak ayarlanmalı (sabit kalmalı - değişirse tüm eski abonelikler geçersiz olur).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
  || 'BMB7_niCe10PvCqP7Ud6-g8AeVNJemyMqvh3v0glQZrppwsGngKWTvuCQVs3Q7IJB2XF4mZLTSnwIIKpu4mvvBQ';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
  || '1vVA2UsQJ4w1TiLedZuvoJn3DPOAWqZAMzUjs-TdM8A';

webpush.setVapidDetails('mailto:destek@micisto.me', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function getSubscriptionsForUser(userId) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
}

// Bir personele push bildirimi gönderir (tüm kayıtlı cihazlarına). Tarayıcı
// kapalıysa bile (desteklenen platformlarda) bildirim gelir; abonelik artık
// geçersizse (kullanıcı bildirimi kapatmış/uygulamayı kaldırmış) o kaydı
// veritabanından temizler.
async function sendPushToUser(userId, payload) {
  const subs = getSubscriptionsForUser(userId);
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      ).catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        }
        throw err;
      })
    )
  );
  return results;
}

async function sendPushToUsers(userIds, payload) {
  await Promise.allSettled(userIds.map((id) => sendPushToUser(id, payload)));
}

module.exports = { sendPushToUser, sendPushToUsers, VAPID_PUBLIC_KEY };
