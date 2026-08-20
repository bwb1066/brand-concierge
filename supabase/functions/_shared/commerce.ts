// Shared commerce logic — the single spine behind the `commerce` REST function
// and (later) the `commerce-mcp` transport. Pure pricing/visibility helpers plus
// DB helpers that take a Supabase client. Mirrors the frontend store so behavior
// is identical across surfaces. Tenant-generic: domain specifics live in each
// product's `specs` JSONB.
//
// deno-lint-ignore-file no-explicit-any

export function resolvePrice(product: any, qty = 1, buyer: any = null): number {
  const contract = buyer?.price_book?.[product.sku];
  if (contract != null) return Number(contract);
  const breaks = (product.price_breaks || [])
    .filter((b: any) => qty >= b.min_qty)
    .sort((a: any, b: any) => b.min_qty - a.min_qty);
  if (breaks.length) return Number(breaks[0].unit_price);
  return Number(product.list_price);
}

export function visibleTo(product: any, buyer: any = null): boolean {
  if (!product.restricted) return true;
  return !!buyer?.entitlements?.includes("export-controlled");
}

export function priceTable(product: any) {
  const rows = [{ min_qty: product.min_order_qty || 1, unit_price: Number(product.list_price) }];
  (product.price_breaks || []).forEach((b: any) => rows.push({ min_qty: b.min_qty, unit_price: Number(b.unit_price) }));
  return rows.sort((a, b) => a.min_qty - b.min_qty);
}

export async function getConfig(sb: any, siteKey: string) {
  const { data } = await sb.from("brand_configs")
    .select("brand_name, currency, facet_hints, tool_desc, commerce_enabled")
    .eq("site_key", siteKey).maybeSingle();
  return data || null;
}

export async function resolveBuyer(sb: any, siteKey: string, email?: string | null) {
  if (!email) return null;
  const { data } = await sb.from("commerce_buyers").select("*")
    .eq("site_key", siteKey).eq("email", email).maybeSingle();
  return data || null;
}

// Single source of truth is brand_products (the concierge catalog), enriched
// with commerce columns. Map its column names to the commerce shape the rest of
// the code + the frontend expect. A row is "buyable" only when it has a sku and
// a list_price, so old concierge-only uploads never render as broken cards.
function mapRow(r: any) {
  if (!r) return null;
  return {
    sku: r.sku,
    name: r.product_name,
    description: r.product_description,
    image_url: r.product_image_url,
    product_url: r.product_page_url,
    category: r.category,
    list_price: r.list_price,
    currency: r.currency,
    uom: r.uom || "each",
    specs: r.specs || {},
    price_breaks: r.price_breaks || [],
    stock_qty: r.stock_qty ?? 0,
    lead_time_days: r.lead_time_days ?? 0,
    min_order_qty: r.min_order_qty || 1,
    restricted: r.restricted === true,
    restriction: r.restriction,
  };
}

// Apply a buyer's negotiated price book: the contracted unit price replaces
// list price and supersedes volume breaks. No-op when the buyer has no contract
// for the SKU. The effective price is written to list_price so the frontend
// (whose REMOTE buyer is identity-only, no price book) renders it directly.
function applyBuyer(product: any, buyer: any) {
  if (!product || !buyer?.price_book) return product;
  const contract = buyer.price_book[product.sku];
  if (contract == null) return product;
  return {
    ...product,
    list_price: Number(contract),
    price_breaks: [],
    contract_price: Number(contract),
  };
}

export async function searchProducts(
  sb: any,
  siteKey: string,
  opts: { query?: string; filters?: Record<string, string> | null; limit?: number },
  buyer: any = null,
) {
  const { query = "", filters = null, limit = 24 } = opts;
  const { data } = await sb.from("brand_products").select("*")
    .eq("site_key", siteKey).eq("active", true)
    .not("sku", "is", null).not("list_price", "is", null);
  let rows = (data || []).map(mapRow).filter((p: any) => visibleTo(p, buyer));
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((p: any) => {
      const hay = [p.name, p.sku, p.description, p.category, ...Object.values(p.specs || {})]
        .join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (filters) {
    rows = rows.filter((p: any) => Object.entries(filters).every(([k, v]) =>
      String(p.specs?.[k] ?? "").toLowerCase().includes(String(v).toLowerCase())));
  }
  return rows.slice(0, limit).map((p: any) => applyBuyer(p, buyer));
}

// Content-as-data: resources (app notes / guides) tagged by category + topic.
// Used by the decisioning layer to surface knowledge relevant to viewed products.
export async function searchResources(
  sb: any,
  siteKey: string,
  opts: { query?: string; category?: string | null; tags?: string[] | null; limit?: number },
) {
  const { query = "", category = null, tags = null, limit = 8 } = opts;
  let q = sb.from("brand_resources").select("*").eq("site_key", siteKey).eq("active", true);
  if (category) q = q.eq("category", category);
  if (tags && tags.length) q = q.overlaps("tags", tags);
  const { data } = await q;
  let rows = data || [];
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((r: any) => {
      const hay = [r.title, r.teaser, r.category, ...(r.tags || [])].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  return rows.slice(0, limit);
}

export async function getProduct(sb: any, siteKey: string, sku: string, buyer: any = null) {
  const { data } = await sb.from("brand_products").select("*")
    .eq("site_key", siteKey).eq("sku", String(sku)).limit(1);
  const product = mapRow((data || [])[0]);
  if (!product || !visibleTo(product, buyer)) return null;
  return applyBuyer(product, buyer);
}

export async function checkAvailability(sb: any, siteKey: string, sku: string, qty: number, buyer: any = null) {
  const p = await getProduct(sb, siteKey, sku, buyer);
  if (!p) return null;
  return {
    sku: p.sku,
    in_stock: p.stock_qty > 0,
    stock_qty: p.stock_qty,
    lead_time_days: p.lead_time_days || 0,
    min_order_qty: p.min_order_qty || 1,
    unit_price: resolvePrice(p, qty, buyer),
    qty_break_table: priceTable(p),
  };
}

async function touchCart(sb: any, cartId: string) {
  await sb.from("commerce_carts").update({ updated_at: new Date().toISOString() }).eq("id", cartId);
}

/** The Option-1 invariant: one open cart per (site_key, buyer). */
export async function resolveOpenCart(sb: any, siteKey: string, buyerId?: string | null, source = "web") {
  if (buyerId) {
    const { data: existing } = await sb.from("commerce_carts").select("*")
      .eq("site_key", siteKey).eq("buyer_id", buyerId).eq("status", "open").maybeSingle();
    if (existing) return existing;
  }
  const { data } = await sb.from("commerce_carts")
    .insert({ site_key: siteKey, buyer_id: buyerId || null, status: "open", source })
    .select().single();
  return data;
}

export async function getCart(sb: any, cartId: string) {
  const { data: cart } = await sb.from("commerce_carts").select("*").eq("id", cartId).maybeSingle();
  if (!cart) return null;
  const { data: items } = await sb.from("commerce_cart_items").select("*")
    .eq("cart_id", cartId).order("created_at");
  return { ...cart, lines: items || [] };
}

export async function addLine(
  sb: any,
  siteKey: string,
  args: { buyer?: any; cartId?: string | null; sku: string; qty?: number; via?: string },
) {
  const { buyer = null, cartId = null, sku, qty = 1, via = "web" } = args;
  const product = await getProduct(sb, siteKey, sku, buyer);
  if (!product) return null;
  const cart = cartId ? await getCart(sb, cartId) : await resolveOpenCart(sb, siteKey, buyer?.id, via);
  const { data: existing } = await sb.from("commerce_cart_items").select("*")
    .eq("cart_id", cart.id).eq("sku", product.sku).maybeSingle();
  const nextQty = (existing?.qty || 0) + qty;
  const unit = resolvePrice(product, nextQty, buyer);
  if (existing) {
    await sb.from("commerce_cart_items").update({ qty: nextQty, unit_price: unit }).eq("id", existing.id);
  } else {
    await sb.from("commerce_cart_items").insert({
      cart_id: cart.id,
      sku: product.sku,
      name: product.name,
      image_url: product.image_url,
      qty: nextQty,
      unit_price: unit,
      lead_time_days: product.lead_time_days || 0,
      added_via: via,
    });
  }
  await touchCart(sb, cart.id);
  return getCart(sb, cart.id);
}

export async function setLineQty(sb: any, siteKey: string, cartId: string, sku: string, qty: number, buyer: any = null) {
  if (qty <= 0) {
    await sb.from("commerce_cart_items").delete().eq("cart_id", cartId).eq("sku", String(sku));
  } else {
    const product = await getProduct(sb, siteKey, sku, buyer);
    const patch: any = { qty };
    if (product) patch.unit_price = resolvePrice(product, qty, buyer);
    await sb.from("commerce_cart_items").update(patch).eq("cart_id", cartId).eq("sku", String(sku));
  }
  await touchCart(sb, cartId);
  return getCart(sb, cartId);
}

export async function removeLine(sb: any, cartId: string, sku: string) {
  await sb.from("commerce_cart_items").delete().eq("cart_id", cartId).eq("sku", String(sku));
  await touchCart(sb, cartId);
  return getCart(sb, cartId);
}

export async function submitCart(sb: any, cartId: string, note = "") {
  const quoteNumber = "Q-" + Date.now().toString(36).toUpperCase();
  const { data } = await sb.from("commerce_carts")
    .update({ status: "submitted", note, quote_number: quoteNumber })
    .eq("id", cartId).select().single();
  return { ...(data || {}), quote_number: quoteNumber };
}
