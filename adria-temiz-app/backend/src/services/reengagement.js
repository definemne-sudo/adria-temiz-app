const db = require('../db');
const { sendPushToUser } = require('./push');
const { getPricingValue } = require('./catalog');

// Ayni musteriye en fazla bu kadar gunde bir kez hatirlatma gonderiyoruz -
// esik degerinin kendisi (45 gun vb.) admin tarafindan ayarlanabilir olsa
// da, "tekrar gonderim sikligi" sabit ve makul bir deger (30 gun) - cok
// sik hatirlatma musteriyi rahatsiz edip tam tersi etki yaratabilir.
const REENGAGEMENT_COOLDOWN_DAYS = 30;

function getDormantThresholdDays() {
  const value = getPricingValue('marketing.dormantThresholdDays');
  return value && value > 0 ? value : 45;
}

// "Kullanmayan musteri" = en az 1 tamamlanmis siparisi olan ama SON
// siparisinin uzerinden esik gunden fazla zaman gecmis musteri. Ayni
// kisiye COOLDOWN suresi dolmadan tekrar gonderilmiyor (last_reengagement_
// push_at kontrolu). Bu fonksiyon server.js'ten periyodik (gunde birkac
// kez yeterli - dakikalik hassasiyet gerekmiyor) cagrilir.
async function checkDormantCustomers() {
  const thresholdDays = getDormantThresholdDays();

  const dormantCustomers = db
    .prepare(
      `SELECT u.id, u.name, MAX(j.completed_at) AS lastJobDate
       FROM users u
       JOIN properties p ON p.owner_id = u.id
       JOIN cleaning_jobs j ON j.property_id = p.id
       WHERE u.account_type IN ('individual','company')
         AND j.status IN ('done','confirmed')
       GROUP BY u.id
       HAVING lastJobDate IS NOT NULL
          AND (julianday('now') - julianday(lastJobDate)) > ?
          AND (u.last_reengagement_push_at IS NULL OR (julianday('now') - julianday(u.last_reengagement_push_at)) > ?)`
    )
    .all(thresholdDays, REENGAGEMENT_COOLDOWN_DAYS);

  for (const cust of dormantCustomers) {
    try {
      await sendPushToUser(cust.id, {
        title: 'Seni özledik! 💚',
        body: 'Uzun zamandır bizi tercih etmedin - yeni bir temizlik talebi oluşturmaya ne dersin?',
        type: 'reengagement',
      });
    } catch (err) {
      console.error('Reengagement push hata:', err);
    }
    // Push basarisiz olsa bile (orn. abonelik yoksa) deneme tarihini
    // isaretliyoruz - yoksa abonesi olmayan bir kullanici icin fonksiyon
    // HER calistiginda tekrar tekrar denenir durur.
    db.prepare(`UPDATE users SET last_reengagement_push_at = datetime('now') WHERE id = ?`).run(cust.id);
  }

  return dormantCustomers.length;
}

module.exports = { checkDormantCustomers, getDormantThresholdDays, REENGAGEMENT_COOLDOWN_DAYS };
