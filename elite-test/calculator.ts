
export class Calculator {
  private history: Array<{ op: string; a: number; b: number; result: number }> = [];

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push({ op: 'add', a, b, result });
    return result;
  }

  subtract(a: number, b: number): number {
    const result = a - b;
    this.history.push({ op: 'subtract', a, b, result });
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this.history.push({ op: 'multiply', a, b, result });
    return result;
  }
  divide(a: number, b: number): number {
    if (b === 0) throw new Error("Division by zero");
    const result = a / b;
    this.history.push({ op: 'divide', a, b, result });
    return result;
  }

  power(a: number, b: number): number {
    const result = Math.pow(a, b);
    this.history.push({ op: 'power', a, b, result });
    return result;
  }

  sqrt(a: number): number {
    if (a < 0) throw new Error("Cannot sqrt negative");
    const result = Math.sqrt(a);
    this.history.push({ op: 'sqrt', a, b: 0, result });
    return result;
  }

  modulo(a: number, b: number): number {
    if (b === 0) throw new Error("Division by zero");
    const result = a % b;
    this.history.push({ op: 'modulo', a, b, result });
    return result;
  }

  undo() {
    if (this.history.length === 0) return null;
    return this.history.pop();
  }

  replay(): number[] {
    const results: number[] = [];
    const historyCopy = [...this.history];
    this.clearHistory();
    for (const entry of historyCopy) {
      let res: number;
      switch (entry.op) {
        case 'add':
          res = this.add(entry.a, entry.b);
          break;
        case 'subtract':
          res = this.subtract(entry.a, entry.b);
          break;
        case 'multiply':
          res = this.multiply(entry.a, entry.b);
          break;
        case 'divide':
          res = this.divide(entry.a, entry.b);
          break;
        case 'power':
          res = this.power(entry.a, entry.b);
          break;
        case 'sqrt':
          res = this.sqrt(entry.a);
          break;
        case 'modulo':
          res = this.modulo(entry.a, entry.b);
          break;
        default:
          continue;
      }
      results.push(res);
    }
    return results;
  }


  getHistory() { return [...this.history]; }
  clearHistory() { this.history = []; }
}
