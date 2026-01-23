import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Identifies R4 profiles that are based on resource types removed in R6
 * @param {string} r4Dir - R4 resources directory
 * @returns {Promise<Array<{profile: string, resource: string}>>}
 */
export async function findRemovedResources(r4Dir) {
  // Load list of resources removed in R6
  const removedResourceTypes = await loadRemovedResourceTypes();
  const removedSet = new Set(removedResourceTypes);
  
  // Read R4 profiles
  const r4Profiles = await readProfileResources(r4Dir);
  
  // Filter profiles based on removed resource types
  const removed = [];
  for (const { profile, resource } of r4Profiles) {
    if (removedSet.has(resource)) {
      removed.push({ profile, resource });
    }
  }
  
  return removed;
}

/**
 * Loads the list of resource types that were removed in R6
 */
async function loadRemovedResourceTypes() {
  const configPath = path.resolve(__dirname, '..', '..', 'config', 'resources-r4-not-in-r6.json');
  const content = await fsp.readFile(configPath, 'utf8');
  const data = JSON.parse(content);
  return data.resources || [];
}

/**
 * Reads all StructureDefinition profiles from a directory
 */
async function readProfileResources(baseDir) {
  const resourcesDir = path.join(baseDir, 'fsh-generated', 'resources');
  const stat = await fsp.stat(resourcesDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return [];
  }
  
  const files = await collectJsonFiles(resourcesDir);
  const results = [];
  const seen = new Set();
  
  for (const filePath of files) {
    const raw = await fsp.readFile(filePath, 'utf8').catch(() => '');
    if (!raw) {
      continue;
    }
    
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    
    if (!data || data.resourceType !== 'StructureDefinition') {
      continue;
    }
    
    const resource = resolveProfileResourceType(data);
    const profile =
      data.title ||
      data.name ||
      data.id ||
      extractLastSegment(data.url) ||
      path.basename(filePath, '.json');
    
    if (!resource || !profile) {
      continue;
    }
    
    const key = `${profile}::${resource}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    
    seen.add(key);
    results.push({ profile, resource });
  }
  
  return results;
}

async function collectJsonFiles(dir) {
  const results = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectJsonFiles(entryPath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      results.push(entryPath);
    }
  }
  return results;
}

function resolveProfileResourceType(data) {
  if (!data || typeof data !== 'object') {
    return '';
  }
  if (typeof data.type === 'string' && data.type) {
    return data.type;
  }
  if (typeof data.baseDefinition === 'string' && data.baseDefinition) {
    return extractLastSegment(data.baseDefinition);
  }
  return '';
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
