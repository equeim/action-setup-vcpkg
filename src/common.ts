import { setFailed } from '@actions/core';
import { env } from 'process';

export const cacheKeyState = 'cacheKey' as const;

export function getEnvVariable(name: string): string
export function getEnvVariable(name: string, required: true): string
export function getEnvVariable(name: string, required: false): string | undefined
export function getEnvVariable(name: string, required: boolean = true): string | undefined {
    const value = env[name];
    if (required && value == null) {
        throw new AbortActionError(`${name} environment variable is not set`);
    }
    return value;
}

export class AbortActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbortActionError';
    }
}

export function errorAsString(error: unknown): string {
    if (error instanceof Error && error.message) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

export async function runMain<T>(block: () => Promise<T>) {
    try {
        await block();
    } catch (error) {
        let message = '';
        if (error instanceof AbortActionError) {
            console.error(error.message);
            message = error.message;
        } else {
            console.error('!!! Unhandled exception:');
            console.error(error);
            message = `!!! Unhandled exception ${error}`;
        }
        setFailed(message);
    }
} 
