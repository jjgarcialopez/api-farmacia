const jwt = require('jsonwebtoken');
const pool = require('../config/db');

async function authenticateToken(req, res, next) {
  const authorization = req.get('authorization');
  const [scheme, token] = authorization ? authorization.split(' ') : [];

  if (scheme !== 'Bearer' || !token || !process.env.JWT_SECRET) {
    return res.status(401).json({ error: 'Autenticación requerida.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (
      typeof payload === 'string' ||
      typeof payload.sub !== 'string'
    ) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    const id = Number(payload.sub);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    const { rows } = await pool.query(
      `SELECT id, nombre, correo, rol
       FROM usuarios
       WHERE id = $1 AND activo = TRUE`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario inactivo o inexistente.' });
    }

    req.user = rows[0];
    return next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }

    console.error('Token authentication failed:', error);
    return res.status(500).json({ error: 'No fue posible validar la autenticación.' });
  }
}

function authorizeRoles(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autenticación requerida.' });
    }

    if (!rolesPermitidos.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No tienes permisos para realizar esta acción.' });
    }

    return next();
  };
}

module.exports = { authenticateToken, authorizeRoles };
