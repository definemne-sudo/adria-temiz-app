const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const jobRoutes = require('./routes/jobs');
const serviceRoutes = require('./routes/services');
const paymentMethodRoutes = require('./routes/paymentMethods');
const chatRoutes = require('./routes/chat');
const staffApplicationRoutes = require('./routes/staffApplications');
const adminRoutes = require('./routes/admin');
const financeRoutes = require('./routes/finance');
const marketingRoutes = require('./routes/marketing');
// NOT: Sipariş Bildirimleri (push + dağıtım motoru) özelliği bilinçli olarak
// ertelendi - routes/push.js ve services/dispatch.js dosyaları henüz repoya
// eklenmedi. O özelliğe döndüğümüzde bu iki satırın ve aşağıdaki push route
// + setInterval bloğunun geri eklenmesi gerekiyor.
// const pushRoutes = require('./routes/push');
// const { checkTimeouts } = require('./services/dispatch');

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
app.use('/api/admin', adminRoutes);
app.use('/api/admin/finance', financeRoutes);
app.use('/api/admin/marketing', marketingRoutes);
// app.use('/api/push', pushRoutes);

// Genel hata yakalayıcı
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Sunucu hatası.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend http://localhost:${PORT} üzerinde çalışıyor`);
});

// setInterval(() => {
//   checkTimeouts().catch((err) => console.error('checkTimeouts hata:', err));
// }, 60 * 1000);
