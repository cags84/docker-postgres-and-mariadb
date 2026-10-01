"""Prueba real aislada. Ejecutar después de pnpm build; --keep permite inspeccionar la UI."""
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'cluster-sql-test-' + uuid.uuid4().hex[:8]
PORT = 3010
BASE = f'http://127.0.0.1:{PORT}'

def command(args, **kwargs):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f'Comando falló ({result.returncode}): {result.stderr[-3000:]}')
    return result.stdout

with tempfile.TemporaryDirectory(prefix='cluster-sql-runtime-') as tmp:
    directory = Path(tmp)
    backups = directory / 'backups'
    backups.mkdir()
    config = json.loads(command(['docker', 'compose', '--env-file', '.env.example', '--profile', 'backup', 'config', '--format', 'json']))
    config.pop('name', None)
    for category in ('volumes', 'networks'):
        for entry in config[category].values():
            entry.pop('name', None)
    for service in config['services'].values():
        service.pop('container_name', None)
        for port in service.get('ports', []):
            port['published'] = '0'
        for volume in service.get('volumes', []):
            if volume.get('target') == '/backups':
                volume['source'] = str(backups)
    config['services']['backup']['environment']['BACKUP_INTERVAL'] = '3600'
    compose_file = directory / 'compose.json'
    compose_file.write_text(json.dumps(config))
    compose = ['docker', 'compose', '-p', PROJECT, '-f', str(compose_file), '--profile', 'backup']
    api = None
    blocker = None
    foreign = None
    def request(path, payload=None):
        req = Request(BASE + '/api/' + path, data=json.dumps(payload).encode() if payload is not None else None,
                      headers={'Origin': BASE, 'Content-Type': 'application/json'})
        with urlopen(req, timeout=15) as response:
            return json.load(response)
    def operation(path, body):
        job = request(path, body)
        for _ in range(360):
            state = next(o for o in request('operations') if o['id'] == job['id'])
            if state['status'] != 'running':
                assert state['status'] == 'succeeded', state
                return state
            time.sleep(.5)
        raise AssertionError('La operación no terminó')
    def container(service):
        return command(compose + ['ps', '-q', service]).strip()
    def sql(service, statement):
        script = 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -N -u root "$MARIADB_DATABASE" -e "$1"' if service == 'mariadb' else 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"'
        return command(['docker', 'exec', container(service), 'sh', '-c', script, 'sql', statement]).strip()
    try:
        print('Construyendo imagen de backup...', flush=True)
        command(compose + ['build', 'backup'], timeout=300)
        env = dict(os.environ, DASHBOARD_PORT=str(PORT), DASHBOARD_PROJECT=PROJECT,
                   DASHBOARD_COMPOSE_FILE=str(compose_file), DASHBOARD_ENV_FILE=str(ROOT / '.env.example'), DASHBOARD_BACKUPS_DIR=str(backups))
        api = subprocess.Popen(['node', 'apps/api/dist/main.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(60):
            try:
                initial = request('services')
                break
            except Exception:
                if api.poll() is not None:
                    raise RuntimeError(api.stderr.read().decode())
                time.sleep(.25)
        else:
            raise AssertionError('La API no inició')
        assert all(s['state'] == 'missing' for s in initial['services'])
        assert len(initial['services']) == 6
        print('OK: servicios sin crear y frontend compilado servido por la API', flush=True)
        with urlopen(BASE) as response:
            assert b'cluster-sql' in response.read()
        command(compose + ['up', '-d', '--wait', '--wait-timeout', '240'], timeout=300)
        live = request('services')
        assert len(live['services']) == 6
        assert all(s['health'] == 'healthy' for s in live['services'] if s['name'] != 'backup')
        assert next(s for s in live['services'] if s['name'] == 'backup')['health'] == 'none'
        for service in ('pgadmin4', 'phpmyadmin'):
            url = next(s for s in live['services'] if s['name'] == service)['toolUrl']
            with urlopen(url, timeout=15) as response:
                assert response.status == 200
        foreign = command(['docker', 'run', '-d', '--rm', '--label', 'com.docker.compose.project=outside-test', '--label', 'com.docker.compose.service=postgres', 'postgres:17-alpine', 'sleep', '600']).strip()
        assert len(request('services')['services']) == 6
        try:
            request('services/foreign/actions', {'action': 'stop'})
            raise AssertionError('Servicio ajeno aceptado')
        except HTTPError as error:
            assert error.code == 400
        print('OK: salud, herramientas de gestión y filtro de proyecto', flush=True)
        operation('services/phpmyadmin/actions', {'action': 'stop'})
        assert next(s for s in request('services')['services'] if s['name'] == 'phpmyadmin')['state'] == 'exited'
        operation('services/phpmyadmin/actions', {'action': 'start'})
        operation('services/phpmyadmin/actions', {'action': 'restart'})
        print('OK: iniciar, detener y reiniciar mediante API', flush=True)
        for service in ('postgres', 'postgres-vector', 'mariadb'):
            sql(service, 'CREATE TABLE runtime_probe (id integer PRIMARY KEY); INSERT INTO runtime_probe VALUES (42);')
        sql('postgres-vector', "CREATE EXTENSION vector; CREATE TABLE vector_probe (v vector(3)); INSERT INTO vector_probe VALUES ('[1,2,3]');")
        for _ in range(30):
            if 'Ciclo OK' in command(compose + ['logs', 'backup']):
                break
            time.sleep(.5)
        else:
            raise AssertionError('El ciclo periódico no terminó')
        time.sleep(1)
        operation('backups', {})
        files = request('backups')
        for prefix, service in [('postgres_', 'postgres'), ('pgvector_', 'postgres-vector'), ('mariadb_', 'mariadb')]:
            latest = sorted(f['name'] for f in files if f['name'].startswith(prefix))[-1]
            with urlopen(BASE + '/api/backups/' + latest + '/download') as response:
                compressed = response.read()
            data = gzip.decompress(compressed)
            assert b'runtime_probe' in data and b'42' in data
            sql(service, 'DROP TABLE runtime_probe;')
            restore_script = 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -u root "$MARIADB_DATABASE"' if service == 'mariadb' else 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
            restored = subprocess.run(['docker', 'exec', '-i', container(service), 'sh', '-c', restore_script], input=data, capture_output=True)
            assert restored.returncode == 0, restored.stderr.decode()
            assert sql(service, 'SELECT id FROM runtime_probe;') == '42'
        assert sql('postgres-vector', 'SELECT v FROM vector_probe;') == '[1,2,3]'
        print('OK: backup manual, descarga y restauración de las tres bases y pgvector', flush=True)
        blocker = command(['docker', 'run', '-d', '--rm', '-v', f'{backups}:/backups', '--entrypoint', 'sh', 'cluster-sql-backup:pg17', '-c', 'exec 9>/backups/.backup.lock; flock 9; echo locked; sleep 120']).strip()
        for _ in range(20):
            if 'locked' in command(['docker', 'logs', blocker]): break
            time.sleep(.1)
        blocked = subprocess.run(compose + ['run', '--rm', '--no-deps', '-T', 'backup', '--once'], capture_output=True, text=True)
        assert blocked.returncode == 75, blocked.stderr
        command(['docker', 'stop', '-t', '1', blocker]); blocker = None
        ancient = backups / 'postgres_preservar_antiguo.sql.gz'
        shutil.copyfile(next(backups.glob('postgres_*.sql.gz')), ancient)
        old = time.time() - 12 * 86400
        os.utime(ancient, (old, old))
        failed = subprocess.run(compose + ['run', '--rm', '--no-deps', '-T', '-e', 'PGPASSWORD=invalid-test-password', 'backup', '--once'], capture_output=True, text=True)
        assert failed.returncode == 1 and 'Rotación omitida' in failed.stdout
        assert ancient.exists() and not list(backups.glob('*.part'))
        print('OK: flock real y conservación de copias ante fallo de autenticación', flush=True)
        print('Todas las pruebas de Docker pasaron.', flush=True)
        if '--keep' in sys.argv:
            print(f'UI temporal disponible en {BASE}; Ctrl+C limpia el stack.', flush=True)
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        if api:
            api.terminate()
            try: api.wait(timeout=5)
            except subprocess.TimeoutExpired: api.kill(); api.wait()
        for extra in (blocker, foreign):
            if extra: subprocess.run(['docker', 'stop', '-t', '1', extra], capture_output=True)
        subprocess.run(compose + ['down', '-v'], capture_output=True, timeout=90)
        print('Stack temporal eliminado.', flush=True)
