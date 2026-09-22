#!/bin/sh
# ============================================================================
# Servicio de backup del stack cluster-sql.
# Se ejecuta dentro del container 'db-backup' (imagen postgres:17-alpine).
#
# Cada BACKUP_INTERVAL segundos genera un dump comprimido de cada base y borra
# los que superen BACKUP_RETENTION_DAYS días.
#
# Regla importante: un dump que falla NO deja archivo. Se escribe primero a
# '<nombre>.part' y solo se renombra a '.sql.gz' si el comando terminó bien,
# para que un fallo nunca se disfrace de backup válido ni desplace a los buenos
# en la rotación.
# ============================================================================
set -u
set -o pipefail

BACKUP_DIR=/backups
BACKUP_INTERVAL="${BACKUP_INTERVAL:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
mkdir -p "$BACKUP_DIR"

# --- Validación temprana --------------------------------------------------
# Sin esto, una variable vacía en .env produce dumps de una base equivocada
# (o inexistente) en silencio. Mejor fallar de entrada y decir cuál falta.
missing=""
for var in POSTGRES_USER POSTGRES_DB POSTGRES_VECTOR_DB \
           MARIADB_ROOT_PASSWORD MARIADB_DATABASE; do
  eval "value=\${$var:-}"
  [ -n "$value" ] || missing="$missing $var"
done
if [ -n "$missing" ]; then
  echo "!! Variables vacías o ausentes:$missing" >&2
  echo "!! Complétalas en tu .env (usa .env.example como referencia)." >&2
  exit 1
fi

# mariadb-dump lee la contraseña de MYSQL_PWD; pasarla como -p<pass> la dejaría
# visible en la lista de procesos del container.
export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"

# --- Dependencias ---------------------------------------------------------
# La imagen base solo trae el cliente de PostgreSQL.
if ! command -v mariadb-dump >/dev/null 2>&1; then
  echo "==> Instalando mariadb-client..."
  if ! apk add --no-cache mariadb-client tzdata >/dev/null; then
    echo "!! No se pudo instalar mariadb-client (¿sin conexión?)." >&2
    echo "!! Los backups de PostgreSQL continúan; los de MariaDB se omitirán." >&2
  fi
fi

# dump <etiqueta> <ruta destino> <comando...>
dump() {
  label="$1"
  target="$2"
  shift 2
  partial="${target}.part"

  if "$@" | gzip -c >"$partial"; then
    mv "$partial" "$target"
    echo "    ok     $(basename "$target")  ($(du -h "$target" | cut -f1))"
    return 0
  fi

  rm -f "$partial"
  echo "    ERROR  $label: el dump falló, no se generó archivo" >&2
  return 1
}

echo "==> Backup activo (intervalo=${BACKUP_INTERVAL}s, retención=${BACKUP_RETENTION_DAYS}d, destino=${BACKUP_DIR})"

while true; do
  DATE=$(date +%F_%H-%M-%S)
  failed=0
  echo "[$DATE] Iniciando ciclo de backup..."

  dump "PostgreSQL ($POSTGRES_DB)" \
    "$BACKUP_DIR/postgres_${POSTGRES_DB}_${DATE}.sql.gz" \
    pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists || failed=1

  dump "pgvector ($POSTGRES_VECTOR_DB)" \
    "$BACKUP_DIR/pgvector_${POSTGRES_VECTOR_DB}_${DATE}.sql.gz" \
    pg_dump -h postgres-vector -U "$POSTGRES_USER" -d "$POSTGRES_VECTOR_DB" \
      --clean --if-exists || failed=1

  if command -v mariadb-dump >/dev/null 2>&1; then
    dump "MariaDB ($MARIADB_DATABASE)" \
      "$BACKUP_DIR/mariadb_${MARIADB_DATABASE}_${DATE}.sql.gz" \
      mariadb-dump -h mariadb -u root \
        --single-transaction --routines --triggers --events \
        "$MARIADB_DATABASE" || failed=1
  else
    echo "    omitido  MariaDB (mariadb-dump no disponible)" >&2
    failed=1
  fi

  echo "[$DATE] Rotando backups de más de ${BACKUP_RETENTION_DAYS} días..."
  find "$BACKUP_DIR" -type f -name '*.sql.gz' -mtime "+$BACKUP_RETENTION_DAYS" -delete
  # Restos de intentos interrumpidos (p. ej. si se detuvo el container a media escritura).
  find "$BACKUP_DIR" -type f -name '*.sql.gz.part' -mtime +1 -delete

  # Solo tiene efecto real en Linux nativo; en Docker Desktop la VM traduce el UID.
  chown -R "${UID:-1000}:${GID:-1000}" "$BACKUP_DIR" 2>/dev/null || true

  if [ "$failed" -eq 0 ]; then
    echo "[$DATE] Ciclo OK. Durmiendo ${BACKUP_INTERVAL}s..."
  else
    echo "[$DATE] Ciclo TERMINADO CON ERRORES (ver arriba). Durmiendo ${BACKUP_INTERVAL}s..." >&2
  fi
  sleep "$BACKUP_INTERVAL"
done
