import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Docker } from './docker.js';
import { buildServer } from './server.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.DASHBOARD_PORT ?? 3000);
const docker = new Docker(process.env.DASHBOARD_PROJECT ?? 'cluster-sql', root, resolve(root, process.env.DASHBOARD_COMPOSE_FILE ?? 'docker-compose.yml'), process.env.DASHBOARD_ENV_FILE ? resolve(root, process.env.DASHBOARD_ENV_FILE) : undefined);
const app = buildServer(docker, { backupsDir: resolve(root, process.env.DASHBOARD_BACKUPS_DIR ?? 'backups'),
    webDir: resolve(root, 'apps/web/dist'), port });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => { void app.close().then(() => process.exit(0)); });
try {
    await app.listen({ port, host: '127.0.0.1' });
    console.log(`Dashboard: http://127.0.0.1:${port}`);
}
catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
