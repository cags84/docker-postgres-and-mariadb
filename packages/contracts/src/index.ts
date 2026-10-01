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
