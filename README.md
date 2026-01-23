# FHIR R4 to R6 Migration Runner

An automated pipeline for migrating FHIR R4 Implementation Guides to FHIR R6, with built-in profile comparison and rule-based analysis.

## Features

- 📦 **Automated Package Download** - Downloads FHIR packages from the official registry
- 🔄 **FSH Generation** - Converts FHIR resources to FSH using GoFSH
- ⬆️ **R6 Upgrade** - Automatically upgrades R4 profiles to R6 using SUSHI
- 📊 **Profile Comparison** - Compares R4 and R6 profiles using the HL7 Validator
- 📝 **Rule-Based Analysis** - Applies customizable rules to identify migration challenges
- 🎯 **Migration Scoring** - Calculates a migration complexity score
- 📄 **Markdown Reports** - Generates detailed migration reports with timestamps

## Installation

### From GitHub Registry

```bash
npm install @gefyra/fhir-r6-migration-runner
```

### From Source

```bash
git clone https://github.com/Gefyra/fhir-r6-migration-runner.git
cd fhir-r6-migration-runner
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
  "compareMode": "incremental"
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
| `resourcesDir` | string | Directory for R4 resources |
| `resourcesR6Dir` | string | Directory for R6 resources |
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

**Auto-download feature:** When `validatorJarPath` is `null`, the HL7 FHIR Validator will be automatically downloaded from the [latest GitHub release](https://github.com/hapifhir/org.hl7.fhir.core/releases/latest) to `<workdir>/validator_cli.jar`. This download only happens once - subsequent runs will reuse the existing JAR file.

## Pipeline Steps

The migration pipeline consists of 4 steps:

### 1. GoFSH (Optional)

Downloads the specified FHIR package and converts it to FSH using GoFSH.

**Skipped if:** `resourcesDir/sushi-config.yaml` already exists

### 2. Upgrade to R6

Runs SUSHI to upgrade the R4 project to R6, applying automatic fixes for common migration issues.

**Skipped if:** `resourcesR6Dir/sushi-config.yaml` already exists

### 3. Profile Comparison

Uses the HL7 FHIR Validator to compare R4 and R6 profiles, generating HTML comparison files.

**Incremental mode:** Only compares profiles with missing HTML files
**Full mode:** Compares all profiles, overwriting existing files

### 4. Report Generation

Applies rules to the comparison HTML files and generates a markdown report with:
- Detailed findings grouped by profile and category
- Migration complexity score
- Timestamped filename (e.g., `migration-report-20260123-143052.md`)

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
  "title": "Custom Migration Rules",
  "tables": [
    {
      "sectionHeading": "Structure",
      "rules": [
        {
          "name": "Element removed in R6",
          "description": "An element from R4 no longer exists in R6",
          "rank": 50,
          "value": 2,
          "conditions": [
            {
              "column": "Comments",
              "operator": "equals",
              "value": "Removed this element"
            }
          ],
          "template": "The element {{Name}} exists in R4 but was removed in R6."
        }
      ]
    }
  ]
}
```

### Rule Properties

- **name**: Rule category name (groups findings in the report)
- **description**: Detailed explanation of the issue
- **rank**: Sorting order in the report (lower = higher priority)
- **value**: Score contribution (higher = more complex migration)
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

## Migration Score

The migration score is calculated by summing the `value` field from all rule matches.

**Interpretation:**
- **0-50**: Low complexity - straightforward migration
- **51-150**: Medium complexity - moderate effort required
- **151+**: High complexity - significant migration challenges

## Output

### Report Format

```markdown
# FHIR R4 to R6 Migration Report

**Generated:** 2026-01-23T14:30:52.000Z
**Total Findings:** 42
**Migration Score:** 135

---

## PatientProfile

**Score:** 25 | **Findings:** 8

### Element with Must-Support removed in R6

*An element marked as Must-Support in R4 has been removed...*

- Element identifier exists in R4 MS, but removed in R6. *(Score: 15)*
- Element photo exists in R4 MS, but removed in R6. *(Score: 15)*

### Change in cardinality

*The cardinality of an element has changed...*

- For element name, the cardinality changed in R6: cardinalities differ (0..* vs 1..*) *(Score: 5)*

---

**Final Migration Score:** 135

*Lower scores indicate fewer migration challenges.*
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
fhir-r6-runner-package/
├── src/
│   ├── index.js          # Main pipeline logic
│   ├── cli.js            # CLI entry point
│   ├── config.js         # Configuration loading & validation
│   ├── rules-engine.js   # Rule evaluation engine
│   └── utils/
│       ├── fs.js         # Filesystem utilities
│       ├── process.js    # Process spawning utilities
│       ├── sushi-log.js  # SUSHI log parsing
│       └── html.js       # HTML parsing utilities
├── config/
│   └── default-rules.json # Default rule configuration
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
