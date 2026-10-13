const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const pool = require('../config/db');

const router = express.Router();

const loginSchema = z.object({
  correo: z.email(),
  password: z.string().min(1),
}).strict();

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo más tarde.' });
  },
});

router.post('/login', async (req, res) => {
  const validation = loginSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: 'Solicitud inválida.',
      details: validation.error.issues.map(({ path, message }) => ({
        campo: path.join('.'),
        mensaje: message,
      })),
    });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32) {
    console.error('JWT_SECRET must be configured with at least 32 bytes.');
    return res.status(500).json({ error: 'El servicio de autenticación no está configurado.' });
  }

  try {
    const correo = validation.data.correo.trim().toLowerCase();
    const { rows } = await pool.query(
      `SELECT id, nombre, correo, password_hash, rol
       FROM usuarios
       WHERE correo = $1 AND activo = TRUE`,
      [correo],
    );
    const usuario = rows[0];

    if (!usuario || !(await bcrypt.compare(validation.data.password, usuario.password_hash))) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    const token = jwt.sign(
      {
        nombre: usuario.nombre,
        correo: usuario.correo,
        rol: usuario.rol,
      },
      jwtSecret,
      { subject: String(usuario.id), expiresIn: '1h' },
    );

    return res.status(200).json({
      token,
      tipo: 'Bearer',
      expiraEn: '1h',
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        correo: usuario.correo,
        rol: usuario.rol,
      },
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ error: 'No fue posible iniciar sesión.' });
  }
});

module.exports = { router, loginRateLimit };
