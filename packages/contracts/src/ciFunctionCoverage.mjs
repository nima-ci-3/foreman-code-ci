// Function-level test proofs: a test that passed at one commit still holds at another when every file it ran reads the
// same once the bodies of the functions it never called are blanked. Shared by the integration coverage collector and
// Main's result cache. The TypeScript module is passed in so this package needs no parser at runtime.

/** Replaces each blanked body; it cannot occur in source text, so masked texts are equal only when their structure is. */
const BLANK = '\0'

/**
 * @typedef {{ path: string; start: number; bodyStart: number; end: number; kind: 'function' | 'class'; enclosing: string[]; constructorPath?: string }} FunctionSpan
 * `start`..`bodyStart` is the head, `bodyStart`..`end` the body; `enclosing` lists the paths of the functions around it.
 * A class head stands for its constructor: V8 reports `new` as a call of a function starting at `class`.
 */

/** @param {any} node @param {any} ts @returns {string} */
function segment(node, ts) {
  const text = (/** @type {any} */ name) => name && (ts.isIdentifier(name) || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : name ? '[computed]' : ''
  let name = ''
  if (ts.isConstructorDeclaration(node)) name = 'constructor'
  else if (ts.isGetAccessorDeclaration(node)) name = `get ${text(node.name)}`
  else if (ts.isSetAccessorDeclaration(node)) name = `set ${text(node.name)}`
  else if (node.name) name = text(node.name)
  else if (node.parent && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)
    || ts.isPropertyDeclaration(node.parent))) name = text(node.parent.name)
  const owner = ts.isClassLike(node.parent) ? node.parent : node.parent && ts.isPropertyDeclaration(node.parent)
    && ts.isClassLike(node.parent.parent) ? node.parent.parent : undefined
  return owner ? `${owner.name?.text ?? ''}.${name}` : name
}

/** Every function and class of a module in source order, named by its enclosing functions' names and its position
 * among same-named siblings, so editing one body does not rename the functions around it.
 * Syntax errors reject the parse: recovered spans must not hide invalid code in a masked proof.
 * @param {string} text @param {string} fileName @param {any} ts the TypeScript module, of any version @returns {FunctionSpan[]} */
export function functionSpans(text, fileName, ts) {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  if (source.parseDiagnostics.length) {
    throw new SyntaxError(`${fileName}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n')}`)
  }
  /** @type {FunctionSpan[]} */
  const spans = []
  /** @param {any} node @param {string} parent @param {Map<string, number>} siblings @param {string[]} enclosing */
  const visit = (node, parent, siblings, enclosing) => {
    const named = (/** @type {string} */ name) => {
      const index = siblings.get(name) ?? 0
      siblings.set(name, index + 1)
      return `${parent}/${name}#${index}`
    }
    if (ts.isFunctionLike(node) && /** @type {any} */ (node).body) {
      const body = /** @type {any} */ (node).body
      const path = named(segment(node, ts))
      spans.push({ path, start: node.getStart(source), bodyStart: body.getStart(source), end: body.end, kind: 'function', enclosing })
      const inner = new Map()
      ts.forEachChild(node, child => visit(child, path, inner, [...enclosing, path]))
      return
    }
    if (ts.isClassLike(node)) {
      const open = node.members.pos - 1
      const span = /** @type {FunctionSpan} */ ({ path: named(`class ${node.name?.text ?? ''}`), start: node.getStart(source),
        bodyStart: open, end: node.end, kind: 'class', enclosing })
      spans.push(span)
      // Members keep the enclosing function's namespace (their segment carries the class name).
      ts.forEachChild(node, child => visit(child, parent, siblings, enclosing))
      const constructor = spans.find(item => item.start >= span.start && item.end <= span.end && item.kind === 'function'
        && item.path.startsWith(`${parent}/${node.name?.text ?? ''}.constructor#`))
      if (constructor) span.constructorPath = constructor.path
      return
    }
    ts.forEachChild(node, child => visit(child, parent, siblings, enclosing))
  }
  visit(source, '', new Map(), [])
  return spans.sort((left, right) => left.start - right.start)
}

/** The functions V8 ran, from one source position inside each (mapped back from its executed code). A position counts
 * for the innermost function around it and every function enclosing that one, which must have run to create it, so a
 * position that lands in a nested function never leaves its real function blanked. Positions in a class head stand
 * for its constructor; elsewhere in a class body they are field initializers; outside every function, module code.
 * @param {FunctionSpan[]} spans @param {number[]} offsets @returns {string[]} */
export function executedFunctions(spans, offsets) {
  const executed = new Set()
  for (const offset of offsets) {
    let innermost
    for (const span of spans) {
      if (span.start > offset) break
      if (offset < span.end) innermost = span
    }
    if (!innermost) continue
    for (const path of innermost.enclosing) executed.add(path)
    if (innermost.kind === 'function') executed.add(innermost.path)
    else if (offset < innermost.bodyStart && innermost.constructorPath) executed.add(innermost.constructorPath)
  }
  return [...executed].sort()
}

/** The text with the body of every function outside `executed` blanked; only module code, heads and executed bodies
 * remain. @param {string} text @param {FunctionSpan[]} spans @param {ReadonlySet<string>} executed */
export function maskedText(text, spans, executed) {
  let masked = ''
  let cursor = 0
  for (const span of spans) {
    if (span.kind !== 'function' || span.bodyStart < cursor || executed.has(span.path)) continue
    masked += text.slice(cursor, span.bodyStart) + BLANK
    cursor = span.end
  }
  return masked + text.slice(cursor)
}
