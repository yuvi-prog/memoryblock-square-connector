import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function load() {
  if (process.env.SQUARE_COMPANIES_JSON) {
    return JSON.parse(process.env.SQUARE_COMPANIES_JSON);
  }
  const path = join(__dirname, "..", "companies.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

const companies = load().filter((c) => c.accessToken);

export function listCompanyNames() {
  return companies.map((c) => c.name);
}

// Groups accessible companies into "australia" and "world" so a caller doesn't have
// to re-derive this from location country codes every time - kept as static config
// on each company since a merchant's home country essentially never changes.
export function listCompaniesByRegion() {
  const grouped = { australia: [], world: [] };
  for (const c of companies) {
    const region = c.region === "world" ? "world" : "australia";
    grouped[region].push(c.name);
  }
  return grouped;
}

export function getCompany(name) {
  const match = companies.find(
    (c) => c.name.toLowerCase() === String(name).toLowerCase()
  );
  if (!match) {
    const available = listCompanyNames().join(", ");
    throw new Error(
      `Unknown or inaccessible company "${name}". Available companies: ${available}`
    );
  }
  return match;
}
