import { parseSync, Visitor, type Expression, type Function as AstFunction, type Node, type Program } from 'oxc-parser';

/** These are identity-graph edges, not replacements for the browser's retries. */
export const SERVICE_H14_LAZY_IMPORTS = [
  { importer: 'src/components/ResultPanel.tsx', module: 'src/components/RecommendationContent.tsx', specifier: './RecommendationContent',
    factory: 'createRecommendation', load: 'recommendationLoad', variable: 'recommendationRetryUrl', generation: 'recommendationRetryGeneration', moduleType: 'RecommendationModule' },
  { importer: 'src/components/LazySuccessAttemptModal.tsx', module: 'src/components/SuccessAttemptModal.tsx', specifier: './SuccessAttemptModal',
    factory: 'createModal', load: 'modalLoad', variable: 'retryUrl', generation: 'retryGeneration', moduleType: 'ModalModule' },
] as const;
export const SERVICE_H14_RETRY_POLICY = {
  source: 'src/lib/lazyModuleRetry.ts', parameter: 'retry', generations: [1, 2],
} as const;

type ParsedSource = { path: string; program: Program };

function parse(path: string, contents: string): ParsedSource {
  const parsed = parseSync(path, contents, {
    lang: path.endsWith('.tsx') ? 'tsx' : 'ts', sourceType: 'module', astType: 'ts', preserveParens: false,
  });
  if (parsed.errors.length) throw new Error(`service_h14_retry_parse_error:${path}:${parsed.errors[0]!.message}`);
  return { path, program: parsed.program };
}

function functionContract(source: ParsedSource, name: string): { node: AstFunction; text: string } {
  const functions: AstFunction[] = [];
  for (const statement of source.program.body) {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (node?.type === 'FunctionDeclaration' && node.id?.name === name) functions.push(node);
  }
  if (functions.length !== 1) throw new Error(`service_h14_retry_function_contract:${source.path}:${name}`);
  // Compare actual ESTree structure, operators and values, not source formatting.
  // Literal spelling/positions are immaterial; template raw values remain bound.
  const text = JSON.stringify(functions[0]!, function(this: Record<string, unknown>, key, value: unknown) {
    if (['start', 'end', 'range', 'loc', 'parent'].includes(key) || key === 'raw' && this['type'] === 'Literal') return undefined;
    return value;
  });
  return { node: functions[0]!, text };
}

// Pin the actual same-origin module-name restriction and the two cache-busting
// generations. Changes to this policy require a reviewed closure-contract edit;
// merely retaining a familiar variable name cannot admit arbitrary URL imports.
const retryPolicyFunction = `export function lazyModuleRetryUrl(
  error: unknown, name: DeferredModule, origin: string, generation: number,
): string | null {
  if (!(error instanceof TypeError) ||
      !/^(Failed to fetch dynamically imported module|error loading dynamically imported module):/i.test(error.message) ||
      (generation !== 1 && generation !== 2)) return null;
  try {
    const url = new URL(error.message.match(/https?:\\/\\/[^\\s"'<>)]*/)?.[0] ?? "");
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    if (!new RegExp(\`^\${rootCandidate ? '/' : '/preview/'}assets/\${name}-[A-Za-z0-9_-]+\\\\.js$\`).test(url.pathname) &&
        !(import.meta.env.DEV && url.pathname === \`/src/components/\${name}.tsx\`)) return null;
    url.searchParams.set("retry", String(generation));
    return url.href;
  } catch { return null; }
}`;

/** Only the write:false source-identity graph receives this projection. Actual
 * Vite/browser source and source-manifest hashes always use the original bytes.
 * All other dynamic imports remain subject to esbuild's strict error setting. */
export function bindServiceH14LazyImportGraph(path: string, contents: string): string | undefined {
  const spec = SERVICE_H14_LAZY_IMPORTS.find(item => item.importer === path);
  if (path !== SERVICE_H14_RETRY_POLICY.source && !spec) return undefined;
  const source = parse(path, contents);
  if (path === SERVICE_H14_RETRY_POLICY.source) {
    if (functionContract(source, 'lazyModuleRetryUrl').text !== functionContract(parse(path, retryPolicyFunction), 'lazyModuleRetryUrl').text)
      throw new Error('service_h14_retry_url_policy_changed');
    return undefined;
  }
  if (!spec) throw new Error('service_h14_retry_import_contract');
  const expected = `function ${spec.factory}() {
    return lazy(() => {
      ${spec.load} ??= (
        ${spec.variable} ? (import(${spec.variable}) as Promise<${spec.moduleType}>) : import("${spec.specifier}")
      ).then((module) => {
        ${spec.variable} = null;
        ${spec.generation} = 0;
        return module;
      }).catch((error: unknown) => {
        ${spec.variable} = lazyModuleRetryUrl(error, "${spec.specifier.slice(2)}", location.origin, ++${spec.generation});
        throw error;
      });
      return ${spec.load};
    });
  }`;
  const factory = functionContract(source, spec.factory);
  if (factory.text !== functionContract(parse(path, expected), spec.factory).text)
    throw new Error(`service_h14_retry_factory_changed:${path}`);
  const policyImports = source.program.body.filter(node => node.type === 'ImportDeclaration' &&
    node.source.value === '../lib/lazyModuleRetry' && node.importKind !== 'type' &&
    node.specifiers.some(binding => binding.type === 'ImportSpecifier' && binding.local.name === 'lazyModuleRetryUrl' &&
      binding.imported.type === 'Identifier' && binding.imported.name === 'lazyModuleRetryUrl' && binding.importKind !== 'type'));
  if (policyImports.length !== 1) throw new Error(`service_h14_retry_policy_import_changed:${path}`);
  const insideFactory = (node: Node) => node.start >= factory.node.start && node.end <= factory.node.end;
  const declarations = new Map<string, number>();
  const imports: Expression[] = [];
  new Visitor({
    VariableDeclarator(node) {
      const id = node.id;
      if (id.type !== 'Identifier' || ![spec.variable, spec.generation].some(name => name === id.name)) return;
      const initial = id.name === spec.variable ? null : 0;
      if (insideFactory(node) || node.init?.type !== 'Literal' || node.init.value !== initial)
        throw new Error(`service_h14_retry_state_initializer_changed:${path}`);
      declarations.set(id.name, (declarations.get(id.name) ?? 0) + 1);
    },
    AssignmentExpression(node) {
      const left = node.left;
      if (left.type === 'Identifier' && [spec.variable, spec.generation].some(name => name === left.name) && !insideFactory(node))
        throw new Error(`service_h14_retry_state_write_changed:${path}`);
    },
    UpdateExpression(node) {
      if (node.argument.type === 'Identifier' && node.argument.name === spec.generation && !insideFactory(node))
        throw new Error(`service_h14_retry_generation_write_changed:${path}`);
    },
    ImportExpression(node) {
      if (node.source.type !== 'Identifier' || node.source.name !== spec.variable) return;
      if (!insideFactory(node)) throw new Error(`service_h14_retry_import_outside_factory:${path}`);
      imports.push(node.source);
    },
  }).visit(source.program);
  if (imports.length !== 1 || declarations.get(spec.variable) !== 1 || declarations.get(spec.generation) !== 1)
    throw new Error(`service_h14_retry_state_contract:${path}`);
  const argument = imports[0]!;
  if (contents.slice(argument.start, argument.end) !== spec.variable) throw new Error(`service_h14_retry_parser_span_mismatch:${path}`);
  return contents.slice(0, argument.start) + JSON.stringify(spec.specifier) + contents.slice(argument.end);
}
