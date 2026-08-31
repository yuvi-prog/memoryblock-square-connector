// Monday.com -> Square catalog sync. Runs in DRY_RUN mode unless SYNC_MODE=live -
// in dry run it computes and logs exactly what it WOULD do to every company's Square
// catalog, but never actually calls a write endpoint. Flip SYNC_MODE=live when ready.
import { listCompanyNames, getCompany } from "./companies.js";
import { findItemByExactName, createItem } from "./catalogItems.js";
import { get, write } from "./square.js";
import { locationsById } from "./reports.js";

const MONDAY_API = "https://api.monday.com/v2";
const BOARD_ID = "5030789525";

// Column ids on the "Products" board (see get_board_info) - kept as one map so a
// board redesign only means editing this block.
const COLUMNS = {
  sku: "text_mm6f1482",
  productType: "color_mm6fj50m", // e.g. Pine, Bamboo, Acrylic, Beechwood
  shape: "color_mm6fgj9g", // e.g. Square, Rectangle, Hexagon, Heart
  size: "color_mm6fat5h", // e.g. XS, S, M, L, XL, G
  rrp: "numeric_mm6fx0r9",
  squareToggle: "boolean_mm6fa9h8",
};

export const SYNC_MODE = process.env.SYNC_MODE === "live" ? "live" : "dry_run";

async function mondayApi(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not configured - cannot fetch board data.");
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function fetchRow(itemId) {
  const query = `query ($itemId: [ID!]) {
    items(ids: $itemId) {
      id
      column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) { id text }
    }
  }`;
  const data = await mondayApi(query, { itemId: [itemId] });
  const item = data.items?.[0];
  if (!item) throw new Error(`Monday item ${itemId} not found`);
  const byId = Object.fromEntries(item.column_values.map((c) => [c.id, c.text]));
  return {
    sku: byId[COLUMNS.sku],
    productType: byId[COLUMNS.productType],
    shape: byId[COLUMNS.shape],
    size: byId[COLUMNS.size],
    rrp: byId[COLUMNS.rrp] ? Number(byId[COLUMNS.rrp]) : null,
    squareTicked: byId[COLUMNS.squareToggle] === "v",
  };
}

function deriveItemName(row) {
  if (!row.shape || !row.productType) return null;
  return `${row.shape} ${row.productType}`;
}

async function fetchAllRows() {
  const rows = [];
  let cursor = null;
  do {
    const query = cursor
      ? `query ($cursor: String!) {
          next_items_page(cursor: $cursor, limit: 100) {
            cursor
            items { id column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) { id text } }
          }
        }`
      : `query ($boardId: [ID!]) {
          boards(ids: $boardId) {
            items_page(limit: 100) {
              cursor
              items { id column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) { id text } }
            }
          }
        }`;
    const variables = cursor ? { cursor } : { boardId: [BOARD_ID] };
    const data = await mondayApi(query, variables);
    const page = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const item of page.items) {
      const byId = Object.fromEntries(item.column_values.map((c) => [c.id, c.text]));
      rows.push({
        itemId: item.id,
        sku: byId[COLUMNS.sku],
        productType: byId[COLUMNS.productType],
        shape: byId[COLUMNS.shape],
        size: byId[COLUMNS.size],
        rrp: byId[COLUMNS.rrp] ? Number(byId[COLUMNS.rrp]) : null,
        squareTicked: byId[COLUMNS.squareToggle] === "v",
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

// Fetches a company's whole catalog ONCE and indexes it, so a full-board reconcile
// doesn't re-fetch the catalog for every row (would be rows x companies calls otherwise).
async function fetchCatalogMap(token) {
  const map = {};
  let cursor;
  do {
    const page = await get(token, `/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ""}`);
    for (const item of page.objects || []) {
      if (item.type !== "ITEM") continue;
      map[item.item_data.name.toLowerCase()] = item;
    }
    cursor = page.cursor;
  } while (cursor);
  return map;
}

function findVariationIn(item, variationName) {
  return item?.item_data?.variations?.find(
    (v) => v.item_variation_data?.name?.toLowerCase() === variationName.toLowerCase()
  );
}

// Runs the same create/hide decision as syncRow but against a pre-fetched catalog
// map instead of hitting the network per row - used by RECONCILE_all_products.
export async function reconcileAll() {
  const rows = (await fetchAllRows()).filter((r) => {
    const itemName = deriveItemName(r);
    return itemName && r.size && r.sku;
  });

  const summary = { itemsProcessed: rows.length, wouldCreate: 0, wouldHide: 0, alreadyCorrect: 0, errors: 0, actions: [] };

  for (const name of listCompanyNames()) {
    const c = getCompany(name);
    let catalogMap;
    try {
      catalogMap = await fetchCatalogMap(c.accessToken);
    } catch (err) {
      summary.errors += 1;
      summary.actions.push({ company: name, error: `Could not read catalog: ${err.message}` });
      continue;
    }

    let activeLocationIds, currency;

    for (const row of rows) {
      const itemName = deriveItemName(row);
      const existingItem = catalogMap[itemName.toLowerCase()];
      const existingVariation = findVariationIn(existingItem, row.size);

      if (row.squareTicked) {
        if (existingVariation) {
          summary.alreadyCorrect += 1;
          continue;
        }
        summary.wouldCreate += 1;
        summary.actions.push({
          company: name,
          itemName,
          variationName: row.size,
          action: existingItem ? "add variation to existing item" : "create new item + variation",
        });
        if (SYNC_MODE === "live") {
          try {
            if (existingItem) {
              await addVariationToItem(c.accessToken, existingItem, { name: row.size, sku: row.sku, price: row.rrp });
            } else {
              if (!activeLocationIds) {
                const locsById = await locationsById(c.accessToken);
                activeLocationIds = Object.entries(locsById).filter(([, l]) => l.status === "ACTIVE").map(([id]) => id);
                currency = Object.values(locsById)[0]?.currency || "AUD";
              }
              const created = await createItem(c.accessToken, {
                itemName,
                variations: [{ name: row.size, sku: row.sku, price: row.rrp }],
                locationIds: activeLocationIds,
                currency,
              });
              // Keep the in-memory map current so a second row for the same new item
              // (e.g. another size) adds a variation instead of creating a duplicate item.
              catalogMap[itemName.toLowerCase()] = { id: created.catalogObjectId, item_data: { name: itemName, variations: [] } };
            }
          } catch (err) {
            summary.errors += 1;
            summary.actions.push({ company: name, itemName, variationName: row.size, error: err.message });
          }
        }
      } else {
        if (!existingVariation) {
          summary.alreadyCorrect += 1;
          continue;
        }
        summary.wouldHide += 1;
        summary.actions.push({ company: name, itemName, variationName: row.size, action: "hide variation (remove from all locations)" });
        if (SYNC_MODE === "live") {
          try {
            await hideVariation(c.accessToken, existingVariation);
          } catch (err) {
            summary.errors += 1;
            summary.actions.push({ company: name, itemName, variationName: row.size, error: err.message });
          }
        }
      }
    }
  }

  return { mode: SYNC_MODE, ...summary };
}

// The core sync decision for one row. Always safe to call - only WRITES if
// SYNC_MODE is "live"; otherwise returns the plan without touching Square.
export async function syncRow(itemId) {
  const row = await fetchRow(itemId);
  const itemName = deriveItemName(row);
  if (!itemName || !row.size || !row.sku) {
    return { itemId, skipped: true, reason: "Row is missing Shape, Product Type, Size, or SKU - can't map to a Square item." };
  }

  const plan = {
    itemId,
    action: row.squareTicked ? "create-if-missing" : "hide-if-present",
    itemName,
    variationName: row.size,
    sku: row.sku,
    price: row.rrp,
    perCompany: [],
  };

  for (const name of listCompanyNames()) {
    const c = getCompany(name);
    try {
      const existingItem = await findItemByExactName(c.accessToken, itemName);
      const existingVariation = existingItem?.item_data?.variations?.find(
        (v) => v.item_variation_data?.name?.toLowerCase() === row.size.toLowerCase()
      );

      if (row.squareTicked) {
        if (existingVariation) {
          plan.perCompany.push({ company: name, wouldDo: "nothing - variation already exists", catalogObjectId: existingVariation.id });
          continue;
        }
        plan.perCompany.push({
          company: name,
          wouldDo: existingItem ? "add variation to existing item" : "create new item + variation",
        });
        if (SYNC_MODE === "live") {
          // Only ever CREATEs (item or variation) - never overwrites an existing variation's price.
          if (existingItem) {
            await addVariationToItem(c.accessToken, existingItem, { name: row.size, sku: row.sku, price: row.rrp });
          } else {
            const locsById = await locationsById(c.accessToken);
            const activeIds = Object.entries(locsById).filter(([, l]) => l.status === "ACTIVE").map(([id]) => id);
            const currency = Object.values(locsById)[0]?.currency || "AUD";
            await createItem(c.accessToken, {
              itemName,
              variations: [{ name: row.size, sku: row.sku, price: row.rrp }],
              locationIds: activeIds,
              currency,
            });
          }
        }
      } else {
        if (!existingVariation) {
          plan.perCompany.push({ company: name, wouldDo: "nothing - variation doesn't exist here" });
          continue;
        }
        plan.perCompany.push({ company: name, wouldDo: "hide variation (remove from all locations)", catalogObjectId: existingVariation.id });
        if (SYNC_MODE === "live") {
          await hideVariation(c.accessToken, existingVariation);
        }
      }
    } catch (err) {
      plan.perCompany.push({ company: name, error: err.message });
    }
  }

  return plan;
}

async function addVariationToItem(token, existingItem, { name, sku, price }) {
  const currency = existingItem.item_data.variations[0]?.item_variation_data?.price_money?.currency || "AUD";
  const updated = {
    ...existingItem,
    item_data: {
      ...existingItem.item_data,
      variations: [
        ...existingItem.item_data.variations,
        {
          type: "ITEM_VARIATION",
          id: "#new_variation",
          item_variation_data: {
            item_id: existingItem.id,
            name,
            sku,
            pricing_type: "FIXED_PRICING",
            price_money: { amount: Math.round((price || 0) * 100), currency },
          },
        },
      ],
    },
  };
  return write(token, "/catalog/object", { idempotency_key: `add-variation-${existingItem.id}-${name}-${Date.now()}`, object: updated });
}

async function hideVariation(token, variation) {
  const updated = {
    ...variation,
    item_variation_data: {
      ...variation.item_variation_data,
      present_at_all_locations: false,
      present_at_location_ids: [],
    },
  };
  return write(token, "/catalog/object", { idempotency_key: `hide-${variation.id}-${Date.now()}`, object: updated });
}
