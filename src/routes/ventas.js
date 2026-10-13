const { randomUUID } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const pool = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  HttpError,
  insertAudit,
  parsePositiveInteger,
  respondToDatabaseError,
  withTransaction,
} = require('../services/database');

const router = express.Router();
const salesReaders = authorizeRoles('administrador', 'operador', 'consulta', 'auditor');
const saleWriters = authorizeRoles('administrador', 'operador');

const saleSchema = z.object({
  items: z.array(z.object({
    medicamento_id: z.number().int().positive(),
    cantidad: z.number().int().positive().max(1000000),
  }).strict()).min(1).max(50),
}).strict().superRefine((sale, context) => {
  const medicationIds = new Set();
  sale.items.forEach((item, index) => {
    if (medicationIds.has(item.medicamento_id)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'medicamento_id'],
        message: 'No repita medicamentos; envíe una sola cantidad por medicamento.',
      });
    }
    medicationIds.add(item.medicamento_id);
  });
});

function parsePagination(query) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(offset) || offset < 0
  ) {
    return null;
  }
  return { limit, offset };
}

function priceToCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) {
    throw new Error('Database returned a price with unexpected precision.');
  }
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}

function centsToPrice(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

router.use(authenticateToken);

router.get('/', salesReaders, async (req, res) => {
  const pagination = parsePagination(req.query);
  if (!pagination) {
    return res.status(400).json({ error: 'limit debe estar entre 1 y 100 y offset debe ser un entero no negativo.' });
  }

  const values = [];
  const conditions = [];
  if (req.query.estado !== undefined) {
    if (!['confirmada', 'revertida'].includes(req.query.estado)) {
      return res.status(400).json({ error: 'estado debe ser confirmada o revertida.' });
    }
    values.push(req.query.estado);
    conditions.push(`v.estado = $${values.length}`);
  }
  if (req.query.desde !== undefined) {
    if (typeof req.query.desde !== 'string' || Number.isNaN(Date.parse(req.query.desde))) {
      return res.status(400).json({ error: 'desde debe ser una fecha válida.' });
    }
    values.push(new Date(req.query.desde).toISOString());
    conditions.push(`v.fecha >= $${values.length}::timestamptz`);
  }
  if (req.query.hasta !== undefined) {
    if (typeof req.query.hasta !== 'string' || Number.isNaN(Date.parse(req.query.hasta))) {
      return res.status(400).json({ error: 'hasta debe ser una fecha válida.' });
    }
    values.push(new Date(req.query.hasta).toISOString());
    conditions.push(`v.fecha <= $${values.length}::timestamptz`);
  }

  try {
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query(
      `SELECT COUNT(*)::integer AS total FROM ventas v ${where}`,
      values,
    );
    const listValues = [...values, pagination.limit, pagination.offset];
    const result = await pool.query(
      `SELECT v.id, v.numero, v.usuario_id, u.nombre AS usuario_nombre,
              v.fecha, v.total, v.estado
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
       ${where}
       ORDER BY v.fecha DESC, v.id DESC
       LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );
    return res.status(200).json({
      items: result.rows,
      pagination: { ...pagination, total: countResult.rows[0].total },
    });
  } catch (error) {
    return respondToDatabaseError(res, error, 'List sales failed');
  }
});

router.get('/:id', salesReaders, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id de la venta debe ser un entero positivo.' });
  }

  try {
    const saleResult = await pool.query(
      `SELECT v.id, v.numero, v.usuario_id, u.nombre AS usuario_nombre,
              v.fecha, v.total, v.estado
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.id = $1`,
      [id],
    );
    if (saleResult.rowCount === 0) {
      return res.status(404).json({ error: 'Venta no encontrada.' });
    }

    const detailsResult = await pool.query(
      `SELECT d.id, d.lote_id, l.codigo_lote, l.medicamento_id,
              m.codigo AS medicamento_codigo, m.nombre AS medicamento_nombre,
              d.cantidad, d.precio_unitario, d.subtotal
       FROM detalle_venta d
       JOIN lotes l ON l.id = d.lote_id
       JOIN medicamentos m ON m.id = l.medicamento_id
       WHERE d.venta_id = $1
       ORDER BY d.id`,
      [id],
    );
    return res.status(200).json({ ...saleResult.rows[0], items: detailsResult.rows });
  } catch (error) {
    return respondToDatabaseError(res, error, 'Get sale failed');
  }
});

router.post('/', saleWriters, async (req, res) => {
  const validation = saleSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: 'Solicitud inválida.',
      details: validation.error.issues.map(({ path, message }) => ({
        campo: path.join('.'),
        mensaje: message,
      })),
    });
  }

  const items = validation.data.items;
  const medicationIds = items.map((item) => item.medicamento_id);
  const quantities = new Map(items.map(({ medicamento_id, cantidad }) => [medicamento_id, cantidad]));

  try {
    const sale = await withTransaction(async (client) => {
      const medications = await client.query(
        `SELECT id FROM medicamentos
         WHERE id = ANY($1::integer[]) AND activo = TRUE
         ORDER BY id
         FOR SHARE`,
        [medicationIds],
      );
      if (medications.rowCount !== medicationIds.length) {
        throw new HttpError(404, 'Uno o más medicamentos no existen o están inactivos.');
      }

      const batches = await client.query(
        `SELECT l.id, l.medicamento_id, l.codigo_lote, l.fecha_vencimiento,
                l.stock, l.precio_venta
         FROM lotes l
         WHERE l.medicamento_id = ANY($1::integer[])
           AND l.stock > 0
           AND l.fecha_vencimiento >= CURRENT_DATE
         ORDER BY l.medicamento_id, l.fecha_vencimiento, l.id
         FOR UPDATE OF l`,
        [medicationIds],
      );

      const batchesByMedication = new Map();
      for (const batch of batches.rows) {
        const available = batchesByMedication.get(batch.medicamento_id) || [];
        available.push(batch);
        batchesByMedication.set(batch.medicamento_id, available);
      }

      const allocations = [];
      for (const item of items) {
        let remaining = item.cantidad;
        for (const batch of batchesByMedication.get(item.medicamento_id) || []) {
          if (remaining === 0) break;
          const quantity = Math.min(remaining, batch.stock);
          if (quantity > 0) {
            allocations.push({ batch, quantity });
            remaining -= quantity;
          }
        }
        if (remaining > 0) {
          throw new HttpError(
            409,
            `Existencias insuficientes en lotes vigentes para el medicamento ${item.medicamento_id}.`,
          );
        }
      }

      const maximumMoney = 999999999999n;
      let totalCents = 0n;
      const preparedAllocations = allocations.map((allocation) => {
        const unitPriceCents = priceToCents(allocation.batch.precio_venta);
        const subtotalCents = unitPriceCents * BigInt(allocation.quantity);
        totalCents += subtotalCents;
        if (totalCents > maximumMoney) {
          throw new HttpError(400, 'El total de la venta supera el valor máximo permitido.');
        }
        return { ...allocation, unitPriceCents, subtotalCents };
      });

      const numero = `VTA-${randomUUID()}`;
      const saleResult = await client.query(
        `INSERT INTO ventas (numero, usuario_id, total)
         VALUES ($1, $2, $3::numeric)
         RETURNING id, numero, usuario_id, fecha, total, estado`,
        [numero, req.user.id, centsToPrice(totalCents)],
      );
      const createdSale = saleResult.rows[0];
      const responseItems = [];

      for (const allocation of preparedAllocations) {
        const { batch, quantity, unitPriceCents, subtotalCents } = allocation;
        const stockAntes = batch.stock;
        const stockDespues = stockAntes - quantity;
        const updateResult = await client.query(
          `UPDATE lotes SET stock = $1
           WHERE id = $2 AND stock = $3
           RETURNING stock`,
          [stockDespues, batch.id, stockAntes],
        );
        if (updateResult.rowCount !== 1) {
          throw new HttpError(409, 'El stock del lote cambió durante la operación; intenta nuevamente.');
        }

        const detailResult = await client.query(
          `INSERT INTO detalle_venta (venta_id, lote_id, cantidad, precio_unitario, subtotal)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric)
           RETURNING id, lote_id, cantidad, precio_unitario, subtotal`,
          [
            createdSale.id,
            batch.id,
            quantity,
            centsToPrice(unitPriceCents),
            centsToPrice(subtotalCents),
          ],
        );
        await client.query(
          `INSERT INTO inventario (
             lote_id, venta_id, usuario_id, tipo, cantidad,
             stock_antes, stock_despues, motivo
           )
           VALUES ($1, $2, $3, 'salida', $4, $5, $6, $7)`,
          [
            batch.id,
            createdSale.id,
            req.user.id,
            quantity,
            stockAntes,
            stockDespues,
            `Venta ${createdSale.numero}`,
          ],
        );
        responseItems.push({
          ...detailResult.rows[0],
          medicamento_id: batch.medicamento_id,
          codigo_lote: batch.codigo_lote,
          fecha_vencimiento: batch.fecha_vencimiento,
        });
      }

      await insertAudit(client, req, {
        accion: 'crear',
        recurso: 'ventas',
        recursoId: createdSale.id,
        datosNuevos: { ...createdSale, items: responseItems },
        codigoHttp: 201,
      });
      return { ...createdSale, items: responseItems };
    });

    return res.status(201).json(sale);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Create sale failed');
  }
});

module.exports = router;
