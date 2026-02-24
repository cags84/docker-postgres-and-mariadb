# Despliegue de Postgres y MariaDB en Docker

Este repositorio pretende tener una base para el despliegue de Postgres en la versión requerida, así como de MariaDB.

Se incluye los complementos PhpMyAdmin en su última versión y de PgAdmin 4.

La idea es parametrizar por medio de un archivo env, el cual nos permite dar una configuración más precisa de estas aplicaciones.

Para poder usar este repositorio, podemos seguir estos pasos

** Requerimientos **

 - Windows, Linux, MacOS
 - Docker o Docker Desktop
 - Terminal con los permisos respectivos

Ha sido probado en Linux, Windows y MacOS con procesador Apple Silicon.

Clonamos el repositorio

```sh
# git clone git@github.com:cags84/docker-postgres-and-mariadb.git
```

Ingresamos al directorio

```sh
# cd docker-postgres-and-mariadb
```

*** IMPORTANTE *** por defecto la configuración esta preparada para MacOS con procesador Apple Silicon, por lo cual si necesita cambiar por otro sistema operativo por ejemplo Linux, debe cambiar este segmento en el archivo docker-compose.yml

```
phpmyadmin:
    #image: arm64v8/phpmyadmin:latest # Para MacOS
    image: phpmyadmin # Para Windows o Linux
```

Ahora procedemos a crear un archivo .env y lo llenamos con los datos correspondiente.

El dato PMA_HOST, se trata del nombre que le damos al contenedor de mariadb en el archivo docker-compose.yml, que para este caso es mariadb, si lo cambia en ese archivo debe cambiarlo en el archivo env.

El parametro [POSTGRES_TZ, MARIADB_TZ, PMA_TZ], debe ser completado dependiendo de su TimeZone, en este caso America/Bogota esta en el ejemplo, porque me encuentro en Colombia.

El parametro del puerto puede ser cualquier puerto libre que tenga y que quiera usar.

```sh
# Configuracion de POSTGRES
POSTGRES_USER=USUARIO_POSTGRES
POSTGRES_PASS=PASSWORD_POSTGRES
POSTGRES_DB=BASE_DE_DATOS_POSTGRES
POSTGRES_TZ=America/Bogota
POSTGRES_PORT=5432

# Configuracion de PGADMIN4
PGADMIN_DEFAULT_EMAIL=SU_EMAIL
PGADMIN_DEFAULT_PASSWORD=_SU_PASSWORD
PGADMIN_PORT=8081

# Configuracion MariaDB
MARIADB_USER=USUARIO_MARIADB
MARIADB_PASSWORD=PASSWORD_MARIADB
MARIADB_DATABASE=BASE_DATOS_MARIADB
MARIADB_ROOT_PASSWORD=PASSWORD_ROOT_MARIADB
MARIADB_TZ=America/Bogota
MARIADB_PORT=3306

# Configuracion PhpMyAdmin
PMA_HOST=mariadb
PMA_ROOT_PASSWORD=PASSWORD_ROOT_MARIADB
PMA_TZ=America/Bogota
PMA_PORT=8082
```

Una vez creado y configurado el archivo .env, podemos levantar los contenedores con los siguientes pasos.

Ingresamos al directorio.

```sh
# cd docker-postgres-and-mariadb
```

Ejecutamos el siguiente comando.

```sh
# docker compose up -d
```

Podemos revisar si todo funciono correctamente con el siguiente comando.

```sh
# docker ps
```

Con esto ya podemos ingresar a las herramientas pgadmin4 y phpmyadmin, por ejemplo

Para PgAdmin4:

 - http://localhost:8081

Para PhpMyAdmin:

 - http://localhost:8082


Ya puedes empezar a trabajar en estas base de datos.

---

### Links

Dejamos aquí los recursos donde podemos consultar la información de las imagenes usadas en este repositorio.

[Postgres](https://hub.docker.com/_/postgres)

[MariaDB](https://hub.docker.com/_/mariadb)

[PhpMyAdmin - MacOS Apple Silicon](https://hub.docker.com/r/arm64v8/phpmyadmin)

[PhpMyAdmin](https://hub.docker.com/_/phpmyadmin)

[PgAdmin4](https://hub.docker.com/r/dpage/pgadmin4)
