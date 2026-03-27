import { stripHtml, normalizeWhitespace, decodeEntities } from './utils/html.js';

/**
 * Evaluates rules against HTML comparison files and returns matches
 */
export function evaluateRulesForHtmlFiles(htmlFiles, rulesConfig) {
  if (!rulesConfig || !Array.isArray(rulesConfig.tables)) {
    return [];
  }
  const results = [];
  
  // First, process error files (xx-*.html) for comparison failures
  for (const htmlFile of htmlFiles) {
    if (!htmlFile || !htmlFile.content) {
      continue;
    }
    const filename = htmlFile.filename || '';
    if (filename.startsWith('xx-')) {
      const errorResult = processComparisonError(htmlFile, rulesConfig);
      if (errorResult) {
        results.push(errorResult);
      }
    }
  }
  
  for (const tableConfig of rulesConfig.tables) {
    if (!Array.isArray(tableConfig.rules) || tableConfig.rules.length === 0) {
      continue;
    }
    const sectionHeading = tableConfig.sectionHeading || 'Structure';
    const groupOrderMap = computeGroupOrder(tableConfig.rules);
    for (const htmlFile of htmlFiles) {
      if (!htmlFile || !htmlFile.content) {
        continue;
      }
      // Skip error files, already processed
      const filename = htmlFile.filename || '';
      if (filename.startsWith('xx-')) {
        continue;
      }
      const tables = findSectionTables(htmlFile.content, sectionHeading);
      if (tables.length === 0) {
        continue;
      }
      const targetTables =
        typeof tableConfig.tableIndex === 'number'
          ? tables[tableConfig.tableIndex]
            ? [tables[tableConfig.tableIndex]]
            : []
          : tables;
      if (targetTables.length === 0) {
        continue;
      }
      for (const tableHtml of targetTables) {
        const parsed = parseTable(tableHtml);
        if (!parsed || parsed.headers.length === 0) {
          continue;
        }
        for (const row of parsed.rows) {
          const matches = applyRules(
            tableConfig.rules,
            row,
            parsed.headers,
            htmlFile.filename || '',
            sectionHeading,
            groupOrderMap
          );
          for (const match of matches) {
            results.push({
              text: match.text,
              group: match.group,
              description: match.description,
              rank: match.rank,
              value: match.value,
              elementPath: match.elementPath,
              file: match.file,
              groupOrder: match.groupOrder,
            });
          }
        }
      }
    }
  }
  return results;
}

function processComparisonError(htmlFile, rulesConfig) {
  const filename = htmlFile.filename || '';
  const content = htmlFile.content || '';
  
  // Extract error message from content (between <pre> tags)
  const preMatch = content.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  let errorMessage = preMatch ? stripHtml(preMatch[1]).trim() : 'Unknown comparison error';
  
  // Keep only the first line of the error message
  const firstLine = errorMessage.split('\n')[0];
  errorMessage = firstLine || 'Unknown comparison error';
  
  // Extract profile name from filename (xx-ProfileName-ProfileNameR6.html)
  const nameMatch = filename.match(/^xx-(.+?)(?:-[A-Za-z0-9]+)?\.html$/);
  const profileName = nameMatch ? nameMatch[1] : filename.replace(/\.html$/, '');
  
  // Find the error rule in rulesConfig
  if (!rulesConfig.tables || !Array.isArray(rulesConfig.tables)) {
    return null;
  }
  
  let errorRule = null;
  for (const tableConfig of rulesConfig.tables) {
    if (Array.isArray(tableConfig.rules)) {
      errorRule = tableConfig.rules.find(rule => 
        rule.name && rule.name.includes('Comparison Error')
      );
      if (errorRule) break;
    }
  }
  
  if (!errorRule) {
    return null;
  }
  
  // Build the template variables - use lowercase keys for template matching
  const variables = {
    name: profileName,
    message: errorMessage,
    file: filename,
    section: 'Error'
  };
  
  const renderedText = renderTemplate(errorRule.template || '', variables);
  
  return {
    text: renderedText,
    group: errorRule.name || 'Comparison Errors',
    description: errorRule.description || '',
    rank: errorRule.rank || 999,
    value: errorRule.value || 15,
    elementPath: profileName,
    file: filename,
    groupOrder: 0
  };
}

function computeGroupOrder(rules = []) {
  const order = new Map();
  rules.forEach((rule, index) => {
    const key = resolveRuleGroup(rule);
    if (!order.has(key)) {
      order.set(key, index);
    }
  });
  return order;
}

function resolveRuleGroup(rule) {
  return rule.name || rule.description || '';
}

function findSectionTables(html, heading) {
  const tables = [];
  const headingRegex = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;
  const desiredHeading = heading.toLowerCase();
  while ((match = headingRegex.exec(html))) {
    const text = normalizeWhitespace(stripHtml(match[1])).toLowerCase();
    if (!text.includes(desiredHeading)) {
      continue;
    }
    const sectionStart = headingRegex.lastIndex;
    const nextHeadingRegex = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
    nextHeadingRegex.lastIndex = sectionStart;
    const nextMatch = nextHeadingRegex.exec(html);
    const sectionEnd = nextMatch ? nextMatch.index : html.length;
    let cursor = sectionStart;
    while (cursor < sectionEnd) {
      const { block, endIndex } = captureNextTable(
        html,
        cursor,
        sectionEnd
      );
      if (!block) {
        break;
      }
      tables.push(block);
      cursor = endIndex;
    }
  }
  return tables;
}

function captureNextTable(html, startIndex, limitIndex) {
  const openRegex = /<table\b[^>]*>/gi;
  openRegex.lastIndex = startIndex;
  const openMatch = openRegex.exec(html);
  if (!openMatch || (limitIndex != null && openMatch.index >= limitIndex)) {
    return { block: null, endIndex: startIndex };
  }
  const start = openMatch.index;
  const tagRegex = /<\/?table\b[^>]*>/gi;
  tagRegex.lastIndex = start;
  let depth = 0;
  let end = null;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(html))) {
    if (limitIndex != null && tagMatch.index >= limitIndex) {
      break;
    }
    if (tagMatch[0][1] === '/') {
      depth -= 1;
      if (depth === 0) {
        end = tagRegex.lastIndex;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (end === null) {
    return { block: null, endIndex: startIndex };
  }
  return { block: html.slice(start, end), endIndex: end };
}

function parseTable(tableHtml) {
  const header = parseHeaderRow(tableHtml);
  if (!header) {
    return null;
  }
  const rows = parseDataRows(tableHtml, header);
  return { headers: header, rows };
}

function parseHeaderRow(tableHtml) {
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableHtml))) {
    if (/<th\b/i.test(match[1])) {
      const cells = [...match[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
      const names = cells.map((cell) =>
        normalizeWhitespace(stripHtml(cell[1]))
      );
      return buildHeaderMeta(names);
    }
  }
  return null;
}

function buildHeaderMeta(names) {
  const used = new Set();
  return names.map((label, index) => {
    let alias = label
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!alias) {
      alias = `Column${index + 1}`;
    }
    let finalAlias = alias;
    let counter = 2;
    while (used.has(finalAlias.toLowerCase())) {
      finalAlias = `${alias}_${counter}`;
      counter += 1;
    }
    used.add(finalAlias.toLowerCase());
    return {
      label,
      alias: finalAlias,
      index,
      lookupKey: finalAlias.toLowerCase(),
    };
  });
}

function parseDataRows(tableHtml, headers) {
  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  let headerConsumed = false;
  while ((match = rowRegex.exec(tableHtml))) {
    if (!headerConsumed) {
      if (/<th\b/i.test(match[1])) {
        headerConsumed = true;
      }
      continue;
    }
    if (!/<td\b/i.test(match[1])) {
      continue;
    }
    rows.push(parseRow(match[1], headers));
  }
  return rows;
}

function parseRow(rowHtml, headers) {
  const cells = splitTopLevelCells(rowHtml).map((cell) => {
    const cellInfo = extractCellText(cell.html || '');
    return {
      raw: cell.html || '',
      attrs: cell.attrs || '',
      text: cellInfo.text,
      titles: cellInfo.titles,
      span: parseColspan(cell.attrs),
    };
  });

  const values = {};
  const indexVars = {};
  const meta = {};
  let columnIndex = 0;

  for (const cell of cells) {
    const span = cell.span > 0 ? cell.span : 1;
    for (let i = 0; i < span && columnIndex < headers.length; i += 1) {
      const header = headers[columnIndex];
      if (!Object.prototype.hasOwnProperty.call(values, header.alias)) {
        values[header.alias] = cell.text;
      }
      if (!meta[header.alias]) {
        meta[header.alias] = {
          titles: cell.titles || [],
        };
      }
      indexVars[`col${columnIndex + 1}`] = values[header.alias];
      columnIndex += 1;
    }
  }

  while (columnIndex < headers.length) {
    const header = headers[columnIndex];
    values[header.alias] = values[header.alias] || '';
    indexVars[`col${columnIndex + 1}`] = values[header.alias];
    columnIndex += 1;
  }

  propagateFlagNotes(values, meta, headers);

  return {
    values,
    indexVars,
    rawRow: rowHtml,
  };
}

function extractCellText(innerHtml) {
  const titles = extractAttributeTexts(innerHtml);
  const anchors = extractAnchorTexts(innerHtml);
  const baseText = stripHtml(innerHtml);
  const parts = [];
  if (anchors.length > 0) {
    parts.push(anchors.join(' '));
  } else if (baseText) {
    parts.push(baseText);
  }
  if (titles.length > 0) {
    parts.push(titles.join(' '));
  }
  return {
    text: normalizeWhitespace(parts.join(' ')),
    titles,
  };
}

function extractAttributeTexts(html = '') {
  const titles = [];
  const attrRegex =
    /<([a-z0-9]+)\b[^>]*\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let match;
  while ((match = attrRegex.exec(html))) {
    const tagName = (match[1] || '').toLowerCase();
    if (tagName === 'img') {
      continue;
    }
    const value = match[2] || match[3] || '';
    if (value) {
      titles.push(decodeEntities(value));
    }
  }
  return titles;
}

function extractAnchorTexts(html = '') {
  const anchors = [];
  const anchorRegex =
    /<a\b[^>]*\bname\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let match;
  while ((match = anchorRegex.exec(html))) {
    const value = match[1] || match[2] || '';
    const formatted = formatAnchorName(value);
    if (formatted) {
      anchors.push(formatted);
    }
  }
  return anchors;
}

function formatAnchorName(value = '') {
  if (!value) {
    return '';
  }
  let text = value.trim();
  if (!text) {
    return '';
  }
  if (text.startsWith('cmp-')) {
    text = text.slice(4);
  }
  text = text.replace(/_x_/gi, '[x]');
  text = text.replace(/_$/g, '');
  return text;
}

function propagateFlagNotes(values, meta, headers) {
  appendFlagNotes(values, meta, headers, 'L Flags', 'L Description & Constraints');
  appendFlagNotes(values, meta, headers, 'R Flags', 'R Description & Constraints');
}

function appendFlagNotes(values, meta, headers, flagLabel, descLabel) {
  const flagAlias = findAliasByLabel(headers, flagLabel);
  const descAlias = findAliasByLabel(headers, descLabel);
  if (!flagAlias || !descAlias) {
    return;
  }
  const titles = meta[flagAlias] ? meta[flagAlias].titles : null;
  if (!titles || titles.length === 0) {
    return;
  }
  const extra = normalizeWhitespace(titles.join(' '));
  if (!extra) {
    return;
  }
  const current = values[descAlias] || '';
  values[descAlias] = normalizeWhitespace(`${current} ${extra}`.trim());
}

function findAliasByLabel(headers, label) {
  const lower = label.toLowerCase();
  const header = headers.find((item) => item.label.toLowerCase() === lower);
  return header ? header.alias : null;
}

function parseColspan(attrText = '') {
  const match = attrText.match(/colspan\s*=\s*"?(\d+)"?/i);
  if (!match) {
    return 1;
  }
  const span = parseInt(match[1], 10);
  return Number.isNaN(span) ? 1 : span;
}

function splitTopLevelCells(rowHtml) {
  const cells = [];
  const tokenRegex =
    /<td\b([^>]*)\/>|<td\b([^>]*)>|<\/td\s*>|<table\b[^>]*>|<\/table\s*>/gi;
  let nestedTableDepth = 0;
  let currentCell = null;
  let match;
  while ((match = tokenRegex.exec(rowHtml))) {
    const token = match[0];
    if (/^<table/i.test(token)) {
      if (currentCell) {
        nestedTableDepth += 1;
      }
      continue;
    }
    if (/^<\/table/i.test(token)) {
      if (currentCell && nestedTableDepth > 0) {
        nestedTableDepth -= 1;
      }
      continue;
    }
    if (nestedTableDepth > 0) {
      continue;
    }
    if (match[1] !== undefined) {
      cells.push({
        attrs: match[1] || '',
        html: '',
      });
      continue;
    }
    if (match[2] !== undefined) {
      currentCell = {
        attrs: match[2] || '',
        startIndex: tokenRegex.lastIndex,
      };
      continue;
    }
    if (/^<\/td/i.test(token) && currentCell) {
      const cellHtml = rowHtml.slice(currentCell.startIndex, match.index);
      cells.push({
        attrs: currentCell.attrs,
        html: cellHtml,
      });
      currentCell = null;
    }
  }
  return cells;
}

function applyRules(rules, row, headers, fileName, sectionHeading, groupOrderMap) {
  const outputs = [];
  const headerLookup = buildHeaderLookup(headers);
  const variables = {
    ...row.values,
    ...row.indexVars,
    file: fileName,
    section: sectionHeading,
    profile: fileName,
  };

  for (const rule of rules) {
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
      continue;
    }
    if (!rule.template) {
      continue;
    }
    let matches = true;
    for (const condition of rule.conditions) {
      if (!evaluateCondition(condition, row, headerLookup)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const rank = Number.isFinite(Number(rule.rank)) ? Number(rule.rank) : null;
      const value = Number.isFinite(Number(rule.value)) ? Number(rule.value) : null;
      const elementPath = (row.values['Name'] || '').trim().split(/\s+/)[0] || '';
      outputs.push({
        text: renderTemplate(rule.template, variables),
        group: resolveRuleGroup(rule),
        description: rule.description || '',
        groupOrder: resolveGroupOrder(rule, groupOrderMap),
        rank,
        value,
        elementPath,
        file: fileName,
      });
    }
  }
  return outputs;
}

function resolveGroupOrder(rule, groupOrderMap) {
  const key = resolveRuleGroup(rule);
  if (!groupOrderMap) {
    return Number.MAX_SAFE_INTEGER;
  }
  return groupOrderMap.get(key) ?? Number.MAX_SAFE_INTEGER;
}

function buildHeaderLookup(headers) {
  const lookup = {};
  headers.forEach((header, index) => {
    lookup[header.alias.toLowerCase()] = header.alias;
    lookup[header.label.toLowerCase()] = header.alias;
    lookup[`col${index + 1}`.toLowerCase()] = header.alias;
  });
  return lookup;
}

function evaluateCondition(condition, row, lookup) {
  const columnAlias = resolveColumnAlias(condition.column || '', lookup);
  if (!columnAlias) {
    return false;
  }
  const cellValue = row.values[columnAlias] || '';
  const expected = resolveExpectedValue(condition, row, lookup);
  const operator = normalizeOperator(condition.operator || '');
  const caseSensitive = Boolean(condition.caseSensitive);
  if (operator === 'equals') {
    return compareEquals(cellValue, expected, caseSensitive);
  }
  if (operator === '!equals' || operator === 'notequals' || operator === 'not-equals') {
    return !compareEquals(cellValue, expected, caseSensitive);
  }
  if (operator === 'contains') {
    return compareContains(cellValue, expected, caseSensitive);
  }
  if (operator === 'typesubsetof') {
    return typeListIsSubset(cellValue, expected);
  }
  if (operator === '!typesubsetof') {
    return !typeListIsSubset(cellValue, expected);
  }
  return false;
}

function normalizeOperator(operator) {
  const value = String(operator).trim().toLowerCase();
  if (value === 'nottypesubsetof' || value === 'not-typesubsetof') {
    return '!typesubsetof';
  }
  return value;
}

function resolveExpectedValue(condition, row, lookup) {
  if (condition.valueColumn) {
    const alias = resolveColumnAlias(condition.valueColumn, lookup);
    if (alias) {
      return row.values[alias] || '';
    }
  }
  return condition.value || '';
}

function resolveColumnAlias(column, lookup) {
  if (!column) {
    return null;
  }
  const key = column.toLowerCase();
  return lookup[key] || null;
}

function compareEquals(left, right, caseSensitive) {
  if (caseSensitive) {
    return String(left) === String(right);
  }
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function compareContains(left, right, caseSensitive) {
  if (caseSensitive) {
    return String(left).includes(String(right));
  }
  return String(left).toLowerCase().includes(String(right).toLowerCase());
}

function normalizeTypeName(name) {
  return String(name)
    .trim()
    .replace(/[- ]?r[46]$/i, '')
    .toLowerCase();
}

function normalizeReferenceGroup(referenceStr) {
  const match = String(referenceStr)
    .trim()
    .match(/^reference\s*\((.*)\)$/i);
  if (!match) {
    return `reference:${normalizeTypeName(referenceStr)}`;
  }
  const normalizedTargets = match[1]
    .split('|')
    .map((token) => normalizeTypeName(token))
    .filter(Boolean)
    .sort();
  return `reference:${normalizedTargets.join('|')}`;
}

function parseTypeList(typeStr) {
  const types = new Set();
  const references = [];
  let current = '';
  let depth = 0;

  const pushCurrent = () => {
    const token = current.trim();
    current = '';
    if (!token) {
      return;
    }
    if (token.toLowerCase().startsWith('reference')) {
      references.push(parseReferenceTargets(token));
      return;
    }
    const normalized = normalizeTypeName(token);
    if (normalized) {
      types.add(normalized);
    }
  };

  for (const char of String(typeStr)) {
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      pushCurrent();
      continue;
    }
    current += char;
  }

  pushCurrent();
  return { types, references };
}

function parseReferenceTargets(referenceStr) {
  const normalized = normalizeReferenceGroup(referenceStr);
  const [, targetList = ''] = normalized.split(':');
  return new Set(targetList.split('|').filter(Boolean));
}

function typeListIsSubset(leftStr, rightStr) {
  const leftTypes = parseTypeList(leftStr);
  const rightTypes = parseTypeList(rightStr);
  for (const type of leftTypes.types) {
    if (!rightTypes.types.has(type)) {
      return false;
    }
  }
  for (const leftReference of leftTypes.references) {
    const hasSuperset = rightTypes.references.some((rightReference) => {
      for (const target of leftReference) {
        if (!rightReference.has(target)) {
          return false;
        }
      }
      return true;
    });
    if (!hasSuperset) {
      return false;
    }
  }
  return true;
}

function renderTemplate(template, variables) {
  const rendered = template.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    const resolved = resolveVariableValue(key.trim(), variables);
    return resolved != null ? resolved : '';
  });
  return rendered.replace(/2147483647/g, '*');
}

function resolveVariableValue(key, variables) {
  if (key in variables) {
    return variables[key];
  }
  const normalizedKey = normalizePlaceholderKey(key);
  for (const candidate of Object.keys(variables)) {
    if (normalizePlaceholderKey(candidate) === normalizedKey) {
      return variables[candidate];
    }
  }
  return null;
}

function normalizePlaceholderKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
