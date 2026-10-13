require('dotenv').config();

const readline = require('node:readline/promises');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const pool = require('../src/config/db');

const userSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  correo: z.email(),
});

function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Este comando debe ejecutarse en una terminal interactiva.'));
      return;
    }

    let value = '';
    const restoreTerminal = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          restoreTerminal();
          process.stdout.write('\n');
          reject(new Error('Operación cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          restoreTerminal();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main() {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const client = await pool.connect();

  try {
    const nombre = await terminal.question('Nombre del administrador: ');
    const correo = await terminal.question('Correo del administrador: ');
    const parsedUser = userSchema.safeParse({
      nombre,
      correo: correo.trim().toLowerCase(),
    });

    if (!parsedUser.success) {
      throw new Error('Nombre o correo inválido.');
    }

    terminal.close();
    const password = await promptHidden('Contraseña (mínimo 12 caracteres): ');
    const confirmation = await promptHidden('Confirma la contraseña: ');
    if (password.length < 12 || password !== confirmation) {
      throw new Error('La contraseña debe tener al menos 12 caracteres y coincidir con la confirmación.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [731942601]);
    const { rows } = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM usuarios WHERE rol = 'administrador'
       ) AS administrador_existe`,
    );
    if (rows[0].administrador_existe) {
      throw new Error('Ya existe un administrador; no se creó otro usuario.');
    }

    await client.query(
      `INSERT INTO usuarios (nombre, correo, password_hash, rol)
       VALUES ($1, $2, $3, 'administrador')`,
      [parsedUser.data.nombre, parsedUser.data.correo, passwordHash],
    );
    await client.query('COMMIT');
    console.log('Administrador creado correctamente.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('No fue posible revertir la transacción de creación del administrador:', rollbackError);
    }
    throw error;
  } finally {
    terminal.close();
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
