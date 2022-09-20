import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AbortActionError, cacheKeyState, computeHashOfBinaryPackage, ENV_VCPKG_BINARY_CACHE, ENV_VCPKG_ROOT, errorAsString, findBinaryPackages, getEnvVariable, Inputs, latestBinaryPackageHashState, mainStepSucceededState, parseInputs, runMain } from './common.js';


async function execProcess(process: ChildProcess) {
    const exitCode: number = await new Promise((resolve, reject) => {
        process.on('close', resolve);
        process.on('error', reject);
    });
    if (exitCode != 0) {
        throw new Error(`Command exited with exit code ${exitCode}`);
    }
}

async function execCommand(command: string, args: string[], shell?: boolean) {
    console.info('Executing command', command, 'with arguments', args);
    try {
        const child = spawn(command, args, { stdio: 'inherit', shell: shell ?? false });
        await execProcess(child);
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Command '${command}' failed with error '${errorAsString(error)}'`);
    }
}

async function extractVcpkgCommit(): Promise<string> {
    try {
        core.startGroup('Extract vcpkg commit');
        const vcpkgConfigurationData = await fs.readFile('vcpkg-configuration.json', { encoding: 'utf-8' });
        const commit = JSON.parse(vcpkgConfigurationData)['default-registry']['baseline'];
        if (typeof (commit) === 'string') {
            console.info('Vcpkg commit is', commit);
            core.endGroup();
            return commit;
        }
        throw new Error('Failed to extract commit from parsed JSON');
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to extract vcpkg commit with error '${errorAsString(error)}'`);
    }
}

async function setupVcpkg(commit: string, inputs: Inputs): Promise<string> {
    core.startGroup('Set up vcpkg');

    let fromEnv = false;
    let vcpkgRoot: string | undefined = inputs.vcpkgRoot;
    if (vcpkgRoot) {
        console.info('Using vcpkg root path from action inputs');
    } else {
        vcpkgRoot = getEnvVariable(ENV_VCPKG_ROOT, false);
        if (vcpkgRoot) {
            console.info(`Using vcpkg root path from ${ENV_VCPKG_ROOT} environment variable`);
            fromEnv = true;
        } else {
            console.info('Using default vcpkg root path');
            vcpkgRoot = 'vcpkg';
        }
    }
    vcpkgRoot = path.resolve(vcpkgRoot);
    console.info('Vcpkg root path is', vcpkgRoot);
    if (!fromEnv) {
        core.exportVariable(ENV_VCPKG_ROOT, vcpkgRoot);
    }

    let checkoutExistingDirectory: boolean
    try {
        const stats = await fs.stat(vcpkgRoot);
        checkoutExistingDirectory = stats.isDirectory()
    } catch (error) {
        checkoutExistingDirectory = false
    }

    if (checkoutExistingDirectory) {
        await execCommand('git', ['-C', vcpkgRoot, 'fetch']);
        await execCommand('git', ['-C', vcpkgRoot, 'checkout', commit]);
    } else {
        await execCommand('git', ['clone', '--no-checkout', 'https://github.com/microsoft/vcpkg.git', vcpkgRoot]);
        await execCommand('git', ['-C', vcpkgRoot, 'checkout', commit]);
    }

    let bootstrapScript: string;
    if (os.platform() == 'win32') {
        bootstrapScript = 'bootstrap-vcpkg.bat';
    } else {
        bootstrapScript = 'bootstrap-vcpkg.sh';
    }
    await execCommand(path.join(vcpkgRoot, bootstrapScript), ['-disableMetrics'], true);

    core.endGroup();

    return vcpkgRoot;
}

async function restoreCache() {
    core.startGroup('Restore cache');

    let fromEnv = false;
    let cacheDir = getEnvVariable(ENV_VCPKG_BINARY_CACHE, false);
    if (cacheDir) {
        console.info(`Using binary cache path from ${ENV_VCPKG_BINARY_CACHE} environment variable`);
        fromEnv = true;
    } else {
        console.info('Using default binary cache path');
        cacheDir = 'vcpkg_binary_cache';
    }
    cacheDir = path.resolve(cacheDir);
    console.info('Vcpkg binary cache path is', cacheDir);
    if (!fromEnv) {
        core.exportVariable(ENV_VCPKG_BINARY_CACHE, cacheDir);
    }
    try {
        await fs.mkdir(cacheDir, { recursive: true });
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to create cache directory with error ${errorAsString(error)}`);
    }
    console.info('Vcpkg binary cache directory is', cacheDir);

    const runnerOs = getEnvVariable('RUNNER_OS');
    /**
     * Since there is no reliable way to know whether vcpkg will rebuild packages,
     * last part of key is random so that exact matches never occur and cache is upload
     * only if vcpkg actually created new binary packages
     */
    const key = `vcpkg-${runnerOs}-${randomBytes(32).toString('hex')}`;
    core.saveState(cacheKeyState, key);
    console.info('Cache key is', key);
    const restoreKeys = [`vcpkg-${runnerOs}-`];
    console.info('Cache restore keys are', restoreKeys);
    try {
        const hitKey = await cache.restoreCache([cacheDir], key, restoreKeys);
        if (hitKey != null) {
            console.info('Cache hit on key', hitKey);
            const latestBinaryPackage = (await findBinaryPackages()).at(0);
            if (latestBinaryPackage != null) {
                console.info('Latest binary package is', latestBinaryPackage);
                const hash = computeHashOfBinaryPackage(latestBinaryPackage);
                console.info('Hash of latest binary package is', hash);
                core.saveState(latestBinaryPackageHashState, hash);
            } else {
                console.info('No binary packages');
            }
        } else {
            console.info('Cache miss');
        }
    } catch (error) {
        console.error(error);
        core.error(`Failed to restore cache with error ${errorAsString(error)}`);
    }

    core.endGroup();
}

async function runVcpkgInstall(inputs: Inputs, vcpkgRoot: string) {
    if (!inputs.runInstall) {
        return;
    }
    core.startGroup('Run vcpkg install');
    const args = ['install', `--triplet=${inputs.triplet}`, `--host-triplet=${inputs.triplet}`]
    if (inputs.installCleanBuildtrees) {
        args.push('--clean-buildtrees-after-build')
    }
    if (inputs.installCleanPackages) {
        args.push('--clean-packages-after-build')
    }
    if (inputs.installCleanDownloads) {
        args.push('--clean-downloads-after-build')
    }
    for (const feature of inputs.installFeatures) {
        args.push(`--x-feature=${feature}`)
    }
    await execCommand(path.join(vcpkgRoot, 'vcpkg'), args);
    core.endGroup();
}

async function main() {
    const inputs = parseInputs();
    const vcpkgRoot = await setupVcpkg(await extractVcpkgCommit(), inputs);
    await restoreCache();
    await runVcpkgInstall(inputs, vcpkgRoot);
    core.saveState(mainStepSucceededState, 'true');
}

await runMain(main);
