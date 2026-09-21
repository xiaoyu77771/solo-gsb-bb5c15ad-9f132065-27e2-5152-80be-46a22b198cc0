'use strict';

const semver = require('semver');

class ResolutionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ResolutionError';
    this.statusCode = 400;
    this.details = details;
  }
}

const ROOT_SOURCE = Object.freeze({ type: 'root' });
const UPDATE_SOURCE = Object.freeze({ type: 'update' });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyName(name, location) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ResolutionError(`${location} names must be non-empty strings.`);
  }
}

function compareSource(a, b) {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.type === 'root' || a.type === 'update') return 0;
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  return semver.compareBuild(a.version, b.version);
}

function compareConstraints(a, b) {
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  return compareSource(a.source, b.source);
}

function comparePathNodes(a, b) {
  // Root-level constraints carry empty chains, so both nodes may be absent.
  if (a.name === undefined && b.name === undefined) return 0;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const versionResult = semver.compareBuild(a.version, b.version);
  if (versionResult !== 0) return versionResult;
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  return compareSource(a.source, b.source);
}

/**
 * Convert and validate the request body into Maps that do not retain the
 * caller's object insertion order.
 */
function normalizeInput(input) {
  if (!isPlainObject(input)) {
    throw new ResolutionError('The request body must be a JSON object.');
  }

  const { registry, root } = input;

  if (!isPlainObject(registry)) {
    throw new ResolutionError('registry must be an object mapping package names to versions.');
  }
  if (!isPlainObject(root)) {
    throw new ResolutionError('root must be an object mapping dependency names to semver ranges.');
  }

  const catalog = new Map();

  for (const packageName of Object.keys(registry).sort()) {
    assertNonEmptyName(packageName, 'registry');
    const versionsInput = registry[packageName];

    if (!isPlainObject(versionsInput)) {
      throw new ResolutionError(`registry.${packageName} must map versions to package metadata.`);
    }

    const canonicalVersionEntries = Object.entries(versionsInput).map(([version, metadata]) => {
      if (!semver.valid(version)) {
        throw new ResolutionError(`"${version}" in registry.${packageName} is not a valid semver version.`);
      }
      return { originalVersion: version, canonicalVersion: semver.parse(version).version, metadata };
    });

    canonicalVersionEntries.sort((a, b) =>
      semver.rcompare(a.canonicalVersion, b.canonicalVersion)
    );

    const versionEntries = [];
    const canonicalVersions = new Set();

    for (const { originalVersion: version, canonicalVersion, metadata } of canonicalVersionEntries) {
      if (canonicalVersions.has(canonicalVersion)) {
        throw new ResolutionError(
          `registry.${packageName} contains duplicate canonical version ${canonicalVersion}.`
        );
      }
      canonicalVersions.add(canonicalVersion);
      if (!isPlainObject(metadata)) {
        throw new ResolutionError(`registry.${packageName}.${version} must be an object.`);
      }

      const dependencies = new Map();
      if (metadata.dependencies !== undefined) {
        if (!isPlainObject(metadata.dependencies)) {
          throw new ResolutionError(
            `registry.${packageName}.${version}.dependencies must be an object.`
          );
        }

        for (const dependencyName of Object.keys(metadata.dependencies).sort()) {
          assertNonEmptyName(dependencyName, 'dependency');
          const range = metadata.dependencies[dependencyName];
          if (typeof range !== 'string' || semver.validRange(range) === null) {
            throw new ResolutionError(
              `Dependency "${dependencyName}" of ${packageName}@${version} has an invalid semver range.`
            );
          }
          dependencies.set(dependencyName, range);
        }
      }

      versionEntries.push({
        version: canonicalVersion,
        dependencies,
      });
    }

    if (versionEntries.length === 0) {
      throw new ResolutionError(`registry.${packageName} must contain at least one version.`);
    }

    catalog.set(packageName, versionEntries);
  }

  const rootRequirements = new Map();
  for (const packageName of Object.keys(root).sort()) {
    assertNonEmptyName(packageName, 'root');
    const range = root[packageName];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      throw new ResolutionError(`root.${packageName} must be a valid semver range string.`);
    }
    rootRequirements.set(packageName, range);
  }

  return { catalog, rootRequirements };
}

function serializeSource(source) {
  if (source.type === 'root') return { type: 'root' };
  if (source.type === 'update') return { type: 'update' };
  return {
    type: 'dependency',
    package: source.package,
    version: source.version,
  };
}

function cloneConstraints(constraints) {
  const result = new Map();
  for (const [name, entries] of constraints) {
    result.set(name, entries.map((entry) => ({ ...entry, source: { ...entry.source } })));
  }
  return result;
}

function cloneReasons(reasons) {
  const result = new Map();
  for (const [name, chains] of reasons) {
    result.set(name, chains.map((chain) => chain.map((node) => ({
      name: node.name,
      version: node.version,
      range: node.range,
      source: { ...node.source },
    }))));
  }
  return result;
}

function cloneSelected(selected) {
  const result = new Map();
  for (const [name, entry] of selected) {
    result.set(name, {
      ...entry,
      source: { ...entry.source },
      path: entry.path.map((node) => ({ ...node, source: { ...node.source } })),
    });
  }
  return result;
}

function sourceLabel(source) {
  if (source.type === 'root') return 'root';
  if (source.type === 'update') return 'update';
  return `${source.package}@${source.version}`;
}

function choosePrimaryConstraint(entries, chains) {
  let bestIndex = 0;

  for (let i = 1; i < entries.length; i += 1) {
    const best = chains[bestIndex];
    const current = chains[i];

    if (
      current.length > best.length ||
      (current.length === best.length && comparePathNodes(
        current[current.length - 1] || {},
        best[best.length - 1] || {}
      ) < 0)
    ) {
      bestIndex = i;
    }
  }

  return { entry: entries[bestIndex], chain: chains[bestIndex] };
}

function buildEndpointConstraints(entries) {
  return entries
    .map((entry) => ({
      requiredRange: entry.range,
      requiredBy: serializeSource(entry.source),
    }))
    .sort((a, b) => compareConstraints(
      { range: a.requiredRange, source: a.requiredBy },
      { range: b.requiredRange, source: b.requiredBy }
    ));
}

function buildConflict(target, state, reasonCode, catalog) {
  const entries = state.constraints.get(target) || [];
  const chains = state.reasons.get(target) || [];
  const primary = choosePrimaryConstraint(entries, chains);
  const selected = state.selected.get(target);
  const availableVersions = (catalog.get(target) || []).map((entry) => entry.version);
  const compatibleVersions = availableVersions.filter((version) =>
    satisfiesAll(version, entries)
  );

  const chain = primary.chain.map((node) => ({
    package: node.name,
    selectedVersion: node.version,
    requiredRange: node.range,
    requiredBy: serializeSource(node.source),
  }));

  chain.push({
    package: target,
    ...(selected ? { selectedVersion: selected.version } : {}),
    requiredRange: primary.entry.range,
    requiredBy: serializeSource(primary.entry.source),
    constraints: buildEndpointConstraints(entries),
    availableVersions,
    compatibleVersions,
    reasonCode,
  });

  return {
    satisfiable: false,
    conflict: {
      package: target,
      reasonCode,
      chain,
    },
  };
}

function satisfiesAll(version, constraints) {
  return constraints.every(({ range }) => semver.satisfies(version, range));
}

function byName(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * Build the initial solver state from named requirement sets. Each set
 * contributes one constraint per package, inserted in sorted package-name
 * order so the state never depends on the caller's key order.
 */
function buildInitialState(requirementSets) {
  const constraints = new Map();
  const reasons = new Map();

  for (const { requirements, source } of requirementSets) {
    for (const [name, range] of [...requirements.entries()].sort(byName)) {
      if (!constraints.has(name)) {
        constraints.set(name, []);
        reasons.set(name, []);
      }
      constraints.get(name).push({ range, source: { ...source } });
      reasons.get(name).push([]);
    }
  }

  return { constraints, reasons, selected: new Map() };
}

/**
 * Select a candidate version for target and propagate its dependencies into
 * a cloned state. Returns { state } on success or { conflict } when one of
 * the new dependency ranges contradicts an already selected version.
 */
function applyCandidate(state, target, candidate, catalog) {
  const nextConstraints = cloneConstraints(state.constraints);
  const nextReasons = cloneReasons(state.reasons);
  const nextSelected = cloneSelected(state.selected);

  const targetEntries = nextConstraints.get(target);
  const targetChains = nextReasons.get(target);
  const primary = choosePrimaryConstraint(targetEntries, targetChains);

  const selectedEntry = {
    version: candidate.version,
    range: primary.entry.range,
    source: { ...primary.entry.source },
    path: primary.chain.map((node) => ({ ...node, source: { ...node.source } })),
  };
  nextSelected.set(target, selectedEntry);

  const pathNode = {
    name: target,
    version: candidate.version,
    range: primary.entry.range,
    source: { ...primary.entry.source },
  };
  const dependencyChain = [...selectedEntry.path, pathNode];

  for (const dependencyName of [...candidate.dependencies.keys()].sort()) {
    const range = candidate.dependencies.get(dependencyName);
    const source = {
      type: 'dependency',
      package: target,
      version: candidate.version,
    };
    const constraint = { range, source };

    if (!nextConstraints.has(dependencyName)) {
      nextConstraints.set(dependencyName, []);
      nextReasons.set(dependencyName, []);
    }

    nextConstraints.get(dependencyName).push(constraint);
    nextReasons.get(dependencyName).push(
      dependencyChain.map((node) => ({ ...node, source: { ...node.source } }))
    );

    const alreadySelected = nextSelected.get(dependencyName);
    if (alreadySelected && !semver.satisfies(alreadySelected.version, range)) {
      return {
        conflict: buildConflict(
          dependencyName,
          {
            constraints: nextConstraints,
            reasons: nextReasons,
            selected: nextSelected,
          },
          'SELECTED_VERSION_DOES_NOT_SATISFY_CONSTRAINT',
          catalog
        ),
      };
    }
  }

  return {
    state: {
      constraints: nextConstraints,
      reasons: nextReasons,
      selected: nextSelected,
    },
  };
}

function solve({ catalog, rootRequirements }) {
  const initialState = buildInitialState([
    { requirements: rootRequirements, source: ROOT_SOURCE },
  ]);
  let firstConflict = null;

  function recordConflict(conflict) {
    if (firstConflict === null) firstConflict = conflict;
    return null;
  }

  function dfs(state) {
    const unresolved = [...state.constraints.keys()]
      .filter((name) => !state.selected.has(name))
      .sort();

    if (unresolved.length === 0) {
      return [...state.selected.entries()]
        .sort(byName)
        .map(([name, entry]) => ({
          package: name,
          version: entry.version,
        }));
    }

    const target = unresolved[0];
    const targetConstraints = state.constraints.get(target);
    const availableVersions = catalog.get(target) || [];
    const candidates = availableVersions.filter((entry) =>
      satisfiesAll(entry.version, targetConstraints)
    );

    if (candidates.length === 0) {
      const reasonCode = availableVersions.length === 0
        ? 'PACKAGE_NOT_IN_REGISTRY'
        : 'NO_VERSION_SATISFIES_CONSTRAINTS';
      return recordConflict(buildConflict(target, state, reasonCode, catalog));
    }

    for (const candidate of candidates) {
      const result = applyCandidate(state, target, candidate, catalog);
      if (result.conflict) {
        recordConflict(result.conflict);
        continue;
      }

      const solution = dfs(result.state);
      if (solution) return solution;
    }

    return null;
  }

  const plan = dfs(initialState);

  if (plan) {
    return {
      satisfiable: true,
      plan,
    };
  }

  return firstConflict;
}

function normalizeLocked(locked) {
  if (!isPlainObject(locked)) {
    throw new ResolutionError('locked must be an object mapping package names to locked versions.');
  }

  const result = new Map();
  for (const packageName of Object.keys(locked).sort()) {
    assertNonEmptyName(packageName, 'locked');
    const version = locked[packageName];
    if (typeof version !== 'string' || !semver.valid(version)) {
      throw new ResolutionError(`locked.${packageName} must be a valid semver version string.`);
    }
    result.set(packageName, semver.parse(version).version);
  }
  return result;
}

function normalizeUpdate(update) {
  if (!isPlainObject(update)) {
    throw new ResolutionError('update must be an object mapping package names to semver ranges.');
  }

  const result = new Map();
  for (const packageName of Object.keys(update).sort()) {
    assertNonEmptyName(packageName, 'update');
    const range = update[packageName];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      throw new ResolutionError(`update.${packageName} must be a valid semver range string.`);
    }
    result.set(packageName, range);
  }
  return result;
}

/**
 * Total order over feasible plans: fewer changes relative to locked wins;
 * ties are broken by walking package names in lexicographic order and
 * preferring the higher version (a plan that contains the package beats one
 * that does not). Returns 0 only for identical plans.
 */
function comparePlans(a, b) {
  if (a.changes !== b.changes) return a.changes - b.changes;

  const names = [...new Set([...a.versions.keys(), ...b.versions.keys()])].sort();
  for (const name of names) {
    const aVersion = a.versions.get(name);
    const bVersion = b.versions.get(name);
    if (aVersion === undefined && bVersion === undefined) continue;
    if (aVersion === undefined) return 1;
    if (bVersion === undefined) return -1;
    const order = semver.compareBuild(aVersion, bVersion);
    if (order !== 0) return -order;
  }
  return 0;
}

function solveUpdate({ catalog, rootRequirements, updateRequirements, locked }) {
  const initialState = buildInitialState([
    { requirements: rootRequirements, source: ROOT_SOURCE },
    { requirements: updateRequirements, source: UPDATE_SOURCE },
  ]);

  let firstConflict = null;
  let best = null;

  function recordConflict(conflict) {
    if (firstConflict === null) firstConflict = conflict;
  }

  // Lower bound on the changes any completion of this state still needs.
  // Selections are final, and every constrained package missing from locked
  // must appear in the final plan. Locked packages not yet constrained are
  // not counted: a later selection may still pull them into the plan.
  function lowerBoundChanges(state) {
    let count = 0;
    for (const [name, entry] of state.selected) {
      if (locked.get(name) !== entry.version) count += 1;
    }
    for (const name of state.constraints.keys()) {
      if (!state.selected.has(name) && !locked.has(name)) count += 1;
    }
    return count;
  }

  function exactChanges(selected) {
    let count = 0;
    for (const [name, entry] of selected) {
      if (locked.get(name) !== entry.version) count += 1;
    }
    for (const name of locked.keys()) {
      if (!selected.has(name)) count += 1;
    }
    return count;
  }

  function dfs(state) {
    if (best !== null && lowerBoundChanges(state) > best.changes) return;

    const unresolved = [...state.constraints.keys()]
      .filter((name) => !state.selected.has(name))
      .sort();

    if (unresolved.length === 0) {
      const plan = [...state.selected.entries()]
        .sort(byName)
        .map(([name, entry]) => ({
          package: name,
          version: entry.version,
        }));
      const candidate = {
        plan,
        changes: exactChanges(state.selected),
        versions: new Map(plan.map((entry) => [entry.package, entry.version])),
      };
      if (best === null || comparePlans(candidate, best) < 0) best = candidate;
      return;
    }

    const target = unresolved[0];
    const targetConstraints = state.constraints.get(target);
    const availableVersions = catalog.get(target) || [];
    const candidates = availableVersions.filter((entry) =>
      satisfiesAll(entry.version, targetConstraints)
    );

    if (candidates.length === 0) {
      const reasonCode = availableVersions.length === 0
        ? 'PACKAGE_NOT_IN_REGISTRY'
        : 'NO_VERSION_SATISFIES_CONSTRAINTS';
      recordConflict(buildConflict(target, state, reasonCode, catalog));
      return;
    }

    // Try the locked version first so low-change plans are found early; the
    // remaining candidates keep their descending version order.
    const lockedVersion = locked.get(target);
    const ordered = lockedVersion === undefined
      ? candidates
      : candidates
        .filter((entry) => entry.version === lockedVersion)
        .concat(candidates.filter((entry) => entry.version !== lockedVersion));

    const bound = lowerBoundChanges(state);

    for (const candidate of ordered) {
      const cost = candidate.version === lockedVersion ? 0 : 1;
      if (best !== null && bound + cost > best.changes) continue;

      const result = applyCandidate(state, target, candidate, catalog);
      if (result.conflict) {
        recordConflict(result.conflict);
        continue;
      }

      dfs(result.state);
    }
  }

  dfs(initialState);

  if (best === null) return firstConflict;

  const kept = [];
  const changed = [];

  for (const { package: name, version } of best.plan) {
    const lockedVersion = locked.get(name);
    if (lockedVersion === undefined) {
      changed.push({ package: name, from: null, to: version });
    } else if (lockedVersion !== version) {
      changed.push({ package: name, from: lockedVersion, to: version });
    } else {
      kept.push({ package: name, version });
    }
  }

  for (const [name, lockedVersion] of [...locked.entries()].sort(byName)) {
    if (!best.versions.has(name)) {
      changed.push({ package: name, from: lockedVersion, to: null });
    }
  }

  changed.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));

  return {
    satisfiable: true,
    plan: best.plan,
    kept,
    changed,
  };
}

function resolve(input) {
  return solve(normalizeInput(input));
}

function planUpdate(input) {
  const { catalog, rootRequirements } = normalizeInput(input);
  const locked = normalizeLocked(input.locked);
  const updateRequirements = normalizeUpdate(input.update);
  return solveUpdate({ catalog, rootRequirements, updateRequirements, locked });
}

module.exports = {
  ResolutionError,
  normalizeInput,
  planUpdate,
  resolve,
  sourceLabel,
};
