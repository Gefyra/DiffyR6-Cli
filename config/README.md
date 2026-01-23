# Example Configuration

This directory contains example configuration files for the FHIR R4 to R6 Migration Runner.

## Files

- `default-rules.json` - Default rule set for migration analysis (used automatically if no custom rules specified)

## Creating Custom Rules

Copy `default-rules.json` and modify it for your needs:

```bash
cp config/default-rules.json my-custom-rules.json
```

Then reference it in your migration config:

```json
{
  "rulesConfigPath": "./my-custom-rules.json"
}
```

## Rule Configuration Structure

See README.md for detailed information about rule configuration format and available options.
