import { Product } from "./models.js";
import { ShoppingCart } from "./cart.js";

const p1: Product = {
  id: "1",
  name: "Laptop",
  price: 1000,
  stock: 5
};

const p2: Product = {
  id: "2",
  name: "Phone",
  price: 500,
  stock: 10
};

const cart = new ShoppingCart();

let passed = 0;
const totalTests = 8;

// 1. Add item
cart.addItem(p1, 2);
passed++;
console.log("1. Add item: passed");

// 2. Get total is correct
if (cart.getTotal() === 2000) {
  passed++;
  console.log("2. Get total is correct: passed");
} else {
  console.log("2. Get total is correct: failed");
}

// 3. Add multiple items
cart.addItem(p2, 3);
if (cart.getTotal() === 3500) {
  passed++;
  console.log("3. Add multiple items: passed");
} else {
  console.log("3. Add multiple items: failed");
}

// 4. Remove item
cart.removeItem("2");
if (cart.getTotal() === 2000) {
  passed++;
  console.log("4. Remove item: passed");
} else {
  console.log("4. Remove item: failed");
}

// 5. Can't exceed stock
let exceeded = false;
try {
  cart.addItem(p1, 4); // current 2 + 4 = 6 > 5
} catch (e) {
  exceeded = true;
}
if (exceeded) {
  passed++;
  console.log("5. Can't exceed stock: passed");
} else {
  console.log("5. Can't exceed stock: failed");
}

// 6. Item count correct
if (cart.itemCount() === 2) {
  passed++;
  console.log("6. Item count correct: passed");
} else {
  console.log("6. Item count correct: failed");
}

// 7. Clear empties cart
cart.clear();
if (cart.itemCount() === 0 && cart.getItems().length === 0) {
  passed++;
  console.log("7. Clear empties cart: passed");
} else {
  console.log("7. Clear empties cart: failed");
}

// 8. Quantity must be positive
let positiveError = false;
try {
  cart.addItem(p1, -1);
} catch (e) {
  positiveError = true;
}
if (positiveError) {
  passed++;
  console.log("8. Quantity must be positive: passed");
} else {
  console.log("8. Quantity must be positive: failed");
}

console.log(`${passed}/${totalTests} passed`);
if (passed === totalTests) {
  console.log("TEST PASS");
  process.exit(0);
} else {
  process.exit(1);
}
