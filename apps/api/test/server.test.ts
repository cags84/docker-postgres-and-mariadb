import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { serviceNames, type Service } from '@cluster-sql/contracts';
import { buildServer } from '../src/server.js';
import { AppError, type DockerAccess } from '../src/docker.js';
const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
const services: Service[] = serviceNames.map(name => ({ name, image: 'test', state: 'missing', health: 'none', healthOutput: null, ports: [], toolUrl: null }));
function fake(overrides: Partial<DockerAccess> = {}): DockerAccess {
    return { context: 'test', project: 'cluster-sql', services: async () => services, action: async () => 'OK', backup: async () => 'OK',
        logs: async () => { throw new AppError('Sin contenedor.', 404); }, ...overrides };
}
async function fixture(docker = fake()) {
    const directory = await mkdtemp(join(tmpdir(), 'dashboard-api-'));
    const app = buildServer(docker, { backupsDir: directory });
    return { directory, app, cleanup: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('lista seis servicios ausentes, sin credenciales ni configuración interna', async () => {
    const f = await fixture();
    try {
        const result = await f.app.inject({ url: '/api/services', headers });
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().services.length, 6);
        assert.ok(result.json().services.every((s: Service) => s.state === 'missing'));
        assert.ok(!result.body.includes('PASSWORD'));
    }
    finally {
        await f.cleanup();
    }
});
test('rechaza servicios y acciones arbitrarias, hosts externos y CSRF', async () => {
    const f = await fixture();
    try {
        for (const service of ['foreign', 'postgres;echo hello']) {
            assert.equal((await f.app.inject({ method: 'POST', url: `/api/services/${encodeURIComponent(service)}/actions`, headers, payload: { action: 'start' } })).statusCode, 400);
        }
        assert.equal((await f.app.inject({ method: 'POST', url: '/api/services/postgres/actions', headers, payload: { action: 'remove' } })).statusCode, 400);
        assert.equal((await f.app.inject({ url: '/api/services', headers: { host: 'external.test:3000' } })).statusCode, 403);
        assert.equal((await f.app.inject({ method: 'POST', url: '/api/backups', headers: { ...headers, origin: 'https://evil.test' }, payload: {} })).statusCode, 403);
        assert.equal((await f.app.inject({ method: 'POST', url: '/api/backups', headers: { host: headers.host, 'content-type': 'application/json' }, payload: {} })).statusCode, 403);
        assert.equal((await f.app.inject({ method: 'POST', url: '/api/backups', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 403);
    }
    finally {
        await f.cleanup();
    }
});
test('serializa acciones e informa progreso y errores', async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>(done => { resolve = done; });
    const f = await fixture(fake({ action: () => pending, backup: async () => { throw new Error('Fallo de dump'); } }));
    try {
        const request = { method: 'POST' as const, url: '/api/services/postgres/actions', headers, payload: { action: 'start' } };
        const first = await f.app.inject(request);
        assert.equal(first.statusCode, 202);
        assert.equal(first.json().status, 'running');
        assert.equal((await f.app.inject(request)).statusCode, 409);
        assert.equal((await f.app.inject({ method: 'POST', url: '/api/backups', headers, payload: {} })).statusCode, 409);
        resolve('Completado');
        await new Promise(done => setImmediate(done));
        const jobs = (await f.app.inject({ url: '/api/operations', headers })).json();
        assert.equal(jobs[0].status, 'succeeded');
        assert.equal(jobs[0].output, 'Completado');
        await f.app.inject({ method: 'POST', url: '/api/backups', headers, payload: {} });
        await new Promise(done => setImmediate(done));
        assert.equal((await f.app.inject({ url: '/api/operations', headers })).json()[0].status, 'failed');
    }
    finally {
        resolve('OK');
        await f.cleanup();
    }
});
test('Docker inaccesible y logs de contenedor ausente dan errores útiles', async () => {
    const f = await fixture(fake({ services: async () => { throw new AppError('Docker no disponible'); } }));
    try {
        const result = await f.app.inject({ url: '/api/services', headers });
        assert.equal(result.statusCode, 503);
        assert.equal(result.json().error, 'Docker no disponible');
        assert.equal((await f.app.inject({ url: '/api/services/postgres/logs', headers })).statusCode, 404);
    }
    finally {
        await f.cleanup();
    }
});
test('lista y descarga solo archivos terminados; rechaza enlaces y traversal', async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.directory, 'postgres_main_2026-10-01_12-00-00.sql.gz'), 'compressed');
        await writeFile(join(f.directory, 'incomplete.sql.gz.part'), 'partial');
        await symlink(join(f.directory, 'incomplete.sql.gz.part'), join(f.directory, 'link.sql.gz'));
        const result = (await f.app.inject({ url: '/api/backups', headers })).json();
        assert.equal(result.length, 1);
        assert.equal(result[0].database, 'main');
        const download = await f.app.inject({ url: `/api/backups/${result[0].name}/download`, headers });
        assert.equal(download.statusCode, 200);
        assert.equal(download.body, 'compressed');
        assert.match(download.headers['content-disposition'] as string, /attachment/);
        assert.equal((await f.app.inject({ url: '/api/backups/link.sql.gz/download', headers })).statusCode, 404);
        assert.equal((await f.app.inject({ url: '/api/backups/..%2Foutside.sql.gz/download', headers })).statusCode, 400);
    }
    finally {
        await f.cleanup();
    }
});
test('SSE transmite líneas y termina el proceso al desconectar', async () => {
    let child: ChildProcess | undefined;
    const f = await fixture(fake({ logs: async () => {
            child = spawn(process.execPath, ['-e', 'console.log("linea de prueba"); setInterval(() => {}, 1000)']);
            return child;
        } }));
    // El servidor valida hosts; se usa un puerto explícito en esta prueba.
    await f.app.close();
    const app = buildServer(fake({ logs: async () => {
            child = spawn(process.execPath, ['-e', 'console.log("linea de prueba"); setInterval(() => {}, 1000)']);
            return child;
        } }), { backupsDir: f.directory, port: 3009 });
    try {
        await app.listen({ port: 3009, host: '127.0.0.1' });
        const controller = new AbortController();
        const response = await fetch('http://127.0.0.1:3009/api/services/postgres/logs', { signal: controller.signal });
        const reader = response.body!.getReader();
        const data = await reader.read();
        assert.match(new TextDecoder().decode(data.value), /linea de prueba/);
        const exit = new Promise(done => child!.once('exit', done));
        controller.abort();
        await exit;
        assert.equal(child!.signalCode, 'SIGTERM');
    }
    finally {
        child?.kill();
        await app.close();
        await f.cleanup();
    }
});
