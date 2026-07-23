import { parse } from "acorn";

export function parseOrchestratedToolCalls(source) {
  const text = String(source || "");
  if (!text.trim()) return [];

  let ast;
  try {
    ast = parse(text, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return [];
  }

  const calls = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return true;
    const name = toolsMethodName(node.callee);
    if (!name) return true;
    const argument = node.arguments[0];
    calls.push({
      name,
      args: staticValue(argument, text),
      rawArguments: argument ? text.slice(argument.start, argument.end) : "",
    });
    return false;
  });
  return calls;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (visit(node) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

function toolsMethodName(callee) {
  if (callee?.type !== "MemberExpression" || callee.object?.type !== "Identifier") return "";
  if (callee.object.name !== "tools") return "";
  if (!callee.computed && callee.property?.type === "Identifier") return callee.property.name;
  if (callee.computed && callee.property?.type === "Literal") return String(callee.property.value || "");
  return "";
}

function staticValue(node, source) {
  if (!node) return {};
  if (node.type === "Literal") return node.value;
  if (node.type === "ObjectExpression") {
    const value = {};
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init") continue;
      const key = propertyKey(property);
      if (!key) continue;
      value[key] = staticValue(property.value, source);
    }
    return value;
  }
  if (node.type === "ArrayExpression") {
    return node.elements.map((element) => staticValue(element, source));
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument?.type === "Literal") {
    return -Number(node.argument.value);
  }
  return source.slice(node.start, node.end);
}

function propertyKey(property) {
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  if (property.key?.type === "Literal") return String(property.key.value || "");
  return "";
}
