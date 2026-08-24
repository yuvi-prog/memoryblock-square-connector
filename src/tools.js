import { z } from "zod";
import { getCompany, listCompanyNames } from "./companies.js";
import { get, searchRead } from "./square.js";
import {
  fetchOrders,
  fetchPayments,
  fetchCatalogCategoryMap,
  locationsById,
  summarizeOrders,
  topItems,
  salesTrend,
  salesByHour,
  salesByCategory,
  discountSummary,
  paymentMethodBreakdown,
  pctChange,
} from "./reports.js";
import { resolvePeriod, PERIOD_NAMES, STORE_TIMEZONE } from "./periods.js";

const companyField = z
  .string()
  .describe(`Company name. One of: ${listCompanyNames().join(", ")}`);

const periodField = z
  .enum(PERIOD_NAMES)
  .optional()
  .describe(
    `Named period resolved server-side (${STORE_TIMEZONE}) so the same period always means the exact same boundaries for everyone. Prefer this over startAt/endAt for anything phrased like "last month" or "this week" - it removes ambiguity that causes two people asking the same question to get different date ranges. Options: ${PERIOD_NAMES.join(", ")}.`
  );

// Resolves a canonical range: an explicit period name always wins over hand-supplied
// startAt/endAt, so calls stay reproducible regardless of how the caller phrased the question.
function resolveRange({ period, startAt, endAt }) {
  if (period) return resolvePeriod(period);
  if (!startAt || !endAt) {
    throw new Error(
      `Provide either "period" (one of: ${PERIOD_NAMES.join(", ")}) or both startAt and endAt.`
    );
  }
  return { startAt, endAt };
}

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
      // Square's orders/search accepts at most 10 location_ids per call
      return searchRead(c.accessToken, "/orders/search", {
        location_ids: location_ids.slice(0, 10),
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
  {
    name: "GET_sales_summary",
    description:
      "Sales report for a company over a date range: gross/net sales, order count, average order value, broken down by location. Great for data analysis and exec summaries.",
    inputSchema: {
      company: companyField,
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range, e.g. 2026-07-01T00:00:00Z. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range, e.g. 2026-08-01T00:00:00Z. Ignored if period is set."),
      locationIds: z.array(z.string()).optional().describe("Omit for all locations"),
    },
    handler: async ({ company, period, startAt, endAt, locationIds }) => {
      const range = resolveRange({ period, startAt, endAt });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const orders = await fetchOrders(c.accessToken, { locationIds: location_ids, ...range });
      return { company: c.name, ...range, ...summarizeOrders(orders, locsById) };
    },
  },
  {
    name: "GET_sales_summary_all_companies",
    description:
      "Cross-company sales report for a date range: gross sales, order count, and per-company breakdown across every accessible Memory Block company. Slower - queries every company's Square account.",
    inputSchema: {
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
    },
    handler: async ({ period, startAt: startAtArg, endAt: endAtArg }) => {
      const { startAt, endAt } = resolveRange({ period, startAt: startAtArg, endAt: endAtArg });
      const results = [];
      for (const name of listCompanyNames()) {
        try {
          const c = getCompany(name);
          const locsById = await locationsById(c.accessToken);
          const orders = await fetchOrders(c.accessToken, {
            locationIds: Object.keys(locsById),
            startAt,
            endAt,
            cap: 500,
          });
          const summary = summarizeOrders(orders, locsById);
          results.push({ company: name, ...summary });
        } catch (err) {
          results.push({ company: name, error: err.message });
        }
      }
      // Companies use different currencies (e.g. MB CL Ireland is EUR, the rest are AUD) -
      // never sum raw amounts across currencies. Totals are grouped by currency instead.
      const totalsByCurrency = {};
      for (const r of results) {
        if (!r.currency) continue;
        if (!totalsByCurrency[r.currency]) {
          totalsByCurrency[r.currency] = { currency: r.currency, totalGrossSales: 0, totalOrderCount: 0 };
        }
        totalsByCurrency[r.currency].totalGrossSales += r.grossSales || 0;
        totalsByCurrency[r.currency].totalOrderCount += r.orderCount || 0;
      }
      for (const t of Object.values(totalsByCurrency)) {
        t.totalGrossSales = Math.round(t.totalGrossSales * 100) / 100;
      }
      return {
        startAt,
        endAt,
        note: "Totals are grouped by currency - do not add totals across different currencies together.",
        totalsByCurrency: Object.values(totalsByCurrency).sort((a, b) => b.totalGrossSales - a.totalGrossSales),
        byCompany: results.sort((a, b) => (b.grossSales || 0) - (a.grossSales || 0)),
      };
    },
  },
  {
    name: "GET_top_items",
    description: "Best-selling catalog items for a company over a date range, ranked by revenue.",
    inputSchema: {
      company: companyField,
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
      limit: z.number().int().min(1).max(100).optional(),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, period, startAt, endAt, limit, locationIds }) => {
      const range = resolveRange({ period, startAt, endAt });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const orders = await fetchOrders(c.accessToken, { locationIds: location_ids, ...range });
      return { company: c.name, ...range, topItems: topItems(orders, limit) };
    },
  },
  {
    name: "GET_sales_trend",
    description:
      "Sales trend over time for a company, bucketed by day/week/month - orders and gross sales per bucket. Use for charting growth or seasonality.",
    inputSchema: {
      company: companyField,
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
      granularity: z.enum(["day", "week", "month"]).optional().describe("Default: day"),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, period, startAt, endAt, granularity, locationIds }) => {
      const range = resolveRange({ period, startAt, endAt });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const orders = await fetchOrders(c.accessToken, { locationIds: location_ids, ...range });
      return { company: c.name, ...range, granularity: granularity || "day", trend: salesTrend(orders, granularity) };
    },
  },
  {
    name: "GET_sales_by_hour",
    description:
      "Sales broken down by hour-of-day (UTC) and day-of-week for a company over a date range - useful for staffing/rostering decisions.",
    inputSchema: {
      company: companyField,
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, period, startAt, endAt, locationIds }) => {
      const range = resolveRange({ period, startAt, endAt });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const orders = await fetchOrders(c.accessToken, { locationIds: location_ids, ...range });
      return { company: c.name, ...range, ...salesByHour(orders) };
    },
  },
  {
    name: "GET_sales_by_category",
    description: "Revenue and quantity sold broken down by catalog category for a company over a date range.",
    inputSchema: {
      company: companyField,
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, period, startAt, endAt, locationIds }) => {
      const range = resolveRange({ period, startAt, endAt });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const [orders, catalogMap] = await Promise.all([
        fetchOrders(c.accessToken, { locationIds: location_ids, ...range }),
        fetchCatalogCategoryMap(c.accessToken),
      ]);
      return { company: c.name, ...range, byCategory: salesByCategory(orders, catalogMap) };
    },
  },
  {
    name: "GET_discount_summary",
    description: "Total discounts given for a company over a date range, broken down by discount name.",
    inputSchema: {
      company: companyField,
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, period, startAt, endAt, locationIds }) => {
      const range = resolveRange({ period, startAt, endAt });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const orders = await fetchOrders(c.accessToken, { locationIds: location_ids, ...range });
      return { company: c.name, ...range, ...discountSummary(orders) };
    },
  },
  {
    name: "GET_payment_method_breakdown",
    description: "Payments broken down by tender/source type (card, cash, external, wallet, etc.) for a company over a date range.",
    inputSchema: {
      company: companyField,
      period: periodField,
      beginTime: z.string().optional().describe("RFC3339 start. Ignored if period is set."),
      endTime: z.string().optional().describe("RFC3339 end. Ignored if period is set."),
    },
    handler: async ({ company, period, beginTime, endTime }) => {
      const range = resolveRange({ period, startAt: beginTime, endAt: endTime });
      const c = getCompany(company);
      const payments = await fetchPayments(c.accessToken, { beginTime: range.startAt, endTime: range.endAt });
      return { company: c.name, beginTime: range.startAt, endTime: range.endAt, breakdown: paymentMethodBreakdown(payments) };
    },
  },
  {
    name: "GET_period_comparison",
    description:
      "Compare a company's sales between two date ranges (e.g. this month vs last month, or vs same period last year) - gross sales, order count, average order value, and % change. Prefer periodA/periodB named periods over explicit dates so 'this month vs last month' always resolves identically.",
    inputSchema: {
      company: companyField,
      periodA: periodField.describe("Named period for the baseline/earlier range, e.g. last_month"),
      periodB: periodField.describe("Named period for the comparison/later range, e.g. this_month"),
      periodAStart: z.string().optional().describe("RFC3339 start of the baseline period. Ignored if periodA is set."),
      periodAEnd: z.string().optional().describe("RFC3339 end of the baseline period. Ignored if periodA is set."),
      periodBStart: z.string().optional().describe("RFC3339 start of the comparison period. Ignored if periodB is set."),
      periodBEnd: z.string().optional().describe("RFC3339 end of the comparison period. Ignored if periodB is set."),
      locationIds: z.array(z.string()).optional(),
    },
    handler: async ({ company, periodA, periodB, periodAStart, periodAEnd, periodBStart, periodBEnd, locationIds }) => {
      const rangeA = resolveRange({ period: periodA, startAt: periodAStart, endAt: periodAEnd });
      const rangeB = resolveRange({ period: periodB, startAt: periodBStart, endAt: periodBEnd });
      const c = getCompany(company);
      const locsById = await locationsById(c.accessToken);
      const location_ids = locationIds || Object.keys(locsById);
      const [ordersA, ordersB] = await Promise.all([
        fetchOrders(c.accessToken, { locationIds: location_ids, ...rangeA }),
        fetchOrders(c.accessToken, { locationIds: location_ids, ...rangeB }),
      ]);
      const summaryA = summarizeOrders(ordersA, locsById);
      const summaryB = summarizeOrders(ordersB, locsById);
      return {
        company: c.name,
        periodA: { ...rangeA, ...summaryA },
        periodB: { ...rangeB, ...summaryB },
        change: {
          grossSalesPct: pctChange(summaryA.grossSales, summaryB.grossSales),
          orderCountPct: pctChange(summaryA.orderCount, summaryB.orderCount),
          averageOrderValuePct: pctChange(summaryA.averageOrderValue, summaryB.averageOrderValue),
        },
      };
    },
  },
  {
    name: "GET_location_leaderboard",
    description:
      "Ranks every store location across ALL accessible Memory Block companies by gross sales for a date range. Slower - queries every company's Square account.",
    inputSchema: {
      period: periodField,
      startAt: z.string().optional().describe("RFC3339 start of created_at range. Ignored if period is set."),
      endAt: z.string().optional().describe("RFC3339 end of created_at range. Ignored if period is set."),
    },
    handler: async ({ period, startAt: startAtArg, endAt: endAtArg }) => {
      const { startAt, endAt } = resolveRange({ period, startAt: startAtArg, endAt: endAtArg });
      const leaderboard = [];
      for (const name of listCompanyNames()) {
        try {
          const c = getCompany(name);
          const locsById = await locationsById(c.accessToken);
          const orders = await fetchOrders(c.accessToken, {
            locationIds: Object.keys(locsById),
            startAt,
            endAt,
            cap: 500,
          });
          const { byLocation } = summarizeOrders(orders, locsById);
          for (const loc of byLocation) leaderboard.push({ company: name, ...loc });
        } catch {
          // Skip companies whose Square account can't be reached for this window
        }
      }
      // Locations use different currencies (MB CL Ireland is EUR, the rest are AUD) -
      // rank within each currency separately rather than mixing EUR and AUD gross sales.
      const byCurrency = {};
      for (const loc of leaderboard) {
        if (!byCurrency[loc.currency]) byCurrency[loc.currency] = [];
        byCurrency[loc.currency].push(loc);
      }
      for (const list of Object.values(byCurrency)) list.sort((a, b) => b.grossSales - a.grossSales);
      return {
        startAt,
        endAt,
        note: "Leaderboards are grouped by currency - a EUR location's revenue is not directly comparable to an AUD location's without a conversion.",
        byCurrency,
      };
    },
  },
];
