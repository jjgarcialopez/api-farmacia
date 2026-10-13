require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./config/db');
const { router: authRoutes, loginRateLimit } = require('./routes/auth');
const medicationRoutes = require('./routes/medicamentos');
const batchRoutes = require('./routes/lotes');

const app = express();
const port = process.env.PORT || 3000;
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors(corsOrigins.length > 0 ? { origin: corsOrigins } : undefined));
app.use('/api/auth/login', loginRateLimit);
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/medicamentos', medicationRoutes);
app.use('/api/lotes', batchRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'El cuerpo de la solicitud debe ser JSON válido.' });
  }

  console.error('Unhandled request error:', error);
  return res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`API listening on port ${port}`);
  });
}

module.exports = app;
