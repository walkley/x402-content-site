// Descriptions and schemas for the package-advisory endpoints.
import { ECOSYSTEMS, MAX_BATCH, OSV_SOURCE_NOTE } from "./advisories.js";
import recorded from "./deps-example.json";

const example = { ...recorded, source: OSV_SOURCE_NOTE };

export const DEPS_SERVICE_NAME = "Package Vulnerability Advisories";
// x402 allows at most 5 tags of up to 32 printable ASCII chars; these are the phrases buyers search directories with.
export const DEPS_TAGS = ["install safety", "dependency check", "package vulnerability", "cve", "osv"];

export const ADVISORIES_DESCRIPTION =
  "Is this package version safe to install? Dependency check for install safety before npm install, pip install or cargo add, for one exact npm, PyPI, Go, crates.io or Maven version. " +
  "Returns vulnerable true/false and the OSV.dev advisories for that version (CVE, GHSA, PYSEC, GO and RUSTSEC vulnerabilities and OpenSSF malicious-package MAL- entries) " +
  "with CVSS, affected ranges, fixed versions and links. " +
  "Package names are case-sensitive. Data fetched live from OSV.dev (cached up to 1 hour).";
// shortcut: the per-package price is written out for search snippets; test/app.test.ts checks it against BATCH_PRICE / MAX_BATCH.
export const BATCH_DESCRIPTION =
  `Are these package versions safe to install? Batch dependency check of up to ${MAX_BATCH} npm, PyPI, Go, crates.io or Maven package versions in one call, ` +
  `e.g. a whole lockfile before install or upgrade. $0.02 per call, $0.0004 per package. ` +
  `Same fields as GET /deps/advisories for each package (CVE and OSV vulnerabilities, malicious-package MAL- entries), in request order.`;

const PACKAGE_PROPS = {
  ecosystem: { type: "string", enum: [...ECOSYSTEMS], description: "Package ecosystem (case-insensitive on input)", examples: ["npm"] },
  name: {
    type: "string",
    minLength: 1,
    maxLength: 214,
    description:
      "Package name exactly as published; matching is case-sensitive for npm (lodash, not Lodash; legacy names such as JSONStream keep their case). Maven uses groupId:artifactId, Go the module path. PyPI names are normalised.",
    examples: ["lodash"],
  },
  version: { type: "string", minLength: 1, maxLength: 128, description: "Exact version, e.g. 4.17.20", examples: ["4.17.20"] },
};

export const ADVISORIES_INPUT_SCHEMA = {
  type: "object",
  properties: PACKAGE_PROPS,
  required: ["ecosystem", "name", "version"],
  additionalProperties: false,
};

const ADVISORY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    aliases: { type: "array", items: { type: "string" }, description: "Usually CVE ids" },
    summary: { type: ["string", "null"] },
    severity: {
      type: "object",
      properties: {
        level: { type: ["string", "null"], description: "Source rating such as LOW, MODERATE, HIGH, CRITICAL" },
        cvss: { type: "array", items: { type: "object", properties: { type: { type: "string" }, vector: { type: "string" } } } },
      },
    },
    affected: {
      type: "array",
      items: {
        type: "object",
        properties: {
          package: { type: "string" },
          ranges: {
            type: "array",
            items: {
              type: "object",
              properties: { type: { type: "string" }, introduced: { type: "string" }, fixed: { type: "string" }, last_affected: { type: "string" } },
            },
          },
        },
      },
    },
    fixed_versions: { type: "array", items: { type: "string" } },
    published: { type: ["string", "null"] },
    modified: { type: ["string", "null"] },
    references: { type: "array", items: { type: "string" } },
    url: { type: "string", description: "osv.dev record page" },
    source_database: { type: "string" },
    license: { type: "string", description: "License of the source record, e.g. CC-BY-4.0" },
  },
  required: ["id", "aliases", "summary", "severity", "affected", "fixed_versions", "url", "license"],
};

export const ADVISORIES_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ecosystem: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    vulnerable: { type: "boolean", description: "true when at least one advisory affects this exact version" },
    advisory_count: { type: "integer", minimum: 0 },
    advisories: { type: "array", items: ADVISORY_SCHEMA },
    truncated: { type: "boolean", description: "true if the upstream result had more pages than were fetched" },
    data_fetched_at: { type: "string", description: "When the data was fetched from OSV.dev (ISO 8601)" },
    queried_at: { type: "string", description: "When this request was answered (ISO 8601)" },
    source: { type: "string" },
  },
  required: ["ecosystem", "name", "version", "vulnerable", "advisory_count", "advisories", "truncated", "data_fetched_at", "queried_at", "source"],
};

export const BATCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    packages: { type: "array", minItems: 1, maxItems: MAX_BATCH, items: ADVISORIES_INPUT_SCHEMA },
  },
  required: ["packages"],
  additionalProperties: false,
};

export const BATCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "integer" },
    vulnerable_count: { type: "integer" },
    results: { type: "array", items: ADVISORIES_OUTPUT_SCHEMA },
  },
  required: ["count", "vulnerable_count", "results"],
};

export const ADVISORIES_EXAMPLE_INPUT = { ecosystem: "npm", name: "lodash", version: "4.17.20" };
/** Real OSV.dev data for lodash 4.17.20, trimmed to one advisory and three references. */
export const ADVISORIES_EXAMPLE_OUTPUT = example;
export const BATCH_EXAMPLE_INPUT = { packages: [ADVISORIES_EXAMPLE_INPUT] };
export const BATCH_EXAMPLE_OUTPUT = { count: 1, vulnerable_count: 1, results: [example] };

export const OSV_ATTRIBUTION =
  "Advisory data from OSV.dev (https://osv.dev, Apache-2.0), which aggregates source databases under their own licenses: " +
  "GitHub Advisory Database, PyPI Advisory Database, Go Vulnerability Database (CC-BY 4.0), Rust Advisory Database (CC0 1.0), " +
  "OpenSSF Malicious Packages (Apache-2.0). Records are excerpted and modified (details omitted, ranges restructured). Each advisory carries its source license; summaries of records from other sources are omitted.";
