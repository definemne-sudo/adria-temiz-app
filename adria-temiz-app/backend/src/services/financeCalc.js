const db = require('../db');
const { calcNetEarning, getPayoutCycleDays } = require('./catalog');

// ONEMLI: SQLite'in date(completed_at) fonksiyonu HER ZAMAN UTC kullanir.
// Bu yuzden JS tarafinda "bugun" / "donem sinirlari" hesaplanirken de
// mutlaka UTC metodlari (getUTCFullYear, getUTCDate vb.) kullanilmali.
// Yerel saat dilimi metodlari (getFullYear, getDate) kullanilirsa, sunucu
// UTC disinda bir saat diliminde calisiyorsa ya da gun sinirina yakin bir
// anda calisilirsa, JS'in "bugun" dedigi tarih ile SQL'in "bugun" dedigi
// tarih bir gun kayabilir - bu da bugun tamamlanan bir isin, hesaplanan
// donem araligina hic girmemesine (ve o donemin sifir gorunmesine) yol
// acar. Bu fonksiyon artik SADECE UTC kullaniyor.
function toDateKey(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function round2(n) { return Math.round(n * 100) / 100; }

// Bir personelin belirli bir tarih aralığındaki TÜM finansal kırılımını
// hesaplar. Ayrım şu:
// - staffEarning: personelin bu aralıkta yaptığı işlerden GERÇEK kazancı
//   (ödeme yöntemi ne olursa olsun - nakit dahil). Personelin kendi
//   ekranındaki "Bu dönemki kazancın" kartı bunu gösterir.
// - owedToStaff / owedToBusiness / netSettlement: MUTABAKAT - yani şu an
//   kimin kimde parası var, kim kime ne kadar ödeyecek. Nakit işlerde para
//   zaten personelde olduğu için o iş için "owedToStaff" ARTMAZ (personel
//   zaten almış) - bunun yerine personel, o işin komisyon payını işletmeye
//   borçlanır (owedToBusiness). Bu yüzden tamamen nakit bir dönemde
//   netSettlement 0 ya da negatif çıkabilir - bu bir hata değil, personel
//   parayı zaten elden aldığı için işletmenin ayrıca ödeyecek bir şeyi
//   kalmamış demektir. "Kazanç" ile "mutabakat" kasıtlı olarak FARKLI
//   iki rakamdır.
function calcStaffRange(staffId, startKey, endKey) {
  const jobs = db
    .prepare(`SELECT price, net_price, vat_amount, payment_method FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done' AND date(completed_at) BETWEEN ? AND ?`)
    .all(staffId, startKey, endKey);
  let owedToStaff = 0, owedToBusiness = 0;
  let grossRevenue = 0, cashHeld = 0, cardHeld = 0, staffEarning = 0, businessEarning = 0, businessVat = 0;
  jobs.forEach((j) => {
    // ONEMLI: netBase = KDV HARIC tutar (eski siparislerde net_price NULL -
    // o zaman price zaten KDV eklenmeden hesaplanmisti, dogrudan kullanilir).
    // MICISTO'nun GERCEK kazanci (businessEarning/commission) SADECE bu net
    // taban uzerinden hesaplanir - KDV, MICISTO'nun parasi degil, devlete
    // gecici olarak tutulan bir tutardir (ayrica businessVat'ta izlenir).
    const netBase = j.net_price != null ? j.net_price : j.price;
    const vat = j.vat_amount != null ? j.vat_amount : 0;
    const net = calcNetEarning(netBase);
    const commission = netBase - net;
    grossRevenue += j.price;
    staffEarning += net;
    businessEarning += commission;
    businessVat += vat;
    if (j.payment_method === 'cash') {
      cashHeld += j.price;
      // Nakit iste personel MUSTERIDEN TOPLAMI (KDV dahil j.price) topluyor,
      // bize hem komisyonumuzu HEM DE devlete odeyecegimiz KDV'yi borclanir.
      owedToBusiness += (commission + vat);
    } else {
      cardHeld += j.price;
      owedToStaff += net;
    }
  });
  return {
    jobCount: jobs.length,
    grossRevenue: round2(grossRevenue),
    cashHeld: round2(cashHeld),
    cardHeld: round2(cardHeld),
    staffEarning: round2(staffEarning),
    businessEarning: round2(businessEarning),
    businessVat: round2(businessVat),
    owedToStaff: round2(owedToStaff),
    owedToBusiness: round2(owedToBusiness),
    netSettlement: round2(owedToStaff - owedToBusiness),
  };
}

// Personelin ilk tamamladığı işten bugüne kadar, 15 günlük pencereler
// halinde ödeme dönemlerini üretir (canlı hesaplanır, saklanmaz - sadece
// "ödendi" işareti staff_payment_marks'ta tutulur). En yeni dönem en başta.
// Bu işaret, admin panelinden ("Ödendi İşaretle") ya da MICISTORad'dan
// ("Ödememi Aldım") - hangisinden gelirse gelsin AYNI kayda yazılır, iki
// taraf da aynı gerçeği görür.
function getStaffPeriods(staffId) {
  const firstJob = db
    .prepare(`SELECT MIN(date(completed_at)) AS d FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done'`)
    .get(staffId);
  if (!firstJob.d) return [];

  const periods = [];
  const cycleDays = getPayoutCycleDays();
  // 'Z' eki ile UTC olarak parse ediyoruz (aksi halde JS bunu yerel saat
  // dilimiyle yorumlar - sunucu UTC disindaysa firstJob.d'nin gunu kayabilir).
  let periodStart = new Date(firstJob.d + 'T00:00:00Z');
  const today = new Date();
  while (periodStart <= today) {
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + cycleDays - 1);
    const startKey = toDateKey(periodStart);
    const endKey = toDateKey(periodEnd);
    const stats = calcStaffRange(staffId, startKey, endKey);
    const mark = db.prepare('SELECT * FROM staff_payment_marks WHERE staff_id = ? AND period_start = ?').get(staffId, startKey);
    periods.push({
      periodStart: startKey, periodEnd: endKey, ...stats,
      isPaid: !!mark, paidAt: mark ? mark.paid_at : null,
    });
    periodStart.setUTCDate(periodStart.getUTCDate() + cycleDays);
  }
  return periods.reverse();
}

function getStaffLifetimeTotal(staffId) {
  const allJobs = db.prepare(`SELECT price, net_price FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done'`).all(staffId);
  return round2(allJobs.reduce((sum, j) => sum + calcNetEarning(j.net_price != null ? j.net_price : j.price), 0));
}

module.exports = { toDateKey, round2, calcStaffRange, getStaffPeriods, getStaffLifetimeTotal };
