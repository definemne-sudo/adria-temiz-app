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
    accountTypes: ['individual', 'company'],
  },
  {
    key: 'deep_clean',
    name: 'Detaylı temizlik',
    description: 'Dolap içi, fırın, cam gibi detayları kapsayan kapsamlı temizlik.',
    base: 30,
    rate: 0.48,
    min: 45,
    accountTypes: ['individual'],
  },
  {
    key: 'office',
    name: 'Ofis / Dükkan / Çalışma Alanı Temizliği',
    description: 'Çalışma alanları için düzenli veya tek seferlik temizlik.',
    base: 25,
    rate: 0.22,
    min: 40,
    accountTypes: ['individual', 'company'],
  },
];

// Ortak Alan Temizliği - yalnızca yönetim şirketi hesaplarında görünür.
// Her alt seçeneğin kendi parametresi ve fiyat mantığı var (m²/kat sayısı
// yerine kat sayısı, m²+kat sayısı, veya asansör kapasitesi kullanılıyor).
const COMMON_AREA_SERVICES = [
  {
    key: 'common_area_staircase',
    name: 'Merdiven Temizliği',
    description: 'Bina merdivenlerinin düzenli temizliği, kat sayısına göre fiyatlanır.',
    base: 15,
    ratePerFloor: 4,
    min: 25,
    paramType: 'floors', // { floorCount }
    accountTypes: ['company'],
  },
  {
    key: 'common_area_corridor',
    name: 'Kat Koridoru Temizliği',
    description: 'Kat koridorlarının temizliği, alan (m²) ve kat sayısına göre fiyatlanır.',
    base: 12,
    ratePerSqm: 0.3,
    ratePerFloor: 3,
    min: 30,
    paramType: 'corridor', // { corridorSqm, floorCount }
    accountTypes: ['company'],
  },
  {
    key: 'common_area_elevator',
    name: 'Asansör Temizliği',
    description: 'Asansör kabini temizliği, kişi kapasitesine göre fiyatlanır.',
    base: 12,
    ratePerCapacity: 1.4,
    min: 20,
    paramType: 'elevator', // { elevatorCapacity }
    accountTypes: ['company'],
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

function getService(key) {
  const service = SERVICES.find((s) => s.key === key);
  if (service) return service;
  const commonArea = COMMON_AREA_SERVICES.find((s) => s.key === key);
  if (commonArea) return commonArea;
  throw new Error('Geçersiz hizmet türü.');
}

function isCommonAreaService(key) {
  return COMMON_AREA_SERVICES.some((s) => s.key === key);
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

// Ortak alan hizmetleri için parametre bazlı fiyat hesaplama.
// params: { floorCount, corridorSqm, elevatorCapacity } (hizmete göre kullanılanlar değişir)
function calcCommonAreaPrice(serviceKey, params = {}) {
  const service = COMMON_AREA_SERVICES.find((s) => s.key === serviceKey);
  if (!service) throw new Error('Geçersiz ortak alan hizmeti.');

  let price = service.base;
  if (service.paramType === 'floors') {
    price += (Number(params.floorCount) || 0) * service.ratePerFloor;
  } else if (service.paramType === 'corridor') {
    price += (Number(params.corridorSqm) || 0) * service.ratePerSqm;
    price += (Number(params.floorCount) || 0) * service.ratePerFloor;
  } else if (service.paramType === 'elevator') {
    price += (Number(params.elevatorCapacity) || 0) * service.ratePerCapacity;
  }
  return Math.max(service.min, Math.round(price / 5) * 5);
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

module.exports = {
  SERVICES, COMMON_AREA_SERVICES, ADDONS, SUPPLIES_FEES,
  getService, getAddon, isCommonAreaService,
  calcPrice, calcCommonAreaPrice, calcAddonsTotal, calcSuppliesFee,
};
