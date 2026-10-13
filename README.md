# API de gestión de farmacia

API REST para administrar usuarios, medicamentos, lotes, inventario y ventas de una farmacia. Incluye autenticación con JWT, permisos por roles y registro de auditoría.

## Funcionalidades

- Inicio de sesión y autenticación mediante tokens JWT.
- Administración de usuarios y asignación de roles.
- Gestión de medicamentos y lotes.
- Consulta de inventario y registro de movimientos.
- Creación y consulta de ventas.
- Consulta de auditoría de operaciones.
- Validación de datos y respuestas JSON.
- Verificación del estado de la API y de la conexión con la base de datos.

## Tecnologías

- Node.js y Express
- PostgreSQL
- `pg` para conectarse a la base de datos
- JWT y `bcrypt` para autenticación y manejo seguro de contraseñas
- Zod para validar solicitudes
- Helmet, CORS y express-rate-limit para protecciones HTTP

## Requisitos

- Node.js y npm
- PostgreSQL
- `psql` disponible en la terminal para ejecutar el esquema de base de datos

## Instalación y ejecución local

1. Clona el repositorio y entra a la carpeta del proyecto:

   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd api-farmacia
   ```

2. Instala las dependencias:

   ```bash
   npm install
   ```

3. Crea en PostgreSQL una base de datos llamada `api_farmacia` (o el nombre que prefieras).

4. Copia el archivo de ejemplo de variables de entorno:

   ```powershell
   Copy-Item .env.example .env
   ```

   También puedes crear `.env` manualmente y usar como referencia `.env.example`.

5. Edita `.env` con los datos de conexión de tu PostgreSQL. Configura `JWT_SECRET` con un valor aleatorio propio de al menos 32 bytes. No compartas ni subas este archivo al repositorio.

   ```env
   PORT=3000
   CORS_ORIGIN=http://localhost:3000

   DB_HOST=localhost
   DB_PORT=5432
   DB_USER=postgres
   DB_PASSWORD=tu_contraseña_local
   DB_NAME=api_farmacia

   JWT_SECRET=reemplaza-esto-con-un-secreto-aleatorio-de-32-bytes-o-mas
   ```

6. Crea las tablas y los datos iniciales:

   ```bash
   psql -U postgres -d api_farmacia -f database/schema.sql
   ```

   El esquema crea las tablas e índices requeridos e inserta algunos medicamentos y lotes de ejemplo. Si cambiaste `DB_NAME`, usa ese nombre en el comando.

7. Crea el primer usuario administrador:

   ```bash
   npm run create-admin
   ```

   El comando solicita nombre, correo y contraseña en la terminal. La contraseña debe tener al menos 12 caracteres y no se muestra mientras se escribe. Debe existir una terminal interactiva y no debe haber ya un usuario con rol administrador.

8. Inicia el servidor:

   ```bash
   npm start
   ```

   Para desarrollo con reinicio automático al cambiar archivos:

   ```bash
   npm run dev
   ```

Por defecto, la API escucha en `http://localhost:3000`. Puedes cambiar el puerto mediante la variable `PORT`.

## Comprobación del servicio

- `GET /health`: comprueba que la API esté activa.
- `GET /health/db`: comprueba además la conexión con PostgreSQL.

Ejemplo:

```bash
curl http://localhost:3000/health
```

## Autenticación

Inicia sesión enviando el correo y la contraseña:

```http
POST /api/auth/login
Content-Type: application/json
```

```json
{
  "correo": "admin@ejemplo.com",
  "password": "una-contraseña-segura"
}
```

La respuesta incluye un token JWT. En las rutas protegidas, envíalo en la cabecera:

```http
Authorization: Bearer <token>
```

El acceso a las operaciones depende del rol. Los roles disponibles son `administrador`, `operador`, `consulta` y `auditor`. Algunas operaciones, como la administración de usuarios y la consulta de auditoría, están restringidas a roles específicos.

## Endpoints principales

Todas las rutas de API usan el prefijo `/api`. Excepto el inicio de sesión, las rutas requieren autenticación; algunas requieren además un rol autorizado.

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Inicia sesión y obtiene un token JWT. |
| `GET` | `/api/medicamentos` | Lista medicamentos. |
| `GET` | `/api/medicamentos/:id` | Consulta un medicamento. |
| `POST` | `/api/medicamentos` | Crea un medicamento. |
| `PUT` | `/api/medicamentos/:id` | Actualiza un medicamento. |
| `DELETE` | `/api/medicamentos/:id` | Desactiva un medicamento. |
| `GET` | `/api/lotes` | Lista lotes. |
| `GET` | `/api/lotes/:id` | Consulta un lote. |
| `POST` | `/api/lotes` | Crea un lote. |
| `PUT` | `/api/lotes/:id` | Actualiza datos de un lote. |
| `DELETE` | `/api/lotes/:id` | Elimina un lote cuando no existen referencias que lo impidan. |
| `GET` | `/api/inventario` | Consulta movimientos de inventario. |
| `GET` | `/api/ventas` | Lista ventas. |
| `GET` | `/api/ventas/:id` | Consulta una venta y su detalle. |
| `POST` | `/api/ventas` | Registra una venta. |
| `GET` | `/api/auditoria` | Consulta el registro de auditoría. |
| `GET` | `/api/usuarios` | Lista usuarios. |
| `GET` | `/api/usuarios/:id` | Consulta un usuario. |
| `POST` | `/api/usuarios` | Crea un usuario. |
| `PUT` | `/api/usuarios/:id` | Actualiza un usuario. |
| `DELETE` | `/api/usuarios/:id` | Desactiva un usuario. |

Los endpoints de listado admiten paginación y, según el recurso, filtros adicionales. Para conocer los campos requeridos y filtros disponibles, consulta la validación y la ruta correspondiente dentro de `src/routes/`.

## Estructura del proyecto

```text
database/
  schema.sql          Esquema inicial, índices y datos de ejemplo
scripts/
  create-admin.js     Creación interactiva del primer administrador
src/
  app.js              Configuración de Express y registro de rutas
  config/             Conexión a PostgreSQL
  controllers/        Controladores de la API
  middleware/         Autenticación y autorización
  routes/             Endpoints de cada recurso
  services/           Operaciones compartidas de base de datos
```

## Seguridad y configuración

- No subas `.env` al repositorio: contiene credenciales y secretos locales.
- Usa un `JWT_SECRET` fuerte, aleatorio y de al menos 32 bytes.
- Configura `CORS_ORIGIN` con los orígenes que realmente deban consumir la API.
- Las contraseñas de usuario se almacenan como hashes generados con `bcrypt`.
- El inicio de sesión limita la cantidad de intentos.

## Licencia

No se ha especificado una licencia para este proyecto.
