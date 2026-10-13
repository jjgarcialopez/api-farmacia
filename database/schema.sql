BEGIN;

CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    correo VARCHAR(160) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol VARCHAR(20) NOT NULL
        CHECK (rol IN ('administrador', 'operador', 'consulta', 'auditor')),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medicamentos (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(40) NOT NULL UNIQUE,
    nombre VARCHAR(140) NOT NULL,
    principio_activo VARCHAR(140),
    presentacion VARCHAR(80),
    requiere_formula BOOLEAN NOT NULL DEFAULT FALSE,
    precio_referencia NUMERIC(12, 2) NOT NULL DEFAULT 0
        CHECK (precio_referencia >= 0),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lotes (
    id BIGSERIAL PRIMARY KEY,
    medicamento_id INTEGER NOT NULL REFERENCES medicamentos(id) ON DELETE RESTRICT,
    codigo_lote VARCHAR(60) NOT NULL,
    fecha_vencimiento DATE NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    costo_unitario NUMERIC(12, 2) NOT NULL CHECK (costo_unitario >= 0),
    precio_venta NUMERIC(12, 2) NOT NULL CHECK (precio_venta >= 0),
    UNIQUE (medicamento_id, codigo_lote)
);

CREATE TABLE IF NOT EXISTS ventas (
    id BIGSERIAL PRIMARY KEY,
    numero VARCHAR(40) NOT NULL UNIQUE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    estado VARCHAR(20) NOT NULL DEFAULT 'confirmada'
        CHECK (estado IN ('confirmada', 'revertida'))
);

CREATE TABLE IF NOT EXISTS detalle_venta (
    id BIGSERIAL PRIMARY KEY,
    venta_id BIGINT NOT NULL REFERENCES ventas(id) ON DELETE RESTRICT,
    lote_id BIGINT NOT NULL REFERENCES lotes(id) ON DELETE RESTRICT,
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    precio_unitario NUMERIC(12, 2) NOT NULL CHECK (precio_unitario >= 0),
    subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0)
);

CREATE TABLE IF NOT EXISTS inventario (
    id BIGSERIAL PRIMARY KEY,
    lote_id BIGINT NOT NULL REFERENCES lotes(id) ON DELETE RESTRICT,
    venta_id BIGINT REFERENCES ventas(id) ON DELETE RESTRICT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    tipo VARCHAR(20) NOT NULL
        CHECK (tipo IN ('entrada', 'salida', 'ajuste', 'reversión')),
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    stock_antes INTEGER NOT NULL CHECK (stock_antes >= 0),
    stock_despues INTEGER NOT NULL CHECK (stock_despues >= 0),
    motivo TEXT NOT NULL,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auditoria (
    id BIGSERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    accion VARCHAR(20) NOT NULL,
    metodo VARCHAR(10) NOT NULL CHECK (metodo IN ('POST', 'PUT', 'DELETE')),
    ruta TEXT NOT NULL,
    recurso VARCHAR(80) NOT NULL,
    recurso_id VARCHAR(80),
    datos_anteriores JSONB,
    datos_nuevos JSONB,
    codigo_http INTEGER NOT NULL CHECK (codigo_http BETWEEN 200 AND 299),
    ip INET,
    user_agent TEXT,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lotes_medicamento_vencimiento
    ON lotes (medicamento_id, fecha_vencimiento)
    WHERE stock > 0;

CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_ventas_usuario_fecha ON ventas (usuario_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_detalle_venta_venta ON detalle_venta (venta_id);
CREATE INDEX IF NOT EXISTS idx_detalle_venta_lote ON detalle_venta (lote_id);
CREATE INDEX IF NOT EXISTS idx_inventario_lote_fecha ON inventario (lote_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_recurso_fecha ON auditoria (recurso, fecha DESC);

INSERT INTO medicamentos (
    codigo, nombre, principio_activo, presentacion, requiere_formula, precio_referencia
)
VALUES
    ('MED-001', 'Acetaminofén 500 mg', 'Acetaminofén', 'Tableta', FALSE, 500.00),
    ('MED-002', 'Loratadina 10 mg', 'Loratadina', 'Tableta', FALSE, 800.00)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO lotes (
    medicamento_id, codigo_lote, fecha_vencimiento, stock, costo_unitario, precio_venta
)
SELECT id, 'LOTE-ACET-001', DATE '2030-12-31', 100, 200.00, 500.00
FROM medicamentos
WHERE codigo = 'MED-001'
ON CONFLICT (medicamento_id, codigo_lote) DO NOTHING;

INSERT INTO lotes (
    medicamento_id, codigo_lote, fecha_vencimiento, stock, costo_unitario, precio_venta
)
SELECT id, 'LOTE-LORA-001', DATE '2030-12-31', 50, 350.00, 800.00
FROM medicamentos
WHERE codigo = 'MED-002'
ON CONFLICT (medicamento_id, codigo_lote) DO NOTHING;

COMMIT;
