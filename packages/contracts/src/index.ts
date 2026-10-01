import { z } from 'zod';
export const serviceNames = ['postgres', 'postgres-vector', 'mariadb', 'pgadmin4', 'phpmyadmin', 'backup'] as const;
export const serviceSchema = z.enum(serviceNames);
export const actionSchema = z.object({ action: z.enum(['start', 'stop', 'restart']) }).strict();
export type ServiceName = z.infer<typeof serviceSchema>;
export type Action = z.infer<typeof actionSchema>['action'];
export interface Service {
    name: ServiceName;
    image: string;
    state: string;
    health: 'healthy' | 'unhealthy' | 'starting' | 'none';
    healthOutput: string | null;
    ports: string[];
    toolUrl: string | null;
}
export interface Overview {
    context: string;
    project: string;
    services: Service[];
    updatedAt: string;
}
export interface Backup {
    name: string;
    size: number;
    modifiedAt: string;
    database: string;
}
export interface Operation {
    id: string;
    target: ServiceName | 'backups';
    action: Action | 'backup';
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: string | null;
    output: string;
}

export const backupCycleSchema = z.object({
    status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
}).strict();
export type BackupCycle = z.infer<typeof backupCycleSchema>;
export interface BackupStatus { automatic: BackupCycle | null; error: string | null }

// Compose puede iniciar o recrear estas dependencias con `up`.
const startDependencies: Partial<Record<ServiceName, ServiceName[]>> = {
    pgadmin4: ['postgres', 'postgres-vector'],
    phpmyadmin: ['mariadb'],
    backup: ['postgres', 'postgres-vector', 'mariadb'],
};
export const databaseServices: ServiceName[] = ['postgres', 'postgres-vector', 'mariadb'];
export function operationResources(target: ServiceName | 'backups', action: Action | 'backup'): ServiceName[] {
    if (target === 'backups') return [...databaseServices, 'backup'];
    return [target, ...(action === 'start' ? startDependencies[target] ?? [] : [])];
}
export function needsBackupLock(target: ServiceName, action: Action): boolean {
    return operationResources(target, action).some(name => name === 'backup' || databaseServices.includes(name));
}
