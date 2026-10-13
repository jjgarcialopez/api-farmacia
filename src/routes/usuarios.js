// Dependencias para definir rutas, validar datos, cifrar contraseñas y acceder a la base de datos.
const express = require('express');
const bcrypt = require('bcrypt');
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

// Router de administración de usuarios y roles permitidos en el sistema.
const router = express.Router();
const validRoles = ['administrador', 'operador', 'consulta', 'auditor'];

// Esquema de los campos obligatorios para crear un usuario.
const createSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  correo: z.string().trim().pipe(z.email()).transform((correo) => correo.toLowerCase()),
  password: z.string().min(12).max(128),
  rol: z.enum(validRoles),
}).strict();

// Esquema de actualización: permite enviar solo los campos que se desean cambiar.
const updateSchema = z.object({
  nombre: z.string().trim().min(1).max(120).optional(),
  correo: z.string().trim().pipe(z.email()).transform((correo) => correo.toLowerCase()).optional(),
  password: z.string().min(12).max(128).optional(),
  rol: z.enum(validRoles).optional(),
  activo: z.boolean().optional(),
}).strict().refine(
  (data) => Object.keys(data).length > 0,
  'Debe enviar al menos un campo para actualizar.',
);

// Todas las operaciones de este router requieren autenticación y rol de administrador.
router.use(authenticateToken, authorizeRoles('administrador'));

// Lista usuarios con paginación y filtros opcionales por rol, estado y texto de búsqueda.
router.get('/', async (req, res) => {
  // Valida la paginación antes de construir consultas a la base de datos.
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
  // Cada filtro se agrega como parámetro para evitar insertar valores del usuario en el SQL.
  if (req.query.rol !== undefined) {
    if (!validRoles.includes(req.query.rol)) {
      return res.status(400).json({ error: 'rol no válido.' });
    }
    values.push(req.query.rol);
    conditions.push(`rol = $${values.length}`);
  }
  if (req.query.activo !== undefined) {
    const activo = parseBoolean(req.query.activo);
    if (activo === null) {
      return res.status(400).json({ error: 'activo debe ser true o false.' });
    }
    values.push(activo);
    conditions.push(`activo = $${values.length}`);
  }
  if (req.query.q !== undefined) {
    if (typeof req.query.q !== 'string' || req.query.q.trim().length === 0 || req.query.q.length > 160) {
      return res.status(400).json({ error: 'q debe contener entre 1 y 160 caracteres.' });
    }
    values.push(`%${req.query.q.trim()}%`);
    conditions.push(`(nombre ILIKE $${values.length} OR correo ILIKE $${values.length})`);
  }

  try {
    // Reutiliza los filtros para obtener el total y la página solicitada.
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await pool.query(
      `SELECT COUNT(*)::integer AS total FROM usuarios ${where}`,
      values,
    );
    const listValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT id, nombre, correo, rol, activo, creado_en
       FROM usuarios
       ${where}
       ORDER BY id
       LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );
    return res.status(200).json({
      items: result.rows,
      pagination: { limit, offset, total: count.rows[0].total },
    });
  } catch (error) {
    // Traduce los errores de base de datos a respuestas HTTP de la API.
    return respondToDatabaseError(res, error, 'List users failed');
  }
});

// Busca un usuario por su identificador y responde 404 si no existe.
router.get('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del usuario debe ser un entero positivo.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, nombre, correo, rol, activo, creado_en
       FROM usuarios WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Get user failed');
  }
});

// Crea un usuario después de validar los datos y guardar su contraseña cifrada.
router.post('/', async (req, res) => {
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

  const { nombre, correo, password, rol } = validation.data;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    // Guarda el usuario y su auditoría en la misma transacción para mantenerlos consistentes.
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO usuarios (nombre, correo, password_hash, rol)
         VALUES ($1, $2, $3, $4)
         RETURNING id, nombre, correo, rol, activo, creado_en`,
        [nombre, correo, passwordHash, rol],
      );
      await insertAudit(client, req, {
        accion: 'crear',
        recurso: 'usuarios',
        recursoId: result.rows[0].id,
        datosNuevos: result.rows[0],
        codigoHttp: 201,
      });
      return result.rows[0];
    });
    return res.status(201).json(created);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Create user failed');
  }
});

// Actualiza parcialmente un usuario, aplicando reglas para proteger las cuentas administradoras.
router.put('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del usuario debe ser un entero positivo.' });
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

  // Nunca se persiste ni se registra la contraseña en texto plano.
  const changes = { ...validation.data };
  let passwordChanged = false;
  if (changes.password !== undefined) {
    changes.password_hash = await bcrypt.hash(changes.password, 12);
    delete changes.password;
    passwordChanged = true;
  }

  const columns = {
    nombre: 'nombre',
    correo: 'correo',
    password_hash: 'password_hash',
    rol: 'rol',
    activo: 'activo',
  };
  const entries = Object.entries(changes);

  try {
    // Bloquea la operación para serializar cambios de rol/estado y evitar dejar el sistema sin administradores.
    const updated = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [731942602]);
      const existingResult = await client.query(
        `SELECT id, nombre, correo, rol, activo, creado_en
         FROM usuarios WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existingResult.rowCount === 0) {
        throw new HttpError(404, 'Usuario no encontrado.');
      }
      const existing = existingResult.rows[0];

      // Un administrador no puede quitarse privilegios ni desactivar su propia cuenta.
      if (
        id === req.user.id &&
        ((changes.rol !== undefined && changes.rol !== 'administrador') ||
          changes.activo === false)
      ) {
        throw new HttpError(409, 'No puedes quitarte el rol administrador o desactivar tu propia cuenta.');
      }

      // Impide desactivar o degradar al último administrador activo.
      const newRole = changes.rol ?? existing.rol;
      const newActive = changes.activo ?? existing.activo;
      if (existing.rol === 'administrador' && existing.activo && (newRole !== 'administrador' || !newActive)) {
        const otherAdmins = await client.query(
          `SELECT COUNT(*)::integer AS total
           FROM usuarios
           WHERE rol = 'administrador' AND activo = TRUE AND id <> $1`,
          [id],
        );
        if (otherAdmins.rows[0].total === 0) {
          throw new HttpError(409, 'Debe existir al menos un administrador activo.');
        }
      }

      // Construye el UPDATE solo con los campos validados que llegaron en la solicitud.
      const assignments = entries.map(([field], index) => `${columns[field]} = $${index + 1}`);
      const values = entries.map(([, value]) => value);
      values.push(id);
      const result = await client.query(
        `UPDATE usuarios
         SET ${assignments.join(', ')}
         WHERE id = $${values.length}
         RETURNING id, nombre, correo, rol, activo, creado_en`,
        values,
      );
      // Registra los valores anteriores y nuevos; solo indica si la contraseña cambió, nunca su hash.
      const auditData = {
        anterior: existing,
        nuevo: result.rows[0],
        ...(passwordChanged ? { password_actualizado: true } : {}),
      };
      await insertAudit(client, req, {
        accion: 'actualizar',
        recurso: 'usuarios',
        recursoId: id,
        datosAnteriores: auditData.anterior,
        datosNuevos: {
          ...auditData.nuevo,
          ...(passwordChanged ? { password_actualizado: true } : {}),
        },
        codigoHttp: 200,
      });
      return result.rows[0];
    });
    return res.status(200).json(updated);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Update user failed');
  }
});

// Desactiva (baja lógica) una cuenta sin borrar su historial de la base de datos.
router.delete('/:id', async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El id del usuario debe ser un entero positivo.' });
  }

  try {
    // La transacción coordina la baja con otras operaciones que puedan afectar administradores activos.
    const deactivated = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [731942602]);
      const existingResult = await client.query(
        `SELECT id, nombre, correo, rol, activo, creado_en
         FROM usuarios WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existingResult.rowCount === 0) {
        throw new HttpError(404, 'Usuario no encontrado.');
      }
      const existing = existingResult.rows[0];

      // Evita desactivar la sesión actual, repetir una baja o dejar el sistema sin administrador.
      if (id === req.user.id) {
        throw new HttpError(409, 'No puedes desactivar tu propia cuenta.');
      }
      if (!existing.activo) {
        throw new HttpError(409, 'El usuario ya está desactivado.');
      }
      if (existing.rol === 'administrador') {
        const otherAdmins = await client.query(
          `SELECT COUNT(*)::integer AS total
           FROM usuarios
           WHERE rol = 'administrador' AND activo = TRUE AND id <> $1`,
          [id],
        );
        if (otherAdmins.rows[0].total === 0) {
          throw new HttpError(409, 'Debe existir al menos un administrador activo.');
        }
      }

      // Marca la cuenta como inactiva y registra la operación para auditoría.
      const result = await client.query(
        `UPDATE usuarios SET activo = FALSE
         WHERE id = $1
         RETURNING id, nombre, correo, rol, activo, creado_en`,
        [id],
      );
      await insertAudit(client, req, {
        accion: 'eliminar',
        recurso: 'usuarios',
        recursoId: id,
        datosAnteriores: existing,
        datosNuevos: result.rows[0],
        codigoHttp: 200,
      });
      return result.rows[0];
    });
    return res.status(200).json(deactivated);
  } catch (error) {
    return respondToDatabaseError(res, error, 'Deactivate user failed');
  }
});

// Expone el router para montarlo bajo la ruta de usuarios de la aplicación.
module.exports = router;
