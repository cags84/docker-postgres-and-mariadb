import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { serviceSchema, actionSchema, type Operation } from '@cluster-sql/contracts';
import { AppError, type DockerAccess } from './docker.js';
import { BackupFiles } from './backups.js';
export interface Settings {
    backupsDir: string;
    webDir?: string;
    port?: number;
}
export function buildServer(docker: DockerAccess, settings: Settings) {
    const app = Fastify({ bodyLimit: 1024, logger: false });
    const operations = new Map<string, Operation>();
    const busy = new Set<string>();
    const streams = new Set<() => void>();
    const hosts = new Set(['localhost', '127.0.0.1'].flatMap(h => [`${h}:${settings.port ?? 3000}`, `${h}:5173`]));
    const origins = new Set([...hosts].map(h => `http://${h}`));
    const backups = new BackupFiles(settings.backupsDir);
    app.addHook('onRequest', async (request) => {
        if (!hosts.has(request.headers.host ?? '') ||
            (request.headers.origin && !origins.has(request.headers.origin)))
            throw new AppError('Origen no permitido.', 403);
        if (request.method === 'POST' && (!request.headers.origin || request.headers['content-type']?.split(';')[0] !== 'application/json'))
            throw new AppError('Las acciones requieren origen local y JSON.', 403);
    });
    app.setErrorHandler((error, _request, reply) => {
        const err = error as Error & {
            statusCode?: number;
        };
        reply.code(err.statusCode ?? 500).send({ error: err.message || 'Error interno.' });
    });
    const service = (value: unknown) => {
        const parsed = serviceSchema.safeParse(value);
        if (!parsed.success)
            throw new AppError('Servicio no permitido.', 400);
        return parsed.data;
    };
    function launch(target: Operation['target'], action: Operation['action'], work: () => Promise<string>) {
        if (busy.has(target))
            throw new AppError('Ya existe una operación en curso para este destino.', 409);
        busy.add(target);
        // Solo se eliminan operaciones finalizadas; nunca se pierde una activa.
        if (operations.size >= 100) {
            const oldest = [...operations.values()].find(o => o.status !== 'running');
            if (oldest)
                operations.delete(oldest.id);
        }
        const operation: Operation = { id: randomUUID(), target, action, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, output: '' };
        operations.set(operation.id, operation);
        void Promise.resolve().then(work).then(output => {
            operation.status = 'succeeded';
            operation.output = output.slice(-16000);
        }).catch(error => {
            operation.status = 'failed';
            operation.output = error instanceof Error ? error.message : 'La operación falló.';
        }).finally(() => { operation.finishedAt = new Date().toISOString(); busy.delete(target); });
        return operation;
    }
    app.get('/api/services', async () => {
        const services = await docker.services();
        return { context: docker.context, project: docker.project, services, updatedAt: new Date().toISOString() };
    });
    app.get('/api/operations', async () => [...operations.values()].reverse());
    app.post<{
        Params: {
            service: string;
        };
    }>('/api/services/:service/actions', async (request, reply) => {
        const name = service(request.params.service);
        const parsed = actionSchema.safeParse(request.body);
        if (!parsed.success)
            throw new AppError('Acción inválida.', 400);
        if (busy.has('backups') && ['postgres', 'postgres-vector', 'mariadb', 'backup'].includes(name))
            throw new AppError('Espera a que termine el backup manual.', 409);
        return reply.code(202).send(launch(name, parsed.data.action, () => docker.action(name, parsed.data.action)));
    });
    app.get('/api/backups', async () => backups.list());
    app.post('/api/backups', async (_request, reply) => {
        if (['postgres', 'postgres-vector', 'mariadb', 'backup'].some(name => busy.has(name)))
            throw new AppError('Espera a que terminen las operaciones sobre las bases.', 409);
        return reply.code(202).send(launch('backups', 'backup', () => docker.backup()));
    });
    app.get<{
        Params: {
            name: string;
        };
    }>('/api/backups/:name/download', async (request, reply) => {
        const file = await backups.download(request.params.name);
        reply.raw.once('close', () => { file.stream.destroy(); });
        reply.header('Content-Type', 'application/gzip').header('Content-Length', file.size)
            .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(request.params.name)}`);
        return reply.send(file.stream);
    });
    app.get<{
        Params: {
            service: string;
        };
    }>('/api/services/:service/logs', async (request, reply) => {
        const child = await docker.logs(service(request.params.service));
        reply.hijack();
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = (event: string, text: string) => { if (!reply.raw.destroyed)
            reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(text)}\n\n`); };
        let pending = '';
        const receive = (chunk: Buffer) => {
            pending += chunk.toString();
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines)
                send('line', line);
            if (pending.length > 32000) {
                send('line', pending);
                pending = '';
            }
            // Se evita acumular salida si el navegador no puede consumirla.
            if (reply.raw.writableLength > 1000000)
                cleanup();
        };
        const heartbeat = setInterval(() => { if (!reply.raw.destroyed)
            reply.raw.write(': heartbeat\n\n'); }, 15000);
        const cleanup = () => { clearInterval(heartbeat); child.kill('SIGTERM'); reply.raw.end(); streams.delete(cleanup); };
        streams.add(cleanup);
        child.stdout?.on('data', receive);
        child.stderr?.on('data', receive);
        child.on('error', () => { send('end', 'No se pueden seguir los logs.'); cleanup(); });
        child.on('close', () => { if (pending)
            send('line', pending); send('end', 'El seguimiento terminó.'); cleanup(); });
        reply.raw.on('close', cleanup);
    });
    if (settings.webDir && existsSync(settings.webDir)) {
        app.register(fastifyStatic, { root: settings.webDir });
        app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Ruta no encontrada.' }) : reply.sendFile('index.html'));
    }
    app.addHook('onClose', async () => { for (const close of streams)
        close(); });
    return app;
}
