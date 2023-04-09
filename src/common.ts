import { getInput, InputOptions, setFailed } from '@actions/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from 'process';

export const cacheKeyState = 'cacheKey' as const;
export const binaryPackagesCountState = 'binaryPackagesCount' as const;
export const mainStepSucceededState = 'mainStepSucceeded' as const;

export type Inputs = {
    runSetup: boolean;
    vcpkgRoot: string;
    runInstall: boolean;
    installRoot: string;
    triplet: string;
    hostTriplet: string;
    installFeatures: string[];
    installCleanBuildtrees: boolean;
    installCleanPackages: boolean;
    installCleanDownloads: boolean;
    overlayTripletsPath: string;
    binaryCachePath: string;
    saveCache: boolean;
    cacheKeyTag: string;
};

function getInputVerbose(name: string, inputOptions: InputOptions): string {
    const value = getInput(name, inputOptions);
    console.info(`Inputs: ${name} is ${value}`);
    return value;
}

export function parseInputs(): Inputs {
    const runSetup = getInputVerbose('run-setup', { required: false });
    const vcpkgRoot = getInputVerbose('vcpkg-root', { required: false });
    const runInstall = getInputVerbose('run-install', { required: false });
    const installRoot = getInputVerbose('install-root', { required: false });
    const triplet = getInputVerbose('triplet', { required: false });
    const hostTriplet = getInputVerbose('host-triplet', { required: false });
    const installFeatures = getInputVerbose('install-features', { required: false });
    const installCleanBuildtrees = getInputVerbose('install-clean-buildtrees', { required: false });
    const installCleanPackages = getInputVerbose('install-clean-packages', { required: false });
    const installCleanDownloads = getInputVerbose('install-clean-downloads', { required: false });
    const overlayTripletsPath = getInputVerbose('overlay-triplets-path', { required: false });
    const binaryCachePath = getInputVerbose('binary-cache-path', { required: false });
    const saveCache = getInputVerbose('save-cache', { required: false });
    const cacheKeyTag = getInputVerbose('cache-key-tag', { required: false });
    const inputs = {
        runSetup: runSetup === 'true',
        vcpkgRoot: vcpkgRoot,
        runInstall: runInstall === 'true',
        installRoot: installRoot,
        triplet: triplet,
        hostTriplet: hostTriplet,
        installFeatures: installFeatures.split(/\s+/).filter(Boolean),
        installCleanBuildtrees: installCleanBuildtrees === 'true',
        installCleanPackages: installCleanPackages === 'true',
        installCleanDownloads: installCleanDownloads === 'true',
        overlayTripletsPath: overlayTripletsPath,
        binaryCachePath: binaryCachePath,
        saveCache: saveCache === 'true',
        cacheKeyTag: cacheKeyTag
    };
    if (inputs.runInstall && !triplet) {
        throw new AbortActionError('Triplet must be defined');
    }
    return inputs;
}

export function getEnvVariable(name: string): string;
export function getEnvVariable(name: string, required: true): string;
export function getEnvVariable(name: string, required: false): string | undefined;
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

// Standard vcpkg environment variables
export const ENV_VCPKG_ROOT = 'VCPKG_ROOT' as const;
export const ENV_VCPKG_BINARY_CACHE = 'VCPKG_DEFAULT_BINARY_CACHE' as const;
// GitHub Actions environment variable for vcpkg root
export const ENV_VCPKG_INSTALLATION_ROOT = 'VCPKG_INSTALLATION_ROOT' as const;

export type BinaryPackage = {
    filePath: string;
    size: number;
    mtime: Date;
};

const ZIP_EXTENSION = '.zip' as const;

function isZipFile(fileName: string): boolean {
    return fileName.endsWith(ZIP_EXTENSION);
}

async function findBinaryPackagesInDir(dirPath: string, onFoundPackage: (dirPath: string, fileName: string) => void) {
    const dir = await fs.opendir(dirPath);
    for await (const dirent of dir) {
        if (dirent.isDirectory()) {
            await findBinaryPackagesInDir(path.join(dirPath, dirent.name), onFoundPackage);
        } else if (dirent.isFile() && isZipFile(dirent.name)) {
            onFoundPackage(dirPath, dirent.name);
        }
    }
}

export async function countBinaryPackages(): Promise<number> {
    let count = 0;
    await findBinaryPackagesInDir(getEnvVariable(ENV_VCPKG_BINARY_CACHE), (_dirPath, _fileName) => {
        ++count;
    });
    return count;
}

export async function findBinaryPackages(): Promise<BinaryPackage[]> {
    const packages: BinaryPackage[] = [];

    const statPackage = async (filePath: string) => {
        const stat = await fs.stat(filePath);
        packages.push({ filePath: filePath, size: stat.size, mtime: stat.mtime });
    };
    const statPromises: Promise<void>[] = [];

    await findBinaryPackagesInDir(getEnvVariable(ENV_VCPKG_BINARY_CACHE), (dirPath, fileName) => {
        statPromises.push(statPackage(path.join(dirPath, fileName)));
    });

    await Promise.all(statPromises);

    // Sort by mtime in descending order, so that oldest files are at the end
    packages.sort((a, b) => {
        return b.mtime.getTime() - a.mtime.getTime();
    });

    return packages;
}

export function bytesToMibibytes(bytes: number): number {
    return (bytes / (1024.0 * 1024.0));
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
