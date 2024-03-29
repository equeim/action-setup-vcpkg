import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AbortActionError, ENV_VCPKG_BINARY_CACHE, ENV_VCPKG_INSTALLATION_ROOT, ENV_VCPKG_ROOT, Inputs, binaryPackagesCountState, cacheKeyState, errorAsString, findBinaryPackagesInDir, getEnvVariable, mainStepSucceededState, parseInputs, runMain, setEnvVariable } from './common.js';


async function execProcess(process: ChildProcess) {
    const exitCode: number = await new Promise((resolve, reject) => {
        process.on('close', resolve);
        process.on('error', reject);
    });
    if (exitCode != 0) {
        throw new Error(`Command exited with exit code ${exitCode}`);
    }
}

async function execCommand(command: string, args: string[], options?: SpawnOptions) {
    console.info('Executing command', command, 'with arguments', args);
    if (!options) {
        options = {};
    }
    if (!options.stdio) {
        options.stdio = 'inherit';
    }
    try {
        const child = spawn(command, args, options);
        await execProcess(child);
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Command '${command}' failed with error '${errorAsString(error)}'`);
    }
}

async function countBinaryPackages(): Promise<number> {
    core.startGroup('Counting packages in binary cache');
    let count = 0;
    await findBinaryPackagesInDir(getEnvVariable(ENV_VCPKG_BINARY_CACHE), (_dirPath, _fileName) => {
        ++count;
    });
    return count;
}

async function restoreCache(inputs: Inputs) {
    core.startGroup('Restore cache');

    let fromEnv = false;
    let cacheDir: string | undefined = inputs.binaryCachePath;
    if (cacheDir) {
        console.info('Using binary cache path from action inputs');
    } else {
        cacheDir = getEnvVariable(ENV_VCPKG_BINARY_CACHE, false);
        if (cacheDir) {
            console.info(`Using binary cache path from ${ENV_VCPKG_BINARY_CACHE} environment variable`);
            fromEnv = true;
        } else {
            console.info('Using default binary cache path');
            cacheDir = 'vcpkg_binary_cache';
        }
    }
    cacheDir = path.resolve(cacheDir);
    console.info('Vcpkg binary cache path is', cacheDir);
    if (!fromEnv) {
        setEnvVariable(ENV_VCPKG_BINARY_CACHE, cacheDir);
    }
    try {
        await fs.mkdir(cacheDir, { recursive: true });
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to create cache directory with error ${errorAsString(error)}`);
    }

    /**
     * Since there is no reliable way to know whether vcpkg will rebuild packages,
     * last part of key is GITHUB_RUN_ID so that exact matches never occur and cache is upload
     * only if vcpkg actually created new binary packages
     */
    const runnerOs = getEnvVariable('RUNNER_OS');
    let restoreKey = `vcpkg|RUNNER_OS=${runnerOs}`;
    if (inputs.cacheKeyTag) {
        restoreKey += `|tag=${inputs.cacheKeyTag}|`;
    } else {
        restoreKey += `|tag is not set|`;
    }
    console.info('Cache restore key is', restoreKey);
    const runId = getEnvVariable('GITHUB_RUN_ID');
    const key = `${restoreKey}GITHUB_RUN_ID=${runId}`;
    core.saveState(cacheKeyState, key);
    console.info('Cache key is', key);
    try {
        const hitKey = await cache.restoreCache([cacheDir], key, [restoreKey]);
        if (hitKey != null) {
            console.info('Cache hit on key', hitKey);
            const binaryPackagesCount = (await countBinaryPackages());
            core.saveState(binaryPackagesCountState, binaryPackagesCount.toString());
            console.info('Binary packages count is', binaryPackagesCount);
        } else {
            console.info('Cache miss');
            core.saveState(binaryPackagesCountState, '0');
        }
    } catch (error) {
        console.error(error);
        core.error(`Failed to restore cache with error ${errorAsString(error)}`);
    }

    core.endGroup();
}

function resolveVcpkgRoot(inputs: Inputs): string {
    core.startGroup('Determining vcpkg root directory');
    let vcpkgRoot: string | undefined = inputs.vcpkgRoot;
    if (vcpkgRoot) {
        console.info('Using vcpkg root directory path from action inputs');
    } else {
        vcpkgRoot = getEnvVariable(ENV_VCPKG_INSTALLATION_ROOT, false);
        if (vcpkgRoot) {
            console.info(`Using vcpkg root directory path from ${ENV_VCPKG_INSTALLATION_ROOT} environment variable`);
        } else {
            console.info('Using default vcpkg root directory path');
            vcpkgRoot = 'vcpkg';
        }
    }
    vcpkgRoot = path.resolve(vcpkgRoot);
    console.info('Vcpkg root directory path is', vcpkgRoot);
    setEnvVariable(ENV_VCPKG_ROOT, vcpkgRoot);
    core.endGroup();
    return vcpkgRoot;
}

async function extractVcpkgCommit(): Promise<string> {
    try {
        const vcpkgConfigurationData = await fs.readFile('vcpkg-configuration.json', { encoding: 'utf-8' });
        const commit = JSON.parse(vcpkgConfigurationData)['default-registry']['baseline'];
        if (typeof (commit) === 'string') {
            console.info('Vcpkg commit is', commit);
            return commit;
        }
        throw new Error('Failed to extract commit from parsed JSON');
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to extract vcpkg commit with error '${errorAsString(error)}'`);
    }
}

async function setupVcpkg(vcpkgRoot: string): Promise<string> {
    core.startGroup('Set up vcpkg');
    const commit = await extractVcpkgCommit();
    let checkoutExistingDirectory: boolean;
    try {
        const stats = await fs.stat(vcpkgRoot);
        checkoutExistingDirectory = stats.isDirectory();
    } catch (error) {
        checkoutExistingDirectory = false;
    }

    if (checkoutExistingDirectory) {
        await execCommand('git', ['-C', vcpkgRoot, 'fetch']);
        await execCommand('git', ['-C', vcpkgRoot, 'checkout', commit]);
    } else {
        await execCommand('git', ['clone', '--no-checkout', 'https://github.com/microsoft/vcpkg.git', vcpkgRoot]);
        await execCommand('git', ['-C', vcpkgRoot, 'checkout', commit]);
    }

    let bootstrapScript: string;
    let spawnOptions: SpawnOptions = {};
    if (os.platform() == 'win32') {
        bootstrapScript = 'bootstrap-vcpkg.bat';
        spawnOptions.shell = true;
    } else {
        bootstrapScript = 'bootstrap-vcpkg.sh';
    }
    await execCommand(path.join(vcpkgRoot, bootstrapScript), ['-disableMetrics'], spawnOptions);

    core.endGroup();

    return vcpkgRoot;
}

async function runVcpkgInstall(inputs: Inputs, vcpkgRoot: string) {
    core.startGroup('Run vcpkg install');
    let installRoot = inputs.installRoot;
    if (installRoot) {
        console.info('Using vcpkg root path from action inputs');
    } else {
        console.info('Using default vcpkg install root path');
        installRoot = 'vcpkg_installed';
    }
    installRoot = path.resolve(installRoot);
    console.info('Vcpkg install root path is', installRoot);
    const args = ['install', `--x-install-root=${installRoot}`, `--triplet=${inputs.triplet}`];
    if (inputs.hostTriplet) {
        args.push(`--host-triplet=${inputs.hostTriplet}`);
    }
    if (inputs.installCleanBuildtrees) {
        args.push('--clean-buildtrees-after-build');
    }
    if (inputs.installCleanPackages) {
        args.push('--clean-packages-after-build');
    }
    if (inputs.installCleanDownloads) {
        args.push('--clean-downloads-after-build');
    }
    for (const feature of inputs.installFeatures) {
        args.push(`--x-feature=${feature}`);
    }
    if (inputs.overlayTripletsPath) {
        args.push(`--overlay-triplets=${inputs.overlayTripletsPath}`);
    }
    await execCommand(path.join(vcpkgRoot, 'vcpkg'), args);
    core.endGroup();
}

async function main() {
    const inputs = parseInputs();
    await restoreCache(inputs);
    if (inputs.runSetup || inputs.runInstall) {
        const vcpkgRoot = resolveVcpkgRoot(inputs);
        if (inputs.runSetup) {
            await setupVcpkg(vcpkgRoot);
        }
        if (inputs.runInstall) {
            await runVcpkgInstall(inputs, vcpkgRoot);
        }
    }
    core.saveState(mainStepSucceededState, 'true');
}

await runMain(main);
