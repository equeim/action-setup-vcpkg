import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { AbortActionError, mainStepSucceededState, cacheKeyState, errorAsString, getEnvVariable, runMain } from './common';

type Inputs = {
    runInstall: boolean;
    triplet: string;
    installFeatures: string[];
};

function parseInputs(): Inputs {
    const runInstall = core.getInput('run-install', { required: false });
    console.info('Inputs: run-install is', runInstall);
    const triplet = core.getInput('triplet', { required: false });
    console.info('Inputs: triplet is', triplet);
    const installFeatures = core.getInput('install-features', { required: false });
    console.info('Inputs: install-features is', installFeatures);
    const inputs = {
        runInstall: runInstall === 'true',
        triplet: triplet,
        installFeatures: installFeatures.split(/\s+/).filter(Boolean),
    };
    if (inputs.runInstall && !triplet) {
        throw new AbortActionError('Triplet must be defined');
    }
    return inputs;
}

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

async function setupVcpkg(commit: string) {
    core.startGroup('Set up vcpkg');
    await execCommand('git', ['clone', '--no-checkout', 'https://github.com/microsoft/vcpkg.git']);
    core.exportVariable('VCPKG_ROOT', path.join(process.cwd(), 'vcpkg'));
    await execCommand('git', ['-C', 'vcpkg', 'checkout', commit]);
    if (os.platform() == 'win32') {
        await execCommand('.\\vcpkg\\bootstrap-vcpkg.bat', ['-disableMetrics'], true);
    } else {
        await execCommand('./vcpkg/bootstrap-vcpkg.sh', ['-disableMetrics'], true);
    }
    core.endGroup();
}

async function restoreCache() {
    core.startGroup('Restore cache');

    const cacheDir = path.join(process.cwd(), 'vcpkg_binary_cache');
    try {
        await fs.mkdir(cacheDir, { recursive: true });
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to create cache directory with error ${errorAsString(error)}`);
    }
    core.exportVariable('VCPKG_DEFAULT_BINARY_CACHE', cacheDir);
    console.info('Vcpkg binary cache directory is', cacheDir);

    const runnerOs = getEnvVariable('RUNNER_OS');
    const baseRefName = getEnvVariable('GITHUB_BASE_REF', false);
    const refName = baseRefName ?? getEnvVariable('GITHUB_REF_NAME');
    /**
     * Since there is no reliable way to know whether vcpkg will rebuild packages,
     * last part of key is random so that exact matches never occur and cache is always uploaded
     */
    const randomString = Buffer.from(Math.random().toString()).toString('base64');
    const key = `vcpkg-${runnerOs}-${refName}-${randomString}`;
    core.saveState(cacheKeyState, key);
    console.info('Cache key is', key);
    const restoreKeys = [`vcpkg-${runnerOs}-${refName}-`, `vcpkg-${runnerOs}-`];
    console.info('Cache restore keys are', restoreKeys);
    try {
        const hitKey = await cache.restoreCache([cacheDir], key, restoreKeys);
        if (hitKey != null) {
            console.info(`Cache hit on key ${hitKey}`);
        } else {
            console.info('Cache miss');
        }
    } catch (error) {
        console.error(error);
        core.error(`Failed to restore cache with error ${errorAsString(error)}`);
    }

    core.endGroup();
}

async function runVcpkgInstall(inputs: Inputs) {
    if (!inputs.runInstall) {
        return;
    }
    core.startGroup('Run vcpkg install');
    const args = ['install', '--clean-after-build', `--triplet=${inputs.triplet}`, `--host-triplet=${inputs.triplet}`]
    for (const feature of inputs.installFeatures) {
        args.push(`--x-feature=${feature}`)
    }
    await execCommand(path.join(process.cwd(), 'vcpkg', 'vcpkg'), args);
    core.endGroup();
}

async function main() {
    const inputs = parseInputs();
    await setupVcpkg(await extractVcpkgCommit());
    await restoreCache();
    await runVcpkgInstall(inputs);
    core.saveState(mainStepSucceededState, 'true');
}

runMain(main);
