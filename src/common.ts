import { getInput, InputOptions, setFailed } from '@actions/core';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from 'process';

export const cacheKeyState = 'cacheKey' as const;
export const latestBinaryPackageHashState = 'latestBinaryPackageHash' as const;
export const mainStepSucceededState = 'mainStepSucceeded' as const;

export type Inputs = {
    vcpkgRoot: string;
    runInstall: boolean;
    triplet: string;
    installFeatures: string[];
    installCleanBuildtrees: boolean;
    installCleanPackages: boolean;
    installCleanDownloads: boolean;
    saveCache: boolean;
};

function getInputVerbose(name: string, inputOptions: InputOptions): string {
    const value = getInput(name, inputOptions)
    console.info(`Inputs: ${name} is ${value}`);
    return value;
}

export function parseInputs(): Inputs {
    const vcpkgRoot = getInputVerbose('vcpkg-root', { required: false });
    const runInstall = getInputVerbose('run-install', { required: false });
    const triplet = getInputVerbose('triplet', { required: false });
    const installFeatures = getInputVerbose('install-features', { required: false });
    const installCleanBuildtrees = getInputVerbose('install-clean-buildtrees', { required: false });
    const installCleanPackages = getInputVerbose('install-clean-packages', { required: false });
    const installCleanDownloads = getInputVerbose('install-clean-downloads', { required: false });
    const saveCache = getInputVerbose('save-cache', { required: false });
    const inputs = {
        vcpkgRoot: vcpkgRoot,
        runInstall: runInstall === 'true',
        triplet: triplet,
        installFeatures: installFeatures.split(/\s+/).filter(Boolean),
        installCleanBuildtrees: installCleanBuildtrees === 'true',
        installCleanPackages: installCleanPackages === 'true',
        installCleanDownloads: installCleanDownloads === 'true',
        saveCache: saveCache === 'true'
    };
    if (inputs.runInstall && !triplet) {
        throw new AbortActionError('Triplet must be defined');
    }
    return inputs;
}

export function getEnvVariable(name: string): string
export function getEnvVariable(name: string, required: true): string
export function getEnvVariable(name: string, required: false): string | undefined
export function getEnvVariable(name: string, required: boolean = true): string | undefined {
    let value = env[name];
    if (value === undefined) {
        console.info(`${name} environment variable is not set`);
    } else {
        console.info(`${name} environment variable is ${value}`);
        if (!value) {
            value = undefined;
        }
    }
    if (value === undefined && required) {
        throw new AbortActionError(`${name} environment variable is not set or empty`);
    }
    return value;
}

export const ENV_VCPKG_ROOT = 'VCPKG_ROOT' as const
export const ENV_VCPKG_BINARY_CACHE = 'VCPKG_DEFAULT_BINARY_CACHE' as const

export type BinaryPackage = {
    filePath: string,
    size: number,
    mtimeMs: number
};

async function findBinaryPackagesInDir(dirPath: string, packages: BinaryPackage[]) {
    const dir = await fs.opendir(dirPath);
    for await (const dirent of dir) {
        if (dirent.isDirectory()) {
            await findBinaryPackagesInDir(path.join(dirPath, dirent.name), packages);
        } else if (dirent.isFile()) {
            const filePath = path.join(dirPath, dirent.name);
            const stat = await fs.stat(filePath);
            packages.push({ filePath: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
}

export async function findBinaryPackages(): Promise<BinaryPackage[]> {
    const packages: BinaryPackage[] = [];
    await findBinaryPackagesInDir(getEnvVariable(ENV_VCPKG_BINARY_CACHE), packages);
    // Sort by mtime in descending order, so that oldest files are at the end
    packages.sort((a, b) => {
        return b.mtimeMs - a.mtimeMs;
    });
    return packages;
}

export function computeHashOfBinaryPackage(pkg: BinaryPackage): string {
    const hash = createHash('sha256');
    hash.update(pkg.filePath);
    hash.update(pkg.mtimeMs.toString());
    hash.update(pkg.size.toString());
    return hash.digest('hex');
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
