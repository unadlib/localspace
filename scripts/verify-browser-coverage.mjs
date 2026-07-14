import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(process.cwd());
const coverageDirectory = path.join(workspaceRoot, '.nyc_output');
const sourceRoot = path.join(workspaceRoot, 'src');

const isWithin = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

const toLocalPath = (fileName) => {
  if (fileName.startsWith('file://')) {
    return fileURLToPath(fileName);
  }
  return path.isAbsolute(fileName)
    ? fileName
    : path.resolve(workspaceRoot, fileName);
};

const coverageDirectoryEntries = await fs
  .readdir(coverageDirectory)
  .catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
const coverageFiles = coverageDirectoryEntries.filter(
  (fileName) => fileName.endsWith('.json') && fileName !== 'vitest.json'
);
const coveredSources = new Set();

const hasExecutedStatement = (fileCoverage) =>
  Object.values(fileCoverage.s ?? {}).some(
    (executionCount) => executionCount > 0
  );

for (const coverageFile of coverageFiles) {
  const coverage = JSON.parse(
    await fs.readFile(path.join(coverageDirectory, coverageFile), 'utf8')
  );

  for (const [fileName, fileCoverage] of Object.entries(coverage)) {
    const localPath = toLocalPath(fileName);
    if (isWithin(localPath, sourceRoot) && hasExecutedStatement(fileCoverage)) {
      coveredSources.add(localPath);
    }
  }
}

if (coveredSources.size === 0) {
  throw new Error(
    '[playwright-coverage] No executed browser coverage mapped to the local src directory.'
  );
}

console.log(
  `[playwright-coverage] Verified browser coverage for ${coveredSources.size} source files.`
);
