# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Note on versioning:** Minor bugfixes and patches that don't introduce new features are released as patch versions (e.g., 1.1.1, 1.1.2) and are not explicitly listed in this changelog. Only feature releases (minor versions) and breaking changes (major versions) are documented here.

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

[Unreleased]: https://github.com/Gefyra/fhir-r6-migration-runner/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Gefyra/fhir-r6-migration-runner/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Gefyra/fhir-r6-migration-runner/releases/tag/v1.0.0
