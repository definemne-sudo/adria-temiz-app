const db = require('../db');

/**
 * Yapısal hizmet tanımları (isim, açıklama, hangi hesap tipine gösterileceği,
 * parametre tipi) kodda sabit - bunlar nadiren değişir. Fiyatlandırma
 * (base/rate/min/estimatedMinutes vb.) ise pricing_settings tablosundan canlı
 * okunuyor - MICISTOMan > Hizmetler & Fiyatlandırma ekranından admin
 * tarafından değiştirilebilir, kod değişikliği/deploy gerektirmez.
 */
const SERVICE_DEFS = [
  {
    key: 'checkin_checkout',
    name: 'Airbnb/Booking Temizliği',
    description: 'Misafir çıkışı ve girişi arasında hızlı, standart temizlik.',
    accountTypes: ['individual', 'company'],
  },
  {
    key: 'deep_clean',
    name: 'Detaylı temizlik',
    description: 'Dolap içi, fırın, cam gibi detayları kapsayan kapsamlı temizlik.',
    accountTypes: ['individual'],
  },
  {
    key: 'office',
    name: 'Ofis / Dükkan / Çalışma Alanı Temizliği',
    description: 'Çalışma alanları için düzenli veya tek seferlik temizlik.',
    accountTypes: ['individual', 'company'],
  },
  {
    key: 'common_area',
    name: 'Ortak Alan Temizliği',
    description: 'Merdiven, kat koridoru ve asansör temizliğinden istediklerini seç.',
    isGroup: true, // fiyat sabit değil, alt seçimlere göre hesaplanır
    accountTypes: ['company'],
  },
];

const COMMON_AREA_SUB_DEFS = [
  {
    key: 'staircase',
    name: 'Merdiven Temizliği',
    description: 'Bina merdivenlerinin düzenli temizliği, kat sayısına göre fiyatlanır.',
    paramType: 'floors', // { floorCount }
  },
  {
    key: 'corridor',
    name: 'Kat Koridoru Temizliği',
    description: 'Kat koridorlarının temizliği, kat sayısı ve kat başına m²ye göre fiyatlanır.',
    paramType: 'corridor', // { floorCount, sqmPerFloor }
  },
  {
    key: 'elevator',
    name: 'Asansör Temizliği',
    description: 'Asansör kabini temizliği, kişi kapasitesine göre fiyatlanır.',
    paramType: 'elevator', // { elevatorCapacity }
  },
];

const ADDON_DEFS = [
  { key: 'carpet', name: 'Halı yıkama', unitLabel: 'adet' },
  { key: 'upholstery', name: 'Koltuk yıkama', unitLabel: 'adet' },
];

// MICISTO'nun her tamamlanan işten aldığı komisyon oranı - personel
// kazancı hesaplanırken bu düşülür. Artık pricing_settings tablosundan
// (MICISTOMan > Settings ekranından) canlı okunuyor - fonksiyon olarak,
// GETTER SERVICES/ADDONS'ta yaşadığımız "sunucu açılışında donma" hatasına
// tekrar düşmemek için (bkz. services.js geçmişi) her yerde
// getCommissionRate() ÇAĞRISI kullanılmalı, sabit bir değişkene
// destructure edilip saklanmamalı.
function getCommissionRate() {
  return getPricingValue('system.commissionRate', 0.20);
}

// Personel ödemelerinin kaç günde bir dönemlere bölüneceği (varsayılan 15).
function getPayoutCycleDays() {
  return getPricingValue('system.payoutCycleDays', 15);
}

function getPricingValue(key, fallback = 0) {
  const row = db.prepare('SELECT value FROM pricing_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

// Bir hizmetin görev listesini (checklist) döner - hem admin panelinden
// yönetiliyor hem artık müşteri uygulamasında "Checklist'i Gör" ekranında
// gösteriliyor.
function getChecklist(serviceKey) {
  return db
    .prepare('SELECT id, item_text, sort_order FROM service_checklists WHERE service_key = ? ORDER BY sort_order ASC, created_at ASC')
    .all(serviceKey);
}

// Yapısal tanımı + canlı fiyatlandırmayı birleştirip tek bir nesne döner.
function getService(key) {
  const def = SERVICE_DEFS.find((s) => s.key === key);
  if (!def) throw new Error('Geçersiz hizmet türü.');
  if (def.isGroup) return def;
  return {
    ...def,
    // Yeni fiyatlandırma modeli: "X m²'ye kadar" sabit fiyat, üstü için
    // m² başına ek ücret. Eski base/rate modelinden farklı - müşteri
    // mülkünün büyüklüğüne göre net, anlaşılır bir fiyat mantığı.
    thresholdSqm: getPricingValue(`${key}.thresholdSqm`),
    flatPrice: getPricingValue(`${key}.flatPrice`),
    extraRate: getPricingValue(`${key}.extraRate`),
    min: getPricingValue(`${key}.min`),
    estimatedMinutes: getPricingValue(`${key}.estimatedMinutes`),
    checklist: getChecklist(key),
  };
}

function getCommonAreaSubOption(key) {
  const def = COMMON_AREA_SUB_DEFS.find((s) => s.key === key);
  if (!def) throw new Error('Geçersiz ortak alan alt seçeneği.');
  return {
    ...def,
    base: getPricingValue(`${key}.base`),
    ratePerFloor: getPricingValue(`${key}.ratePerFloor`),
    ratePerSqm: getPricingValue(`${key}.ratePerSqm`),
    ratePerCapacity: getPricingValue(`${key}.ratePerCapacity`),
    min: getPricingValue(`${key}.min`),
    estimatedMinutes: getPricingValue(`${key}.estimatedMinutes`),
    checklist: getChecklist(key),
  };
}

function getAddon(key) {
  const def = ADDON_DEFS.find((a) => a.key === key);
  if (!def) throw new Error('Geçersiz ekstra hizmet.');
  return { ...def, rate: getPricingValue(`${key}.rate`), checklist: getChecklist(key) };
}

function getAllServices() {
  return SERVICE_DEFS.map((s) => getService(s.key));
}
function getAllCommonAreaSubOptions() {
  return COMMON_AREA_SUB_DEFS.map((s) => getCommonAreaSubOption(s.key));
}
function getAllAddons() {
  return ADDON_DEFS.map((a) => getAddon(a.key));
}
function getSuppliesFees() {
  return {
    noEquipment: getPricingValue('supplies.noEquipment'),
    noChemicals: getPricingValue('supplies.noChemicals'),
  };
}

function calcPrice(serviceKey, { sizeSqm } = {}) {
  const service = getService(serviceKey);
  const sqm = Number(sizeSqm) || 0;
  const price = sqm <= service.thresholdSqm
    ? service.flatPrice
    : service.flatPrice + (sqm - service.thresholdSqm) * service.extraRate;
  return Math.max(service.min, Math.round(price / 5) * 5);
}

// Tek bir ortak alan alt seçeneğinin fiyatı. Sabit bir "başlangıç ücreti"
// yok, bilerek - admin panelinde tek bir parametreye karşılık tek bir
// birim fiyat girilsin diye (kat sayısı × kat başına ücret gibi).
function calcCommonAreaSubPrice(key, params = {}) {
  const sub = getCommonAreaSubOption(key);
  let price = 0;
  if (sub.paramType === 'floors') {
    price += (Number(params.floorCount) || 0) * sub.ratePerFloor;
  } else if (sub.paramType === 'corridor') {
    const floors = Number(params.floorCount) || 0;
    const sqmPerFloor = Number(params.sqmPerFloor) || 0;
    price += (floors * sqmPerFloor) * sub.ratePerSqm;
  } else if (sub.paramType === 'elevator') {
    price += (Number(params.elevatorCapacity) || 0) * sub.ratePerCapacity;
  }
  return Math.max(sub.min, Math.round(price / 5) * 5);
}

// selections: [{ key, floorCount?, sqmPerFloor?, elevatorCapacity? }]
// En az bir seçim zorunlu - hepsinin fiyatı toplanır.
function calcCommonAreaGroupTotal(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('En az bir ortak alan hizmeti seçilmeli.');
  }
  return selections.reduce((sum, sel) => sum + calcCommonAreaSubPrice(sel.key, sel), 0);
}

// addons: [{ key, quantity }]
function calcAddonsTotal(addons) {
  if (!Array.isArray(addons) || addons.length === 0) return 0;
  return addons.reduce((sum, a) => {
    const addon = getAddon(a.key);
    const qty = Math.max(1, Number(a.quantity) || 1);
    return sum + addon.rate * qty;
  }, 0);
}

function calcSuppliesFee({ hasEquipment, hasChemicals }) {
  const fees = getSuppliesFees();
  let fee = 0;
  if (!hasEquipment) fee += fees.noEquipment;
  if (!hasChemicals) fee += fees.noChemicals;
  return fee;
}

// Bir işin fiyatından MICISTO komisyonu düşüldükten sonra personele
// kalan net kazanç.
function calcNetEarning(price) {
  return Math.round(price * (1 - getCommissionRate()) * 100) / 100;
}

// Personel performans bonusu - o dönemde (hafta/ay) çalıştığı gün sayısının
// toplam gün sayısına oranına (ya da benzer bir metriğe) göre hesaplanacak.
// NOT: Gerçek formül/eşik değerleri henüz belirlenmedi - kullanıcıyla
// birlikte netleşince doldurulacak. Şimdilik her zaman 0 dönüyor, arayüzde
// bonus alanı hazır bekliyor.
function calcPerformanceBonus(completionRate, context) {
  return 0;
}

// Bir işin toplam tahmini süresi (dakika). Ortak alan siparişlerinde
// seçilen tüm alt hizmetlerin süreleri toplanır.
function estimateJobMinutes(serviceKey, serviceParams) {
  if (serviceKey === 'common_area') {
    const selections = (serviceParams && serviceParams.selections) || [];
    return selections.reduce((sum, sel) => {
      try { return sum + (getCommonAreaSubOption(sel.key).estimatedMinutes || 0); }
      catch (e) { return sum; }
    }, 0);
  }
  try { return getService(serviceKey).estimatedMinutes || 0; }
  catch (e) { return 0; }
}

module.exports = {
  // Geriye dönük uyumluluk için düz diziler de export ediliyor (mevcut
  // kodun SERVICES/COMMON_AREA_SUB_OPTIONS/ADDONS'u doğrudan kullandığı
  // yerler için) - ama bunlar artık GETTER, her erişimde canlı hesaplanıyor.
  get SERVICES() { return getAllServices(); },
  get COMMON_AREA_SUB_OPTIONS() { return getAllCommonAreaSubOptions(); },
  get ADDONS() { return getAllAddons(); },
  get SUPPLIES_FEES() { return getSuppliesFees(); },
  getCommissionRate, getPayoutCycleDays,
  getService, getAddon, getCommonAreaSubOption, getChecklist,
  getAllServices, getAllCommonAreaSubOptions, getAllAddons, getSuppliesFees,
  calcPrice, calcCommonAreaSubPrice, calcCommonAreaGroupTotal, calcAddonsTotal, calcSuppliesFee,
  calcNetEarning, estimateJobMinutes, calcPerformanceBonus,
};
