const express = require('express');
const { z } = require('zod');
const pool = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  HttpError,
  insertAudit,
  parseBoolean,
  parsePositiveInteger,
  respondToDatabaseError,
  withTransaction,
} = require('../services/database');

const router = express.Router();
const writeRoles = authorizeRoles('administrador', 'operador');

const createSchema = z.object({
  codigo: z.string().trim().min(1).max(40),
  nombre: z.string().trim().min(1).max(140),
  principio_activo: z.string().trim().max(140).nullable().optional(),
  presentacion: z.string().trim().max(80).nullable().optional(),
  requiere_formula: z.boolean().optional(),
  precio_referencia: z.number().finite().nonnegative().optional(),
}).strict();

const updateSchema = createSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  'Debe enviar al menos un campo para actualizar.',
);

router.use(authenticateToken);

router.get('/', async (req, res) => {
  const { q, activo } = req.query;
  if (activo !== undefined && parseBoolean(activo) === null) {
    return res.status(400).json({ error: 'El filtro activo debe ser true o false.' });
  }

  const values = [];
  const conditions = [];
  if (activo !== undefined) {
    values.push(parseBoolean(activo));
    conditions.push(`activo = $${values.length}`);
  }
  if (q !== undefined) {
    if (typeof q !== 'string' || q.trim().length === 0 || q.length > 140) {
      return res.status(400).json({ error: 'El filtro q debe ser texto de 1 a 140 caracteres.' });
    }
    values.push(`%${q.trim()}%`);
    conditions.push(`(codigo ILIKE $${values.length} OR nombre ILIKE $${values.length} OR principio_activo ILIKE $${values.length})`);
  }

  try {
    const result = await pool.query(
      `SELECT id, codigo, nombre, principio_activo, presentacion,
              requiere_formula, precio_referencia, activo, creado_en
       FROM medicamentos
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY nombre, id`,
      values,
    );
    return res.status(200).json({ items: result.rows });
  } catch (error) {
    return respondToDatabaseError(res, error, 'List medications failed');
  }
});

router.get('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del medicamento debe ser un entero positivo.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, codigo, nombre, principio_activo, presentacion,
              requiere_formula, precio_referencia, activo, creado_en
       FROM medicamentos WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Medicamento no encontrado.' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Get medication failed');
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

  const medication = validation.data;
  try {
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO medicamentos (
           codigo, nombre, principio_activo, presentacion, requiere_formula, precio_referencia
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, codigo, nombre, principio_activo, presentacion,
                   requiere_formula, precio_referencia, activo, creado_en`,
        [
          medication.codigo,
          medication.nombre,
          medication.principio_activo ?? null,
          medication.presentacion ?? null,
          medication.requiere_formula ?? false,
          medication.precio_referencia ?? 0,
        ],
      );
      await insertAudit(client, req, {
        accion: 'crear',
        recurso: 'medicamentos',
        recursoId: result.rows[0].id,
        datosNuevos: result.rows[0],
        codigoHttp: 201,
      });
      return result.rows[0];
    });
    return res.status(201).json(created);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Create medication failed');
  }
});

router.put('/:id', writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del medicamento debe ser un entero positivo.' });
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

  const medication = validation.data;
  const columns = {
    codigo: 'codigo',
    nombre: 'nombre',
    principio_activo: 'principio_activo',
    presentacion: 'presentacion',
    requiere_formula: 'requiere_formula',
    precio_referencia: 'precio_referencia',
  };
  const entries = Object.entries(medication);

  try {
    const updated = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, codigo, nombre, principio_activo, presentacion,
                requiere_formula, precio_referencia, activo, creado_en
         FROM medicamentos WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw new HttpError(404, 'Medicamento no encontrado.');
      }

      const assignments = entries.map(([field], index) => `${columns[field]} = $${index + 1}`);
      const values = entries.map(([, value]) => value);
      values.push(id);
      const result = await client.query(
        `UPDATE medicamentos
         SET ${assignments.join(', ')}
         WHERE id = $${values.length}
         RETURNING id, codigo, nombre, principio_activo, presentacion,
                   requiere_formula, precio_referencia, activo, creado_en`,
        values,
      );
      await insertAudit(client, req, {
        accion: 'actualizar',
        recurso: 'medicamentos',
        recursoId: id,
        datosAnteriores: existing.rows[0],
        datosNuevos: result.rows[0],
        codigoHttp: 200,
      });
      return result.rows[0];
    });
    return res.status(200).json(updated);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Update medication failed');
  }
});

router.delete('/:id', authorizeRoles('administrador'), async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del medicamento debe ser un entero positivo.' });
  }

  try {
    const deactivated = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, codigo, nombre, principio_activo, presentacion,
                requiere_formula, precio_referencia, activo, creado_en
         FROM medicamentos WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw new HttpError(404, 'Medicamento no encontrado.');
      }

      if (!existing.rows[0].activo) {
        throw new HttpError(409, 'El medicamento ya está desactivado.');
      }

      const result = await client.query(
        `UPDATE medicamentos SET activo = FALSE
         WHERE id = $1
         RETURNING id, codigo, nombre, principio_activo, presentacion,
                   requiere_formula, precio_referencia, activo, creado_en`,
        [id],
      );
      await insertAudit(client, req, {
        accion: 'eliminar',
        recurso: 'medicamentos',
        recursoId: id,
        datosAnteriores: existing.rows[0],
        datosNuevos: result.rows[0],
        codigoHttp: 200,
      });
      return result.rows[0];
    });
    return res.status(200).json(deactivated);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Deactivate medication failed');
  }
});

module.exports = router;
