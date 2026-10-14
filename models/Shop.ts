import mongoose, { Schema, model, models, type Model } from "mongoose";

/**
 * A print counter. Registration is deliberately lightweight (no password):
 * the counter's browser/agent holds a random device key, stored here only as
 * a SHA-256 hash. The public shopCode is what the counter's QR encodes.
 */
export interface IShop extends mongoose.Document {
  name: string;
  area: string;
  shopCode: string;
  deviceKeyHash: string;
  createdAt: Date;
  lastSeenAt: Date;
}

const ShopSchema = new Schema<IShop>({
  name: { type: String, required: true },
  area: { type: String, default: "" },
  shopCode: { type: String, required: true, unique: true },
  deviceKeyHash: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
});

export const Shop: Model<IShop> = (models.Shop as Model<IShop>) ?? model<IShop>("Shop", ShopSchema);

/** Human label shown to the citizen ("Sharma Xerox, Andheri"). */
export function shopLabel(shop: Pick<IShop, "name" | "area">): string {
  return shop.area ? `${shop.name}, ${shop.area}` : shop.name;
}
