const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const jobRoutes = require('./routes/jobs');
const serviceRoutes = require('./routes/services');
const paymentMethodRoutes = require('./routes/paymentMethods');
const chatRoutes = require('./routes/chat');
const staffApplicationRoutes = require('./routes/staffApplications');
const pushRoutes = require('./routes/push');
const adminRoutes = require('./routes/admin');
const { checkTimeouts } = require('./services/dispatch');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/payment-methods', paymentMethodRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/staff-applications', staffApplicationRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/admin', adminRoutes);

// Genel hata yakalayıcı
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Sunucu hatası.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend http://localhost:${PORT} üzerinde çalışıyor`);
});

// Sipariş dağıtımında zaman aşımına uğrayan (kabul edilmemiş ya da kabul
// edilip başlanmamış) işleri periyodik kontrol edip bir sonraki adaya
// devreder. NOT: Tek sunucu örneği için uygun basit bir yaklaşım - birden
// fazla sunucu örneği (yatay ölçekleme) olursa bu iş kuyruğunun Redis/Bull
// gibi paylaşımlı bir sisteme taşınması gerekir.
setInterval(() => {
  checkTimeouts().catch((err) => console.error('checkTimeouts hata:', err));
}, 60 * 1000);
