import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Ajv } from 'ajv';
import formatsPlugin from 'ajv-formats';
import { AbortActionError, ENV_VCPKG_BINARY_CACHE, ENV_VCPKG_INSTALLATION_ROOT, ENV_VCPKG_ROOT, Inputs, binaryPackagesCountState, cacheKeyState, errorAsString, findBinaryPackagesInDir, getEnvVariable, mainStepSucceededState, parseInputs, runMain, setEnvVariable } from './common.js';
import { VCPKG_CONFIGURATION_JSON_SCHEMA, VCPKG_JSON_SCHEMA, VCPKG_SCHEMA_DEFINITIONS } from './schemas.js';


const DEFAULT_VCPKG_URL = 'https://github.com/microsoft/vcpkg.git';

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

type VcpkgRepositoryInfo = {
    url: string;
    commit: string;
};

async function extractVcpkgRepositoryInfo(): Promise<VcpkgRepositoryInfo> {
    try {
        let url: string | undefined;
        let commit: string | undefined;
        const ajv = new Ajv();
        formatsPlugin.default(ajv);
        ajv.addSchema(VCPKG_SCHEMA_DEFINITIONS);
        try {
            const vcpkgConfigurationJsonData = await fs.readFile('vcpkg-configuration.json', { encoding: 'utf-8' });
            const vcpkgConfigurationJson = JSON.parse(vcpkgConfigurationJsonData);
            const vcpkgConfigurationJsonValidator = ajv.compile<any>(VCPKG_CONFIGURATION_JSON_SCHEMA);
            if (!vcpkgConfigurationJsonValidator(vcpkgConfigurationJson)) {
                console.error('Failed to validate vcpkg-configuration.json:', vcpkgConfigurationJsonValidator.errors);
                throw Error('Failed to validate vcpkg-configuration.json');
            }
            const defaultRegistry = vcpkgConfigurationJson['default-registry'];
            if (typeof (defaultRegistry) === 'undefined') {
                throw Error('vcpkg-configuration.json does not contain "default-registry" field');
            }
            const kind = defaultRegistry['kind'];
            switch (kind) {
                case 'builtin':
                    url = DEFAULT_VCPKG_URL;
                    break;
                case 'git':
                    url = defaultRegistry['repository'];
                    break;
                default:
                    throw Error(`Registry kind '${kind}' is not supported`);
            }
            commit = defaultRegistry['baseline'];
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                const vcpkgJsonData = await fs.readFile('vcpkg.json', { encoding: 'utf-8' });
                const vcpkgJson = JSON.parse(vcpkgJsonData);
                const vcpkgJsonValidator = ajv.compile<any>(VCPKG_JSON_SCHEMA);
                if (!vcpkgJsonValidator(vcpkgJson)) {
                    console.error('Failed to validate vcpkg.json:', vcpkgJsonValidator.errors);
                    throw Error('Failed to validate vcpkg.json');
                }
                commit = vcpkgJson['builtin-baseline'];
                if (typeof (commit) === 'undefined') {
                    throw Error('vcpkg.json does not contain "builtin-baseline" field');
                }
                url = DEFAULT_VCPKG_URL;
            } else {
                throw error;
            }
        }
        if (typeof (url) !== 'string') {
            throw Error('Repository URL is unknown');
        }
        if (typeof (commit) !== 'string') {
            throw Error('Repository commit is unknown');
        }
        return { url: url, commit: commit };
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to extract vcpkg repository info with error '${errorAsString(error)}'`);
    }
}

async function setupVcpkg(vcpkgRoot: string): Promise<string> {
    core.startGroup('Set up vcpkg');
    const repositoryInfo = await extractVcpkgRepositoryInfo();
    let checkoutExistingDirectory: boolean;
    try {
        const stats = await fs.stat(vcpkgRoot);
        checkoutExistingDirectory = stats.isDirectory();
    } catch (error) {
        checkoutExistingDirectory = false;
    }

    if (checkoutExistingDirectory) {
        const remoteName = 'action-setup-vcpkg';
        await execCommand('git', ['-C', vcpkgRoot, 'remote', 'add', remoteName, repositoryInfo.url]);
        await execCommand('git', ['-C', vcpkgRoot, 'fetch', remoteName]);
        await execCommand('git', ['-C', vcpkgRoot, 'checkout', repositoryInfo.commit]);
    } else {
        await execCommand('git', ['clone', '--no-checkout', repositoryInfo.url, vcpkgRoot]);
        await execCommand('git', ['-C', vcpkgRoot, 'checkout', repositoryInfo.commit]);
    }

    let bootstrapScript: string;
    let shell: boolean;
    if (os.platform() == 'win32') {
        bootstrapScript = 'bootstrap-vcpkg.bat';
        shell = true;
    } else {
        bootstrapScript = 'bootstrap-vcpkg.sh';
        shell = false;
    }
    await execCommand(path.join(vcpkgRoot, bootstrapScript), ['-disableMetrics'], shell);

    core.endGroup();

    return vcpkgRoot;
}

async function main() {
    const inputs = parseInputs();
    await restoreCache(inputs);
    if (inputs.runSetup) {
        const vcpkgRoot = resolveVcpkgRoot(inputs);
        if (inputs.runSetup) {
            await setupVcpkg(vcpkgRoot);
        }
    }
    core.saveState(mainStepSucceededState, 'true');
}

await runMain(main);
