const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const jobRoutes = require('./routes/jobs');
const serviceRoutes = require('./routes/services');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/services', serviceRoutes);

// Genel hata yakalayıcı
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Sunucu hatası.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend http://localhost:${PORT} üzerinde çalışıyor`);
});
