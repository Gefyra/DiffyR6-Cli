import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { createAnimator, spawnProcess } from './utils/process.js';
import { directoryExists, fileExists } from './utils/fs.js';

/**
 * Compares terminology bindings between R4 and R6 profiles
 * 
 * Steps:
 * 1. Find all profile pairs from the comparison run
 * 2. Compare element[].binding.strength and valueSet between R4 and R6
 * 3. If valueSet has a version (pipe notation), compare the actual ValueSet content from local package cache
 * 4. Generate a markdown report with all findings
 * 
 * Note: Snapshots must already exist (built by runSnapshotBuild in index.js before calling this function)
 * 
 * @param {string} resourcesDir - R4 resources directory
 * @param {string} resourcesR6Dir - R6 resources directory
 * @param {string} outputDir - Output directory for the report
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Report info with path and findings count
 */
export async function compareTerminology(resourcesDir, resourcesR6Dir, outputDir, options = {}) {
  const { debug = false } = options;
  
  console.log('  Analyzing binding differences...');
  
  // Collect profile pairs and compare bindings
  const r4Profiles = await collectStructureDefinitions(resourcesDir);
  const r6Profiles = await collectStructureDefinitions(resourcesR6Dir);
  
  const pairs = buildProfilePairs(r4Profiles, r6Profiles);
  
  if (pairs.length === 0) {
    console.log('  No matching profile pairs found');
    return null;
  }
  
  const findings = [];
  
  for (const pair of pairs) {
    const profileFindings = await compareProfileBindings(pair.r4, pair.r6, options);
    if (profileFindings.length > 0) {
      findings.push({
        profileName: pair.name,
        r4Url: pair.r4.url,
        r6Url: pair.r6.url,
        findings: profileFindings,
      });
    }
  }
  
  console.log(`  Found ${findings.length} profile(s) with binding differences`);
  
  // Identify common bindings across all profiles
  const commonBindings = sortFindings(identifyCommonBindings(findings));
  
  // Remove common bindings from individual profiles
  const filteredFindings = removeCommonBindingsFromProfiles(findings, commonBindings).map(profile => ({
    ...profile,
    findings: sortFindings(profile.findings),
  }));
  
  // Generate reports
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const reportFilename = `terminology-report-${timestamp}.md`;
  const reportPath = path.join(outputDir, reportFilename);
  const jsonFilename = `terminology-report-${timestamp}.json`;
  const jsonPath = path.join(outputDir, jsonFilename);
  
  // Generate markdown report
  const markdown = generateTerminologyReport(filteredFindings, commonBindings);
  await fsp.writeFile(reportPath, markdown, 'utf8');
  
  // Generate JSON report
  const jsonData = {
    generated: new Date().toISOString(),
    profilesWithDifferences: filteredFindings.length,
    totalFindings: filteredFindings.reduce((sum, p) => sum + p.findings.length, 0) + commonBindings.length,
    commonBindings,
    profiles: filteredFindings,
  };
  await fsp.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
  
  const totalFindings = filteredFindings.reduce((sum, p) => sum + p.findings.length, 0);
  
  return {
    path: reportPath,
    filename: reportFilename,
    jsonPath,
    jsonFilename,
    profilesWithDifferences: filteredFindings.length,
    totalFindings,
  };
}

/**
 * Check if snapshots already exist in the StructureDefinition files
 */
export async function hasSnapshots(dir) {
  const resourcesPath = path.join(dir, 'fsh-generated', 'resources');
  const exists = await directoryExists(resourcesPath);
  
  if (!exists) {
    return false;
  }
  
  const files = await fsp.readdir(resourcesPath);
  
  // Check if at least one StructureDefinition has a snapshot
  for (const file of files) {
    if (!file.startsWith('StructureDefinition-') || !file.endsWith('.json')) {
      continue;
    }
    
    try {
      const filePath = path.join(resourcesPath, file);
      const content = await fsp.readFile(filePath, 'utf8');
      const data = JSON.parse(content);
      
      if (data.resourceType === 'StructureDefinition' && data.snapshot && data.snapshot.element) {
        // Found at least one StructureDefinition with snapshot
        return true;
      }
    } catch (error) {
      // Skip files that can't be read or parsed
      continue;
    }
  }
  
  return false;
}

/**
 * Run sushi with snapshots flag in a directory
 */
export async function runSushiWithSnapshots(dir, debug = false) {
  const sushiConfigPath = path.join(dir, 'sushi-config.yaml');
  const exists = await fileExists(sushiConfigPath);
  
  if (!exists) {
    throw new Error(`sushi-config.yaml not found in ${dir}`);
  }
  
  const dirName = path.basename(dir);
  const animator = createAnimator(`SUSHI building snapshots for ${dirName}...`);
  animator.start();
  
  try {
    const result = await spawnProcess('sushi', ['-s'], dir, {
      rejectOnNonZero: true,
    });
    
    if (result.exitCode !== 0) {
      if (debug) {
        console.error('SUSHI stderr:', result.stderr);
      }
      throw new Error(`SUSHI failed in ${dir}: exit code ${result.exitCode}`);
    }
  } finally {
    animator.stop();
  }
}

/**
 * Collect StructureDefinition files from a directory
 */
async function collectStructureDefinitions(rootDir) {
  const resourcesPath = path.join(rootDir, 'fsh-generated', 'resources');
  const exists = await directoryExists(resourcesPath);
  
  if (!exists) {
    return [];
  }
  
  const files = await fsp.readdir(resourcesPath);
  const definitions = [];
  
  for (const file of files) {
    if (!file.startsWith('StructureDefinition-') || !file.endsWith('.json')) {
      continue;
    }
    
    const filePath = path.join(resourcesPath, file);
    const content = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    
    if (data.resourceType === 'StructureDefinition' && data.url) {
      definitions.push({
        url: data.url,
        id: data.id || '',
        name: data.name || '',
        filePath,
        data,
      });
    }
  }
  
  return definitions;
}

/**
 * Build profile pairs for comparison
 */
function buildProfilePairs(r4Profiles, r6Profiles) {
  const pairs = [];
  
  // Create a map of R4 profiles by their last segment
  const r4Map = new Map();
  for (const r4 of r4Profiles) {
    const segment = extractLastSegment(r4.url).toLowerCase();
    r4Map.set(segment, r4);
  }
  
  // Match R6 profiles to R4 profiles
  for (const r6 of r6Profiles) {
    const r6Segment = extractLastSegment(r6.url).toLowerCase();
    
    // Try direct match
    let r4 = r4Map.get(r6Segment);
    
    // Try without version suffix
    if (!r4) {
      const withoutR6 = r6Segment.replace(/-?r6$/i, '');
      r4 = r4Map.get(withoutR6) || r4Map.get(withoutR6 + '-r4') || r4Map.get(withoutR6 + 'r4');
    }
    
    if (r4) {
      pairs.push({
        name: r6.name || r6.id || extractLastSegment(r6.url),
        r4,
        r6,
      });
    }
  }
  
  return pairs;
}

/**
 * Extract last segment from URL
 */
function extractLastSegment(url) {
  if (!url) return '';
  const hashIndex = url.lastIndexOf('#');
  const slashIndex = url.lastIndexOf('/');
  const index = Math.max(hashIndex, slashIndex);
  return index >= 0 ? url.slice(index + 1) : url;
}

/**
 * Compare bindings between two profiles
 */
async function compareProfileBindings(r4Profile, r6Profile, options = {}) {
  const findings = [];
  
  // Get snapshots from both profiles
  const r4Snapshot = r4Profile.data.snapshot?.element || [];
  const r6Snapshot = r6Profile.data.snapshot?.element || [];
  
  // Create maps of elements by path
  const r4Elements = new Map();
  for (const elem of r4Snapshot) {
    if (elem.binding) {
      r4Elements.set(elem.path, elem);
    }
  }
  
  const r6Elements = new Map();
  for (const elem of r6Snapshot) {
    if (elem.binding) {
      r6Elements.set(elem.path, elem);
    }
  }
  
  // Compare bindings for each element
  for (const [path, r6Elem] of r6Elements) {
    const r4Elem = r4Elements.get(path);
    
    if (!r4Elem) {
      // New binding in R6
      findings.push({
        type: 'new-binding',
        path,
        isMustSupport: isMustSupportElement(r6Elem),
        r6Binding: r6Elem.binding,
      });
      continue;
    }
    
    const r4Binding = r4Elem.binding;
    const r6Binding = r6Elem.binding;
    
    // Check what changed
    const strengthChanged = r4Binding.strength !== r6Binding.strength;
    const valueSetChanged = r4Binding.valueSet !== r6Binding.valueSet;
    
    // If both changed, create a combined finding
    if (strengthChanged && valueSetChanged) {
      const finding = {
        type: 'strength-and-valueset-change',
        path,
        isMustSupport: isMustSupportElement(r4Elem) || isMustSupportElement(r6Elem),
        r4Strength: r4Binding.strength,
        r6Strength: r6Binding.strength,
        r4ValueSet: r4Binding.valueSet,
        r6ValueSet: r6Binding.valueSet,
      };
      
      // If both have version, compare content
      if (hasVersion(r4Binding.valueSet) && hasVersion(r6Binding.valueSet)) {
        const contentDiff = await compareValueSetContent(
          r4Binding.valueSet,
          r6Binding.valueSet,
          options
        );
        
        if (contentDiff) {
          finding.contentDifference = contentDiff;
        }
      }
      
      // Check if only version differs and no content changes
      const onlyVersionChange = onlyVersionDiffers(r4Binding.valueSet, r6Binding.valueSet);
      const hasContentChanges = finding.contentDifference && 
                                 !finding.contentDifference.message &&
                                 (finding.contentDifference.addedCount > 0 || 
                                  finding.contentDifference.removedCount > 0);
      
      // If only version differs and no content changes, treat as strength-change only
      if (onlyVersionChange && !hasContentChanges) {
        findings.push({
          type: 'strength-change',
          path,
          isMustSupport: isMustSupportElement(r4Elem) || isMustSupportElement(r6Elem),
          r4Strength: r4Binding.strength,
          r6Strength: r6Binding.strength,
          r4ValueSet: r4Binding.valueSet,
          r6ValueSet: r6Binding.valueSet,
        });
      } else {
        findings.push(finding);
      }
    } else if (strengthChanged) {
      // Only strength changed
      findings.push({
        type: 'strength-change',
        path,
        isMustSupport: isMustSupportElement(r4Elem) || isMustSupportElement(r6Elem),
        r4Strength: r4Binding.strength,
        r6Strength: r6Binding.strength,
        r4ValueSet: r4Binding.valueSet,
        r6ValueSet: r6Binding.valueSet,
      });
    } else if (valueSetChanged) {
      // Only valueSet changed
      const finding = {
        type: 'valueset-change',
        path,
        isMustSupport: isMustSupportElement(r4Elem) || isMustSupportElement(r6Elem),
        r4ValueSet: r4Binding.valueSet,
        r6ValueSet: r6Binding.valueSet,
        r4Strength: r4Binding.strength,
        r6Strength: r6Binding.strength,
      };
      
      // If both have version, compare content
      if (hasVersion(r4Binding.valueSet) && hasVersion(r6Binding.valueSet)) {
        const contentDiff = await compareValueSetContent(
          r4Binding.valueSet,
          r6Binding.valueSet,
          options
        );
        
        if (contentDiff) {
          finding.contentDifference = contentDiff;
        }
      }
      
      // Skip if only version differs and no content changes
      const onlyVersionChange = onlyVersionDiffers(r4Binding.valueSet, r6Binding.valueSet);
      const hasContentChanges = finding.contentDifference && 
                                 !finding.contentDifference.message &&
                                 (finding.contentDifference.addedCount > 0 || 
                                  finding.contentDifference.removedCount > 0);
      
      // Only add finding if:
      // - Version is different AND there are content changes, OR
      // - The base URL is different (not just version)
      if (!onlyVersionChange || hasContentChanges) {
        findings.push(finding);
      }
    }
  }
  
  // Check for removed bindings
  for (const [path, r4Elem] of r4Elements) {
    if (!r6Elements.has(path)) {
      findings.push({
        type: 'removed-binding',
        path,
        isMustSupport: isMustSupportElement(r4Elem),
        r4Binding: r4Elem.binding,
      });
    }
  }
  
  return findings;
}

function isMustSupportElement(element) {
  return element?.mustSupport === true;
}

/**
 * Check if valueSet URL has a version (pipe notation)
 */
function hasVersion(valueSetUrl) {
  return valueSetUrl && valueSetUrl.includes('|');
}

/**
 * Check if two ValueSet URLs differ only in version
 */
function onlyVersionDiffers(url1, url2) {
  if (!url1 || !url2) return false;
  
  // Extract base URLs (without version)
  const base1 = url1.split('|')[0];
  const base2 = url2.split('|')[0];
  
  // If base URLs are the same, they only differ in version
  return base1 === base2;
}

/**
 * Compare ValueSet content from local package cache
 */
async function compareValueSetContent(r4ValueSetUrl, r6ValueSetUrl, options = {}) {
  try {
    const r4ValueSet = await loadValueSetFromCache(r4ValueSetUrl, '4.0.1');
    const r6ValueSet = await loadValueSetFromCache(r6ValueSetUrl, '6.0.0-ballot3');
    
    if (!r4ValueSet || !r6ValueSet) {
      return { message: 'Could not load ValueSets from cache' };
    }
    
    // Extract all codes from both ValueSets
    const r4Codes = await extractCodesFromValueSet(r4ValueSet, '4.0.1');
    const r6Codes = await extractCodesFromValueSet(r6ValueSet, '6.0.0-ballot3');
    
    // Compare codes
    const r4CodeSet = new Set(r4Codes.map(c => `${c.system}|${c.code}`));
    const r6CodeSet = new Set(r6Codes.map(c => `${c.system}|${c.code}`));
    
    const addedCodes = [];
    const removedCodes = [];
    
    // Find added codes
    for (const codeKey of r6CodeSet) {
      if (!r4CodeSet.has(codeKey)) {
        const code = r6Codes.find(c => `${c.system}|${c.code}` === codeKey);
        addedCodes.push(code);
      }
    }
    
    // Find removed codes
    for (const codeKey of r4CodeSet) {
      if (!r6CodeSet.has(codeKey)) {
        const code = r4Codes.find(c => `${c.system}|${c.code}` === codeKey);
        removedCodes.push(code);
      }
    }
    
    if (addedCodes.length === 0 && removedCodes.length === 0) {
      return null; // No difference in codes
    }
    
    return {
      r4TotalCodes: r4Codes.length,
      r6TotalCodes: r6Codes.length,
      addedCodes: addedCodes.slice(0, 20), // Limit to first 20 for readability
      removedCodes: removedCodes.slice(0, 20), // Limit to first 20 for readability
      addedCount: addedCodes.length,
      removedCount: removedCodes.length,
    };
  } catch (error) {
    return { message: `Error comparing ValueSets: ${error.message}` };
  }
}

/**
 * Extract all codes from a ValueSet by processing compose.include
 */
async function extractCodesFromValueSet(valueSet, fhirVersion) {
  const codes = [];
  
  if (!valueSet.compose || !valueSet.compose.include) {
    return codes;
  }
  
  for (const include of valueSet.compose.include) {
    const system = include.system;
    
    if (!system) {
      continue;
    }
    
    // If specific concepts are listed, use those
    if (include.concept && include.concept.length > 0) {
      for (const concept of include.concept) {
        codes.push({
          system,
          code: concept.code,
          display: concept.display,
        });
      }
    } else {
      // Otherwise, try to load the entire CodeSystem
      const codeSystem = await loadCodeSystemFromCache(system, fhirVersion);
      if (codeSystem && codeSystem.concept) {
        for (const concept of codeSystem.concept) {
          addConceptAndChildren(codes, system, concept);
        }
      }
    }
  }
  
  // Handle excludes
  if (valueSet.compose.exclude) {
    const excludedCodes = new Set();
    
    for (const exclude of valueSet.compose.exclude) {
      const system = exclude.system;
      
      if (exclude.concept) {
        for (const concept of exclude.concept) {
          excludedCodes.add(`${system}|${concept.code}`);
        }
      }
    }
    
    // Filter out excluded codes
    return codes.filter(c => !excludedCodes.has(`${c.system}|${c.code}`));
  }
  
  return codes;
}

/**
 * Recursively add concept and its children to the codes array
 */
function addConceptAndChildren(codes, system, concept) {
  codes.push({
    system,
    code: concept.code,
    display: concept.display,
  });
  
  if (concept.concept && concept.concept.length > 0) {
    for (const child of concept.concept) {
      addConceptAndChildren(codes, system, child);
    }
  }
}

/**
 * Load a CodeSystem from the local FHIR package cache
 */
async function loadCodeSystemFromCache(codeSystemUrl, fhirVersion) {
  // Extract base URL without version
  const [baseUrl] = codeSystemUrl.split('|');
  
  // Determine package path based on FHIR version
  const userProfile = os.homedir();
  let packagePath;
  
  if (fhirVersion.startsWith('4.')) {
    packagePath = path.join(userProfile, '.fhir', 'packages', 'hl7.fhir.r4.core#4.0.1', 'package');
  } else if (fhirVersion.startsWith('6.')) {
    packagePath = path.join(userProfile, '.fhir', 'packages', 'hl7.fhir.r6.core#6.0.0-ballot3', 'package');
  } else {
    return null;
  }
  
  // Check if package exists
  const exists = await directoryExists(packagePath);
  if (!exists) {
    return null;
  }
  
  // Search for CodeSystem file
  const files = await fsp.readdir(packagePath);
  
  for (const file of files) {
    if (!file.startsWith('CodeSystem-') || !file.endsWith('.json')) {
      continue;
    }
    
    try {
      const filePath = path.join(packagePath, file);
      const content = await fsp.readFile(filePath, 'utf8');
      const data = JSON.parse(content);
      
      if (data.resourceType === 'CodeSystem' && data.url === baseUrl) {
        return data;
      }
    } catch (error) {
      // Skip files that can't be read or parsed
      continue;
    }
  }
  
  return null;
}

/**
 * Load a ValueSet from the local FHIR package cache
 */
async function loadValueSetFromCache(valueSetUrl, fhirVersion) {
  // Extract base URL without version
  const [baseUrl, version] = valueSetUrl.split('|');
  
  // Determine package path based on FHIR version
  const userProfile = os.homedir();
  let packagePath;
  
  if (fhirVersion.startsWith('4.')) {
    packagePath = path.join(userProfile, '.fhir', 'packages', 'hl7.fhir.r4.core#4.0.1', 'package');
  } else if (fhirVersion.startsWith('6.')) {
    packagePath = path.join(userProfile, '.fhir', 'packages', 'hl7.fhir.r6.core#6.0.0-ballot3', 'package');
  } else {
    return null;
  }
  
  // Check if package exists
  const exists = await directoryExists(packagePath);
  if (!exists) {
    return null;
  }
  
  // Search for ValueSet file
  const files = await fsp.readdir(packagePath);
  
  for (const file of files) {
    if (!file.startsWith('ValueSet-') || !file.endsWith('.json')) {
      continue;
    }
    
    const filePath = path.join(packagePath, file);
    const content = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    
    if (data.resourceType === 'ValueSet' && data.url === baseUrl) {
      return data;
    }
  }
  
  return null;
}

/**
 * Identify bindings that are common across all profiles
 */
function identifyCommonBindings(findings) {
  if (findings.length === 0) {
    return [];
  }
  
  // Build a map of finding signatures to count occurrences
  const signatureMap = new Map();
  
  for (const profile of findings) {
    const seenSignatures = new Set();
    
    for (const finding of profile.findings) {
      // Create a signature for this finding (without the path's resource type prefix)
      const pathWithoutResource = finding.path.replace(/^[^.]+\./, '');
      const signature = createFindingSignature(finding, pathWithoutResource);
      
      if (!seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        
        if (!signatureMap.has(signature)) {
          signatureMap.set(signature, {
            count: 0,
            finding: { ...finding, path: pathWithoutResource },
          });
        }
        signatureMap.get(signature).count++;
      }
    }
  }
  
  // Filter to findings that appear in all profiles
  const commonFindings = [];
  for (const [signature, data] of signatureMap) {
    if (data.count === findings.length) {
      commonFindings.push(data.finding);
    }
  }
  
  return commonFindings;
}

/**
 * Create a signature for a finding to identify identical changes
 */
function createFindingSignature(finding, pathWithoutResource) {
  const parts = [
    finding.type,
    pathWithoutResource,
    finding.r4ValueSet || '',
    finding.r6ValueSet || '',
    finding.r4Strength || '',
    finding.r6Strength || '',
  ];
  
  return parts.join('||');
}

/**
 * Remove common bindings from individual profile findings
 */
function removeCommonBindingsFromProfiles(findings, commonBindings) {
  if (commonBindings.length === 0) {
    return findings;
  }
  
  // Create signatures for common bindings
  const commonSignatures = new Set(
    commonBindings.map(f => createFindingSignature(f, f.path))
  );
  
  // Filter findings from each profile
  const filtered = findings.map(profile => {
    const filteredFindings = profile.findings.filter(finding => {
      const pathWithoutResource = finding.path.replace(/^[^.]+\./, '');
      const signature = createFindingSignature(finding, pathWithoutResource);
      return !commonSignatures.has(signature);
    });
    
    return {
      ...profile,
      findings: filteredFindings,
    };
  }).filter(profile => profile.findings.length > 0); // Remove profiles with no unique findings
  
  return filtered;
}

/**
 * Group findings by type
 */
function groupFindingsByType(findings) {
  const byType = {
    'strength-and-valueset-change': [],
    'strength-change': [],
    'valueset-change': [],
    'new-binding': [],
    'removed-binding': [],
  };
  
  for (const finding of findings) {
    byType[finding.type].push(finding);
  }
  
  return byType;
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    if ((left.isMustSupport === true) !== (right.isMustSupport === true)) {
      return left.isMustSupport === true ? -1 : 1;
    }
    const pathCompare = (left.path || '').localeCompare(right.path || '');
    if (pathCompare !== 0) {
      return pathCompare;
    }
    return (left.type || '').localeCompare(right.type || '');
  });
}

function splitFindingsByMustSupport(findings) {
  const mustSupport = [];
  const others = [];

  for (const finding of findings) {
    if (finding.isMustSupport === true) {
      mustSupport.push(finding);
    } else {
      others.push(finding);
    }
  }

  return { mustSupport, others };
}

function appendFindingMetadata(lines, finding) {
  lines.push(`- Must Support: ${finding.isMustSupport === true ? 'yes' : 'no'}`);
}

/**
 * Append findings to markdown lines
 */
function appendFindingsToMarkdown(lines, byType) {
  // Combined strength and valueset changes
  if (byType['strength-and-valueset-change'].length > 0) {
    lines.push('### Binding Strength and ValueSet Changes');
    lines.push('');
    
    for (const f of byType['strength-and-valueset-change']) {
      lines.push(`**${f.path}**`);
      appendFindingMetadata(lines, f);
      lines.push(`- Strength: \`${f.r4Strength}\` → \`${f.r6Strength}\``);
      lines.push(`- R4 ValueSet: ${f.r4ValueSet || 'none'}`);
      lines.push(`- R6 ValueSet: ${f.r6ValueSet || 'none'}`);
      
      if (f.contentDifference) {
        lines.push('');
        lines.push('**Content Difference:**');
        
        if (f.contentDifference.message) {
          lines.push(`- ${f.contentDifference.message}`);
        } else {
          lines.push(`- R4 Total Codes: ${f.contentDifference.r4TotalCodes}`);
          lines.push(`- R6 Total Codes: ${f.contentDifference.r6TotalCodes}`);
          
          if (f.contentDifference.addedCount > 0) {
            lines.push(`- **Added Codes (${f.contentDifference.addedCount}):**`);
            const addedCodes = f.contentDifference.addedCodes || [];
            for (const code of addedCodes) {
              const display = code.display ? ` - ${code.display}` : '';
              lines.push(`  - \`${code.code}\`${display} (${code.system})`);
            }
            if (f.contentDifference.addedCount > addedCodes.length) {
              lines.push(`  - ... and ${f.contentDifference.addedCount - addedCodes.length} more`);
            }
          }
          
          if (f.contentDifference.removedCount > 0) {
            lines.push(`- **Removed Codes (${f.contentDifference.removedCount}):**`);
            const removedCodes = f.contentDifference.removedCodes || [];
            for (const code of removedCodes) {
              const display = code.display ? ` - ${code.display}` : '';
              lines.push(`  - \`${code.code}\`${display} (${code.system})`);
            }
            if (f.contentDifference.removedCount > removedCodes.length) {
              lines.push(`  - ... and ${f.contentDifference.removedCount - removedCodes.length} more`);
            }
          }
        }
      }
      
      lines.push('');
    }
  }
  
  // Strength changes
  if (byType['strength-change'].length > 0) {
    lines.push('### Binding Strength Changes');
    lines.push('');
    
    for (const f of byType['strength-change']) {
      lines.push(`**${f.path}**`);
      appendFindingMetadata(lines, f);
      lines.push(`- Strength: \`${f.r4Strength}\` → \`${f.r6Strength}\``);
      if (f.r4ValueSet) {
        lines.push(`- ValueSet (R4): ${f.r4ValueSet}`);
      }
      if (f.r6ValueSet) {
        lines.push(`- ValueSet (R6): ${f.r6ValueSet}`);
      }
      lines.push('');
    }
  }
  
  // ValueSet changes
  if (byType['valueset-change'].length > 0) {
    lines.push('### ValueSet Changes');
    lines.push('');
    
    for (const f of byType['valueset-change']) {
      lines.push(`**${f.path}**`);
      appendFindingMetadata(lines, f);
      lines.push(`- R4 ValueSet: ${f.r4ValueSet || 'none'}`);
      lines.push(`- R6 ValueSet: ${f.r6ValueSet || 'none'}`);
      
      if (f.r4Strength || f.r6Strength) {
        lines.push(`- Binding Strength: \`${f.r4Strength || 'none'}\` → \`${f.r6Strength || 'none'}\``);
      }
      
      if (f.contentDifference) {
        lines.push('');
        lines.push('**Content Difference:**');
        
        if (f.contentDifference.message) {
          lines.push(`- ${f.contentDifference.message}`);
        } else {
          lines.push(`- R4 Total Codes: ${f.contentDifference.r4TotalCodes}`);
          lines.push(`- R6 Total Codes: ${f.contentDifference.r6TotalCodes}`);
          
          if (f.contentDifference.addedCount > 0) {
            lines.push(`- **Added Codes (${f.contentDifference.addedCount}):**`);
            const addedCodes = f.contentDifference.addedCodes || [];
            for (const code of addedCodes) {
              const display = code.display ? ` - ${code.display}` : '';
              lines.push(`  - \`${code.code}\`${display} (${code.system})`);
            }
            if (f.contentDifference.addedCount > addedCodes.length) {
              lines.push(`  - ... and ${f.contentDifference.addedCount - addedCodes.length} more`);
            }
          }
          
          if (f.contentDifference.removedCount > 0) {
            lines.push(`- **Removed Codes (${f.contentDifference.removedCount}):**`);
            const removedCodes = f.contentDifference.removedCodes || [];
            for (const code of removedCodes) {
              const display = code.display ? ` - ${code.display}` : '';
              lines.push(`  - \`${code.code}\`${display} (${code.system})`);
            }
            if (f.contentDifference.removedCount > removedCodes.length) {
              lines.push(`  - ... and ${f.contentDifference.removedCount - removedCodes.length} more`);
            }
          }
        }
      }
      
      lines.push('');
    }
  }
  
  // New bindings
  if (byType['new-binding'].length > 0) {
    lines.push('### New Bindings in R6');
    lines.push('');
    
    for (const f of byType['new-binding']) {
      lines.push(`**${f.path}**`);
      appendFindingMetadata(lines, f);
      if (f.r6Binding?.valueSet) {
        lines.push(`- ValueSet: ${f.r6Binding.valueSet}`);
      }
      if (f.r6Binding?.strength) {
        lines.push(`- Strength: \`${f.r6Binding.strength}\``);
      }
      lines.push('');
    }
  }
  
  // Removed bindings
  if (byType['removed-binding'].length > 0) {
    lines.push('### Removed Bindings in R6');
    lines.push('');
    
    for (const f of byType['removed-binding']) {
      lines.push(`**${f.path}**`);
      appendFindingMetadata(lines, f);
      if (f.r4Binding?.valueSet) {
        lines.push(`- ValueSet (R4): ${f.r4Binding.valueSet}`);
      }
      if (f.r4Binding?.strength) {
        lines.push(`- Strength (R4): \`${f.r4Binding.strength}\``);
      }
      lines.push('');
    }
  }
}

/**
 * Generate markdown report for terminology comparison
 */
function generateTerminologyReport(findings, commonBindings = []) {
  const lines = [];
  const sortedProfiles = sortProfilesAlphabetically(findings);
  const mustSupportProfiles = sortedProfiles
    .map(profile => ({
      ...profile,
      findings: profile.findings.filter(finding => finding.isMustSupport === true),
    }))
    .filter(profile => profile.findings.length > 0);
  const otherProfiles = sortedProfiles
    .map(profile => ({
      ...profile,
      findings: profile.findings.filter(finding => finding.isMustSupport !== true),
    }))
    .filter(profile => profile.findings.length > 0);
  
  lines.push('# Terminology Binding Comparison Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Profiles with Differences:** ${sortedProfiles.length}`);
  if (commonBindings.length > 0) {
    lines.push(`**Common Bindings Across All Profiles:** ${commonBindings.length}`);
  }
  lines.push('');
  lines.push('This report shows differences in terminology bindings between R4 and R6 profiles.');
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Add common bindings section
  if (commonBindings.length > 0) {
    lines.push('## All Resources');
    lines.push('');
    lines.push('The following binding changes occur in **all** profiles:');
    lines.push('');

    appendMustSupportSections(lines, commonBindings);
    
    lines.push('---');
    lines.push('');
  }
  
  if (sortedProfiles.length === 0) {
    lines.push('✅ **No profile-specific binding differences found.**');
    lines.push('');
    return lines.join('\n');
  }

  if (mustSupportProfiles.length > 0) {
    lines.push('## Must Support');
    lines.push('');
    lines.push('The following profiles contain binding differences on Must-Support elements:');
    lines.push('');

    for (const profile of mustSupportProfiles) {
      appendProfileSection(lines, profile);
    }
  }

  if (otherProfiles.length > 0) {
    lines.push('## Non Must Support');
    lines.push('');
    lines.push('The following profiles contain binding differences on elements without Must Support:');
    lines.push('');

    for (const profile of otherProfiles) {
      appendProfileSection(lines, profile);
    }
  }
  
  return lines.join('\n');
}

function appendMustSupportSections(lines, findings) {
  const sortedFindings = sortFindings(findings);
  const { mustSupport, others } = splitFindingsByMustSupport(sortedFindings);

  if (mustSupport.length > 0) {
    lines.push('### Must Support Elements');
    lines.push('');
    appendFindingsToMarkdown(lines, groupFindingsByType(mustSupport));
  }

  if (others.length > 0) {
    lines.push('### Other Elements');
    lines.push('');
    appendFindingsToMarkdown(lines, groupFindingsByType(others));
  }
}

function appendProfileSection(lines, profile) {
  lines.push(`### ${profile.profileName}`);
  lines.push('');
  lines.push(`- **R4 URL:** ${profile.r4Url}`);
  lines.push(`- **R6 URL:** ${profile.r6Url}`);
  lines.push(`- **Differences:** ${profile.findings.length}`);
  lines.push('');
  appendFindingsToMarkdown(lines, groupFindingsByType(sortFindings(profile.findings)));
  lines.push('---');
  lines.push('');
}

function sortProfilesAlphabetically(profiles) {
  return [...profiles].sort((left, right) =>
    (left.profileName || '').localeCompare(right.profileName || '')
  );
}
