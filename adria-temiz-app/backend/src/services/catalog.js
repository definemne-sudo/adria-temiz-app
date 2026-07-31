/**
 * Hizmet kataloğu — her hizmetin kendi fiyat hesaplama mantığı var.
 * calcType:
 *   'per_sqm'  -> taban ücret + (m² * oran)
 *   'per_item' -> taban ücret + (adet * oran)   [örn. halı/koltuk yıkama]
 * Tüm fiyatlar 'min' değerinin altına düşmez, 5€'ya yuvarlanır.
 *
 * Bu rakamlar başlangıç varsayımı — gerçek maliyet/personel verisi geldikçe
 * (şablon dokümanındaki Ablan Temizler personel finansal modeli gibi) ayarlanmalı.
 */
const SERVICES = [
  {
    key: 'checkin_checkout',
    name: 'Check-in / Check-out temizliği',
    description: 'Misafir çıkışı ve girişi arasında hızlı, standart temizlik.',
    calcType: 'per_sqm',
    base: 20,
    rate: 0.28,
    min: 30,
  },
  {
    key: 'deep_clean',
    name: 'Detaylı temizlik',
    description: 'Dolap içi, fırın, cam gibi detayları kapsayan kapsamlı temizlik.',
    calcType: 'per_sqm',
    base: 30,
    rate: 0.48,
    min: 45,
  },
  {
    key: 'office',
    name: 'Ofis / iş yeri temizliği',
    description: 'Çalışma alanları için düzenli veya tek seferlik temizlik.',
    calcType: 'per_sqm',
    base: 25,
    rate: 0.22,
    min: 40,
  },
  {
    key: 'carpet_upholstery',
    name: 'Halı / koltuk yıkama',
    description: 'Adet bazlı halı ve koltuk yıkama hizmeti.',
    calcType: 'per_item',
    base: 0,
    rate: 18,
    min: 18,
    unitLabel: 'adet',
  },
];

function getService(key) {
  const service = SERVICES.find((s) => s.key === key);
  if (!service) throw new Error('Geçersiz hizmet türü.');
  return service;
}

function calcPrice(serviceKey, { sizeSqm, quantity } = {}) {
  const service = getService(serviceKey);
  let price;
  if (service.calcType === 'per_sqm') {
    price = service.base + (Number(sizeSqm) || 0) * service.rate;
  } else if (service.calcType === 'per_item') {
    price = service.base + (Number(quantity) || 1) * service.rate;
  } else {
    price = service.base;
  }
  return Math.max(service.min, Math.round(price / 5) * 5);
}

module.exports = { SERVICES, getService, calcPrice };
