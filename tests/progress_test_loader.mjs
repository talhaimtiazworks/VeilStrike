// Test-only loader: isolate Progress' unlock plug-in from Three.js-backed game modules.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') {
    return {
      url: new URL('../assets/vendor/three.module.js', import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier === './unlocks.js' && context.parentURL?.endsWith('/js/progress.js')) {
    return {
      url: new URL('./unlocks_stub.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
