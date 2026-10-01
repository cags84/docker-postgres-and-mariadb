"""Pruebas del script sin motor Docker; las dependencias se simulan."""
from pathlib import Path
import gzip
import os
import subprocess
import tempfile
import time
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'backup.sh').read_text()

class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cluster-sql-backup-test-')
        self.root = Path(self.temp.name)
        self.bins = self.root / 'bin'
        self.bins.mkdir()
        mocks = {
            'pg_dump': 'case "$*" in *"-h postgres-vector "*) [ "${FAIL_VECTOR:-0}" = 1 ] && exit 1 ;; esac\nprintf "SELECT 42;\\n"\n',
            'mariadb-dump': '[ "${FAIL_MARIA:-0}" = 1 ] && exit 1\nprintf "SELECT 42;\\n"\n',
            'mv': '[ "${FAIL_MOVE:-0}" = 1 ] && exit 1\nexec /bin/mv "$@"\n',
            'flock': '[ "$1" = "-u" ] && exit 0\n[ "${LOCK_BUSY:-0}" != 1 ]\n',
            'chown': 'exit 0\n',
        }
        for name, body in mocks.items():
            file = self.bins / name
            file.write_text('#!/bin/sh\n' + body)
            file.chmod(0o755)
        self.dest = self.root / 'backups'
        self.dest.mkdir()
        self.old = self.dest / 'postgres_main_old.sql.gz'
        self.old.write_bytes(b'old backup')
        ancient = time.time() - 12 * 86400
        os.utime(self.old, (ancient, ancient))
        self.script = self.root / 'backup.sh'
        self.script.write_text(SOURCE.replace('BACKUP_DIR=/backups', f'BACKUP_DIR={self.dest}'))
        self.env = dict(os.environ, PATH=f'{self.bins}:{os.environ["PATH"]}', PGPASSWORD='test', POSTGRES_USER='test', POSTGRES_DB='main', POSTGRES_VECTOR_DB='vector', MARIADB_ROOT_PASSWORD='test', MARIADB_DATABASE='main', BACKUP_INTERVAL='1', BACKUP_RETENTION_DAYS='7')

    def tearDown(self):
        self.temp.cleanup()

    def run_backup(self, **changes):
        return subprocess.run(['/bin/sh', str(self.script), '--once'], env=dict(self.env, **changes), capture_output=True, text=True, timeout=10)

    def test_once_success_and_rotation(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.old.exists())
        files = list(self.dest.glob('*.sql.gz'))
        self.assertEqual(len(files), 3)
        for file in files:
            self.assertIn(b'42', gzip.decompress(file.read_bytes()))

    def test_dump_failure_preserves_old_copy(self):
        result = self.run_backup(FAIL_VECTOR='1')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.old.exists())
        self.assertIn('Rotación omitida', result.stdout)
        self.assertFalse(list(self.dest.glob('*.part')))

    def test_move_failure_not_success(self):
        result = self.run_backup(FAIL_MOVE='1')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.old.exists())
        self.assertNotIn('    ok ', result.stdout)
        self.assertFalse(list(self.dest.glob('*.part')))

    def test_busy_lock(self):
        result = self.run_backup(LOCK_BUSY='1')
        self.assertEqual(result.returncode, 75)
        self.assertTrue(self.old.exists())
        self.assertEqual(len(list(self.dest.glob('*.sql.gz'))), 1)

    def test_invalid_configuration(self):
        for changes in [{'BACKUP_INTERVAL': '0'}, {'BACKUP_INTERVAL': '000'}, {'BACKUP_INTERVAL': '-1'}, {'BACKUP_INTERVAL': 'x'}, {'BACKUP_RETENTION_DAYS': '-1'}, {'PGPASSWORD': ''}]:
            with self.subTest(changes=changes):
                self.assertEqual(self.run_backup(**changes).returncode, 1)
                self.assertTrue(self.old.exists())

    def test_zero_retention(self):
        self.assertEqual(self.run_backup(BACKUP_RETENTION_DAYS='0').returncode, 0)

if __name__ == '__main__':
    unittest.main()
