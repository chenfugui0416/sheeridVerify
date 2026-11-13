// A page-side function is shipped to the browser as source text. new Function()
// evaluates a function BODY, so a declaration such as
// "export function installDom(){...}" only defines a name inside that body and
// evaluates to undefined, while a bare "return" in the body is invalid.
// Wrapping the declaration and returning its name by reference yields a callable
// value. The declaration must be terminated before the return, or the wrapper
// closes on the wrong brace.
const DECLARATION = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

export function sourceOf(fn) {
  const text = String(fn).replace(/^export\s+/, '').trim();
  const match = DECLARATION.exec(text);
  if (!match) {
    // An arrow or anonymous function is already an expression: evaluate it and
    // hand back the value rather than a wrapper around it.
    return '(function(){ return (' + text + '); })()';
  }
  const terminated = text.endsWith(';') ? text : text + ';';
  return '(function(){ ' + terminated + ' return ' + match[1] + '; })()';
}
