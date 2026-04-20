import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { createAnimator, spawnProcess } from './utils/process.js';
import { fileExists, pathExists } from './utils/fs.js';
import { parseSushiLog } from './utils/sushi-log.js';

const SOURCE_VERSION = '4.0.1';
const TARGET_VERSION = '6.0.0-ballot3';
const MAX_ITERATIONS = 10;
const SNOMED_CT_ERROR_TEXT = 'Resolved value "SNOMED_CT" is not a valid URI';

/**
 * Upgrades a SUSHI project to FHIR R6
 */
export async function upgradeSushiToR6(sourceDir, sushiExecutable = 'sushi -s') {
  await ensureDirectory(sourceDir);
  const workingDir = await createR6Workspace(sourceDir);

  const configs = await findSushiConfigs(workingDir);
  if (configs.length === 0) {
    throw new Error(`No sushi-config.yaml found in ${workingDir}`);
  }

  await Promise.all(
    configs.map(async (configPath) => {
      const updated = await updateFhirVersion(configPath, SOURCE_VERSION, TARGET_VERSION);
      if (updated) {
        console.log(`  Updated ${path.basename(configPath)} to ${TARGET_VERSION}`);
      }
    })
  );

  await renameProfilesWithSuffix(workingDir);
  await runSushiUntilSuccess(workingDir, sushiExecutable);
  
  return workingDir;
}

async function ensureDirectory(dir) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dir}`);
  }
}

async function createR6Workspace(sourceDir) {
  const targetDir = deriveR6Path(sourceDir);
  const exists = await pathExists(targetDir);
  if (exists) {
    // A directory without sushi-config.yaml means the previous copy failed partway through.
    // Clean it up so we can retry with a fresh copy.
    const sushiConfigPath = path.join(targetDir, 'sushi-config.yaml');
    const hasConfig = await fileExists(sushiConfigPath);
    if (hasConfig) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }
    console.log(`  Removing incomplete target directory from failed previous run: ${targetDir}`);
    await fsp.rm(targetDir, { recursive: true, force: true });
  }
  console.log(`  Copying ${sourceDir} to ${targetDir}...`);
  try {
    await fsp.cp(sourceDir, targetDir, { recursive: true });
  } catch (error) {
    // Clean up any partial copy so the next run can retry cleanly.
    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => null);
    throw error;
  }
  return targetDir;
}

function deriveR6Path(sourceDir) {
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);
  const hasR4Suffix = base.toLowerCase().endsWith('r4');
  const trimmed = hasR4Suffix ? base.slice(0, -2) : base;
  return path.join(parent, `${trimmed}R6`);
}

async function findSushiConfigs(rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const targets = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower === 'sushi-config.yaml' || lower === 'sushi-config.yml') {
      targets.push(path.join(rootDir, entry.name));
    }
  }
  return targets;
}

async function updateFhirVersion(filePath, fromVersion, toVersion) {
  const original = await fsp.readFile(filePath, 'utf8');
  const updated = replaceFhirVersion(original, fromVersion, toVersion);
  if (updated === original) {
    return false;
  }
  await fsp.writeFile(filePath, updated, 'utf8');
  return true;
}

function replaceFhirVersion(content, fromVersion, toVersion) {
  const regex = new RegExp(
    `(fhirVersion\\s*:\\s*)(["']?)${escapeRegExp(fromVersion)}\\2`,
    'i'
  );
  return content.replace(regex, (_, prefix, quote) => {
    const q = quote || '';
    return `${prefix}${q}${toVersion}${q}`;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function renameProfilesWithSuffix(rootDir) {
  const fshFiles = await collectFshFiles(rootDir);
  if (fshFiles.length === 0) {
    console.warn('  No FSH files found, skipping profile renaming');
    return;
  }
  const renameMap = await buildProfileRenameMap(fshFiles);
  if (renameMap.size === 0) {
    console.log('  No profiles without R6 suffix found');
    return;
  }
  const changedFiles = await applyProfileRenames(fshFiles, renameMap);
  console.log(`  Renamed ${renameMap.size} profile(s) in ${changedFiles} file(s)`);
}

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

async function buildProfileRenameMap(files) {
  const renameMap = new Map();
  const profileRegex = /^Profile:\s*(\S+)/;
  for (const file of files) {
    const content = await fsp.readFile(file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(profileRegex);
      if (!match) {
        continue;
      }
      const name = match[1];
      if (name.endsWith('R6') || renameMap.has(name)) {
        continue;
      }
      renameMap.set(name, `${name}R6`);
    }
  }
  return renameMap;
}

async function applyProfileRenames(files, renameMap) {
  if (renameMap.size === 0) {
    return 0;
  }
  const patterns = [...renameMap.entries()].map(([oldName, newName]) => ({
    newName,
    regex: createProfileNameRegex(oldName),
  }));

  let changedFiles = 0;
  for (const file of files) {
    const original = await fsp.readFile(file, 'utf8');
    let updated = original;
    
    for (const { newName, regex } of patterns) {
      updated = updated.replace(regex, (_, prefix = '') => `${prefix || ''}${newName}`);
    }
    
    for (const [oldName, newName] of renameMap.entries()) {
      const oldIdPart = camelCaseToKebabCase(oldName);
      const newIdPart = camelCaseToKebabCase(newName);
      
      const urlPattern = new RegExp(
        `(\\^url\\s*=\\s*["\'])([^"']*\\/)${escapeRegExp(oldIdPart)}(["\'])`,
        'g'
      );
      updated = updated.replace(urlPattern, (_, prefix, urlPrefix, suffix) => {
        return `${prefix}${urlPrefix}${newIdPart}${suffix}`;
      });
      
      const idPattern = new RegExp(
        `(\\^id\\s*=\\s*["\'])${escapeRegExp(oldIdPart)}(["\'])`,
        'g'
      );
      updated = updated.replace(idPattern, (_, prefix, suffix) => {
        return `${prefix}${newIdPart}${suffix}`;
      });
    }
    
    if (updated !== original) {
      await fsp.writeFile(file, updated, 'utf8');
      changedFiles += 1;
    }
  }
  return changedFiles;
}

function camelCaseToKebabCase(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function createProfileNameRegex(name) {
  const prefix = '(^|[^A-Za-z0-9._-])';
  const suffix = '(?=[^A-Za-z0-9._-]|$)';
  const pattern = `${prefix}(${escapeRegExp(name)})${suffix}`;
  return new RegExp(pattern, 'gm');
}

async function runSushiUntilSuccess(targetDir, sushiExecutable) {
  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    console.log(`  SUSHI iteration ${iteration}...`);
    const { stdout, stderr, exitCode } = await runSushi(sushiExecutable, targetDir);
    const combinedLog = [stdout, stderr].filter(Boolean).join('\n');
    const logPath = path.join(targetDir, `sushi-upgrade-${iteration}.log`);
    await fsp.writeFile(logPath, combinedLog, 'utf8');
    if (exitCode === 0) {
      console.log(`  SUSHI completed successfully (iteration ${iteration})`);
      return;
    }
    console.warn(`  SUSHI exited with code ${exitCode}, analyzing errors...`);

    const errors = parseSushiLog(combinedLog);
    const snomedFix = await fixSnomedCtIssues(errors, targetDir);
    if (snomedFix) {
      console.log('  Applied SNOMED_CT fix, re-running...');
      continue;
    }
    const cardinalityFix = await fixMinCardinalityInstanceErrors(errors, targetDir);
    if (cardinalityFix) {
      console.log(`  Disabled ${cardinalityFix} instance file(s), re-running...`);
      continue;
    }
    const modifications = await commentErrorLines(errors, targetDir);
    if (modifications === 0) {
      throw new Error('SUSHI failed but no lines could be commented out');
    }
    console.log(`  Commented out lines in ${modifications} file(s)`);
  }
  throw new Error(
    `SUSHI failed after ${MAX_ITERATIONS} iterations. ` +
    `Please fix the remaining SUSHI errors manually in the ResourcesR6 directory ` +
    `and then run 'sushi -s' to build the snapshots.`
  );
}

async function runSushi(executable, targetDir) {
  const animator = createAnimator('SUSHI working...');
  animator.start();
  try {
    const parts = executable.trim().split(/\s+/);
    const command = parts[0];
    const args = [...parts.slice(1), targetDir];
    
    return await spawnProcess(command, args, process.cwd());
  } finally {
    animator.stop();
  }
}

async function commentErrorLines(logEntries, workingDir) {
  const grouped = new Map();

  for (const entry of logEntries) {
    const normalizedPath = normalizeLogPath(entry.file, workingDir);
    if (!normalizedPath || typeof entry.line !== 'number') {
      continue;
    }
    if (!grouped.has(normalizedPath)) {
      grouped.set(normalizedPath, new Set());
    }
    const startLine = entry.line;
    const endLine = entry.endLine || entry.line;
    for (let ln = startLine; ln <= endLine; ln++) {
      grouped.get(normalizedPath).add(ln);
    }
  }

  let modifiedFiles = 0;
  for (const [filePath, lines] of grouped.entries()) {
    const updated = await commentLinesInFile(filePath, [...lines]);
    if (updated) {
      modifiedFiles += 1;
    }
  }
  return modifiedFiles;
}

function normalizeLogPath(filePath, workingDir) {
  if (!filePath) {
    return null;
  }
  let candidate = filePath.trim();
  if (!candidate) {
    return null;
  }

  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    if (process.platform === 'win32') {
      candidate = candidate.replace(/\//g, '\\');
    } else {
      const drive = candidate[0].toLowerCase();
      const rest = candidate.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
      candidate = `/mnt/${drive}/${rest}`;
    }
  } else if (process.platform === 'win32') {
    candidate = candidate.replace(/\//g, '\\');
  } else {
    candidate = candidate.replace(/\\/g, '/');
  }

  if (!path.isAbsolute(candidate)) {
    candidate = path.join(workingDir, candidate);
  }

  return candidate;
}

async function commentLinesInFile(filePath, lineNumbers) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    console.warn(`Could not find file: ${filePath}`);
    return false;
  }

  const original = await fsp.readFile(filePath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let changed = false;

  const expandedLines = expandContainsBlockLines(lines, lineNumbers);

  expandedLines
    .filter((n) => Number.isInteger(n) && n > 0 && n <= lines.length)
    .sort((a, b) => a - b)
    .forEach((lineNumber) => {
      const idx = lineNumber - 1;
      const current = lines[idx];
      if (current.trim().startsWith('// AUTO-DISABLED (SUSHI R6):')) {
        return;
      }
      const indent = current.match(/^\s*/)[0] || '';
      const content = current.trimStart();
      lines[idx] = `${indent}// AUTO-DISABLED (SUSHI R6): ${content}`;
      changed = true;
    });

  if (changed) {
    const updated = lines.join(newline);
    await fsp.writeFile(filePath, updated, 'utf8');
  }

  return changed;
}

function expandContainsBlockLines(lines, lineNumbers) {
  const expanded = new Set(lineNumbers);

  for (const lineNumber of lineNumbers) {
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length) {
      continue;
    }

    const currentLine = lines[idx].trim();
    
    // Handle multi-line string literals (e.g., ^comment, ^description, etc.)
    // Check if line contains = followed by a quote that's not closed
    const hasStringAssignment = currentLine.match(/=\s*(""")?(")?/);
    if (hasStringAssignment) {
      const tripleQuote = hasStringAssignment[1]; // """
      const singleQuote = hasStringAssignment[2]; // "
      
      if (tripleQuote) {
        // Triple-quoted string - find closing """
        const firstTriplePos = currentLine.indexOf('"""');
        const secondTriplePos = currentLine.indexOf('"""', firstTriplePos + 3);
        
        if (secondTriplePos === -1) {
          // No closing """ on this line - include following lines
          let nextIdx = idx + 1;
          while (nextIdx < lines.length) {
            expanded.add(nextIdx + 1);
            if (lines[nextIdx].includes('"""')) {
              break;
            }
            nextIdx++;
            // Safety limit to prevent infinite loops
            if (nextIdx - idx > 100) break;
          }
        }
      } else if (singleQuote) {
        // Single-quoted string - check if it's closed on the same line
        const firstQuotePos = currentLine.indexOf('"');
        let secondQuotePos = -1;
        
        // Find closing quote that's not escaped
        for (let i = firstQuotePos + 1; i < currentLine.length; i++) {
          if (currentLine[i] === '"' && currentLine[i - 1] !== '\\') {
            secondQuotePos = i;
            break;
          }
        }
        
        if (secondQuotePos === -1) {
          // No closing " on this line - include following lines
          let nextIdx = idx + 1;
          while (nextIdx < lines.length) {
            expanded.add(nextIdx + 1);
            // Check for unescaped closing quote
            const nextLine = lines[nextIdx];
            let foundClosing = false;
            for (let i = 0; i < nextLine.length; i++) {
              if (nextLine[i] === '"' && (i === 0 || nextLine[i - 1] !== '\\')) {
                foundClosing = true;
                break;
              }
            }
            if (foundClosing) {
              break;
            }
            nextIdx++;
            // Safety limit to prevent infinite loops
            if (nextIdx - idx > 100) break;
          }
        }
      }
    }
    
    if (currentLine.includes(' contains') || currentLine.endsWith(' and')) {
      let nextIdx = idx + 1;
      while (nextIdx < lines.length) {
        const nextLine = lines[nextIdx].trim();
        if (nextLine.startsWith('// AUTO-DISABLED (SUSHI R6):')) {
          nextIdx++;
          continue;
        }
        if (nextLine === '') {
          nextIdx++;
          continue;
        }
        const isIndentedContinuation = lines[nextIdx].match(/^\s+/) && 
          (nextLine.match(/^\w+\s+\d/) || nextLine.endsWith(' and') || nextLine.endsWith('MS') || nextLine.endsWith('MS and'));
        const isSliceDefinition = nextLine.match(/^\w+\s+\d+\.\.(\d+|\*)\s*(MS)?\s*(and)?\s*$/);
        
        if (isIndentedContinuation || isSliceDefinition) {
          expanded.add(nextIdx + 1);
          nextIdx++;
        } else {
          break;
        }
      }
    }

    const softIndexMatch = currentLine.match(/^\*\s*(\S+)\[(\d+|\+)\]\./);
    if (softIndexMatch) {
      const elementPath = softIndexMatch[1];
      let nextIdx = idx + 1;
      while (nextIdx < lines.length) {
        const nextLine = lines[nextIdx].trim();
        if (nextLine.startsWith('// AUTO-DISABLED (SUSHI R6):')) {
          nextIdx++;
          continue;
        }
        if (nextLine === '') {
          nextIdx++;
          continue;
        }
        const eqPattern = new RegExp(`^\\*\\s*${escapeRegExp(elementPath)}\\[=\\]\\.`);
        if (eqPattern.test(nextLine)) {
          expanded.add(nextIdx + 1);
          nextIdx++;
        } else if (nextLine.match(new RegExp(`^\\*\\s*${escapeRegExp(elementPath)}\\[(\\d+|\\+)\\]\\.`))) {
          break;
        } else {
          break;
        }
      }
    }
  }

  return [...expanded];
}

async function fixSnomedCtIssues(logEntries, workingDir) {
  const hasSnomedError = logEntries.some(
    (entry) => typeof entry.message === 'string' && entry.message.includes(SNOMED_CT_ERROR_TEXT)
  );
  if (!hasSnomedError) {
    return false;
  }
  const replacements = await replacePlainSnomedReferences(workingDir);
  const aliasAdded = await ensureSnomedAliasDefinition(workingDir);
  if (replacements > 0 || aliasAdded) {
    console.log(`  Fixed SNOMED_CT in ${replacements} file(s)${aliasAdded ? ' and added alias' : ''}`);
    return true;
  }
  return false;
}

async function replacePlainSnomedReferences(rootDir) {
  const files = await collectFshFiles(rootDir);
  let changedFiles = 0;
  const pattern = /(^|[^$A-Za-z0-9_])SNOMED_CT\b/gm;
  for (const file of files) {
    const original = await fsp.readFile(file, 'utf8');
    const updated = original.replace(pattern, (_, prefix) => `${prefix}$SNOMED_CT`);
    if (updated !== original) {
      await fsp.writeFile(file, updated, 'utf8');
      changedFiles += 1;
    }
  }
  return changedFiles;
}

async function ensureSnomedAliasDefinition(rootDir) {
  const { filePath, exists } = await resolveAliasFilePath(rootDir);
  let content = '';
  if (exists) {
    content = await fsp.readFile(filePath, 'utf8');
    if (/^\s*Alias:\s*\$SNOMED_CT\b/m.test(content)) {
      return false;
    }
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const aliasLine = 'Alias: $SNOMED_CT = http://snomed.info/sct';
  if (!exists || content.length === 0) {
    const newline = os.EOL || '\n';
    await fsp.writeFile(filePath, `${aliasLine}${newline}`, 'utf8');
    return true;
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const needsNewline = content.endsWith('\r') || content.endsWith('\n');
  const suffix = needsNewline ? '' : newline;
  const updated = `${content}${suffix}${aliasLine}${newline}`;
  await fsp.writeFile(filePath, updated, 'utf8');
  return true;
}

async function fixMinCardinalityInstanceErrors(logEntries, workingDir) {
  const candidates = logEntries.filter(
    (entry) =>
      entry &&
      typeof entry.message === 'string' &&
      entry.message.includes('minimum cardinality 1 but occurs 0 time(s).') &&
      typeof entry.file === 'string'
  );
  if (candidates.length === 0) {
    return 0;
  }

  let disabled = 0;
  for (const entry of candidates) {
    const sourcePath = normalizeLogPath(entry.file, workingDir);
    if (
      !sourcePath ||
      !sourcePath.endsWith('.fsh') ||
      !sourcePath.includes(`${path.sep}instances${path.sep}`)
    ) {
      continue;
    }
    const targetPath = sourcePath.slice(0, -4);
    const renamed = await disableInstanceFile(sourcePath, targetPath);
    if (renamed) {
      disabled += 1;
    }
  }
  return disabled;
}

async function disableInstanceFile(sourcePath, targetPath) {
  const stat = await fsp.stat(sourcePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return false;
  }
  const original = await fsp.readFile(sourcePath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let renamedInstance = false;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*Instance:\s*)(\S+)(.*)$/);
    if (match) {
      lines[i] = `${match[1]}${match[2]}-disabled${match[3] || ''}`;
      renamedInstance = true;
      break;
    }
  }
  if (renamedInstance) {
    const updated = lines.join(newline);
    await fsp.writeFile(sourcePath, updated, 'utf8');
  }
  await fsp.rename(sourcePath, targetPath).catch(() => null);
  return true;
}

async function resolveAliasFilePath(rootDir) {
  const candidates = [
    path.join(rootDir, 'input', 'fsh', 'aliases.fsh'),
    path.join(rootDir, 'input', 'fsh', 'alias.fsh'),
    path.join(rootDir, 'aliases.fsh'),
    path.join(rootDir, 'alias.fsh'),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return { filePath: candidate, exists: true };
    }
  }
  return { filePath: candidates[0], exists: false };
}
