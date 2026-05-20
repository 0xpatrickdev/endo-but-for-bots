// @ts-check
/* global Buffer, process */

import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';
import { makeNodeReader, makeNodeWriter } from '@endo/stream-node';
import { makeNetstringCapTP } from './connection.js';
import { makePetStoreMaker } from './pet-store.js';
import { servePrivatePath } from './serve-private-path.js';
import { makeSerialJobs } from './serial-jobs.js';
import { makeDaemonDatabase } from './daemon-database-node.js';
// The shared SQLite-backed persistence powers live in
// ./daemon-persistence-powers.js so the XS-on-Rust supervisor can
// use them without importing the Node-only graph above.
import { makeDaemonicPersistencePowers } from './daemon-persistence-powers.js';

export { makeDaemonicPersistencePowers };

/** @import { Reader, Writer } from '@endo/stream' */
/** @import { ERef, FarRef } from '@endo/eventual-send' */
/** @import { CapTpConnectionRegistrar, Config, CryptoPowers, DaemonWorkerFacet, DaemonicPersistencePowers, DaemonicPowers, EndoReadable, FilePowers, Formula, FormulaNumber, GitPowers, NetworkPowers, SocketPowers, WorkerDaemonFacet } from './types.js' */
/** @import { DaemonDatabase } from './daemon-database.js' */

/**
 * @param {object} modules
 * @param {typeof import('net')} modules.net
 * @param {Pick<typeof import('fs/promises'), 'access'>} modules.fsp
 * @returns {SocketPowers}
 */
export const makeSocketPowers = ({ net, fsp: { access } }) => {
  const serveListener = async (listen, cancelled) => {
    const [
      /** @type {Reader<Connection>} */ readFrom,
      /** @type {Writer<Connection} */ writeTo,
    ] = makePipe();

    const server = net.createServer();
    const { promise: erred, reject: err } = makePromiseKit();
    server.on('error', error => {
      err(error);
      void writeTo.throw(error);
    });
    server.on('close', () => {
      void writeTo.return(undefined);
    });

    cancelled.catch(error => {
      server.close();
      void writeTo.throw(error);
    });

    const listening = listen(server);

    await Promise.race([erred, cancelled, listening]);

    server.on('connection', conn => {
      const reader = makeNodeReader(conn);
      const writer = makeNodeWriter(conn);
      const closed = new Promise(resolve => conn.on('close', resolve));
      // TODO Respect back-pressure signal and avoid accepting new connections.
      void writeTo.next({ reader, writer, closed });
    });

    const port = await listening;

    return harden({
      port,
      connections: readFrom,
    });
  };

  /** @type {SocketPowers['servePort']} */
  const servePort = async ({ port, host = '0.0.0.0', cancelled }) =>
    serveListener(
      server =>
        new Promise(resolve =>
          server.listen(port, host, () => resolve(server.address().port)),
        ),
      cancelled,
    );

  /** @type {SocketPowers['connectPort']} */
  const connectPort = ({ port, host, cancelled }) =>
    new Promise((resolve, reject) => {
      const conn = net.connect(port, host);
      conn.on('connect', () => {
        const reader = makeNodeReader(conn);
        const writer = makeNodeWriter(conn);
        const closed = new Promise(close => conn.on('close', close));
        resolve({
          reader,
          writer,
          closed,
        });
      });
      conn.on('error', reject);
      cancelled.catch(error => {
        conn.destroy();
        reject(error);
      });
    });

  /** @type {SocketPowers['servePath']} */
  const servePath = async ({ path, cancelled }) => {
    const { connections } = await serveListener(server => {
      return new Promise((resolve, reject) =>
        server.listen({ path }, async error => {
          await null;
          // In some environments, an overly-long Unix domain socket path
          // (`sockaddr_un` `sun_path`) is silently truncated. This exposes the
          // problem, but we may still leak the incorrectly-named file and
          // thereby cause EADDRINUSE errors for future attempts to start.
          error ||= await access(path).catch(err => err);
          if (error) {
            if (path.length >= 104) {
              console.warn(
                `Warning: Length of path for domain socket or named path exceeeds common maximum (104, possibly 108) for some platforms (length: ${path.length}, path: ${path})`,
              );
            }
            try {
              server.close(_serverNotRunningErr => reject(error));
            } catch (_serverCloseErr) {
              reject(error);
            }
          } else {
            resolve(undefined);
          }
        }),
      );
    }, cancelled);
    return connections;
  };

  return { servePort, servePath, connectPort };
};

/**
 * @param {object} modules
 * @param {typeof import('net')} modules.net
 * @param {Pick<typeof import('fs/promises'), 'access'>} modules.fsp
 * @returns {NetworkPowers}
 */
export const makeNetworkPowers = ({ net, fsp }) => {
  const { servePort, servePath, connectPort } = makeSocketPowers({ net, fsp });

  const connectionNumbers = (function* generateNumbers() {
    let n = 0;
    for (;;) {
      yield n;
      n += 1;
    }
  })();

  /**
   * @param {FarRef<unknown>} endoBootstrap
   * @param {string} sockPath
   * @param {Promise<never>} cancelled
   * @param {(error: Error) => void} exitWithError
   * @param {CapTpConnectionRegistrar} [capTpConnectionRegistrar]
   * @returns {{ started: Promise<void>, stopped: Promise<void> }}
   */
  const makePrivatePathService = (
    endoBootstrap,
    sockPath,
    cancelled,
    exitWithError,
    capTpConnectionRegistrar = undefined,
  ) => {
    const privatePathService = servePrivatePath(sockPath, endoBootstrap, {
      servePath,
      connectionNumbers,
      cancelled,
      exitWithError,
      capTpConnectionRegistrar,
    });
    return privatePathService;
  };

  return harden({
    servePort,
    servePath,
    connectPort,
    makePrivatePathService,
  });
};

export const makeFilePowers = ({ fs, path: fspath }) => {
  const writeJobs = makeSerialJobs();

  /**
   * @param {string} path
   */
  const makeFileReader = path => {
    const nodeReadStream = fs.createReadStream(path);
    return makeNodeReader(nodeReadStream);
  };

  /**
   * @param {string} path
   * @returns {Writer<Uint8Array>}
   */
  const makeFileWriter = path => {
    const nodeWriteStream = fs.createWriteStream(path);
    return makeNodeWriter(nodeWriteStream);
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const writeFileText = async (path, text) => {
    await writeJobs.enqueue(async () => {
      await fs.promises.writeFile(path, text);
    });
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const appendFileText = async (path, text) => {
    await writeJobs.enqueue(async () => {
      await fs.promises.appendFile(path, text);
    });
  };

  /**
   * @param {string} path
   */
  const readFileText = async path => {
    return fs.promises.readFile(path, 'utf-8');
  };

  /**
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  const readFileBytes = async path => {
    const buf = await fs.promises.readFile(path);
    // Return as a plain Uint8Array (Buffer is a subclass) so the
    // shape is portable across XS / Node and easy to harden.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };

  /**
   * Binary-safe whole-file read.  Returns the file contents as a
   * `Uint8Array` (Node's `Buffer` is a `Uint8Array` subclass, so the
   * value is interoperable with both runtimes).
   *
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  const readFile = async path => fs.promises.readFile(path);

  /**
   * Binary-safe whole-file read that returns `undefined` when the
   * file does not exist (ENOENT) or the path is a directory (EISDIR).
   * Other I/O errors propagate.
   *
   * @param {string} path
   * @returns {Promise<Uint8Array | undefined>}
   */
  const maybeReadFile = async path =>
    readFile(path).catch(error => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT' || code === 'EISDIR') {
        return undefined;
      }
      throw error;
    });

  /**
   * @param {string} path
   */
  const maybeReadFileText = async path =>
    readFileText(path).catch(error => {
      if (
        error.message.startsWith('ENOENT: ') ||
        error.message.startsWith('EISDIR: ')
      ) {
        return undefined;
      }
      throw error;
    });

  /**
   * @param {string} path
   */
  const readDirectory = async path => {
    return fs.promises.readdir(path);
  };

  /**
   * @param {string} path
   */
  const makePath = async path => {
    await fs.promises.mkdir(path, { recursive: true });
  };

  /**
   * @param {string} path
   */
  const removePath = async path => {
    await writeJobs.enqueue(async () => {
      // Use force: true to make removal idempotent (no error if already removed)
      return fs.promises.rm(path, { force: true });
    });
  };

  /**
   * Recursively remove a directory and its contents.  Idempotent:
   * removing a missing directory is not an error.
   *
   * @param {string} path
   */
  const removeDirectory = async path => {
    await writeJobs.enqueue(async () => {
      return fs.promises.rm(path, { force: true, recursive: true });
    });
  };

  const renamePath = async (source, target) => {
    await writeJobs.enqueue(async () => {
      return fs.promises.rename(source, target);
    });
  };

  const joinPath = (...components) => fspath.join(...components);

  /** @param {string} path */
  const realPath = async path => fs.promises.realpath(path);

  /** @param {string} path */
  const pathIdentity = async path => {
    const stat = await fs.promises.stat(path);
    return `${stat.dev}:${stat.ino}`;
  };

  /** @param {string} path */
  const isDirectory = async path => {
    try {
      const stat = await fs.promises.stat(path);
      return stat.isDirectory();
    } catch {
      return false;
    }
  };

  /** @param {string} path */
  const statPath = async path => {
    const stat = await fs.promises.lstat(path);
    const kind = /** @type {'directory' | 'file' | 'symlink'} */ (
      stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'file'
    );
    return harden({
      kind,
      sizeBytes: stat.size,
      modifiedMs: stat.mtimeMs,
    });
  };

  /** @param {string} path */
  const exists = async path => {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  };

  return harden({
    makeFileReader,
    makeFileWriter,
    writeFileText,
    appendFileText,
    readFileText,
    readFileBytes,
    readFile,
    maybeReadFile,
    maybeReadFileText,
    readDirectory,
    makePath,
    joinPath,
    removePath,
    removeDirectory,
    renamePath,
    realPath,
    pathIdentity,
    statPath,
    isDirectory,
    exists,
  });
};

const gitNullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 30;
const GIT_BASE_ARGS = harden([
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'credential.helper=',
  '-c',
  'core.sshCommand=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
]);
const EXECUTABLE_REPO_CONFIG =
  /^(filter\..*\.(clean|smudge|process)|merge\..*\.driver)$/u;

/**
 * @param {string} value
 */
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
harden(shellQuote);

const GIT_CREDENTIAL_HELPER_SOURCE = `\
const fs = require('fs');

const secretPath = process.argv[2];
const operation = process.argv[3];
if (operation !== 'get') {
  process.exit(0);
}
const state = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
if (state.revoked) {
  process.exit(1);
}
if (state.kind === 'bearer') {
  process.stdout.write('username=' + (state.username || 'x-access-token') + '\\n');
  process.stdout.write('password=' + state.token + '\\n\\n');
} else if (state.kind === 'basic') {
  process.stdout.write('username=' + state.username + '\\n');
  process.stdout.write('password=' + state.password + '\\n\\n');
} else {
  process.exit(1);
}
`;

/**
 * @param {object} opts
 * @param {typeof import('child_process')} opts.popen
 * @param {FilePowers} opts.filePowers
 * @returns {GitPowers}
 */
export const makeGitPowers = ({ popen, filePowers }) => {
  /**
   * @param {string} repoRoot
   */
  const makeGitEnv = repoRoot =>
    harden({
      PATH: process.env.PATH || '',
      HOME: filePowers.joinPath(repoRoot, '.git-endo-home'),
      XDG_CONFIG_HOME: filePowers.joinPath(repoRoot, '.git-endo-home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitNullDevice,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_ASKPASS: 'false',
      SSH_ASKPASS: 'false',
      GIT_SSH_COMMAND: 'false',
      TMPDIR: process.env.TMPDIR || '/tmp',
      LANG: 'C',
      LC_ALL: 'C',
    });

  /**
   * @param {string} file
   * @param {string[]} args
   * @param {{ cancelled?: Promise<unknown>, [option: string]: unknown }} options
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  const execFileText = (file, args, options) =>
    new Promise((resolve, reject) => {
      const { cancelled, ...execOptions } = options;
      let settled = false;
      const child = popen.execFile(
        file,
        args,
        /** @type {any} */ (execOptions),
        (error, stdout, stderr) => {
          settled = true;
          const stdoutText = /** @type {string} */ (
            /** @type {unknown} */ (stdout)
          );
          const stderrText = /** @type {string} */ (
            /** @type {unknown} */ (stderr)
          );
          if (error) {
            Object.assign(error, { stdout: stdoutText, stderr: stderrText });
            reject(error);
          } else {
            resolve({ stdout: stdoutText, stderr: stderrText });
          }
        },
      );
      if (cancelled !== undefined) {
        void cancelled.then(
          () => {
            if (!settled) {
              child.kill();
            }
          },
          () => {
            if (!settled) {
              child.kill();
            }
          },
        );
      }
    });

  /**
   * @param {string} file
   * @param {string[]} args
   * @param {object} options
   * @returns {Promise<{ stdout: Uint8Array, stderr: string }>}
   */
  const execFileBytes = (file, args, options) =>
    new Promise((resolve, reject) => {
      popen.execFile(
        file,
        args,
        /** @type {any} */ ({ ...options, encoding: 'buffer' }),
        (error, stdout, stderr) => {
          const stdoutBytes = new Uint8Array(/** @type {Buffer} */ (stdout));
          const stderrText = /** @type {Buffer} */ (stderr).toString('utf-8');
          if (error) {
            Object.assign(error, { stdout: stdoutBytes, stderr: stderrText });
            reject(error);
          } else {
            resolve({ stdout: stdoutBytes, stderr: stderrText });
          }
        },
      );
    });

  /** @type {Promise<string> | undefined} */
  let gitVersionPromise;

  const verifyGitVersion = async () => {
    if (gitVersionPromise === undefined) {
      gitVersionPromise = execFileText('git', ['--version'], {
        env: makeGitEnv(process.cwd()),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      }).then(({ stdout }) => {
        const versionText = stdout.trim();
        const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/u.exec(
          versionText,
        );
        if (match === null) {
          throw new Error(`Unable to parse native git version: ${versionText}`);
        }
        const major = Number(match[1]);
        const minor = Number(match[2]);
        if (
          major < MIN_GIT_MAJOR ||
          (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)
        ) {
          throw new Error(
            `Native git >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} is required, got ${versionText}`,
          );
        }
        return versionText;
      });
    }
    return gitVersionPromise;
  };

  /**
   * @param {string} repoRoot
   * @param {string[]} args
   * @param {import('./types.js').GitRunOptions} [options]
   */
  const runGit = async (repoRoot, args, options = {}) => {
    await verifyGitVersion();
    return execFileText('git', [...GIT_BASE_ARGS, ...args], {
      cwd: repoRoot,
      env: makeGitEnv(repoRoot),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      cancelled: options.cancelled,
    });
  };

  /**
   * @param {string} repoRoot
   */
  const ensureCredentialHelper = async repoRoot => {
    const helperDir = filePowers.joinPath(repoRoot, '.git-endo-home');
    await filePowers.makePath(helperDir);
    const helperPath = filePowers.joinPath(
      helperDir,
      'git-credential-helper.cjs',
    );
    await filePowers.writeFileText(helperPath, GIT_CREDENTIAL_HELPER_SOURCE);
    return helperPath;
  };

  /**
   * @param {string} repoRoot
   * @param {string[]} args
   * @param {import('./types.js').GitCredentialUse} credential
   * @param {import('./types.js').GitRunOptions} [options]
   */
  const runGitCredentialed = async (
    repoRoot,
    args,
    credential,
    options = {},
  ) => {
    await verifyGitVersion();
    const helperPath = await ensureCredentialHelper(repoRoot);
    const helperCommand = `!${shellQuote(process.execPath)} ${shellQuote(
      helperPath,
    )} ${shellQuote(credential.secretPath)}`;
    return execFileText(
      'git',
      [...GIT_BASE_ARGS, '-c', `credential.helper=${helperCommand}`, ...args],
      {
        cwd: repoRoot,
        env: makeGitEnv(repoRoot),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        cancelled: options.cancelled,
      },
    );
  };

  /**
   * @param {string} repoRoot
   * @param {string[]} args
   */
  const runGitBytes = async (repoRoot, args) => {
    await verifyGitVersion();
    return execFileBytes('git', [...GIT_BASE_ARGS, ...args], {
      cwd: repoRoot,
      env: makeGitEnv(repoRoot),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  };

  /**
   * @param {string} repoRoot
   * @param {string[]} args
   * @returns {Promise<Reader<Uint8Array>>}
   */
  const runGitReader = async (repoRoot, args) => {
    await verifyGitVersion();
    const child = popen.spawn('git', [...GIT_BASE_ARGS, ...args], {
      cwd: repoRoot,
      env: makeGitEnv(repoRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert(child.stdout);
    assert(child.stderr);

    /** @type {Buffer[]} */
    const stderrChunks = [];
    child.stderr.on('data', chunk => {
      stderrChunks.push(/** @type {Buffer} */ (chunk));
    });

    /** @type {Promise<void>} */
    const closed = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        if (code === 0) {
          resolve();
        } else {
          const error = Error(
            `git ${args[0]} failed (exit ${code ?? 'unknown'}):\n${stderr.trim()}`,
          );
          Object.assign(error, { stderr, code });
          reject(error);
        }
      });
    });

    const stdoutReader = makeNodeReader(child.stdout);
    /** @type {Reader<Uint8Array>} */
    const reader = harden({
      async next() {
        const result = await stdoutReader.next();
        if (result.done) {
          await closed;
        }
        return result;
      },
      async return() {
        child.kill();
        await stdoutReader.return(undefined);
        return harden({ done: true, value: undefined });
      },
      async throw(error) {
        child.kill();
        await stdoutReader.throw(error);
        throw error;
      },
      [Symbol.asyncIterator]() {
        return reader;
      },
    });
    return reader;
  };

  const getRepositoryRoot = async configuredRoot => {
    await verifyGitVersion();
    const resolvedRoot = await filePowers.realPath(configuredRoot);
    const { stdout } = await execFileText(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: resolvedRoot,
        env: makeGitEnv(resolvedRoot),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    const actualRoot = await filePowers.realPath(stdout.trim());
    if (actualRoot !== resolvedRoot) {
      throw new Error(
        `Git root must be the mount root: expected ${resolvedRoot}, got ${actualRoot}`,
      );
    }
    return actualRoot;
  };

  const absolutizeGitPath = (repoRoot, candidatePath) => {
    if (
      candidatePath.startsWith('/') ||
      /^[a-zA-Z]:[\\/]/u.test(candidatePath)
    ) {
      return candidatePath;
    }
    return filePowers.joinPath(repoRoot, candidatePath);
  };

  const getRepositoryIdentity = async repoRoot => {
    await verifyGitVersion();
    const { stdout: gitDirText } = await execFileText(
      'git',
      [...GIT_BASE_ARGS, 'rev-parse', '--absolute-git-dir'],
      {
        cwd: repoRoot,
        env: makeGitEnv(repoRoot),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    const { stdout: commonDirText } = await execFileText(
      'git',
      [...GIT_BASE_ARGS, 'rev-parse', '--git-common-dir'],
      {
        cwd: repoRoot,
        env: makeGitEnv(repoRoot),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    const gitDir = await filePowers.realPath(
      absolutizeGitPath(repoRoot, gitDirText.trim()),
    );
    const commonDir = await filePowers.realPath(
      absolutizeGitPath(repoRoot, commonDirText.trim()),
    );
    return harden({
      gitDir,
      commonDir,
      gitDirIdentity: await filePowers.pathIdentity(gitDir),
      commonDirIdentity: await filePowers.pathIdentity(commonDir),
    });
  };

  const assertNoExecutableRepoConfig = async repoRoot => {
    const { stdout } = await runGit(repoRoot, [
      'config',
      '--local',
      '--name-only',
      '--list',
    ]);
    const executableConfig = stdout
      .split('\n')
      .filter(name => EXECUTABLE_REPO_CONFIG.test(name));
    if (executableConfig.length > 0) {
      throw new Error(
        `Refusing git operation because repository config can execute commands: ${executableConfig.join(', ')}`,
      );
    }
  };

  const checkRefFormat = async (repoRoot, branchName) => {
    await verifyGitVersion();
    await runGit(repoRoot, ['check-ref-format', '--branch', branchName]);
  };

  return harden({
    runGit,
    runGitBytes,
    runGitReader,
    runGitCredentialed,
    getRepositoryRoot,
    getRepositoryIdentity,
    assertNoExecutableRepoConfig,
    checkRefFormat,
  });
};
harden(makeGitPowers);

/**
 * @param {typeof import('crypto')} crypto
 * @returns {CryptoPowers}
 */
export const makeCryptoPowers = crypto => {
  const makeSha256 = () => {
    const digester = crypto.createHash('sha256');
    return harden({
      update: chunk => digester.update(chunk),
      updateText: chunk => digester.update(bytesFromText(chunk)),
      digestHex: () => encodeHex(digester.digest()),
    });
  };

  const randomHex256 = () =>
    new Promise((resolve, reject) =>
      crypto.randomBytes(32, (err, bytes) => {
        if (err) {
          reject(err);
        } else {
          resolve(encodeHex(bytes));
        }
      }),
    );

  // PKCS8 DER prefix for wrapping a raw 32-byte Ed25519 private key seed.
  const ED25519_PKCS8_PREFIX = Buffer.from(
    '302e020100300506032b657004220420',
    'hex',
  );

  /**
   * Sign a message with a raw 32-byte Ed25519 private key.
   *
   * @param {Uint8Array} privateKey - 32-byte raw Ed25519 private key seed
   * @param {Uint8Array} message - message bytes to sign
   * @returns {Uint8Array} 64-byte Ed25519 signature
   */
  const ed25519Sign = (privateKey, message) => {
    const derKey = Buffer.concat([ED25519_PKCS8_PREFIX, privateKey]);
    const keyObject = crypto.createPrivateKey({
      key: derKey,
      format: 'der',
      type: 'pkcs8',
    });
    const sig = crypto.sign(null, message, keyObject);
    return new Uint8Array(sig);
  };

  const generateEd25519Keypair = () =>
    new Promise((resolve, reject) =>
      crypto.generateKeyPair(
        'ed25519',
        {},
        (err, publicKeyObject, privateKeyObject) => {
          if (err) {
            reject(err);
          } else {
            const publicDer = publicKeyObject.export({
              type: 'spki',
              format: 'der',
            });
            const privateDer = privateKeyObject.export({
              type: 'pkcs8',
              format: 'der',
            });
            // Extract raw 32-byte keys from DER encoding.
            // Ed25519 SPKI DER has a 12-byte prefix before the 32-byte key.
            // Ed25519 PKCS8 DER has a 16-byte prefix before the 32-byte seed.
            const rawPublicKey = publicDer.subarray(publicDer.length - 32);
            const rawPrivateKey = privateDer.subarray(privateDer.length - 32);
            const publicKey = new Uint8Array(rawPublicKey);
            const privateKey = new Uint8Array(rawPrivateKey);
            resolve(
              harden({
                publicKey,
                privateKey,
                sign: message => ed25519Sign(privateKey, message),
              }),
            );
          }
        },
      ),
    );

  return harden({
    makeSha256,
    randomHex256,
    generateEd25519Keypair,
    ed25519Sign,
  });
};

/**
 * @param {Config} config
 * @param {import('url').fileURLToPath} fileURLToPath
 * @param {FilePowers} filePowers
 * @param {typeof import('fs')} fs
 * @param {typeof import('child_process')} popen
 */
export const makeDaemonicControlPowers = (
  config,
  fileURLToPath,
  filePowers,
  fs,
  popen,
) => {
  const endoWorkerPath =
    process.env.ENDO_WORKER_SUBPROCESS_PATH ||
    fileURLToPath(new URL('worker-node.js', import.meta.url));

  const endoWorkerWithShimsPath = fileURLToPath(
    new URL('worker-node-with-shims.js', import.meta.url),
  );

  /**
   * @param {string} workerId
   * @param {DaemonWorkerFacet} daemonWorkerFacet
   * @param {Promise<never>} cancelled - rejects to initiate shutdown (SIGTERM)
   * @param {Promise<never>} forceCancelled - rejects to force shutdown (SIGKILL)
   * @param {CapTpConnectionRegistrar} [capTpConnectionRegistrar]
   * @param {string[]} [trustedShims]
   * @param {string} [label]
   */
  const makeWorker = async (
    workerId,
    daemonWorkerFacet,
    cancelled,
    forceCancelled,
    capTpConnectionRegistrar = undefined,
    trustedShims = undefined,
    label = '<untitled>',
  ) => {
    const { statePath, ephemeralStatePath } = config;

    const workerStatePath = filePowers.joinPath(statePath, 'worker', workerId);
    const workerEphemeralStatePath = filePowers.joinPath(
      ephemeralStatePath,
      'worker',
      workerId,
    );

    await Promise.all([
      filePowers.makePath(workerStatePath),
      filePowers.makePath(workerEphemeralStatePath),
    ]);

    const logPath = filePowers.joinPath(workerStatePath, 'worker.log');
    const pidPath = filePowers.joinPath(workerEphemeralStatePath, 'worker.pid');

    const useShims = trustedShims && trustedShims.length > 0;
    const workerPath = useShims ? endoWorkerWithShimsPath : endoWorkerPath;
    const workerArgs = useShims ? [JSON.stringify(trustedShims)] : [];

    const log = fs.openSync(logPath, 'a');
    const child = popen.fork(workerPath, workerArgs, {
      stdio: ['ignore', log, log, 'pipe', 'pipe', 'ipc'],
      // @ts-ignore Stale Node.js type definition.
      windowsHide: true,
    });
    const workerPid = child.pid;
    const nodeWriter = /** @type {import('stream').Writable} */ (
      child.stdio[3]
    );
    const nodeReader = /** @type {import('stream').Readable} */ (
      child.stdio[4]
    );
    assert(nodeWriter);
    assert(nodeReader);
    const reader = makeNodeReader(nodeReader);
    const writer = makeNodeWriter(nodeWriter);

    const workerClosed = new Promise(resolve => {
      child.on('exit', () => {
        console.log(
          `Endo worker exited for PID ${workerPid} with unique identifier ${workerId}`,
        );
        resolve(undefined);
      });
    });

    await filePowers.writeFileText(pidPath, `${child.pid}\n`);

    const metaPath = filePowers.joinPath(workerStatePath, 'worker.meta.json');
    const meta = JSON.stringify({
      createdAt: new Date().toISOString(),
      label,
    });
    await filePowers.writeFileText(metaPath, `${meta}\n`);

    workerClosed.then(() => filePowers.removePath(pidPath).catch(() => {}));

    cancelled.catch(() => {
      child.kill();
    });

    forceCancelled.catch(() => {
      child.kill('SIGKILL');
    });

    console.log(
      `Endo worker started PID ${workerPid} unique identifier ${workerId}`,
    );

    const { getBootstrap, closed: capTpClosed } = makeNetstringCapTP(
      `Worker ${workerId}`,
      writer,
      reader,
      cancelled,
      daemonWorkerFacet,
      undefined,
      capTpConnectionRegistrar,
    );

    capTpClosed.finally(() => {
      console.log(
        `Endo worker connection closed for PID ${workerPid} with unique identifier ${workerId}`,
      );
    });

    const workerTerminated = Promise.race([workerClosed, capTpClosed]);

    /** @type {ERef<WorkerDaemonFacet>} */
    const workerDaemonFacet = getBootstrap();

    return { workerTerminated, workerDaemonFacet };
  };

  return harden({
    makeWorker,
  });
};

/**
 * @param {object} opts
 * @param {Config} opts.config
 * @param {Promise<never>} opts.cancelled
 * @param {typeof import('fs')} opts.fs
 * @param {typeof import('child_process')} opts.popen
 * @param {typeof import('url')} opts.url
 * @param {FilePowers} opts.filePowers
 * @param {CryptoPowers} opts.cryptoPowers
 * @returns {Promise<DaemonicPowers>}
 */
export const makeDaemonicPowers = async ({
  config,
  cancelled,
  fs,
  popen,
  url,
  filePowers,
  cryptoPowers,
}) => {
  const { fileURLToPath } = url;

  // Ensure state directory exists before opening database.
  await filePowers.makePath(config.statePath);

  const daemonDb = makeDaemonDatabase(config);
  cancelled.catch(() => daemonDb.close());

  const petStorePowers = makePetStoreMaker(daemonDb);
  const daemonicPersistencePowers = makeDaemonicPersistencePowers(
    daemonDb,
    filePowers,
    cryptoPowers,
    config,
  );
  const daemonicControlPowers = makeDaemonicControlPowers(
    config,
    fileURLToPath,
    filePowers,
    fs,
    popen,
  );
  const gitPowers = makeGitPowers({ popen, filePowers });

  return harden({
    crypto: cryptoPowers,
    petStore: petStorePowers,
    persistence: daemonicPersistencePowers,
    control: daemonicControlPowers,
    filePowers,
    gitPowers,
  });
};
