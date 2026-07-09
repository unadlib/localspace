import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));

const findDeclarations = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const declarations = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      declarations.push(...(await findDeclarations(path)));
    } else if (entry.name.endsWith('.d.ts')) {
      declarations.push(path);
    }
  }

  return declarations;
};

const createCommonJsDeclaration = async (declarationPath) => {
  const commonJsPath = declarationPath.replace(/\.d\.ts$/, '.d.cts');
  const declaration = await readFile(declarationPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    declarationPath,
    declaration,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const replacements = [];

  const addReplacement = (specifier) => {
    if (!/^\.{1,2}\//.test(specifier.text) || !specifier.text.endsWith('.js')) {
      return;
    }
    replacements.push({
      start: specifier.getStart(sourceFile) + 1,
      end: specifier.getEnd() - 1,
      value: `${specifier.text.slice(0, -3)}.cjs`,
    });
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addReplacement(node.moduleSpecifier);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      addReplacement(node.argument.literal);
    } else if (
      ts.isExternalModuleReference(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression)
    ) {
      addReplacement(node.expression);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  let commonJsDeclaration = declaration;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    commonJsDeclaration =
      commonJsDeclaration.slice(0, replacement.start) +
      replacement.value +
      commonJsDeclaration.slice(replacement.end);
  }
  commonJsDeclaration = commonJsDeclaration.replace(
    /\n?\/\/# sourceMappingURL=.*\.d\.ts\.map\s*$/,
    '\n'
  );

  await writeFile(commonJsPath, commonJsDeclaration);
};

const declarations = await findDeclarations(distDirectory);
await Promise.all(declarations.map(createCommonJsDeclaration));
