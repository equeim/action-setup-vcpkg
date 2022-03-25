import * as readline from 'readline';
import { Readable } from 'stream';
import * as yauzl from 'yauzl';
import { BinaryPackage } from './common';

const controlFileName = 'CONTROL' as const;
const packageNameKey = 'Package' as const;
const architectureKey = 'Architecture' as const;
const keyValueSeparator = ':' as const;

export type BinaryPackageControl = {
    packageName: string,
    architecture: string
};

export async function extractBinaryPackageControl(pkg: BinaryPackage): Promise<BinaryPackageControl> {
    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
        yauzl.open(pkg.filePath, { autoClose: true, lazyEntries: true }, (err, zipfile) => {
            if (zipfile != null) {
                resolve(zipfile);
            } else {
                reject(new Error('Failed to open zip file'));
            }
        });
    });

    try {
        const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
            zipfile.readEntry();
            zipfile.on('entry', (entry: yauzl.Entry) => {
                if (entry.fileName === controlFileName) {
                    resolve(entry);
                } else {
                    zipfile.readEntry();
                }
            });
            zipfile.once('end', () => {
                reject(new Error(`Reached end of zip file before finding ${controlFileName} entry`));
            });
            zipfile.once('error', (err) => {
                reject(err);
            });
        });

        const stream = await new Promise<Readable>((resolve, reject) => {
            zipfile.openReadStream(entry, (err, stream) => {
                if (stream != null) {
                    resolve(stream);
                } else {
                    reject(err);
                }
            });
        });

        const control = await new Promise<BinaryPackageControl>((resolve, reject) => {
            let packageName: string | undefined;
            let architecture: string | undefined;

            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            rl.on('line', (line) => {
                const separatorIndex = line.indexOf(keyValueSeparator);
                if (separatorIndex != -1) {
                    const key = line.slice(0, separatorIndex).trim();
                    const lazyValue = () => {
                        return line.slice(separatorIndex + 1).trim();
                    };
                    if (key == packageNameKey) {
                        packageName = lazyValue();
                    } else if (key == architectureKey) {
                        architecture = lazyValue();
                    }
                    if (packageName !== undefined && architecture !== undefined) {
                        rl.close();
                        stream.destroy();
                        resolve({ packageName: packageName, architecture: architecture });
                    }
                }
            });
            stream.on('end', () => {
                const notFound = [];
                if (packageName === undefined) {
                    notFound.push(packageNameKey);
                }
                if (architecture === undefined) {
                    notFound.push(architectureKey);
                }
                reject(new Error(`${controlFileName} file doesn't contain required keys: ${notFound}`));
            });
        });

        return control;
    } finally {
        zipfile.close();
    }
}
