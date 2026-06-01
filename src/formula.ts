export type FormulaAst =
  | { type: "number"; value: number }
  | { type: "identifier"; name: string }
  | { type: "unary"; op: "+" | "-"; expr: FormulaAst }
  | { type: "binary"; op: FormulaBinaryOp; left: FormulaAst; right: FormulaAst }
  | { type: "call"; name: FormulaFunctionName; args: FormulaAst[] };

export type FormulaBinaryOp = "+" | "-" | "*" | "/" | "^" | ">" | ">=" | "<" | "<=" | "==" | "!=";

export type FormulaFunctionName = "pow" | "min" | "max" | "clamp" | "round" | "abs" | "if";

export interface FormulaError {
  message: string;
  pos: number;
}

export type FormulaParseResult =
  | { ok: true; ast: FormulaAst }
  | { ok: false; error: FormulaError };

export type FormulaEvalResult =
  | { ok: true; value: number }
  | { ok: false; error: FormulaError };

type TokenType =
  | "number"
  | "identifier"
  | "operator"
  | "lparen"
  | "rparen"
  | "comma"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const FUNCTIONS = new Set<FormulaFunctionName>(["pow", "min", "max", "clamp", "round", "abs", "if"]);

export function parseFormula(source: string): FormulaParseResult {
  const parser = new FormulaParser(source);
  return parser.parse();
}

export function evaluateFormula(ast: FormulaAst, env: Record<string, number> = {}): FormulaEvalResult {
  return evalNode(ast, env);
}

export function extractFormulaIdentifiers(ast: FormulaAst): string[] {
  const out = new Set<string>();
  const visit = (node: FormulaAst): void => {
    switch (node.type) {
      case "number":
        return;
      case "identifier":
        out.add(node.name);
        return;
      case "unary":
        visit(node.expr);
        return;
      case "binary":
        visit(node.left);
        visit(node.right);
        return;
      case "call":
        for (const arg of node.args) visit(arg);
        return;
    }
  };
  visit(ast);
  return [...out].sort();
}

class FormulaParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  parse(): FormulaParseResult {
    try {
      const ast = this.parseComparison();
      const next = this.peek();
      if (next.type !== "eof") throw this.error(`Unexpected token "${next.value}".`, next);
      return { ok: true, ast };
    } catch (error) {
      return { ok: false, error: error as FormulaError };
    }
  }

  private parseComparison(): FormulaAst {
    let left = this.parseAdditive();
    const next = this.peek();
    if (next.type === "operator" && (next.value === ">" || next.value === ">=" || next.value === "<" || next.value === "<=" || next.value === "==" || next.value === "!=")) {
      this.index++;
      const right = this.parseAdditive();
      left = { type: "binary", op: next.value as FormulaBinaryOp, left, right };
    }
    return left;
  }

  private parseAdditive(): FormulaAst {
    let left = this.parseMultiplicative();
    while (this.matchOperator("+") || this.matchOperator("-")) {
      const op = this.previous().value as "+" | "-";
      const right = this.parseMultiplicative();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): FormulaAst {
    let left = this.parsePower();
    while (this.matchOperator("*") || this.matchOperator("/")) {
      const op = this.previous().value as "*" | "/";
      const right = this.parsePower();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parsePower(): FormulaAst {
    const left = this.parseUnary();
    if (this.matchOperator("^")) {
      const right = this.parsePower();
      return { type: "binary", op: "^", left, right };
    }
    return left;
  }

  private parseUnary(): FormulaAst {
    if (this.matchOperator("+") || this.matchOperator("-")) {
      const op = this.previous().value as "+" | "-";
      return { type: "unary", op, expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaAst {
    const token = this.peek();
    if (token.type === "number") {
      this.index++;
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw this.error(`Invalid number "${token.value}".`, token);
      return { type: "number", value };
    }
    if (token.type === "identifier") {
      this.index++;
      if (this.match("lparen")) {
        if (!FUNCTIONS.has(token.value as FormulaFunctionName)) {
          throw this.error(`Unknown function "${token.value}".`, token);
        }
        const args: FormulaAst[] = [];
        if (!this.match("rparen")) {
          do {
            args.push(this.parseComparison());
          } while (this.match("comma"));
          this.consume("rparen", "Expected ')' after function arguments.");
        }
        return { type: "call", name: token.value as FormulaFunctionName, args };
      }
      return { type: "identifier", name: token.value };
    }
    if (this.match("lparen")) {
      const expr = this.parseComparison();
      this.consume("rparen", "Expected ')' after expression.");
      return expr;
    }
    throw this.error("Expected a number, identifier, function call, or parenthesized expression.", token);
  }

  private match(type: TokenType): boolean {
    if (this.peek().type !== type) return false;
    this.index++;
    return true;
  }

  private matchOperator(value: string): boolean {
    const token = this.peek();
    if (token.type !== "operator" || token.value !== value) return false;
    this.index++;
    return true;
  }

  private consume(type: TokenType, message: string): Token {
    const token = this.peek();
    if (token.type === type) {
      this.index++;
      return token;
    }
    throw this.error(message, token);
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private previous(): Token {
    return this.tokens[this.index - 1]!;
  }

  private error(message: string, token: Token): FormulaError {
    return { message, pos: token.pos };
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (isNumberStart(source, i)) {
      const start = i;
      i = readNumber(source, i);
      tokens.push({ type: "number", value: source.slice(start, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < source.length && /[A-Za-z0-9_.-]/.test(source[i]!)) i++;
      tokens.push({ type: "identifier", value: source.slice(start, i), pos: start });
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch, pos: i++ });
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch, pos: i++ });
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch, pos: i++ });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "==" || two === "!=") {
      tokens.push({ type: "operator", value: two, pos: i });
      i += 2;
      continue;
    }
    if ("+-*/^<>".includes(ch)) {
      tokens.push({ type: "operator", value: ch, pos: i++ });
      continue;
    }
    tokens.push({ type: "operator", value: ch, pos: i++ });
  }
  tokens.push({ type: "eof", value: "", pos: source.length });
  return tokens;
}

function isNumberStart(source: string, index: number): boolean {
  const ch = source[index]!;
  if (/\d/.test(ch)) return true;
  return ch === "." && /\d/.test(source[index + 1] ?? "");
}

function readNumber(source: string, index: number): number {
  let i = index;
  while (i < source.length && /\d/.test(source[i]!)) i++;
  if (source[i] === ".") {
    i++;
    while (i < source.length && /\d/.test(source[i]!)) i++;
  }
  if (source[i] === "e" || source[i] === "E") {
    const expStart = i;
    i++;
    if (source[i] === "+" || source[i] === "-") i++;
    const digitStart = i;
    while (i < source.length && /\d/.test(source[i]!)) i++;
    if (i === digitStart) return expStart;
  }
  return i;
}

function evalNode(node: FormulaAst, env: Record<string, number>): FormulaEvalResult {
  switch (node.type) {
    case "number":
      return finite(node.value, 0);
    case "identifier": {
      const value = env[node.name];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: { message: `Missing numeric value for "${node.name}".`, pos: 0 } };
      }
      return { ok: true, value };
    }
    case "unary": {
      const value = evalNode(node.expr, env);
      if (!value.ok) return value;
      return finite(node.op === "-" ? -value.value : value.value, 0);
    }
    case "binary":
      return evalBinary(node, env);
    case "call":
      return evalCall(node, env);
  }
}

function evalBinary(node: Extract<FormulaAst, { type: "binary" }>, env: Record<string, number>): FormulaEvalResult {
  const left = evalNode(node.left, env);
  if (!left.ok) return left;
  const right = evalNode(node.right, env);
  if (!right.ok) return right;
  switch (node.op) {
    case "+":
      return finite(left.value + right.value, 0);
    case "-":
      return finite(left.value - right.value, 0);
    case "*":
      return finite(left.value * right.value, 0);
    case "/":
      return right.value === 0
        ? { ok: false, error: { message: "Division by zero.", pos: 0 } }
        : finite(left.value / right.value, 0);
    case "^":
      return finite(Math.pow(left.value, right.value), 0);
    case ">":
      return { ok: true, value: left.value > right.value ? 1 : 0 };
    case ">=":
      return { ok: true, value: left.value >= right.value ? 1 : 0 };
    case "<":
      return { ok: true, value: left.value < right.value ? 1 : 0 };
    case "<=":
      return { ok: true, value: left.value <= right.value ? 1 : 0 };
    case "==":
      return { ok: true, value: left.value === right.value ? 1 : 0 };
    case "!=":
      return { ok: true, value: left.value !== right.value ? 1 : 0 };
  }
}

function evalCall(node: Extract<FormulaAst, { type: "call" }>, env: Record<string, number>): FormulaEvalResult {
  const args: number[] = [];
  for (const arg of node.args) {
    const value = evalNode(arg, env);
    if (!value.ok) return value;
    args.push(value.value);
  }
  switch (node.name) {
    case "pow":
      return arity(node, args, 2, 2) ?? finite(Math.pow(args[0]!, args[1]!), 0);
    case "min":
      return arity(node, args, 1, Infinity) ?? finite(Math.min(...args), 0);
    case "max":
      return arity(node, args, 1, Infinity) ?? finite(Math.max(...args), 0);
    case "clamp":
      return arity(node, args, 3, 3) ?? finite(Math.min(Math.max(args[0]!, args[1]!), args[2]!), 0);
    case "round": {
      const arityError = arity(node, args, 1, 2);
      if (arityError) return arityError;
      const digits = args[1] ?? 0;
      const factor = Math.pow(10, Math.trunc(digits));
      return finite(Math.round(args[0]! * factor) / factor, 0);
    }
    case "abs":
      return arity(node, args, 1, 1) ?? finite(Math.abs(args[0]!), 0);
    case "if":
      return arity(node, args, 3, 3) ?? finite(args[0] !== 0 ? args[1]! : args[2]!, 0);
  }
}

function arity(node: Extract<FormulaAst, { type: "call" }>, args: number[], min: number, max: number): FormulaEvalResult | null {
  if (args.length >= min && args.length <= max) return null;
  const expected = min === max ? String(min) : `${min}-${max === Infinity ? "many" : max}`;
  return { ok: false, error: { message: `${node.name}() expects ${expected} arguments, got ${args.length}.`, pos: 0 } };
}

function finite(value: number, pos: number): FormulaEvalResult {
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, error: { message: "Formula produced a non-finite result.", pos } };
}
