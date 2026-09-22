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
cp .env.example .env       # ajusta usuarios, contraseñas y nombres de las bases
docker compose up -d       # levanta el stack (sin el backup)
docker compose ps          # verifica que todo esté "healthy"
```

> `.env.example` trae **todas** las variables que el compose necesita. Si borras alguna,
> `docker compose up` avisa con `variable is not set` y el servicio afectado arranca mal
> (por ejemplo, sin `POSTGRES_VECTOR_DB` la base vectorial se crea con el nombre del usuario).

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

Por defecto todos los puertos quedan atados a `127.0.0.1` (solo accesibles desde tu máquina, no
desde la WiFi). Para llegar desde otro equipo, mira [Acceso remoto](#acceso-remoto-lan-o-vpn).
Los puertos y los nombres de las bases salen de tu `.env`; abajo se muestran los valores por defecto.

| Servicio          | URL / Conexión   | Puerto en `.env`        | Base de datos en `.env` |
| ----------------- | ---------------- | ----------------------- | ----------------------- |
| PostgreSQL        | `localhost:5432` | `POSTGRES_PORT`         | `POSTGRES_DB`           |
| PostgreSQL vector | `localhost:5433` | `POSTGRES_VECTOR_PORT`  | `POSTGRES_VECTOR_DB`    |
| MariaDB           | `localhost:3306` | `MARIADB_PORT`          | `MARIADB_DATABASE`      |
| pgAdmin 4         | http://localhost:8081 | `PGADMIN_PORT`     | —                       |
| phpMyAdmin        | http://localhost:8082 | `PMA_PORT`         | —                       |

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

Sustituye los valores por los que pusiste en tu `.env`:

```python
# Postgres principal   -> POSTGRES_USER : POSTGRES_PASS @ POSTGRES_PORT / POSTGRES_DB
DATABASE_URL = "postgresql+asyncpg://mi_usuario:mi_password@localhost:5432/mi_base"

# Postgres con pgvector -> POSTGRES_USER : POSTGRES_PASS @ POSTGRES_VECTOR_PORT / POSTGRES_VECTOR_DB
VECTOR_DATABASE_URL = "postgresql+asyncpg://mi_usuario:mi_password@localhost:5433/mi_base_vector"
```

> Los dos Postgres comparten `POSTGRES_USER` y `POSTGRES_PASS`; solo cambian la base y el puerto.

### Laravel corriendo en el host — `.env` del proyecto Laravel

```env
DB_CONNECTION=mariadb
DB_HOST=127.0.0.1
DB_PORT=3306          # MARIADB_PORT
DB_DATABASE=mi_base   # MARIADB_DATABASE
DB_USERNAME=mi_usuario   # MARIADB_USER
DB_PASSWORD=mi_password  # MARIADB_PASSWORD
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
# Ojo: dentro de la red se usa el puerto interno 5432, no POSTGRES_PORT.
DATABASE_URL = "postgresql+asyncpg://mi_usuario:mi_password@postgres:5432/mi_base"
```

---

## Habilitar la extensión `vector` (primera vez)

Usa el usuario y la base que definiste como `POSTGRES_USER` y `POSTGRES_VECTOR_DB`:

```bash
docker exec -it postgres-vector \
  psql -U mi_usuario -d mi_base_vector -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

---

## Acceso remoto (LAN o VPN)

Si Docker corre en otra máquina —un servidor de la LAN, o uno accesible por VPN—
necesitas que los puertos escuchen fuera de `localhost`. Lo controla una sola
variable, `BIND_ADDRESS`:

| Valor | Escucha en | Cuándo |
| ----- | ---------- | ------ |
| `127.0.0.1` | solo esa máquina | Desarrollo local. **Por defecto.** |
| `0.0.0.0` | todas las interfaces | LAN de confianza. Expone a todo lo que alcance el host. |
| `10.x.x.x`, `100.x.x.x`… | solo esa interfaz | **La mejor opción con VPN**: usa la IP que te da la VPN. |

```bash
# .env
BIND_ADDRESS=0.0.0.0
```

```bash
docker compose up -d           # recrea los containers con el nuevo bind
ss -ltn | grep 5432            # comprueba: debe decir 0.0.0.0, no 127.0.0.1
```

Desde el otro equipo se conecta igual, cambiando `localhost` por la IP del servidor:

```python
DATABASE_URL = "postgresql+asyncpg://mi_usuario:mi_password@192.168.1.50:5432/mi_base"
```

### Al exponer, cambia también estas dos

En local son comodidades; con el puerto abierto son agujeros reales.

| Variable | Local | Remoto | Por qué |
| -------- | ----- | ------ | ------- |
| `PGADMIN_SERVER_MODE` | `False` | **`True`** | En `False` pgAdmin usa *"an automatic default login"*: entra **sin pedir contraseña**, con tus conexiones ya guardadas. Su propia documentación avisa: *"DO NOT DISABLE SERVER MODE IF RUNNING ON A WEBSERVER!!"*. En `True` exige `PGADMIN_DEFAULT_EMAIL` + `PGADMIN_DEFAULT_PASSWORD`. |
| `PMA_ARBITRARY` | `1` | **`0`** | En `1` la pantalla de login de phpMyAdmin acepta **cualquier host** MySQL/MariaDB, así que sirve de trampolín hacia otras bases alcanzables desde el container. En `0` solo habla con el MariaDB del compose. |

Y ahora las contraseñas del `.env` sí importan: en local casi daba igual lo que
pusieras porque nada salía de tu máquina.

### El firewall del host no te protege

Esto sorprende a mucha gente. Un `ufw deny 5432` **no cierra** un puerto publicado por
Docker. La documentación de Docker lo dice sin rodeos:

> *"When you publish a container's ports using Docker, traffic to and from that
> container gets diverted before it goes through the ufw firewall settings."*

El motivo es que Docker enruta en la tabla `nat`, y los paquetes se desvían antes de
llegar a las cadenas `INPUT`/`OUTPUT` que usa ufw. Con `firewalld` no es exactamente un
bypass, pero Docker crea una zona `docker` con target `ACCEPT`, con el mismo efecto
práctico.

**Consecuencia:** no publiques en `0.0.0.0` confiando en cerrarlo luego con el firewall.
Ata `BIND_ADDRESS` a la IP de la VPN, que es la interfaz por la que de verdad quieres
recibir tráfico.

## Backups

El servicio `backup` es **opcional** y solo arranca con su perfil:

```bash
docker compose --profile backup up -d
docker compose logs -f backup      # ver cada ciclo
```

La lógica está en [`backup.sh`](backup.sh) (se monta dentro del container, así que
puedes editarlo y aplicar con `docker compose restart backup`). Cada
`BACKUP_INTERVAL` segundos vuelca las tres bases a `./backups/`:

```
backups/postgres_<POSTGRES_DB>_2026-09-22_03-00-00.sql.gz
backups/pgvector_<POSTGRES_VECTOR_DB>_2026-09-22_03-00-00.sql.gz
backups/mariadb_<MARIADB_DATABASE>_2026-09-22_03-00-00.sql.gz
```

| Variable de `.env`      | Por defecto | Qué hace |
| ----------------------- | ----------- | -------- |
| `BACKUP_INTERVAL`       | `86400`     | Segundos entre ciclos (86400 = 24 h) |
| `BACKUP_RETENTION_DAYS` | `7`         | Borra los `.sql.gz` más antiguos que esto |
| `UID` / `GID`           | `1000`      | Dueño de los archivos generados (solo Linux nativo) |

**Un dump que falla no deja archivo.** El volcado se escribe primero como
`.sql.gz.part` y solo se renombra si el comando terminó bien, para que un fallo
(contraseña mala, base inexistente) no se disfrace de backup válido ni desplace a
los buenos cuando corre la rotación. Si algo falla, el ciclo lo registra como
`ERROR` y termina con `Ciclo TERMINADO CON ERRORES`.

**Alcance:** se respalda **una base por servidor** — las que indican `POSTGRES_DB`,
`POSTGRES_VECTOR_DB` y `MARIADB_DATABASE`. No incluye otras bases que hayas creado
a mano ni los roles globales de PostgreSQL (eso sería `pg_dumpall --globals-only`).

### Backup manual a demanda

Sin necesidad de levantar el servicio:

```bash
docker exec postgres pg_dump -U mi_usuario mi_base | gzip > backup_$(date +%F).sql.gz
```

### Restaurar

```bash
# PostgreSQL (los dumps se generan con --clean --if-exists: reemplazan lo que haya)
gunzip -c backups/postgres_mi_base_2026-09-22_03-00-00.sql.gz \
  | docker exec -i postgres psql -U mi_usuario -d mi_base

# MariaDB
gunzip -c backups/mariadb_mi_base_2026-09-22_03-00-00.sql.gz \
  | docker exec -i mariadb mariadb -u root -p mi_base
```

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
docker exec -it postgres psql -U mi_usuario -d mi_base
docker exec -it mariadb mariadb -u root -p

# Ver estado de salud de todos los servicios
docker compose ps
```

---

## Troubleshooting

**No puedo conectar desde otra máquina**
Revisa `BIND_ADDRESS` en tu `.env` (por defecto es `127.0.0.1`, que solo acepta conexiones
locales) y recrea con `docker compose up -d`. Comprueba con `ss -ltn | grep <puerto>`: si
muestra `127.0.0.1` en vez de `0.0.0.0` o la IP esperada, el cambio no se aplicó. Ver
[Acceso remoto](#acceso-remoto-lan-o-vpn) — y ojo, el firewall del host no interviene aquí.

**`variable is not set. Defaulting to a blank string`**
A tu `.env` le falta una variable que el compose usa. Compáralo con `.env.example`.
El caso más silencioso es `POSTGRES_VECTOR_DB`: sin él, la base vectorial se crea con
el nombre del usuario en vez del que esperas. Si el servicio `backup` detecta variables
vacías se detiene y las lista en su log en vez de generar dumps equivocados.

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