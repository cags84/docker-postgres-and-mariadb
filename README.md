# cluster-sql — stack de DBs para desarrollo local

Stack listo para correr en tres entornos:

| Plataforma | Runtime recomendado |
| ---------- | ------------------- |
| macOS      | **OrbStack** |
| Windows    | **Docker Desktop** con backend **WSL2** |
| Linux      | **Docker Engine** nativo (`docker-ce`) |

Incluye **PostgreSQL 17**, **PostgreSQL 17 + pgvector**, **MariaDB LTS**, **pgAdmin 4** y **phpMyAdmin**.

---

## Inicio rápido (igual en los 3 entornos)

```bash
cp .env.example .env       # ajusta las contraseñas
docker compose up -d       # levanta el stack (sin el backup)
docker compose ps          # verifica que todo esté "healthy"
```

Para incluir backups automáticos:

```bash
docker compose --profile backup up -d
```

Detener todo (manteniendo los datos):

```bash
docker compose down
```

Borrar todo, incluidos los datos:

```bash
docker compose down -v
```

---

## Servicios y puertos

Todos los puertos quedan atados a `127.0.0.1` (solo accesibles desde tu máquina, no desde la WiFi).

| Servicio          | URL / Conexión                        |
| ----------------- | ------------------------------------- |
| PostgreSQL        | `localhost:5432` (db: `app_db`)       |
| PostgreSQL vector | `localhost:5433` (db: `vector_db`)    |
| MariaDB           | `localhost:3306` (db: `laravel_db`)   |
| pgAdmin 4         | http://localhost:8081                 |
| phpMyAdmin        | http://localhost:8082                 |

### Bonus si usas OrbStack

OrbStack genera un dominio automático para cada servicio del compose, con HTTPS incluido. No hace falta recordar puertos:

| Servicio          | Dominio OrbStack                                    |
| ----------------- | --------------------------------------------------- |
| pgAdmin 4         | https://pgadmin4.cluster-sql.orb.local              |
| phpMyAdmin        | https://phpmyadmin.cluster-sql.orb.local            |
| PostgreSQL        | `postgres.cluster-sql.orb.local:5432`               |
| PostgreSQL vector | `postgres-vector.cluster-sql.orb.local:5432`        |
| MariaDB           | `mariadb.cluster-sql.orb.local:3306`                |

> El TLD es `.orb.local`. Los certificados HTTPS los genera OrbStack y se confían automáticamente en macOS — no aparece la advertencia del navegador.

---

## Conectar desde tu app

### FastAPI corriendo en el host

```python
# Postgres principal
DATABASE_URL = "postgresql+asyncpg://postgres:changeme_strong_password@localhost:5432/app_db"

# Postgres con pgvector
VECTOR_DATABASE_URL = "postgresql+asyncpg://postgres:changeme_strong_password@localhost:5433/vector_db"
```

### Laravel corriendo en el host — `.env` del proyecto Laravel

```env
DB_CONNECTION=mariadb
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=laravel_db
DB_USERNAME=laravel
DB_PASSWORD=changeme_user_password
```

### Si tu app también corre en Docker

Únela a la red `cluster-sql_db_network` y usa los nombres de servicio (`postgres`, `mariadb`, `postgres-vector`) como host:

```yaml
# en el compose de tu app
services:
  api:
    networks: [cluster-sql_db_network]

networks:
  cluster-sql_db_network:
    external: true
```

Dentro del container la URL queda así:

```python
DATABASE_URL = "postgresql+asyncpg://postgres:changeme_strong_password@postgres:5432/app_db"
```

---

## Habilitar la extensión `vector` (primera vez)

```bash
docker exec -it postgres-vector \
  psql -U postgres -d vector_db -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

---

## Notas por plataforma

### 🍎 macOS con OrbStack

**Instalación:**
```bash
brew install --cask orbstack
```
o descargar desde https://orbstack.dev.

**Por qué OrbStack y no Docker Desktop:**
- Arranca en ~2 segundos vs varios segundos de Docker Desktop.
- Menor consumo de RAM/CPU en idle (decenas de MB vs varios GB).
- Bind mounts notablemente más rápidos (VirtioFS optimizado nativamente).
- Soporta Rosetta nativamente para imágenes amd64 (no las necesitamos aquí porque las del compose son multi-arch).
- CLI 100% compatible con `docker` y `docker compose` — el compose funciona sin modificar nada.

**No necesitas configurar nada de recursos**: OrbStack auto-ajusta la VM según el host. A diferencia de Docker Desktop, no hay un panel "Settings → Resources" que ajustar.

**Comandos útiles específicos de OrbStack:**
```bash
orb                    # abre la app
orb logs postgres      # logs del container
open ~/OrbStack        # navegar volúmenes desde Finder
```

### 🪟 Windows con Docker Desktop + WSL2

**Instalación:**
1. Habilita WSL2: en PowerShell como administrador `wsl --install`.
2. Instala una distro Linux desde Microsoft Store (Ubuntu 24.04 LTS recomendado).
3. Descarga Docker Desktop desde https://www.docker.com/products/docker-desktop. Durante la instalación marca **"Use WSL 2 instead of Hyper-V"**.
4. En Docker Desktop → Settings → Resources → WSL Integration: activa la integración con tu distro.

**Regla de oro de performance:**
> El proyecto debe vivir **dentro del filesystem de WSL2**, no en `C:\Users\...`.

Concretamente:
- ✅ Bien: `/home/tu-usuario/proyectos/cluster-sql/` (dentro de Ubuntu WSL)
- ❌ Mal: `C:\Users\tu-usuario\proyectos\cluster-sql\` (en NTFS, accedido vía `/mnt/c/`)

La diferencia es enorme: bind mounts en `/mnt/c/` son lentísimos. En el filesystem WSL2 son casi como Linux nativo.

**Cómo trabajar:**
- Abre la terminal de Ubuntu WSL y trabaja desde ahí.
- En VS Code instala la extensión **WSL** y abre la carpeta con `code .` desde dentro de WSL.
- Desde el Explorador de Windows accedes vía `\\wsl$\Ubuntu\home\tu-usuario\...` si necesitas.

**Comandos útiles:**
```powershell
wsl --update              # actualiza el kernel de WSL2
wsl --status              # versión y distro por defecto
wsl --shutdown            # reinicia WSL si Docker se vuelve raro
```

### 🐧 Linux nativo (Docker Engine)

**Instalación:**
```bash
# Sigue las instrucciones oficiales para tu distro:
# https://docs.docker.com/engine/install/

# Después, agrégate al grupo docker para no tener que usar sudo:
sudo usermod -aG docker $USER
newgrp docker

# Verifica:
docker compose version
```

**Particularidades de Linux:**
- No hay VM intermedia: bind mounts son a nivel de kernel, máxima performance.
- El `chown -R $UID:$GID /backups` del servicio backup **sí funciona aquí** — los archivos quedan con tu usuario en el host. En macOS/Windows ese paso no aplica (la traducción de UID la hace la VM).
- Asegúrate de que `UID` y `GID` en `.env` coincidan con tu usuario:
  ```bash
  echo "UID=$(id -u)"
  echo "GID=$(id -g)"
  ```

---

## Comandos útiles del día a día

```bash
# Ver logs en vivo
docker compose logs -f postgres

# Reiniciar un solo servicio
docker compose restart mariadb

# Entrar a un container
docker exec -it postgres psql -U postgres -d app_db
docker exec -it mariadb mariadb -u root -p

# Backup manual a demanda (sin levantar el contenedor backup)
docker exec postgres pg_dump -U postgres app_db | gzip > backup_$(date +%F).sql.gz

# Restaurar un backup
gunzip -c backup_2026-04-26.sql.gz | docker exec -i postgres psql -U postgres -d app_db

# Ver estado de salud de todos los servicios
docker compose ps
```

---

## Troubleshooting

**"port is already allocated"**
Ya tienes algo escuchando en ese puerto. Cambia el puerto en `.env` (`POSTGRES_PORT`, `MARIADB_PORT`, etc.) o detén el otro proceso.

**El healthcheck nunca pasa a "healthy"**
Mira los logs: `docker compose logs <servicio>`. Causa más común: contraseña incorrecta o conflicto del volumen con datos previos. Limpia con `docker compose down -v` (¡borra los datos!).

**pgAdmin da 401 Unauthorized al entrar**
Si ves en los logs `sudo: The "no new privileges" flag is set` y `The desktop user ... was not found in the configuration database`: el entrypoint de pgAdmin necesita `sudo` para crear su "desktop user", y el flag `no-new-privileges` lo bloquea. En este compose pgAdmin ya está configurado **sin** ese flag por esa razón. Si modificaste el archivo y agregaste `security_opt: no-new-privileges:true` al servicio `pgadmin4`, quítalo. Reinicia con `docker compose down -v && docker compose up -d` (¡borra los datos!) o limpia solo el volumen de pgAdmin: `docker volume rm cluster-sql_pgadmin_data`.

**En Windows todo va lentísimo**
Asegúrate de que el proyecto está en el filesystem WSL2, no en `C:\`. Ver sección "Windows" arriba.

**En macOS los puertos no responden después de `compose up`**
Espera unos segundos al primer arranque (sobre todo de pgAdmin, que tarda en inicializar). Verifica `docker compose ps` que estén `healthy`.