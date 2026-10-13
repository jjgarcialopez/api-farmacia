const pool = require('../config/db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function withTransaction(operation) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Database transaction rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function insertAudit(client, req, entry) {
  await client.query(
    `INSERT INTO auditoria (
       usuario_id, accion, metodo, ruta, recurso, recurso_id,
       datos_anteriores, datos_nuevos, codigo_http, ip, user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      req.user.id,
      entry.accion,
      req.method,
      req.originalUrl,
      entry.recurso,
      entry.recursoId === undefined ? null : String(entry.recursoId),
      entry.datosAnteriores === undefined ? null : JSON.stringify(entry.datosAnteriores),
      entry.datosNuevos === undefined ? null : JSON.stringify(entry.datosNuevos),
      entry.codigoHttp,
      req.ip || null,
      req.get('user-agent') || null,
    ],
  );
}

function respondToDatabaseError(res, error, context) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }

  if (error.code === '23505') {
    return res.status(409).json({ error: 'Ya existe un registro con esos datos únicos.' });
  }
  if (error.code === '23503') {
    return res.status(409).json({ error: 'La operación no es posible porque el registro tiene relaciones asociadas.' });
  }
  if (['23514', '22P02', '22007', '22008'].includes(error.code)) {
    return res.status(400).json({ error: 'Los datos enviados no cumplen las reglas de la base de datos.' });
  }

  console.error(`${context}:`, error);
  return res.status(500).json({ error: 'No fue posible completar la operación.' });
}

function parsePositiveInteger(value) {
  if (!/^[1-9]\d*$/.test(value || '')) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

module.exports = {
  HttpError,
  insertAudit,
  isValidDate,
  parseBoolean,
  parsePositiveInteger,
  respondToDatabaseError,
  withTransaction,
};
