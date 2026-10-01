import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Backup } from '@cluster-sql/contracts';
import { AppError } from './docker.js';
export class BackupFiles {
    constructor(private directory: string) { }
    private async file(name: string) {
        if (!name.endsWith('.sql.gz') || name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.sql.gz')
            throw new AppError('Nombre de backup inválido.', 400);
        try {
            const handle = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            const stat = await handle.stat();
            if (!stat.isFile()) {
                await handle.close();
                throw new AppError('Backup no encontrado.', 404);
            }
            return { handle, stat };
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            throw new AppError('Backup no encontrado.', 404);
        }
    }
    async list(): Promise<Backup[]> {
        let entries;
        try {
            entries = await readdir(this.directory, { withFileTypes: true });
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return [];
            throw error;
        }
        const files: Backup[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.sql.gz'))
                continue;
            try {
                const { handle, stat } = await this.file(entry.name);
                await handle.close();
                files.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString(),
                    database: /^(?:postgres|pgvector|mariadb)_(.+)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.sql\.gz$/.exec(entry.name)?.[1] ?? 'Sin identificar' });
            }
            catch { /* Un archivo puede desaparecer durante la rotación. */ }
        }
        return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    }
    async download(name: string) {
        const { handle, stat } = await this.file(name);
        return { size: stat.size, stream: handle.createReadStream() };
    }
}
