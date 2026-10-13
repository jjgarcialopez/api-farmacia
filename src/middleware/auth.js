const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const authorization = req.get('authorization');
  const [scheme, token] = authorization ? authorization.split(' ') : [];

  if (scheme !== 'Bearer' || !token || !process.env.JWT_SECRET) {
    return res.status(401).json({ error: 'Autenticación requerida.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (
      typeof payload === 'string' ||
      typeof payload.sub !== 'string' ||
      typeof payload.rol !== 'string'
    ) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    req.user = {
      id: Number(payload.sub),
      nombre: payload.nombre,
      correo: payload.correo,
      rol: payload.rol,
    };

    if (!Number.isSafeInteger(req.user.id) || req.user.id <= 0) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    return next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }

    return next(error);
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
