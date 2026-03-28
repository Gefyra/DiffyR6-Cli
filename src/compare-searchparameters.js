import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function compareSearchParameters(resourcesDir, outputDir, options = {}) {
  const { debug = false } = options;

  if (debug) {
    console.log('  Scanning CapabilityStatements for removed search parameters...');
  }

  const removedParams = await loadRemovedSearchParameters();
  const capabilityStatements = await collectCapabilityStatements(resourcesDir);
  const usedParams = extractUsedSearchParameters(capabilityStatements);
  const matches = findRemovedMatches(usedParams, removedParams);

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const reportFilename = `searchparameter-report-${timestamp}.md`;
  const reportPath = path.join(outputDir, reportFilename);
  const jsonFilename = `searchparameter-report-${timestamp}.json`;
  const jsonPath = path.join(outputDir, jsonFilename);

  const markdown = generateSearchParameterReport(matches);
  await fsp.writeFile(reportPath, markdown, 'utf8');

  const affectedCapabilityStatements = new Set(
    matches.map(match => match.capabilityStatement.id || match.capabilityStatement.url || match.capabilityStatement.sourceFile)
  );
  const jsonData = {
    generated: new Date().toISOString(),
    totalRemovedMatches: matches.length,
    affectedCapabilityStatements: affectedCapabilityStatements.size,
    matches,
  };
  await fsp.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');

  return {
    path: reportPath,
    filename: reportFilename,
    jsonPath,
    jsonFilename,
    matchCount: matches.length,
    affectedCpsCount: affectedCapabilityStatements.size,
  };
}

async function loadRemovedSearchParameters() {
  const configPath = path.resolve(__dirname, '..', 'config', 'searchparameters-r4-not-in-r6.json');
  const content = await fsp.readFile(configPath, 'utf8');
  const data = JSON.parse(content);
  return data.searchParameters || [];
}

async function collectCapabilityStatements(resourcesDir) {
  const files = await collectJsonFiles(resourcesDir);
  const capabilityStatements = [];
  const baseDir = path.resolve(resourcesDir);

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

    if (data?.resourceType !== 'CapabilityStatement') {
      continue;
    }

    capabilityStatements.push({
      id: data.id || '',
      url: data.url || '',
      name: data.name || data.title || data.id || path.basename(filePath, '.json'),
      sourceFile: path.relative(baseDir, filePath) || path.basename(filePath),
      data,
    });
  }

  return capabilityStatements;
}

function extractUsedSearchParameters(capabilityStatements) {
  const used = [];

  for (const capabilityStatement of capabilityStatements) {
    const restEntries = Array.isArray(capabilityStatement.data.rest) ? capabilityStatement.data.rest : [];

    for (const rest of restEntries) {
      const resources = Array.isArray(rest.resource) ? rest.resource : [];

      for (const resource of resources) {
        const resourceType = typeof resource.type === 'string' ? resource.type : '';
        const searchParams = Array.isArray(resource.searchParam) ? resource.searchParam : [];

        for (const searchParam of searchParams) {
          const name = normalizeString(searchParam.name || searchParam.code);
          const definition = normalizeString(searchParam.definition);

          if (!name && !definition) {
            continue;
          }

          used.push({
            name,
            definition,
            resourceType,
            capabilityStatementId: capabilityStatement.id,
            capabilityStatementUrl: capabilityStatement.url,
            capabilityStatementName: capabilityStatement.name,
            sourceFile: capabilityStatement.sourceFile,
          });
        }
      }
    }
  }

  return used;
}

function findRemovedMatches(usedParams, removedParams) {
  const removedByUrl = new Map();
  const removedByBaseAndCode = new Map();

  for (const removed of removedParams) {
    const url = normalizeString(removed.url);
    if (url) {
      removedByUrl.set(url, removed);
    }

    const bases = Array.isArray(removed.base) ? removed.base : [];
    for (const base of bases) {
      const key = buildBaseCodeKey(base, removed.code || removed.name);
      if (!key) {
        continue;
      }
      if (!removedByBaseAndCode.has(key)) {
        removedByBaseAndCode.set(key, []);
      }
      removedByBaseAndCode.get(key).push(removed);
    }
  }

  const seen = new Set();
  const matches = [];

  for (const used of usedParams) {
    let removed = null;
    let matchedBy = '';

    if (used.definition && removedByUrl.has(used.definition)) {
      removed = removedByUrl.get(used.definition);
      matchedBy = 'definition';
    } else if (used.resourceType && used.name) {
      const fallbackMatches = removedByBaseAndCode.get(buildBaseCodeKey(used.resourceType, used.name)) || [];
      if (fallbackMatches.length > 0) {
        removed = fallbackMatches[0];
        matchedBy = 'name+base';
      }
    }

    if (!removed) {
      continue;
    }

    const matchKey = [
      removed.url || removed.id || removed.code,
      used.capabilityStatementId || used.capabilityStatementUrl || used.sourceFile,
      used.resourceType,
      used.name,
      used.definition,
    ].join('::').toLowerCase();

    if (seen.has(matchKey)) {
      continue;
    }
    seen.add(matchKey);

    matches.push({
      removedSearchParameter: {
        id: removed.id || '',
        name: removed.name || '',
        code: removed.code || '',
        url: removed.url || '',
        base: Array.isArray(removed.base) ? removed.base : [],
        type: removed.type || '',
        description: removed.description || '',
      },
      capabilityStatement: {
        id: used.capabilityStatementId || '',
        url: used.capabilityStatementUrl || '',
        name: used.capabilityStatementName || '',
        sourceFile: used.sourceFile,
      },
      resourceType: used.resourceType,
      searchParameter: {
        name: used.name,
        definition: used.definition,
      },
      matchedBy,
    });
  }

  return matches.sort(compareMatches);
}

function generateSearchParameterReport(matches) {
  const lines = [];
  const generated = new Date().toISOString();
  const affectedCapabilityStatements = new Set(
    matches.map(match => match.capabilityStatement.id || match.capabilityStatement.url || match.capabilityStatement.sourceFile)
  );

  lines.push('# Search Parameter Report');
  lines.push('');
  lines.push(`**Generated:** ${generated}`);
  lines.push(`**Removed search parameter matches:** ${matches.length}`);
  lines.push(`**Affected CapabilityStatements:** ${affectedCapabilityStatements.size}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (matches.length === 0) {
    lines.push('No CapabilityStatements were found that reference search parameters removed in FHIR R6.');
    lines.push('');
    return lines.join('\n');
  }

  const grouped = new Map();
  for (const match of matches) {
    const key = match.removedSearchParameter.url || `${match.removedSearchParameter.code}::${match.resourceType}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(match);
  }

  for (const key of Array.from(grouped.keys()).sort()) {
    const group = grouped.get(key);
    const first = group[0];
    const removed = first.removedSearchParameter;

    lines.push(`## ${removed.code || removed.name || removed.id}`);
    lines.push('');
    lines.push(`**Resource Type:** ${(removed.base || []).join(', ') || first.resourceType || 'Unknown'}`);
    lines.push(`**Definition:** ${removed.url || 'n/a'}`);
    lines.push(`**Matches:** ${group.length}`);
    if (removed.description) {
      lines.push(`**Description:** ${removed.description}`);
    }
    lines.push('');
    lines.push('Affected CapabilityStatements:');
    lines.push('');

    for (const match of group) {
      const cpsLabel =
        match.capabilityStatement.name ||
        match.capabilityStatement.id ||
        match.capabilityStatement.url ||
        path.basename(match.capabilityStatement.sourceFile);
      lines.push(`- **${cpsLabel}**`);
      lines.push(`  Resource: ${match.resourceType || 'Unknown'}`);
      lines.push(`  Parameter: ${match.searchParameter.name || 'n/a'}`);
      lines.push(`  Match: ${match.matchedBy}`);
      if (match.searchParameter.definition) {
        lines.push(`  Definition: ${match.searchParameter.definition}`);
      }
      lines.push(`  Source: ${match.capabilityStatement.sourceFile}`);
    }

    lines.push('');
  }

  return lines.join('\n');
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

function buildBaseCodeKey(base, code) {
  const normalizedBase = normalizeString(base);
  const normalizedCode = normalizeString(code);
  if (!normalizedBase || !normalizedCode) {
    return '';
  }
  return `${normalizedBase}::${normalizedCode}`;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function compareMatches(a, b) {
  return (
    compareStrings(a.removedSearchParameter.code, b.removedSearchParameter.code) ||
    compareStrings(a.resourceType, b.resourceType) ||
    compareStrings(a.capabilityStatement.name || a.capabilityStatement.id, b.capabilityStatement.name || b.capabilityStatement.id) ||
    compareStrings(a.searchParameter.name, b.searchParameter.name)
  );
}

function compareStrings(a, b) {
  return (a || '').localeCompare(b || '');
}
