import fsp from 'fs/promises';
import path from 'path';
import { fileExists, directoryExists } from './utils/fs.js';
import { loadConfig, loadRules } from './config.js';
import { evaluateRulesForHtmlFiles } from './rules-engine.js';
import { spawnProcess } from './utils/process.js';
import { generateFshFromPackage } from './generate-fsh.js';
import { upgradeSushiToR6 } from './upgrade-sushi.js';
import { compareProfiles } from './compare-profiles.js';
import { compareTerminology } from './compare-terminology.js';
import { findRemovedResources } from './utils/removed-resources.js';
import { createZip } from './utils/zip.js';

/**
 * Main entry point - runs the FHIR R4 to R6 migration pipeline
 */
export async function runMigration(config) {
  // Resolve paths
  const workdir = config.workdir ? path.resolve(config.workdir) : process.cwd();
  const resourcesDir = path.resolve(workdir, config.resourcesDir);
  const resourcesR6Dir = path.resolve(workdir, config.resourcesR6Dir);
  const compareDir = path.resolve(workdir, config.compareDir);
  const outputDir = path.resolve(workdir, config.outputDir);
  
  // Ensure output directory exists
  await fsp.mkdir(outputDir, { recursive: true });
  
  const context = {
    config,
    workdir,
    resourcesDir,
    resourcesR6Dir,
    compareDir,
    outputDir,
    steps: [],
  };
  
  // Step 1: GoFSH (if enabled and not already done)
  if (config.enableGoFSH) {
    const shouldRunGoFSH = await checkShouldRunGoFSH(resourcesDir);
    if (shouldRunGoFSH) {
      console.log('\n[1/5] Downloading package and generating FSH...');
      await runGoFSH(context);
      context.steps.push('gofsh');
    } else {
      console.log('\n[1/5] GoFSH - SKIPPED (Resources directory with sushi-config.yaml already exists)');
    }
  } else {
    console.log('\n[1/5] GoFSH - DISABLED in config');
  }
  
  // Step 2: Upgrade to R6
  const shouldRunUpgrade = await checkShouldRunUpgrade(resourcesR6Dir);
  if (shouldRunUpgrade) {
    console.log('\n[2/5] Upgrading to R6...');
    await runUpgradeToR6(context);
    context.steps.push('upgrade');
  } else {
    console.log('\n[2/5] Upgrade - SKIPPED (ResourcesR6 directory with sushi-config.yaml already exists)');
  }
  
  // Step 3: Compare profiles
  console.log('\n[3/5] Comparing R4 vs R6 profiles...');
  const compareResults = await runProfileComparison(context);
  context.steps.push('compare');
  
  // Step 4: Generat5] Generating migration report...');
  const removedResources = await findRemovedResources(resourcesDir);
  const report = await generateReport(context, compareResults, removedResources);
  context.steps.push('report');

  // Step 5: Compare terminology bindings
  console.log('\n[5/5] Comparing terminology bindings...');
  let terminologyReport = null;
  try {
    terminologyReport = await runTerminologyComparison(context);
    if (terminologyReport) {
      context.steps.push('terminology');
    }
  } catch (error) {
    console.warn(`  Terminology comparison failed: ${error.message}`);
    console.warn('  Continuing without terminology report...');
  }

  let exportZipPath = null;
  if (config.exportZip) {
    console.log('\nGenerating export ZIP...');
    exportZipPath = await exportComparisonZip(context, report, terminologyReport);
    context.steps.push('exportZip');
  }
  
  console.log(`\n✓ Migration complete!`);
  console.log(`  Report: ${report.path}`);
  console.log(`  Total Score: ${report.score}`);
  console.log(`  Findings: ${report.findingsCount}`);
  if (exportZipPath) {
    console.log(`  Export ZIP: ${exportZipPath}`);
  }
  
  return {
    success: true,
    steps: context.steps,
    report: report.path,
    exportZip: exportZipPath,
    score: report.score,
    findingsCount: report.findingsCount,
  };
}

/**
 * Check if GoFSH should run (Resources dir doesn't exist or is empty)
 */
async function checkShouldRunGoFSH(resourcesDir) {
  const sushiConfigPath = path.join(resourcesDir, 'sushi-config.yaml');
  return !(await fileExists(sushiConfigPath));
}

/**
 * Check if upgrade should run (ResourcesR6 dir doesn't exist or is empty)
 */
async function checkShouldRunUpgrade(resourcesR6Dir) {
  const sushiConfigPath = path.join(resourcesR6Dir, 'sushi-config.yaml');
  return !(await fileExists(sushiConfigPath));
}

/**
 * Run GoFSH to generate FSH from package
 */
async function runGoFSH(context) {
  const { config, resourcesDir } = context;
  const packageSpec = config.packageVersion 
    ? `${config.packageId}#${config.packageVersion}`
    : config.packageId;
  
  await generateFshFromPackage(packageSpec, resourcesDir);
}

/**
 * Run SUSHI upgrade to R6
 */
async function runUpgradeToR6(context) {
  const { resourcesDir, config } = context;
  const sushiExecutable = config.sushiExecutable || 'sushi -s';
  await upgradeSushiToR6(resourcesDir, sushiExecutable);
}

/**
 * Run profile comparison
 */
async function runProfileComparison(context) {
  const { config, resourcesDir, resourcesR6Dir, compareDir, workdir } = context;
  
  // Ensure compare directory exists
  await fsp.mkdir(compareDir, { recursive: true });
  
  const options = {
    jarPath: config.validatorJarPath || null,
    fhirVersion: '4.0',
    debug: config.debug || false,
    workingDirectory: workdir,
  };
  
  const result = await compareProfiles(resourcesDir, resourcesR6Dir, compareDir, options);
  console.log(`  Compared ${result.comparedCount} profile pair(s)`);
  
  return [];
}

/**
 * Run terminology comparison
 */
async function runTerminologyComparison(context) {
  const { resourcesDir, resourcesR6Dir, outputDir, config } = context;
  
  const options = {
    debug: config.debug || false,
  };
  
  const result = await compareTerminology(resourcesDir, resourcesR6Dir, outputDir, options);
  
  if (result) {
    console.log(`  ${result.profilesWithDifferences} profile(s) with binding differences`);
    console.log(`  Total findings: ${result.totalFindings}`);
    console.log(`  Markdown report: ${result.path}`);
    console.log(`  JSON report: ${result.jsonPath}`);
  }
  
  return result;
}

/**
 * Get list of profiles that need to be compared
 */
async function getProfilesToCompare(resourcesDir, resourcesR6Dir, compareDir, compareMode) {
  const r4Profiles = await listProfiles(resourcesDir);
  const r6Profiles = await listProfiles(resourcesR6Dir);
  
  // Find common profiles
  const commonProfiles = r4Profiles.filter(p => r6Profiles.includes(p));
  
  if (compareMode === 'full') {
    return commonProfiles;
  }
  
  // Incremental mode: only compare missing files
  const existing = await listExistingCompareFiles(compareDir);
  return commonProfiles.filter(profile => {
    const expectedFile = `sd-${profile}-${profile}.html`;
    return !existing.includes(expectedFile);
  });
}

/**
 * List profile names from a resources directory
 */
async function listProfiles(resourcesDir) {
  const resourcesPath = path.join(resourcesDir, 'fsh-generated', 'resources');
  const exists = await directoryExists(resourcesPath);
  if (!exists) {
    return [];
  }
  
  const files = await fsp.readdir(resourcesPath);
  const profiles = [];
  
  for (const file of files) {
    if (!file.startsWith('StructureDefinition-') || !file.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(resourcesPath, file);
    const content = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    
    if (data.resourceType === 'StructureDefinition' && data.id) {
      profiles.push(data.id);
    }
  }
  
  return profiles;
}

/**
 * List existing compare HTML files
 */
async function listExistingCompareFiles(compareDir) {
  const exists = await directoryExists(compareDir);
  if (!exists) {
    return [];
  }
  
  const files = await fsp.readdir(compareDir);
  return files.filter(f => f.endsWith('.html'));
}

/**
 * Generate markdown report with rules evaluation
 */
async function generateReport(context, compareResults, removedResources = []) {
  const { compareDir, outputDir, config } = context;
  
  // Load rules
  const rules = await loadRules(config.rulesConfigPath);
  
  // Read all HTML files from compare directory
  const htmlFiles = await readCompareHtmlFiles(compareDir);
  
  // Evaluate rules
  const findings = evaluateRulesForHtmlFiles(htmlFiles, rules);
  
  // Calculate total score
  const totalScore = findings.reduce((sum, f) => sum + (f.value || 0), 0);
  
  // Generate markdown
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const reportFilename = `migration-report-${timestamp}.md`;
  const reportPath = path.join(outputDir, reportFilename);
  
  const markdown = generateMarkdown(findings, totalScore, rules, removedResources);
  await fsp.writeFile(reportPath, markdown, 'utf8');
  
  return {
    path: reportPath,
    filename: reportFilename,
    timestamp,
    score: totalScore,
    findingsCount: findings.length,
  };
}

/**
 * Create a ZIP export with compare HTML files, report, and run config
 */
async function exportComparisonZip(context, report, terminologyReport = null) {
  const { compareDir, outputDir, config } = context;
  const exportFilename = 'diffyr6-publish.zip';
  const exportPath = path.join(outputDir, exportFilename);

  const entries = [];

  // Add HTML comparison files sent to the API
  const htmlFiles = await listExportHtmlFiles(compareDir);
  for (const file of htmlFiles) {
    const filePath = path.join(compareDir, file);
    const content = await fsp.readFile(filePath);
    entries.push({
      name: file,
      data: content,
      mtime: (await fsp.stat(filePath)).mtime,
    });
  }

  // Add markdown report
  const reportContent = await fsp.readFile(report.path);
  entries.push({
    name: report.filename,
    data: reportContent,
    mtime: (await fsp.stat(report.path)).mtime,
  });

  // Add terminology report if available
  if (terminologyReport && terminologyReport.path) {
    const termContent = await fsp.readFile(terminologyReport.path);
    entries.push({
      name: terminologyReport.filename,
      data: termContent,
      mtime: (await fsp.stat(terminologyReport.path)).mtime,
    });
    
    // Add terminology JSON if available
    if (terminologyReport.jsonPath) {
      const termJsonContent = await fsp.readFile(terminologyReport.jsonPath);
      entries.push({
        name: terminologyReport.jsonFilename,
        data: termJsonContent,
        mtime: (await fsp.stat(terminologyReport.jsonPath)).mtime,
      });
    }
  }

  // Add config used for the run
  entries.push({
    name: 'run-config.json',
    data: JSON.stringify(config, null, 2),
    mtime: new Date(),
  });

  await createZip(exportPath, entries);
  return exportPath;
}

async function listExportHtmlFiles(compareDir) {
  const exists = await directoryExists(compareDir);
  if (!exists) {
    return [];
  }
  const files = await fsp.readdir(compareDir);
  const allowed = /^(sd|xx)-.+-.+\.html$/i;
  const excluded = /(intersection|union)\.html$/i;
  return files
    .filter(file => allowed.test(file) && !excluded.test(file))
    .sort();
}

/**
 * Read all HTML comparison files
 */
async function readCompareHtmlFiles(compareDir) {
  const exists = await directoryExists(compareDir);
  if (!exists) {
    return [];
  }
  
  const files = await fsp.readdir(compareDir);
  const htmlFiles = [];
  
  for (const file of files) {
    if (!file.endsWith('.html')) {
      continue;
    }
    const filePath = path.join(compareDir, file);
    const content = await fsp.readFile(filePath, 'utf8');
    htmlFiles.push({
      filename: file,
      content,
    });
  }
  
  return htmlFiles;
}

/**
 * Generate markdown report from findings
 */
function generateMarkdown(findings, totalScore, rules, removedResources = []) {
  const lines = [];
  
  lines.push('# FHIR R4 to R6 Migration Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Total Findings:** ${findings.length}`);
  lines.push(`**Migration Score:** ${totalScore}`);
  lines.push(`**Resources Removed in R6:** ${removedResources.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Removed Resources Section
  lines.push('## ⚠️ Resources Removed in R6');
  lines.push('');
  
  if (removedResources.length > 0) {
    lines.push('The following resources/profiles exist in R4 but were completely removed in R6:');
    lines.push('');
    
    for (const { profile, resource } of removedResources) {
      lines.push(`- **${profile}** (${resource})`);
    }
    
    lines.push('');
    lines.push('> **Critical:** These resources cannot be migrated automatically. You must redesign data capture using alternative R6 resources.');
  } else {
    lines.push('✅ **No profiles found that are based on resource types removed in R6.**');
    lines.push('');
    lines.push('Your R4 profiles do not use any of the 38 resource types that were removed in FHIR R6 (such as Media, CatalogEntry, DocumentManifest, etc.).');
  }
  
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Group by profile
  const byProfile = new Map();
  for (const finding of findings) {
    const profile = extractProfileName(finding.file);
    if (!byProfile.has(profile)) {
      byProfile.set(profile, []);
    }
    byProfile.get(profile).push(finding);
  }
  
  // Sort profiles by name
  const sortedProfiles = Array.from(byProfile.keys()).sort();
  
  for (const profile of sortedProfiles) {
    const profileFindings = byProfile.get(profile);
    const profileScore = profileFindings.reduce((sum, f) => sum + (f.value || 0), 0);
    
    lines.push(`## ${profile}`);
    lines.push('');
    lines.push(`**Score:** ${profileScore} | **Findings:** ${profileFindings.length}`);
    lines.push('');
    
    // Group by rule group
    const byGroup = new Map();
    for (const finding of profileFindings) {
      const group = finding.group || 'Other';
      if (!byGroup.has(group)) {
        byGroup.set(group, []);
      }
      byGroup.get(group).push(finding);
    }
    
    // Sort groups by groupOrder
    const sortedGroups = Array.from(byGroup.keys()).sort((a, b) => {
      const findingsA = byGroup.get(a);
      const findingsB = byGroup.get(b);
      const orderA = findingsA[0]?.groupOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = findingsB[0]?.groupOrder ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
    
    for (const group of sortedGroups) {
      const groupFindings = byGroup.get(group);
      
      lines.push(`### ${group}`);
      lines.push('');
      
      // Find description from first finding
      const description = groupFindings[0]?.description;
      if (description) {
        lines.push(`*${description}*`);
        lines.push('');
      }
      
      // Sort findings by rank
      const sortedFindings = groupFindings.sort((a, b) => {
        const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
        const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
        return rankA - rankB;
      });
      
      for (const finding of sortedFindings) {
        lines.push(`- ${finding.text} *(Score: ${finding.value || 0})*`);
      }
      
      lines.push('');
    }
  }
  
  lines.push('---');
  lines.push('');
  lines.push(`**Final Migration Score:** ${totalScore}`);
  lines.push('');
  lines.push('*Lower scores indicate fewer migration challenges. Review high-scoring sections carefully.*');
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Extract profile name from filename
 */
function extractProfileName(filename) {
  // sd-ProfileName-ProfileNameR6.html -> ProfileName
  const match = filename.match(/^(?:sd-)?(.+?)(?:-\w+)?\.html$/);
  return match ? match[1] : filename.replace('.html', '');
}
