# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Note on versioning:** Minor bugfixes and patches that don't introduce new features are released as patch versions (e.g., 1.1.1, 1.1.2) and are not explicitly listed in this changelog. Only feature releases (minor versions) and breaking changes (major versions) are documented here.

## [1.2.2] - 2026-04-20

### Fixed
- All relative paths in the config file (`resourcesDir`, `resourcesR6Dir`, `compareDir`, `outputDir`, `workdir`, `rulesConfigPath`, `validatorJarPath`) are now resolved relative to the config file's location instead of the current working directory. This means `fhir-r6-migrate --config ./igs/example/migrate-config.json` now works correctly regardless of where the command is executed.
- Step 2 (Upgrade to R6) now recovers from a previously interrupted copy: if the target directory exists but contains no `sushi-config.yaml` (indicating a partial copy from a failed prior run), it is automatically deleted before retrying. Additionally, if the copy itself fails, the partial directory is cleaned up immediately so the next run can retry cleanly.
- Step 2 (Upgrade to R6) now copies only whitelisted files (`*.fsh`, `sushi-config.yaml/yml`) from the source directory into the R6 workspace, preserving the directory structure. All other files (e.g. build artifacts, reports, non-FHIR resources) are left in place and not carried over.

## [1.2.1] - 2026-03-28

### Added
- SearchParameter analysis for CapabilityStatements to detect references to search parameters removed from R6
- Dedicated `searchparameter-report-<timestamp>.md` and `.json` outputs
- New configuration option `skipSearchParameterReport`
- Recursive CapabilityStatement scanning across `resourcesDir`, including manually placed JSON files outside `fsh-generated/resources`
- SearchParameter report metadata including affected CapabilityStatement count and per-match source file information
- The terminology report now sorted by 'must support'

### Changed
- ZIP export now includes the newest available terminology and SearchParameter reports from `outputDir` when present, even if they were not regenerated in the current run
- ZIP export now selects only one report set per type and uses the newest available matching report pair
- SearchParameter report `sourceFile` paths are now written relative to the analyzed project directory instead of absolute filesystem paths
- Runner pipeline extended with a seventh step for SearchParameter analysis
- Configuration schema updated to version `1.0.3` with automatic migration for existing config files

### Fixed
- Broken runner step logging around report generation
- Missing config migration path for adding `skipSearchParameterReport` to existing configurations
- Missing SearchParameter report inclusion in ZIP exports when reusing existing report files
- GoFSH post-processing now comments out invalid `^slicing` rules on choice elements (for example `value[x]`) because they are not valid due to comparer errors

## [1.1.*] - 2026-01-28

### Added
- Terminology binding analysis with detailed comparison report
- ZIP export functionality for sharing comparison results
- Snapshot check before terminology analysis
- New default rule for type switching detection
- Filter for string to identifier type conversions
- Configuration option to skip terminology analysis (`skipTerminologyAnalysis`)
- Enhanced rule templates for better findings descriptions
- npm registry publishing workflow

### Changed
- Limited SUSHI runs to only when necessary (snapshot generation)
- Improved terminology report to exclude findings from main score

### Fixed
- ZIP content structure and completeness
- False positive triggers in type change detection
- Package.json configuration issues
- Workflow authorization for npm publishing

## [1.0.*] - 2026-01-23

### Added
- Initial release
- Automated FHIR R4 to R6 migration pipeline
- GoFSH integration for FSH generation from FHIR packages
- SUSHI upgrade automation with R6 migration
- Profile comparison using HL7 FHIR Validator
- Rule-based migration analysis engine
- Configurable rules with default rule set
- Migration complexity scoring
- Markdown report generation with timestamps
- Incremental and full comparison modes
- Smart skip logic based on filesystem state
- Configuration schema validation with versioning
- CLI tool (`fhir-r6-migrate`)
- Programmatic API for integration
- Comprehensive documentation

### Features
- Downloads FHIR packages from official registry
- Converts resources to FSH using GoFSH
- Automatically upgrades R4 profiles to R6
- Compares R4 vs R6 profiles side-by-side
- Identifies migration challenges via rules
- Generates detailed reports with findings
- Supports custom rules configuration
- Auto-downloads validator JAR if needed
- Resume capability via filesystem checks
- Timestamped report filenames

[Unreleased]: https://github.com/Gefyra/fhir-r6-migration-runner/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Gefyra/fhir-r6-migration-runner/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Gefyra/fhir-r6-migration-runner/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Gefyra/fhir-r6-migration-runner/releases/tag/v1.0.0
