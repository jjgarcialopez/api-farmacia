const express = require('express');
const { z } = require('zod');
const pool = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  HttpError,
  insertAudit,
  isValidDate,
  parseBoolean,
  parsePositiveInteger,
  respondToDatabaseError,
  withTransaction,
} = require('../services/database');

const router = express.Router();
const writeRoles = authorizeRoles('administrador', 'operador');

const createSchema = z.object({
  medicamento_id: z.number().int().positive(),
  codigo_lote: z.string().trim().min(1).max(60),
  fecha_vencimiento: z.string().refine(isValidDate, 'La fecha debe tener formato YYYY-MM-DD y ser válida.'),
  stock: z.number().int().positive(),
  costo_unitario: z.number().finite().nonnegative(),
  precio_venta: z.number().finite().nonnegative(),
}).strict();

const updateSchema = z.object({
  codigo_lote: z.string().trim().min(1).max(60).optional(),
  fecha_vencimiento: z.string().refine(isValidDate, 'La fecha debe tener formato YYYY-MM-DD y ser válida.').optional(),
  costo_unitario: z.number().finite().nonnegative().optional(),
  precio_venta: z.number().finite().nonnegative().optional(),
}).strict().refine(
  (data) => Object.keys(data).length > 0,
  'Debe enviar al menos un campo permitido para actualizar. El stock se modifica mediante movimientos de inventario.',
);

router.use(authenticateToken);

router.get('/', async (req, res) => {
  const { medicamento_id: medicamentoId, vencimiento_desde: from, vencimiento_hasta: until, disponible } = req.query;
  const values = [];
  const conditions = [];

  if (medicamentoId !== undefined) {
    const id = parsePositiveInteger(medicamentoId);
    if (!id) {
      return res.status(400).json({ error: 'medicamento_id debe ser un entero positivo.' });
    }
    values.push(id);
    conditions.push(`l.medicamento_id = $${values.length}`);
  }

  for (const [value, name] of [[from, 'vencimiento_desde'], [until, 'vencimiento_hasta']]) {
    if (value !== undefined) {
      if (!isValidDate(value)) {
        return res.status(400).json({ error: `${name} debe tener formato YYYY-MM-DD y ser una fecha válida.` });
      }
      values.push(value);
      conditions.push(`l.fecha_vencimiento ${name === 'vencimiento_desde' ? '>=' : '<='} $${values.length}::date`);
    }
  }

  if (disponible !== undefined) {
    const available = parseBoolean(disponible);
    if (available === null) {
      return res.status(400).json({ error: 'El filtro disponible debe ser true o false.' });
    }
    conditions.push(available ? 'l.stock > 0' : 'l.stock = 0');
  }

  try {
    const result = await pool.query(
      `SELECT l.id, l.medicamento_id, m.codigo AS medicamento_codigo,
              m.nombre AS medicamento_nombre, l.codigo_lote, l.fecha_vencimiento,
              l.stock, l.costo_unitario, l.precio_venta
       FROM lotes l
       JOIN medicamentos m ON m.id = l.medicamento_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY l.fecha_vencimiento, l.id`,
      values,
    );
    return res.status(200).json({ items: result.rows });
  } catch (error) {
    return respondToDatabaseError(res, error, 'List batches failed');
  }
});

router.get('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del lote debe ser un entero positivo.' });
  }

  try {
    const result = await pool.query(
      `SELECT l.id, l.medicamento_id, m.codigo AS medicamento_codigo,
              m.nombre AS medicamento_nombre, l.codigo_lote, l.fecha_vencimiento,
              l.stock, l.costo_unitario, l.precio_venta
       FROM lotes l
       JOIN medicamentos m ON m.id = l.medicamento_id
       WHERE l.id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lote no encontrado.' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Get batch failed');
  }
});

router.post('/', writeRoles, async (req, res) => {
  const validation = createSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: 'Solicitud inválida.',
      details: validation.error.issues.map(({ path, message }) => ({
        campo: path.join('.'),
        mensaje: message,
      })),
    });
  }

  const batch = validation.data;
  try {
    const created = await withTransaction(async (client) => {
      const medication = await client.query(
        'SELECT id FROM medicamentos WHERE id = $1 AND activo = TRUE FOR SHARE',
        [batch.medicamento_id],
      );
      if (medication.rowCount === 0) {
        throw new HttpError(404, 'Medicamento no encontrado o inactivo.');
      }

      const result = await client.query(
        `INSERT INTO lotes (
           medicamento_id, codigo_lote, fecha_vencimiento, stock, costo_unitario, precio_venta
         )
         VALUES ($1, $2, $3::date, $4, $5, $6)
         RETURNING id, medicamento_id, codigo_lote, fecha_vencimiento,
                   stock, costo_unitario, precio_venta`,
        [
          batch.medicamento_id,
          batch.codigo_lote,
          batch.fecha_vencimiento,
          batch.stock,
          batch.costo_unitario,
          batch.precio_venta,
        ],
      );
      const createdBatch = result.rows[0];
      await client.query(
        `INSERT INTO inventario (
           lote_id, usuario_id, tipo, cantidad, stock_antes, stock_despues, motivo
         )
         VALUES ($1, $2, 'entrada', $3, 0, $4, $5)`,
        [createdBatch.id, req.user.id, batch.stock, createdBatch.stock, 'Registro inicial de lote'],
      );
      await insertAudit(client, req, {
        accion: 'crear',
        recurso: 'lotes',
        recursoId: createdBatch.id,
        datosNuevos: createdBatch,
        codigoHttp: 201,
      });
      return createdBatch;
    });
    return res.status(201).json(created);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Create batch failed');
  }
});

router.put('/:id', writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del lote debe ser un entero positivo.' });
  }

  const validation = updateSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: 'Solicitud inválida.',
      details: validation.error.issues.map(({ path, message }) => ({
        campo: path.join('.'),
        mensaje: message,
      })),
    });
  }

  const batch = validation.data;
  const columns = {
    codigo_lote: 'codigo_lote',
    fecha_vencimiento: 'fecha_vencimiento',
    costo_unitario: 'costo_unitario',
    precio_venta: 'precio_venta',
  };
  const entries = Object.entries(batch);

  try {
    const updated = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, medicamento_id, codigo_lote, fecha_vencimiento,
                stock, costo_unitario, precio_venta
         FROM lotes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw new HttpError(404, 'Lote no encontrado.');
      }

      const assignments = entries.map(([field], index) => {
        const value = field === 'fecha_vencimiento' ? `$${index + 1}::date` : `$${index + 1}`;
        return `${columns[field]} = ${value}`;
      });
      const values = entries.map(([, value]) => value);
      values.push(id);
      const result = await client.query(
        `UPDATE lotes SET ${assignments.join(', ')}
         WHERE id = $${values.length}
         RETURNING id, medicamento_id, codigo_lote, fecha_vencimiento,
                   stock, costo_unitario, precio_venta`,
        values,
      );
      await insertAudit(client, req, {
        accion: 'actualizar',
        recurso: 'lotes',
        recursoId: id,
        datosAnteriores: existing.rows[0],
        datosNuevos: result.rows[0],
        codigoHttp: 200,
      });
      return result.rows[0];
    });
    return res.status(200).json(updated);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Update batch failed');
  }
});

router.delete('/:id', authorizeRoles('administrador'), async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del lote debe ser un entero positivo.' });
  }

  try {
    await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, medicamento_id, codigo_lote, fecha_vencimiento,
                stock, costo_unitario, precio_venta
         FROM lotes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw new HttpError(404, 'Lote no encontrado.');
      }

      const movement = await client.query(
        'SELECT 1 FROM inventario WHERE lote_id = $1 LIMIT 1',
        [id],
      );
      const saleDetail = await client.query(
        'SELECT 1 FROM detalle_venta WHERE lote_id = $1 LIMIT 1',
        [id],
      );
      if (movement.rowCount > 0 || saleDetail.rowCount > 0) {
        throw new HttpError(409, 'No se puede eliminar un lote con movimientos o ventas asociados.');
      }

      await insertAudit(client, req, {
        accion: 'eliminar',
        recurso: 'lotes',
        recursoId: id,
        datosAnteriores: existing.rows[0],
        codigoHttp: 204,
      });
      await client.query('DELETE FROM lotes WHERE id = $1', [id]);
    });
    return res.status(204).end();
  } catch (error) {
    return respondToDatabaseError(res, error, 'Delete batch failed');
  }
});

module.exports = router;
