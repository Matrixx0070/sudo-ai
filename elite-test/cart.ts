import { Product, CartItem } from "./models.js";

export class ShoppingCart {
  private items: CartItem[] = [];

  addItem(product: Product, qty: number = 1): void {
    if (qty <= 0) {
      throw new Error("Quantity must be positive");
    }
    const available = product.stock;
    const existing = this.items.find(i => i.product.id === product.id);
    const currentQty = existing ? existing.quantity : 0;
    if (currentQty + qty > available) {
      throw new Error("Cannot add more than available stock");
    }
    if (existing) {
      existing.quantity += qty;
    } else {
      this.items.push({ product, quantity: qty });
    }
  }

  removeItem(productId: string): void {
    this.items = this.items.filter(item => item.product.id !== productId);
  }

  getItems(): CartItem[] {
    return [...this.items];
  }

  getTotal(): number {
    return this.items.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  }

  clear(): void {
    this.items = [];
  }

  itemCount(): number {
    return this.items.reduce((sum, item) => sum + item.quantity, 0);
  }
}
