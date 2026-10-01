// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { serviceNames } from '@cluster-sql/contracts';
const services = serviceNames.map(name => ({ name, image: 'test:1', state: name === 'postgres' ? 'running' : 'missing', health: name === 'postgres' ? 'healthy' : 'none', healthOutput: null, ports: [], toolUrl: name === 'postgres' ? 'http://127.0.0.1:8081' : null }));
let offline = false;
let currentJob: object | null = null;
class MockEvents {
    static last: MockEvents;
    onopen?: () => void;
    onerror?: () => void;
    closed = false;
    listeners: Record<string, (event: {
        data: string;
    }) => void> = {};
    constructor() { MockEvents.last = this; }
    addEventListener(event: string, listener: (event: {
        data: string;
    }) => void) { this.listeners[event] = listener; }
    close() { this.closed = true; }
}
beforeEach(() => {
    offline = false;
    currentJob = null;
    vi.stubGlobal('EventSource', MockEvents);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (offline)
            return { ok: false, json: async () => ({ error: 'Docker apagado' }) };
        if (init)
            currentJob = { id: 'job', status: 'running', target: 'postgres', action: 'restart', startedAt: new Date().toISOString(), finishedAt: null, output: '' };
        const value = init ? currentJob : url.endsWith('/services') ? { context: 'orbstack', project: 'cluster-sql', services, updatedAt: new Date().toISOString() } : url.endsWith('/operations') && currentJob ? [currentJob] : [];
        return { ok: true, json: async () => value };
    }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test('muestra servicios ausentes, salud y enlaces; confirma operaciones', async () => {
    render(<App />);
    await screen.findByText('PostgreSQL');
    expect(screen.getAllByText('Sin crear')).toHaveLength(5);
    expect(screen.getByRole('link', { name: 'Abrir gestión de PostgreSQL' })).toHaveAttribute('href', 'http://127.0.0.1:8081');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar PostgreSQL' }));
    expect(confirm).toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar PostgreSQL' }));
    await screen.findByText('En curso', { exact: false });
    expect(screen.getByRole('button', { name: 'Reiniciar PostgreSQL' })).toBeDisabled();
});
test('conserva datos anteriores y deshabilita acciones cuando Docker falla', async () => {
    render(<App />);
    await screen.findByText('PostgreSQL');
    offline = true;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await screen.findByText('Información desactualizada');
    expect(screen.getByText('Docker apagado')).toBeVisible();
    expect(screen.getByText('PostgreSQL')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Detener PostgreSQL' })).toBeDisabled();
});
test('logs limitados a 5000 líneas, limpiar, pausar y cerrar al salir', async () => {
    render(<App />);
    await screen.findByText('PostgreSQL');
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    await waitFor(() => expect(MockEvents.last).toBeDefined());
    const events = MockEvents.last;
    act(() => { events.onopen?.(); for (let i = 0; i < 5001; i++)
        events.listeners.line({ data: JSON.stringify(`línea ${i}`) }); });
    expect(screen.getByText('5000 líneas')).toBeVisible();
    const output = screen.getByLabelText('Salida de logs');
    expect(output.textContent).not.toContain('línea 0\n');
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar' }));
    expect(screen.getByText('0 líneas')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(events.closed).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reanudar' }));
    const next = MockEvents.last;
    fireEvent.click(screen.getByRole('button', { name: /Vista general/ }));
    expect(next.closed).toBe(true);
});
test('vista de backups muestra estado vacío', async () => {
    render(<App />);
    await screen.findByText('PostgreSQL');
    fireEvent.click(screen.getByRole('button', { name: /Backups 0/ }));
    expect(screen.getByText('Todavía no hay backups')).toBeVisible();
});
