import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { fileExists, pathExists } from './utils/fs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CORE_SD_PREFIX = 'http://hl7.org/fhir/StructureDefinition/';
export const PARENT_HELPER_MARKER = '.parent-helpers.json';
const HELPER_DIR_NAME = '_parents';

/**
 * Converts the external R4 parent chain of an R6 project into local FSH.
 *
 * Profiles whose `Parent` resolves to a StructureDefinition from an R4 dependency
 * package (e.g. de.basisprofil.r4) cannot be lifted to R6 by SUSHI, because SUSHI
 * builds the child on the R4 parent snapshot. By materialising the whole parent
 * chain as local FSH (carrying the original canonical url + version), SUSHI rebuilds
 * the entire chain on R6 core and the children become genuine R6 profiles.
 *
 * The helper canonicals are recorded in a marker file so the comparison step can
 * exclude them from the report (they are scaffolding, not the package's own profiles).
 *
 * @returns {Promise<{canonicals: string[], count: number}>}
 */
export async function resolveParentChainToFsh(r6WorkingDir, options = {}) {
  const fshRoot = path.join(r6WorkingDir, 'input', 'fsh');
  if (!(await pathExists(fshRoot))) {
    return { canonicals: [], count: 0 };
  }

  const fshFiles = await collectFshFiles(fshRoot);
  const aliasMap = await buildAliasMap(fshFiles);
  const { localUrls } = await buildLocalDefinitions(fshFiles, r6WorkingDir);
  const parentRefs = await collectParentReferences(fshFiles);

  const cacheIndex = await buildDependencyCacheIndex(r6WorkingDir, options.cacheRoot);
  if (cacheIndex.size === 0) {
    return { canonicals: [], count: 0 };
  }

  // Resolve every external parent (and its transitive base chain) to a cache SD file.
  const collected = new Map(); // canonicalUrl -> { file, url, version }
  for (const ref of parentRefs) {
    const url = resolveParentToUrl(ref, aliasMap);
    if (!url) {
      continue;
    }
    collectExternalChain(url, { cacheIndex, localUrls, collected });
  }

  if (collected.size === 0) {
    return { canonicals: [], count: 0 };
  }

  const helperDir = path.join(fshRoot, HELPER_DIR_NAME);
  await convertCollectedToFsh([...collected.values()], helperDir, options);

  const canonicals = [...collected.values()].map((entry) => entry.url);
  await fsp.writeFile(
    path.join(r6WorkingDir, PARENT_HELPER_MARKER),
    JSON.stringify({ canonicals }, null, 2),
    'utf8'
  );

  console.log(`  Materialised ${canonicals.length} parent profile(s) as local FSH for R6 conversion`);
  return { canonicals, count: canonicals.length };
}

/**
 * Reads the helper canonical list written by resolveParentChainToFsh, if present.
 */
export async function readParentHelperCanonicals(workingDir) {
  const markerPath = path.join(workingDir, PARENT_HELPER_MARKER);
  const raw = await fsp.readFile(markerPath, 'utf8').catch(() => null);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.canonicals) ? parsed.canonicals : [];
  } catch {
    return [];
  }
}

// --- parent discovery -------------------------------------------------------

async function collectFshFiles(dir) {
  const files = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.fsh')) {
        files.push(entryPath);
      }
    }
  }
  await walk(dir);
  return files;
}

async function buildAliasMap(fshFiles) {
  const map = new Map();
  const aliasRegex = /^Alias:\s*(\$?\S+)\s*=\s*(\S+)/;
  for (const file of fshFiles) {
    const content = await fsp.readFile(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(aliasRegex);
      if (match) {
        map.set(match[1], match[2]);
      }
    }
  }
  return map;
}

async function buildLocalDefinitions(fshFiles, r6WorkingDir) {
  const localIds = new Set();
  const idRegex = /^Id:\s*(\S+)/;
  for (const file of fshFiles) {
    const content = await fsp.readFile(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const idMatch = line.match(idRegex);
      if (idMatch) {
        localIds.add(idMatch[1]);
      }
    }
  }
  const canonical = await readCanonical(r6WorkingDir);
  const localUrls = new Set();
  if (canonical) {
    for (const id of localIds) {
      localUrls.add(`${canonical}/StructureDefinition/${id}`.toLowerCase());
    }
  }
  return { localUrls };
}

async function collectParentReferences(fshFiles) {
  const refs = new Set();
  const parentRegex = /^Parent:\s*(\S+)/;
  for (const file of fshFiles) {
    const content = await fsp.readFile(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(parentRegex);
      if (match) {
        refs.add(match[1]);
      }
    }
  }
  return [...refs];
}

function resolveParentToUrl(ref, aliasMap) {
  let value = ref;
  if (value.startsWith('$') && aliasMap.has(value)) {
    value = aliasMap.get(value);
  }
  // bare resource/type name (no slash) → core, SUSHI builds it from R6 core
  if (!value.includes('/')) {
    return null;
  }
  return stripVersion(value);
}

function stripVersion(url) {
  const pipeIndex = url.indexOf('|');
  return pipeIndex >= 0 ? url.slice(0, pipeIndex) : url;
}

function collectExternalChain(url, ctx) {
  const { cacheIndex, localUrls, collected } = ctx;
  let current = stripVersion(url);
  while (current) {
    if (current.startsWith(CORE_SD_PREFIX)) {
      return; // reached FHIR core
    }
    if (localUrls.has(current.toLowerCase())) {
      return; // defined locally already
    }
    if (collected.has(current)) {
      return; // already collected (and its chain)
    }
    const entry = cacheIndex.get(current.toLowerCase());
    if (!entry) {
      return; // not resolvable from cache; leave for SUSHI to report
    }
    collected.set(current, entry);
    current = entry.baseDefinition ? stripVersion(entry.baseDefinition) : null;
  }
}

// --- dependency cache index -------------------------------------------------

async function buildDependencyCacheIndex(r6WorkingDir, cacheRootOverride) {
  const deps = await readDependencies(r6WorkingDir);
  const cacheRoot = cacheRootOverride || defaultCacheRoot();
  const index = new Map(); // url(lowercase) -> { file, url, version, baseDefinition }
  for (const [id, version] of deps) {
    const packageDir = path.join(cacheRoot, `${id}#${version}`, 'package');
    if (!(await pathExists(packageDir))) {
      continue;
    }
    const entries = await fsp.readdir(packageDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
        continue;
      }
      const filePath = path.join(packageDir, entry.name);
      const data = await readJson(filePath);
      if (!data || data.resourceType !== 'StructureDefinition' || !data.url) {
        continue;
      }
      const key = data.url.toLowerCase();
      if (!index.has(key)) {
        index.set(key, {
          file: filePath,
          url: data.url,
          version: data.version || version,
          baseDefinition: data.baseDefinition || null,
        });
      }
    }
  }
  return index;
}

async function readDependencies(r6WorkingDir) {
  const configPath = await findSushiConfig(r6WorkingDir);
  if (!configPath) {
    return [];
  }
  const content = await fsp.readFile(configPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const deps = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^dependencies:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\S/.test(line)) {
        break; // left the block (next top-level key)
      }
      // simple form:   id: version
      const simple = line.match(/^\s+([A-Za-z0-9_.\-]+):\s*([0-9A-Za-z._\-]+)\s*$/);
      if (simple) {
        deps.push([simple[1], simple[2]]);
        continue;
      }
      // object form:   id:\n    version: x
      const idOnly = line.match(/^\s+([A-Za-z0-9_.\-]+):\s*$/);
      if (idOnly) {
        deps.push([idOnly[1], null]);
      }
      const versionLine = line.match(/^\s+version:\s*([0-9A-Za-z._\-]+)\s*$/);
      if (versionLine && deps.length > 0 && deps[deps.length - 1][1] === null) {
        deps[deps.length - 1][1] = versionLine[1];
      }
    }
  }
  return deps.filter(([, version]) => Boolean(version));
}

async function findSushiConfig(dir) {
  for (const name of ['sushi-config.yaml', 'sushi-config.yml']) {
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function readCanonical(r6WorkingDir) {
  const configPath = await findSushiConfig(r6WorkingDir);
  if (!configPath) {
    return null;
  }
  const content = await fsp.readFile(configPath, 'utf8');
  const match = content.match(/^canonical:\s*(\S+)/m);
  return match ? match[1].replace(/\/+$/, '') : null;
}

function defaultCacheRoot() {
  if (process.env.FHIR_PACKAGE_CACHE) {
    return process.env.FHIR_PACKAGE_CACHE;
  }
  return path.join(os.homedir(), '.fhir', 'packages');
}

// --- GoFSH conversion -------------------------------------------------------

async function convertCollectedToFsh(entries, helperDir, options) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'parents-'));
  const srcDir = path.join(tempRoot, 'src');
  const outDir = path.join(tempRoot, 'out');
  try {
    await fsp.mkdir(srcDir, { recursive: true });
    // id -> { url, version } so we can force the original canonical onto the FSH
    const idMeta = new Map();
    for (const entry of entries) {
      const data = await readJson(entry.file);
      if (!data || !data.id) {
        continue;
      }
      idMeta.set(data.id, { url: entry.url, version: data.version || entry.version });
      await fsp.copyFile(entry.file, path.join(srcDir, path.basename(entry.file)));
    }

    const gofshBin = await resolveGofshExecutable(process.env.GOFSH_BIN);
    await runCommand(gofshBin, ['--out', outDir, srcDir]);

    const generatedFshRoot = path.join(outDir, 'input', 'fsh');
    if (!(await pathExists(generatedFshRoot))) {
      throw new Error('GoFSH produced no FSH for parent profiles');
    }

    await fsp.mkdir(helperDir, { recursive: true });
    const generatedFiles = await collectFshFiles(generatedFshRoot);
    for (const file of generatedFiles) {
      const rel = path.relative(generatedFshRoot, file);
      const dest = path.join(helperDir, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const patched = forceOriginalCanonical(await fsp.readFile(file, 'utf8'), idMeta);
      await fsp.writeFile(dest, patched, 'utf8');
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Injects the original `^url` (and `^version`) into a generated parent profile so
 * `Parent:` references by canonical resolve to this local definition instead of the
 * R4 dependency package.
 */
function forceOriginalCanonical(content, idMeta) {
  const lines = content.split(/\r?\n/);
  const idRegex = /^Id:\s*(\S+)/;
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    const match = lines[i].match(idRegex);
    if (!match) {
      continue;
    }
    const meta = idMeta.get(match[1]);
    if (!meta) {
      continue;
    }
    if (!content.includes('^url')) {
      out.push(`* ^url = "${meta.url}"`);
    }
    if (meta.version && !content.includes('^version')) {
      out.push(`* ^version = "${meta.version}"`);
    }
  }
  return out.join('\n');
}

// --- shared low-level helpers ----------------------------------------------

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8').catch(() => null);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nodeModulesBinDirsUpFrom(startDir) {
  const dirs = [];
  let current = startDir;
  for (;;) {
    dirs.push(path.join(current, 'node_modules', '.bin'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function resolveGofshExecutable(overridePath) {
  if (overridePath) {
    return overridePath;
  }
  const candidateNames =
    process.platform === 'win32'
      ? ['gofsh.cmd', 'gofsh.exe', 'gofsh.bat', 'gofsh']
      : ['gofsh'];
  const searchRoots = [
    process.cwd(),
    ...nodeModulesBinDirsUpFrom(process.cwd()),
    ...nodeModulesBinDirsUpFrom(__dirname),
  ];
  for (const root of searchRoots) {
    for (const name of candidateNames) {
      const candidate = path.join(root, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return 'gofsh';
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const needsShell =
      process.platform === 'win32' &&
      typeof command === 'string' &&
      (command.toLowerCase().endsWith('.cmd') || command.toLowerCase().endsWith('.bat'));
    const child = spawn(command, args, { stdio: 'inherit', shell: needsShell, ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
