import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs/promises';
import path from 'path';
import { AbortActionError, binaryCachePathState, BinaryPackage, binaryPackagesCountState, cacheKeyState, errorAsString, findBinaryPackagesInDir, getEnvVariable, mainStepSucceededState, parseInputs, runMain } from './common.js';
import { Architecture, extractBinaryPackageControl, PackageName } from './extractControl.js';

function bytesToMibibytesString(bytes: number): string {
    return (bytes / (1024.0 * 1024.0)).toFixed(2) + ' MiB';
}

async function findBinaryPackages(): Promise<BinaryPackage[]> {
    core.startGroup('Searching packages in binary cache');
    const packages: BinaryPackage[] = [];

    let totalSize = 0;
    const statPackage = async (filePath: string) => {
        const stat = await fs.stat(filePath);
        totalSize += stat.size;
        packages.push({ filePath: filePath, size: stat.size, mtime: stat.mtime });
    };

    const statPromises: Promise<void>[] = [];
    await findBinaryPackagesInDir(core.getState(binaryCachePathState), (dirPath, fileName) => {
        statPromises.push(statPackage(path.join(dirPath, fileName)));
    });
    await Promise.all(statPromises);

    console.info(`Found ${packages.length} binary packages total size is ${bytesToMibibytesString(totalSize)}`);

    return packages;
}

function areThereNewBinaryPackages(packages: BinaryPackage[]): boolean {
    const previousCount = parseInt(core.getState(binaryPackagesCountState));
    console.info('Previous count of binary packages is', previousCount);
    const binaryPackagesCount = packages.length;
    return binaryPackagesCount !== previousCount;
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
    const identifiedPackages = new Map<PackageName, Map<Architecture, BinaryPackage[]>>();
    for (const pkg of packages) {
        try {
            const control = await extractBinaryPackageControl(pkg);
            const pkgsWithSameName = computeIfAbsent(identifiedPackages, control.packageName, () => {
                return new Map<Architecture, BinaryPackage[]>();
            });
            const pkgsWithSameNameAndArch = computeIfAbsent(pkgsWithSameName, control.architecture, () => { return []; });
            pkgsWithSameNameAndArch.push(pkg);
        } catch (error) {
            console.error('Failed to extract metadata from package', pkg.filePath, error);
        }
    }
    const remainingPackages = new Set(packages);
    const rmPromises: Promise<void>[] = [];
    for (const [packageName, pkgsWithSameName] of identifiedPackages) {
        for (const [architecture, pkgsWithSameNameAndArch] of pkgsWithSameName) {
            // Sort by mtime in descending order, so that oldest files are at the end
            pkgsWithSameNameAndArch.sort((a, b) => {
                return b.mtime.getTime() - a.mtime.getTime();
            });
            console.info(`Packages with name ${packageName} and architecture ${architecture}:`);
            while (pkgsWithSameNameAndArch.length > 1) {
                const pkg = pkgsWithSameNameAndArch.pop()!!;
                console.info(` - Removing ${pkg.filePath}, with size ${bytesToMibibytesString(pkg.size)} and mtime ${pkg.mtime.toISOString()}`);
                rmPromises.push(fs.rm(pkg.filePath));
                remainingPackages.delete(pkg);
            }
            const last = pkgsWithSameNameAndArch.at(0)!!;
            console.info(` - Latest is ${last.filePath}, with size ${bytesToMibibytesString(last.size)} and mtime ${last.mtime.toISOString()}`);
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
        console.info('New packages count is', remainingPackages.size, 'and total size is', bytesToMibibytesString(totalSize));
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
        await cache.saveCache([core.getState(binaryCachePathState)], key);
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
    const packages = await findBinaryPackages();
    if (packages.length == 0) {
        console.info('No binary packages, skip saving cache');
        return;
    }
    if (!areThereNewBinaryPackages(packages)) {
        console.info('No new binary packages, skip saving cache');
        return;
    }
    console.info('There are new binary packages');
    await removeOldVersions(packages);
    await saveCache();
}

await runMain(main);
