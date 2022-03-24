import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs/promises';
import { AbortActionError, BinaryPackage, cacheKeyState, computeHashOfBinaryPackage, errorAsString, findBinaryPackages, getCacheDir, latestBinaryPackageHashState, mainStepSucceededState, parseInputs, runMain } from './common';



const maximumCacheSize = 3 * 1024 * 1024 * 1024;

function bytesToMibibytes(bytes: number): number {
    return (bytes / (1024.0 * 1024.0));
}

type BinaryPackages = {
    packages: BinaryPackage[];
    totalSize: number;
}

async function findBinaryPackagesAndComputeTotalSize(): Promise<BinaryPackages> {
    core.startGroup('Searching packages in binary cache');
    const packages = await findBinaryPackages();
    let totalSize = packages.reduce((prev, cur) => prev + cur.size, 0);
    console.info('Found', packages.length, 'cached packages, total size is', bytesToMibibytes(totalSize), 'MiB');
    core.endGroup();
    return { packages: packages, totalSize: totalSize };
}

function didLatestPackageChange(packages: BinaryPackage[]): boolean {
    const previousHash = core.getState(latestBinaryPackageHashState);
    console.info('Previous hash of latest binary package is', previousHash);
    const latestBinaryPackage = packages.at(0)!!;
    console.info('Latest binary package is', latestBinaryPackage);
    const hash = computeHashOfBinaryPackage(latestBinaryPackage);
    console.info('Hash of latest binary package is', hash);
    if (hash === previousHash) {
        console.info('Hash of latest binary package did not change');
        return false;
    }
    console.info('Hash of latest binary package changed');
    return true;
}

async function removeOldestPackages(cachedPackages: BinaryPackages): Promise<BinaryPackage[]> {
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

async function saveCache() {
    core.startGroup('Saving cache');
    const key = core.getState(cacheKeyState);
    if (!key) {
        throw new AbortActionError('Cache key is not set');
    }
    console.info('Saving cache with key', key);
    try {
        await cache.saveCache([getCacheDir()], key);
    } catch (error) {
        console.error(error);
        core.error(`Failed to save cache with error ${errorAsString(error)}`);
    }
    core.endGroup();
}

async function main() {
    const mainStepSucceeded = core.getState(mainStepSucceededState);
    if (mainStepSucceeded !== 'true') {
        console.info('Main step did not succeed, skip saving cache');
        return;
    }
    const inputs = parseInputs();
    if (!inputs.saveCache) {
        console.info('Cache saving is disabled, skip saving cache');
        return;
    }
    const packages = await findBinaryPackagesAndComputeTotalSize();
    if (packages.packages.length == 0) {
        console.info('No binary packages, skip saving cache');
        return;
    }
    if (!didLatestPackageChange(packages.packages)) {
        console.info('Latest binary package did not change, skip saving cache');
        return;
    }
    const newPackages = await removeOldestPackages(packages);
    if (newPackages.length == 0) {
        console.info('All binary packages were removed, skip saving cache');
        return;
    }
    await saveCache();
}

runMain(main);
