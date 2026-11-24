// Descriptions and schemas for the package-advisory endpoints.
import { ECOSYSTEMS, MAX_BATCH } from "./advisories.js";
import example from "./deps-example.json";

export const DEPS_SERVICE_NAME = "Package Vulnerability Advisories";
export const DEPS_TAGS = ["security", "dependencies", "cve", "npm", "pypi"];

export const ADVISORIES_DESCRIPTION =
  "Known security advisories (CVE, GHSA, PYSEC, GO, RUSTSEC) affecting one exact package version in npm, PyPI, Go, crates.io or Maven. " +
  "Returns vulnerable true/false, CVSS, affected ranges, fixed versions and links. Data from OSV.dev, fetched live (cached up to 1 hour).";
export const BATCH_DESCRIPTION =
  `Same as GET /deps/advisories for up to ${MAX_BATCH} package versions in one call. Results are in request order.`;

const PACKAGE_PROPS = {
  ecosystem: { type: "string", enum: [...ECOSYSTEMS], description: "Package ecosystem (case-insensitive on input)" },
  name: { type: "string", minLength: 1, maxLength: 214, description: "Package name; Maven uses groupId:artifactId, Go uses the module path" },
  version: { type: "string", minLength: 1, maxLength: 128, description: "Exact version, e.g. 4.17.20" },
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
  "OpenSSF Malicious Packages (Apache-2.0). Each advisory carries its source license; summaries of records from other sources are omitted.";
