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
  let currency = "AUD";
  const byLocation = {};

  for (const o of orders) {
    if (o.state && o.state !== "COMPLETED") continue; // skip open/cancelled orders
    const gross = o.total_money?.amount || 0;
    const net = (o.total_money?.amount || 0) - (o.total_discount_money?.amount || 0);
    currency = o.total_money?.currency || currency;
    grossCents += gross;
    netCents += net;

    const locId = o.location_id;
    if (!byLocation[locId]) {
      byLocation[locId] = {
        locationId: locId,
        locationName: locationsById[locId]?.name || locId,
        orderCount: 0,
        grossSales: 0,
      };
    }
    byLocation[locId].orderCount += 1;
    byLocation[locId].grossSales += money(gross);
  }

  return {
    orderCount: orders.filter((o) => !o.state || o.state === "COMPLETED").length,
    grossSales: money(grossCents),
    netSales: money(netCents),
    currency,
    averageOrderValue: orders.length ? money(grossCents / orders.length) : 0,
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
