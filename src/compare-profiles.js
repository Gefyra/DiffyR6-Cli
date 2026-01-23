import fsp from 'fs/promises';
import path from 'path';
import { createAnimator, spawnProcess } from './utils/process.js';
import { ensureValidator } from './utils/validator.js';

const MAGNIFIER_FRAMES = [
  '🔎     ~~~~~',
  ' 🔎    ~~~~~',
  '  🔎   ~~~~~',
  '   🔎  ~~~~~',
  '    🔎 ~~~~~',
  '    🔍 ~~~~~',
  '   🔍  ~~~~~',
  '  🔍   ~~~~~',
  ' 🔍    ~~~~~',
  '🔍     ~~~~~',
];

/**
 * Compares R4 and R6 FHIR profiles using the validator CLI
 */
export async function compareProfiles(r4Dir, r6Dir, destDir, options = {}) {
  const {
    jarPath = 'validator_cli.jar',
    fhirVersion = '4.0',
    debug = false,
    workingDirectory = process.cwd(),
  } = options;

  await ensureDirectory(r4Dir, 'R4 directory');
  await ensureDirectory(r6Dir, 'R6 directory');
  
  // Ensure validator JAR exists (auto-download if jarPath is null)
  const resolvedJarPath = await ensureValidator(jarPath, workingDirectory);
  
  await fsp.mkdir(destDir, { recursive: true });

  const r4Defs = (await collectStructureDefinitions(r4Dir)).sort((a, b) =>
    a.url.localeCompare(b.url)
  );
  const r6Defs = (await collectStructureDefinitions(r6Dir)).sort((a, b) =>
    a.url.localeCompare(b.url)
  );

  if (r4Defs.length === 0) {
    throw new Error(`No StructureDefinitions found in ${r4Dir}`);
  }
  if (r6Defs.length === 0) {
    throw new Error(`No StructureDefinitions found in ${r6Dir}`);
  }

  const pairs = buildComparisonPairs(r4Defs, r6Defs);
  if (pairs.length === 0) {
    throw new Error('No matching profile pairs found between R4 and R6');
  }

  console.log(`Found ${pairs.length} profile pair(s) to compare`);

  const igPaths = [
    path.join(r4Dir, 'fsh-generated', 'resources'),
    path.join(r6Dir, 'fsh-generated', 'resources'),
  ];
  
  // Filter to only existing IG paths
  const validIgPaths = [];
  for (const igPath of igPaths) {
    const stat = await fsp.stat(igPath).catch(() => null);
    if (stat && stat.isDirectory()) {
      validIgPaths.push(igPath);
    }
  }
  
  if (validIgPaths.length === 0) {
    console.warn('Warning: No fsh-generated/resources directories found for IG paths');
  }
  
  const existingFiles = await collectExistingComparisonFiles(destDir);

  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    const label = `[${i + 1}/${pairs.length}] ${pair.displayName}`;
    console.log(`\n${label}`);
    const comparisonFile = buildComparisonFileName(pair.left.url, pair.right.url);
    if (comparisonFile && existingFiles.has(comparisonFile)) {
      console.log(`  Skipping ${pair.displayName} (${comparisonFile} exists)`);
      continue;
    }
    await runValidatorCompare({
      jarPath: resolvedJarPath,
      destDir,
      version: fhirVersion,
      leftUrl: pair.left.url,
      rightUrl: pair.right.url,
      workingDirectory,
      spinnerLabel: `Comparing ${pair.displayName}...`,
      igPaths: validIgPaths,
      debug,
    });
    if (comparisonFile) {
      existingFiles.add(comparisonFile);
    }
    console.log(`  Done: ${pair.displayName}`);
  }

  return {
    comparedCount: pairs.length,
    skippedCount: pairs.filter((p) => {
      const fileName = buildComparisonFileName(p.left.url, p.right.url);
      return fileName && existingFiles.has(fileName);
    }).length,
  };
}

async function ensureDirectory(dirPath, label) {
  const stat = await fsp.stat(dirPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`${label} not found: ${dirPath}`);
  }
}



async function collectStructureDefinitions(rootDir) {
  const resourcesDir = path.join(rootDir, 'fsh-generated', 'resources');
  const stat = await fsp.stat(resourcesDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return [];
  }
  const files = await collectJsonFiles(resourcesDir);
  const results = [];
  for (const filePath of files) {
    let data;
    try {
      data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (!data || data.resourceType !== 'StructureDefinition' || !data.url) {
      continue;
    }
    results.push({
      url: data.url,
      id: data.id || '',
      name: data.name || '',
      filePath,
    });
  }
  return results;
}

async function collectJsonFiles(dir) {
  const results = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        results.push(entryPath);
      }
    }
  }
  await walk(dir);
  return results;
}

function buildComparisonPairs(r4Defs, r6Defs) {
  const lookup = buildR4Lookup(r4Defs);
  const pairs = [];
  for (const right of r6Defs) {
    const left = findMatchingR4Definition(right.url, lookup);
    if (!left) {
      console.warn(`  No R4 match for ${right.url}, skipping`);
      continue;
    }
    const displayName = extractLastSegment(right.url) || right.name || right.id || right.url;
    pairs.push({
      left,
      right,
      displayName,
    });
  }
  return pairs;
}

function buildR4Lookup(definitions) {
  const byCanonical = new Map();
  const bySegment = new Map();
  for (const def of definitions) {
    const canonicalKey = def.url.toLowerCase();
    byCanonical.set(canonicalKey, def);
    const segment = extractLastSegment(def.url).toLowerCase();
    if (!bySegment.has(segment)) {
      bySegment.set(segment, []);
    }
    bySegment.get(segment).push(def);
  }
  return { byCanonical, bySegment };
}

function findMatchingR4Definition(r6Url, lookup) {
  if (!r6Url) {
    return null;
  }
  const canonicalKey = r6Url.toLowerCase();
  if (lookup.byCanonical.has(canonicalKey)) {
    return lookup.byCanonical.get(canonicalKey);
  }

  const lastSegment = extractLastSegment(r6Url);
  const variants = generateCanonicalVariants(r6Url, lastSegment);
  for (const candidate of variants) {
    const key = candidate.toLowerCase();
    if (lookup.byCanonical.has(key)) {
      return lookup.byCanonical.get(key);
    }
  }

  const segmentVariants = generateSegmentVariants(lastSegment);
  for (const seg of segmentVariants) {
    const entries = lookup.bySegment.get(seg);
    if (entries && entries.length === 1) {
      return entries[0];
    }
  }

  return null;
}

function generateCanonicalVariants(url, lastSegment) {
  if (!lastSegment) {
    return [];
  }
  const variants = new Set();

  const replacedR6WithR4 = lastSegment.replace(/-?r6$/i, '-R4');
  if (replacedR6WithR4 !== lastSegment) {
    variants.add(replaceLastSegment(url, replacedR6WithR4));
  }

  const removedR6 = lastSegment.replace(/-?r6$/i, '');
  if (removedR6 !== lastSegment) {
    variants.add(replaceLastSegment(url, removedR6));
  }

  if (!/-?r4$/i.test(lastSegment)) {
    variants.add(replaceLastSegment(url, `${lastSegment}-R4`));
    variants.add(replaceLastSegment(url, `${lastSegment}R4`));
  } else {
    variants.add(replaceLastSegment(url, lastSegment.replace(/-?r4$/i, '')));
  }
  return [...variants].filter(Boolean);
}

function generateSegmentVariants(segment) {
  if (!segment) {
    return [];
  }
  const variants = new Set();
  const lower = segment.toLowerCase();
  variants.add(lower);

  if (lower.endsWith('-r6')) {
    variants.add(lower.replace(/-r6$/, '-r4'));
    variants.add(lower.replace(/-r6$/, ''));
  }

  if (lower.endsWith('r6')) {
    variants.add(lower.replace(/r6$/, 'r4'));
    variants.add(lower.replace(/r6$/, ''));
  }

  if (lower.endsWith('-r4')) {
    variants.add(lower.replace(/-r4$/, ''));
  } else if (lower.endsWith('r4')) {
    variants.add(lower.replace(/r4$/, ''));
  } else {
    variants.add(`${lower}-r4`);
    variants.add(`${lower}r4`);
  }
  return [...variants].filter(Boolean);
}

function extractLastSegment(url) {
  if (!url) {
    return '';
  }
  const hashIndex = url.lastIndexOf('#');
  const slashIndex = url.lastIndexOf('/');
  const index = Math.max(hashIndex, slashIndex);
  return index >= 0 ? url.slice(index + 1) : url;
}

function replaceLastSegment(url, newSegment) {
  if (!url) {
    return '';
  }
  const hashIndex = url.lastIndexOf('#');
  const slashIndex = url.lastIndexOf('/');
  const index = Math.max(hashIndex, slashIndex);
  if (index === -1) {
    return newSegment;
  }
  return `${url.slice(0, index + 1)}${newSegment}`;
}

async function collectExistingComparisonFiles(destDir) {
  const entries = await fsp.readdir(destDir).catch(() => []);
  return new Set(entries.filter((name) => name.toLowerCase().endsWith('.html')));
}

function buildComparisonFileName(leftUrl, rightUrl) {
  const leftSegment = sanitizeSegment(extractLastSegment(leftUrl));
  const rightSegment = sanitizeSegment(extractLastSegment(rightUrl));
  if (!leftSegment || !rightSegment) {
    return null;
  }
  return `sd-${leftSegment}-${rightSegment}.html`;
}

function sanitizeSegment(value) {
  return (value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

async function runValidatorCompare({
  jarPath,
  destDir,
  version,
  leftUrl,
  rightUrl,
  workingDirectory,
  spinnerLabel,
  igPaths = [],
  debug,
}) {
  const args = [
    '-Djava.awt.headless=true',
    '-jar',
    jarPath,
    '-compare',
    '-dest',
    destDir,
    '-version',
    version,
    '-right',
    rightUrl,
    '-left',
    leftUrl,
  ];
  igPaths.filter(Boolean).forEach((igPath) => {
    args.push('-ig', igPath);
  });
  
  let animator = null;
  if (!debug) {
    animator = createAnimator(spinnerLabel, { frames: MAGNIFIER_FRAMES });
    animator.start();
  } else {
    console.log(`  ${spinnerLabel}`);
  }
  
  try {
    const spawnOptions = debug ? { stdio: 'inherit' } : {};
    const result = await spawnProcess('java', args, workingDirectory, spawnOptions);
    if (debug && result) {
      // Output already shown via inherit, no need to print again
    }
  } finally {
    if (animator) {
      animator.stop();
    }
  }
}

function printProcessOutput({ stdout, stderr }, leftUrl, rightUrl) {
  const header = `--- Validator output for ${rightUrl} vs ${leftUrl} ---`;
  console.log(header);
  if (stdout && stdout.trim()) {
    console.log(stdout.trimEnd());
  }
  if (stderr && stderr.trim()) {
    console.error(stderr.trimEnd());
  }
  console.log('-'.repeat(header.length));
}
