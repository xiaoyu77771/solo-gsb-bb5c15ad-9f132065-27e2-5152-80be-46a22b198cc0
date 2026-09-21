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
  if (a.type === 'root') return 0;
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  return semver.compareBuild(a.version, b.version);
}

function compareConstraints(a, b) {
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  return compareSource(a.source, b.source);
}

function comparePathNodes(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const versionResult = semver.compareBuild(a.version, b.version);
  if (versionResult !== 0) return versionResult;
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  return compareSource(a.source, b.source);
}

/**
 * Convert and validate the registry object into a Map that does not retain
 * the caller's object insertion order.
 */
function normalizeRegistry(registry) {
  if (!isPlainObject(registry)) {
    throw new ResolutionError('registry must be an object mapping package names to versions.');
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

  return catalog;
}

/**
 * Convert and validate a "package name -> semver range" object (root
 * requirements or update constraints) into a sorted-name Map.
 */
function normalizeRequirements(requirements, location) {
  if (!isPlainObject(requirements)) {
    throw new ResolutionError(`${location} must be an object mapping dependency names to semver ranges.`);
  }

  const result = new Map();
  for (const packageName of Object.keys(requirements).sort()) {
    assertNonEmptyName(packageName, location);
    const range = requirements[packageName];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      throw new ResolutionError(`${location}.${packageName} must be a valid semver range string.`);
    }
    result.set(packageName, range);
  }
  return result;
}

/**
 * Convert and validate the locked "package name -> version" map, applying
 * the same semver canonicalization as registry versions.
 */
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

/**
 * Convert and validate the request body into Maps that do not retain the
 * caller's object insertion order.
 */
function normalizeInput(input) {
  if (!isPlainObject(input)) {
    throw new ResolutionError('The request body must be a JSON object.');
  }

  return {
    catalog: normalizeRegistry(input.registry),
    rootRequirements: normalizeRequirements(input.root, 'root'),
  };
}

/**
 * Convert and validate an /update-plan request body.
 */
function normalizeUpdatePlanInput(input) {
  if (!isPlainObject(input)) {
    throw new ResolutionError('The request body must be a JSON object.');
  }

  return {
    catalog: normalizeRegistry(input.registry),
    rootRequirements: normalizeRequirements(input.root, 'root'),
    updateRequirements: normalizeRequirements(input.update, 'update'),
    locked: normalizeLocked(input.locked),
  };
}

function serializeSource(source) {
  if (source.type === 'root') return { type: 'root' };
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
  return source.type === 'root'
    ? 'root'
    : `${source.package}@${source.version}`;
}

function choosePrimaryConstraint(entries, chains) {
  let bestIndex = 0;

  for (let i = 1; i < entries.length; i += 1) {
    const best = chains[bestIndex];
    const current = chains[i];

    if (current.length > best.length) {
      bestIndex = i;
      continue;
    }

    if (current.length === best.length) {
      // Seeded root/update requirements have empty chains and no path nodes
      // to compare; fall back to the constraint itself so the choice stays
      // deterministic.
      const comparison = current.length === 0
        ? compareConstraints(entries[i], entries[bestIndex])
        : comparePathNodes(current[current.length - 1], best[best.length - 1]);

      if (comparison < 0) {
        bestIndex = i;
      }
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

function comparePackageNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildPlan(selected) {
  return [...selected.entries()]
    .sort((a, b) => comparePackageNames(a[0], b[0]))
    .map(([name, entry]) => ({
      package: name,
      version: entry.version,
    }));
}

function rootSeed(requirements) {
  return [...requirements.entries()]
    .sort((a, b) => comparePackageNames(a[0], b[0]))
    .map(([name, range]) => ({ name, range, source: { ...ROOT_SOURCE } }));
}

/**
 * Depth-first backtracking search shared by /resolve and /update-plan.
 * `visit(state)` is called for every complete assignment in deterministic
 * search order; any truthy return value stops the search and is propagated
 * to the caller. `prune(state)` may skip branches that cannot improve the
 * best solution found so far.
 */
function createSearch({ catalog, seed }) {
  const constraints = new Map();
  const reasons = new Map();

  // Seed requirements are inserted in sorted package-name order.
  for (const { name, range, source } of seed) {
    if (!constraints.has(name)) {
      constraints.set(name, []);
      reasons.set(name, []);
    }
    constraints.get(name).push({ range, source: { ...source } });
    reasons.get(name).push([]);
  }

  const initialState = { constraints, reasons, selected: new Map() };
  let firstConflict = null;

  function recordConflict(conflict) {
    if (firstConflict === null) firstConflict = conflict;
  }

  function dfs(state, visit, prune) {
    const unresolved = [...state.constraints.keys()]
      .filter((name) => !state.selected.has(name))
      .sort();

    if (unresolved.length === 0) {
      return visit(state);
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
      return null;
    }

    for (const candidate of candidates) {
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

      let selectedConflict = null;

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
          selectedConflict = buildConflict(
            dependencyName,
            {
              constraints: nextConstraints,
              reasons: nextReasons,
              selected: nextSelected,
            },
            'SELECTED_VERSION_DOES_NOT_SATISFY_CONSTRAINT',
            catalog
          );
          break;
        }
      }

      if (selectedConflict) {
        recordConflict(selectedConflict);
        continue;
      }

      const nextState = {
        constraints: nextConstraints,
        reasons: nextReasons,
        selected: nextSelected,
      };

      if (prune && prune(nextState)) {
        continue;
      }

      const result = dfs(nextState, visit, prune);
      if (result) return result;
    }

    return null;
  }

  return {
    initialState,
    dfs,
    getFirstConflict: () => firstConflict,
  };
}

function solve({ catalog, rootRequirements }) {
  const search = createSearch({ catalog, seed: rootSeed(rootRequirements) });
  const plan = search.dfs(search.initialState, (state) => buildPlan(state.selected), null);

  if (plan) {
    return {
      satisfiable: true,
      plan,
    };
  }

  return search.getFirstConflict();
}

/**
 * Number of already-selected packages that are new or version-changed
 * relative to the locked map. This only grows as the search selects more
 * packages, so it is a safe lower bound for pruning.
 */
function countSelectedChanges(selected, locked) {
  let changes = 0;
  for (const [name, entry] of selected) {
    if (locked.get(name) !== entry.version) {
      changes += 1;
    }
  }
  return changes;
}

/**
 * Total number of changed packages in a complete plan: additions, removals
 * and version changes each count once.
 */
function countTotalChanges(selected, locked) {
  let changes = countSelectedChanges(selected, locked);
  for (const name of locked.keys()) {
    if (!selected.has(name)) {
      changes += 1;
    }
  }
  return changes;
}

/**
 * Tie-break between two complete plans with equal change counts: walk
 * package names in lexicographic order and prefer the higher version at
 * the first differing name. A package present in only one plan is
 * preferred over its absence.
 */
function comparePlans(a, b) {
  const versionsA = new Map(a.map((entry) => [entry.package, entry.version]));
  const versionsB = new Map(b.map((entry) => [entry.package, entry.version]));
  const names = [...new Set([...versionsA.keys(), ...versionsB.keys()])].sort();

  for (const name of names) {
    const versionA = versionsA.get(name);
    const versionB = versionsB.get(name);
    if (versionA === undefined && versionB === undefined) continue;
    if (versionA === undefined) return -1;
    if (versionB === undefined) return 1;
    const comparison = semver.compare(versionA, versionB);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function buildSummary(plan, locked) {
  const kept = [];
  const changed = [];
  const plannedPackages = new Set();

  for (const { package: name, version } of plan) {
    plannedPackages.add(name);
    const lockedVersion = locked.has(name) ? locked.get(name) : null;
    if (lockedVersion === version) {
      kept.push({ package: name, version });
    } else {
      changed.push({ package: name, from: lockedVersion, to: version });
    }
  }

  for (const [name, version] of [...locked.entries()].sort((a, b) =>
    comparePackageNames(a[0], b[0])
  )) {
    if (!plannedPackages.has(name)) {
      changed.push({ package: name, from: version, to: null });
    }
  }

  changed.sort((a, b) => comparePackageNames(a.package, b.package));

  return { kept, changed };
}

function solveUpdatePlan({ catalog, rootRequirements, updateRequirements, locked }) {
  const seed = [
    ...rootSeed(rootRequirements),
    ...rootSeed(updateRequirements),
  ];
  const search = createSearch({ catalog, seed });

  let best = null;

  const visit = (state) => {
    const plan = buildPlan(state.selected);
    const changes = countTotalChanges(state.selected, locked);
    if (
      best === null ||
      changes < best.changes ||
      (changes === best.changes && comparePlans(plan, best.plan) > 0)
    ) {
      best = { changes, plan };
    }
    return null;
  };

  // A partial selection can never shed changes it has already accumulated,
  // so branches whose locked-diff count exceeds the best plan cannot win.
  const prune = (state) =>
    best !== null && countSelectedChanges(state.selected, locked) > best.changes;

  search.dfs(search.initialState, visit, prune);

  if (best === null) {
    return search.getFirstConflict();
  }

  return {
    satisfiable: true,
    plan: best.plan,
    summary: buildSummary(best.plan, locked),
  };
}

function resolve(input) {
  return solve(normalizeInput(input));
}

function planUpdate(input) {
  return solveUpdatePlan(normalizeUpdatePlanInput(input));
}

module.exports = {
  ResolutionError,
  normalizeInput,
  normalizeUpdatePlanInput,
  planUpdate,
  resolve,
  sourceLabel,
};
