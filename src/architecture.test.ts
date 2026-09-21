import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const walk = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = `${directory}/${entry.name}`;
  return entry.isDirectory() ? walk(file) : [file];
});
const files = walk('src').filter(file => /\.tsx?$/.test(file) && !/(\.test\.|fixtures|conformance)/.test(file));
const trees = new Map(files.map(file => [file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)]));
const dependencies = new Map<string, string[]>();
const unsupported: string[] = [];
for (const [file, tree] of trees) {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    const dynamic = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require');
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : dynamic ? (node as ts.CallExpression).arguments[0] : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    if (dynamic && (!specifier || !ts.isStringLiteral(specifier))) unsupported.push(`${file}: nonliteral module load`);
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text));
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(value => trees.has(value));
      if (target) imports.push(target);
      else if (!/\.(css|svg)$/.test(base)) unsupported.push(`${file}: unresolved ${specifier.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); dependencies.set(file, imports);
}

describe('checked production architecture', () => {
  it('resolves static, re-exported and dynamic imports and has no production cycles', () => {
    expect(unsupported).toEqual([]);
    const completed = new Set<string>(), cycles: string[] = [];
    const visit = (file: string, stack: string[]): void => {
      if (stack.includes(file)) { cycles.push([...stack, file].join(' -> ')); return; }
      if (completed.has(file)) return;
      for (const target of dependencies.get(file) ?? []) visit(target, [...stack, file]);
      completed.add(file);
    };
    for (const file of files) visit(file, []);
    expect(cycles).toEqual([]);
  });
  it('keeps capabilities and feature ownership separate', () => {
    const errors: string[] = [];
    const forbidden = (from: string, to: string): boolean => {
      if (!from.startsWith('src/ui/') && from !== 'src/main.ts' && to.startsWith('src/ui/')) return true;
      if (from.startsWith('src/core/') && !to.startsWith('src/core/')) return true;
      if (/^src\/(scanner|robots|market|portfolio)\//.test(from) && /^src\/broker\/(alpaca|market-data|stream|http|connection)\.ts$/.test(to)) return true;
      if (/^src\/(scanner|robots|market)\//.test(from) && to.startsWith('src/trading/')) return true;
      if (from.startsWith('src/portfolio/') && to.startsWith('src/trading/') && to !== 'src/trading/records.ts') return true;
      if (from.startsWith('src/trading/') && /^src\/robots\/(service|documents|research\/)/.test(to)) return true;
      if (from.startsWith('src/ui/') && /^src\/broker\//.test(to)) return true;
      return false;
    };
    for (const [from, targets] of dependencies) for (const to of targets) if (forbidden(from, to)) errors.push(`${from} -> ${to}`);
    expect(errors).toEqual([]);
  });
  it('allows broker mutations at the executor call site only', () => {
    const violations: string[] = [];
    for (const [file, tree] of trees) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['submitOrder', 'cancelOrder', 'closePosition'].includes(node.expression.name.text)
          && file !== 'src/trading/executor.ts') violations.push(`${file}: ${node.expression.name.text}`);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(violations).toEqual([]);
    const source = fs.readFileSync('src/broker/connection.ts', 'utf8');
    expect(source).not.toMatch(/\bas\s+(?:unknown|AccountReads|DataReads|MarketReads)|\bPick</);
  });
  it('keeps numerical kernels free of ambient time, storage, DOM and network', () => {
    const kernels = files.filter(file => /^src\/robots\/(math|templates)\//.test(file)
      || /^src\/scanner\/(engine|state)\.ts$/.test(file) || file === 'src/portfolio/accounting.ts' || file === 'src/market/indicators.ts');
    const violations: string[] = [];
    for (const file of kernels) {
      const source = fs.readFileSync(file, 'utf8');
      if (/\b(Date\.now|document|localStorage|sessionStorage|indexedDB|fetch|WebSocket)\b|new Date\(\)/.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
