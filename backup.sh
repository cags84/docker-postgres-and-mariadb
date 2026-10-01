#!/bin/sh
# ============================================================================
# Servicio de backup del stack cluster-sql.
# Se ejecuta dentro del container 'db-backup' (imagen basada en PostgreSQL 17).
#
# Cada BACKUP_INTERVAL segundos genera un dump comprimido de cada base. Si los
# tres terminan bien, borra los que superen BACKUP_RETENTION_DAYS días.
#
# Regla importante: un dump que falla NO deja archivo. Se escribe primero a
# '<nombre>.part' y solo se renombra a '.sql.gz' si el comando terminó bien,
# para que un fallo nunca se disfrace de backup válido ni desplace a los buenos
# en la rotación.
# ============================================================================
set -u
set -o pipefail

once=0
case "${1:-}" in
  '') ;;
  --once) once=1 ;;
  *) echo "Uso: backup.sh [--once]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "Uso: backup.sh [--once]" >&2; exit 2; }
BACKUP_DIR=/backups
BACKUP_INTERVAL="${BACKUP_INTERVAL:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# --- Validación temprana --------------------------------------------------
# Sin esto, una variable vacía en .env produce dumps de una base equivocada
# (o inexistente) en silencio. Mejor fallar de entrada y decir cuál falta.
missing=""
for var in PGPASSWORD POSTGRES_USER POSTGRES_DB POSTGRES_VECTOR_DB \
           MARIADB_ROOT_PASSWORD MARIADB_DATABASE; do
  eval "value=\${$var:-}"
  [ -n "$value" ] || missing="$missing $var"
done
if [ -n "$missing" ]; then
  echo "!! Variables vacías o ausentes:$missing" >&2
  echo "!! Complétalas en tu .env (usa .env.example como referencia)." >&2
  exit 1
fi

for var in BACKUP_INTERVAL BACKUP_RETENTION_DAYS; do
  eval "value=\${$var}"
  case "$value" in
    ''|*[!0-9]*)
      echo "!! $var debe ser un número entero sin signo." >&2
      exit 1
      ;;
  esac
done
case "$BACKUP_INTERVAL" in
  *[1-9]*) ;;
  *) echo "!! BACKUP_INTERVAL debe ser mayor que cero." >&2; exit 1 ;;
esac
mkdir -p "$BACKUP_DIR" || exit 1

# mariadb-dump lee la contraseña de MYSQL_PWD; pasarla como -p<pass> la dejaría
# visible en la lista de procesos del container.
export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"

# Las dependencias se instalan al construir la imagen, no durante el backup.
for command in pg_dump mariadb-dump gzip flock; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "!! Falta $command. Reconstruye la imagen de backup." >&2
    exit 1
  }
done

# El descriptor se comparte entre contenedores mediante el directorio montado.
# flock libera el bloqueo automáticamente, incluso si el proceso se interrumpe.
exec 9>"$BACKUP_DIR/.backup.lock" || exit 1

mode=automatic
[ "$once" -eq 0 ] || mode=manual
status_file="$BACKUP_DIR/.backup-status-${mode}.json"
cycle_active=0
started_at=""
finished_at=""
write_status() {
  # Solo fechas y estados controlados; nunca se escriben credenciales.
  status_partial="${status_file}.$$.part"
  printf '{"status":"%s","startedAt":"%s","finishedAt":%s}\n' \
    "$1" "$started_at" "${finished_at:-null}" >"$status_partial" &&
    mv "$status_partial" "$status_file"
}
finish_interrupted() {
  if [ "$cycle_active" -eq 1 ]; then
    finished_at="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    write_status interrupted || true
  fi
}
trap finish_interrupted EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# dump <etiqueta> <ruta destino> <comando...>
dump() {
  label="$1"
  target="$2"
  shift 2
  partial="${target}.part"

  if "$@" | gzip -c >"$partial" && mv "$partial" "$target"; then
    echo "    ok     $(basename "$target")  ($(du -h "$target" | cut -f1))"
    return 0
  fi

  rm -f "$partial"
  echo "    ERROR  $label: falló el dump o su guardado, no se generó un backup válido" >&2
  return 1
}

echo "==> Backup activo (intervalo=${BACKUP_INTERVAL}s, retención=${BACKUP_RETENTION_DAYS}d, destino=${BACKUP_DIR})"

while true; do
  if ! flock -n 9; then
    echo "!! Hay otro ciclo de backup activo." >&2
    [ "$once" -eq 0 ] || exit 75
    # Un bloqueo de una acción breve no debe saltarse un día de backups.
    retry_interval=30
    [ "$BACKUP_INTERVAL" -ge 30 ] || retry_interval="$BACKUP_INTERVAL"
    sleep "$retry_interval"
    continue
  fi
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  finished_at=""
  cycle_active=1
  write_status running || { echo "!! No se pudo guardar el estado del backup." >&2; exit 1; }
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

  # Rotar solo tras respaldar las tres bases: una falla prolongada no debe
  # eliminar las últimas copias válidas.
  if [ "$failed" -eq 0 ]; then
    echo "[$DATE] Rotando backups de más de ${BACKUP_RETENTION_DAYS} días..."
    find "$BACKUP_DIR" -type f -name '*.sql.gz' -mtime "+$BACKUP_RETENTION_DAYS" -delete || failed=1
  else
    echo "[$DATE] Rotación omitida: se conservan los backups anteriores."
  fi
  # Restos de intentos interrumpidos (p. ej. si se detuvo el container a media escritura).
  find "$BACKUP_DIR" -type f -name '*.sql.gz.part' -mtime +1 -delete

  # Solo tiene efecto real en Linux nativo; en Docker Desktop la VM traduce el UID.
  chown -R "${UID:-1000}:${GID:-1000}" "$BACKUP_DIR" 2>/dev/null || true

  if [ "$failed" -eq 0 ]; then
    echo "[$DATE] Ciclo OK. Durmiendo ${BACKUP_INTERVAL}s..."
  else
    echo "[$DATE] Ciclo TERMINADO CON ERRORES (ver arriba). Durmiendo ${BACKUP_INTERVAL}s..." >&2
  fi
  finished_at="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  result=succeeded
  [ "$failed" -eq 0 ] || result=failed
  write_status "$result" || { echo "!! No se pudo guardar el resultado del backup." >&2; exit 1; }
  cycle_active=0
  flock -u 9
  [ "$once" -eq 0 ] || exit "$failed"
  sleep "$BACKUP_INTERVAL"
done
