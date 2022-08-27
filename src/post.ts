import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs/promises';
import { AbortActionError, BinaryPackage, cacheKeyState, computeHashOfBinaryPackage, errorAsString, findBinaryPackages, getCacheDir, latestBinaryPackageHashState, mainStepSucceededState, parseInputs, runMain } from './common.js';
import { extractBinaryPackageControl } from './extractControl.js';


function bytesToMibibytes(bytes: number): number {
    return (bytes / (1024.0 * 1024.0));
}

async function findBinaryPackagesAndComputeTotalSize(): Promise<BinaryPackage[]> {
    core.startGroup('Searching packages in binary cache');
    const packages = await findBinaryPackages();
    let totalSize = packages.reduce((prev, cur) => prev + cur.size, 0);
    console.info('Found', packages.length, 'cached packages, total size is', bytesToMibibytes(totalSize), 'MiB');
    core.endGroup();
    return packages;
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

function computeIfAbsent<K, V>(map: Map<K, V>, key: K, mappingFunction: (key: K) => V): V {
    let value = map.get(key);
    if (value === undefined) {
        value = mappingFunction(key);
        map.set(key, value);
    }
    return value;
}

async function removeOldVersions(packages: BinaryPackage[]) {
    core.startGroup('Removing old versions of packages');
    const identifiedPackages = new Map<string, Map<string, BinaryPackage[]>>();
    for (const pkg of packages) {
        try {
            const control = await extractBinaryPackageControl(pkg);
            const pkgsWithSameName = computeIfAbsent(identifiedPackages, control.packageName, () => {
                return new Map<string, BinaryPackage[]>()
            });
            const pkgsWithSameNameAndArch = computeIfAbsent(pkgsWithSameName, control.architecture, () => { return []; });
            pkgsWithSameNameAndArch.push(pkg);
        } catch (error) {
            console.error('Failed to extract metadata from package', pkg.filePath, error);
        }
    }
    const remainingPackages = new Set(packages);
    const rmPromises: Promise<void>[] = []
    for (const [packageName, pkgsWithSameName] of identifiedPackages) {
        for (const [architecture, pkgsWithSameNameAndArch] of pkgsWithSameName) {
            if (pkgsWithSameNameAndArch.length > 1) {
                console.info('Removing older versions of package', packageName, 'with architecture', architecture, `(latest is ${pkgsWithSameNameAndArch.at(0)?.filePath})`)
                // Packages are sorted from newest to oldest, remove old ones
                while (pkgsWithSameNameAndArch.length > 1) {
                    const pkg = pkgsWithSameNameAndArch.pop()!!;
                    console.info(' - Removing', pkg.filePath);
                    rmPromises.push(fs.rm(pkg.filePath));
                    remainingPackages.delete(pkg);
                }
            }
        }
    }
    if (rmPromises.length > 0) {
        try {
            await Promise.all(rmPromises);
        } catch (error) {
            console.error(error);
            throw new AbortActionError(`Failed to remove packages with error '${errorAsString(error)}'`);
        }
        let totalSize = [...remainingPackages].reduce((prev, cur) => prev + cur.size, 0);
        console.info('New packages count is', remainingPackages.size, 'and total size is', bytesToMibibytes(totalSize), 'MiB');
    } else {
        console.info('Did not remove any packages');
    }
    core.endGroup();
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
    if (packages.length == 0) {
        console.info('No binary packages, skip saving cache');
        return;
    }
    if (!didLatestPackageChange(packages)) {
        console.info('Latest binary package did not change, skip saving cache');
        return;
    }
    await removeOldVersions(packages);
    await saveCache();
}

await runMain(main);
