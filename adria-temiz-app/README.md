# Adria Temiz — MVP

Karadağ'daki ev sahipleri (bireysel + yönetim şirketi) için temizlik hizmeti platformunun ilk çalışan iskeleti.

## İçerik

- `backend/` — Node.js/Express API, SQLite veritabanı (better-sqlite3), JWT auth, iCal senkron motoru, escrow ödeme simülasyonu.
- `frontend/index.html` — Birleşik ev sahibi/yönetim paneli. Build aracı gerektirmez, tarayıcıda doğrudan açılır.

## Çalıştırma

```bash
cd backend
npm install
npm start
```

Sunucu `http://localhost:4000` üzerinde ayağa kalkar (ilk çalıştırmada `data.sqlite` otomatik oluşur).

Sonra `frontend/index.html` dosyasını tarayıcıda aç (çift tıkla ya da `npx serve frontend` gibi basit bir statik sunucuyla servis et).

## Demo akışı

1. "Hesap oluştur" ile bireysel ev sahibi ya da yönetim şirketi olarak kaydol.
2. "Mülk ekle" ile bir mülk oluştur (gerçek bir Airbnb iCal linki de girebilirsin — prod'da backend bu linki periyodik okur).
3. Mülk kartındaki "Takvimi senkronla (demo)" butonuna bas — bu, örnek bir .ics içeriğiyle senkron motorunu tetikler ve check-out tarihlerine göre otomatik temizlik işleri oluşturur.
4. "Temizlik İşleri" sekmesinde oluşan işleri gör, "Ödemeyi tut" ile escrow simülasyonunu başlat, "Onayla ve öde" ile serbest bırak.

## Neler eksik / sıradaki adımlar

Bu bilinçli olarak minimum bir iskelet — şablon dokümanındaki (`karadag-temizlik-app-rakip-analizi.md`) planın kod karşılığı olarak düşünülmeli. Eklenmesi gereken gerçek işler:

- **Gerçek iCal fetch**: `services/icalSync.js` şu an demo için ham `.ics` metni kabul ediyor; prod'da `ical.async.fromURL(property.ical_url)` çağrısı zaten hazır, sadece periyodik bir cron job (örn. `node-cron` ile her 30 dakikada bir tüm mülkleri senkronla) eklenmeli.
- **Gerçek Stripe entegrasyonu**: `/jobs/:id/pay` ve `/jobs/:id/release` şu an sadece veritabanı durumu değiştiriyor; gerçek Stripe PaymentIntent + manuel capture akışıyla değiştirilmeli.
- **Personel uygulaması**: `/jobs/pending` endpoint'i hazır ama ayrı bir mobil arayüz yok.
- **Delege erişim daveti**: Backend'de var (`POST /properties/:id/delegates`) ama frontend'de arayüzü yok.
- **SMS OTP doğrulama, adli sicil/sigorta kaydı alanları**: veri modeline eklenmedi.
- **Supabase'e geçiş**: Şu an yerel SQLite kullanıyor (sıfır maliyetli geliştirme için); production'da şablonda önerilen Supabase ücretsiz katmanına taşınabilir (PostgreSQL şeması neredeyse aynı kalır).
