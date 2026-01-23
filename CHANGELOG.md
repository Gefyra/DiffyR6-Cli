# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-23

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

[1.0.0]: https://github.com/Gefyra/fhir-r6-migration-runner/releases/tag/v1.0.0
