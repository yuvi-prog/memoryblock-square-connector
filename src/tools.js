import { z } from "zod";
import { getCompany, listCompanyNames } from "./companies.js";
import { get, searchRead } from "./square.js";

const companyField = z
  .string()
  .describe(`Company name. One of: ${listCompanyNames().join(", ")}`);

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

export const tools = [
  {
    name: "GET_companies",
    description: "List Memory Block companies this connector has Square access to.",
    inputSchema: {},
    handler: async () => ({ companies: listCompanyNames() }),
  },
  {
    name: "GET_locations",
    description: "List Square store locations for a company.",
    inputSchema: { company: companyField },
    handler: async ({ company }) => {
      const c = getCompany(company);
      return get(c.accessToken, "/locations");
    },
  },
  {
    name: "GET_orders",
    description: "Search orders for a company's locations within a date range (RFC3339 timestamps).",
    inputSchema: {
      company: companyField,
      locationIds: z.array(z.string()).optional().describe("Square location IDs; omit for all locations"),
      startAt: z.string().optional().describe("RFC3339 start of created_at range"),
      endAt: z.string().optional().describe("RFC3339 end of created_at range"),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: async ({ company, locationIds, startAt, endAt, limit }) => {
      const c = getCompany(company);
      let location_ids = locationIds;
      if (!location_ids) {
        const locs = await get(c.accessToken, "/locations");
        location_ids = (locs.locations || []).map((l) => l.id);
      }
      return searchRead(c.accessToken, "/orders/search", {
        location_ids,
        limit,
        query: startAt || endAt
          ? { filter: { date_time_filter: { created_at: { start_at: startAt, end_at: endAt } } } }
          : undefined,
      });
    },
  },
  {
    name: "GET_payments",
    description: "List payments for a company within an optional time range.",
    inputSchema: {
      company: companyField,
      beginTime: z.string().optional().describe("RFC3339 start"),
      endTime: z.string().optional().describe("RFC3339 end"),
      locationId: z.string().optional(),
      cursor: z.string().optional(),
    },
    handler: async ({ company, beginTime, endTime, locationId, cursor }) => {
      const c = getCompany(company);
      return get(
        c.accessToken,
        `/payments${qs({ begin_time: beginTime, end_time: endTime, location_id: locationId, cursor })}`
      );
    },
  },
  {
    name: "GET_refunds",
    description: "List payment refunds for a company within an optional time range.",
    inputSchema: {
      company: companyField,
      beginTime: z.string().optional(),
      endTime: z.string().optional(),
      locationId: z.string().optional(),
      cursor: z.string().optional(),
    },
    handler: async ({ company, beginTime, endTime, locationId, cursor }) => {
      const c = getCompany(company);
      return get(
        c.accessToken,
        `/refunds${qs({ begin_time: beginTime, end_time: endTime, location_id: locationId, cursor })}`
      );
    },
  },
  {
    name: "GET_disputes",
    description: "List payment disputes for a company.",
    inputSchema: { company: companyField, cursor: z.string().optional() },
    handler: async ({ company, cursor }) => {
      const c = getCompany(company);
      return get(c.accessToken, `/disputes${qs({ cursor })}`);
    },
  },
  {
    name: "GET_customers",
    description: "List customers for a company.",
    inputSchema: { company: companyField, cursor: z.string().optional() },
    handler: async ({ company, cursor }) => {
      const c = getCompany(company);
      return get(c.accessToken, `/customers${qs({ cursor })}`);
    },
  },
  {
    name: "GET_catalog_items",
    description: "List catalog objects (items, categories, taxes, modifiers etc.) for a company.",
    inputSchema: {
      company: companyField,
      types: z.string().optional().describe("Comma-separated catalog object types, e.g. ITEM,CATEGORY"),
      cursor: z.string().optional(),
    },
    handler: async ({ company, types, cursor }) => {
      const c = getCompany(company);
      return get(c.accessToken, `/catalog/list${qs({ types, cursor })}`);
    },
  },
  {
    name: "GET_inventory_counts",
    description: "Get current inventory counts for a specific catalog item variation.",
    inputSchema: {
      company: companyField,
      catalogObjectId: z.string().describe("Catalog object ID of the item variation"),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, catalogObjectId, locationIds }) => {
      const c = getCompany(company);
      return get(
        c.accessToken,
        `/inventory/${encodeURIComponent(catalogObjectId)}${qs({ location_ids: locationIds?.join(",") })}`
      );
    },
  },
  {
    name: "GET_invoices",
    description: "List invoices for a company location.",
    inputSchema: { company: companyField, locationId: z.string(), cursor: z.string().optional() },
    handler: async ({ company, locationId, cursor }) => {
      const c = getCompany(company);
      return get(c.accessToken, `/invoices${qs({ location_id: locationId, cursor })}`);
    },
  },
  {
    name: "GET_team_members",
    description: "List team members (staff) for a company.",
    inputSchema: { company: companyField, locationIds: z.array(z.string()).optional() },
    handler: async ({ company, locationIds }) => {
      const c = getCompany(company);
      return searchRead(c.accessToken, "/team-members/search", {
        query: locationIds ? { filter: { location_ids: locationIds } } : undefined,
      });
    },
  },
  {
    name: "GET_loyalty_accounts",
    description: "Search loyalty accounts for a company.",
    inputSchema: { company: companyField, cursor: z.string().optional() },
    handler: async ({ company, cursor }) => {
      const c = getCompany(company);
      return searchRead(c.accessToken, "/loyalty/accounts/search", { cursor });
    },
  },
  {
    name: "GET_gift_cards",
    description: "List gift cards for a company.",
    inputSchema: { company: companyField, cursor: z.string().optional() },
    handler: async ({ company, cursor }) => {
      const c = getCompany(company);
      return get(c.accessToken, `/gift-cards${qs({ cursor })}`);
    },
  },
  {
    name: "GET_bookings",
    description: "List appointment bookings for a company location.",
    inputSchema: { company: companyField, locationId: z.string().optional(), cursor: z.string().optional() },
    handler: async ({ company, locationId, cursor }) => {
      const c = getCompany(company);
      return get(c.accessToken, `/bookings${qs({ location_id: locationId, cursor })}`);
    },
  },
  {
    name: "GET_subscriptions",
    description: "Search recurring subscriptions for a company's locations.",
    inputSchema: { company: companyField, locationIds: z.array(z.string()).optional() },
    handler: async ({ company, locationIds }) => {
      const c = getCompany(company);
      let location_ids = locationIds;
      if (!location_ids) {
        const locs = await get(c.accessToken, "/locations");
        location_ids = (locs.locations || []).map((l) => l.id);
      }
      return searchRead(c.accessToken, "/subscriptions/search", { query: { filter: { location_ids } } });
    },
  },
];
