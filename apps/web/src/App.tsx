import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Archive, ArrowDownToLine, ArrowUpRight, Box, CircleCheck, Database, FileText, LayoutDashboard, LoaderCircle, Pause, Play, RefreshCw, RotateCcw, Square, Terminal, Trash2 } from 'lucide-react';
import { operationResources, type Backup, type BackupStatus, type Operation, type Overview, type Service, type ServiceName, type Action } from '@cluster-sql/contracts';
const names: Record<ServiceName, string> = { postgres: 'PostgreSQL', 'postgres-vector': 'PostgreSQL Vector', mariadb: 'MariaDB', pgadmin4: 'pgAdmin 4', phpmyadmin: 'phpMyAdmin', backup: 'Backups automáticos' };
const stateNames: Record<string, string> = { missing: 'Sin crear', running: 'En ejecución', exited: 'Detenido', created: 'Creado', restarting: 'Reiniciando', paused: 'Pausado', dead: 'Error' };
const healthNames = { healthy: 'Saludable', unhealthy: 'No saludable', starting: 'Iniciando', none: 'Sin healthcheck' };
const actionNames = { start: 'Iniciar', stop: 'Detener', restart: 'Reiniciar', backup: 'Generar backup' };
const time = (value: string) => new Date(value).toLocaleString('es-CO');
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error ?? 'No se pudo completar la solicitud.');
    return data as T;
}
function Logs({ service }: {
    service: ServiceName;
}) {
    const [lines, setLines] = useState<string[]>([]);
    const [paused, setPaused] = useState(false);
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(false);
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => { setLines([]); setPaused(false); }, [service]);
    useEffect(() => {
        if (paused) {
            setConnected(false);
            return;
        }
        setError('');
        const stream = new EventSource(`/api/services/${service}/logs`);
        stream.onopen = () => setConnected(true);
        stream.addEventListener('line', (event: MessageEvent) => { setLines(lines => [...lines, JSON.parse(event.data) as string].slice(-5000)); });
        stream.addEventListener('end', (event: MessageEvent) => { setError(JSON.parse(event.data) as string); setConnected(false); stream.close(); });
        stream.onerror = () => { setError('El seguimiento se desconectó. Comprueba Docker y pausa/reanuda para reconectar.'); setConnected(false); stream.close(); };
        return () => { stream.close(); setConnected(false); };
    }, [service, paused]);
    useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [lines]);
    return <section className="logs-panel">
    <div className="panel-heading"><div><Terminal size={18}/><strong>{names[service]}</strong><span className={`live ${connected ? 'connected' : ''}`}>{connected ? 'EN VIVO' : paused ? 'PAUSADO' : 'DESCONECTADO'}</span></div><div>
      <button onClick={() => setPaused(!paused)}>{paused ? <Play size={15}/> : <Pause size={15}/>} {paused ? 'Reanudar' : 'Pausar'}</button>
      <button onClick={() => setLines([])}><Trash2 size={15}/> Limpiar</button></div></div>
    {error && <p className="log-notice" role="status">{error}</p>}
    <div className="log-output" aria-label="Salida de logs"><pre>{lines.length ? lines.join('\n') : 'Esperando salida del contenedor…'}</pre><div ref={end}/></div>
    <div className="log-footer">Últimas 200 líneas al conectar · Máximo 5.000 líneas en pantalla <span>{lines.length} líneas</span></div>
  </section>;
}
export function App() {
    const [view, setView] = useState<'overview' | 'logs' | 'backups'>('overview');
    const [overview, setOverview] = useState<Overview | null>(null);
    const [backups, setBackups] = useState<Backup[]>([]);
    const [backupStatus, setBackupStatus] = useState<BackupStatus>({automatic: null, error: null});
    const [operations, setOperations] = useState<Operation[]>([]);
    const [error, setError] = useState('');
    const [actionError, setActionError] = useState('');
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<ServiceName>('postgres');
    const [submitting, setSubmitting] = useState<string | null>(null);
    const refresh = useCallback(async () => {
        try {
            const [next, files, jobs, status] = await Promise.all([api<Overview>('services'), api<Backup[]>('backups'), api<Operation[]>('operations'), api<BackupStatus>('backups/status')]);
            setOverview(next);
            setBackups(files);
            setBackupStatus(status);
            setOperations(jobs);
            setError('');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'No se puede conectar con la API.');
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh]);
    const active = operations.filter(o => o.status === 'running');
    const busy = (target: ServiceName | 'backups', action: Action | 'backup') => {
        const resources = operationResources(target, action);
        const pending = submitting ? operationResources(submitting as ServiceName | 'backups', submitting === 'backups' ? 'backup' : 'start') : [];
        const automatic = backupStatus.automatic?.status === 'running' ? operationResources('backups', 'backup') : [];
        return resources.some(name => pending.includes(name) || automatic.includes(name) ||
            active.some(o => operationResources(o.target, o.action).includes(name)));
    };
    const act = async (target: ServiceName | 'backups', action: Action | 'backup') => {
        if ((action === 'stop' || action === 'restart') && !window.confirm(`${actionNames[action]} ${names[target as ServiceName]}? Las conexiones activas pueden interrumpirse.`))
            return;
        setSubmitting(target);
        setActionError('');
        try {
            const job = await api<Operation>(target === 'backups' ? 'backups' : `services/${target}/actions`, target === 'backups' ? {} : { action });
            setOperations(previous => [job, ...previous.filter(o => o.id !== job.id)]);
            void refresh();
        }
        catch (err) {
            setActionError(err instanceof Error ? err.message : 'La acción falló.');
        }
        finally {
            setSubmitting(null);
        }
    };
    const services = overview?.services ?? [];
    const healthy = services.filter(s => s.state === 'running' && s.health === 'healthy').length;
    const running = services.filter(s => s.state === 'running').length;
    const latest = backups[0];
    const showLogs = (name: ServiceName) => { setSelected(name); setView('logs'); };
    const headings = { overview: ['Vista general', 'Tus bases de datos, en un solo lugar.'], logs: ['Logs de contenedores', 'Sigue la actividad y encuentra la causa de los errores.'], backups: ['Backups', 'Consulta, descarga y genera copias de tus bases de datos.'] };
    return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="cluster-sql inicio"><span className="brand-icon"><Database size={23}/></span><span>cluster<span className="brand-light">-sql</span><small>CONTROL DE DESARROLLO</small></span></a>
      <div className="nav-label">WORKSPACE</div><nav aria-label="Navegación principal">
        <button className={view === 'overview' ? 'selected' : ''} onClick={() => setView('overview')}><LayoutDashboard size={18}/> Vista general</button>
        <button className={view === 'logs' ? 'selected' : ''} onClick={() => setView('logs')}><Terminal size={18}/> Logs</button>
        <button className={view === 'backups' ? 'selected' : ''} onClick={() => setView('backups')}><Archive size={18}/> Backups <span className="nav-count">{backups.length}</span></button>
      </nav><div className="sidebar-bottom"><span className="local-dot"/> Entorno local<small>{overview?.context || 'Docker'} · {overview?.project || 'cluster-sql'}</small></div>
    </aside>
    <div className="workspace"><header className="topbar"><span><Box size={16}/> cluster-sql <span className="slash">/</span> {view === 'overview' ? 'Dashboard' : view === 'logs' ? 'Logs' : 'Backups'}</span><span className="local-badge">LOCAL</span></header>
      <main><div className="page-heading"><div><span className="eyebrow">TU STACK SQL</span><h1>{headings[view][0]}</h1><p>{headings[view][1]}</p></div><button className="button" onClick={() => { void refresh(); }}><RefreshCw size={16}/> Actualizar</button></div>
        {error && <div className="notice error" role="alert"><strong>Información desactualizada</strong><span>{error}</span></div>}
        {actionError && <div className="notice error" role="alert">{actionError}</div>}
        {loading && <p className="loading"><LoaderCircle className="spin" size={18}/> Conectando con Docker…</p>}
        {view !== 'logs' && <AutomaticBackup status={backupStatus}/>}
        {view === 'overview' && <>
          <div className="metrics"><article><span className="metric-label">CONTENEDORES <Box size={17}/></span><div className="metric-value">{running}<small>/ 6</small></div><p>En ejecución</p></article>
            <article><span className="metric-label">SALUD <Activity size={17}/></span><div className="metric-value">{healthy}<span className="metric-status">saludables</span></div><p>Servicios con healthcheck</p></article>
            <article><span className="metric-label">BACKUPS <Archive size={17}/></span><div className="metric-value">{backups.length}<small>archivos</small></div><p>{latest ? `Último: ${time(latest.modifiedAt)}` : 'Aún no hay copias guardadas'}</p></article>
          </div>
          <section className="panel"><div className="panel-title"><div><h2>Servicios del stack</h2><p>Estado actual de las bases y sus herramientas</p></div><span className="subtle">{services.length} servicios</span></div>
            <div className="table-scroll"><table><thead><tr><th>SERVICIO</th><th>ESTADO</th><th>SALUD</th><th>PUERTOS</th><th className="right">ACCIONES</th></tr></thead><tbody>{services.map(s => <ServiceRow key={s.name} service={s} blocked={action => !!error || busy(s.name, action)} act={act} logs={showLogs}/>)}</tbody></table></div>
            {!loading && !services.length && <p className="empty">No se pudo obtener el estado de los servicios.</p>}
            <div className="panel-footer"><span className={`status-dot ${error ? 'bad' : ''}`}/>{overview ? `Última lectura: ${time(overview.updatedAt)}` : 'Sin datos'}<span className="push">Actualización cada 5 segundos</span></div>
          </section>
          <div className="backup-callout"><div className="callout-icon"><Archive size={22}/></div><div><h3>Una copia antes del siguiente cambio</h3><p>Respalda las tres bases sin reiniciar el servicio de backups.</p></div><button className="button primary" disabled={!!error || busy('backups', 'backup')} onClick={() => { void act('backups', 'backup'); }}>{busy('backups', 'backup') ? <LoaderCircle className="spin" size={16}/> : <Archive size={16}/>} Generar backup</button></div>
        </>}
        {view === 'logs' && <><div className="log-selector"><label htmlFor="service">Contenedor</label><select id="service" value={selected} onChange={e => setSelected(e.target.value as ServiceName)}>{Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><span className="subtle">{stateNames[services.find(s => s.name === selected)?.state ?? 'missing']}</span></div><Logs service={selected}/></>}
        {view === 'backups' && <section className="panel"><div className="panel-title"><div><h2>Copias guardadas</h2><p>Archivos SQL comprimidos de las tres bases</p></div><button className="button primary" disabled={!!error || busy('backups', 'backup')} onClick={() => { void act('backups', 'backup'); }}><Archive size={16}/> Generar backup</button></div>
          {!backups.length ? <div className="empty-backups"><Archive size={36}/><h3>Todavía no hay backups</h3><p>Inicia las tres bases y genera tu primera copia.</p></div> : <div className="table-scroll"><table><thead><tr><th>ARCHIVO</th><th>BASE</th><th>TAMAÑO</th><th>FECHA</th><th /></tr></thead><tbody>{backups.map(b => <tr key={b.name}><td><span className="file-name"><FileText size={17}/>{b.name}</span></td><td>{b.database}</td><td>{bytes(b.size)}</td><td>{time(b.modifiedAt)}</td><td><a className="download" href={`/api/backups/${encodeURIComponent(b.name)}/download`} download><ArrowDownToLine size={16}/> Descargar</a></td></tr>)}</tbody></table></div>}</section>}
        {!!operations.length && <section className="operations"><h2>Actividad reciente</h2>{operations.slice(0, 5).map(o => <div key={o.id} className={`operation ${o.status}`}><span>{o.status === 'running' ? <LoaderCircle className="spin" size={18}/> : o.status === 'succeeded' ? <CircleCheck size={18}/> : <Activity size={18}/>}</span><div><strong>{actionNames[o.action]} · {o.target === 'backups' ? 'Las tres bases' : names[o.target]}</strong><small>{time(o.startedAt)} · {o.status === 'running' ? 'En curso' : o.status === 'succeeded' ? 'Completado' : 'Falló'}</small>{o.output && <details><summary>Ver resultado</summary><pre>{o.output}</pre></details>}</div></div>)}</section>}
        <footer className="page-footer">cluster-sql <span>Herramientas para tu entorno de desarrollo</span></footer>
      </main>
    </div>
  </div>;
}
function ServiceRow({ service: s, blocked, act, logs }: {
    service: Service;
    blocked: (action: Action) => boolean;
    act: (target: ServiceName, action: Action) => Promise<void>;
    logs: (service: ServiceName) => void;
}) {
    const isRunning = s.state === 'running';
    return <tr><td><div className="service-cell"><span className={`service-icon ${s.name === 'mariadb' || s.name === 'phpmyadmin' ? 'teal' : ''}`}>{['pgadmin4', 'phpmyadmin'].includes(s.name) ? <LayoutDashboard size={19}/> : s.name === 'backup' ? <Archive size={19}/> : <Database size={19}/>}</span><span><strong>{names[s.name]}</strong><small>{s.image}</small></span></div></td>
    <td><span className={`state-pill ${isRunning ? 'running' : ''}`}><span />{stateNames[s.state] ?? s.state}</span></td>
    <td><span className={`health ${s.health}`} title={s.healthOutput ?? ''}>{s.health === 'healthy' && <CircleCheck size={14}/>} {healthNames[s.health]}</span>{s.healthOutput && s.health !== 'healthy' && <details className="health-detail"><summary>Detalle</summary><pre>{s.healthOutput}</pre></details>}</td>
    <td className="ports">{s.ports.join(', ') || '—'}</td>
    <td><div className="row-actions"><button title="Ver logs" aria-label={`Logs de ${names[s.name]}`} disabled={s.state === 'missing'} onClick={() => logs(s.name)}><Terminal size={16}/></button>
      <button title={isRunning ? 'Detener' : 'Iniciar'} aria-label={`${isRunning ? 'Detener' : 'Iniciar'} ${names[s.name]}`} disabled={blocked(isRunning ? 'stop' : 'start')} onClick={() => { void act(s.name, isRunning ? 'stop' : 'start'); }}>{isRunning ? <Square size={14}/> : <Play size={16}/>}</button>
      <button title="Reiniciar" aria-label={`Reiniciar ${names[s.name]}`} disabled={blocked('restart') || s.state === 'missing'} onClick={() => { void act(s.name, 'restart'); }}><RotateCcw size={16}/></button>
      {s.toolUrl ? <a title="Abrir herramienta de gestión" aria-label={`Abrir gestión de ${names[s.name]}`} href={s.toolUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={17}/></a> : <span className="disabled-link" title="Herramienta no disponible"><ArrowUpRight size={17}/></span>}</div></td>
  </tr>;
}

function AutomaticBackup({status}: {status: BackupStatus}) {
    const cycle = status.automatic;
    const labels = {running: 'En curso', succeeded: 'Completado', failed: 'Falló', interrupted: 'Interrumpido'};
    return <section className={`automatic-backup ${cycle?.status ?? 'unknown'}`} aria-label="Estado del backup automático">
        <Archive size={19}/><div><strong>Último ciclo automático</strong>
            <p>{status.error ?? (cycle ? `${labels[cycle.status]} · Inicio: ${time(cycle.startedAt)}${cycle.finishedAt ? ` · Fin: ${time(cycle.finishedAt)}` : ''}` : 'Sin ciclos registrados. Inicia el servicio de backups automáticos para generar una copia.')}</p>
            {cycle?.status === 'failed' && <p>Consulta los logs del servicio backup. Se conservan las copias anteriores cuando falla un dump.</p>}
            {cycle?.status === 'interrupted' && <p>El ciclo no terminó. Revisa los logs antes de confiar en sus archivos.</p>}
        </div>
    </section>;
}
