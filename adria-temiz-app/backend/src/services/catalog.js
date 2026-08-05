/**
 * Ana hizmetler: m²'ye göre fiyatlanır, "Hizmetler" ekranında kart olarak gösterilir.
 * accountTypes: bu hizmetin hangi hesap tipine gösterileceğini belirtir -
 * frontend filtrelemeyi burada tutuyoruz ki tek bir doğru kaynak olsun.
 * Ekstra hizmetler (ADDONS): halı/koltuk yıkama gibi, herhangi bir ana hizmete
 * "+" olarak eklenir, adet bazlı fiyatlanır, kendi başına ayrı bir kart değildir.
 */
const SERVICES = [
  {
    key: 'checkin_checkout',
    name: 'Airbnb/Booking Temizliği',
    description: 'Misafir çıkışı ve girişi arasında hızlı, standart temizlik.',
    base: 20,
    rate: 0.28,
    min: 30,
    estimatedMinutes: 60,
    accountTypes: ['individual', 'company'],
  },
  {
    key: 'deep_clean',
    name: 'Detaylı temizlik',
    description: 'Dolap içi, fırın, cam gibi detayları kapsayan kapsamlı temizlik.',
    base: 30,
    rate: 0.48,
    min: 45,
    estimatedMinutes: 150,
    accountTypes: ['individual'],
  },
  {
    key: 'office',
    name: 'Ofis / Dükkan / Çalışma Alanı Temizliği',
    description: 'Çalışma alanları için düzenli veya tek seferlik temizlik.',
    base: 25,
    rate: 0.22,
    min: 40,
    estimatedMinutes: 90,
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

// Ortak Alan Temizliği - yalnızca yönetim şirketi hesaplarında görünür.
// Hizmetler ekranında TEK kart olarak görünür ("common_area"), müşteri
// bunun altında istediği kadar alt seçeneği (checkbox) işaretleyip tek
// siparişte birleştirebilir. Her alt seçeneğin kendi parametresi var.
const COMMON_AREA_SUB_OPTIONS = [
  {
    key: 'staircase',
    name: 'Merdiven Temizliği',
    description: 'Bina merdivenlerinin düzenli temizliği, kat sayısına göre fiyatlanır.',
    base: 15,
    ratePerFloor: 4,
    min: 25,
    estimatedMinutes: 40,
    paramType: 'floors', // { floorCount }
  },
  {
    key: 'corridor',
    name: 'Kat Koridoru Temizliği',
    description: 'Kat koridorlarının temizliği, kat sayısı ve kat başına m²ye göre fiyatlanır.',
    base: 12,
    ratePerSqm: 0.3,
    ratePerFloor: 3,
    min: 30,
    estimatedMinutes: 35,
    paramType: 'corridor', // { floorCount, sqmPerFloor }
  },
  {
    key: 'elevator',
    name: 'Asansör Temizliği',
    description: 'Asansör kabini temizliği, kişi kapasitesine göre fiyatlanır.',
    base: 12,
    ratePerCapacity: 1.4,
    min: 20,
    estimatedMinutes: 20,
    paramType: 'elevator', // { elevatorCapacity }
  },
];

const ADDONS = [
  { key: 'carpet', name: 'Halı yıkama', rate: 18, unitLabel: 'adet' },
  { key: 'upholstery', name: 'Koltuk yıkama', rate: 22, unitLabel: 'adet' },
];

// Müşteride temizlik aracı/kimyasalı yoksa uygulanan ek ücret.
// NOT: Bu rakamlar başlangıç varsayımı - gerçek maliyet verisi geldikçe
// birlikte ayarlanacak (kullanıcıyla konuşulduğu üzere).
const SUPPLIES_FEES = {
  noEquipment: 15,
  noChemicals: 10,
};

// MICISTO'nun her tamamlanan işten aldığı komisyon oranı - personel
// kazancı hesaplanırken bu düşülür. NOT: Başlangıç varsayımı (%20),
// gerçek iş modeli netleşince birlikte ayarlanacak.
const COMMISSION_RATE = 0.20;

function getService(key) {
  const service = SERVICES.find((s) => s.key === key);
  if (service) return service;
  throw new Error('Geçersiz hizmet türü.');
}

function getCommonAreaSubOption(key) {
  const sub = COMMON_AREA_SUB_OPTIONS.find((s) => s.key === key);
  if (!sub) throw new Error('Geçersiz ortak alan alt seçeneği.');
  return sub;
}

function getAddon(key) {
  const addon = ADDONS.find((a) => a.key === key);
  if (!addon) throw new Error('Geçersiz ekstra hizmet.');
  return addon;
}

function calcPrice(serviceKey, { sizeSqm } = {}) {
  const service = getService(serviceKey);
  const price = service.base + (Number(sizeSqm) || 0) * service.rate;
  return Math.max(service.min, Math.round(price / 5) * 5);
}

// Tek bir ortak alan alt seçeneğinin fiyatı.
function calcCommonAreaSubPrice(key, params = {}) {
  const sub = getCommonAreaSubOption(key);
  let price = sub.base;
  if (sub.paramType === 'floors') {
    price += (Number(params.floorCount) || 0) * sub.ratePerFloor;
  } else if (sub.paramType === 'corridor') {
    const floors = Number(params.floorCount) || 0;
    const sqmPerFloor = Number(params.sqmPerFloor) || 0;
    price += floors * sub.ratePerFloor;
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
  let fee = 0;
  if (!hasEquipment) fee += SUPPLIES_FEES.noEquipment;
  if (!hasChemicals) fee += SUPPLIES_FEES.noChemicals;
  return fee;
}

// Bir işin fiyatından MICISTO komisyonu düşüldükten sonra personele
// kalan net kazanç.
function calcNetEarning(price) {
  return Math.round(price * (1 - COMMISSION_RATE) * 100) / 100;
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
  SERVICES, COMMON_AREA_SUB_OPTIONS, ADDONS, SUPPLIES_FEES, COMMISSION_RATE,
  getService, getAddon, getCommonAreaSubOption,
  calcPrice, calcCommonAreaSubPrice, calcCommonAreaGroupTotal, calcAddonsTotal, calcSuppliesFee,
  calcNetEarning, estimateJobMinutes, calcPerformanceBonus,
};
