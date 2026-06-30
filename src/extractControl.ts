import * as readline from 'readline';

import * as yauzl from 'yauzl';
import { BinaryPackage } from './common.js';

const controlFileName = 'CONTROL' as const;
const packageNameKey = 'Package' as const;
const architectureKey = 'Architecture' as const;
const keyValueSeparator = ':' as const;

enum PackageNameBrand { _ = '' };
export type PackageName = string & PackageNameBrand;
enum ArchitectureBrand { _ = '' };
export type Architecture = string & ArchitectureBrand;

export type BinaryPackageControl = {
    packageName: PackageName,
    architecture: Architecture;
};

export async function extractBinaryPackageControl(pkg: BinaryPackage): Promise<BinaryPackageControl> {
    const zipfile = await yauzl.openPromise(pkg.filePath, { autoClose: true, lazyEntries: true });
    try {
        return await parseControl(zipfile, await findControlEntry(zipfile));

    } finally {
        zipfile.close();
    }
}

async function findControlEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry> {
    for await (const entry of zipfile.eachEntry()) {
        if (entry.fileName == controlFileName) {
            return entry;
        }
    }
    throw new Error(`Reached end of zip file before finding ${controlFileName} entry`);
}

async function parseControl(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<BinaryPackageControl> {
    let packageName: PackageName | undefined;
    let architecture: Architecture | undefined;

    await using controlEntryStream = await zipfile.openReadStreamPromise(entry);
    using lines = readline.createInterface({ input: controlEntryStream, crlfDelay: Infinity });
    for await (const line of lines) {
        const separatorIndex = line.indexOf(keyValueSeparator);
        if (separatorIndex != -1) {
            const key = line.slice(0, separatorIndex).trim();
            const lazyValue = () => {
                return line.slice(separatorIndex + 1).trim();
            };
            if (key == packageNameKey) {
                packageName = lazyValue() as PackageName;
            } else if (key == architectureKey) {
                architecture = lazyValue() as Architecture;
            }
            if (packageName !== undefined && architecture !== undefined) {
                return { packageName, architecture };
            }
        }
    }

    const notFound = [];
    if (packageName === undefined) {
        notFound.push(packageNameKey);
    }
    if (architecture === undefined) {
        notFound.push(architectureKey);
    }
    throw new Error(`${controlFileName} file of archive doesn't contain required keys: ${notFound}`);
}
