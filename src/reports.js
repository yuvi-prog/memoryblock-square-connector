import { get, searchRead } from "./square.js";

const MAX_ORDERS = 1000; // safety cap per query so one call can't run away

export async function fetchLocations(token) {
  const res = await get(token, "/locations");
  return res.locations || [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function fetchOrders(token, { locationIds, startAt, endAt, cap = MAX_ORDERS }) {
  const orders = [];
  // Square's orders/search accepts at most 10 location_ids per call
  for (const batch of chunk(locationIds, 10)) {
    let cursor;
    do {
      const page = await searchRead(token, "/orders/search", {
        location_ids: batch,
        cursor,
        limit: 200,
        query:
          startAt || endAt
            ? { filter: { date_time_filter: { created_at: { start_at: startAt, end_at: endAt } } } }
            : undefined,
      });
      orders.push(...(page.orders || []));
      cursor = page.cursor;
    } while (cursor && orders.length < cap);
    if (orders.length >= cap) break;
  }
  return orders.slice(0, cap);
}

function money(amountCents) {
  return Math.round((amountCents || 0)) / 100;
}

export function summarizeOrders(orders, locationsById = {}) {
  let grossCents = 0;
  let netCents = 0;
  let orderCount = 0;
  const currencies = new Set();
  const byLocation = {};

  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue; // skip open/cancelled orders
    const gross = o.total_money?.amount || 0;
    const net = (o.total_money?.amount || 0) - (o.total_discount_money?.amount || 0);
    // Fall back to the location's own configured currency (Square location object)
    // rather than guessing AUD - MB CL Ireland's locations are EUR, for instance.
    const currency = o.total_money?.currency || locationsById[o.location_id]?.currency || "UNKNOWN";
    currencies.add(currency);
    grossCents += gross;
    netCents += net;
    orderCount += 1;

    const locId = o.location_id;
    if (!byLocation[locId]) {
      byLocation[locId] = {
        locationId: locId,
        locationName: locationsById[locId]?.name || locId,
        currency,
        orderCount: 0,
        grossSales: 0,
      };
    }
    byLocation[locId].orderCount += 1;
    byLocation[locId].grossSales += money(gross);
  }

  const currency = currencies.size === 1 ? [...currencies][0] : [...currencies].join("+");

  return {
    orderCount,
    grossSales: money(grossCents),
    netSales: money(netCents),
    currency,
    ...(currencies.size > 1 && {
      warning: `Orders in this result use mixed currencies (${[...currencies].join(", ")}) - grossSales/netSales above are a meaningless sum across currencies. Check byLocation for per-location currency instead.`,
    }),
    averageOrderValue: orderCount ? money(grossCents / orderCount) : 0,
    byLocation: Object.values(byLocation).sort((a, b) => b.grossSales - a.grossSales),
  };
}

export function topItems(orders, limit = 20) {
  const items = {};
  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue;
    for (const li of o.line_items || []) {
      const key = li.name || "Unknown item";
      if (!items[key]) items[key] = { name: key, quantitySold: 0, revenue: 0 };
      items[key].quantitySold += Number(li.quantity || 0);
      items[key].revenue += money(li.total_money?.amount || 0);
    }
  }
  return Object.values(items)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export async function locationsById(token) {
  const locs = await fetchLocations(token);
  return Object.fromEntries(locs.map((l) => [l.id, l]));
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function salesTrend(orders, granularity = "day") {
  const buckets = {};
  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue;
    const d = new Date(o.created_at);
    let key;
    if (granularity === "month") {
      key = d.toISOString().slice(0, 7);
    } else if (granularity === "week") {
      const dow = d.getUTCDay() || 7;
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - dow + 1);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = d.toISOString().slice(0, 10);
    }
    if (!buckets[key]) buckets[key] = { period: key, orderCount: 0, grossSales: 0 };
    buckets[key].orderCount += 1;
    buckets[key].grossSales += money(o.total_money?.amount || 0);
  }
  return Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period));
}

export function salesByHour(orders) {
  const byHour = {};
  const byDayOfWeek = {};
  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue;
    const d = new Date(o.created_at);
    const hour = d.getUTCHours();
    const dow = DAY_NAMES[d.getUTCDay()];
    const gross = money(o.total_money?.amount || 0);

    if (!byHour[hour]) byHour[hour] = { hourUtc: hour, orderCount: 0, grossSales: 0 };
    byHour[hour].orderCount += 1;
    byHour[hour].grossSales += gross;

    if (!byDayOfWeek[dow]) byDayOfWeek[dow] = { dayOfWeek: dow, orderCount: 0, grossSales: 0 };
    byDayOfWeek[dow].orderCount += 1;
    byDayOfWeek[dow].grossSales += gross;
  }
  return {
    note: "hourUtc is in UTC, not store-local time - shift it by each location's timezone offset if needed.",
    byHour: Object.values(byHour).sort((a, b) => a.hourUtc - b.hourUtc),
    byDayOfWeek: Object.values(byDayOfWeek).sort(
      (a, b) => DAY_NAMES.indexOf(a.dayOfWeek) - DAY_NAMES.indexOf(b.dayOfWeek)
    ),
  };
}

export async function fetchCatalogCategoryMap(token) {
  const categories = {};
  const variationToCategory = {};
  let cursor;
  do {
    const page = await get(
      token,
      `/catalog/list?types=ITEM,CATEGORY${cursor ? `&cursor=${cursor}` : ""}`
    );
    for (const obj of page.objects || []) {
      if (obj.type === "CATEGORY") {
        categories[obj.id] = obj.category_data?.name || "Unnamed category";
      }
      if (obj.type === "ITEM") {
        // Square has deprecated the singular category_id in favor of a categories array;
        // fall back to category_id for older catalogs that never migrated.
        const categoryId = obj.item_data?.categories?.[0]?.id || obj.item_data?.category_id;
        for (const v of obj.item_data?.variations || []) {
          variationToCategory[v.id] = categoryId;
        }
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return { categories, variationToCategory };
}

export function salesByCategory(orders, catalogMap) {
  const byCategory = {};
  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue;
    for (const li of o.line_items || []) {
      const categoryId = catalogMap.variationToCategory[li.catalog_object_id];
      const name = catalogMap.categories[categoryId] || "Uncategorized";
      if (!byCategory[name]) byCategory[name] = { category: name, quantitySold: 0, revenue: 0 };
      byCategory[name].quantitySold += Number(li.quantity || 0);
      byCategory[name].revenue += money(li.total_money?.amount || 0);
    }
  }
  return Object.values(byCategory).sort((a, b) => b.revenue - a.revenue);
}

export function discountSummary(orders) {
  const byName = {};
  let totalDiscounted = 0;
  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue;
    const discountsByUid = Object.fromEntries(
      (o.discounts || []).map((d) => [d.uid, d.name || d.type || "Discount"])
    );
    for (const li of o.line_items || []) {
      for (const ad of li.applied_discounts || []) {
        const name = discountsByUid[ad.discount_uid] || "Discount";
        const amt = money(ad.applied_money?.amount || 0);
        byName[name] = (byName[name] || 0) + amt;
        totalDiscounted += amt;
      }
    }
  }
  return {
    totalDiscounted: Math.round(totalDiscounted * 100) / 100,
    byDiscount: Object.entries(byName)
      .map(([name, total]) => ({ name, totalDiscounted: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.totalDiscounted - a.totalDiscounted),
  };
}

export async function fetchPayments(token, { beginTime, endTime, cap = MAX_ORDERS }) {
  const payments = [];
  let cursor;
  do {
    const qs = new URLSearchParams(
      Object.entries({ begin_time: beginTime, end_time: endTime, cursor, limit: 100 }).filter(
        ([, v]) => v !== undefined && v !== null
      )
    );
    const page = await get(token, `/payments?${qs.toString()}`);
    payments.push(...(page.payments || []));
    cursor = page.cursor;
  } while (cursor && payments.length < cap);
  return payments.slice(0, cap);
}

export function paymentMethodBreakdown(payments) {
  const byMethod = {};
  for (const p of payments) {
    if (p.status && p.status !== "COMPLETED") continue;
    const method = p.source_type || "OTHER";
    if (!byMethod[method]) byMethod[method] = { method, count: 0, total: 0 };
    byMethod[method].count += 1;
    byMethod[method].total += money(p.total_money?.amount || 0);
  }
  return Object.values(byMethod).sort((a, b) => b.total - a.total);
}

export function pctChange(before, after) {
  if (!before) return after ? 100 : 0;
  return Math.round(((after - before) / before) * 10000) / 100;
}
