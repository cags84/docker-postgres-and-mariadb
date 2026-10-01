import { spawn, type ChildProcess } from 'node:child_process';
import { serviceNames, type ServiceName, type Service, type Action, needsBackupLock } from '@cluster-sql/contracts';
export class AppError extends Error {
    constructor(message: string, public statusCode = 503) { super(message); }
}
export interface Container {
    Id: string;
    Config: {
        Image: string;
        Labels: Record<string, string>;
    };
    State: {
        Status: string;
        Health?: {
            Status: Service['health'];
            Log?: {
                Output: string;
            }[];
        };
    };
    NetworkSettings: {
        Ports: Record<string, {
            HostIp: string;
            HostPort: string;
        }[] | null>;
    };
}
const images: Record<ServiceName, string> = {
    postgres: 'postgres:17-trixie', 'postgres-vector': 'pgvector/pgvector:pg17-trixie',
    mariadb: 'mariadb:lts-ubi9', pgadmin4: 'dpage/pgadmin4:9', phpmyadmin: 'phpmyadmin:5', backup: 'cluster-sql-backup:pg17',
};
export interface DockerAccess {
    context: string;
    project: string;
    services(): Promise<Service[]>;
    action(service: ServiceName, action: Action): Promise<string>;
    backup(): Promise<string>;
    logs(service: ServiceName): Promise<ChildProcess>;
}
export class Docker implements DockerAccess {
    context = '';
    constructor(public project: string, private root: string, private composeFile: string, private envFile?: string) { }
    private run(args: string[], timeout = 30000): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn('docker', args, { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '', error = '', settled = false;
            const timer = setTimeout(() => {
                settled = true;
                child.kill('SIGTERM');
                reject(new AppError('Docker tardó demasiado en responder. Comprueba el estado antes de repetir la acción.', 504));
            }, timeout);
            child.stdout.on('data', (chunk: Buffer) => {
                output += chunk.toString();
                if (output.length > 4000000) {
                    child.kill();
                    finish(new AppError('La respuesta de Docker supera el límite.'));
                }
            });
            child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8000); });
            const finish = (err?: Error) => {
                clearTimeout(timer);
                if (settled)
                    return;
                settled = true;
                if (err)
                    reject(err);
                else
                    resolve(output + (args.includes('run') ? error : ''));
            };
            child.on('error', () => finish(new AppError('No se puede ejecutar Docker. Comprueba su instalación.')));
            child.on('close', (code) => finish(code === 0 ? undefined : new AppError(error.trim() || `Docker terminó con código ${code}.`, code === 75 ? 409 : 503)));
        });
    }
    private async base(): Promise<string[]> {
        // Se fija al primer uso y no cambia mientras la API esté activa.
        if (!this.context)
            this.context = (await this.run(['context', 'show'])).trim();
        return ['--context', this.context];
    }
    private async compose(): Promise<string[]> {
        return [...await this.base(), 'compose', '-p', this.project, '-f', this.composeFile,
            ...(this.envFile ? ['--env-file', this.envFile] : []), '--profile', 'backup'];
    }
    private async containers(): Promise<Container[]> {
        const args = await this.base();
        const ids = (await this.run([...args, 'ps', '-aq', '--filter', `label=com.docker.compose.project=${this.project}`])).trim().split(/\s+/).filter(Boolean);
        if (!ids.length)
            return [];
        const inspected: Container[] = JSON.parse(await this.run([...args, 'inspect', ...ids]));
        return inspected.filter(c => c.Config.Labels['com.docker.compose.project'] === this.project &&
            c.Config.Labels['com.docker.compose.oneoff'] !== 'True' &&
            serviceNames.includes(c.Config.Labels['com.docker.compose.service'] as ServiceName));
    }
    private async container(service: ServiceName): Promise<Container> {
        const found = (await this.containers()).find(c => c.Config.Labels['com.docker.compose.service'] === service);
        if (!found)
            throw new AppError('El servicio todavía no tiene contenedor.', 404);
        return found;
    }
    async services(): Promise<Service[]> {
        const containers = await this.containers();
        const result = serviceNames.map(name => {
            const c = containers.find(c => c.Config.Labels['com.docker.compose.service'] === name);
            const published = c ? Object.values(c.NetworkSettings.Ports).flatMap(p => p ?? []) : [];
            const web = c?.NetworkSettings.Ports['80/tcp']?.[0];
            return {
                name, image: c?.Config.Image ?? images[name], state: c?.State.Status ?? 'missing',
                health: c?.State.Health?.Status ?? 'none',
                healthOutput: c?.State.Health?.Log?.at(-1)?.Output.slice(-2000) ?? null,
                ports: published.map(p => `${p.HostIp}:${p.HostPort}`),
                toolUrl: c?.State.Status === 'running' && web ? `http://127.0.0.1:${web.HostPort}` : null,
            } satisfies Service;
        });
        const pg = result.find(s => s.name === 'pgadmin4')!.toolUrl;
        const maria = result.find(s => s.name === 'phpmyadmin')!.toolUrl;
        for (const service of result) {
            if (service.name === 'postgres' || service.name === 'postgres-vector')
                service.toolUrl = pg;
            if (service.name === 'mariadb')
                service.toolUrl = maria;
        }
        return result;
    }
    private async withBackupLock(work: () => Promise<string>): Promise<string> {
        // Un contenedor pequeño mantiene flock mientras la CLI del host actúa.
        // Funciona en macOS/Windows sin instalar flock en el host.
        const script = 'exec 9>/backups/.backup.lock; flock -n -E 75 9 || exit 75; printf "__cluster_sql_guard_ready__\\n"; cat >/dev/null';
        const child = spawn('docker', [...await this.compose(), 'run', '--rm', '--no-deps', '-T',
            '--entrypoint', 'sh', 'backup', '-c', script], {cwd: this.root, stdio: ['pipe', 'pipe', 'pipe']});
        let ended = false;
        let stderr = '';
        child.stdin.on('error', () => { /* El contenedor puede rechazar el bloqueo antes de leer stdin. */ });
        const closed = new Promise<void>(resolve => child.once('close', () => {ended = true; resolve();}));
        child.stderr.on('data', (data: Buffer) => {stderr = (stderr + data.toString()).slice(-8000);});
        try {
            await new Promise<void>((resolve, reject) => {
                let output = '';
                const timer = setTimeout(() => reject(new AppError('No se pudo preparar el bloqueo de backup a tiempo.', 504)), 300000);
                const finish = (error?: Error) => {clearTimeout(timer); if (error) reject(error); else resolve();};
                child.stdout.on('data', (data: Buffer) => {
                    output = (output + data.toString()).slice(-1000);
                    if (output.includes('__cluster_sql_guard_ready__')) finish();
                });
                child.once('error', () => finish(new AppError('No se puede ejecutar Docker.')));
                child.once('close', code => finish(new AppError(code === 75
                    ? 'Hay un backup u otra acción protegida en curso. Espera a que termine.'
                    : stderr.trim() || 'No se pudo adquirir el bloqueo de backup.', code === 75 ? 409 : 503)));
            });
            const result = await work();
            if (ended) throw new AppError('Se perdió el bloqueo durante la acción. Comprueba el estado de Docker.');
            return result;
        } finally {
            child.stdin.end();
            // Antes de READY puede estar construyendo la imagen; se cancela si no lee stdin.
            const timeout = setTimeout(() => child.kill('SIGTERM'), 10000);
            await closed;
            clearTimeout(timeout);
        }
    }
    async action(service: ServiceName, action: Action): Promise<string> {
        const work = async () => {
            if (action === 'start') return this.run([...await this.compose(), 'up', '-d', service], 300000);
            const container = await this.container(service);
            return this.run([...await this.base(), action, container.Id], 60000);
        };
        return needsBackupLock(service, action) ? this.withBackupLock(work) : work();
    }
    async backup(): Promise<string> {
        const services = await this.services();
        if (services.filter(s => ['postgres', 'postgres-vector', 'mariadb'].includes(s.name))
            .some(s => s.state !== 'running' || s.health !== 'healthy')) {
            throw new AppError('Las tres bases deben estar saludables para generar un backup.', 409);
        }
        return this.run([...await this.compose(), 'run', '--rm', '--no-deps', '-T', 'backup', '--once'], 1800000);
    }
    async logs(service: ServiceName): Promise<ChildProcess> {
        const container = await this.container(service);
        return spawn('docker', [...await this.base(), 'logs', '--follow', '--tail', '200', '--timestamps', container.Id], { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'] });
    }
}
