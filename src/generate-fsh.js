import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import https from 'https';
import { spawn } from 'child_process';
import { fileExists } from './utils/fs.js';
import { spawnProcess, createAnimator } from './utils/process.js';
import { parseSushiLog } from './utils/sushi-log.js';

const IGNORED_PACKAGE_DEPENDENCIES = new Set(['gofsh', 'sushi']);

/**
 * Downloads a FHIR package and generates FSH using GoFSH
 */
export async function generateFshFromPackage(packageSpec, outputDir) {
  const [packageName, versionFromArg] = packageSpec.split('#');
  const version = versionFromArg && versionFromArg.length > 0 ? versionFromArg : 'current';
  const packageSpecifier = `${packageName}/${version}`;
  const displaySpecifier = `${packageName}#${version}`;
  const downloadUrl = `https://packages.fhir.org/${packageSpecifier}`;
  const gofshBin = await resolveGofshExecutable(process.env.GOFSH_BIN);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gofsh-'));
  const archivePath = path.join(tempRoot, 'package.tgz');
  const extractDir = path.join(tempRoot, 'extracted');

  console.log(`  Downloading ${displaySpecifier}...`);
  try {
    await downloadToFile(downloadUrl, archivePath);
    await fsp.mkdir(extractDir, { recursive: true });
    console.log('  Extracting package...');
    await extractArchive(archivePath, extractDir);

    const packageDir = await resolvePackageDir(extractDir);
    await ensurePackageContent(packageDir);
    await fsp.mkdir(outputDir, { recursive: true });

    const gofshArgs = ['--out', outputDir, packageDir];
    console.log(`  Running GoFSH...`);
    await runCommand(gofshBin, gofshArgs);
    console.log('  GoFSH finished successfully');
    
    await updateSushiConfigDependencies(path.join(extractDir, 'package'), outputDir);
    await runSushiWithDuplicateSliceFix(outputDir);
  } catch (err) {
    throw new Error(`Failed to generate FSH from package: ${err.message}`);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
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
    path.resolve(process.cwd(), 'node_modules', '.bin'),
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

function downloadToFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https
      .get(url, response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.destroy();
          file.close(() => {
            downloadToFile(response.headers.location, destination).then(resolve).catch(reject);
          });
          return;
        }

        if (response.statusCode !== 200) {
          response.destroy();
          file.close(() => reject(new Error(`Download failed (${response.statusCode}) ${url}`)));
          return;
        }

        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

async function resolvePackageDir(extractedRoot) {
  const candidate = path.join(extractedRoot, 'package');
  const stat = await fsp
    .stat(candidate)
    .then(info => (info.isDirectory() ? candidate : extractedRoot))
    .catch(() => extractedRoot);
  return stat;
}

async function ensurePackageContent(packageDir) {
  const marker = path.join(packageDir, 'package.json');
  await fsp
    .access(marker)
    .catch(() => {
      throw new Error(`Extracted package incomplete - ${marker} missing`);
    });
}

async function extractArchive(archivePath, destination) {
  await runCommand('tar', ['-xzf', archivePath, '-C', destination]);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const needsShell =
      process.platform === 'win32' &&
      typeof command === 'string' &&
      (command.toLowerCase().endsWith('.cmd') || command.toLowerCase().endsWith('.bat'));
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: needsShell,
      ...options,
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function updateSushiConfigDependencies(packageDir, outputDir) {
  const projectDependencies = await readProjectDependencies(packageDir);
  if (!projectDependencies || Object.keys(projectDependencies).length === 0) {
    return;
  }
  const configPath = await findSushiConfig(outputDir);
  if (!configPath) {
    console.warn('  Could not find sushi-config.yaml - dependencies not updated');
    return;
  }
  const updated = await mergeDependenciesIntoConfig(configPath, projectDependencies);
  if (updated) {
    console.log(`  Updated dependencies in ${path.basename(configPath)}`);
  }
}

async function readProjectDependencies(targetDir) {
  const pkgPath = path.join(targetDir, 'package.json');
  const pkgRaw = await fsp.readFile(pkgPath, 'utf8').catch(() => null);
  if (!pkgRaw) {
    return null;
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return null;
  }
  const source = pkg.fhirDependencies && Object.keys(pkg.fhirDependencies).length > 0 ? pkg.fhirDependencies : pkg.dependencies;
  if (!source) {
    return null;
  }
  const entries = Object.entries(source).filter(
    ([name, version]) => typeof version === 'string' && version.trim().length > 0 && !IGNORED_PACKAGE_DEPENDENCIES.has(name)
  );
  if (entries.length === 0) {
    return null;
  }
  return Object.fromEntries(entries.map(([name, version]) => [name, version.trim()]));
}

async function findSushiConfig(dir) {
  const candidates = ['sushi-config.yaml', 'sushi-config.yml'];
  for (const candidate of candidates) {
    const filePath = path.join(dir, candidate);
    if (await fileExists(filePath)) {
      return filePath;
    }
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === '.' || entry.name === '..') {
      continue;
    }
    const nested = await findSushiConfig(path.join(dir, entry.name));
    if (nested) {
      return nested;
    }
  }
  return null;
}

async function mergeDependenciesIntoConfig(configPath, dependencies) {
  const original = await fsp.readFile(configPath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const blockLines = ['dependencies:', ...Object.entries(dependencies).map(([name, version]) => `  ${name}: ${version}`)];
  const lines = original.split(/\r?\n/);
  const { start, end } = findDependencyBlockRange(lines);
  let updated;
  if (start === -1) {
    const trimmed = original.trimEnd();
    const separator = trimmed.length > 0 ? `${newline}${newline}` : '';
    updated = `${trimmed}${separator}${blockLines.join(newline)}${newline}`;
  } else {
    lines.splice(start, end - start, ...blockLines);
    updated = lines.join(newline);
  }
  if (updated !== original) {
    await fsp.writeFile(configPath, updated, 'utf8');
    return true;
  }
  return false;
}

function findDependencyBlockRange(lines) {
  const start = lines.findIndex(
    line => line.trimStart().startsWith('dependencies:') && !/^\s/.test(line)
  );
  if (start === -1) {
    return { start: -1, end: -1 };
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s/.test(line)) {
      end += 1;
      continue;
    }
    if (line.trim().length === 0) {
      break;
    }
    break;
  }
  return { start, end };
}

async function runSushiWithDuplicateSliceFix(outputDir) {
  const sushiExec = process.env.SUSHI_BIN || 'sushi';
  const sushiArgs = ['-s', outputDir];
  console.log(`  Validating FSH with SUSHI...`);
  const initialRun = await runSushiOnce(sushiExec, sushiArgs, outputDir, 'sushi-from-gofsh.log');
  if (initialRun.exitCode === 0) {
    console.log('  SUSHI completed without errors');
    return;
  }

  const fixes = await fixDuplicateSlicesFromLog(initialRun.logEntries, outputDir);
  if (fixes === 0) {
    console.warn('  SUSHI reported errors but no duplicate slice issues were detected');
    return;
  }
  console.log(`  Applied ${fixes} duplicate-slice fix(es), re-running SUSHI...`);
  const rerun = await runSushiOnce(sushiExec, sushiArgs, outputDir, 'sushi-from-gofsh-rerun.log');
  if (rerun.exitCode !== 0) {
    console.warn('  SUSHI still reports errors after auto-fix');
  }
}

async function runSushiOnce(executable, args, cwd, logFileName) {
  const animator = createAnimator('SUSHI working...');
  animator.start();
  const { stdout, stderr, exitCode } = await spawnProcess(executable, args, cwd).finally(() =>
    animator.stop()
  );
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const logPath = path.join(cwd, logFileName);
  if (combined.trim()) {
    await fsp.writeFile(logPath, combined, 'utf8');
  }
  const logEntries = parseSushiLog(combined);
  return { exitCode, logEntries };
}

async function fixDuplicateSlicesFromLog(logEntries, outputDir) {
  const duplicateEntries = logEntries
    .map(parseDuplicateSliceMessage)
    .filter(entry => entry && entry.file && entry.elementPath && entry.sliceName);
  if (duplicateEntries.length === 0) {
    return 0;
  }

  const grouped = new Map();
  for (const entry of duplicateEntries) {
    const targetFile = path.isAbsolute(entry.file) ? entry.file : path.join(outputDir, entry.file);
    const normalizedPath = toFshPath(entry.elementPath);
    if (!normalizedPath) {
      continue;
    }
    if (!grouped.has(targetFile)) {
      grouped.set(targetFile, new Map());
    }
    const perElement = grouped.get(targetFile);
    if (!perElement.has(normalizedPath)) {
      perElement.set(normalizedPath, new Set());
    }
    perElement.get(normalizedPath).add(entry.sliceName);
  }

  let changedBlocks = 0;
  for (const [filePath, elementMap] of grouped.entries()) {
    const updated = await rewriteContainsBlocks(filePath, elementMap);
    changedBlocks += updated;
  }
  return changedBlocks;
}

function parseDuplicateSliceMessage(entry) {
  if (!entry || typeof entry.message !== 'string') {
    return null;
  }
  const match = entry.message.match(/Slice named (\S+) already exists on element (\S+) of/i);
  if (!match) {
    return null;
  }
  const [, sliceName, elementPath] = match;
  return {
    file: entry.file,
    sliceName,
    elementPath,
  };
}

function toFshPath(elementPath) {
  if (!elementPath || typeof elementPath !== 'string') {
    return null;
  }
  const withoutRoot = elementPath.includes('.')
    ? elementPath.slice(elementPath.indexOf('.') + 1)
    : elementPath;
  return withoutRoot
    .split('.')
    .map(part => part.replace(/:([^.:]+)/g, '[$1]'))
    .join('.');
}

async function rewriteContainsBlocks(filePath, elementMap) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    console.warn(`Cannot apply duplicate-slice fix. File not found: ${filePath}`);
    return 0;
  }
  const original = await fsp.readFile(filePath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let replacements = 0;

  for (const [elementPath, sliceNames] of elementMap.entries()) {
    const parsed = parseContainsBlock(lines, elementPath);
    if (!parsed || parsed.slices.length === 0) {
      continue;
    }
    const newRules = parsed.slices.map(slice => {
      const parts = [`${parsed.indent}* ${elementPath}[${slice.sliceName}]`];
      if (slice.cardinality) {
        parts.push(slice.cardinality);
      }
      if (slice.suffix) {
        parts.push(slice.suffix);
      }
      return parts.filter(Boolean).join(' ').trimEnd();
    });
    if (newRules.length === 0) {
      continue;
    }
    const deleteCount = parsed.end - parsed.start + 1;
    lines.splice(parsed.start, deleteCount, ...newRules);
    replacements += 1;
  }

  if (replacements > 0) {
    const updated = lines.join(newline);
    if (updated !== original) {
      await fsp.writeFile(filePath, updated, 'utf8');
    }
  }
  return replacements;
}

function parseContainsBlock(lines, elementPath) {
  const regex = new RegExp(`^\\s*\\*\\s+${escapeRegExp(elementPath)}\\s+contains\\b`, 'i');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!regex.test(line)) {
      continue;
    }
    const indentMatch = line.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : '';
    const afterContains = line.split(/contains/i)[1]?.trim() || '';
    let sliceText = afterContains;
    let end = i;
    let cursor = i + 1;
    while (!sliceText || sliceText.endsWith('and')) {
      const next = lines[cursor];
      if (!next) {
        break;
      }
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith('*')) {
        break;
      }
      sliceText = `${sliceText} ${trimmed}`.trim();
      end = cursor;
      cursor += 1;
    }
    const slices = parseSliceEntries(sliceText);
    return { start: i, end, indent, slices };
  }
  return null;
}

function parseSliceEntries(sliceText) {
  if (!sliceText) {
    return [];
  }
  return sliceText
    .split(/\s+and\s+/i)
    .map(entry => entry.replace(/\s+and\s*$/i, '').trim())
    .filter(Boolean)
    .map(entry => {
      const match = entry.match(/^(\S+)(?:\s+named\s+(\S+))?\s*(\d+\.\.\d+|\d+\.\.\*)?\s*(.*)$/i);
      if (!match) {
        return null;
      }
      const [, token, named, card, rest] = match;
      const sliceName = (named || token).replace(/^\[|\]$/g, '');
      return {
        sliceName,
        cardinality: card || '',
        suffix: (rest || '').replace(/\s+and\s*$/i, '').trim(),
      };
    })
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
