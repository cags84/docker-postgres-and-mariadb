# Guía del proyecto para agentes y LLMs

## Ubicación y alcance

Este archivo está en la raíz de `docker-postgres-and-mariadb`, cuyo proyecto Compose y workspace se llaman `cluster-sql`. Localiza la raíz con `git rev-parse --show-toplevel`; todos los comandos y rutas de esta guía parten de allí. No dependas de una ruta absoluta de la máquina de un desarrollador.

Lee primero `README.md` para conocer el uso y alcance actual. Es un monorepo funcional para desarrollo local: dashboard en el host, tres bases de datos, dos herramientas web de gestión y backups opcionales. No hay autenticación, dashboard remoto, métricas CPU/RAM, restauración desde la UI ni base de datos propia para el dashboard. No presentes esas funciones como implementadas.

## Dónde buscar y modificar

| Ruta | Responsabilidad |
| --- | --- |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.nvmrc` | Workspace, comandos y versiones |
| `docker-compose.yml`, `.env.example` | Servicios, dependencias, puertos, volúmenes y configuración |
| `apps/api/src/main.ts` | Arranque, raíz del repo, variables `DASHBOARD_*` y escucha local |
| `apps/api/src/server.ts` | Rutas HTTP, validación de origen, operaciones y logs SSE |
| `apps/api/src/docker.ts` | CLI Docker, contexto, selección de contenedores, acciones y bloqueo de backups |
| `apps/api/src/backups.ts` | Lectura segura de dumps y estado persistente del backup automático |
| `apps/web/src/App.tsx`, `apps/web/src/style.css` | Interfaz y estilos |
| `apps/web/vite.config.ts` | Proxy de desarrollo a la API |
| `packages/contracts/src/index.ts` | Tipos, esquemas Zod, servicios permitidos y recursos afectados por acciones |
| `backup.sh`, `docker/backup/Dockerfile` | Ciclos, retención, metadatos e imagen con clientes SQL y flock |
| `docs/assets/` | Recursos visuales locales del README |
| `apps/api/test/server.test.ts` | Pruebas de API |
| `apps/web/src/App.test.tsx` | Pruebas de componentes |
| `tests/backup_test.py` | Pruebas del script con comandos simulados |
| `tests/runtime_test.py` | Integración Docker aislada y restauración real |

El código y los manifests son la fuente de verdad. Mantén esta guía como mapa; documenta instrucciones de uso en `README.md`, sin duplicar esquemas completos ni un historial de cambios.

## Entorno y comandos

Usa Node 24 y pnpm 12.8.1, según los manifests. Python 3 se necesita para las pruebas de backups. Docker y Compose v2 se necesitan para la integración y para operar servicios.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# Requiere build previo, Docker activo y puerto 3010 libre:
python3 tests/runtime_test.py
```

`pnpm dev` inicia API en `127.0.0.1:3000` y Vite en `127.0.0.1:5173`. `pnpm build && pnpm start` sirve la web compilada desde la API en 3000. Los scripts raíz compilan primero los contratos; si los editas durante una sesión de desarrollo, vuelve a compilarlos con `pnpm --filter @cluster-sql/contracts build` y reinicia los procesos que los consumen.

Las variables `DASHBOARD_*` pertenecen al entorno del proceso Node. `.env` configura Compose; Node no lo carga automáticamente. Las rutas relativas del dashboard se resuelven desde la raíz, tanto desde `src` como desde `dist`.

## Reglas de implementación

- Prioriza funcionalidad y cambios sencillos. Usa la estructura existente; no añadas otro orquestador de monorepo, almacenamiento o servicios sin necesidad de la tarea.
- Cambia contratos, API y UI de forma coherente. La lista permitida es `postgres`, `postgres-vector`, `mariadb`, `pgadmin4`, `phpmyadmin`, `backup`. Si cambias dependencias Compose, revisa también `operationResources` y `needsBackupLock`.
- Conserva el filtro por etiqueta de proyecto y la exclusión de contenedores one-off. El contexto Docker queda fijado al primer uso; no hagas acciones sobre todos los contenedores del host.
- Ejecuta Docker con argumentos separados y sin shell del host. Mantén la validación local de Host/Origin y la escucha en `127.0.0.1`. No devuelvas inspecciones completas, configuración con secretos ni credenciales en enlaces.
- Conserva las reservas de servicios y dependencias en la API, así como el bloqueo `flock` compartido con los backups. Las acciones protegidas usan un contenedor temporal para no exigir flock en macOS/Windows. No sustituyas esa coordinación por un bloqueo únicamente en memoria.
- Mantén los dumps parciales separados de los publicables y rota únicamente tras éxito de las tres bases. Los estados automático y manual son archivos distintos; un manual no debe sobrescribir el automático.
- Mantén las protecciones de descarga y lectura de metadatos contra traversal y enlaces simbólicos, los límites de salida y la limpieza de procesos de logs al desconectar.
- No apliques `no-new-privileges` globalmente: el entrypoint actual de pgAdmin requiere sudo. La excepción está documentada junto al servicio.

## Datos y verificación

`.env`, `backups/`, dumps, `node_modules/` y `dist/` no se versionan. No imprimas secretos al revisar configuración ni incluyas valores reales en documentación o commits. Usa `.env.example` para validaciones sin secretos:

```sh
docker compose --env-file .env.example --profile backup config --quiet
sh -n backup.sh
git diff --check
```

No elimines volúmenes del stack del usuario para diagnosticar errores. La integración real crea su propio proyecto, volúmenes y directorio temporal, y limpia solo esos recursos. Puede construir la imagen local de backup. Cambiar `.env` no cambia usuarios ni bases en volúmenes existentes.

Ejecuta verificaciones acordes al cambio: lint/tipos/pruebas/compilación para código; pruebas del script para backups; integración real para comportamiento Docker o restauración. Para cambios exclusivamente documentales, contrasta comandos y rutas con la implementación y revisa el diff. No declares como ejecutadas pruebas que no corriste ni como comprobados entornos que no verificaste.

Actualiza `README.md` cuando cambien comandos, configuración o comportamiento. Actualiza esta guía cuando cambien estructura o límites del proyecto. Revisa `git status` antes de hacer commits y conserva cambios ajenos a la tarea.
