// Descriptions and schemas for the SEC EDGAR endpoints.
import { DEFAULT_FILINGS_LIMIT, INSIDER_FILINGS, MAX_FILINGS_LIMIT, SEC_SOURCE_NOTE } from "./sec.js";
import recorded from "./sec-example.json";

export const SEC_SERVICE_NAME = "SEC EDGAR Insider Trades and Filings";
export const SEC_TAGS = ["sec", "edgar", "insider-trading", "form-4", "filings", "stocks"];

export const INSIDER_TRADES_DESCRIPTION =
  "Recent insider trading for a US public company: SEC Form 4 filings parsed into structured JSON. " +
  `Look up by stock ticker (e.g. AAPL) or SEC CIK; returns every transaction in the ${INSIDER_FILINGS} most recent Form 4 / 4/A filings: ` +
  "insider name and role (director, officer title, 10% owner), transaction date, transaction code (P purchase, S sale, A award, M exercise, F tax withholding...), " +
  "shares, price per share, shares owned after, direct/indirect, Rule 10b5-1 plan flag and the filing link. " +
  "A company with no recent Form 4 returns an empty transactions list (charged); an unknown ticker or CIK is a free 404. Data from SEC EDGAR, fetched live.";
export const LATEST_FILINGS_DESCRIPTION =
  "Latest SEC filings for a US public company by ticker or CIK: 8-K (with item numbers and titles, e.g. 2.02 earnings results), 10-K, 10-Q, Form 4, S-1 and others. " +
  `Optional form filter (e.g. form=8-K) and limit (1-${MAX_FILINGS_LIMIT}, default ${DEFAULT_FILINGS_LIMIT}). ` +
  "Returns form type, filing and report dates, acceptance time and document links. Data from SEC EDGAR, fetched live (cached up to 10 minutes).";

const COMPANY_PROPS = {
  ticker: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.\\-]{0,9}$", description: "US stock ticker, e.g. AAPL or BRK-B. Pass ticker or cik, not both.", examples: ["AAPL"] },
  cik: { type: "string", pattern: "^\\d{1,10}$", description: "SEC Central Index Key, with or without leading zeros, e.g. 320193", examples: ["320193"] },
};

export const INSIDER_TRADES_INPUT_SCHEMA = {
  type: "object",
  properties: COMPANY_PROPS,
  additionalProperties: false,
};

export const LATEST_FILINGS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ...COMPANY_PROPS,
    form: { type: "string", description: "Only this EDGAR form type, e.g. 8-K, 10-Q, 10-K, 4", examples: ["8-K"] },
    limit: { type: "string", pattern: "^\\d{1,3}$", description: `Number of filings, 1-${MAX_FILINGS_LIMIT} (default ${DEFAULT_FILINGS_LIMIT})`, examples: ["2"] },
  },
  additionalProperties: false,
};

const ISSUER_SCHEMA = {
  type: "object",
  properties: { cik: { type: "string", description: "10-digit CIK" }, name: { type: "string" }, tickers: { type: "array", items: { type: "string" } } },
  required: ["cik", "name", "tickers"],
};
const NUM = { type: ["number", "null"] };
const STR = { type: ["string", "null"] };

const TRANSACTION_SCHEMA = {
  type: "object",
  properties: {
    accession_number: { type: "string" },
    form: { type: "string", enum: ["4", "4/A"] },
    filing_date: { type: "string" },
    filing_url: { type: "string", description: "EDGAR filing index page" },
    reporting_owners: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          cik: { type: "string" },
          is_director: { type: "boolean" },
          is_officer: { type: "boolean" },
          officer_title: STR,
          is_ten_percent_owner: { type: "boolean" },
          is_other: { type: "boolean" },
        },
      },
    },
    rule_10b5_1: { type: ["boolean", "null"], description: "Filer checked the Rule 10b5-1 trading plan box (null on older forms without it)" },
    table: { type: "string", enum: ["non_derivative", "derivative"] },
    security: STR,
    transaction_date: STR,
    code: { ...STR, description: "Form 4 transaction code: P purchase, S sale, A award, M exercise, F tax withholding, G gift..." },
    code_description: STR,
    acquired_disposed: { type: ["string", "null"], enum: ["A", "D", null] },
    shares: NUM,
    price_per_share: { ...NUM, description: "null when the filing gives the price only in a footnote" },
    shares_owned_after: NUM,
    ownership: { type: ["string", "null"], enum: ["D", "I", null], description: "D direct, I indirect" },
    underlying_security: STR,
  },
  required: ["accession_number", "form", "filing_date", "filing_url", "reporting_owners", "table", "transaction_date", "code", "shares", "price_per_share"],
};

export const INSIDER_TRADES_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    issuer: ISSUER_SCHEMA,
    filings_checked: { type: "integer", minimum: 0, maximum: INSIDER_FILINGS },
    transaction_count: { type: "integer", minimum: 0 },
    transactions: { type: "array", items: TRANSACTION_SCHEMA, description: "Newest filing first, in filing order within a filing" },
    data_fetched_at: { type: "string", description: "When the filing list was fetched from SEC EDGAR (ISO 8601)" },
    queried_at: { type: "string" },
    source: { type: "string" },
  },
  required: ["issuer", "filings_checked", "transaction_count", "transactions", "data_fetched_at", "queried_at", "source"],
};

export const LATEST_FILINGS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    issuer: ISSUER_SCHEMA,
    form: STR,
    count: { type: "integer", minimum: 0, maximum: MAX_FILINGS_LIMIT },
    filings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accession_number: { type: "string" },
          form: { type: "string" },
          filing_date: { type: "string" },
          report_date: STR,
          accepted_at: STR,
          items: {
            type: "array",
            description: "8-K item numbers with titles, e.g. 2.02 Results of Operations and Financial Condition",
            items: { type: "object", properties: { item: { type: "string" }, title: STR } },
          },
          description: STR,
          document_url: { type: "string" },
          index_url: { type: "string" },
        },
      },
    },
    data_fetched_at: { type: "string" },
    queried_at: { type: "string" },
    source: { type: "string" },
  },
  required: ["issuer", "form", "count", "filings", "data_fetched_at", "queried_at", "source"],
};

export const INSIDER_TRADES_EXAMPLE_INPUT = { ticker: "AAPL" };
/** Real SEC EDGAR data for AAPL, trimmed to one transaction. */
export const INSIDER_TRADES_EXAMPLE_OUTPUT = { ...recorded.insider_trades, source: SEC_SOURCE_NOTE };
export const LATEST_FILINGS_EXAMPLE_INPUT = { ticker: "AAPL", form: "8-K", limit: "2" };
export const LATEST_FILINGS_EXAMPLE_OUTPUT = { ...recorded.latest_filings, source: SEC_SOURCE_NOTE };

export const SEC_ATTRIBUTION =
  "Data from SEC EDGAR (https://www.sec.gov/edgar), U.S. public filings, retrieved live under SEC's fair-access policy and reformatted. " +
  "This service is not affiliated with or endorsed by the U.S. Securities and Exchange Commission. Not investment advice.";
