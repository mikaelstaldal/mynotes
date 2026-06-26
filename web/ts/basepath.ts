// base is '' for root deployments, '/prefix' (no trailing slash) for subpath
// deployments. It is derived from the <base href> that the server injects into
// index.html based on the -public-url flag's path component.
export const base: string = (() => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/';
  return href === '/' ? '' : href.endsWith('/') ? href.slice(0, -1) : href;
})();
