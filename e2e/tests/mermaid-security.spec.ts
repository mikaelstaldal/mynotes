import { test, expect } from '@playwright/test';

test('Mermaid blocks and graph titles cannot inject CSS', async ({ page }) => {
  const beacons: string[] = [];
  page.on('request', request => {
    if (request.url().includes('attacker.invalid')) beacons.push(request.url());
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Exercise the shared renderer directly, including its real vendored engine.
    // @ts-expect-error browser module served by the app
    const { renderMermaidBlocks, sanitizeMermaidSVG } = await import('/util/mermaid.js');
    // @ts-expect-error browser module served by the app
    const { buildGraphSource } = await import('/util/graph.js');
    const payload = "%%{init: {'themeCSS': ':root:has(&) body{opacity:0.123!important;background:url(https://attacker.invalid/beacon)}', 'fontFamily': 'evil'}}%%";
    const note = { slug: 'evil', title: payload, tags: [], incoming_links: [{ slug: 'evil' }], outgoing_links: [] };
    const graph = buildGraphSource([note]);
    const transientOpacity: string[] = [];
    const observer = new MutationObserver(() => {
      const opacity = getComputedStyle(document.body).opacity;
      if (opacity !== '1') transientOpacity.push(opacity);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const rendered: boolean[] = [];
    const styles: string[] = [];
    for (const source of [payload + '\ngraph LR\n A-->B', graph.source, 'graph LR\n A-->B',
      'stateDiagram-v2\n classDef x fill:red}} body{opacity:0.25} y{\n [*] --> A\n class A x',
      "%%{init: {'fontFamily':'evil', 'themeCSS':'body{opacity:0.123}'}}%%\ngraph LR\n A-->B"]) {
      const container = document.createElement('section');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = source;
      pre.append(code);
      container.append(pre);
      document.body.append(container);
      await renderMermaidBlocks(container);
      rendered.push(Boolean(container.querySelector('.mermaid-diagram svg')));
      styles.push(container.innerHTML);
      container.remove();
    }
    observer.disconnect();
    const rejected = [
      '#test{position:fixed;inset:0;z-index:999999}',
      '#test{width:100%;height:100%}',
      '#test:has(*) body{opacity:0}', '#test ~ body{opacity:0}',
      '#test .node{fill:url(https://attacker.invalid/beacon)}',
      '#test .node{fill:u\\72l(https://attacker.invalid/beacon)}',
      '@import "https://attacker.invalid/style";',
      '#test .node{background:image-set("https://attacker.invalid/beacon" 1x)}',
    ].map(css => {
      try { sanitizeMermaidSVG(`<svg><style>${css}</style></svg>`, 'test'); return false; }
      catch { return true; }
    });
    return { rendered, rejected, styles, transientOpacity, opacity: getComputedStyle(document.body).opacity, source: graph.source };
  });
  expect(result.rendered).toEqual([true, true, true, false, true]);
  expect(result.styles[4]).not.toContain('evil');
  expect(result.rejected).toEqual([true, true, true, true, true, true, true, true]);
  expect(result.opacity).toBe('1');
  expect(result.transientOpacity).toEqual([]);
  expect(beacons).toEqual([]);
  expect(result.source).not.toContain('%%');
});

const diagrams = {
  flowchart: 'graph LR\n A-->B',
  sequence: 'sequenceDiagram\n Alice->>Bob: Hello',
  gantt: 'gantt\n dateFormat YYYY-MM-DD\n section Work\n Task :2026-01-01, 2d',
  gitGraph: 'gitGraph\n commit\n branch develop\n commit',
  timeline: 'timeline\n 2020 : Started\n 2021 : Continued',
  state: 'stateDiagram-v2\n [*] --> A\n A --> B',
  class: 'classDiagram\n Animal <|-- Duck',
  journey: 'journey\n title My day\n section Work\n Task: 5: Me',
  block: 'block-beta\n columns 2\n A B',
  labels: 'graph LR\n A["R&D me@example.com src/*.go"] & B --> C@{ shape: rect }',
};

for (const theme of ['default', 'dark'] as const) {
  test(`ordinary diagrams and graph labels render in ${theme} theme`, async ({ page }) => {
    await page.goto('/');
    const rendered = await page.evaluate(async ({ diagrams, theme }) => {
      // @ts-expect-error browser module served by the app
      const { renderMermaidBlocks } = await import('/util/mermaid.js');
      // @ts-expect-error browser module served by the app
      const { buildGraphSource } = await import('/util/graph.js');
      const sources = { ...diagrams, graph: buildGraphSource([{
        slug: 'glob', title: 'Globs: src/*.go', tags: [],
        incoming_links: [{ slug: 'glob' }], outgoing_links: [],
      }]).source };
      const results: Record<string, boolean> = {};
      for (const [name, source] of Object.entries(sources)) {
        const container = document.createElement('section');
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-mermaid';
        code.textContent = source;
        pre.append(code);
        container.append(pre);
        document.body.append(container);
        await renderMermaidBlocks(container, theme);
        results[name] = Boolean(container.querySelector('.mermaid-diagram svg'));
        container.remove();
      }
      return results;
    }, { diagrams, theme });
    for (const [name, didRender] of Object.entries(rendered)) {
      expect(didRender, `${name} in ${theme}`).toBe(true);
    }
  });
}

for (const entry of ['/', '/render/index.html']) {
  test(`Mermaid links follow the URL policy at ${entry}`, async ({ page }) => {
    await page.goto(entry);
    const result = await page.evaluate(async (entry) => {
      // @ts-expect-error browser module served by the app
      const { renderMermaidBlocks, sanitizeMermaidSVG } = await import('/util/mermaid.js');
      const urls = ['tel:+19005551234', 'sms:+19005551234?body=STOP', 'callto:123',
        'xmpp:user@example.com', 'ftp://example.com/', 'https://example.com/',
        'http://example.com/', 'mailto:user@example.com'];
      const source = 'graph LR\n' + urls.map((url, i) =>
        `N${i}[Node${i}]\n click N${i} "${url}"`).join('\n');
      let container: HTMLElement;
      if (entry === '/') {
        container = document.createElement('section');
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-mermaid';
        code.textContent = source;
        pre.append(code);
        container.append(pre);
        document.body.append(container);
        await renderMermaidBlocks(container);
      } else {
        const host = (globalThis as unknown as {
          MyNotesRender: { render(markdown: string): Promise<void> };
        }).MyNotesRender;
        await host.render('```mermaid\n' + source + '\n```');
        container = document.getElementById('note')!;
      }
      const links = (root: ParentNode) => Array.from(root.querySelectorAll('a'), a => ({
        href: a.getAttribute('href') ?? a.getAttribute('xlink:href'),
        target: a.getAttribute('target'), rel: a.getAttribute('rel'),
      })).filter(a => a.href);
      const template = document.createElement('template');
      template.innerHTML = sanitizeMermaidSVG(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        urls.flatMap(url => [`<a href="${url}"><text>link</text></a>`,
          `<a xlink:href="${url}"><text>link</text></a>`]).join('') +
        '<a href="#node"><text>fragment</text></a></svg>', 'test');
      const variants = document.createElement('template');
      variants.innerHTML = sanitizeMermaidSVG('<svg xmlns="http://www.w3.org/2000/svg" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a href=" https://example.com/"><text>space</text></a>' +
        '<a href="https:example.com"><text>scheme</text></a>' +
        '<a href="tel:123" xlink:href="https://example.com/"><text>both</text></a></svg>', 'test');
      return { rendered: Boolean(container.querySelector('.mermaid-diagram svg')),
        links: links(container), direct: links(template.content), variants: links(variants.content) };
    }, entry);
    expect(result.rendered).toBe(true);
    const allowed = ['https://example.com/', 'http://example.com/', 'mailto:user@example.com'];
    expect(result.links.map(a => a.href).sort()).toEqual([...allowed].sort());
    expect(result.direct.map(a => a.href).sort()).toEqual([...allowed, ...allowed, '#node'].sort());
    expect(result.variants).toHaveLength(3);
    for (const link of [...result.variants, ...result.links, ...result.direct]) {
      if (link.href?.trim().startsWith('http')) {
        expect(link.target).toBe('_blank');
        expect(link.rel).toBe('noopener noreferrer');
      }
    }
  });
}
