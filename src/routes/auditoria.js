const express = require('express');
const pool = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  isValidDate,
  parsePositiveInteger,
  respondToDatabaseError,
} = require('../services/database');

const router = express.Router();
router.use(authenticateToken, authorizeRoles('administrador', 'auditor'));

router.get('/', async (req, res) => {
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(offset) || offset < 0
  ) {
    return res.status(400).json({ error: 'limit debe estar entre 1 y 100 y offset debe ser un entero no negativo.' });
  }

  const values = [];
  const conditions = [];
  if (req.query.recurso !== undefined) {
    if (typeof req.query.recurso !== 'string' || req.query.recurso.length < 1 || req.query.recurso.length > 80) {
      return res.status(400).json({ error: 'recurso debe contener entre 1 y 80 caracteres.' });
    }
    values.push(req.query.recurso);
    conditions.push(`a.recurso = $${values.length}`);
  }
  if (req.query.usuario_id !== undefined) {
    const userId = parsePositiveInteger(req.query.usuario_id);
    if (!userId) {
      return res.status(400).json({ error: 'usuario_id debe ser un entero positivo.' });
    }
    values.push(userId);
    conditions.push(`a.usuario_id = $${values.length}`);
  }
  if (req.query.metodo !== undefined) {
    if (!['POST', 'PUT', 'DELETE'].includes(req.query.metodo)) {
      return res.status(400).json({ error: 'metodo debe ser POST, PUT o DELETE.' });
    }
    values.push(req.query.metodo);
    conditions.push(`a.metodo = $${values.length}`);
  }
  for (const [queryName, operator] of [['desde', '>='], ['hasta', '<=']]) {
    if (req.query[queryName] !== undefined) {
      if (!isValidDate(req.query[queryName])) {
        return res.status(400).json({ error: `${queryName} debe tener formato YYYY-MM-DD.` });
      }
      values.push(req.query[queryName]);
      conditions.push(`a.fecha ${operator} $${values.length}::date`);
    }
  }

  try {
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query(
      `SELECT COUNT(*)::integer AS total FROM auditoria a ${where}`,
      values,
    );
    const listValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT a.id, a.usuario_id, u.nombre AS usuario_nombre, a.accion,
              a.metodo, a.ruta, a.recurso, a.recurso_id, a.datos_anteriores,
              a.datos_nuevos, a.codigo_http, a.ip, a.user_agent, a.fecha
       FROM auditoria a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${where}
       ORDER BY a.fecha DESC, a.id DESC
       LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );
    return res.status(200).json({
      items: result.rows,
      pagination: { limit, offset, total: countResult.rows[0].total },
    });
  } catch (error) {
    return respondToDatabaseError(res, error, 'List audit entries failed');
  }
});

module.exports = router;
