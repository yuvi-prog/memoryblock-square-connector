// Catalog item creation. Deliberately narrow: this can only CREATE a brand-new ITEM
// with its variations - it never edits or deletes an existing item, and price editing
// stays in pricing.js. Kept as its own file so the two write surfaces don't blur together.
import { get, write } from "./square.js";

export async function findItemByExactName(token, name) {
  let cursor;
  do {
    const page = await get(token, `/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ""}`);
    const match = (page.objects || []).find(
      (o) => o.type === "ITEM" && o.item_data?.name?.toLowerCase() === name.toLowerCase()
    );
    if (match) return match;
    cursor = page.cursor;
  } while (cursor);
  return null;
}

// Read-only: resolves what a CREATE_catalog_item call would actually do, without
// writing anything - includes checking for a name collision with an existing item.
export async function previewCreateItem(token, { itemName, variations, locationIds, locationsById }) {
  const existing = await findItemByExactName(token, itemName);
  return {
    itemName,
    variations: variations.map((v) => ({ name: v.name, price: v.price, sku: v.sku })),
    locations: locationIds.map((id) => ({ locationId: id, locationName: locationsById[id]?.name || id })),
    existingItemWarning: existing
      ? `An item named "${itemName}" already exists (catalogObjectId ${existing.id}) - CREATE_catalog_item will refuse to run while this is true, to avoid creating a duplicate.`
      : undefined,
  };
}

export async function createItem(token, { itemName, variations, locationIds, currency }) {
  const existing = await findItemByExactName(token, itemName);
  if (existing) {
    throw new Error(
      `An item named "${itemName}" already exists (catalogObjectId ${existing.id}). Refusing to create a duplicate - edit the existing item instead, or use a different name.`
    );
  }

  const object = {
    type: "ITEM",
    id: "#new_item",
    item_data: {
      name: itemName,
      present_at_all_locations: false,
      present_at_location_ids: locationIds,
      variations: variations.map((v, i) => ({
        type: "ITEM_VARIATION",
        id: `#new_variation_${i}`,
        item_variation_data: {
          item_id: "#new_item",
          name: v.name,
          sku: v.sku,
          pricing_type: "FIXED_PRICING",
          price_money: { amount: Math.round(v.price * 100), currency },
          present_at_all_locations: false,
          present_at_location_ids: locationIds,
        },
      })),
    },
  };

  const result = await write(token, "/catalog/object", {
    idempotency_key: `create-item-${itemName}-${Date.now()}`,
    object,
  });

  const created = result.catalog_object;
  return {
    itemName,
    catalogObjectId: created?.id,
    variations: (created?.item_data?.variations || []).map((v) => ({
      catalogObjectId: v.id,
      name: v.item_variation_data?.name,
      sku: v.item_variation_data?.sku,
      price: (v.item_variation_data?.price_money?.amount || 0) / 100,
      currency: v.item_variation_data?.price_money?.currency,
    })),
    locationIds,
  };
}
