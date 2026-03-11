# DiffyR6 - FHIR Profile Comparison & Analysis CLI

An automated toolkit for comparing FHIR profiles across different versions, analyzing structural differences, and generating comprehensive impact reports with rule-based evaluation.

## Features

- 📦 **Automated Package Download** - Downloads FHIR packages from the official registry
- 🔄 **FSH Generation** - Converts FHIR resources to FSH using GoFSH  
- ⬆️ **Profile Upgrade Pipeline** - Automatically upgrades profiles between FHIR versions using SUSHI
- 📊 **Profile Comparison** - Compares profile versions using the HL7 FHIR Validator
- 🎯 **Terminology Binding Analysis** - Compares terminology bindings between versions and checks ValueSet content from local package cache
- 📝 **Rule-Based Difference Analysis** - Applies customizable rules to classify and score structural changes
- 🎯 **Impact Scoring** - Calculates complexity scores based on breaking changes and migration risks
- 🚨 **Removed Resource Detection** - Identifies profiles based on resource types removed in newer FHIR versions
- 📄 **Markdown Reports** - Generates detailed comparison reports with timestamps and findings categorization

## Installation

### From GitHub Registry

```bash
npm install @gefyra/diffyr6-cli
```

### From Source

```bash
git clone https://github.com/Gefyra/DiffyR6-Cli.git
cd DiffyR6-Cli
npm install
npm link
```

## Prerequisites

- **Node.js** 18.0.0 or higher
- **npm** for package management
- **Java** (for HL7 FHIR Validator)
- **tar** available on PATH (for extracting FHIR packages)

### Required Peer Dependencies

```bash
npm install gofsh fsh-sushi
```

## Quick Start

### 1. Create a Configuration File

```bash
fhir-r6-migrate --init
```

This creates a `migration-config.json` file with default settings.

### 2. Edit the Configuration

```json
{
  "configVersion": "1.0.0",
  "packageId": "de.basisprofil.r4",
  "packageVersion": "1.5.0",
  "enableGoFSH": true,
  "resourcesDir": "Resources",
  "resourcesR6Dir": "ResourcesR6",
  "compareDir": "compare",
  "outputDir": "output",
  "rulesConfigPath": null,
  "validatorJarPath": null,
  "workdir": null,
  "compareMode": "incremental",
  "exportZip": true
}
```

### 3. Run the Migration

```bash
fhir-r6-migrate
```

Or with a custom config:

```bash
fhir-r6-migrate --config my-config.json
```

## Usage

### CLI Usage

```bash
# Run with default config
fhir-r6-migrate

# Run with custom config
fhir-r6-migrate --config path/to/config.json

# Create example config
fhir-r6-migrate --init

# Show version
fhir-r6-migrate --version

# Show help
fhir-r6-migrate --help
```

**Managing Multiple IGs in Parallel**

The `--config` parameter enables you to manage multiple implementation guides simultaneously. To do this, create separate config files for each IG and adjust the `workdir` field to point to different directories. All other paths (like `resourcesDir`, `resourcesR6Dir`, `compareDir`, and `outputDir`) can remain the same across configs, as they will be resolved relative to each specific `workdir`.

Example:
```bash
# IG 1 configuration (config-basisprofil.json with "workdir": "./igs/basisprofil")
fhir-r6-migrate --config config-basisprofil.json

# IG 2 configuration (config-medikation.json with "workdir": "./igs/medikation") 
fhir-r6-migrate --config config-medikation.json
```

### Programmatic Usage

```javascript
import { runMigration } from '@gefyra/fhir-r6-migration-runner';
import { loadConfig } from '@gefyra/fhir-r6-migration-runner/config';

// Load config from file
const config = await loadConfig('./migration-config.json');

// Or create config programmatically
const config = {
  configVersion: '1.0.0',
  packageId: 'de.basisprofil.r4',
  packageVersion: '1.5.0',
  enableGoFSH: true,
  resourcesDir: 'Resources',
  resourcesR6Dir: 'ResourcesR6',
  compareDir: 'compare',
  outputDir: 'output',
  compareMode: 'incremental',
};

// Run migration
const result = await runMigration(config);

console.log('Migration complete!');
console.log('Report:', result.report);
console.log('Score:', result.score);
console.log('Findings:', result.findingsCount);
```

## Configuration Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `configVersion` | string | Config schema version (must be "1.0.0") |
| `packageId` | string | FHIR package ID (required if `enableGoFSH` is true) |
| `resourcesDir` | string | Directory for baseline/source version resources |
| `resourcesR6Dir` | string | Directory for target/comparison version resources |
| `compareDir` | string | Directory for comparison HTML files |
| `outputDir` | string | Directory for generated reports |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `packageVersion` | string | `"current"` | FHIR package version |
| `enableGoFSH` | boolean | `true` | Enable GoFSH package download & FSH generation |
| `rulesConfigPath` | string | `null` | Path to custom rules config (uses default if null) |
| `validatorJarPath` | string | `null` | Path to validator_cli.jar (auto-downloads latest from GitHub if null) |
| `workdir` | string | `null` | Working directory (uses current dir if null) |
| `compareMode` | string | `"incremental"` | Comparison mode: `"incremental"` or `"full"` |
| `exportZip` | boolean | `true` | Create a ZIP export containing compare HTML, markdown report, and run config |

**Auto-download feature:** When `validatorJarPath` is `null`, the HL7 FHIR Validator will be automatically downloaded from a [stable GitHub release](https://github.com/hapifhir/org.hl7.fhir.core/releases/download/6.7.10/validator_cli.jar) to `<workdir>/validator_cli.jar`. This download only happens once - subsequent runs will reuse the existing JAR file.

## Pipeline Steps

The comparison pipeline consists of 5 steps:

### 1. GoFSH (Optional)

Downloads the specified FHIR package and converts it to FSH using GoFSH for the baseline version.

**Skipped if:** `resourcesDir/sushi-config.yaml` already exists

### 2. Profile Upgrade

Runs SUSHI to upgrade profiles to the target FHIR version, applying automatic fixes for common issues.

**Skipped if:** `resourcesR6Dir/sushi-config.yaml` already exists

### 3. Profile Comparison

Uses the HL7 FHIR Validator to compare baseline and target profile versions, generating HTML comparison files showing structural differences.

**Incremental mode:** Only compares profiles with missing HTML files
**Full mode:** Compares all profiles, overwriting existing files

### 4. Report Generation

Applies rules to the comparison HTML files and generates a markdown report with:
- Removed resource detection (profiles based on deprecated resource types)
- Detailed findings grouped by profile and category
- Impact score based on breaking changes
- Timestamped filename (e.g., `comparison-report-20260123-143052.md`)

### 5. Terminology Binding Analysis

Compares terminology bindings between R4 and R6 profiles:
1. Runs `sushi -s` in both Resources and ResourcesR6 directories to generate snapshots
2. Compares `element[].binding.strength` and `valueSet` between R4 and R6 profiles
3. For ValueSets with version notation (pipe `|`), loads and compares content from local FHIR package cache:
   - R4: `%USERPROFILE%\.fhir\packages\hl7.fhir.r4.core#4.0.1\package`
   - R6: `%USERPROFILE%\.fhir\packages\hl7.fhir.r6.core#6.0.0-ballot3\package`
4. Generates a `terminology-report-<timestamp>.md` with all binding differences
5. Includes the report in the ZIP export

**Note:** This step continues even if it fails, to ensure the main migration completes.

## Compare Modes

### Incremental Mode (Default)

```json
{
  "compareMode": "incremental"
}
```

- Only compares profiles that don't have existing HTML files
- Faster for incremental updates
- Preserves existing comparisons

### Full Mode

```json
{
  "compareMode": "full"
}
```

- Compares all profiles, overwriting existing files
- Useful for clean rebuilds
- Ensures all comparisons are up-to-date

## Custom Rules

The package includes a default set of rules for common migration issues. You can customize or extend these rules:

### Using Custom Rules

```json
{
  "rulesConfigPath": "./my-rules.json"
}
```

### Rules Configuration Format

```json
{
  "title": "Custom Analysis Rules",
  "tables": [
    {
      "sectionHeading": "Structure",
      "rules": [
        {
          "name": "Element removed in target version",
          "description": "An element from the baseline version no longer exists in the target",
          "rank": 50,
          "value": 2,
          "conditions": [
            {
              "column": "Comments",
              "operator": "equals",
              "value": "Removed this element"
            }
          ],
          "template": "The element {{Name}} exists in baseline but was removed in target."
        }
      ]
    }
  ]
}
```

### Rule Properties

- **name**: Rule category name (groups findings in the report)
- **description**: Detailed explanation of the difference
- **rank**: Sorting order in the report (lower = higher priority)
- **value**: Score contribution (higher = more significant change)
- **conditions**: Array of conditions that must ALL match
- **template**: Output text with variable substitution (`{{variableName}}`)

### Condition Operators

- `equals`: Exact match (case-insensitive by default)
- `contains`: Substring match (case-insensitive by default)
- `!equals` / `notequals`: Not equal

### Available Variables

- Column aliases (e.g., `{{Name}}`, `{{Comments}}`)
- Index-based columns (e.g., `{{col1}}`, `{{col2}}`)
- Context variables: `{{file}}`, `{{section}}`, `{{profile}}`

## Impact Score

The impact score is calculated by summing the `value` field from all rule matches across all differences found.

**Purpose:**

The score is designed to **estimate the effort required for analysis**, not the effort required for the migration itself. Each finding represents a structural difference that requires review and evaluation to determine its implications for your implementation.

**Why there are no zero scores:**

Every detected element receives a score value, even for seemingly minor differences. This reflects the principle that each finding deserves at least a moment of attention during the analysis phase. Even small structural changes may have unexpected consequences that need to be evaluated in the context of your specific use case.

**Interpretation:**
- **0-50**: Low analysis effort - minor differences, straightforward review
- **51-150**: Medium analysis effort - moderate structural changes requiring careful attention
- **151+**: High analysis effort - significant differences requiring thorough evaluation and planning

## Output

### Report Format

```markdown
# FHIR Profile Comparison Report

**Generated:** 2026-01-23T14:30:52.000Z
**Total Findings:** 42
**Impact Score:** 135
**Resources Removed:** 0

---

## ⚠️ Resources Removed in Target Version

✅ **No profiles found that are based on resource types removed in target version.**

Your baseline profiles do not use any deprecated resource types.

---

## PatientProfile

**Score:** 25 | **Findings:** 8

### Element removed in target version

*An element from baseline version no longer exists in target...*

- Element identifier exists in baseline but removed in target. *(Score: 15)*
- Element photo exists in baseline but removed in target. *(Score: 15)*

### Change in cardinality

*The cardinality of an element has changed...*

- For element name, the cardinality changed: cardinalities differ (0..* vs 1..*) *(Score: 5)*

---

**Final Impact Score:** 135

*Lower scores indicate fewer structural changes.*
```

## Configuration Versioning

The package uses semantic versioning for configuration schemas.

**Current version:** `1.0.0`

### Version Compatibility

- **Major version** must match exactly
- **Minor/patch versions** are backwards compatible

If you receive a config version error:
1. Update the package: `npm update @gefyra/fhir-r6-migration-runner`
2. Or update your config's `configVersion` field

## Troubleshooting

### Error: "Missing configVersion field"

Add `"configVersion": "1.0.0"` to your config file.

### Error: "Incompatible config version"

Update the package or adjust your config to match the expected major version.

### GoFSH not found

Ensure `gofsh` is installed:
```bash
npm install gofsh
```

Or specify a custom path in your environment:
```bash
export GOFSH_BIN=/path/to/gofsh
```

### Validator JAR download fails

Download manually and specify the path:
```json
{
  "validatorJarPath": "/path/to/validator_cli.jar"
}
```

## Development

### Project Structure

```
DiffyR6-Cli/
├── src/
│   ├── index.js            # Main pipeline logic
│   ├── cli.js              # CLI entry point
│   ├── config.js           # Configuration loading & validation
│   ├── rules-engine.js     # Rule evaluation engine
│   ├── generate-fsh.js     # GoFSH package download & FSH generation
│   ├── upgrade-sushi.js    # SUSHI profile upgrade with auto-fixes
│   ├── compare-profiles.js # HL7 Validator profile comparison
│   └── utils/
│       ├── fs.js               # Filesystem utilities
│       ├── process.js          # Process spawning utilities
│       ├── sushi-log.js        # SUSHI log parsing
│       ├── html.js             # HTML parsing utilities
│       ├── validator.js        # Validator JAR auto-download
│       └── removed-resources.js # Removed resource detection
├── config/
│   ├── default-rules.json           # Default analysis rules
│   └── resources-r4-not-in-r6.json  # List of removed resource types
├── package.json
└── README.md
```

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

*Note: Tests are not yet implemented*

## Contributing

Contributions are welcome! Please open an issue or pull request on GitHub.

## License

MIT

## Author

Jonas Schön (Gefyra GmbH)
- Email: js@gefyra.de
- GitHub: [@Gefyra](https://github.com/Gefyra)

## Links

- [GitHub Repository](https://github.com/Gefyra/fhir-r6-migration-runner)
- [npm Package](https://www.npmjs.com/package/@gefyra/fhir-r6-migration-runner)
- [FHIR R6 Specification](https://hl7.org/fhir/R6/)
- [GoFSH](https://github.com/FHIR/GoFSH)
- [SUSHI](https://github.com/FHIR/sushi)
