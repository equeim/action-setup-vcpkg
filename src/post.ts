import * as fs from 'fs/promises';
import * as path from 'path';

import * as cache from '@actions/cache';
import * as core from '@actions/core';

import { cacheKeyState, getEnvVariable, AbortActionError, errorAsString, runMain } from './common';

const maximumCacheSize = 3 * 1024 * 1024 * 1024;

function bytesToMibibytes(bytes: number): number {
    return (bytes / (1024.0 * 1024.0));
}

type CachedPackage = {
    filePath: string,
    size: number,
    mtimeMs: number
};

async function findCachedPackagesInDir(dirPath: string, packages: CachedPackage[]) {
    const dir = await fs.opendir(dirPath);
    for await (const dirent of dir) {
        if (dirent.isDirectory()) {
            await findCachedPackagesInDir(path.join(dirPath, dirent.name), packages);
        } else if (dirent.isFile()) {
            const filePath = path.join(dirPath, dirent.name);
            const stat = await fs.stat(filePath);
            packages.push({ filePath: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
}

type CachedPackages = {
    packages: CachedPackage[];
    totalSize: number;
}

async function findCachedPackages(cacheDir: string): Promise<CachedPackages> {
    core.startGroup('Searching packages in binary cache');
    const packages: CachedPackage[] = [];
    await findCachedPackagesInDir(cacheDir, packages);
    // Sort by mtime in descending order, so that oldest files are at the end
    packages.sort((a, b) => {
        return b.mtimeMs - a.mtimeMs;
    });
    let totalSize = packages.reduce((prev, cur) => prev + cur.size, 0);
    console.info('Found', packages.length, 'cached packages, total size is', bytesToMibibytes(totalSize), 'MiB');
    core.endGroup();
    return { packages: packages, totalSize: totalSize };
}

async function removeOldestPackages(cachedPackages: CachedPackages): Promise<CachedPackage[]> {
    let { packages, totalSize } = cachedPackages;
    if (totalSize <= maximumCacheSize) {
        return packages;
    }
    core.startGroup('Removing old packages')
    console.info('Cache size is more than', bytesToMibibytes(maximumCacheSize), 'MiB, remove oldest packages');
    const rmPromises: Promise<void>[] = []
    while (totalSize > maximumCacheSize && packages.length > 0) {
        const pkg = packages.pop();
        if (pkg != null) {
            console.info('Removing', pkg.filePath);
            rmPromises.push(fs.rm(pkg.filePath));
            totalSize -= pkg.size;
        }
    }
    if (rmPromises.length > 0) {
        try {
            await Promise.all(rmPromises);
        } catch (error) {
            console.error(error);
            throw new AbortActionError(`Failed to remove packages with error '${errorAsString(error)}'`);
        }
    }
    console.info('New packages count is', packages.length, 'and total size is', bytesToMibibytes(totalSize), 'MiB');
    core.endGroup();
    return packages;
}

async function saveCache(cacheDir: string) {
    core.startGroup('Saving cache');
    const key = core.getState(cacheKeyState);
    if (!key) {
        throw new AbortActionError('Cache key is not set');
    }
    console.info('Saving cache with key', key);
    try {
        await cache.saveCache([cacheDir], key);
    } catch (error) {
        console.error(error);
        core.error(`Failed to save cache with error ${errorAsString(error)}`);
    }
    core.endGroup();
}

async function main() {
    const cacheDir = getEnvVariable('VCPKG_DEFAULT_BINARY_CACHE');
    const packages = await removeOldestPackages(await findCachedPackages(cacheDir))
    if (packages.length > 0) {
        await saveCache(cacheDir);
    }
}

runMain(main);
