# cluster-sql

Monorepo para administrar un stack local de PostgreSQL, PostgreSQL con pgvector y MariaDB. Incluye pgAdmin, phpMyAdmin, backups y un dashboard web. El dashboard se ejecuta en el host y controla Docker mediante su CLI.

## Estado actual

- Dashboard con estado, salud, detalle del healthcheck y puertos publicados de los seis servicios del proyecto.
- Logs en vivo, con pausa y reconexión; cada conexión empieza con las últimas 200 líneas y la pantalla conserva hasta 5.000.
- Acciones para iniciar, detener y reiniciar servicios, con resultado visible en la actividad reciente.
- Acceso a pgAdmin y phpMyAdmin mediante enlaces con los puertos reales.
- Listado y descarga de dumps, backup manual y estado persistente del último ciclo automático.
- Bloqueo compartido entre backups y acciones del dashboard que afectan sus bases o dependencias.

El alcance es desarrollo local. No incluye autenticación, acceso remoto al dashboard, métricas de CPU/RAM, restauración o eliminación desde la UI, ni administración de otros proyectos Docker. La actividad de las acciones vive en memoria y se pierde al reiniciar la API; el resultado del backup automático permanece en disco.

## Requisitos

- Docker activo y Docker Compose v2 disponibles en la terminal.
- Node.js 24 (ver [.nvmrc](.nvmrc)) y pnpm 12.8.1 (ver [package.json](package.json)).
- Python 3 para ejecutar las pruebas de backups y la integración con Docker.

Ejecuta los comandos desde la raíz del repositorio. En Windows, usa un entorno WSL2 con acceso a Docker y ejecuta también Node/pnpm allí.

## Inicio

1. Si aún no existe `.env`, copia la plantilla:

   ```sh
   cp .env.example .env
   ```

   Edita usuarios, contraseñas, nombres de las tres bases y el correo de pgAdmin. No sobrescribas un `.env` existente. Las credenciales de la plantilla son ejemplos.

2. Valida y levanta las bases y sus herramientas:

   ```sh
   docker compose config --quiet
   docker compose up -d --wait
   ```

3. Instala las dependencias e inicia el dashboard:

   ```sh
   pnpm install --frozen-lockfile
   pnpm dev
   ```

Abre [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite sirve la web en 5173 y redirige `/api` a la API en 3000. El dashboard también muestra los servicios que todavía no se han creado; iniciarlos requiere un `.env` válido.

Para servir la aplicación compilada sin Vite:

```sh
pnpm build
pnpm start
```

Abre [http://127.0.0.1:3000](http://127.0.0.1:3000). El servidor usa los archivos compilados de `apps/web/dist`; vuelve a compilar después de cambiar el código.

## Servicios y conexiones

Los puertos siguientes son los valores de `.env.example`; puedes modificarlos en `.env`.

| Servicio Compose | Imagen | Acceso desde el host | Dentro de la red Compose |
| --- | --- | --- | --- |
| `postgres` | `postgres:17-trixie` | `127.0.0.1:5432` | `postgres:5432` |
| `postgres-vector` | `pgvector/pgvector:pg17-trixie` | `127.0.0.1:5433` | `postgres-vector:5432` |
| `mariadb` | `mariadb:lts-ubi9` | `127.0.0.1:3306` | `mariadb:3306` |
| `pgadmin4` | `dpage/pgadmin4:9` | [localhost:8081](http://127.0.0.1:8081) | `pgadmin4:80` |
| `phpmyadmin` | `phpmyadmin:5` | [localhost:8082](http://127.0.0.1:8082) | `phpmyadmin:80` |
| `backup` | `cluster-sql-backup:pg17` (construida localmente) | Carpeta `backups/` | Sin puerto publicado |

En pgAdmin registra los servidores como `postgres:5432` y `postgres-vector:5432`, usando `POSTGRES_USER` y `POSTGRES_PASS`. Ambas instancias comparten esas credenciales, pero tienen bases y volúmenes separados. phpMyAdmin apunta a `mariadb`; ingresa con un usuario de MariaDB.

La imagen pgvector incluye la extensión, pero debes habilitarla en cada base donde la necesites:

```sh
docker compose exec postgres-vector sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"'
```

Los datos persisten en los volúmenes `postgres_data`, `pg_vector_data`, `mariadb_data` y `pgadmin_data` del proyecto Compose `cluster-sql`. Cambiar las credenciales o nombres de bases en `.env` no modifica las bases ya inicializadas: realiza esos cambios con SQL y actualiza la configuración correspondiente.

## Backups

Para activar el servicio periódico:

```sh
docker compose --profile backup up -d --build backup
```

El primer ciclo empieza al arrancar. `BACKUP_INTERVAL` define la espera entre ciclos (86.400 segundos por defecto) y `BACKUP_RETENTION_DAYS` la retención (7 por defecto). En Linux, ajusta `UID` y `GID` al propietario deseado de los archivos.

El botón de backup manual requiere las tres bases en ejecución y saludables. No necesita mantener activo el servicio periódico. Su equivalente por terminal es:

```sh
docker compose build backup
docker compose --profile backup run --rm --no-deps -T backup --once
```

Cada ciclo genera tres dumps SQL comprimidos en `backups/`: uno de `POSTGRES_DB`, uno de `POSTGRES_VECTOR_DB` y uno de `MARIADB_DATABASE`. No respalda otras bases, roles globales de PostgreSQL ni la configuración de pgAdmin. El backup de cada base es independiente; el ciclo no es una instantánea sincronizada de las tres.

Los archivos se escriben como `.sql.gz.part` y se publican como `.sql.gz` solo cuando el dump termina correctamente. La rotación usa `find -mtime +BACKUP_RETENTION_DAYS` y solo se ejecuta si los tres dumps tuvieron éxito; los fallos conservan las copias anteriores.

`backups/.backup.lock` impide ciclos simultáneos. Las acciones del dashboard que afectan bases o sus dependencias usan el mismo bloqueo mediante un contenedor temporal. Los comandos Docker ejecutados directamente fuera del dashboard no pasan por esa protección.

El script guarda el último estado en `.backup-status-automatic.json` y `.backup-status-manual.json`. El dashboard muestra el automático: en curso, completado, fallido o interrumpido. Si todavía no existe, muestra que no hay un ciclo registrado. Las fechas del estado se guardan en UTC; los nombres de los dumps usan la zona horaria del servicio. No se guarda un historial de ciclos.

La restauración se realiza por CLI o por las herramientas de gestión. Selecciona el archivo, la instancia y la base de destino, y valida la recuperación antes de depender de una copia. La prueba de integración incluye una restauración real de las tres bases y de datos vectoriales.

Si cambias `backup.sh`, reinicia `backup`; si cambias su Dockerfile, reconstruye y recrea el servicio:

```sh
docker compose --profile backup restart backup
# Después de cambiar docker/backup/Dockerfile:
docker compose --profile backup up -d --build backup
```

## Configuración del dashboard

Estas variables se pasan al proceso Node mediante su entorno; no se cargan automáticamente desde `.env`. Ese archivo configura Compose.

| Variable | Valor predeterminado | Uso |
| --- | --- | --- |
| `DASHBOARD_PROJECT` | `cluster-sql` | Filtrado por etiqueta de proyecto Compose |
| `DASHBOARD_COMPOSE_FILE` | `docker-compose.yml` | Archivo para ejecutar las acciones |
| `DASHBOARD_ENV_FILE` | Sin override | Archivo de variables alternativo para Compose |
| `DASHBOARD_BACKUPS_DIR` | `backups` | Carpeta que lista y sirve la API |
| `DASHBOARD_PORT` | `3000` | Puerto de la API y de la web compilada |

Las rutas relativas se resuelven desde la raíz del repositorio. El directorio de backups de la API debe corresponder al montaje `/backups` de Compose. Mantén coherentes el proyecto, el archivo Compose y sus etiquetas.

La API fija el contexto Docker al usarlo por primera vez y lo muestra en el dashboard. Si cambias de contexto, reinicia la API. Solo administra los seis nombres de servicio definidos en el proyecto; excluye contenedores temporales de `compose run`.

Para cambiar el puerto, usa la aplicación compilada, por ejemplo `DASHBOARD_PORT=3001 pnpm start`. En desarrollo, el proxy Vite apunta a 3000 y requiere modificar también `apps/web/vite.config.ts` si cambias ese puerto.

## Acceso remoto

`BIND_ADDRESS=127.0.0.1` publica las bases y sus herramientas únicamente en el host. Cambiarlo a una IP de LAN/VPN o a `0.0.0.0` amplía ese acceso. Antes de hacerlo, configura credenciales propias, `PGADMIN_SERVER_MODE=True`, `PMA_ARBITRARY=0` y las restricciones de acceso de tu entorno.

El dashboard sigue ligado a `127.0.0.1`, sin autenticación y con validación de Host/Origin local. `BIND_ADDRESS` no cambia su dirección de escucha. No está preparado para publicarse en la red.

`TZ` configura la zona horaria del stack; `POSTGRES_TZ`, `MARIADB_TZ`, `PMA_TZ`, `PGADMIN_TZ` y `BACKUP_TZ` permiten overrides por servicio.

## Desarrollo y validación

| Comando | Verificación |
| --- | --- |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Tipos de contratos, API y web |
| `pnpm test` | Pruebas de API, componentes web y script de backups |
| `pnpm build` | Compilación de los tres paquetes |
| `python3 tests/runtime_test.py` | Integración real con Docker, después de compilar |

La integración crea un proyecto temporal, puertos de bases asignados por Docker y volúmenes propios. Verifica servicios, enlaces, acciones, bloqueos, backups, descargas y restauración; elimina sus recursos al finalizar. Necesita Docker activo, imágenes disponibles y el puerto 3010 libre. Con `--keep`, conserva el entorno mientras inspeccionas la UI; termina con Ctrl+C para ejecutar la limpieza.

## Diagnóstico

- **Variables ausentes:** revisa `.env` y ejecuta `docker compose config --quiet`.
- **Docker no responde o faltan servicios:** comprueba `docker info`, `docker context show` y `docker compose ps -a`; reinicia la API después de cambiar de contexto.
- **Servicio no saludable:** consulta su detalle en el dashboard o `docker compose logs --tail 100 NOMBRE_SERVICIO`.
- **Puerto ocupado:** cambia el puerto del servicio en `.env` y recréalo con `docker compose up -d NOMBRE_SERVICIO`.
- **Acción bloqueada:** espera a que termine el backup o la operación dependiente y revisa su resultado en actividad reciente.
- **Credenciales nuevas no funcionan:** el volumen conserva las credenciales anteriores; cambiar `.env` no las reemplaza.

`docker compose down` elimina contenedores y red, conservando los volúmenes. Añadir `-v` elimina los datos persistentes; no lo uses como solución rutinaria a errores.

## Mapa del repositorio

Consulta [AGENTS.md](AGENTS.md) para orientarte al trabajar con agentes o LLMs. La implementación se divide entre `apps/web`, `apps/api` y `packages/contracts`; la infraestructura vive en `docker-compose.yml`, `backup.sh` y `docker/backup/`.

Licencia [MIT](LICENSE).
