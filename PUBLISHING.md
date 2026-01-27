# Publishing DiffyR6-Cli to npm

This document explains how to publish the package to npm registry.

## Prerequisites

1. **npm Account**: Create account at https://www.npmjs.com
2. **npm Token**: Generate access token in npm account settings
3. **GitHub Secret**: Add token as `NPM_TOKEN` in repository secrets

## Setup npm Token

1. Go to https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Click "Generate New Token" → "Automation"
3. Copy the token
4. Go to GitHub repo → Settings → Secrets → Actions
5. Add new secret: `NPM_TOKEN` = your token

## Publishing Methods

### Method 1: GitHub Release (Recommended)

Create a new release on GitHub:

```bash
# Tag the release
git tag v1.0.0
git push origin v1.0.0

# Create release on GitHub UI
# The workflow will automatically publish to npm
```

### Method 2: Manual Workflow Dispatch

1. Go to Actions → "Publish to npm"
2. Click "Run workflow"
3. Enter version (e.g., `1.0.0`)
4. Click "Run workflow"

### Method 3: Local Publish (Not Recommended)

```bash
# Login to npm
npm login

# Publish
npm publish --access public
```

## After Publishing

Update main project's package.json:

```json
{
  "dependencies": {
    "@gefyra/diffyr6-cli": "^1.0.0"  // Instead of "file:./packages/runner"
  }
}
```

## Version Management

Follow semantic versioning:
- **Major** (1.0.0): Breaking changes
- **Minor** (0.1.0): New features, backward compatible
- **Patch** (0.0.1): Bug fixes

Update version in package.json before publishing:

```bash
npm version major  # 1.0.0 → 2.0.0
npm version minor  # 1.0.0 → 1.1.0
npm version patch  # 1.0.0 → 1.0.1
```

## Workflow Details

The publish workflow:
1. ✅ Checks out code
2. ✅ Sets up Node.js 18
3. ✅ Installs dependencies
4. ✅ Runs tests (if available)
5. ✅ Updates version (manual trigger only)
6. ✅ Publishes to npm with provenance
7. ✅ Creates summary

## Files Excluded from Package

See `.npmignore` for excluded files:
- Development files (.git, .github, .vscode)
- Tests (test/, *.test.js)
- Documentation source (docs/)
- Build artifacts (*.log)
- Temporary files (tmp/, workdir/)

## Troubleshooting

### "Package already exists"
- Increment version in package.json
- You cannot re-publish same version

### "Authentication failed"
- Verify NPM_TOKEN secret is set
- Check token hasn't expired
- Ensure token has "Automation" permissions

### "Package name not available"
- @gefyra scope must be available
- Or publish under different scope/name

## Migration Path

### Current State (Local)
```json
"@gefyra/diffyr6-cli": "file:./packages/runner"
```

### After npm Publish
```json
"@gefyra/diffyr6-cli": "^1.0.0"
```

### Benefits
- ✅ Users can install with `npm install`
- ✅ Version management with semver
- ✅ Automatic updates with `npm update`
- ✅ No submodule needed for users
- ✅ Faster CI/CD (no git submodule clone)

## First Release Checklist

- [ ] Create npm account
- [ ] Generate npm token
- [ ] Add NPM_TOKEN to GitHub secrets
- [ ] Update package.json version to 1.0.0
- [ ] Update README with install instructions
- [ ] Create GitHub release v1.0.0
- [ ] Verify package on https://www.npmjs.com/package/@gefyra/diffyr6-cli
- [ ] Update main project to use npm version
- [ ] Test installation: `npm install @gefyra/diffyr6-cli`

## Keeping Submodule

You can keep the submodule for development:

```json
{
  "dependencies": {
    "@gefyra/diffyr6-cli": "^1.0.0"  // Production
  },
  "devDependencies": {
    "@gefyra/diffyr6-cli-dev": "file:./packages/runner"  // Development
  }
}
```

Or use npm link for development:

```bash
# In packages/runner/
npm link

# In main project
npm link @gefyra/diffyr6-cli
```
