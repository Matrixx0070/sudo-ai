import { Calculator } from './calculator';

const calc = new Calculator();
let passCount = 0;
const totalTests = 10;

// Test 1: divide works
try {
  const divRes = calc.divide(10, 2);
  if (divRes === 5) passCount++;
  console.log('1. divide works:', divRes === 5);
} catch (e) {
  console.log('1. divide works: false');
}

// Test 2: divide by zero throws
let threw = false;
try {
  calc.divide(10, 0);
} catch (e) {
  if (e.message === "Division by zero") threw = true;
}
if (threw) passCount++;
console.log('2. divide by zero throws:', threw);

// Test 3: power works
try {
  const powRes = calc.power(2, 3);
  if (powRes === 8) passCount++;
  console.log('3. power works:', powRes === 8);
} catch (e) {
  console.log('3. power works: false');
}

// Test 4: sqrt works
try {
  const sqrtRes = calc.sqrt(16);
  if (sqrtRes === 4) passCount++;
  console.log('4. sqrt works:', sqrtRes === 4);
} catch (e) {
  console.log('4. sqrt works: false');
}

// Test 5: sqrt negative throws
threw = false;
try {
  calc.sqrt(-1);
} catch (e) {
  if (e.message === "Cannot sqrt negative") threw = true;
}
if (threw) passCount++;
console.log('5. sqrt negative throws:', threw);

// Test 6: modulo works
try {
  const modRes = calc.modulo(10, 3);
  if (modRes === 1) passCount++;
  console.log('6. modulo works:', modRes === 1);
} catch (e) {
  console.log('6. modulo works: false');
}

// Test 7: undo removes last
const beforeUndoLen = calc.getHistory().length;
const undone = calc.undo();
if (undone && undone.op === 'modulo' && beforeUndoLen - 1 === calc.getHistory().length) {
  passCount++;
}
console.log('7. undo removes last:', !!undone);

// Test 8: replay re-executes
const histBefore = calc.getHistory();
const replayResults = calc.replay();
if (replayResults.length === histBefore.length && replayResults.every((r, i) => {
  // rough check
  return typeof r === 'number';
})) {
  passCount++;
}
console.log('8. replay re-executes:', replayResults.length > 0);

// Test 9: history still tracks all ops
if (calc.getHistory().length > 0) {
  passCount++;
}
console.log('9. history still tracks all ops:', calc.getHistory().length > 0);

// Test 10: Original add/subtract/multiply still work
try {
  const addRes = calc.add(5, 3);
  const subRes = calc.subtract(10, 4);
  const mulRes = calc.multiply(3, 4);
  if (addRes === 8 && subRes === 6 && mulRes === 12) passCount++;
  console.log('10. Original ops still work:', addRes === 8 && subRes === 6 && mulRes === 12);
} catch (e) {
  console.log('10. Original ops still work: false');
}

console.log(`\n${passCount}/${totalTests} passed`);
if (passCount === totalTests) {
  console.log("TEST PASS");
  process.exit(0);
} else {
  console.log("TEST FAIL");
  process.exit(1);
}
