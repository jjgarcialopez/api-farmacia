const express = require('express');
const pool = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  isValidDate,
  parsePositiveInteger,
  respondToDatabaseError,
} = require('../services/database');

const router = express.Router();
router.use(authenticateToken, authorizeRoles('administrador', 'operador', 'auditor'));

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
  if (req.query.lote_id !== undefined) {
    const loteId = parsePositiveInteger(req.query.lote_id);
    if (!loteId) {
      return res.status(400).json({ error: 'lote_id debe ser un entero positivo.' });
    }
    values.push(loteId);
    conditions.push(`i.lote_id = $${values.length}`);
  }
  if (req.query.venta_id !== undefined) {
    const saleId = parsePositiveInteger(req.query.venta_id);
    if (!saleId) {
      return res.status(400).json({ error: 'venta_id debe ser un entero positivo.' });
    }
    values.push(saleId);
    conditions.push(`i.venta_id = $${values.length}`);
  }
  if (req.query.tipo !== undefined) {
    if (!['entrada', 'salida', 'ajuste', 'reversión'].includes(req.query.tipo)) {
      return res.status(400).json({ error: 'tipo de movimiento inválido.' });
    }
    values.push(req.query.tipo);
    conditions.push(`i.tipo = $${values.length}`);
  }
  for (const [queryName, operator] of [['desde', '>='], ['hasta', '<=']]) {
    if (req.query[queryName] !== undefined) {
      if (!isValidDate(req.query[queryName])) {
        return res.status(400).json({ error: `${queryName} debe tener formato YYYY-MM-DD.` });
      }
      values.push(req.query[queryName]);
      conditions.push(`i.fecha ${operator} $${values.length}::date`);
    }
  }

  try {
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query(
      `SELECT COUNT(*)::integer AS total
       FROM inventario i JOIN lotes l ON l.id = i.lote_id ${where}`,
      values,
    );
    const listValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT i.id, i.lote_id, l.codigo_lote, l.medicamento_id,
              m.nombre AS medicamento_nombre, i.venta_id, i.usuario_id,
              u.nombre AS usuario_nombre, i.tipo, i.cantidad,
              i.stock_antes, i.stock_despues, i.motivo, i.fecha
       FROM inventario i
       JOIN lotes l ON l.id = i.lote_id
       JOIN medicamentos m ON m.id = l.medicamento_id
       JOIN usuarios u ON u.id = i.usuario_id
       ${where}
       ORDER BY i.fecha DESC, i.id DESC
       LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );
    return res.status(200).json({
      items: result.rows,
      pagination: { limit, offset, total: countResult.rows[0].total },
    });
  } catch (error) {
    return respondToDatabaseError(res, error, 'List inventory movements failed');
  }
});

module.exports = router;
