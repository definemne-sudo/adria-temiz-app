/**
 * Ana hizmetler: m²'ye göre fiyatlanır, "Hizmetler" ekranında kart olarak gösterilir.
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
  },
  {
    key: 'deep_clean',
    name: 'Detaylı temizlik',
    description: 'Dolap içi, fırın, cam gibi detayları kapsayan kapsamlı temizlik.',
    base: 30,
    rate: 0.48,
    min: 45,
  },
  {
    key: 'office',
    name: 'Ofis / Dükkan / Çalışma Alanı Temizliği',
    description: 'Çalışma alanları için düzenli veya tek seferlik temizlik.',
    base: 25,
    rate: 0.22,
    min: 40,
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
  if (!service) throw new Error('Geçersiz hizmet türü.');
  return service;
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
  SERVICES, ADDONS, SUPPLIES_FEES,
  getService, getAddon, calcPrice, calcAddonsTotal, calcSuppliesFee,
};
